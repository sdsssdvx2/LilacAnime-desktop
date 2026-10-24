'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let preload = read('electron/libmpv-shared-preload.cjs');
let bridge = read('electron/libmpv-shared-main.cjs');
let playerCss = read('src/player-android.css');

if (!preload.includes("const presentationMode = 'raf-staged-copy';")) throw new Error('R2Y requires R2X staged presenter first');
if (!bridge.includes('nativeCadenceTracker')) throw new Error('R2Y requires R2X pipeline diagnostics first');

// User hardware showed native/receive at ~23.98fps but the one-shot rAF final
// presenter at only ~19.9fps with hundreds of coalesced frames. Keep rAF warm
// while video is active so BeginFrame scheduling is already running before each
// source frame arrives. The source VideoFrame/shared-texture lifetime remains
// immediate; only the private WebGPU texture survives to presentation.
preload = replaceOnce(
  preload,
  "const presentationMode = 'raf-staged-copy';",
  "const presentationMode = 'raf-warm-staged-copy';",
  'R2Y presentation mode'
);
preload = replaceOnce(
  preload,
  'let gpuCoalescedFrames = 0;',
  `let gpuCoalescedFrames = 0;\nlet gpuPresentLoopTicks = 0;\nlet gpuPresentLoopStarts = 0;\nlet gpuPresentLoopStops = 0;`,
  'R2Y warm-loop diagnostics state'
);
preload = replaceOnce(
  preload,
  "stagingTexture: null, presentRaf: 0, latestFrameId: 0, lastPresentedFrameId: 0, latestExpectedFps: 0, latestDisplayFrequency: 0, latestPlayerId: 0, error: null",
  "stagingTexture: null, presentRaf: 0, latestFrameId: 0, lastPresentedFrameId: 0, latestExpectedFps: 0, latestDisplayFrequency: 0, latestPlayerId: 0, lastSourceAtMs: 0, error: null",
  'R2Y GPU warm-loop state'
);

const oldPresenter = `function scheduleGpuPresent(state) {\n  if (!state || state.presentRaf || state.status !== 'ready') return;\n  state.presentRaf = requestAnimationFrame(atMs => {\n    state.presentRaf = 0;\n    const frameId = Number(state.latestFrameId) || 0;\n    if (!frameId || frameId === Number(state.lastPresentedFrameId) || !state.stagingTexture) return;\n    const started = performance.now();\n    try {\n      const encoder = state.device.createCommandEncoder();\n      encoder.copyTextureToTexture(\n        { texture: state.stagingTexture },\n        { texture: state.context.getCurrentTexture() },\n        { width: state.width, height: state.height, depthOrArrayLayers: 1 }\n      );\n      state.device.queue.submit([encoder.finish()]);\n      const elapsed = performance.now() - started;\n      gpuPresentFrames += 1;\n      gpuPresentSubmitSamples += 1;\n      gpuPresentSubmitTotalMs += elapsed;\n      gpuPresentSubmitMaxMs = Math.max(gpuPresentSubmitMaxMs, elapsed);\n      state.lastPresentedFrameId = frameId;\n      presentedFrames += 1;\n      const scalarMetadata = {\n        frameId,\n        playerId: Number(state.latestPlayerId) || 0,\n        fps: Number(state.latestExpectedFps) || 0,\n        displayFrequency: Number(state.latestDisplayFrequency) || 0\n      };\n      observePresentationCadence(scalarMetadata, atMs);\n      sendStats({\n        lastFrameId: frameId,\n        playerId: scalarMetadata.playerId,\n        width: state.width,\n        height: state.height,\n        reason: 'presented'\n      });\n    } catch (error) {\n      gpuPresentFailures += 1;\n      lastGpuError = String(error?.message || error).slice(0, 160);\n      sendStats({ lastFrameId: frameId, reason: 'gpu-present-failed', error: lastGpuError }, true);\n    }\n  });\n}`;
const newPresenter = `const GPU_PRESENT_IDLE_STOP_MS = 500;\n\nfunction ensureGpuPresentLoop(state) {\n  if (!state || state.presentRaf || state.status !== 'ready') return;\n  gpuPresentLoopStarts += 1;\n  const tick = atMs => {\n    state.presentRaf = 0;\n    if (!state || state.status !== 'ready') return;\n    gpuPresentLoopTicks += 1;\n    const frameId = Number(state.latestFrameId) || 0;\n    if (frameId && frameId !== Number(state.lastPresentedFrameId) && state.stagingTexture) {\n      const started = performance.now();\n      try {\n        const encoder = state.device.createCommandEncoder();\n        encoder.copyTextureToTexture(\n          { texture: state.stagingTexture },\n          { texture: state.context.getCurrentTexture() },\n          { width: state.width, height: state.height, depthOrArrayLayers: 1 }\n        );\n        state.device.queue.submit([encoder.finish()]);\n        const elapsed = performance.now() - started;\n        gpuPresentFrames += 1;\n        gpuPresentSubmitSamples += 1;\n        gpuPresentSubmitTotalMs += elapsed;\n        gpuPresentSubmitMaxMs = Math.max(gpuPresentSubmitMaxMs, elapsed);\n        state.lastPresentedFrameId = frameId;\n        presentedFrames += 1;\n        const scalarMetadata = {\n          frameId,\n          playerId: Number(state.latestPlayerId) || 0,\n          fps: Number(state.latestExpectedFps) || 0,\n          displayFrequency: Number(state.latestDisplayFrequency) || 0\n        };\n        observePresentationCadence(scalarMetadata, atMs);\n        sendStats({\n          lastFrameId: frameId,\n          playerId: scalarMetadata.playerId,\n          width: state.width,\n          height: state.height,\n          reason: 'presented'\n        });\n      } catch (error) {\n        gpuPresentFailures += 1;\n        lastGpuError = String(error?.message || error).slice(0, 160);\n        sendStats({ lastFrameId: frameId, reason: 'gpu-present-failed', error: lastGpuError }, true);\n      }\n    }\n    const idleForMs = Math.max(0, atMs - (Number(state.lastSourceAtMs) || 0));\n    const hasPendingFrame = Number(state.latestFrameId) !== Number(state.lastPresentedFrameId);\n    if (hasPendingFrame || idleForMs < GPU_PRESENT_IDLE_STOP_MS) {\n      state.presentRaf = requestAnimationFrame(tick);\n    } else {\n      gpuPresentLoopStops += 1;\n    }\n  };\n  state.presentRaf = requestAnimationFrame(tick);\n}`;
preload = replaceOnce(preload, oldPresenter, newPresenter, 'R2Y warm rAF presenter');
preload = replaceOnce(
  preload,
  `      gpuCoalescedFrames,\n      avgGpuPresentSubmitMs:`,
  `      gpuCoalescedFrames,\n      gpuPresentLoopTicks,\n      gpuPresentLoopStarts,\n      gpuPresentLoopStops,\n      avgGpuPresentSubmitMs:`,
  'R2Y presentation loop diagnostics payload'
);
preload = replaceOnce(
  preload,
  `      gpu.latestDisplayFrequency = Number(metadata.displayFrequency) || 0;\n      scheduleGpuPresent(gpu);`,
  `      gpu.latestDisplayFrequency = Number(metadata.displayFrequency) || 0;\n      gpu.lastSourceAtMs = performance.now();\n      ensureGpuPresentLoop(gpu);`,
  'R2Y keep rAF presenter warm'
);

// R2's fixed 16ms pump was intentionally conservative, but on a 23.976fps
// source it quantizes frame discovery by up to one full 16ms timer period. User
// hardware measured ~9.5ms native jitter. Sleep most of the source frame period,
// then poll at 2ms only near the predicted next frame boundary. This keeps CPU
// bounded while cutting discovery jitter by roughly an order of magnitude.
bridge = replaceOnce(
  bridge,
  '  let pumpRunning = false;',
  '  let pumpRunning = false;\n  let lastNativeFramePerfAt = 0;',
  'R2Y native frame phase state'
);
const oldScheduler = `  function schedulePump(delay = 16) {\n    if (!active || disposed) return;\n    const wait = Math.max(0, Number(delay) || 0);\n    if (pumpTimer) {\n      if (wait > 0) return;\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n    }\n    pumpTimer = setTimeout(() => {\n      pumpTimer = null;\n      void pump();\n    }, wait);\n  }`;
const newScheduler = `  const ACTIVE_PUMP_RETRY_MS = 2;\n  const ACTIVE_PUMP_LEAD_MS = 6;\n\n  function expectedSourceFrameIntervalMs() {\n    const fps = Number(lastState?.fps) || 0;\n    if (!Number.isFinite(fps) || fps < 10 || fps > 240) return 0;\n    return 1000 / fps;\n  }\n\n  function nextActivePumpDelay(now = performance.now()) {\n    if (lastState?.paused) return 50;\n    const interval = expectedSourceFrameIntervalMs();\n    if (!interval || !lastNativeFramePerfAt) return 4;\n    const untilLead = (lastNativeFramePerfAt + interval - ACTIVE_PUMP_LEAD_MS) - now;\n    if (untilLead > ACTIVE_PUMP_RETRY_MS) {\n      return Math.max(ACTIVE_PUMP_RETRY_MS, Math.min(32, Math.floor(untilLead)));\n    }\n    return ACTIVE_PUMP_RETRY_MS;\n  }\n\n  function schedulePump(delay = 4) {\n    if (!active || disposed) return;\n    const wait = Math.max(0, Number(delay) || 0);\n    if (pumpTimer) {\n      if (wait > 0) return;\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n    }\n    pumpTimer = setTimeout(() => {\n      pumpTimer = null;\n      void pump();\n    }, wait);\n  }`;
bridge = replaceOnce(bridge, oldScheduler, newScheduler, 'R2Y phase-aware pump scheduler');
bridge = replaceOnce(
  bridge,
  '    let nextDelay = 16;',
  '    let nextDelay = 4;',
  'R2Y default pump delay'
);
bridge = replaceOnce(
  bridge,
  `      if (!nativeFrame?.updated) {\n        nextDelay = 16;\n        return;\n      }\n      metrics.nativeFrames += 1;\n      const frameNow = Date.now();`,
  `      if (!nativeFrame?.updated) {\n        nextDelay = nextActivePumpDelay();\n        return;\n      }\n      metrics.nativeFrames += 1;\n      lastNativeFramePerfAt = performance.now();\n      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);\n      const frameNow = Date.now();`,
  'R2Y near-boundary polling'
);

// Restore the top-right controls/settings positioning to the pre-R2X behavior.
// The user explicitly prefers OP/ED text and the gear at the original right side.
playerCss = replaceOnce(
  playerCss,
  '.immersive-player .player-top { padding-right: 158px; }',
  '.immersive-player.windowed .player-top { padding-right: 158px; }',
  'restore original top-right positioning'
);
playerCss = replaceOnce(
  playerCss,
  '.immersive-player .player-settings { right: 16px; }',
  '.immersive-player.windowed .player-settings { right: 150px; }',
  'restore original settings panel positioning'
);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r2x.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r7') {
  throw new Error(`expected R2X identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r2y.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r8';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2Y-Setup.${ext}';

for (const marker of ["presentationMode = 'raf-warm-staged-copy'", 'ensureGpuPresentLoop', 'GPU_PRESENT_IDLE_STOP_MS = 500', 'gpuPresentLoopTicks', 'lastSourceAtMs = performance.now()']) {
  if (!preload.includes(marker)) throw new Error(`R2Y preload marker missing: ${marker}`);
}
for (const marker of ['ACTIVE_PUMP_RETRY_MS = 2', 'ACTIVE_PUMP_LEAD_MS = 6', 'nextActivePumpDelay', 'lastNativeFramePerfAt = performance.now()']) {
  if (!bridge.includes(marker)) throw new Error(`R2Y bridge marker missing: ${marker}`);
}
if (bridge.includes('let nextDelay = 16;') || bridge.includes('nextDelay = 16;')) throw new Error('R2Y fixed 16ms active pump survived');
if (preload.includes('scheduleGpuPresent(gpu)')) throw new Error('R2Y one-shot rAF presenter survived');
if (preload.includes('setSharedTextureReceiver(async') || preload.includes('await requestAnimationFrame')) throw new Error('R2Y changed immediate source lifetime');
if (!playerCss.includes('.immersive-player.windowed .player-top { padding-right: 158px; }')) throw new Error('R2Y original top-right rule missing');
if (!playerCss.includes('.immersive-player.windowed .player-settings { right: 150px; }')) throw new Error('R2Y original settings rule missing');

write('electron/libmpv-shared-preload.cjs', preload);
write('electron/libmpv-shared-main.cjs', bridge);
write('src/player-android.css', playerCss);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const preloadBundle = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(preloadEntry)) throw new Error('R2Y preload bundle entry missing');
buildSync({
  entryPoints: [preloadEntry],
  outfile: preloadBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});
const bundled = read('electron/preload-libmpv-shared.generated.cjs');
for (const marker of ['raf-warm-staged-copy', 'ensureGpuPresentLoop', 'gpuPresentLoopTicks', 'receiveCadenceTracker']) {
  if (!bundled.includes(marker)) throw new Error(`R2Y generated preload missing: ${marker}`);
}
if (bundled.includes('setSharedTextureReceiver(async') || bundled.includes('await requestAnimationFrame')) throw new Error('R2Y generated preload changed immediate source lifetime');

console.log('LIBMPV_R2Y_OK presentation=raf-warm-staged-copy pump=phase-aware-2ms-near-boundary sourceLifetime=immediate ui=original-right');

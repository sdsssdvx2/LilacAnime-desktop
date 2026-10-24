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
let css = read('src/player-android.css');

if (!preload.includes("const presentationMode = 'raf-warm-staged-copy';")) throw new Error('R2Z requires R2Y warm staged presenter first');
if (!bridge.includes('pumpExpectedFps') || !bridge.includes('ACTIVE_PUMP_RETRY_MS = 2')) throw new Error('R2Z requires R2Y phase-aware pump');

// R2Y hardware evidence: native + renderer receive are essentially exact 23.976 fps,
// while the Chromium rAF presenter itself remains ~19.9 fps. Therefore rAF is not
// a usable presentation clock on this Electron/Windows path. Restore the already
// hardware-qualified R2H/R2V direct WebGPU canvas copy and keep only the R2Y pump
// timing improvement. Source VideoFrame/shared-texture ownership still ends in the
// same receiver turn.
preload = replaceOnce(
  preload,
  "const presentationMode = 'raf-warm-staged-copy';",
  "const presentationMode = 'direct-receive-webgpu-copy';",
  'R2Z presentation mode'
);

preload = replaceOnce(
  preload,
  `let gpuPresentFrames = 0;\nlet gpuPresentFailures = 0;\nlet gpuPresentSubmitSamples = 0;\nlet gpuPresentSubmitTotalMs = 0;\nlet gpuPresentSubmitMaxMs = 0;\nlet gpuCoalescedFrames = 0;\nlet gpuPresentLoopTicks = 0;\nlet gpuPresentLoopStarts = 0;\nlet gpuPresentLoopStops = 0;`,
  `let gpuPresentFrames = 0;\nlet gpuPresentFailures = 0;\nlet gpuPresentSubmitSamples = 0;\nlet gpuPresentSubmitTotalMs = 0;\nlet gpuPresentSubmitMaxMs = 0;\nlet gpuCoalescedFrames = 0;\nlet gpuPresentLoopTicks = 0;\nlet gpuPresentLoopStarts = 0;\nlet gpuPresentLoopStops = 0;`,
  'R2Z retain compatible presentation diagnostics'
);

preload = replaceOnce(
  preload,
  "state = { status: 'initializing', canvas, adapter: null, device: null, context: null, format: null, width: 0, height: 0, stagingTexture: null, presentRaf: 0, latestFrameId: 0, lastPresentedFrameId: 0, latestExpectedFps: 0, latestDisplayFrequency: 0, latestPlayerId: 0, lastSourceAtMs: 0, error: null };",
  "state = { status: 'initializing', canvas, adapter: null, device: null, context: null, format: null, width: 0, height: 0, error: null };",
  'remove R2X/R2Y staging state'
);

const stagedConfigure = `function configureGpu(state, canvas, width, height) {\n  if (!state || state.status !== 'ready' || !state.device || !state.context) return false;\n  if (state.width === width && state.height === height && state.stagingTexture) return true;\n  const usage = globalThis.GPUTextureUsage;\n  if (!usage) throw new Error('GPUTextureUsage unavailable');\n  state.context.configure({\n    device: state.device,\n    format: state.format,\n    alphaMode: 'opaque',\n    usage: usage.COPY_DST | usage.RENDER_ATTACHMENT\n  });\n  try { state.stagingTexture?.destroy?.(); } catch {}\n  state.stagingTexture = state.device.createTexture({\n    size: { width, height, depthOrArrayLayers: 1 },\n    format: state.format,\n    usage: usage.COPY_DST | usage.COPY_SRC | usage.RENDER_ATTACHMENT\n  });\n  state.width = width;\n  state.height = height;\n  state.latestFrameId = 0;\n  state.lastPresentedFrameId = 0;\n  return true;\n}`;
const directConfigure = `function configureGpu(state, canvas, width, height) {\n  if (!state || state.status !== 'ready' || !state.device || !state.context) return false;\n  if (state.width === width && state.height === height) return true;\n  const usage = globalThis.GPUTextureUsage;\n  if (!usage) throw new Error('GPUTextureUsage unavailable');\n  state.context.configure({\n    device: state.device,\n    format: state.format,\n    alphaMode: 'opaque',\n    usage: usage.COPY_DST | usage.RENDER_ATTACHMENT\n  });\n  state.width = width;\n  state.height = height;\n  return true;\n}`;
preload = replaceOnce(preload, stagedConfigure, directConfigure, 'restore direct WebGPU configure');

// gpuStateFor/configureGpu live between findSurface and sendStats. R2X appended
// its staged presenter there and R2Y replaced that presenter in-place, so sendStats
// is the stable structural boundary after the entire warm-rAF block.
const warmPresenterStart = preload.indexOf('const GPU_PRESENT_IDLE_STOP_MS = 500;');
const warmPresenterEnd = preload.indexOf('\nfunction sendStats(', warmPresenterStart);
if (warmPresenterStart < 0 || warmPresenterEnd <= warmPresenterStart) throw new Error('R2Y warm presenter block not found');
preload = preload.slice(0, warmPresenterStart) + preload.slice(warmPresenterEnd + 1);

preload = replaceOnce(
  preload,
  '{ texture: gpu.stagingTexture },',
  '{ texture: gpu.context.getCurrentTexture() },',
  'restore direct canvas destination'
);

const stagedTail = `      // The source shared image is copied into a private WebGPU texture now.\n      // Source ownership still ends in this receiver turn; only the private GPU\n      // texture survives until the next compositor opportunity.\n      const nextFrameId = Number(metadata.frameId) || 0;\n      if (gpu.presentRaf && gpu.latestFrameId && gpu.latestFrameId !== gpu.lastPresentedFrameId && gpu.latestFrameId !== nextFrameId) {\n        gpuCoalescedFrames += 1;\n      }\n      gpu.latestFrameId = nextFrameId;\n      gpu.latestPlayerId = Number(metadata.playerId) || 0;\n      gpu.latestExpectedFps = Number(metadata.fps) || 0;\n      gpu.latestDisplayFrequency = Number(metadata.displayFrequency) || 0;\n      gpu.lastSourceAtMs = performance.now();\n      ensureGpuPresentLoop(gpu);`;
const directTail = `      // Direct presentation is the already hardware-qualified R2H/R2V path.\n      // The copy is queued straight into Chromium's current canvas texture and\n      // the source VideoFrame/imported texture is still closed/released below in\n      // this same receiver turn. No rAF callback owns or gates a source frame.\n      presentedFrames += 1;\n      gpuPresentFrames += 1;\n      gpuPresentSubmitSamples += 1;\n      gpuPresentSubmitTotalMs += lastDrawMs;\n      gpuPresentSubmitMaxMs = Math.max(gpuPresentSubmitMaxMs, lastDrawMs);\n      observePresentationCadence(metadata, performance.now());`;
preload = replaceOnce(preload, stagedTail, directTail, 'remove rAF presentation gate');

// These remain for diagnostic schema compatibility but must prove that no rAF
// loop/coalescing path is active in R2Z.
preload = replaceOnce(
  preload,
  `      gpuCoalescedFrames,\n      gpuPresentLoopTicks,\n      gpuPresentLoopStarts,\n      gpuPresentLoopStops,`,
  `      gpuCoalescedFrames,\n      gpuPresentLoopTicks,\n      gpuPresentLoopStarts,\n      gpuPresentLoopStops,`,
  'retain zero-valued legacy presentation counters'
);

// Lock the top-right UI to one coordinate system regardless of F/fullscreen.
// R2Y accidentally reintroduced .windowed-only offsets, which is exactly why
// the gear/status/settings panel jumped by ~134 px on every fullscreen toggle.
css = replaceOnce(
  css,
  '.immersive-player.windowed .player-top { padding-right: 158px; }',
  '.immersive-player .player-top { padding-right: 28px; }',
  'stable top-right controls'
);
css = replaceOnce(
  css,
  '.immersive-player.windowed .player-settings { right: 150px; }',
  '.immersive-player .player-settings { right: 16px; }',
  'stable settings panel'
);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r2y.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r8') {
  throw new Error(`expected R2Y identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r2z.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r9';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2Z-Setup.${ext}';

for (const marker of [
  "presentationMode = 'direct-receive-webgpu-copy'",
  'copyExternalImageToTexture',
  '{ texture: gpu.context.getCurrentTexture() }',
  'presentedFrames += 1',
  'observePresentationCadence(metadata, performance.now())'
]) {
  if (!preload.includes(marker)) throw new Error(`R2Z direct presenter marker missing: ${marker}`);
}
for (const forbidden of ['stagingTexture', 'copyTextureToTexture', 'ensureGpuPresentLoop', 'GPU_PRESENT_IDLE_STOP_MS', 'requestAnimationFrame(']) {
  if (preload.includes(forbidden)) throw new Error(`R2Z forbidden rAF/staging marker survived: ${forbidden}`);
}
if (preload.includes('setSharedTextureReceiver(async') || preload.includes('await requestAnimationFrame')) {
  throw new Error('R2Z violated immediate source lifetime');
}
for (const marker of ['ACTIVE_PUMP_RETRY_MS = 2', 'ACTIVE_PUMP_LEAD_MS = 6', 'pumpExpectedFps', 'refreshPumpTimingState']) {
  if (!bridge.includes(marker)) throw new Error(`R2Z lost phase-aware pump marker: ${marker}`);
}
if (!css.includes('.immersive-player .player-top { padding-right: 28px; }')) throw new Error('R2Z stable top-right CSS missing');
if (!css.includes('.immersive-player .player-settings { right: 16px; }')) throw new Error('R2Z stable settings CSS missing');
if (css.includes('.immersive-player.windowed .player-top') || css.includes('.immersive-player.windowed .player-settings')) {
  throw new Error('R2Z fullscreen-dependent top-right CSS survived');
}

write('electron/libmpv-shared-preload.cjs', preload);
write('src/player-android.css', css);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

const entry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const out = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(entry)) throw new Error('R2Z preload entry missing');
buildSync({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});
const bundled = read('electron/preload-libmpv-shared.generated.cjs');
for (const marker of ["direct-receive-webgpu-copy", 'copyExternalImageToTexture', 'receiveCadenceTracker']) {
  if (!bundled.includes(marker)) throw new Error(`R2Z generated preload marker missing: ${marker}`);
}
for (const forbidden of ['stagingTexture', 'copyTextureToTexture', 'ensureGpuPresentLoop', 'requestAnimationFrame(']) {
  if (bundled.includes(forbidden)) throw new Error(`R2Z generated preload retained forbidden marker: ${forbidden}`);
}
if (bundled.includes('setSharedTextureReceiver(async')) throw new Error('R2Z generated preload changed immediate source lifetime');

console.log('LIBMPV_R2Z_OK presentation=direct-receive-webgpu-copy pump=R2Y-phase-aware sourceLifetime=immediate ui=fixed-right');

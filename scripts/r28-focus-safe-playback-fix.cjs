'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');
let preload = read('electron/libmpv-shared-preload.cjs');

if (!bridge.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R28 requires R27 main diagnostics');
if (!preload.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R28 requires R27 renderer diagnostics');
if (!bridge.includes('frameProducerStarted') || !bridge.includes('addon.popProducedFrame')) throw new Error('R28 requires R3E native producer');
if (!bridge.includes('nativeWakePending') || !bridge.includes('wakePumpFromNative')) throw new Error('R28 requires R3B callback/pending-wake path');
if (!bridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX')) throw new Error('R28 requires R24 serial latest-frame mailbox');
if (!preload.includes("presentationMode = 'direct-receive-webgpu-copy'")) throw new Error('R28 requires direct WebGPU presenter');
if (!preload.includes('copyExternalImageToTexture')) throw new Error('R28 requires WebGPU external-image copy');
if (bridge.includes('LILAC_R28_FOCUS_SAFE_PLAYBACK') || preload.includes('LILAC_R28_FOCUS_SAFE_PLAYBACK')) throw new Error('R28 already applied');

// R27 hardware evidence shows the native worker remains cadence-perfect while the
// Electron main process can stop draining for hundreds of milliseconds. R3B had a
// callback-driven 250ms watchdog, but R3E changed native-producer empty-queue
// fallback to a 6ms poll and post-frame fallback to 0ms. Restore the callback as
// the authoritative wake source: wakePumpFromNative clears the watchdog timer and
// runs immediately, while nativeWakePending preserves callbacks that arrive during
// an active pump. The 250ms timer is therefore failure recovery, not frame pacing.
bridge = replaceOnce(
  bridge,
  `  let frameProducerStarted = false;\n  let noFrameBurstCount = 0;`,
  `  let frameProducerStarted = false; // LILAC_R28_FOCUS_SAFE_PLAYBACK\n  const R28_PRODUCER_JS_WATCHDOG_MS = 250;\n  let r28ProducerBacklogDropped = 0;\n  let noFrameBurstCount = 0;`,
  'R28 producer watchdog state'
);

// If main JS was stalled, the native worker may have accumulated several already
// rendered frames. Replaying those stale frames at 1-3ms intervals creates the
// visible catch-up burst seen in R27. Drain only what is already ready, release
// stale producer slots immediately, and present the newest frame. The native
// producer itself and its qualified DLL/addon bytes are unchanged.
const pumpStart = bridge.indexOf('  async function pump() {');
if (pumpStart < 0 || bridge.indexOf('  async function pump() {', pumpStart + 1) >= 0) throw new Error('R28 pump boundary must be unique');
const latestHelper = `  function r28PopLatestProducedFrame(ownerPlayerId) {\n    let latest = addon.popProducedFrame(ownerPlayerId);\n    if (!latest?.updated) return latest;\n    // There are 24 qualified producer slots, so 23 additional pops are enough to\n    // collapse every stale frame that can already be queued without waiting.\n    for (let i = 0; i < 23; i += 1) {\n      const next = addon.popProducedFrame(ownerPlayerId);\n      if (!next?.updated) break;\n      try {\n        if (addon.releaseProducedFrame(ownerPlayerId, Number(latest.slotId), Number(latest.frameId)) === true) {\n          r28ProducerBacklogDropped += 1;\n        }\n      } catch {}\n      latest = next;\n    }\n    return latest;\n  }\n\n`;
bridge = bridge.slice(0, pumpStart) + latestHelper + bridge.slice(pumpStart);

bridge = replaceOnce(
  bridge,
  `        nativeFrame = frameProducerStarted\n          ? addon.popProducedFrame(ownerPlayerId)\n          : addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  `        nativeFrame = frameProducerStarted\n          ? r28PopLatestProducedFrame(ownerPlayerId)\n          : addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  'collapse producer backlog to newest frame'
);

bridge = replaceOnce(
  bridge,
  `        nextDelay = frameProducerStarted ? NO_FRAME_BACKOFF_MS : nextActivePumpDelay(performance.now(), true);`,
  `        nextDelay = frameProducerStarted ? R28_PRODUCER_JS_WATCHDOG_MS : nextActivePumpDelay(performance.now(), true);`,
  'restore callback-driven empty-queue watchdog'
);
bridge = replaceOnce(
  bridge,
  `      nextDelay = frameProducerStarted ? 0 : nextActivePumpDelay(lastNativeFramePerfAt);`,
  `      nextDelay = frameProducerStarted ? R28_PRODUCER_JS_WATCHDOG_MS : nextActivePumpDelay(lastNativeFramePerfAt);`,
  'restore callback-driven post-frame watchdog'
);

bridge = replaceOnce(
  bridge,
  `      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      pendingFrames: pendingFrames.size,`,
  `      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      r28ProducerDrain: {\n        watchdogMs: R28_PRODUCER_JS_WATCHDOG_MS,\n        backlogDropped: r28ProducerBacklogDropped,\n        callbackAuthoritative: nativeUpdateCallbackInstalled === true\n      },\n      pendingFrames: pendingFrames.size,`,
  'expose R28 producer drain diagnostics'
);

// Renderer: keep the user-qualified direct copy unchanged while focused. R27
// proves that while unfocused the source arrives and copy submission stays fast,
// yet the Windows/Chromium presentation still flashes black. In that state only,
// first copy the external VideoFrame into a Chromium-owned private WebGPU texture,
// then copy that texture into the current canvas texture. This keeps an internal
// GPU-owned source for the final compositor step without CPU readback, rAF, or a
// queue-completion fence.
preload = replaceOnce(
  preload,
  `let lastGpuError = null;`,
  `let lastGpuError = null;\nlet r28DirectFrames = 0; // LILAC_R28_FOCUS_SAFE_PLAYBACK\nlet r28FocusStagedFrames = 0;\nlet r28FocusStagingFailures = 0;\nlet r28LastPresentationPath = 'direct-external-to-canvas';`,
  'R28 renderer counters'
);

const sendStatsAt = preload.indexOf('function sendStats(');
if (sendStatsAt < 0 || preload.indexOf('function sendStats(', sendStatsAt + 1) >= 0) throw new Error('R28 sendStats boundary must be unique');
const stagingHelper = `function r28FocusStagingTexture(state, width, height) {\n  if (!state || state.status !== 'ready' || !state.device) throw new Error('R28 staging GPU state unavailable');\n  if (state.r28StagingTexture && state.r28StagingWidth === width && state.r28StagingHeight === height) {\n    return state.r28StagingTexture;\n  }\n  const usage = globalThis.GPUTextureUsage;\n  if (!usage) throw new Error('GPUTextureUsage unavailable');\n  try { state.r28StagingTexture?.destroy?.(); } catch {}\n  state.r28StagingTexture = state.device.createTexture({\n    size: { width, height, depthOrArrayLayers: 1 },\n    format: state.format,\n    usage: usage.COPY_DST | usage.COPY_SRC\n  });\n  state.r28StagingWidth = width;\n  state.r28StagingHeight = height;\n  return state.r28StagingTexture;\n}\n\n`;
preload = preload.slice(0, sendStatsAt) + stagingHelper + preload.slice(sendStatsAt);

preload = replaceOnce(
  preload,
  `      const drawStarted = performance.now();\n      try {\n        gpu.device.queue.copyExternalImageToTexture(\n          { source: frame },\n          { texture: gpu.context.getCurrentTexture() },\n          { width, height, depthOrArrayLayers: 1 }\n        );\n      } catch (error) {\n        gpuCopyFailures += 1;\n        lastGpuError = String(error?.message || error).slice(0, 160);\n        throw error;\n      }`,
  `      const drawStarted = performance.now();\n      const r28UseFocusStaging = r27RendererFocused === false;\n      try {\n        if (r28UseFocusStaging) {\n          const stagingTexture = r28FocusStagingTexture(gpu, width, height);\n          gpu.device.queue.copyExternalImageToTexture(\n            { source: frame },\n            { texture: stagingTexture },\n            { width, height, depthOrArrayLayers: 1 }\n          );\n          const encoder = gpu.device.createCommandEncoder({ label: 'lilac-r28-focus-present' });\n          encoder.copyTextureToTexture(\n            { texture: stagingTexture },\n            { texture: gpu.context.getCurrentTexture() },\n            { width, height, depthOrArrayLayers: 1 }\n          );\n          gpu.device.queue.submit([encoder.finish()]);\n          r28FocusStagedFrames += 1;\n          r28LastPresentationPath = 'focus-staged-gpu-copy';\n        } else {\n          gpu.device.queue.copyExternalImageToTexture(\n            { source: frame },\n            { texture: gpu.context.getCurrentTexture() },\n            { width, height, depthOrArrayLayers: 1 }\n          );\n          r28DirectFrames += 1;\n          r28LastPresentationPath = 'direct-external-to-canvas';\n        }\n      } catch (error) {\n        if (r28UseFocusStaging) r28FocusStagingFailures += 1;\n        gpuCopyFailures += 1;\n        lastGpuError = String(error?.message || error).slice(0, 160);\n        throw error;\n      }`,
  'focus-only private WebGPU staging presenter'
);

preload = replaceOnce(
  preload,
  `      receiverStatsSuppressed,\n      ...extra`,
  `      receiverStatsSuppressed,\n      r28FocusSafePlayback: 'LILAC_R28_FOCUS_SAFE_PLAYBACK',\n      r28DirectFrames,\n      r28FocusStagedFrames,\n      r28FocusStagingFailures,\n      r28LastPresentationPath,\n      ...extra`,
  'R28 receiver diagnostics fields'
);

// Do not depend on the older bridge receiverStats schema for R28 proof. R26/R27
// already has an on-demand renderer diagnostic snapshot, so expose R28 counters
// directly there. This also avoids any extra per-frame IPC or parser coupling.
preload = replaceOnce(
  preload,
  `    worstTransportFrameId: r26WorstTransportFrameId,\n    r27: {`,
  `    worstTransportFrameId: r26WorstTransportFrameId,\n    r28: {\n      focusSafePlayback: 'LILAC_R28_FOCUS_SAFE_PLAYBACK',\n      directFrames: r28DirectFrames,\n      focusStagedFrames: r28FocusStagedFrames,\n      focusStagingFailures: r28FocusStagingFailures,\n      lastPresentationPath: r28LastPresentationPath\n    },\n    r27: {`,
  'R28 on-demand renderer trace diagnostics'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);

const entry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const out = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(entry)) throw new Error('R28 preload entry missing');
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

const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalPreload = read('electron/libmpv-shared-preload.cjs');
const bundled = read('electron/preload-libmpv-shared.generated.cjs');
for (const marker of [
  'LILAC_R28_FOCUS_SAFE_PLAYBACK', 'R28_PRODUCER_JS_WATCHDOG_MS = 250',
  'r28PopLatestProducedFrame', 'r28ProducerBacklogDropped', 'callbackAuthoritative'
]) {
  if (!finalBridge.includes(marker)) throw new Error(`R28 bridge marker missing: ${marker}`);
}
for (const marker of [
  'LILAC_R28_FOCUS_SAFE_PLAYBACK', 'r28FocusStagingTexture', 'focus-staged-gpu-copy',
  'copyExternalImageToTexture', 'copyTextureToTexture', 'r28FocusStagedFrames', 'focusStagingFailures'
]) {
  if (!finalPreload.includes(marker) || !bundled.includes(marker)) throw new Error(`R28 preload marker missing: ${marker}`);
}
for (const forbidden of ['requestAnimationFrame(', 'onSubmittedWorkDone(']) {
  if (finalPreload.includes(forbidden) || bundled.includes(forbidden)) throw new Error(`R28 reintroduced forbidden renderer synchronization: ${forbidden}`);
}
if (!finalBridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX') || !finalBridge.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R28 lost main qualified baseline');
if (!finalPreload.includes("presentationMode = 'direct-receive-webgpu-copy'") || !finalPreload.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R28 lost renderer qualified baseline');
if (finalBridge.includes('frameProducerStarted ? NO_FRAME_BACKOFF_MS') || finalBridge.includes('frameProducerStarted ? 0 : nextActivePumpDelay')) throw new Error('R28 retained R3E busy JS producer fallback');

console.log('R28_FOCUS_SAFE_PLAYBACK_OK focused=direct-webgpu unfocused=private-staging-webgpu raf=off gpuFence=off producerWatchdogMs=250 backlog=newest-only nativeBytes=unchanged');

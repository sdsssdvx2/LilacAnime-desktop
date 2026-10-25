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

if (!bridge.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R29 requires R27 main diagnostics');
if (!preload.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R29 requires R27 renderer diagnostics');
if (!bridge.includes('frameProducerStarted') || !bridge.includes('addon.popProducedFrame')) throw new Error('R29 requires R3E native producer');
if (!bridge.includes('nativeWakePending') || !bridge.includes('wakePumpFromNative')) throw new Error('R29 requires callback/pending-wake path');
if (!bridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX')) throw new Error('R29 requires serial latest-frame mailbox');
if (!preload.includes("presentationMode = 'direct-receive-webgpu-copy'")) throw new Error('R29 requires direct WebGPU presenter');
if (!preload.includes('copyExternalImageToTexture')) throw new Error('R29 requires direct WebGPU copy');
if (preload.includes('r28FocusStagingTexture') || preload.includes('focus-staged-gpu-copy') || preload.includes('copyTextureToTexture')) {
  throw new Error('R29 must be based on R27; failed R28 staging path is forbidden');
}
if (bridge.includes('LILAC_R29_GPU_SAFE_LIFETIME') || preload.includes('LILAC_R29_GPU_SAFE_LIFETIME')) throw new Error('R29 already applied');

// Main-process drain repair retained from the evidence-driven part of R28 only.
// Native callback remains authoritative; 250ms is a watchdog, not frame pacing.
bridge = replaceOnce(
  bridge,
  `  let frameProducerStarted = false;\n  let noFrameBurstCount = 0;`,
  `  let frameProducerStarted = false; // LILAC_R29_GPU_SAFE_LIFETIME\n  const R29_PRODUCER_JS_WATCHDOG_MS = 250;\n  let r29ProducerBacklogDropped = 0;\n  let noFrameBurstCount = 0;`,
  'R29 producer watchdog state'
);

const pumpStart = bridge.indexOf('  async function pump() {');
if (pumpStart < 0 || bridge.indexOf('  async function pump() {', pumpStart + 1) >= 0) throw new Error('R29 pump boundary must be unique');
const latestHelper = `  function r29PopLatestProducedFrame(ownerPlayerId) {\n    let latest = addon.popProducedFrame(ownerPlayerId);\n    if (!latest?.updated) return latest;\n    // Producer has 24 qualified slots. Collapse only frames already queued now;\n    // never wait for another native frame. This removes post-stall catch-up bursts.\n    for (let i = 0; i < 23; i += 1) {\n      const next = addon.popProducedFrame(ownerPlayerId);\n      if (!next?.updated) break;\n      try {\n        if (addon.releaseProducedFrame(ownerPlayerId, Number(latest.slotId), Number(latest.frameId)) === true) {\n          r29ProducerBacklogDropped += 1;\n        }\n      } catch {}\n      latest = next;\n    }\n    return latest;\n  }\n\n`;
bridge = bridge.slice(0, pumpStart) + latestHelper + bridge.slice(pumpStart);

bridge = replaceOnce(
  bridge,
  `        nativeFrame = frameProducerStarted\n          ? addon.popProducedFrame(ownerPlayerId)\n          : addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  `        nativeFrame = frameProducerStarted\n          ? r29PopLatestProducedFrame(ownerPlayerId)\n          : addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  'collapse producer backlog to newest frame'
);
bridge = replaceOnce(
  bridge,
  `        nextDelay = frameProducerStarted ? NO_FRAME_BACKOFF_MS : nextActivePumpDelay(performance.now(), true);`,
  `        nextDelay = frameProducerStarted ? R29_PRODUCER_JS_WATCHDOG_MS : nextActivePumpDelay(performance.now(), true);`,
  'callback-driven empty-queue watchdog'
);
bridge = replaceOnce(
  bridge,
  `      nextDelay = frameProducerStarted ? 0 : nextActivePumpDelay(lastNativeFramePerfAt);`,
  `      nextDelay = frameProducerStarted ? R29_PRODUCER_JS_WATCHDOG_MS : nextActivePumpDelay(lastNativeFramePerfAt);`,
  'callback-driven post-frame watchdog'
);
bridge = replaceOnce(
  bridge,
  `      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      pendingFrames: pendingFrames.size,`,
  `      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      r29ProducerDrain: {\n        watchdogMs: R29_PRODUCER_JS_WATCHDOG_MS,\n        backlogDropped: r29ProducerBacklogDropped,\n        callbackAuthoritative: nativeUpdateCallbackInstalled === true\n      },\n      pendingFrames: pendingFrames.size,`,
  'R29 producer diagnostics'
);

// Renderer lifetime repair. Keep the exact R27 direct WebGPU presentation path.
// VideoFrame.close() is still immediate: Electron documents that the underlying
// resource waits for GPU completion internally. The imported shared-texture
// reference is different: use subtle.release(callback) so Electron delays the
// final reference release until the GPU command buffer is done with the source.
// Main's allReferencesReleased callback therefore cannot return the R3E D3D11
// producer slot early. This adds no rAF gate and no queue.onSubmittedWorkDone wait.
preload = replaceOnce(
  preload,
  `let textureReleaseFailures = 0;`,
  `let textureReleaseFailures = 0;\nlet r29GpuSafeReleaseCalls = 0; // LILAC_R29_GPU_SAFE_LIFETIME\nlet r29GpuSafeReleaseCallbacks = 0;\nlet r29GpuSafeReleaseFallbacks = 0;\nlet r29GpuSafeReleasePending = 0;\nlet r29GpuSafeReleaseMaxPending = 0;\nlet r29GpuSafeReleaseMaxMs = 0;`,
  'R29 lifetime counters'
);

const oldRelease = `      try {\n        if (importedSharedTexture?.release) {\n          importedSharedTexture.release();\n          textureReleaseCalls += 1;\n        }\n      } catch {\n        textureReleaseFailures += 1;\n        lifetimeFailure = true;\n      }`;
const newRelease = `      try {\n        const subtleRelease = importedSharedTexture?.subtle?.release;\n        if (typeof subtleRelease === 'function') {\n          const r29ReleaseStarted = performance.now();\n          r29GpuSafeReleaseCalls += 1;\n          r29GpuSafeReleasePending += 1;\n          r29GpuSafeReleaseMaxPending = Math.max(r29GpuSafeReleaseMaxPending, r29GpuSafeReleasePending);\n          let r29ReleaseSettled = false;\n          subtleRelease.call(importedSharedTexture.subtle, () => {\n            if (r29ReleaseSettled) return;\n            r29ReleaseSettled = true;\n            r29GpuSafeReleasePending = Math.max(0, r29GpuSafeReleasePending - 1);\n            r29GpuSafeReleaseCallbacks += 1;\n            r29GpuSafeReleaseMaxMs = Math.max(r29GpuSafeReleaseMaxMs, Math.max(0, performance.now() - r29ReleaseStarted));\n          });\n          textureReleaseCalls += 1;\n        } else if (importedSharedTexture?.release) {\n          // Compatibility fallback only. Electron 44.9.3 is expected to expose\n          // SharedTextureImported.subtle.release(callback).\n          importedSharedTexture.release();\n          textureReleaseCalls += 1;\n          r29GpuSafeReleaseFallbacks += 1;\n        }\n      } catch {\n        r29GpuSafeReleasePending = Math.max(0, r29GpuSafeReleasePending - 1);\n        textureReleaseFailures += 1;\n        lifetimeFailure = true;\n      }`;
preload = replaceOnce(preload, oldRelease, newRelease, 'GPU-safe sharedTexture release');

// Expose proof only through the existing low-rate stats and on-demand R26/R27
// snapshot; do not add a new per-frame IPC channel.
preload = replaceOnce(
  preload,
  `      textureReleaseFailures,\n      rendererMode,`,
  `      textureReleaseFailures,\n      r29GpuSafeReleaseCalls,\n      r29GpuSafeReleaseCallbacks,\n      r29GpuSafeReleaseFallbacks,\n      r29GpuSafeReleasePending,\n      r29GpuSafeReleaseMaxPending,\n      r29GpuSafeReleaseMaxMs: Math.round(r29GpuSafeReleaseMaxMs * 1000) / 1000,\n      rendererMode,`,
  'R29 receiver stats'
);
preload = replaceOnce(
  preload,
  `    worstTransportFrameId: r26WorstTransportFrameId,\n    r27: {`,
  `    worstTransportFrameId: r26WorstTransportFrameId,\n    r29: {\n      gpuSafeLifetime: 'LILAC_R29_GPU_SAFE_LIFETIME',\n      releaseCalls: r29GpuSafeReleaseCalls,\n      releaseCallbacks: r29GpuSafeReleaseCallbacks,\n      releaseFallbacks: r29GpuSafeReleaseFallbacks,\n      releasePending: r29GpuSafeReleasePending,\n      releaseMaxPending: r29GpuSafeReleaseMaxPending,\n      releaseMaxMs: Math.round(r29GpuSafeReleaseMaxMs * 1000) / 1000\n    },\n    r27: {`,
  'R29 on-demand lifetime diagnostics'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);

const entry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const out = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(entry)) throw new Error('R29 preload entry missing');
buildSync({
  entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', external: ['electron'], logLevel: 'info'
});

const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalPreload = read('electron/libmpv-shared-preload.cjs');
const bundled = read('electron/preload-libmpv-shared.generated.cjs');

for (const marker of [
  'LILAC_R29_GPU_SAFE_LIFETIME', 'R29_PRODUCER_JS_WATCHDOG_MS = 250',
  'r29PopLatestProducedFrame', 'r29ProducerBacklogDropped', 'callbackAuthoritative'
]) if (!finalBridge.includes(marker)) throw new Error(`R29 bridge marker missing: ${marker}`);

for (const marker of [
  'LILAC_R29_GPU_SAFE_LIFETIME', 'importedSharedTexture?.subtle?.release',
  'r29GpuSafeReleaseCallbacks', 'r29GpuSafeReleasePending', 'r29GpuSafeReleaseMaxPending'
]) {
  if (!finalPreload.includes(marker)) throw new Error(`R29 preload marker missing: ${marker}`);
  if (marker !== 'LILAC_R29_GPU_SAFE_LIFETIME' && !bundled.includes(marker.replace('importedSharedTexture?.subtle?.release', 'subtle'))) {
    if (!bundled.includes('r29GpuSafeRelease')) throw new Error(`R29 bundled lifetime marker missing: ${marker}`);
  }
}

for (const forbidden of ['r28FocusStagingTexture', 'focus-staged-gpu-copy', 'copyTextureToTexture', 'requestAnimationFrame(', 'onSubmittedWorkDone(']) {
  if (finalPreload.includes(forbidden) || bundled.includes(forbidden)) throw new Error(`R29 forbidden renderer path survived: ${forbidden}`);
}
if (!finalPreload.includes("presentationMode = 'direct-receive-webgpu-copy'") || !finalPreload.includes('copyExternalImageToTexture')) {
  throw new Error('R29 lost R27 direct WebGPU presenter');
}
if (!finalBridge.includes('LILAC_R27_FOCUS_STALL_RETENTION') || !finalPreload.includes('LILAC_R27_FOCUS_STALL_RETENTION')) {
  throw new Error('R29 lost R27 diagnostics');
}
if (finalBridge.includes('frameProducerStarted ? NO_FRAME_BACKOFF_MS') || finalBridge.includes('frameProducerStarted ? 0 : nextActivePumpDelay')) {
  throw new Error('R29 retained R3E busy JS producer fallback');
}

console.log('R29_GPU_SAFE_LIFETIME_OK presenter=direct-webgpu staging=removed release=subtle-gpu-finished producerWatchdogMs=250 backlog=newest-only nativeBytes=unchanged');

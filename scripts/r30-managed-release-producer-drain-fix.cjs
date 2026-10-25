'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');
const preloadBefore = read('electron/libmpv-shared-preload.cjs');
const bundledBefore = read('electron/preload-libmpv-shared.generated.cjs');
const preloadHashBefore = sha256(preloadBefore);
const bundledHashBefore = sha256(bundledBefore);

if (!bridge.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R30 requires R27 main diagnostics');
if (!preloadBefore.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R30 requires R27 renderer diagnostics');
if (!bridge.includes('frameProducerStarted') || !bridge.includes('addon.popProducedFrame')) throw new Error('R30 requires R3E native producer');
if (!bridge.includes('nativeWakePending') || !bridge.includes('wakePumpFromNative')) throw new Error('R30 requires callback/pending-wake path');
if (!bridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX')) throw new Error('R30 requires serial latest-frame mailbox');
if (!preloadBefore.includes("presentationMode = 'direct-receive-webgpu-copy'")) throw new Error('R30 requires R27 direct WebGPU presenter');
if (!preloadBefore.includes('copyExternalImageToTexture')) throw new Error('R30 requires direct WebGPU copy');
if (!preloadBefore.includes('importedSharedTexture?.release')) throw new Error('R30 requires Electron managed SharedTextureImported.release path');
for (const forbidden of [
  'LILAC_R28_FOCUS_SAFE_PLAYBACK', 'r28FocusStagingTexture', 'focus-staged-gpu-copy', 'copyTextureToTexture',
  'LILAC_R29_GPU_SAFE_LIFETIME', 'r29GpuSafeReleaseCallbacks', 'importedSharedTexture?.subtle?.release',
  'requestAnimationFrame(', 'onSubmittedWorkDone('
]) {
  if (preloadBefore.includes(forbidden) || bundledBefore.includes(forbidden)) throw new Error(`R30 forbidden renderer marker present before patch: ${forbidden}`);
}
if (bridge.includes('LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN')) throw new Error('R30 already applied');

// R27 hardware evidence showed a cadence-perfect native worker while Electron main
// occasionally stopped draining for hundreds of milliseconds or longer. Keep the
// native callback authoritative and use 250ms only as a failure-recovery watchdog.
bridge = replaceOnce(
  bridge,
  `  let frameProducerStarted = false;\n  let noFrameBurstCount = 0;`,
  `  let frameProducerStarted = false; // LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN\n  const R30_PRODUCER_JS_WATCHDOG_MS = 250;\n  let r30ProducerBacklogDropped = 0;\n  let noFrameBurstCount = 0;`,
  'R30 producer watchdog state'
);

// After a main-thread stall, the 24-slot native producer can contain multiple
// already-rendered stale frames. Drain only frames that are ready right now,
// release stale producer slots immediately, and deliver the newest one. Never
// wait for another frame in this helper and never modify native producer bytes.
const pumpStart = bridge.indexOf('  async function pump() {');
if (pumpStart < 0 || bridge.indexOf('  async function pump() {', pumpStart + 1) >= 0) throw new Error('R30 pump boundary must be unique');
const helper = `  function r30PopLatestProducedFrame(ownerPlayerId) {\n    let latest = addon.popProducedFrame(ownerPlayerId);\n    if (!latest?.updated) return latest;\n    for (let i = 0; i < 23; i += 1) {\n      const next = addon.popProducedFrame(ownerPlayerId);\n      if (!next?.updated) break;\n      try {\n        if (addon.releaseProducedFrame(ownerPlayerId, Number(latest.slotId), Number(latest.frameId)) === true) {\n          r30ProducerBacklogDropped += 1;\n        }\n      } catch {}\n      latest = next;\n    }\n    return latest;\n  }\n\n`;
bridge = bridge.slice(0, pumpStart) + helper + bridge.slice(pumpStart);

bridge = replaceOnce(
  bridge,
  `        nativeFrame = frameProducerStarted\n          ? addon.popProducedFrame(ownerPlayerId)\n          : addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  `        nativeFrame = frameProducerStarted\n          ? r30PopLatestProducedFrame(ownerPlayerId)\n          : addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  'R30 collapse producer backlog to newest'
);
bridge = replaceOnce(
  bridge,
  `        nextDelay = frameProducerStarted ? NO_FRAME_BACKOFF_MS : nextActivePumpDelay(performance.now(), true);`,
  `        nextDelay = frameProducerStarted ? R30_PRODUCER_JS_WATCHDOG_MS : nextActivePumpDelay(performance.now(), true);`,
  'R30 empty-queue watchdog'
);
bridge = replaceOnce(
  bridge,
  `      nextDelay = frameProducerStarted ? 0 : nextActivePumpDelay(lastNativeFramePerfAt);`,
  `      nextDelay = frameProducerStarted ? R30_PRODUCER_JS_WATCHDOG_MS : nextActivePumpDelay(lastNativeFramePerfAt);`,
  'R30 post-frame watchdog'
);
bridge = replaceOnce(
  bridge,
  `      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      pendingFrames: pendingFrames.size,`,
  `      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      r30ProducerDrain: {\n        watchdogMs: R30_PRODUCER_JS_WATCHDOG_MS,\n        backlogDropped: r30ProducerBacklogDropped,\n        callbackAuthoritative: nativeUpdateCallbackInstalled === true,\n        rendererReleaseMode: 'electron-managed-sync-token'\n      },\n      pendingFrames: pendingFrames.size,`,
  'R30 producer diagnostics'
);

write('electron/libmpv-shared-main.cjs', bridge);

// Renderer must remain byte-identical to the R27 result. Electron's managed
// sendSharedTexture receiver owns lifetime via sync token and must continue to use
// SharedTextureImported.release(), not the subtle-transfer API used by R29.
const preloadAfter = read('electron/libmpv-shared-preload.cjs');
const bundledAfter = read('electron/preload-libmpv-shared.generated.cjs');
if (sha256(preloadAfter) !== preloadHashBefore) throw new Error('R30 changed R27 preload source unexpectedly');
if (sha256(bundledAfter) !== bundledHashBefore) throw new Error('R30 changed R27 preload bundle unexpectedly');

const finalBridge = read('electron/libmpv-shared-main.cjs');
for (const marker of [
  'LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN', 'R30_PRODUCER_JS_WATCHDOG_MS = 250',
  'r30PopLatestProducedFrame', 'r30ProducerBacklogDropped', "rendererReleaseMode: 'electron-managed-sync-token'"
]) if (!finalBridge.includes(marker)) throw new Error(`R30 bridge marker missing: ${marker}`);
if (finalBridge.includes('frameProducerStarted ? NO_FRAME_BACKOFF_MS') || finalBridge.includes('frameProducerStarted ? 0 : nextActivePumpDelay')) {
  throw new Error('R30 retained R3E busy JS producer fallback');
}
for (const marker of ['importedSharedTexture?.release', "presentationMode = 'direct-receive-webgpu-copy'", 'copyExternalImageToTexture', 'LILAC_R27_FOCUS_STALL_RETENTION']) {
  if (!preloadAfter.includes(marker)) throw new Error(`R30 R27 renderer marker missing: ${marker}`);
}
for (const forbidden of ['LILAC_R28_FOCUS_SAFE_PLAYBACK', 'LILAC_R29_GPU_SAFE_LIFETIME', 'r29GpuSafeReleaseCallbacks', 'importedSharedTexture?.subtle?.release', 'r28FocusStagingTexture', 'copyTextureToTexture']) {
  if (preloadAfter.includes(forbidden) || bundledAfter.includes(forbidden)) throw new Error(`R30 forbidden renderer marker survived: ${forbidden}`);
}

console.log(`R30_MANAGED_RELEASE_PRODUCER_DRAIN_OK rendererSourceSha256=${preloadHashBefore} rendererBundleSha256=${bundledHashBefore} release=managed-sync-token producerWatchdogMs=250 backlog=newest-only nativeBytes=unchanged`);

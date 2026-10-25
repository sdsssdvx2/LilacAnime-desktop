'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

// R24 keeps the R3E native producer. User hardware shows that producer at
// 23.975 fps with a 44.3 ms max interval; the remaining ~107 ms gap appears at
// the Electron main->renderer shared-texture transfer boundary. Do not regress
// the producer or direct WebGPU presentation while fixing that boundary.
let main = read('electron/main.cjs');
let bridge = read('electron/libmpv-shared-main.cjs');

assert(main.includes("app.commandLine.appendSwitch('disable-renderer-backgrounding');"), 'renderer backgrounding baseline missing');
assert(!main.includes('LILAC_R24_INACTIVE_COMPOSITOR_GUARD'), 'R24 inactive compositor guard already applied');
main = replaceOnce(
  main,
  "app.commandLine.appendSwitch('disable-renderer-backgrounding');",
  `app.commandLine.appendSwitch('disable-renderer-backgrounding');\n// LILAC_R24_INACTIVE_COMPOSITOR_GUARD: playback must remain visually stable when\n// the Lilac window is unfocused, covered, fullscreen, windowed, or mini-player.\n// backgroundThrottling=false protects renderer timers, while these Chromium\n// switches prevent the separate Windows native-occlusion path from backgrounding\n// the window/compositor when focus or occlusion changes.\napp.commandLine.appendSwitch('disable-backgrounding-occluded-windows');\napp.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');`,
  'inactive compositor guard'
);

assert(bridge.includes('async function deliverImportedFrame(delivery) {'), 'R3A/R3E async delivery helper missing');
assert(bridge.includes('frameProducerStarted'), 'R3E native producer baseline missing');
assert(bridge.includes('MAX_PENDING_DELIVERY_FRAMES = 12'), 'bounded delivery baseline missing');
assert(!bridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX'), 'R24 delivery mailbox already applied');

bridge = replaceOnce(
  bridge,
  '  let deliveryInFlight = 0;\n',
  `  let deliveryInFlight = 0;\n  // LILAC_R24_LATEST_FRAME_MAILBOX: Electron sharedTexture transfer is serialized.\n  // Normal transfer is ~1 ms versus a ~41.7 ms source period, so concurrency is\n  // unnecessary. If Chromium stalls while the window is inactive, keep only the\n  // newest unsent frame instead of accumulating/bursting stale frames.\n  let deliveryMailboxActive = false;\n  let deliveryQueuedLatest = null;\n`
  , 'delivery mailbox state'
);

bridge = replaceOnce(
  bridge,
  '    deliveryThrottleCount: 0,\n',
  `    deliveryThrottleCount: 0,\n    deliveryCoalescedFrames: 0,\n    deliveryMailboxStarts: 0,\n    deliveryMailboxMaxQueued: 0,\n`,
  'delivery mailbox metrics'
);

const helperStart = bridge.indexOf('  async function deliverImportedFrame(delivery) {');
const pumpStart = bridge.indexOf('  async function pump() {', helperStart);
if (helperStart < 0 || pumpStart <= helperStart) throw new Error('delivery helper structural boundary missing');

const mailboxHelper = `  function releaseUnsentDelivery(delivery) {\n    try { delivery?.imported?.release?.(); } catch {}\n  }\n\n  async function sendImportedFrame(delivery) {\n    const {\n      imported, ownerPlayerId, ownerGeneration, slotId, frameId, width, height,\n      timestampUs, fps, displayFrequency\n    } = delivery || {};\n    if (!imported) return;\n    deliveryInFlight += 1;\n    metrics.deliveryStarted += 1;\n    metrics.deliveryMaxInFlight = Math.max(metrics.deliveryMaxInFlight, deliveryInFlight);\n    let sendStarted = 0;\n    try {\n      if (!active || ownerGeneration !== generation || ownerPlayerId !== playerId || !attachedWindow || attachedWindow.isDestroyed()) return;\n      sendStarted = performance.now();\n      let sendPromise;\n      const invokeStarted = performance.now();\n      try {\n        sendPromise = sharedTexture.sendSharedTexture({\n          frame: attachedWindow.webContents.mainFrame,\n          importedSharedTexture: imported\n        }, {\n          kind: 'lilac-libmpv-frame',\n          playerId: ownerPlayerId,\n          generation: ownerGeneration,\n          slotId,\n          frameId,\n          width,\n          height,\n          timestampUs,\n          fps,\n          displayFrequency\n        });\n      } finally {\n        const invokeElapsed = Math.max(0, performance.now() - invokeStarted);\n        metrics.sendInvokeSamples += 1;\n        metrics.sendInvokeTotalMs += invokeElapsed;\n        metrics.sendInvokeMaxMs = Math.max(metrics.sendInvokeMaxMs, invokeElapsed);\n      }\n      await sendPromise;\n      metrics.sentFrames += 1;\n    } catch (error) {\n      metrics.sendFailures += 1;\n      lastError = \`shared texture send failed: \${String(error?.message || error).slice(0, 180)}\`;\n    } finally {\n      if (sendStarted > 0) {\n        const sendElapsed = Math.max(0, performance.now() - sendStarted);\n        metrics.sendSharedTextureSamples += 1;\n        metrics.sendSharedTextureTotalMs += sendElapsed;\n        metrics.sendSharedTextureMaxMs = Math.max(metrics.sendSharedTextureMaxMs, sendElapsed);\n        metrics.lastSendSharedTextureMs = sendElapsed;\n      }\n      deliveryInFlight = Math.max(0, deliveryInFlight - 1);\n      metrics.deliveryCompleted += 1;\n      try { imported?.release?.(); } catch {}\n    }\n  }\n\n  async function drainDeliveryMailbox(initialDelivery) {\n    let current = initialDelivery;\n    try {\n      while (current) {\n        await sendImportedFrame(current);\n        current = deliveryQueuedLatest;\n        deliveryQueuedLatest = null;\n      }\n    } finally {\n      deliveryMailboxActive = false;\n      // A frame may have arrived after the loop observed an empty mailbox but\n      // before this finally block ran. Re-arm without allowing concurrent sends.\n      if (deliveryQueuedLatest) {\n        const next = deliveryQueuedLatest;\n        deliveryQueuedLatest = null;\n        enqueueImportedFrame(next);\n      }\n    }\n  }\n\n  function enqueueImportedFrame(delivery) {\n    if (!delivery?.imported) return;\n    if (!deliveryMailboxActive) {\n      deliveryMailboxActive = true;\n      metrics.deliveryMailboxStarts += 1;\n      void drainDeliveryMailbox(delivery);\n      return;\n    }\n    if (deliveryQueuedLatest?.imported) {\n      metrics.deliveryCoalescedFrames += 1;\n      releaseUnsentDelivery(deliveryQueuedLatest);\n    }\n    deliveryQueuedLatest = delivery;\n    metrics.deliveryMailboxMaxQueued = Math.max(metrics.deliveryMailboxMaxQueued, 1);\n  }\n\n`;
bridge = bridge.slice(0, helperStart) + mailboxHelper + bridge.slice(pumpStart);

bridge = replaceOnce(
  bridge,
  '      void deliverImportedFrame(delivery);',
  '      enqueueImportedFrame(delivery);',
  'route delivery through latest-frame mailbox'
);

// Drop an unsent queued frame when playback stops. The imported texture release
// drives the existing allReferencesReleased callback and returns its native slot.
bridge = replaceOnce(
  bridge,
  '    frameProducerStarted = false;\n    active = false;',
  `    frameProducerStarted = false;\n    if (deliveryQueuedLatest) {\n      releaseUnsentDelivery(deliveryQueuedLatest);\n      deliveryQueuedLatest = null;\n    }\n    active = false;`,
  'clear queued delivery on stop'
);

for (const marker of [
  'LILAC_R24_INACTIVE_COMPOSITOR_GUARD',
  "disable-backgrounding-occluded-windows",
  "CalculateNativeWinOcclusion",
  'LILAC_R24_LATEST_FRAME_MAILBOX',
  'deliveryQueuedLatest',
  'deliveryCoalescedFrames',
  'enqueueImportedFrame(delivery)'
]) {
  const source = marker.startsWith('LILAC_R24_INACTIVE') || marker.startsWith('disable-') || marker === 'CalculateNativeWinOcclusion' ? main : bridge;
  assert(source.includes(marker), `R24 marker missing: ${marker}`);
}
assert(!bridge.includes('async function deliverImportedFrame(delivery)'), 'old concurrent delivery helper survived');
assert(!bridge.includes('void deliverImportedFrame(delivery)'), 'old concurrent delivery launch survived');

write('electron/main.cjs', main);
write('electron/libmpv-shared-main.cjs', bridge);

console.log('R24_FOCUS_DELIVERY_OK nativeProducer=unchanged delivery=serial-latest mailbox=1 inactiveOcclusionGuard=1');

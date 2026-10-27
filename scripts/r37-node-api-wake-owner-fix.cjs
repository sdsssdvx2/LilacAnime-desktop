'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Structural repair is intentionally source-only and this file is also a watched CI trigger.
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'electron', 'libmpv-shared-main.cjs');
let bridge = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

if (!bridge.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')) {
  throw new Error('R37 Node-API wake scope fix requires post-transform R37 bridge');
}
if (bridge.includes('LILAC_R37_TS_FN_OWNER_SCOPE')) {
  throw new Error('R37 obsolete TSFN owner-binding workaround survived');
}

const wakeMarker = '  function wakePumpFromNative() {';
const wakeStart = bridge.indexOf(wakeMarker);
if (wakeStart < 0 || bridge.indexOf(wakeMarker, wakeStart + wakeMarker.length) >= 0) {
  throw new Error('R37 wakePumpFromNative boundary must be unique');
}
const wakeEnd = bridge.indexOf('\n\n  function ', wakeStart + wakeMarker.length);
if (wakeEnd <= wakeStart) throw new Error('R37 wakePumpFromNative end boundary missing');

const releaseMarker = '  function releaseNativeFrame(ownerPlayerId, slotId, frameId) {';
const releaseStart = bridge.indexOf(releaseMarker);
if (releaseStart < 0 || releaseStart >= wakeStart) {
  throw new Error('R37 releaseNativeFrame boundary missing before wake callback');
}

let wakeBlock = bridge.slice(wakeStart, wakeEnd);
const trackingNeedle = '    if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {';
const completionNeedle = '    r34CompleteFocusHandoff(ownerPlayerId, frameId);';
const trackingStart = wakeBlock.indexOf(trackingNeedle);
const completionStart = wakeBlock.indexOf(completionNeedle, Math.max(0, trackingStart));
let mode = 'already-correct';

if (trackingStart >= 0 || completionStart >= 0) {
  if (trackingStart < 0 || completionStart < trackingStart) {
    throw new Error('R37 inherited R36 release bookkeeping is incomplete inside wake callback');
  }
  const misplacedEnd = completionStart + completionNeedle.length;
  const misplacedReleaseBookkeeping = wakeBlock.slice(trackingStart, misplacedEnd);
  wakeBlock = wakeBlock.slice(0, trackingStart) + wakeBlock.slice(misplacedEnd);
  bridge = bridge.slice(0, wakeStart) + wakeBlock + bridge.slice(wakeEnd);

  const repairedWakeStart = bridge.indexOf(wakeMarker);
  const repairedReleaseStart = bridge.indexOf(releaseMarker);
  let releaseBlock = bridge.slice(repairedReleaseStart, repairedWakeStart);
  if (releaseBlock.includes(completionNeedle)) {
    throw new Error('R37 release callback already contains handoff completion; refusing duplicate insertion');
  }
  const releaseClose = releaseBlock.lastIndexOf('\n  }');
  if (releaseClose < 0) throw new Error('R37 releaseNativeFrame close boundary missing');
  releaseBlock = releaseBlock.slice(0, releaseClose) + '\n' + misplacedReleaseBookkeeping + releaseBlock.slice(releaseClose);
  bridge = bridge.slice(0, repairedReleaseStart) + releaseBlock + bridge.slice(repairedWakeStart);
  mode = 'relocated-r36-release-bookkeeping';
}

const finalWakeStart = bridge.indexOf(wakeMarker);
const finalWakeEnd = bridge.indexOf('\n\n  function ', finalWakeStart + wakeMarker.length);
let finalWakeBlock = bridge.slice(finalWakeStart, finalWakeEnd);
if (finalWakeBlock.includes('ownerPlayerId') || finalWakeBlock.includes('frameId')) {
  throw new Error('R37 TSFN wake callback still contains frame-owner variables');
}
if (!finalWakeBlock.includes('nativeWakePending') || !finalWakeBlock.includes('void pump()')) {
  throw new Error('R37 TSFN wake callback lost qualified R3B/R3D wake semantics');
}

const finalReleaseStart = bridge.indexOf(releaseMarker);
const finalReleaseEnd = bridge.indexOf(wakeMarker, finalReleaseStart + releaseMarker.length);
const finalReleaseBlock = bridge.slice(finalReleaseStart, finalReleaseEnd);
if (!finalReleaseBlock.includes('r36FocusHandoffReleasedFrames') || !finalReleaseBlock.includes(completionNeedle)) {
  throw new Error('R37 releaseNativeFrame missing inherited R36 release bookkeeping');
}

// R24 intentionally serialized SharedTexture transfers. The real R37 E2E proved
// a focus handoff can begin while the last focused transfer is still awaiting
// Chromium lifetime completion: producer/main drain continued (45/46 frames) but
// sentFrames stayed at 21, the handoff required frame >=22, and no renderer ACK
// could exist. Preserve serial-latest steady state, but permit exactly one bounded
// parallel transfer while an R37 handoff is pending. This is only an ownership
// handoff escape hatch; it does not alter direct WebGPU presentation or staging.
const mailboxStateNeedle = '  let deliveryMailboxActive = false;\n  let deliveryQueuedLatest = null;';
if (!bridge.includes(mailboxStateNeedle)) throw new Error('R37 mailbox escape requires R24 serial-latest state');
bridge = bridge.replace(
  mailboxStateNeedle,
  `${mailboxStateNeedle}\n  let r37HandoffEscapeActive = false; // LILAC_R37_HANDOFF_MAILBOX_ESCAPE\n  let r37HandoffEscapeTransfers = 0;\n  let r37HandoffEscapeMaxInFlight = 0;`
);

const enqueueMarker = '  function enqueueImportedFrame(delivery) {';
const enqueueStart = bridge.indexOf(enqueueMarker);
const enqueueEnd = bridge.indexOf('\n\n  async function pump() {', enqueueStart + enqueueMarker.length);
if (enqueueStart < 0 || enqueueEnd <= enqueueStart || bridge.indexOf(enqueueMarker, enqueueStart + enqueueMarker.length) >= 0) {
  throw new Error('R37 mailbox escape enqueueImportedFrame boundary must be unique');
}
const oldEnqueue = bridge.slice(enqueueStart, enqueueEnd);
if (!oldEnqueue.includes('deliveryMailboxActive = true;') || !oldEnqueue.includes('deliveryQueuedLatest = delivery;')) {
  throw new Error('R37 mailbox escape requires qualified R24 enqueue semantics');
}
const newEnqueue = `  function enqueueImportedFrame(delivery) {\n    if (!delivery?.imported) return;\n    // LILAC_R37_HANDOFF_MAILBOX_ESCAPE: if the pre-focus serial transfer is still\n    // awaiting Chromium lifetime completion, one epoch-tagged handoff frame must\n    // be allowed to reach the renderer or the explicit ACK protocol deadlocks.\n    // Never exceed one escape transfer; later frames still coalesce in R24's\n    // normal latest-frame mailbox.\n    if (r34FocusHandoffPending && deliveryMailboxActive && !r37HandoffEscapeActive) {\n      r37HandoffEscapeActive = true;\n      r37HandoffEscapeTransfers += 1;\n      r37HandoffEscapeMaxInFlight = Math.max(r37HandoffEscapeMaxInFlight, deliveryInFlight + 1);\n      void sendImportedFrame(delivery).finally(() => {\n        r37HandoffEscapeActive = false;\n      });\n      return;\n    }\n    if (!deliveryMailboxActive) {\n      deliveryMailboxActive = true;\n      metrics.deliveryMailboxStarts += 1;\n      void drainDeliveryMailbox(delivery);\n      return;\n    }\n    if (deliveryQueuedLatest?.imported) {\n      metrics.deliveryCoalescedFrames += 1;\n      releaseUnsentDelivery(deliveryQueuedLatest);\n    }\n    deliveryQueuedLatest = delivery;\n    metrics.deliveryMailboxMaxQueued = Math.max(metrics.deliveryMailboxMaxQueued, 1);\n  }`;
bridge = bridge.slice(0, enqueueStart) + newEnqueue + bridge.slice(enqueueEnd);

const r37DiagNeedle = '            regionNativeClears: r37PresenterRegionNativeClears';
if (!bridge.includes(r37DiagNeedle)) throw new Error('R37 mailbox escape diagnostics anchor missing');
bridge = bridge.replace(
  r37DiagNeedle,
  `${r37DiagNeedle},\n            mailboxEscapeTransfers: r37HandoffEscapeTransfers,\n            mailboxEscapeActive: r37HandoffEscapeActive,\n            mailboxEscapeMaxInFlight: r37HandoffEscapeMaxInFlight`
);

bridge = bridge.slice(0, finalWakeStart) +
  '  // LILAC_R37_TS_FN_RELEASE_SCOPE_REPAIRED: frame-owner bookkeeping belongs to releaseNativeFrame.\n' +
  bridge.slice(finalWakeStart);
fs.writeFileSync(target, bridge, 'utf8');

const out = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const outWakeStart = out.indexOf(wakeMarker);
const outWakeEnd = out.indexOf('\n\n  function ', outWakeStart + wakeMarker.length);
const outWake = out.slice(outWakeStart, outWakeEnd);
if (outWake.includes('ownerPlayerId') || outWake.includes('frameId')) {
  throw new Error('R37 packaged-source wake scope verification failed');
}
if (!out.includes('LILAC_R37_TS_FN_RELEASE_SCOPE_REPAIRED')) {
  throw new Error('R37 TSFN release-scope repair marker missing');
}
if (!out.includes('LILAC_R37_HANDOFF_MAILBOX_ESCAPE') ||
    !out.includes('r34FocusHandoffPending && deliveryMailboxActive && !r37HandoffEscapeActive')) {
  throw new Error('R37 bounded handoff mailbox escape verification failed');
}
if (out.includes('focus-staged-gpu-copy') || out.includes('copyTextureToTexture')) {
  throw new Error('R37 mailbox repair resurrected forbidden staged renderer path');
}

console.log('R37_NODE_API_WAKE_SCOPE_OK mode=' + mode + ' callback=wakePumpFromNative ownerRefs=0 frameRefs=0 releaseBookkeeping=releaseNativeFrame dep0168RootCause=mis-scoped-R34-boundary-repaired mailboxEscape=handoff-only-max1 directWebgpu=preserved');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Structural repair is intentionally source-only and this file is also a watched CI trigger.
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'electron', 'libmpv-shared-main.cjs');
let bridge = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

if (!bridge.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')) {
  throw new Error('R37 Node-API release-scope fix requires post-transform R37 bridge');
}
if (bridge.includes('LILAC_R37_TS_FN_OWNER_SCOPE')) {
  throw new Error('R37 obsolete TSFN owner-binding workaround survived');
}

function uniqueStart(source, marker, label) {
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) {
    throw new Error(`${label} boundary must be unique`);
  }
  return start;
}

function functionEnd(source, start, markerLength, label) {
  const searchAt = start + markerLength;
  const candidates = [
    source.indexOf('\n\n  function ', searchAt),
    source.indexOf('\n\n  async function ', searchAt)
  ].filter(index => index > start);
  if (!candidates.length) throw new Error(`${label} end boundary missing`);
  return Math.min(...candidates);
}

function countOccurrences(source, needle) {
  let count = 0;
  let at = 0;
  while ((at = source.indexOf(needle, at)) >= 0) {
    count += 1;
    at += needle.length;
  }
  return count;
}

const releaseMarker = '  function releaseNativeFrame(ownerPlayerId, slotId, frameId) {';
const wakeMarker = '  function wakePumpFromNative() {';
const deadlineMarker = '  function advanceNativeFrameDeadline(now = performance.now()) {';

// R34 used schedulePump as releaseNativeFrame's end boundary even though R3A/R3B
// had already inserted advanceNativeFrameDeadline + wakePumpFromNative in between.
// R36 then expanded that misplaced completion into release-before-send tracking.
// The old R37 repair correctly removed it from wakePumpFromNative, but used wake as
// the release end boundary and therefore moved the same block into
// advanceNativeFrameDeadline. It stayed dormant until focus handoff made the first
// short-circuit operand true, at which point ownerPlayerId became an immediate
// ReferenceError and 24 producer slots leaked. Repair by matching the exact R36
// release-bookkeeping block and putting its single copy inside the actual release
// function, whose end is the *first* following function boundary.
const releaseBookkeeping = `    if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {\n      const releasedFrameId = Number(frameId);\n      if (!r34FocusHandoffSentFrames.has(releasedFrameId)) r36ReleaseBeforeSend += 1;\n      r36FocusHandoffReleasedFrames.add(releasedFrameId);\n      while (r36FocusHandoffReleasedFrames.size > 24) r36FocusHandoffReleasedFrames.delete(r36FocusHandoffReleasedFrames.values().next().value);\n    }\n    r34CompleteFocusHandoff(ownerPlayerId, frameId);`;

let releaseStart = uniqueStart(bridge, releaseMarker, 'R37 releaseNativeFrame');
let releaseEnd = functionEnd(bridge, releaseStart, releaseMarker.length, 'R37 releaseNativeFrame');
let releaseBlock = bridge.slice(releaseStart, releaseEnd);
const initialBookkeepingCount = countOccurrences(bridge, releaseBookkeeping);
if (initialBookkeepingCount !== 1) {
  throw new Error(`R37 expected exactly one inherited R36 release-bookkeeping block, found ${initialBookkeepingCount}`);
}

let mode = releaseBlock.includes(releaseBookkeeping) ? 'already-correct' : 'relocated-r36-release-bookkeeping';
if (mode !== 'already-correct') {
  bridge = bridge.replace(releaseBookkeeping, '');
  releaseStart = uniqueStart(bridge, releaseMarker, 'R37 repaired releaseNativeFrame');
  releaseEnd = functionEnd(bridge, releaseStart, releaseMarker.length, 'R37 repaired releaseNativeFrame');
  releaseBlock = bridge.slice(releaseStart, releaseEnd);
  if (releaseBlock.includes('r36FocusHandoffReleasedFrames.add(') ||
      releaseBlock.includes('r34CompleteFocusHandoff(ownerPlayerId, frameId)')) {
    throw new Error('R37 releaseNativeFrame retained a partial/duplicate handoff bookkeeping block');
  }
  const releaseClose = releaseBlock.lastIndexOf('\n  }');
  if (releaseClose < 0) throw new Error('R37 releaseNativeFrame close boundary missing');
  releaseBlock = releaseBlock.slice(0, releaseClose) + '\n' + releaseBookkeeping + releaseBlock.slice(releaseClose);
  bridge = bridge.slice(0, releaseStart) + releaseBlock + bridge.slice(releaseEnd);
}

// Verify the three adjacent functions independently. This prevents a future
// transform from passing merely because the required text exists somewhere in a
// broad release->schedulePump slice.
releaseStart = uniqueStart(bridge, releaseMarker, 'R37 final releaseNativeFrame');
releaseEnd = functionEnd(bridge, releaseStart, releaseMarker.length, 'R37 final releaseNativeFrame');
releaseBlock = bridge.slice(releaseStart, releaseEnd);
if (!releaseBlock.includes(releaseBookkeeping)) {
  throw new Error('R37 releaseNativeFrame is missing canonical R36 release bookkeeping');
}
if (countOccurrences(bridge, releaseBookkeeping) !== 1 ||
    countOccurrences(bridge, '    r34CompleteFocusHandoff(ownerPlayerId, frameId);') !== 1) {
  throw new Error('R37 release bookkeeping is not single-owner/single-copy');
}

const wakeStart = uniqueStart(bridge, wakeMarker, 'R37 wakePumpFromNative');
const wakeEnd = functionEnd(bridge, wakeStart, wakeMarker.length, 'R37 wakePumpFromNative');
const wakeBlock = bridge.slice(wakeStart, wakeEnd);
for (const forbidden of ['ownerPlayerId', 'frameId', 'r36FocusHandoffReleasedFrames', 'r34CompleteFocusHandoff']) {
  if (wakeBlock.includes(forbidden)) throw new Error(`R37 TSFN wake callback retained release-scope symbol: ${forbidden}`);
}
if (!wakeBlock.includes('nativeWakePending') || !wakeBlock.includes('void pump()')) {
  throw new Error('R37 TSFN wake callback lost qualified R3B/R3D wake semantics');
}

const deadlineStart = uniqueStart(bridge, deadlineMarker, 'R37 advanceNativeFrameDeadline');
const deadlineEnd = functionEnd(bridge, deadlineStart, deadlineMarker.length, 'R37 advanceNativeFrameDeadline');
const deadlineBlock = bridge.slice(deadlineStart, deadlineEnd);
for (const forbidden of ['ownerPlayerId', 'frameId', 'r36FocusHandoffReleasedFrames', 'r34CompleteFocusHandoff']) {
  if (deadlineBlock.includes(forbidden)) throw new Error(`R37 frame deadline retained release-scope symbol: ${forbidden}`);
}
for (const required of ['expectedSourceFrameIntervalMs()', 'nextNativeFrameDeadlinePerfAt', 'pumpPhaseLateMaxMs']) {
  if (!deadlineBlock.includes(required)) throw new Error(`R37 frame deadline lost R3A phase semantics: ${required}`);
}

// Preserve the proven R24 serial-latest mailbox exactly. A temporary R37 mailbox
// escape was introduced while the stall looked like an in-flight send deadlock;
// run #46 proved the actual cause was the ReferenceError above. Do not widen the
// steady-state transfer concurrency for a problem that no longer exists.
if (!bridge.includes('  let deliveryMailboxActive = false;') ||
    !bridge.includes('  let deliveryQueuedLatest = null;') ||
    !bridge.includes('  function enqueueImportedFrame(delivery) {')) {
  throw new Error('R37 release-scope repair lost R24 serial-latest mailbox');
}
if (bridge.includes('LILAC_R37_HANDOFF_MAILBOX_ESCAPE') ||
    bridge.includes('r37HandoffEscapeActive') ||
    bridge.includes('r37HandoffEscapeTransfers')) {
  throw new Error('R37 speculative mailbox escape survived structural release repair');
}
if (!bridge.includes('function r30PopLatestProducedFrame(ownerPlayerId)')) {
  throw new Error('R37 release-scope repair removed R30 newest-only producer drain helper');
}
if (bridge.includes('focus-staged-gpu-copy') || bridge.includes('copyTextureToTexture')) {
  throw new Error('R37 release-scope repair resurrected forbidden staged renderer path');
}

const markerWakeStart = bridge.indexOf(wakeMarker);
bridge = bridge.slice(0, markerWakeStart) +
  '  // LILAC_R37_TS_FN_RELEASE_SCOPE_REPAIRED: release bookkeeping structurally belongs only to releaseNativeFrame.\n' +
  bridge.slice(markerWakeStart);
fs.writeFileSync(target, bridge, 'utf8');

const out = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const outReleaseStart = uniqueStart(out, releaseMarker, 'R37 packaged releaseNativeFrame');
const outReleaseEnd = functionEnd(out, outReleaseStart, releaseMarker.length, 'R37 packaged releaseNativeFrame');
const outRelease = out.slice(outReleaseStart, outReleaseEnd);
const outWakeStart = uniqueStart(out, wakeMarker, 'R37 packaged wakePumpFromNative');
const outWakeEnd = functionEnd(out, outWakeStart, wakeMarker.length, 'R37 packaged wakePumpFromNative');
const outWake = out.slice(outWakeStart, outWakeEnd);
const outDeadlineStart = uniqueStart(out, deadlineMarker, 'R37 packaged advanceNativeFrameDeadline');
const outDeadlineEnd = functionEnd(out, outDeadlineStart, deadlineMarker.length, 'R37 packaged advanceNativeFrameDeadline');
const outDeadline = out.slice(outDeadlineStart, outDeadlineEnd);

if (!outRelease.includes(releaseBookkeeping) || countOccurrences(out, releaseBookkeeping) !== 1) {
  throw new Error('R37 packaged-source release bookkeeping verification failed');
}
for (const [label, block] of [['wake', outWake], ['deadline', outDeadline]]) {
  for (const forbidden of ['ownerPlayerId', 'frameId', 'r36FocusHandoffReleasedFrames', 'r34CompleteFocusHandoff']) {
    if (block.includes(forbidden)) throw new Error(`R37 packaged-source ${label} scope verification failed: ${forbidden}`);
  }
}
if (!out.includes('LILAC_R37_TS_FN_RELEASE_SCOPE_REPAIRED')) {
  throw new Error('R37 TSFN release-scope repair marker missing');
}
if (out.includes('LILAC_R37_HANDOFF_MAILBOX_ESCAPE') || out.includes('r37HandoffEscapeActive')) {
  throw new Error('R37 packaged-source speculative mailbox escape survived');
}

console.log('R37_NODE_API_WAKE_SCOPE_OK mode=' + mode + ' callback=wakePumpFromNative ownerRefs=0 frameRefs=0 deadlineOwnerRefs=0 releaseBookkeeping=releaseNativeFrame-only dep0168RootCause=mis-scoped-R34-boundary-repaired mailbox=R24-serial-latest r30Drain=preserved directWebgpu=preserved');

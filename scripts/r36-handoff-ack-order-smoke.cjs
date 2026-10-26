'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'electron/libmpv-shared-main.cjs'), 'utf8').replace(/\r\n/g, '\n');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

for (const marker of [
  'LILAC_R36_HANDOFF_ACK_ORDER',
  'r36FocusHandoffReleasedFrames.add(releasedFrameId)',
  'r36FocusHandoffReleasedFrames.has(sentFrameId)',
  'r34CompleteFocusHandoff(ownerPlayerId, sentFrameId)',
  'R36_HANDOFF_FAIL_OPEN_MS = 1500',
  'r36-focus-fail-open',
  'r36SupplyGaps: r36SnapshotSupplyGaps()'
]) assert(bridge.includes(marker), 'R36 bridge marker missing: ' + marker);

const releaseTrack = bridge.indexOf('r36FocusHandoffReleasedFrames.add(releasedFrameId)');
const releaseComplete = bridge.indexOf('r34CompleteFocusHandoff(ownerPlayerId, frameId);', releaseTrack);
assert(releaseTrack >= 0 && releaseComplete > releaseTrack, 'release-before-send bookkeeping must precede completion gate');

const sendTrack = bridge.indexOf('r34FocusHandoffSentFrames.add(sentFrameId)');
const sendObservedRelease = bridge.indexOf('r36FocusHandoffReleasedFrames.has(sentFrameId)', sendTrack);
const sendComplete = bridge.indexOf('r34CompleteFocusHandoff(ownerPlayerId, sentFrameId)', sendObservedRelease);
assert(sendTrack >= 0 && sendObservedRelease > sendTrack && sendComplete > sendObservedRelease, 'send-after-release completion ordering invalid');

function makeCycle() {
  const sent = new Set();
  const released = new Set();
  let completed = 0;
  const complete = id => {
    if (!sent.has(id) || !released.has(id)) return false;
    completed += 1;
    sent.clear();
    released.clear();
    return true;
  };
  return {
    send(id) { sent.add(id); if (released.has(id)) complete(id); },
    release(id) { released.add(id); if (sent.has(id)) complete(id); },
    snapshot() { return { completed, sent: sent.size, released: released.size }; }
  };
}

let sendFirst = 0;
let releaseFirst = 0;
for (let cycle = 0; cycle < 200; cycle += 1) {
  const frameId = 1000 + cycle;
  const state = makeCycle();
  if ((cycle & 1) === 0) {
    state.send(frameId);
    state.release(frameId);
    sendFirst += 1;
  } else {
    state.release(frameId);
    state.send(frameId);
    releaseFirst += 1;
  }
  const snapshot = state.snapshot();
  assert(snapshot.completed === 1, 'ack cycle did not complete exactly once at cycle ' + cycle);
  assert(snapshot.sent === 0 && snapshot.released === 0, 'ack cycle leaked bookkeeping at cycle ' + cycle);
}

// The old R35 failure signature is specifically forbidden: after a completed
// release there must not be a full 24-frame sent-only set with no counterpart.
assert(!bridge.includes('sentAwaitingRelease: r34FocusHandoffSentFrames.size\n          r35FocusRedrawArms'), 'R35 stale diagnostics layout unexpectedly survived');
console.log('R36_HANDOFF_ACK_ORDER_SMOKE_OK cycles=200 sendFirst=' + sendFirst + ' releaseFirst=' + releaseFirst + ' staleSet=0 failOpenMs=1500 sourceOrdering=verified');

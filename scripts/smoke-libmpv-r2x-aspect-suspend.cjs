'use strict';

const assert = require('node:assert/strict');
const {
  VIDEO_ASPECT_RATIO,
  isVideoAspectLocked,
  isVideoAspectSuspended,
  setVideoAspectLocked,
  setVideoAspectSuspended,
  bindVideoAspectFullscreen
} = require('../electron/window-aspect.cjs');

const calls = [];
const listeners = new Map();
const win = {
  isDestroyed: () => false,
  setAspectRatio: value => calls.push(value),
  on: (name, fn) => listeners.set(name, fn)
};

assert.equal(bindVideoAspectFullscreen(win), true);
assert.equal(bindVideoAspectFullscreen(win), false, 'fullscreen listeners must bind once');
assert.equal(typeof listeners.get('enter-full-screen'), 'function');
assert.equal(typeof listeners.get('leave-full-screen'), 'function');

let state = setVideoAspectLocked(win, true);
assert.equal(state.locked, true);
assert.equal(state.suspended, false);
assert.equal(state.ratio, VIDEO_ASPECT_RATIO);
assert.equal(isVideoAspectLocked(win), true);
assert.equal(calls.at(-1), VIDEO_ASPECT_RATIO);

listeners.get('enter-full-screen')();
assert.equal(isVideoAspectLocked(win), true, 'fullscreen must preserve desired lock');
assert.equal(isVideoAspectSuspended(win), true);
assert.equal(calls.at(-1), 0, 'fullscreen must release native aspect constraint');

listeners.get('leave-full-screen')();
assert.equal(isVideoAspectLocked(win), true);
assert.equal(isVideoAspectSuspended(win), false);
assert.equal(calls.at(-1), VIDEO_ASPECT_RATIO, 'leaving fullscreen must restore 16:9');

state = setVideoAspectSuspended(win, true);
assert.equal(state.ratio, 0);
setVideoAspectLocked(win, false);
assert.equal(isVideoAspectLocked(win), false);
setVideoAspectSuspended(win, false);
assert.equal(calls.at(-1), 0, 'disabled desired lock must stay disabled after fullscreen');

console.log('LIBMPV_R2X_ASPECT_SUSPEND_OK desiredLock=preserved fullscreenRatio=0 leaveRatio=16:9 disabledRemains0=1');

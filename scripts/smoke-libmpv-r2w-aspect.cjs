'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MiniPlayerWindowController } = require('../electron/miniplayer-window.cjs');
const { VIDEO_ASPECT_RATIO, isVideoAspectLocked, setVideoAspectLocked } = require('../electron/window-aspect.cjs');

function mockWindow() {
  const calls = [];
  const win = {
    calls,
    destroyed: false,
    bounds: { x: 100, y: 100, width: 1280, height: 720 },
    min: [760, 500],
    resizable: true,
    always: false,
    isDestroyed() { return this.destroyed; },
    getNormalBounds() { return { ...this.bounds }; },
    getBounds() { return { ...this.bounds }; },
    isMaximized() { return false; },
    isFullScreen() { return false; },
    isAlwaysOnTop() { return this.always; },
    getMinimumSize() { return this.min.slice(); },
    isResizable() { return this.resizable; },
    setMinimumSize(w, h) { this.min = [w, h]; calls.push(['min', w, h]); },
    setResizable(value) { this.resizable = value; calls.push(['resizable', value]); },
    setAspectRatio(value) { calls.push(['aspect', value]); },
    setAlwaysOnTop(value) { this.always = value; calls.push(['top', value]); },
    setBounds(value) { this.bounds = { ...value }; calls.push(['bounds', value.width, value.height]); },
    show() {}, focus() {}, unmaximize() {}, maximize() {}, setFullScreen() {},
    once() {}, removeListener() {}
  };
  return win;
}

(async () => {
  const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) };
  const controller = new MiniPlayerWindowController({ screen });
  const win = mockWindow();
  assert.equal(isVideoAspectLocked(win), false);
  const entered = await controller.enter(win);
  assert.equal(entered.active, true);
  assert.equal(isVideoAspectLocked(win), true);
  assert.ok(win.calls.some(call => call[0] === 'aspect' && Math.abs(call[1] - VIDEO_ASPECT_RATIO) < 1e-9));
  assert.equal(Math.round(entered.bounds.width * 9 / 16), entered.bounds.height);
  await controller.leave(win);
  assert.equal(isVideoAspectLocked(win), false);
  assert.equal(win.calls.at(-4)[0] === 'aspect' || win.calls.some(call => call[0] === 'aspect' && call[1] === 0), true);

  const alreadyLocked = mockWindow();
  setVideoAspectLocked(alreadyLocked, true);
  await controller.enter(alreadyLocked);
  await controller.leave(alreadyLocked);
  assert.equal(isVideoAspectLocked(alreadyLocked), true);
  assert.ok(alreadyLocked.calls.filter(call => call[0] === 'aspect').at(-1)[1] > 1.7);

  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.ok(main.includes("setVideoAspectLocked(win,next.mode==='player'||next.mode==='hidden')"), 'normal window player/hidden aspect policy missing');
  assert.ok(main.includes("mode==='__lilac_miniplayer_on__'"), 'R2V mini-player fallback was lost');
  console.log('LIBMPV_R2W_ASPECT_SMOKE_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });

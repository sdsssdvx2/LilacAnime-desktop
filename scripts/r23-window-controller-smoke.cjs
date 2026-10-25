'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MiniPlayerWindowController } = require('../electron/miniplayer-window.cjs');

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.maximized = true;
    this.fullScreen = false;
    this.top = false;
    this.bounds = { x: 80, y: 90, width: 1280, height: 720 };
    this.minimumSize = [640, 360];
    this.resizable = true;
    this.log = [];
  }
  isDestroyed() { return this.destroyed; }
  getNormalBounds() { return { ...this.bounds }; }
  getBounds() { return { ...this.bounds }; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullScreen; }
  isAlwaysOnTop() { return this.top; }
  getMinimumSize() { return [...this.minimumSize]; }
  isResizable() { return this.resizable; }
  unmaximize() { this.log.push('unmaximize'); this.maximized = false; queueMicrotask(() => this.emit('unmaximize')); }
  maximize() { this.log.push('maximize'); this.maximized = true; }
  setFullScreen(value) {
    this.log.push(`fullscreen:${value}`); this.fullScreen = Boolean(value);
    queueMicrotask(() => this.emit(value ? 'enter-full-screen' : 'leave-full-screen'));
  }
  setMinimumSize(w, h) { this.log.push(`minimum:${w}x${h}`); this.minimumSize = [w, h]; }
  setResizable(value) { this.log.push(`resizable:${value}`); this.resizable = Boolean(value); }
  setBounds(bounds) { this.log.push('bounds'); this.bounds = { ...bounds }; }
  show() { this.log.push('show'); this.emit('show'); }
  focus() { this.log.push('focus'); }
  setAlwaysOnTop(value, level = '') { this.log.push(`top:${value}:${level}`); this.top = Boolean(value); }
  moveTop() { this.log.push('moveTop'); }
}

(async () => {
  const screen = {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
  };
  const controller = new MiniPlayerWindowController({ screen });
  const win = new FakeWindow();
  const original = { ...win.bounds };

  const entered = await controller.set(win, true);
  assert.equal(entered.active, true);
  assert.equal(win.top, true, 'mini-player must be always-on-top after enter');
  assert.equal(win.__lilacMiniPlayer, true);
  assert.equal(win.maximized, false, 'enter must finish unmaximize before applying mini bounds');
  const boundsAt = win.log.indexOf('bounds');
  const firstTopAt = win.log.findIndex(x => x.startsWith('top:true'));
  assert.ok(boundsAt >= 0 && firstTopAt > boundsAt, `topmost must be applied after bounds: ${win.log.join(',')}`);
  assert.ok(win.log.includes('moveTop'), 'mini-player must move to top after pin');

  win.top = false;
  win.emit('restore');
  assert.equal(win.top, true, 'restore event must re-pin topmost state');

  const left = await controller.set(win, false);
  assert.equal(left.active, false);
  assert.equal(win.__lilacMiniPlayer, false);
  assert.deepEqual(win.bounds, original, 'normal bounds must be restored');
  assert.equal(win.top, false, 'original always-on-top state must be restored');
  assert.equal(win.maximized, true, 'original maximized state must be restored');
  assert.equal(win.listenerCount('show'), 0, 'pin listener must be removed on leave');
  assert.equal(win.listenerCount('restore'), 0, 'restore pin listener must be removed on leave');

  console.log(`R23_WINDOW_CONTROLLER_SMOKE_OK order=${win.log.join('>')}`);
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const exists = relative => fs.existsSync(path.join(root, relative));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const bridge = read('electron/libmpv-shared-main.cjs');
const entry = read('src/libmpv-shared-entry.js');
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
const sharedPreload = read('electron/libmpv-shared-preload.cjs');
const controllerPath = path.join(root, 'electron/miniplayer-window.cjs');
const native = exists('native/libmpv-d3d11-bridge/player_addon.cc') ? read('native/libmpv-d3d11-bridge/player_addon.cc') : null;

for (const marker of [
  'LILAC_R39_REFOCUS_PHASE_REANCHOR',
  'r39ReanchorPumpPhase',
  "r39ReanchorPumpPhase(Boolean(focused) ? 'focus' : 'blur', Boolean(focused))",
  'nextNativeFrameDeadlinePerfAt = 0',
  'schedulePump(0)'
]) assert(bridge.includes(marker), `R39 bridge smoke missing ${marker}`);
assert(sharedPreload.includes("presentationMode = 'direct-receive-webgpu-copy'"), 'R39 lost focused direct WebGPU');
assert(!sharedPreload.includes('focus-staged-gpu-copy'), 'R39 resurrected staged WebGPU');
assert(bridge.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK'), 'R39 lost R37 explicit handoff');
assert(bridge.includes('LILAC_R37_NO_STALE_UI_HOLES'), 'R39 lost R37 no-region-churn path');

if (native) {
  for (const marker of ['LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC', 'HWND_TOPMOST', 'ownerTopmost', 'windowTopmost']) {
    assert(native.includes(marker), `R39 native smoke missing ${marker}`);
  }
  assert(native.includes('LILAC_R33_OWNED_POPUP_FOCUS_SURFACE'), 'R39 lost R33 owned popup');
  assert(native.includes('LILAC_R33_NATIVE_ONLY_UNFOCUSED'), 'R39 lost R33 native-only path');
  assert(!native.includes('--disable-direct-composition'), 'R39 resurrected Direct Composition disable');
}

for (const marker of ['LILAC_R39_NATIVE_SUBTITLE_PARITY', 'browserBottomInset', "'sub-ass-override', 'strip'"]) {
  assert(entry.includes(marker), `R39 subtitle smoke missing ${marker}`);
}
assert(!entry.includes("'sub-ass-override', 'force'"), 'R39 subtitle force override returned');
assert(!entry.includes("'sub-ass-override', 'scale'"), 'R39 subtitle scale override returned');
assert(/subtitleSize'\) \|\| 100/.test(entry), 'R39 native subtitle size default is not 100');
assert(/subtitlePosition'\) \|\| 12/.test(entry), 'R39 native subtitle position default is not 12');
assert(/vttWeight'\) \|\| 700/.test(entry), 'R39 native subtitle weight default is not 700');

assert(main.includes('LILAC_R38_UPDATE_ACTIVITY_CHECK'), 'R39 lost R38 updater lifecycle');
assert(main.includes("player:miniplayer-state"), 'R39 mini-player state IPC missing');
assert(preload.includes('miniPlayerState:'), 'R39 mini-player state preload missing');
assert(bridge.includes('r39MiniPlayer:'), 'R39 mini-player diagnostics missing from copied diagnostics');

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.bounds = { x: 100, y: 120, width: 1280, height: 720 };
    this.maximized = false;
    this.fullScreen = false;
    this.topmost = false;
    this.minimum = [0, 0];
    this.resizable = true;
    this.topmostCalls = [];
    this.moveTopCalls = 0;
  }
  isDestroyed() { return this.destroyed; }
  getNormalBounds() { return { ...this.bounds }; }
  getBounds() { return { ...this.bounds }; }
  setBounds(value) { this.bounds = { ...value }; }
  isMaximized() { return this.maximized; }
  maximize() { this.maximized = true; this.emit('maximize'); }
  unmaximize() { this.maximized = false; this.emit('unmaximize'); }
  isFullScreen() { return this.fullScreen; }
  setFullScreen(value) { this.fullScreen = Boolean(value); this.emit(value ? 'enter-full-screen' : 'leave-full-screen'); }
  isAlwaysOnTop() { return this.topmost; }
  setAlwaysOnTop(value, level) { this.topmost = Boolean(value); this.topmostCalls.push([Boolean(value), level || '']); this.emit('always-on-top-changed', {}, this.topmost); }
  getMinimumSize() { return [...this.minimum]; }
  setMinimumSize(w, h) { this.minimum = [w, h]; }
  isResizable() { return this.resizable; }
  setResizable(value) { this.resizable = Boolean(value); }
  show() { this.emit('show'); }
  focus() { this.emit('focus'); }
  moveTop() { this.moveTopCalls += 1; }
}

const fakeScreen = {
  getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
};

const { MiniPlayerWindowController } = require(controllerPath);
(async () => {
  const win = new FakeWindow();
  const controller = new MiniPlayerWindowController({ screen: fakeScreen });
  const entered = await controller.set(win, true);
  assert(entered.active === true, 'mini-player did not enter');
  assert(win.isAlwaysOnTop() === true, 'mini-player not topmost after enter');
  assert(win.topmostCalls.some(([, level]) => level === 'screen-saver'), 'screen-saver topmost level was never requested');
  assert(win.moveTopCalls > 0, 'moveTop was never used');
  assert(entered.marker === 'LILAC_R39_MINIPLAYER_TOPMOST', 'mini-player diagnostics marker missing');
  assert(entered.pinCount >= 2, 'mini-player pin did not run around show/focus');

  const beforeBlur = entered.pinCount;
  win.emit('blur');
  const afterBlur = controller.snapshot(win);
  assert(afterBlur.pinCount > beforeBlur, 'blur did not reassert topmost');
  assert(afterBlur.alwaysOnTop === true, 'blur lost topmost');

  const left = await controller.set(win, false);
  assert(left.active === false, 'mini-player did not leave');
  assert(win.isAlwaysOnTop() === false, 'mini-player did not restore original topmost state');
  assert(win.bounds.x === 100 && win.bounds.y === 120 && win.bounds.width === 1280 && win.bounds.height === 720, 'mini-player did not restore original bounds');

  console.log(`R39_REFOCUS_PIP_SUBTITLE_SMOKE_OK refocus=phase-reset+focused-wake pip=screen-saver+self-heal+native-owner-topmost subtitle=dom-baseline+22over720-inset nativeSource=${native ? 1 : 0} r33=preserved r37=preserved r38Updater=preserved`);
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});

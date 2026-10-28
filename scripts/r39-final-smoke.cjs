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
const player = read('src/player.js');
const controllerPath = path.join(root, 'electron/miniplayer-window.cjs');
const native = exists('native/libmpv-d3d11-bridge/player_addon.cc') ? read('native/libmpv-d3d11-bridge/player_addon.cc') : null;

// Refocus repair + protected playback invariants.
for (const marker of [
  'LILAC_R39_REFOCUS_PHASE_REANCHOR',
  'r39ReanchorPumpPhase',
  "r39ReanchorPumpPhase(Boolean(focused) ? 'focus' : 'blur', Boolean(focused))",
  'nextNativeFrameDeadlinePerfAt = 0',
  'r27LastDispatchWallMs = 0',
  'schedulePump(0)',
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R37_NO_STALE_UI_HOLES'
]) assert(bridge.includes(marker), `R39 final bridge smoke missing ${marker}`);
assert(sharedPreload.includes("presentationMode = 'direct-receive-webgpu-copy'"), 'R39 final lost focused direct WebGPU');
assert(sharedPreload.includes('copyExternalImageToTexture'), 'R39 final lost direct WebGPU copy primitive');
assert(!sharedPreload.includes('focus-staged-gpu-copy'), 'R39 final resurrected failed staged WebGPU presenter');
assert(!sharedPreload.includes('requestAnimationFrame('), 'R39 final introduced rAF presenter');

// Mini-player must remain reachable through both the dedicated preload bridge and
// the R2V stable window-buttons fallback that was added after a real installed
// runtime exposed window.lilac without setMiniPlayer.
for (const marker of ['libmpvMiniInvoker', 'LilacMiniPlayerDiagnostics', '__lilac_miniplayer_on__']) {
  assert(player.includes(marker), `R39 final player PiP bridge missing ${marker}`);
}
assert(main.includes("mode==='__lilac_miniplayer_on__'"), 'R39 final lost R2V mini-player fallback IPC');
assert(main.includes("player:miniplayer-state"), 'R39 final mini-player state IPC missing');
assert(main.includes('LILAC_R39_MINIPLAYER_TOPMOST'), 'R39 final mini-player main marker missing');
assert(preload.includes('setMiniPlayer:'), 'R39 final direct mini-player preload bridge missing');
assert(preload.includes('miniPlayerState:'), 'R39 final mini-player diagnostics preload bridge missing');
assert(bridge.includes('r39MiniPlayer:'), 'R39 final mini-player diagnostics missing from copied diagnostics');

// Native owned-popup source is available during source qualification but not inside
// extracted ASAR. Verify the C++ z-order policy whenever source is present.
if (native) {
  for (const marker of [
    'LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC',
    'LILAC_R39_TOPMOST_BIDIRECTIONAL',
    'r39OwnerTopmost ? HWND_TOPMOST : HWND_NOTOPMOST',
    'ownerTopmost',
    'windowTopmost',
    'LILAC_R33_OWNED_POPUP_FOCUS_SURFACE',
    'LILAC_R33_NATIVE_ONLY_UNFOCUSED'
  ]) assert(native.includes(marker), `R39 final native smoke missing ${marker}`);
  assert(!native.includes('--disable-direct-composition'), 'R39 final resurrected failed Direct Composition disable');
  assert(!native.includes('focus-staged-gpu-copy'), 'R39 final native source contains failed staged presenter marker');
}

// Final subtitle authority is R2V's screenshot-calibrated 105/10/130/400/3 path.
const subtitleStart = entry.indexOf('  async _syncR32NativeSubtitleFallbackStyle() {');
const subtitleEnd = entry.indexOf('\n  async _loadTrack(', subtitleStart);
assert(subtitleStart >= 0 && subtitleEnd > subtitleStart, 'R39 final native subtitle helper boundary missing');
const subtitleBlock = entry.slice(subtitleStart, subtitleEnd);
for (const marker of [
  'LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY',
  "subtitleSize') || 105",
  "subtitlePosition') || 10",
  "vttOutline') ?? 3",
  "vttWeight') || 400",
  'r39NativeVisualBottom = clamp(position - 1.25, 0, 48)',
  "r39NativeFont ? ['set_property', 'sub-font', r39NativeFont] : null",
  "lilac: 'Malgun Gothic'",
  "pretendard: 'Pretendard'",
  "noto: 'Noto Sans KR'",
  "'sub-ass-override', 'strip'"
]) assert(entry.includes(marker), `R39 final subtitle marker missing ${marker}`);
assert(!subtitleBlock.includes('browserBottomInset'), 'R39 final retained superseded +22/720 native subtitle inset');
assert(!subtitleBlock.includes("subtitleSize') || 100"), 'R39 final retained superseded native subtitle size 100');
assert(!subtitleBlock.includes("subtitlePosition') || 12"), 'R39 final retained superseded native subtitle position 12');
assert(!subtitleBlock.includes("vttOutline') ?? 2"), 'R39 final retained superseded native subtitle outline 2');
assert(!subtitleBlock.includes("vttWeight') || 700"), 'R39 final retained superseded native subtitle weight 700');
assert(!entry.includes('LILAC_R39_NATIVE_SUBTITLE_PARITY'), 'R39 final retained superseded subtitle marker');
assert(!entry.includes("'sub-ass-override', 'force'") && !entry.includes("'sub-ass-override', 'scale'"), 'R39 final resurrected rejected subtitle override policy');
assert(entry.includes('browserVisualBottom=clamp(position-1.25,0,48)') || entry.includes('browserVisualBottom = clamp(position - 1.25, 0, 48)'), 'R39 final focused DOM R2V visual-bottom calibration missing');

assert(main.includes('LILAC_R38_UPDATE_ACTIVITY_CHECK'), 'R39 final lost R38 updater lifecycle');

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
  setAlwaysOnTop(value, level) {
    this.topmost = Boolean(value);
    this.topmostCalls.push([Boolean(value), level || '']);
    this.emit('always-on-top-changed', {}, this.topmost);
  }
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
  assert(entered.active === true, 'R39 final mini-player did not enter');
  assert(win.isAlwaysOnTop() === true, 'R39 final mini-player not topmost after enter');
  assert(win.topmostCalls.some(([, level]) => level === 'screen-saver'), 'R39 final never requested screen-saver topmost level');
  assert(win.moveTopCalls > 0, 'R39 final mini-player never called moveTop');
  assert(entered.marker === 'LILAC_R39_MINIPLAYER_TOPMOST', 'R39 final mini-player diagnostics marker missing');
  assert(entered.pinCount >= 2, 'R39 final mini-player did not re-pin around show/focus');

  const beforeBlur = entered.pinCount;
  win.emit('blur');
  const afterBlur = controller.snapshot(win);
  assert(afterBlur.pinCount > beforeBlur, 'R39 final blur did not reassert topmost');
  assert(afterBlur.alwaysOnTop === true, 'R39 final blur lost topmost');

  // Simulate an external z-order loss and prove the controller self-heals.
  win.topmost = false;
  win.emit('always-on-top-changed', {}, false);
  await new Promise(resolve => setTimeout(resolve, 5));
  const afterLoss = controller.snapshot(win);
  assert(afterLoss.alwaysOnTop === true, 'R39 final did not heal lost topmost state');
  assert(afterLoss.pinCount > afterBlur.pinCount, 'R39 final topmost-loss event did not trigger another pin');

  const left = await controller.set(win, false);
  assert(left.active === false, 'R39 final mini-player did not leave');
  assert(win.isAlwaysOnTop() === false, 'R39 final mini-player did not restore original topmost state');
  assert(win.bounds.x === 100 && win.bounds.y === 120 && win.bounds.width === 1280 && win.bounds.height === 720, 'R39 final mini-player did not restore original bounds');

  console.log(`R39_FINAL_SMOKE_OK refocus=phase-reanchor+focused-wake pip=direct+fallback+screen-saver+self-heal+native-bidirectional subtitle=R2V-105/10/130/400/3+position-minus1.25+known-fonts nativeSource=${native ? 1 : 0} r33=preserved r37=preserved r38Updater=preserved focused=direct-webgpu`);
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});

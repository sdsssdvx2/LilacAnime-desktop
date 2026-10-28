'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const readOptional = rel => {
  const target = path.join(root, rel);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
};

function section(label, source, startNeedle, endNeedle, maxChars = 14000, required = true) {
  const start = source.indexOf(startNeedle);
  if (start < 0) {
    console.log(`\n===== R39_PROBE_${label}_MISSING marker=${JSON.stringify(startNeedle)} =====\n`);
    if (required) throw new Error(`${label}: start marker missing: ${startNeedle}`);
    return '';
  }
  const end = endNeedle ? source.indexOf(endNeedle, start + startNeedle.length) : -1;
  const sliceEnd = end > start ? end : Math.min(source.length, start + maxChars);
  const body = source.slice(start, Math.min(sliceEnd, start + maxChars));
  console.log(`\n===== R39_PROBE_${label}_BEGIN =====`);
  console.log(body);
  console.log(`===== R39_PROBE_${label}_END =====\n`);
  return body;
}

function around(label, source, needle, radius = 2200) {
  const index = source.indexOf(needle);
  if (index < 0) {
    console.log(`===== R39_PROBE_${label}_ABSENT needle=${JSON.stringify(needle)} =====`);
    return '';
  }
  const body = source.slice(Math.max(0, index - radius), Math.min(source.length, index + needle.length + radius));
  console.log(`\n===== R39_PROBE_${label}_BEGIN =====`);
  console.log(body);
  console.log(`===== R39_PROBE_${label}_END =====\n`);
  return body;
}

const bridge = read('electron/libmpv-shared-main.cjs');
const sharedPreload = read('electron/libmpv-shared-preload.cjs');
const entry = read('src/libmpv-shared-entry.js');
const player = read('src/player.js');
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
const updater = read('electron/updater.cjs');
const mini = readOptional('electron/miniplayer-window.cjs');

for (const marker of [
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R38_UPDATE_ACTIVITY_CHECK',
  "presentationMode = 'direct-receive-webgpu-copy'",
  'LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC'
]) {
  const haystack = marker.startsWith('LILAC_R38') ? main : (marker.includes('presentationMode') ? sharedPreload : bridge + entry);
  if (!haystack.includes(marker)) throw new Error(`R39 probe baseline marker missing: ${marker}`);
}

const focusBlock = section('FOCUS', bridge, '  function r32ApplyNativePresenterFocus(focused) {', '\n\n  function ensurePlayer() {');
const deadlineBlock = section('DEADLINE', bridge, '  function nextActivePumpDelay(', '\n\n  function wakePumpFromNative() {', 24000);
section('RELEASE', bridge, '  function releaseNativeFrame(ownerPlayerId, slotId, frameId) {', '  function wakePumpFromNative() {', 16000);
const subtitleStyle = section('SUBTITLE_STYLE', entry, '  async _syncR32NativeSubtitleFallbackStyle() {', '  async _loadTrack(element) {', 12000);
const subtitleLoad = section('SUBTITLE_LOAD', entry, '  async _loadTrack(element) {', '\n  removeChild(', 22000);
section('SUBTITLE_OVERLAY', entry, '  refreshSubtitleOverlay()', '\n  _render', 18000);
section('UPDATER_FOCUS', main, '// LILAC_R38_UPDATE_ACTIVITY_CHECK', "app.on('second-instance'", 14000);

for (const [body, marker, label] of [
  [focusBlock, 'r34BeginFocusHandoff', 'focus handoff'],
  [focusBlock, 'r33NativePresenterActive', 'native focus state'],
  [deadlineBlock, 'nextNativeFrameDeadlinePerfAt', 'absolute deadline'],
  [deadlineBlock, 'advanceNativeFrameDeadline', 'deadline advance'],
  [subtitleStyle, "'sub-pos'", 'native subtitle position'],
  [subtitleStyle, "'sub-font-size'", 'native subtitle size'],
  [subtitleLoad, 'sub-add', 'native subtitle add']
]) {
  if (!body.includes(marker)) throw new Error(`R39 probe ${label} marker missing: ${marker}`);
}

// PiP is intentionally diagnostic-only here. R38 user hardware says it is broken,
// so absence at any layer is evidence rather than a probe failure.
const pipNeedles = [
  ['PLAYER_TOGGLE_PIP', player, 'togglePictureInPicture'],
  ['PLAYER_MINIPLAYER_ID', player, "$('#miniPlayer')"],
  ['PLAYER_SHIFT_P', player, 'Shift+P'],
  ['PLAYER_CAPTURE_STREAM', player, 'captureStream'],
  ['PLAYER_SET_MINI', player, 'setMiniPlayer'],
  ['PRELOAD_SET_MINI', preload, 'setMiniPlayer'],
  ['MAIN_MINI_IPC', main, 'player:miniplayer'],
  ['MAIN_MINI_CONTROLLER', main, 'MiniPlayerWindowController'],
  ['MINI_ALWAYS_ON_TOP', mini, 'setAlwaysOnTop'],
  ['MINI_MOVE_TOP', mini, 'moveTop']
];
for (const [label, source, needle] of pipNeedles) around(label, source, needle, 1600);

const pip = {
  playerToggle: player.includes('togglePictureInPicture'),
  playerButton: player.includes("$('#miniPlayer')") || player.includes('miniPlayer'),
  playerShiftP: player.includes('Shift+P'),
  playerCaptureStream: player.includes('captureStream'),
  playerSetMini: player.includes('setMiniPlayer'),
  preloadSetMini: preload.includes('setMiniPlayer'),
  mainIpc: main.includes('player:miniplayer'),
  mainController: main.includes('MiniPlayerWindowController'),
  controllerFile: Boolean(mini),
  controllerAlwaysOnTop: mini.includes('setAlwaysOnTop'),
  controllerMoveTop: mini.includes('moveTop')
};
console.log('R39_PIP_LAYER_SUMMARY ' + JSON.stringify(pip));

const subtitle = {
  domSizeDefault100: entry.includes("localStorage.getItem('subtitleSize') || 100"),
  domPositionDefault12: entry.includes("localStorage.getItem('subtitlePosition') || 12"),
  domOutlineDefault2: entry.includes("localStorage.getItem('vttOutline') ?? 2"),
  nativeSizeDefault105: entry.includes("localStorage.getItem('subtitleSize') || 105"),
  nativePositionDefault10: entry.includes("localStorage.getItem('subtitlePosition') || 10"),
  nativeOutlineDefault3: entry.includes("localStorage.getItem('vttOutline') ?? 3"),
  nativeWeightDefault400: entry.includes("localStorage.getItem('vttWeight') || 400")
};
console.log('R39_SUBTITLE_PARITY_SUMMARY ' + JSON.stringify(subtitle));

const performance = {
  absoluteDeadline: bridge.includes('nextNativeFrameDeadlinePerfAt'),
  focusResetsDeadline: focusBlock.includes('nextNativeFrameDeadlinePerfAt = 0'),
  focusForcesPump: focusBlock.includes('schedulePump(0)') || focusBlock.includes('void pump()'),
  gapHasPaused: bridge.includes('paused: lastState?.paused === true'),
  gapHasSeeking: bridge.includes('seeking: lastState?.seeking === true'),
  gapHasBuffering: bridge.includes('pausedForCache: lastState?.pausedForCache === true')
};
console.log('R39_PERFORMANCE_LAYER_SUMMARY ' + JSON.stringify(performance));

console.log('R39_RUNTIME_SOURCE_PROBE_OK focus=final-r38 deadline=absolute subtitle=dom+native-fallback pip=reported-not-assumed updaterFocus=present');

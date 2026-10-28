'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

function section(label, source, startNeedle, endNeedle, maxChars = 14000) {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`${label}: start marker missing: ${startNeedle}`);
  const end = endNeedle ? source.indexOf(endNeedle, start + startNeedle.length) : -1;
  const sliceEnd = end > start ? end : Math.min(source.length, start + maxChars);
  const body = source.slice(start, Math.min(sliceEnd, start + maxChars));
  console.log(`\n===== R39_PROBE_${label}_BEGIN =====`);
  console.log(body);
  console.log(`===== R39_PROBE_${label}_END =====\n`);
  return body;
}

const bridge = read('electron/libmpv-shared-main.cjs');
const entry = read('src/libmpv-shared-entry.js');
const player = read('src/player.js');
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
const updater = read('electron/updater.cjs');
const miniPath = path.join(root, 'electron', 'miniplayer-window.cjs');
if (!fs.existsSync(miniPath)) throw new Error('R39 probe: generated miniplayer-window.cjs missing');
const mini = read('electron/miniplayer-window.cjs');

for (const marker of [
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R38_UPDATE_ACTIVITY_CHECK',
  "presentationMode = 'direct-receive-webgpu-copy'",
  'LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC'
]) {
  const haystack = marker.startsWith('LILAC_R38') ? main : (marker.includes('presentationMode') ? read('electron/libmpv-shared-preload.cjs') : bridge + entry);
  if (!haystack.includes(marker)) throw new Error(`R39 probe baseline marker missing: ${marker}`);
}

const focusBlock = section('FOCUS', bridge, '  function r32ApplyNativePresenterFocus(focused) {', '\n\n  function ensurePlayer() {');
const deadlineBlock = section('DEADLINE', bridge, '  function nextActivePumpDelay(', '\n\n  function wakePumpFromNative() {', 24000);
const releaseBlock = section('RELEASE', bridge, '  function releaseNativeFrame(ownerPlayerId, slotId, frameId) {', '  function wakePumpFromNative() {', 16000);
const subtitleStyle = section('SUBTITLE_STYLE', entry, '  async _syncR32NativeSubtitleFallbackStyle() {', '  async _loadTrack(element) {', 12000);
const subtitleLoad = section('SUBTITLE_LOAD', entry, '  async _loadTrack(element) {', '\n  removeChild(', 22000);
const subtitleOverlay = section('SUBTITLE_OVERLAY', entry, '  refreshSubtitleOverlay()', '\n  _render', 18000);
const pipBlock = section('PIP_PLAYER', player, 'let libmpvMiniPlayerActive = false;', '// --- Media controls (Android MediaSession)', 22000);
const miniController = section('MINIPLAYER_CONTROLLER', mini, "'use strict';", null, 24000);
const mainMini = section('MINIPLAYER_MAIN', main, "ipcMain.handle('player:miniplayer'", null, 5000);
const preloadMini = section('MINIPLAYER_PRELOAD', preload, 'setMiniPlayer:', null, 3000);
const updaterFocus = section('UPDATER_FOCUS', main, "// LILAC_R38_UPDATE_ACTIVITY_CHECK", "app.on('second-instance'", 14000);

const must = [
  [focusBlock, 'r34BeginFocusHandoff', 'focus handoff'],
  [focusBlock, 'r33NativePresenterActive', 'native focus state'],
  [deadlineBlock, 'nextNativeFrameDeadlinePerfAt', 'absolute deadline'],
  [deadlineBlock, 'advanceNativeFrameDeadline', 'deadline advance'],
  [subtitleStyle, "'sub-pos'", 'native subtitle position'],
  [subtitleStyle, "'sub-font-size'", 'native subtitle size'],
  [subtitleLoad, 'sub-add', 'native subtitle add'],
  [pipBlock, 'window.lilac.setMiniPlayer', 'PiP renderer bridge'],
  [miniController, "setAlwaysOnTop?.(true, 'floating')", 'PiP always-on-top'],
  [miniController, 'win.moveTop?.()', 'PiP moveTop'],
  [mainMini, 'player:miniplayer', 'PiP main IPC'],
  [preloadMini, 'setMiniPlayer:', 'PiP preload IPC'],
  [updaterFocus, "browser-window-focus", 'R38 focus updater hook']
];
for (const [body, marker, label] of must) if (!body.includes(marker)) throw new Error(`R39 probe ${label} marker missing: ${marker}`);

console.log('R39_RUNTIME_SOURCE_PROBE_OK focus=final-r38 deadline=absolute subtitle=dom+native-fallback pip=renderer+preload+main+controller updaterFocus=present');

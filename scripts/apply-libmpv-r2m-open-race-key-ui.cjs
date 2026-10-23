'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function rewriteSection(source, startMarker, endMarker, transform, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) throw new Error(`${label}: section anchors missing`);
  const before = source.slice(start, end);
  const after = transform(before);
  if (after === before) throw new Error(`${label}: section was not changed`);
  return source.slice(0, start) + after + source.slice(end);
}

// R2M closes the real-world reopen race that R2L's generation-only guard missed:
// mpv can briefly surface the previous file's END_FILE/time/duration after loadfile(replace)
// but before the new file emits FILE_LOADED. Ignore all media state until FILE_LOADED for
// the current generation has actually been observed, and clear stale timing immediately.
let entry = read('src/libmpv-shared-entry.js');
if (!entry.includes('this._generation = 0;')) throw new Error('R2M requires R2L generation guard');
if (!entry.includes('this._ended && !previousEnded')) throw new Error('R2M requires R2L ended edge trigger');

entry = replaceOnce(
  entry,
  '    this._generation = 0;\n    this._lastState = null;',
  '    this._generation = 0;\n    this._loadConfirmed = false;\n    this._lastState = null;',
  'load-confirmed constructor state'
);
entry = replaceOnce(
  entry,
  '    this._generation = 0;\n    this._openPromise = null;',
  '    this._generation = 0;\n    this._loadConfirmed = false;\n    this._openPromise = null;',
  'load-confirmed reset state'
);
entry = replaceOnce(
  entry,
  '    this._readyState = 0;\n    this._metadataSent = false;\n    this._ended = false;\n    this.dispatchEvent(new Event(\'waiting\'));',
  '    this._time = 0;\n    this._duration = 0;\n    this._readyState = 0;\n    this._metadataSent = false;\n    this._ended = false;\n    this._loadConfirmed = false;\n    this._lastState = null;\n    this.dispatchEvent(new Event(\'waiting\'));',
  'clear stale media state on open'
);
entry = replaceOnce(
  entry,
  '      this._generation = Number(result?.generation) || 0;\n      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);',
  '      this._generation = Number(result?.generation) || 0;\n      this._loadConfirmed = false;\n      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);',
  'reset confirmation after open result'
);
entry = replaceOnce(
  entry,
  '      if (this._generation && Number(state.generation) !== this._generation) return;\n      const previousTime = this._time;',
  '      if (this._generation && Number(state.generation) !== this._generation) return;\n      if (state.fileLoaded !== true) { this._lastState = state; return; }\n      this._loadConfirmed = true;\n      const previousTime = this._time;',
  'ignore pre-FILE_LOADED state'
);
entry = replaceOnce(
  entry,
  '      this._ended = Boolean(state.eof) || (this._duration > 0 && this._time >= this._duration - 0.15 && this._paused);',
  '      this._ended = this._loadConfirmed && (Boolean(state.eof) || (this._duration > 0 && this._time >= this._duration - 0.15 && this._paused));',
  'end requires confirmed load'
);

for (const marker of [
  'this._loadConfirmed = false',
  'state.fileLoaded !== true',
  'this._loadConfirmed = true',
  'this._ended = this._loadConfirmed &&',
  'this._time = 0;\n    this._duration = 0;'
]) {
  if (!entry.includes(marker)) throw new Error(`R2M entry marker missing: ${marker}`);
}
write('src/libmpv-shared-entry.js', entry);

// R2L temporarily broadened keyboard input into a controls reveal. R2M's final policy is
// deliberately stricter: keyboard shortcuts may perform their action/toast, but must never
// make the full controls/gradients visible or extend their mouse-triggered visibility timer.
// Only real mouse movement reveals the controls; an open settings panel remains the pin-open state.
let player = read('src/player.js');
const broadCapture = `window.addEventListener('keydown', event => {\n  usingKeyboard = true;\n  const typingTarget = event.target instanceof Element && event.target.matches('input,textarea,select,[contenteditable=\\"true\\"]');\n  if (!typingTarget && !event.ctrlKey && !event.altKey && !event.metaKey && document.body.classList.contains('player-mode')) showPlayerControls();\n}, true);`;
player = replaceOnce(
  player,
  broadCapture,
  "window.addEventListener('keydown', () => { usingKeyboard = true; }, true);",
  'remove broad keyboard reveal'
);

let spaceRevealCount = 0;
player = rewriteSection(
  player,
  'function finishSpaceHold(toggle = false) {',
  "\nwindow.addEventListener('keyup'",
  section => {
    spaceRevealCount = (section.match(/showPlayerControls\(\);/g) || []).length;
    if (spaceRevealCount < 1) throw new Error('Space release reveal anchor missing');
    return section.replaceAll('showPlayerControls();', '');
  },
  'Space release keyboard reveal'
);

let keyRevealCount = 0;
player = rewriteSection(
  player,
  'function handlePlayerKey(event) {',
  '\n// 스크린샷',
  section => {
    keyRevealCount = (section.match(/showPlayerControls\(\);/g) || []).length;
    if (keyRevealCount < 1) throw new Error('keyboard reveal anchors missing');
    return section.replaceAll('showPlayerControls();', '');
  },
  'player keyboard reveals'
);

const finishBlock = player.slice(player.indexOf('function finishSpaceHold(toggle = false) {'), player.indexOf("\nwindow.addEventListener('keyup'", player.indexOf('function finishSpaceHold(toggle = false) {')));
const keyBlock = player.slice(player.indexOf('function handlePlayerKey(event) {'), player.indexOf('\n// 스크린샷', player.indexOf('function handlePlayerKey(event) {')));
const mouseBlock = player.slice(player.indexOf("$('#immersivePlayer').addEventListener('mousemove', event => {"), player.indexOf('\n// --- Picture-in-picture', player.indexOf("$('#immersivePlayer').addEventListener('mousemove', event => {")));
const settingsBlock = player.slice(player.indexOf('function openPlayerSettings(open, focusSection = null) {'), player.indexOf('\n// Mirrors the settings page', player.indexOf('function openPlayerSettings(open, focusSection = null) {')));
if (player.includes('typingTarget')) throw new Error('R2L broad keyboard reveal survived');
if (finishBlock.includes('showPlayerControls')) throw new Error('Space release still reveals full controls');
if (keyBlock.includes('showPlayerControls')) throw new Error('keyboard handler still reveals full controls');
if (!mouseBlock.includes('if (!playerLocked) showPlayerControls();')) throw new Error('real mouse movement reveal missing');
if (!settingsBlock.includes('showPlayerControls();')) throw new Error('settings panel pin-open reveal missing');
write('src/player.js', player);

// Up/down volume shortcuts dispatch the slider's input event. Upstream's input handler also
// revealed controls, so removing only direct key-handler calls was not sufficient. Keep the
// same volume/mute persistence and UI sync, but do not let slider input reveal the full UI.
let app = read('src/app.js');
app = replaceOnce(
  app,
  "$('#playerVolume').oninput=e=>{const video=$('#video');video.volume=Number(e.target.value)/100;video.muted=video.volume===0;localStorage.setItem('playerVolume',String(video.volume));localStorage.setItem('playerMuted',String(video.muted));syncVolumeUI();showPlayerControls()};",
  "$('#playerVolume').oninput=e=>{const video=$('#video');video.volume=Number(e.target.value)/100;video.muted=video.volume===0;localStorage.setItem('playerVolume',String(video.volume));localStorage.setItem('playerMuted',String(video.muted));syncVolumeUI()};",
  'volume input keyboard reveal'
);
const volumeStart = app.indexOf("$('#playerVolume').oninput=");
const volumeEnd = app.indexOf("\n$('#video').addEventListener('volumechange'", volumeStart);
if (volumeStart < 0 || volumeEnd <= volumeStart) throw new Error('volume input section missing');
if (app.slice(volumeStart, volumeEnd).includes('showPlayerControls')) throw new Error('volume input still reveals full controls');
write('src/app.js', app);

console.log(`LIBMPV_R2M_OPEN_RACE_KEY_UI_OK fileLoadedGate=1 staleTimingReset=1 endedEdge=1 keyReveal=none removedKey=${keyRevealCount} removedSpace=${spaceRevealCount} volumeInputQuiet=1 mouseReveal=1 settingsPin=1`);

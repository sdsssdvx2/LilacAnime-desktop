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

// R2L revealed controls for every unmodified key. Restore upstream's selective behavior:
// left/right, digits, F/M and other original UI-bearing shortcuts keep revealing controls,
// while Space, [ ], volume up/down, Z/X, P/S, PageUp/Down stay quiet. C is the one extra
// shortcut the user asked to reveal because its subtitle state is visual.
let player = read('src/player.js');
const broadCapture = `window.addEventListener('keydown', event => {\n  usingKeyboard = true;\n  const typingTarget = event.target instanceof Element && event.target.matches('input,textarea,select,[contenteditable=\\"true\\"]');\n  if (!typingTarget && !event.ctrlKey && !event.altKey && !event.metaKey && document.body.classList.contains('player-mode')) showPlayerControls();\n}, true);`;
player = replaceOnce(
  player,
  broadCapture,
  "window.addEventListener('keydown', () => { usingKeyboard = true; }, true);",
  'remove broad keyboard reveal'
);
player = replaceOnce(
  player,
  "  if (letter === 'c') { const box = $('#subtitleEnabled'); box.checked = !box.checked; box.dispatchEvent(new Event('change')); toast(box.checked ? '자막을 켰어요' : '자막을 껐어요'); return; }",
  "  if (letter === 'c') { const box = $('#subtitleEnabled'); box.checked = !box.checked; box.dispatchEvent(new Event('change')); toast(box.checked ? '자막을 켰어요' : '자막을 껐어요'); showPlayerControls(); return; }",
  'C shortcut reveal'
);

if (player.includes('typingTarget')) throw new Error('R2L broad keyboard reveal survived');
if (!player.includes("letter === 'c') { const box = $('#subtitleEnabled')") || !player.includes("showPlayerControls(); return; }")) throw new Error('C reveal missing');
write('src/player.js', player);

console.log('LIBMPV_R2M_OPEN_RACE_KEY_UI_OK fileLoadedGate=1 staleTimingReset=1 endedEdge=1 keyReveal=selective+c');

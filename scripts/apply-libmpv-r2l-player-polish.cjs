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

// Bind media state to the exact bridge generation and fire ended only on a false -> true edge.
let entry = read('src/libmpv-shared-entry.js');
entry = replaceOnce(entry,
  '    this._playerOpen = false;\n    this._lastState = null;',
  '    this._playerOpen = false;\n    this._generation = 0;\n    this._lastState = null;',
  'generation field');
entry = replaceOnce(entry,
  '    this._playerOpen = false;\n    this._openPromise = null;\n    delete this.dataset.libmpvPlayerId;',
  '    this._playerOpen = false;\n    this._generation = 0;\n    this._openPromise = null;\n    delete this.dataset.libmpvPlayerId;',
  'generation reset');
entry = replaceOnce(entry,
  '      this._playerOpen = Boolean(result?.ok);\n      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);',
  '      this._playerOpen = Boolean(result?.ok);\n      this._generation = Number(result?.generation) || 0;\n      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);',
  'generation capture');
entry = replaceOnce(entry,
  '      if (!state?.active) return;\n      const previousTime = this._time;',
  '      if (!state?.active) return;\n      if (this._generation && Number(state.generation) !== this._generation) return;\n      const previousTime = this._time;',
  'generation poll guard');
entry = replaceOnce(entry,
  '      const previousHeight = this._height;\n      const previousPaused = this._paused;',
  '      const previousHeight = this._height;\n      const previousPaused = this._paused;\n      const previousEnded = this._ended;',
  'ended edge snapshot');
entry = replaceOnce(entry,
  "      if (this._ended) this.dispatchEvent(new Event('ended'));",
  "      if (this._ended && !previousEnded) this.dispatchEvent(new Event('ended'));",
  'ended edge dispatch');

// Match the visible normal-Lilac VTT UI more closely and keep the full lower position range.
entry = replaceOnce(entry,
  '.lilac-vtt-stack,.lilac-vtt-top{position:absolute;left:2%;right:2%;display:flex;flex-direction:column;align-items:center;gap:.08em;text-align:center;white-space:pre-line;line-height:1.22;color:#fff;overflow-wrap:anywhere}',
  '.lilac-vtt-stack,.lilac-vtt-top{position:absolute;left:2%;right:2%;display:flex;flex-direction:column;align-items:center;text-align:center;white-space:pre-line;line-height:1.2;color:#fff;overflow-wrap:anywhere}',
  'subtitle stack metrics');
entry = entry.replace(/\n    \/\/ Match official Lilac\/Android placement:[\s\S]*?\n    const bottomInset = 100 - baseline;\n/, '\n');
entry = replaceOnce(entry,
  "    bottomStack.style.bottom = `${bottomInset.toFixed(3)}%`;",
  "    bottomStack.style.bottom = `${position.toFixed(3)}%`;",
  'subtitle position calibration');
for (const marker of ['this._generation = Number(result?.generation) || 0','Number(state.generation) !== this._generation','this._ended && !previousEnded','position.toFixed(3)','line-height:1.2']) {
  if (!entry.includes(marker)) throw new Error(`R2L entry marker missing: ${marker}`);
}
write('src/libmpv-shared-entry.js', entry);

let player = read('src/player.js');
// Wrap the live episode function at stable button wiring instead of rewriting its transform-sensitive body.
player = replaceOnce(player,
  "$('#previousEpisode').onclick = () => playSiblingEpisode(siblingEpisode(-1));",
  "const unlockedPlaySiblingEpisode = playSiblingEpisode;\nlet episodeTransitioning = false;\nplaySiblingEpisode = async episode => {\n  if (!episode || episodeTransitioning) return;\n  episodeTransitioning = true;\n  try { return await unlockedPlaySiblingEpisode(episode); }\n  finally { episodeTransitioning = false; }\n};\n$('#previousEpisode').onclick = () => playSiblingEpisode(siblingEpisode(-1));",
  'episode transition wrapper');

// Any actual mouse movement reveals controls. Use the stable capture key listener to reveal them for every
// unmodified player shortcut (arrows, digits, C, Space, Z/X, P/S, brackets, media/page keys) without touching
// the individual shortcut implementations.
player = replaceOnce(player,
  "  if (!playerLocked && event.target !== $('#video') && player.classList.contains('controls-visible')) showPlayerControls();",
  "  if (!playerLocked) showPlayerControls();",
  'mousemove reveals controls');
player = replaceOnce(player,
  "window.addEventListener('keydown', () => { usingKeyboard = true; }, true);",
  "window.addEventListener('keydown', event => {\n  usingKeyboard = true;\n  const typingTarget = event.target instanceof Element && event.target.matches('input,textarea,select,[contenteditable=\\\"true\\\"]');\n  if (!typingTarget && !event.ctrlKey && !event.altKey && !event.metaKey && document.body.classList.contains('player-mode')) showPlayerControls();\n}, true);",
  'capture keyboard reveal');

// Hide the unsupported libmpv PiP affordance until a shared-texture PiP path is qualified.
player = replaceOnce(player,
  "$('#miniPlayer').onclick=()=>togglePictureInPicture();",
  "$('#miniPlayer').onclick=()=>togglePictureInPicture();\nif ($('#video')?.tagName === 'LILAC-MPV-VIDEO') { $('#miniPlayer').classList.add('hidden'); $('#miniPlayer').setAttribute('aria-hidden', 'true'); }",
  'hide unsupported libmpv PiP');
for (const marker of ['unlockedPlaySiblingEpisode','let episodeTransitioning = false','if (!episode || episodeTransitioning) return','if (!playerLocked) showPlayerControls()','typingTarget',"tagName === 'LILAC-MPV-VIDEO'"]) {
  if (!player.includes(marker)) throw new Error(`R2L player marker missing: ${marker}`);
}
write('src/player.js', player);

// Controls and gradients are transient even while paused; an open settings panel is the pin-open state.
let app = read('src/app.js');
app = replaceOnce(app,
  "function showPlayerControls(){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!$('#video').paused&&!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen())player.classList.remove('controls-visible')},2000)}",
  "function showPlayerControls(){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen())player.classList.remove('controls-visible')},2000)}",
  'paused controls auto-hide');
if (app.includes("if(!$('#video').paused&&!settingsOpen())")) throw new Error('paused control hold still present');
write('src/app.js', app);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.49-libmpv-r2k.rc1') throw new Error(`R2L expected R2K package, got ${pkg.version}`);
pkg.version = '0.5.49-libmpv-r2l.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.49-r2';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2L-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2L_PLAYER_POLISH_OK generationGuard=1 endedEdge=1 episodeLock=wrapper controls=transient paused=autohide subtitles=calibrated pip=hidden');

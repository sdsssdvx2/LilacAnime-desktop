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
function replaceRegexOnce(source, pattern, replacer, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one regex match, found ${matches.length}`);
  return source.replace(pattern, replacer);
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

// Calibrate the custom VTT overlay to the visible Lilac subtitle UI. Position is a direct bottom inset,
// so 0 really reaches the bottom and 45 remains available; remove the extra custom cue gap.
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

// Serialize next/previous episode transitions. Earlier diagnostic transforms may insert code inside this function,
// so transform the whole bounded function instead of relying on adjacent source lines.
let player = read('src/player.js');
const siblingPattern = /async function playSiblingEpisode\(episode\)\s*\{([\s\S]*?)\n\}\n\n\/\/ Explicit seeks/;
player = replaceRegexOnce(player, siblingPattern, (_whole, originalBody) => {
  let body = originalBody;
  const before = body;
  body = body.replace(/^\s*if\s*\(!episode\)\s*return;?\s*/m, '\n');
  if (body === before) throw new Error('episode transition lock: initial guard not found inside bounded function');
  return `let episodeTransitioning = false;\nasync function playSiblingEpisode(episode) {\n  if (!episode || episodeTransitioning) return;\n  episodeTransitioning = true;\n  try {${body}\n  } finally {\n    episodeTransitioning = false;\n  }\n}\n\n// Explicit seeks`;
}, 'bounded sibling episode function');

// Any real mouse movement reveals controls; all unmodified player shortcuts reveal them before their action.
player = replaceOnce(player,
  "  if (!playerLocked && event.target !== $('#video') && player.classList.contains('controls-visible')) showPlayerControls();",
  "  if (!playerLocked) showPlayerControls();",
  'mousemove reveals controls');
player = replaceOnce(player,
  '  if (typing) return;\n  const controlsShown = player.classList.contains(\'controls-visible\');',
  "  if (typing) return;\n  if (!event.ctrlKey && !event.altKey && !event.metaKey) showPlayerControls();\n  const controlsShown = player.classList.contains('controls-visible');",
  'keyboard reveals controls');

// The current composite PiP path cannot draw a lilac-mpv-video custom element as a CanvasImageSource safely.
// Hide the dead affordance until a qualified shared-texture PiP path exists.
player = replaceOnce(player,
  "$('#miniPlayer').onclick=()=>togglePictureInPicture();",
  "$('#miniPlayer').onclick=()=>togglePictureInPicture();\nif ($('#video')?.tagName === 'LILAC-MPV-VIDEO') { $('#miniPlayer').classList.add('hidden'); $('#miniPlayer').setAttribute('aria-hidden', 'true'); }",
  'hide unsupported libmpv PiP');
for (const marker of ['let episodeTransitioning = false','if (!episode || episodeTransitioning) return','episodeTransitioning = false','if (!playerLocked) showPlayerControls()',"tagName === 'LILAC-MPV-VIDEO'"]) {
  if (!player.includes(marker)) throw new Error(`R2L player marker missing: ${marker}`);
}
write('src/player.js', player);

// Controls/gradients are transient whether playing or paused; settings panel is the only normal pin-open state.
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
// Keep the R2K identity so this is an in-place custom-channel update and preserves settings.
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2L-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2L_PLAYER_POLISH_OK generationGuard=1 endedEdge=1 episodeLock=1 controls=transient paused=autohide subtitles=calibrated pip=hidden');

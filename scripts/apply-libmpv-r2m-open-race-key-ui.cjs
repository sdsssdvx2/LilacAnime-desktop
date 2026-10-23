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
entry = replaceOnce(entry, '    this._generation = 0;\n    this._lastState = null;', '    this._generation = 0;\n    this._loadConfirmed = false;\n    this._lastState = null;', 'load-confirmed constructor state');
entry = replaceOnce(entry, '    this._generation = 0;\n    this._openPromise = null;', '    this._generation = 0;\n    this._loadConfirmed = false;\n    this._openPromise = null;', 'load-confirmed reset state');
entry = replaceOnce(entry, '    this._readyState = 0;\n    this._metadataSent = false;\n    this._ended = false;\n    this.dispatchEvent(new Event(\'waiting\'));', '    this._time = 0;\n    this._duration = 0;\n    this._readyState = 0;\n    this._metadataSent = false;\n    this._ended = false;\n    this._loadConfirmed = false;\n    this._lastState = null;\n    this.dispatchEvent(new Event(\'waiting\'));', 'clear stale media state on open');
entry = replaceOnce(entry, '      this._generation = Number(result?.generation) || 0;\n      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);', '      this._generation = Number(result?.generation) || 0;\n      this._loadConfirmed = false;\n      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);', 'reset confirmation after open result');
entry = replaceOnce(entry, '      if (this._generation && Number(state.generation) !== this._generation) return;\n      const previousTime = this._time;', '      if (this._generation && Number(state.generation) !== this._generation) return;\n      if (state.fileLoaded !== true) { this._lastState = state; return; }\n      this._loadConfirmed = true;\n      const previousTime = this._time;', 'ignore pre-FILE_LOADED state');
entry = replaceOnce(entry, '      this._ended = Boolean(state.eof) || (this._duration > 0 && this._time >= this._duration - 0.15 && this._paused);', '      this._ended = this._loadConfirmed && (Boolean(state.eof) || (this._duration > 0 && this._time >= this._duration - 0.15 && this._paused));', 'end requires confirmed load');
for (const marker of ['this._loadConfirmed = false','state.fileLoaded !== true','this._loadConfirmed = true','this._ended = this._loadConfirmed &&','this._time = 0;\n    this._duration = 0;']) if (!entry.includes(marker)) throw new Error(`R2M entry marker missing: ${marker}`);
write('src/libmpv-shared-entry.js', entry);

// Final controls policy: only genuine mouse movement may reveal the full controls/gradients,
// and an open player-settings sheet may pin them visible. Keyboard shortcuts, media-state
// events, episode transitions, clicks and slider input must not reveal or extend that UI.
let player = read('src/player.js');
const broadCapture = `window.addEventListener('keydown', event => {\n  usingKeyboard = true;\n  const typingTarget = event.target instanceof Element && event.target.matches('input,textarea,select,[contenteditable=\\"true\\"]');\n  if (!typingTarget && !event.ctrlKey && !event.altKey && !event.metaKey && document.body.classList.contains('player-mode')) showPlayerControls();\n}, true);`;
player = replaceOnce(player, broadCapture, "window.addEventListener('keydown', () => { usingKeyboard = true; }, true);", 'remove broad keyboard reveal');

let spaceRevealCount = 0;
player = rewriteSection(player, 'function finishSpaceHold(toggle = false) {', "\nwindow.addEventListener('keyup'", section => {
  spaceRevealCount = (section.match(/showPlayerControls\(\);/g) || []).length;
  if (spaceRevealCount < 1) throw new Error('Space release reveal anchor missing');
  return section.replaceAll('showPlayerControls();', '');
}, 'Space release keyboard reveal');

let keyRevealCount = 0;
player = rewriteSection(player, 'function handlePlayerKey(event) {', '\n// 스크린샷', section => {
  keyRevealCount = (section.match(/showPlayerControls\(\);/g) || []).length;
  if (keyRevealCount < 1) throw new Error('keyboard reveal anchors missing');
  return section.replaceAll('showPlayerControls();', '');
}, 'player keyboard reveals');

player = rewriteSection(player, 'function setPlayerLocked(locked) {', '\nfunction flashUnlockButton', section => {
  const count = (section.match(/showPlayerControls\(\);/g) || []).length;
  if (count !== 1) throw new Error(`lock section: expected one reveal, found ${count}`);
  return section.replace(/\s*else showPlayerControls\(\);/, '');
}, 'unlock reveal');

player = rewriteSection(player, 'function openPlayerSettings(open, focusSection = null) {', '\n// Mirrors the settings page', section => {
  const count = (section.match(/showPlayerControls\(\);/g) || []).length;
  if (count !== 1) throw new Error(`settings section: expected one reveal, found ${count}`);
  return section.replace('  showPlayerControls();', "  if (open) showPlayerControls('settings');\n  else { clearTimeout(controlsTimer); $('#immersivePlayer').classList.remove('controls-visible'); }");
}, 'settings pin policy');
player = replaceOnce(player, '  if (!playerLocked) showPlayerControls();', "  if (!playerLocked) showPlayerControls('mouse');", 'mousemove source tagging');

const finishBlock = player.slice(player.indexOf('function finishSpaceHold(toggle = false) {'), player.indexOf("\nwindow.addEventListener('keyup'", player.indexOf('function finishSpaceHold(toggle = false) {')));
const keyBlock = player.slice(player.indexOf('function handlePlayerKey(event) {'), player.indexOf('\n// 스크린샷', player.indexOf('function handlePlayerKey(event) {')));
const lockBlock = player.slice(player.indexOf('function setPlayerLocked(locked) {'), player.indexOf('\nfunction flashUnlockButton', player.indexOf('function setPlayerLocked(locked) {')));
const mouseBlock = player.slice(player.indexOf("$('#immersivePlayer').addEventListener('mousemove', event => {"), player.indexOf('\n// --- Picture-in-picture', player.indexOf("$('#immersivePlayer').addEventListener('mousemove', event => {")));
const settingsBlock = player.slice(player.indexOf('function openPlayerSettings(open, focusSection = null) {'), player.indexOf('\n// Mirrors the settings page', player.indexOf('function openPlayerSettings(open, focusSection = null) {')));
if (player.includes('typingTarget')) throw new Error('R2L broad keyboard reveal survived');
if (finishBlock.includes('showPlayerControls')) throw new Error('Space release still reveals full controls');
if (keyBlock.includes('showPlayerControls')) throw new Error('keyboard handler still reveals full controls');
if (lockBlock.includes('showPlayerControls')) throw new Error('unlock still reveals full controls');
if (!mouseBlock.includes("showPlayerControls('mouse')")) throw new Error('real mouse movement reveal missing');
if (!settingsBlock.includes("showPlayerControls('settings')")) throw new Error('settings panel pin-open reveal missing');
if (!settingsBlock.includes("classList.remove('controls-visible')")) throw new Error('settings close does not hide controls');
write('src/player.js', player);

let app = read('src/app.js');
// Defense in depth: even if a future indirect path calls showPlayerControls() during play/pause/seek,
// the reveal helper rejects every source except mouse movement or an actually-open settings panel.
const r2lControls = "function showPlayerControls(){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen())player.classList.remove('controls-visible')},2000)}";
const guardedControls = "function showPlayerControls(source=''){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;if(source!=='mouse'&&!settingsOpen())return;player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen())player.classList.remove('controls-visible')},2000)}";
app = replaceOnce(app, r2lControls, guardedControls, 'controls source guard');

// Remove known non-mouse callers as well, so the source itself expresses the policy instead of relying only on the guard.
app = replaceOnce(app, '  enterPlayer();showPlayerControls();', '  enterPlayer();', 'pending player reveal');
app = replaceOnce(app, '  enterPlayer();setPlayerLocked(false);showPlayerControls();updateEpisodeButtons();', '  enterPlayer();setPlayerLocked(false);updateEpisodeButtons();', 'play entry reveal');
app = replaceOnce(app, "$('#screenshotPlayer').onclick=()=>{takeScreenshot();showPlayerControls()};", "$('#screenshotPlayer').onclick=()=>{takeScreenshot()};", 'screenshot click timer extension');
app = replaceOnce(app, "$('#playerVolume').oninput=e=>{const video=$('#video');video.volume=Number(e.target.value)/100;video.muted=video.volume===0;localStorage.setItem('playerVolume',String(video.volume));localStorage.setItem('playerMuted',String(video.muted));syncVolumeUI();showPlayerControls()};", "$('#playerVolume').oninput=e=>{const video=$('#video');video.volume=Number(e.target.value)/100;video.muted=video.volume===0;localStorage.setItem('playerVolume',String(video.volume));localStorage.setItem('playerMuted',String(video.muted));syncVolumeUI()};", 'volume input reveal');
app = replaceOnce(app, "['mousedown','touchstart'].forEach(type=>$('#immersivePlayer').addEventListener(type,event=>{if(event.target!==$('#video'))showPlayerControls()},{passive:true}));\n", '', 'pointer press reveal');
app = replaceOnce(app, "if(player.classList.contains('controls-visible')){clearTimeout(controlsTimer);player.classList.remove('controls-visible')}else showPlayerControls()", "if(player.classList.contains('controls-visible')){clearTimeout(controlsTimer);player.classList.remove('controls-visible')}", 'video click reveal');
app = replaceOnce(app, "$('#video').addEventListener('playing',()=>{$('#immersivePlayer').classList.add('is-playing');$('#playerEmpty').classList.add('hidden');showPlayerControls();prepareNext().catch(()=>{})});", "$('#video').addEventListener('playing',()=>{$('#immersivePlayer').classList.add('is-playing');$('#playerEmpty').classList.add('hidden');prepareNext().catch(()=>{})});", 'playing event reveal');
app = replaceOnce(app, "$('#video').addEventListener('pause',()=>{saveHistorySoon();$('#immersivePlayer').classList.remove('is-playing');showPlayerControls()});", "$('#video').addEventListener('pause',()=>{saveHistorySoon();$('#immersivePlayer').classList.remove('is-playing')});", 'pause event reveal');
app = replaceOnce(app, "$('#video').addEventListener('ended',()=>{const next=siblingEpisode(1);if(!next){$('#downloadStatus').textContent='마지막 회차입니다.';showPlayerControls();return}if(!playerFlag('playerAutoPlay')){$('#downloadStatus').textContent='재생이 끝났습니다.';showPlayerControls();return}playSiblingEpisode(next)});", "$('#video').addEventListener('ended',()=>{const next=siblingEpisode(1);if(!next){$('#downloadStatus').textContent='마지막 회차입니다.';return}if(!playerFlag('playerAutoPlay')){$('#downloadStatus').textContent='재생이 끝났습니다.';return}playSiblingEpisode(next)});", 'ended event reveal');

const playerCalls = [...player.matchAll(/showPlayerControls\(([^)]*)\)/g)].map(match => match[1]);
const appCalls = [...app.matchAll(/showPlayerControls\(([^)]*)\)/g)].map(match => match[1]);
if (playerCalls.length !== 2 || !playerCalls.includes("'mouse'") || !playerCalls.includes("'settings'")) throw new Error(`unexpected player controls call sites: ${playerCalls.join('|')}`);
if (appCalls.length !== 1 || appCalls[0] !== "source=''" ) throw new Error(`unexpected app controls call sites: ${appCalls.join('|')}`);
if (!app.includes("if(source!=='mouse'&&!settingsOpen())return")) throw new Error('controls source guard missing');
if (!app.includes("if(!settingsOpen())controlsTimer=setTimeout")) throw new Error('2-second transient controls timer missing');
write('src/app.js', app);

console.log(`LIBMPV_R2M_OPEN_RACE_KEY_UI_OK fileLoadedGate=1 staleTimingReset=1 endedEdge=1 removedKey=${keyRevealCount} removedSpace=${spaceRevealCount} controlsPolicy=mouse-or-settings playerCalls=${playerCalls.length} appCalls=${appCalls.length}`);

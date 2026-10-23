'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const playerSource = fs.readFileSync(path.join(root, 'src', 'player.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');

function block(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last <= first) throw new Error(`missing section: ${start}`);
  return source.slice(first, last);
}
function classList(...initial) {
  const values = new Set(initial);
  return {
    contains: value => values.has(value),
    add: value => values.add(value),
    remove: value => values.delete(value),
    toggle(value, on) { on ? values.add(value) : values.delete(value); }
  };
}

const finishSource = block(playerSource, 'function finishSpaceHold(toggle = false) {', "\nwindow.addEventListener('keyup'");
const keySource = block(playerSource, 'function handlePlayerKey(event) {', '\n// 스크린샷');
const mouseSource = block(playerSource, "$('#immersivePlayer').addEventListener('mousemove', event => {", '\n// --- Picture-in-picture');
const settingsSource = block(playerSource, 'function openPlayerSettings(open, focusSection = null) {', '\n// Mirrors the settings page');
const controlsSource = block(appSource, 'function showPlayerControls(', '\nfunction scheduleOpEdAnalysis');
const volumeSource = block(appSource, "$('#playerVolume').oninput=", "\n$('#video').addEventListener('volumechange'");
const playingSource = block(appSource, "$('#video').addEventListener('playing'", '\n// Progress is saved');
const pauseSource = block(appSource, "$('#video').addEventListener('pause'", "\n$('#video').addEventListener('waiting'");
const endedSource = block(appSource, "$('#video').addEventListener('ended'", "\n$('#video').addEventListener('loadedmetadata'");

// Exhaustive static call-site gate: after R2M, player.js may invoke the full controls only
// from the settings sheet and real mouse movement. app.js owns only the guarded definition.
const playerCalls = [...playerSource.matchAll(/showPlayerControls\(([^)]*)\)/g)].map(match => match[1]);
const appCalls = [...appSource.matchAll(/showPlayerControls\(([^)]*)\)/g)].map(match => match[1]);
assert.deepEqual(playerCalls.slice().sort(), ["'mouse'", "'settings'"].sort(), `unexpected player controls calls: ${playerCalls.join('|')}`);
assert.deepEqual(appCalls, ["source=''"], `unexpected app controls calls: ${appCalls.join('|')}`);
assert.equal(playerSource.includes('typingTarget'), false, 'broad key capture reveal survived');
assert.equal(finishSource.includes('showPlayerControls'), false, 'Space release still reveals full controls');
assert.equal(keySource.includes('showPlayerControls'), false, 'keyboard handler still reveals full controls');
assert.equal(volumeSource.includes('showPlayerControls'), false, 'volume input still reveals full controls');
assert.equal(playingSource.includes('showPlayerControls'), false, 'playing event still reveals full controls');
assert.equal(pauseSource.includes('showPlayerControls'), false, 'pause event still reveals full controls');
assert.equal(endedSource.includes('showPlayerControls'), false, 'ended event still reveals full controls');
assert.ok(mouseSource.includes("showPlayerControls('mouse')"), 'actual mouse movement no longer reveals controls');
assert.ok(settingsSource.includes("showPlayerControls('settings')"), 'settings panel no longer pins controls visible');
assert.ok(settingsSource.includes("classList.remove('controls-visible')"), 'settings close does not hide controls');
assert.ok(controlsSource.includes("if(source!=='mouse'&&!settingsOpen())return"), 'controls source guard missing');
assert.ok(controlsSource.includes('if(!settingsOpen())controlsTimer=setTimeout'), '2-second mouse auto-hide missing');

let revealCount = 0;
let actionCount = 0;
let timerId = 0;
let scheduled = new Map();
const storage = new Map();
const player = { classList: classList(), contains: () => false };
const speedBoost = { classList: classList('hidden') };
let context;
const video = {
  duration: 100,
  currentTime: 50,
  playbackRate: 1,
  volume: .5,
  muted: false,
  paused: false,
  ended: false,
  play() { this.paused = false; actionCount++; context.showPlayerControls(); return Promise.resolve(); },
  pause() { this.paused = true; actionCount++; context.showPlayerControls(); }
};
const subtitle = { checked: true, dispatchEvent() { actionCount++; context.showPlayerControls(); } };
const skip = { classList: classList('hidden'), click() { actionCount++; context.showPlayerControls(); } };
const speed = { value: '1' };
const playerVolume = {
  value: '50',
  dispatchEvent() {
    video.volume = Number(this.value) / 100;
    video.muted = video.volume === 0;
    storage.set('playerVolume', String(video.volume));
    storage.set('playerMuted', String(video.muted));
    actionCount++;
    // Deliberately emulate an accidental legacy indirect reveal. The source guard must reject it.
    context.showPlayerControls();
  }
};
const toggle = { focus() { document.activeElement = this; actionCount++; } };
const button = () => ({ click() { actionCount++; context.showPlayerControls(); }, focus() { document.activeElement = this; } });
const fullscreen = button(), mute = button(), back = button(), settingsButton = button();
const elements = {
  '#video': video,
  '#immersivePlayer': player,
  '#playerSpeedBoost': speedBoost,
  '#togglePlayer': toggle,
  '#subtitleEnabled': subtitle,
  '#skipNow': skip,
  '#speed': speed,
  '#playerVolume': playerVolume,
  '#fullscreenPlayer': fullscreen,
  '#mutePlayer': mute,
  '#playerBack': back,
  '#playerSettingsButton': settingsButton,
  '#playerSettings': { classList: classList() }
};
const document = {
  body: { classList: classList('player-mode') },
  activeElement: { tagName: 'BODY', matches: () => false },
  fullscreenElement: null,
  exitFullscreen() { actionCount++; this.fullscreenElement = null; context.showPlayerControls(); }
};
context = vm.createContext({
  $, document,
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  },
  playerLocked: false,
  playerWindowFullscreen: false,
  controlsTimer: null,
  playerSettingsOpen: () => false,
  playerFlag: (key, fallback = true) => key === 'arrowVolume' ? true : fallback,
  flashUnlockButton: () => { actionCount++; },
  openPlayerSettings: () => { actionCount++; },
  moveFocus: () => { actionCount++; return true; },
  seekPlayer: value => { video.currentTime = value; actionCount++; context.showPlayerControls(); },
  toast: () => { actionCount++; },
  takeScreenshot: () => { actionCount++; context.showPlayerControls(); },
  setSubtitleSync: value => { storage.set('subtitleSync', String(value)); actionCount++; },
  syncPlayerSettingsUI: () => { actionCount++; },
  playSiblingEpisode: () => { actionCount++; context.showPlayerControls(); context.showPlayerControls(); },
  siblingEpisode: step => ({ step }),
  SPEED_OPTIONS: [.1, .25, .5, .75, 1, 1.25, 1.5, 1.75, 2, 3, 4],
  Event: class Event { constructor(type) { this.type = type; } },
  clearTimeout: id => scheduled.delete(id),
  setTimeout: fn => { const id = ++timerId; scheduled.set(id, fn); return id; },
  console
});
function $(selector) { return elements[selector] || null; }

vm.runInContext(`${controlsSource}\nlet spaceHold = null;\nfunction startSpaceHold(event) {\n  event.preventDefault();\n  if (!event.repeat) spaceHold = { source: 'keyboard', pointer: null, boosted: false, rate: $('#video').playbackRate, timer: null };\n}\n${finishSource}\n${keySource}`, context);

function eventFor(key, code = key) {
  return {
    key, code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false,
    preventDefault() { this.prevented = true; }
  };
}
function reset() {
  revealCount = 0;
  actionCount = 0;
  scheduled = new Map();
  context.controlsTimer = null;
  player.classList.remove('controls-visible');
  video.duration = 100;
  video.currentTime = 50;
  video.playbackRate = 1;
  video.volume = .5;
  video.muted = false;
  video.paused = false;
  video.ended = false;
  subtitle.checked = true;
  speed.value = '1';
  playerVolume.value = '50';
  document.activeElement = { tagName: 'BODY', matches: () => false };
  document.fullscreenElement = null;
  context.playerLocked = false;
  context.playerWindowFullscreen = false;
  context.playerSettingsOpen = () => false;
  context.playerFlag = (key, fallback = true) => key === 'arrowVolume' ? true : fallback;
}
function assertQuiet(label, event, after = null, expectAction = true) {
  reset();
  context.handlePlayerKey(event);
  after?.();
  assert.equal(player.classList.contains('controls-visible'), false, `${label}: controls-visible became true`);
  assert.equal(scheduled.size, 0, `${label}: keyboard extended the controls timer`);
  if (expectAction) assert.ok(actionCount > 0, `${label}: shortcut action did not execute`);
}

const cases = [
  ['ArrowLeft', eventFor('ArrowLeft', 'ArrowLeft')],
  ['ArrowRight', eventFor('ArrowRight', 'ArrowRight')],
  ['ArrowUp-volume', eventFor('ArrowUp', 'ArrowUp')],
  ['ArrowDown-volume', eventFor('ArrowDown', 'ArrowDown')],
  ['C', eventFor('c', 'KeyC')],
  ['Z', eventFor('z', 'KeyZ')],
  ['X', eventFor('x', 'KeyX')],
  ['P', eventFor('p', 'KeyP')],
  ['S', eventFor('s', 'KeyS')],
  ['BracketLeft', eventFor('[', 'BracketLeft')],
  ['BracketRight', eventFor(']', 'BracketRight')],
  ['F', eventFor('f', 'KeyF')],
  ['M', eventFor('m', 'KeyM')],
  ['PageUp', eventFor('PageUp', 'PageUp')],
  ['PageDown', eventFor('PageDown', 'PageDown')],
  ['MediaTrackPrevious', eventFor('MediaTrackPrevious', 'MediaTrackPrevious')],
  ['MediaTrackNext', eventFor('MediaTrackNext', 'MediaTrackNext')],
  ['MediaPlayPause', eventFor('MediaPlayPause', 'MediaPlayPause')],
  ['Enter', eventFor('Enter', 'Enter')],
  ['Escape', eventFor('Escape', 'Escape')],
  ['BrowserBack', eventFor('BrowserBack', 'BrowserBack')]
];
for (let number = 0; number <= 9; number++) cases.push([`Digit${number}`, eventFor(String(number), `Digit${number}`)]);
for (const [label, event] of cases) assertQuiet(label, event);
assertQuiet('Space-short-press', eventFor(' ', 'Space'), () => context.finishSpaceHold(true));
assertQuiet('UnhandledKey', eventFor('q', 'KeyQ'), null, false);

// Also cover remote-focus arrow fallback with arrowVolume disabled.
for (const [label, key] of [['ArrowUp-focus', 'ArrowUp'], ['ArrowDown-focus', 'ArrowDown']]) {
  reset();
  context.playerFlag = (name, fallback = true) => name === 'arrowVolume' ? false : fallback;
  context.handlePlayerKey(eventFor(key, key));
  assert.equal(player.classList.contains('controls-visible'), false, `${label}: controls-visible became true`);
  assert.equal(scheduled.size, 0, `${label}: keyboard extended the controls timer`);
  assert.ok(actionCount > 0, `${label}: fallback focus action did not execute`);
}

// Even a legacy/indirect no-source call is rejected by the runtime guard.
reset();
context.showPlayerControls();
assert.equal(player.classList.contains('controls-visible'), false, 'unguarded internal reveal was accepted');
assert.equal(scheduled.size, 0, 'unguarded internal reveal scheduled a timer');

// Genuine mouse movement is the transient reveal path and expires after ~2s.
reset();
context.showPlayerControls('mouse');
assert.equal(player.classList.contains('controls-visible'), true, 'mouse reveal rejected');
assert.equal(scheduled.size, 1, 'mouse reveal did not schedule auto-hide');
[...scheduled.values()][0]();
assert.equal(player.classList.contains('controls-visible'), false, 'mouse reveal did not auto-hide');

// Settings are the sole pin-open path: visible with no auto-hide timer while open.
reset();
context.playerSettingsOpen = () => true;
context.showPlayerControls('settings');
assert.equal(player.classList.contains('controls-visible'), true, 'settings pin reveal rejected');
assert.equal(scheduled.size, 0, 'settings pin unexpectedly scheduled auto-hide');

console.log(`LIBMPV_R2M_KEY_UI_PASS keys=${cases.length + 4} actions=preserved keyboardVisible=0 keyboardTimers=0 indirectGuard=1 mouseReveal=1 mouseAutoHide=1 settingsPin=1 callSites=2`);

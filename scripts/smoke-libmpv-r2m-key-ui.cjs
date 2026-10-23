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
const controlsSource = block(appSource, 'function showPlayerControls()', '\nfunction scheduleOpEdAnalysis');

assert.equal(playerSource.includes('typingTarget'), false, 'broad key capture reveal survived');
assert.equal(finishSource.includes('showPlayerControls'), false, 'Space release still reveals full controls');
assert.equal(keySource.includes('showPlayerControls'), false, 'keyboard handler still reveals full controls');
assert.ok(mouseSource.includes('if (!playerLocked) showPlayerControls();'), 'actual mouse movement no longer reveals controls');
assert.ok(settingsSource.includes('showPlayerControls();'), 'settings panel no longer pins controls visible');
assert.ok(controlsSource.includes('if(!settingsOpen())controlsTimer=setTimeout'), 'paused controls are not transient');
assert.equal(controlsSource.includes("if(!$('#video').paused&&!settingsOpen())"), false, 'paused playback still pins controls');

let revealCount = 0;
let actionCount = 0;
const storage = new Map();
const player = { classList: classList(), contains: () => false };
const speedBoost = { classList: classList('hidden') };
const video = {
  duration: 100,
  currentTime: 50,
  playbackRate: 1,
  paused: false,
  ended: false,
  play() { this.paused = false; actionCount++; return Promise.resolve(); },
  pause() { this.paused = true; actionCount++; }
};
const subtitle = { checked: true, dispatchEvent() { actionCount++; } };
const skip = { classList: classList('hidden'), click() { actionCount++; } };
const speed = { value: '1' };
const toggle = { focus() { document.activeElement = this; } };
const button = () => ({ click() { actionCount++; }, focus() { document.activeElement = this; } });
const fullscreen = button(), mute = button(), back = button(), settingsButton = button();
const elements = {
  '#video': video,
  '#immersivePlayer': player,
  '#playerSpeedBoost': speedBoost,
  '#togglePlayer': toggle,
  '#subtitleEnabled': subtitle,
  '#skipNow': skip,
  '#speed': speed,
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
  exitFullscreen() { actionCount++; this.fullscreenElement = null; }
};
const context = vm.createContext({
  $, document,
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  },
  playerLocked: false,
  playerWindowFullscreen: false,
  playerSettingsOpen: () => false,
  showPlayerControls: () => { revealCount++; player.classList.add('controls-visible'); },
  flashUnlockButton: () => { actionCount++; },
  openPlayerSettings: () => { actionCount++; },
  moveFocus: () => { actionCount++; return true; },
  seekPlayer: value => { video.currentTime = value; actionCount++; },
  toast: () => { actionCount++; },
  takeScreenshot: () => { actionCount++; },
  setSubtitleSync: value => { storage.set('subtitleSync', String(value)); actionCount++; },
  syncPlayerSettingsUI: () => { actionCount++; },
  playSiblingEpisode: () => { actionCount++; },
  siblingEpisode: step => ({ step }),
  SPEED_OPTIONS: [.1, .25, .5, .75, 1, 1.25, 1.5, 1.75, 2, 3, 4],
  Event: class Event { constructor(type) { this.type = type; } },
  clearTimeout: () => {},
  console
});
function $(selector) { return elements[selector] || null; }

vm.runInContext(`
let spaceHold = null;
function startSpaceHold(event) {
  event.preventDefault();
  if (!event.repeat) spaceHold = { source: 'keyboard', pointer: null, boosted: false, rate: $('#video').playbackRate, timer: null };
}
${finishSource}
${keySource}
`, context);

function eventFor(key, code = key) {
  return {
    key, code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false,
    preventDefault() { this.prevented = true; }
  };
}
function reset() {
  revealCount = 0;
  actionCount = 0;
  player.classList.remove('controls-visible');
  video.duration = 100;
  video.currentTime = 50;
  video.playbackRate = 1;
  video.paused = false;
  video.ended = false;
  subtitle.checked = true;
  speed.value = '1';
  document.activeElement = { tagName: 'BODY', matches: () => false };
  document.fullscreenElement = null;
  context.playerLocked = false;
  context.playerWindowFullscreen = false;
  context.playerSettingsOpen = () => false;
}
function assertQuiet(label, event, after = null) {
  reset();
  context.handlePlayerKey(event);
  after?.();
  assert.equal(revealCount, 0, `${label}: showPlayerControls called`);
  assert.equal(player.classList.contains('controls-visible'), false, `${label}: controls-visible became true`);
}

const cases = [
  ['ArrowLeft', eventFor('ArrowLeft', 'ArrowLeft')],
  ['ArrowRight', eventFor('ArrowRight', 'ArrowRight')],
  ['ArrowUp', eventFor('ArrowUp', 'ArrowUp')],
  ['ArrowDown', eventFor('ArrowDown', 'ArrowDown')],
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
  ['BrowserBack', eventFor('BrowserBack', 'BrowserBack')],
  ['UnhandledKey', eventFor('q', 'KeyQ')]
];
for (let number = 0; number <= 9; number++) cases.push([`Digit${number}`, eventFor(String(number), `Digit${number}`)]);
for (const [label, event] of cases) assertQuiet(label, event);

assertQuiet('Space-short-press', eventFor(' ', 'Space'), () => context.finishSpaceHold(true));

// A key pressed while mouse-revealed controls are already visible must not refresh the timer either.
reset();
player.classList.add('controls-visible');
context.handlePlayerKey(eventFor('ArrowRight', 'ArrowRight'));
assert.equal(revealCount, 0, 'keyboard refreshed already-visible controls');
assert.equal(player.classList.contains('controls-visible'), true, 'keyboard unexpectedly hid already-visible controls');

console.log(`LIBMPV_R2M_KEY_UI_PASS keys=${cases.length + 1} hidden=all revealCalls=0 mouseReveal=1 settingsPin=1 pausedAutoHide=1`);

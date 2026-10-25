'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r31-focus-compositor-state-coalesce-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceBlock(label, assignment, replacement) {
  const labelAt = source.indexOf(`'${label}'`);
  if (labelAt < 0) throw new Error(`R31 anchor normalizer label missing: ${label}`);
  const start = source.lastIndexOf(`${assignment} = replaceOnce(`, labelAt);
  const end = source.indexOf('\n);', labelAt);
  if (start < 0 || end < 0) throw new Error(`R31 anchor normalizer block missing: ${label}`);
  source = source.slice(0, start) + replacement + source.slice(end + 3);
}

// Generate the transform using arrays joined by LF rather than nested escaped
// multiline literals. This makes the build-time patch insensitive to JS string
// escape depth and keeps every source anchor explicit.
replaceBlock('R31 state diagnostics fields', 'bridge', `{
  const r31StateSpread = '      ...(lastState || {})';
  const r31StateLines = [
    "      r31StateCoalesce: 'LILAC_R31_STATE_COALESCE',",
    '      r31StateNativePollIntervalMs: R31_PLAYBACK_STATE_POLL_MS,',
    '      r31StateSampleWallMs,',
    '      r31StateNativePolls,',
    '      r31StateCacheHits,',
    '      r31StateCacheAgeMs: r31StateSampleWallMs > 0 ? Math.max(0, Date.now() - r31StateSampleWallMs) : 0,',
    r31StateSpread
  ].join(String.fromCharCode(10));
  bridge = replaceOnce(bridge, r31StateSpread, r31StateLines, 'R31 state diagnostics fields');
}`);

// R2B normalizes set_property to mpv input-command `set` inside a try/catch.
// Anchor only the unique native command call and preserve its existing wrapper.
replaceBlock('R31 invalidate state cache on timing commands', 'bridge', `{
  const r31CommandAnchor = '      addon.command(playerId, commandArray);';
  const r31CommandLines = [
    r31CommandAnchor,
    "      if (commandArray[0] === 'set' && ['time-pos', 'pause', 'speed'].includes(commandArray[1])) {",
    '        r31LastPlaybackPollPerfMs = -Infinity;',
    '      }'
  ].join(String.fromCharCode(10));
  bridge = replaceOnce(bridge, r31CommandAnchor, r31CommandLines, 'R31 invalidate state cache on timing commands');
}`);

// Constructor/reset are located structurally inside their own method ranges.
replaceBlock('R31 renderer clock fields', 'renderer', `{
  const r31ClassAt = renderer.indexOf('class LilacSharedMpvElement extends HTMLElement');
  const r31CtorAt = renderer.indexOf('  constructor() {', r31ClassAt);
  const r31CtorEnd = renderer.indexOf('  connectedCallback() {', r31CtorAt);
  const r31TimeAnchor = '    this._time = 0;';
  const r31TimeAt = renderer.indexOf(r31TimeAnchor, r31CtorAt);
  if (r31ClassAt < 0 || r31CtorAt < 0 || r31CtorEnd < 0 || r31TimeAt < r31CtorAt || r31TimeAt >= r31CtorEnd) {
    throw new Error('R31 renderer constructor clock anchor missing');
  }
  const r31CtorLines = [
    r31TimeAnchor,
    "    this._r31StateClockMode = 'LILAC_R31_STATE_CLOCK';",
    '    this._stateClockTime = 0;',
    '    this._stateSampleWallMs = 0;'
  ].join(String.fromCharCode(10));
  renderer = renderer.slice(0, r31TimeAt) + r31CtorLines + renderer.slice(r31TimeAt + r31TimeAnchor.length);
}`);

replaceBlock('R31 reset renderer clock', 'renderer', `{
  const r31ResetAt = renderer.indexOf('  _resetMediaState() {');
  const r31ResetEnd = renderer.indexOf('  get src()', r31ResetAt);
  const r31ResetTimeAnchor = '    this._time = 0;';
  const r31ResetTimeAt = renderer.indexOf(r31ResetTimeAnchor, r31ResetAt);
  if (r31ResetAt < 0 || r31ResetEnd < 0 || r31ResetTimeAt < r31ResetAt || r31ResetTimeAt >= r31ResetEnd) {
    throw new Error('R31 renderer reset clock anchor missing');
  }
  const r31ResetLines = [
    r31ResetTimeAnchor,
    '    this._stateClockTime = 0;',
    '    this._stateSampleWallMs = 0;'
  ].join(String.fromCharCode(10));
  renderer = renderer.slice(0, r31ResetTimeAt) + r31ResetLines + renderer.slice(r31ResetTimeAt + r31ResetTimeAnchor.length);
}`);

// Safety correction: Canvas2D drawImage() consumes the VideoFrame synchronously
// for the canvas backing store. Do not retain a cloned VideoFrame on a timer;
// inactive-window timer delay could otherwise hold native shared-texture slots.
const heldCounters = String.raw`\nlet r31HeldVideoFrames = 0;\nlet r31HeldVideoFramesMax = 0;`;
if (!source.includes(heldCounters)) throw new Error('R31 clone counter source anchor missing');
source = source.replace(heldCounters, '');

const heldDraw = String.raw`  let held = null;\n  try { held = typeof frame?.clone === 'function' ? frame.clone() : null; } catch {}\n  const drawStarted = performance.now();\n  context.drawImage(held || frame, 0, 0, width, height);\n  const elapsed = Math.max(0, performance.now() - drawStarted);\n  r31FocusShieldDrawSamples += 1;\n  r31FocusShieldDrawTotalMs += elapsed;\n  r31FocusShieldDrawMaxMs = Math.max(r31FocusShieldDrawMaxMs, elapsed);\n  r31FocusShieldReady = true;\n  if (held) {\n    r31HeldVideoFrames += 1;\n    r31HeldVideoFramesMax = Math.max(r31HeldVideoFramesMax, r31HeldVideoFrames);\n    setTimeout(() => {\n      try { held.close?.(); } catch {}\n      r31HeldVideoFrames = Math.max(0, r31HeldVideoFrames - 1);\n    }, 34);\n  }\n  return elapsed;`;
const directDraw = String.raw`  const drawStarted = performance.now();\n  context.drawImage(frame, 0, 0, width, height);\n  const elapsed = Math.max(0, performance.now() - drawStarted);\n  r31FocusShieldDrawSamples += 1;\n  r31FocusShieldDrawTotalMs += elapsed;\n  r31FocusShieldDrawMaxMs = Math.max(r31FocusShieldDrawMaxMs, elapsed);\n  r31FocusShieldReady = true;\n  return elapsed;`;
if (!source.includes(heldDraw)) throw new Error('R31 timed clone draw source anchor missing');
source = source.replace(heldDraw, directDraw);

for (const stat of [
  String.raw`\n      r31HeldVideoFrames,\n      r31HeldVideoFramesMax,`,
  String.raw`\n      heldVideoFrames: r31HeldVideoFrames,\n      heldVideoFramesMax: r31HeldVideoFramesMax`
]) {
  if (!source.includes(stat)) throw new Error('R31 held-frame diagnostic anchor missing');
  source = source.replace(stat, '');
}
source = source.replace('heldCloneMs=34 ', 'cloneHold=none ');

if (source.includes('frame?.clone') || source.includes('r31HeldVideoFrames') || source.includes('setTimeout(() => {\\n      try { held.close')) {
  throw new Error('R31 timed VideoFrame retention survived normalization');
}

fs.writeFileSync(target, source, 'utf8');
console.log('R31_TRANSFORM_ANCHORS_OK state=lf-safe command=native-call-scoped constructor=structural bundleMarker=semantic reset=structural focusShieldCloneHold=none');

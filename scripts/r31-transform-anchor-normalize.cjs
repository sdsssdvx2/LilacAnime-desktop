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

replaceBlock('R31 state diagnostics fields', 'bridge', `bridge = replaceOnce(
  bridge,
  \`      ...(lastState || {})\`,
  \`      r31StateCoalesce: 'LILAC_R31_STATE_COALESCE',\\n      r31StateNativePollIntervalMs: R31_PLAYBACK_STATE_POLL_MS,\\n      r31StateSampleWallMs,\\n      r31StateNativePolls,\\n      r31StateCacheHits,\\n      r31StateCacheAgeMs: r31StateSampleWallMs > 0 ? Math.max(0, Date.now() - r31StateSampleWallMs) : 0,\\n      ...(lastState || {})\`,
  'R31 state diagnostics fields'
);`);

// R2B normalizes set_property to mpv input-command `set` inside a try/catch.
// Anchor only the unique native command call so R31 remains compatible with the
// existing error-reporting wrapper and invalidate after successful timing writes.
replaceBlock('R31 invalidate state cache on timing commands', 'bridge', `bridge = replaceOnce(
  bridge,
  \`      addon.command(playerId, commandArray);\`,
  \`      addon.command(playerId, commandArray);\\n      if (commandArray[0] === 'set' && ['time-pos', 'pause', 'speed'].includes(commandArray[1])) {\\n        r31LastPlaybackPollPerfMs = -Infinity;\\n      }\`,
  'R31 invalidate state cache on timing commands'
);`);

replaceBlock('R31 renderer clock fields', 'renderer', `renderer = replaceOnce(
  renderer,
  \`    this._canvas = this._root.querySelector('canvas');\\n    this._time = 0;\\n    this._duration = 0;\`,
  \`    this._canvas = this._root.querySelector('canvas');\\n    this._time = 0;\\n    this._r31StateClockMode = 'LILAC_R31_STATE_CLOCK';\\n    this._stateClockTime = 0;\\n    this._stateSampleWallMs = 0;\\n    this._duration = 0;\`,
  'R31 renderer clock fields'
);`);

replaceBlock('R31 reset renderer clock', 'renderer', `renderer = replaceOnce(
  renderer,
  \`  _resetMediaState() {\\n    this._openToken += 1;\\n    this._rawSource = '';\\n    this._time = 0;\\n    this._duration = 0;\\n    this._width = 0;\`,
  \`  _resetMediaState() {\\n    this._openToken += 1;\\n    this._rawSource = '';\\n    this._time = 0;\\n    this._stateClockTime = 0;\\n    this._stateSampleWallMs = 0;\\n    this._duration = 0;\\n    this._width = 0;\`,
  'R31 reset renderer clock'
);`);

fs.writeFileSync(target, source, 'utf8');
console.log('R31_TRANSFORM_ANCHORS_OK state=spread-scoped command=native-call-scoped constructor=canvas-scoped bundleMarker=semantic reset=method-scoped');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r31-focus-compositor-state-coalesce-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceBlock(label, replacement) {
  const labelAt = source.indexOf(`'${label}'`);
  if (labelAt < 0) throw new Error(`R31 anchor normalizer label missing: ${label}`);
  const start = source.lastIndexOf('renderer = replaceOnce(', labelAt);
  const end = source.indexOf('\n);', labelAt);
  if (start < 0 || end < 0) throw new Error(`R31 anchor normalizer block missing: ${label}`);
  source = source.slice(0, start) + replacement + source.slice(end + 3);
}

replaceBlock('R31 renderer clock fields', `renderer = replaceOnce(
  renderer,
  \`    this._canvas = this._root.querySelector('canvas');\\n    this._time = 0;\\n    this._duration = 0;\`,
  \`    this._canvas = this._root.querySelector('canvas');\\n    this._time = 0;\\n    this._stateClockTime = 0; // LILAC_R31_STATE_CLOCK\\n    this._stateSampleWallMs = 0;\\n    this._duration = 0;\`,
  'R31 renderer clock fields'
);`);

replaceBlock('R31 reset renderer clock', `renderer = replaceOnce(
  renderer,
  \`  _resetMediaState() {\\n    this._openToken += 1;\\n    this._rawSource = '';\\n    this._time = 0;\\n    this._duration = 0;\\n    this._width = 0;\`,
  \`  _resetMediaState() {\\n    this._openToken += 1;\\n    this._rawSource = '';\\n    this._time = 0;\\n    this._stateClockTime = 0;\\n    this._stateSampleWallMs = 0;\\n    this._duration = 0;\\n    this._width = 0;\`,
  'R31 reset renderer clock'
);`);

fs.writeFileSync(target, source, 'utf8');
console.log('R31_TRANSFORM_ANCHORS_OK constructor=canvas-scoped reset=method-scoped');

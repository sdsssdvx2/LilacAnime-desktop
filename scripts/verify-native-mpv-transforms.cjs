'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const bridgePath = path.join(root, 'electron', 'mpv-native-main.cjs');
const entryPath = path.join(root, 'src', 'mpv-native-entry.js');
const bridge = fs.readFileSync(bridgePath, 'utf8');
const entry = fs.readFileSync(entryPath, 'utf8');

function fail(message) {
  console.error(`NATIVE_MPV_VERIFY_FAIL ${message}`);
  process.exit(1);
}

if (bridge.includes('lastRelativeBounds.holes = [];')) {
  fail('forced hole reset remains in transformed bridge');
}
if (!bridge.includes('value?.width ?? value?.w') || !bridge.includes('value?.height ?? value?.h')) {
  fail('bridge does not accept renderer w/h hole schema');
}
if (!entry.includes("addHole(document.querySelector('#playerBack'))") ||
    !entry.includes("addHole(document.querySelector('#lilacAutoDiagCard'))")) {
  fail('compact control/diagnostic hole markers are missing');
}
if (entry.includes("addHole(document.querySelector('#immersivePlayer .player-top'))") ||
    entry.includes("addHole(document.querySelector('#immersivePlayer .player-bottom'))")) {
  fail('full-width dock holes regressed');
}

const start = bridge.indexOf('  function normalizeHole(');
const end = bridge.indexOf('\n\n  function syncHostBounds()', start);
if (start < 0 || end < 0) fail('could not isolate bridge bounds helpers');
const helpers = bridge.slice(start, end);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${helpers}\nthis.__line = helperBoundsLine({\n  x: 0, y: 0, width: 1920, height: 1080, visible: true,\n  holes: [\n    { x: 20, y: 13, w: 42, h: 42 },\n    { x: 815, y: 970, width: 290, height: 50 },\n    { x: 1900, y: 1070, w: 100, h: 100 }\n  ]\n});`, sandbox);

const expected = 'B 0 0 1920 1080 1 3 20 13 42 42 815 970 290 50 1900 1070 20 10\n';
if (sandbox.__line !== expected) {
  fail(`bounds serialization mismatch: ${JSON.stringify(sandbox.__line)}`);
}

console.log('NATIVE_MPV_VERIFY_OK normalized renderer holes survive serialization with clipping');

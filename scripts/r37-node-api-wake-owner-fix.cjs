'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'electron', 'libmpv-shared-main.cjs');
let bridge = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

if (!bridge.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')) {
  throw new Error('R37 Node-API wake scope fix requires post-transform R37 bridge');
}
if (bridge.includes('LILAC_R37_TS_FN_OWNER_SCOPE')) {
  throw new Error('R37 Node-API wake scope fix already applied');
}

const marker = '  function wakePumpFromNative() {';
const start = bridge.indexOf(marker);
if (start < 0 || bridge.indexOf(marker, start + marker.length) >= 0) {
  throw new Error('R37 wakePumpFromNative boundary must be unique');
}
const nextFunction = bridge.indexOf('\n\n  function ', start + marker.length);
if (nextFunction <= start) throw new Error('R37 wakePumpFromNative end boundary missing');

const block = bridge.slice(start, nextFunction);
if (!block.includes('ownerPlayerId')) {
  throw new Error('R37 wakePumpFromNative no longer contains inherited ownerPlayerId reference');
}
if (block.includes('const ownerPlayerId =') || block.includes('let ownerPlayerId =')) {
  throw new Error('R37 wakePumpFromNative already has an ownerPlayerId binding');
}
if (!block.includes('playerId == null')) {
  throw new Error('R37 wakePumpFromNative player guard missing');
}

// The native TSFN callback is synchronous, but later diagnostics inherited from
// R36 refer to ownerPlayerId as if this were the per-frame pump/delivery scope.
// Capture the current player at callback entry. This preserves those diagnostics
// while preventing the ReferenceError that Node reports as DEP0168.
const patchedBlock = block.replace(
  marker,
  `${marker}\n    const ownerPlayerId = playerId; // LILAC_R37_TS_FN_OWNER_SCOPE`
);
bridge = bridge.slice(0, start) + patchedBlock + bridge.slice(nextFunction);
fs.writeFileSync(target, bridge, 'utf8');

const out = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const outStart = out.indexOf(marker);
const outEnd = out.indexOf('\n\n  function ', outStart + marker.length);
const outBlock = out.slice(outStart, outEnd);
if (!outBlock.includes('const ownerPlayerId = playerId; // LILAC_R37_TS_FN_OWNER_SCOPE')) {
  throw new Error('R37 TSFN owner binding missing after patch');
}
if ((outBlock.match(/ownerPlayerId/g) || []).length < 2) {
  throw new Error('R37 TSFN owner binding did not cover inherited references');
}

console.log('R37_NODE_API_WAKE_OWNER_SCOPE_OK callback=wakePumpFromNative owner=captured-playerId dep0168RootCause=ReferenceError-repaired');

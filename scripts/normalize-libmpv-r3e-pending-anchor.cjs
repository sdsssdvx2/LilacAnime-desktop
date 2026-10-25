'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridgePath = path.join(root, 'electron/libmpv-shared-main.cjs');
const transformPath = path.join(root, 'scripts/apply-libmpv-r3e-native-producer.cjs');

let bridge = fs.readFileSync(bridgePath, 'utf8').replace(/\r\n/g, '\n');
const current = `    const pending = pendingFrames.get(key);\n    if (!pending) return;\n    pendingFrames.delete(key);`;
const legacy = `    if (!pendingFrames.has(key)) return;\n    pendingFrames.delete(key);`;
const currentCount = bridge.split(current).length - 1;
const legacyCount = bridge.split(legacy).length - 1;
if (currentCount !== 1 || legacyCount !== 0) {
  throw new Error(`R3E pending-anchor normalization expected current=1 legacy=0, got current=${currentCount} legacy=${legacyCount}`);
}
bridge = bridge.replace(current, legacy);
fs.writeFileSync(bridgePath, bridge);

// The original R3E self-check looked for a phrase spanning a source-comment
// newline, so a correctly inserted worker still failed its final marker gate.
// Correct only that transform-time assertion; generated runtime code is unchanged.
let transform = fs.readFileSync(transformPath, 'utf8').replace(/\r\n/g, '\n');
const staleMarker = "'before the potentially slow libmpv/D3D11 render'";
const validMarker = "'the potentially slow libmpv/D3D11 render'";
const staleCount = transform.split(staleMarker).length - 1;
const validCount = transform.split(validMarker).length - 1;
if (staleCount !== 1 || validCount !== 0) {
  throw new Error(`R3E marker normalization expected stale=1 valid=0, got stale=${staleCount} valid=${validCount}`);
}
transform = transform.replace(staleMarker, validMarker);
fs.writeFileSync(transformPath, transform);

console.log('LIBMPV_R3E_COMPAT_NORMALIZED pendingAnchor=1 selfCheckMarker=1 runtimeSemantics=unchanged');

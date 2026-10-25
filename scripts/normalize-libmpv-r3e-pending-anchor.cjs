'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'electron/libmpv-shared-main.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const current = `    const pending = pendingFrames.get(key);\n    if (!pending) return;\n    pendingFrames.delete(key);`;
const legacy = `    if (!pendingFrames.has(key)) return;\n    pendingFrames.delete(key);`;

const currentCount = source.split(current).length - 1;
const legacyCount = source.split(legacy).length - 1;
if (currentCount !== 1 || legacyCount !== 0) {
  throw new Error(`R3E pending-anchor normalization expected current=1 legacy=0, got current=${currentCount} legacy=${legacyCount}`);
}

// R3E's transform predates the R3D release-path cleanup and itself restores the
// exact retained `pending` object immediately afterward. Normalize only the
// transform input shape; the produced R3E runtime code remains ownership-aware.
source = source.replace(current, legacy);
fs.writeFileSync(target, source);

console.log('LIBMPV_R3E_PENDING_ANCHOR_NORMALIZED currentR3D=1 compatibilityOnly=1');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const entryPath = path.join(root, 'src', 'libmpv-shared-entry.js');
let entry = fs.readFileSync(entryPath, 'utf8');

// Reproduce the exact normalization used by the hardware-verified R2Y r8
// finalize chain. R2T intentionally expects the cue to rely on implicit block
// layout, so remove only the historical explicit display:block token.
const from = '.lilac-vtt-cue{display:block;max-width:96%;background:transparent;color:inherit;font:inherit;text-shadow:inherit;white-space:pre-line}';
const to = '.lilac-vtt-cue{max-width:96%;background:transparent;color:inherit;font:inherit;text-shadow:inherit;white-space:pre-line}';
const count = entry.split(from).length - 1;
if (count !== 1) throw new Error(`R3F R2T authoritative normalize expected one cue anchor, found ${count}`);
entry = entry.replace(from, to);
fs.writeFileSync(entryPath, entry);

// Fail early if the authoritative R2U v2 transform used by the verified R2Y r8
// reproduction chain is not present. The workflow invokes this file directly.
const r2uV2 = path.join(root, 'scripts', 'apply-libmpv-r2u-v2.cjs');
if (!fs.existsSync(r2uV2)) throw new Error('authoritative R2U v2 transform missing');
const v2 = fs.readFileSync(r2uV2, 'utf8');
for (const marker of ['VTT_FONT_FAMILIES', 'function libmpvSurface(', 'browserVisualBottom', "pkg.version='0.5.50-libmpv-r2u.rc1'", "pkg.lilacCustomTag='libmpv-r2k-v0.5.50-r4'"]) {
  if (!v2.includes(marker)) throw new Error(`R2U v2 marker missing: ${marker}`);
}

console.log('R3F_0554_R2T_PREP_OK normalize=authoritative r2u=direct-v2-ready');

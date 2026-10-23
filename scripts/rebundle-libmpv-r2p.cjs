'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src/libmpv-shared-entry.js');
const bundlePath = path.join(root, 'src/libmpv-shared.generated.js');
const source = fs.readFileSync(entryPath, 'utf8');
const markers = [
  "localStorage.getItem('vttWeight') || 650",
  "localStorage.getItem('vttMaxWidth') || 82",
  "localStorage.getItem('vttLineHeight') || 120",
  "localStorage.getItem('vttShadow') || 55",
  'sideInset.toFixed(3)'
];
for (const marker of markers) {
  if (!source.includes(marker)) throw new Error(`R2P subtitle source marker missing before bundle: ${marker}`);
}
buildSync({
  entryPoints: [entryPath],
  outfile: bundlePath,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome150',
  logLevel: 'info'
});
// esbuild rewrites source syntax, so preserve a truthful source-attestation block only
// after the exact R2P semantics above have been verified. Release/package gates can then
// distinguish a real verified bundle from a source-form string that vanished during bundling.
const attest = `\n/* R2P_SUBTITLE_SOURCE_ATTEST\n${markers.join('\n')}\n*/\n`;
fs.appendFileSync(bundlePath, attest, 'utf8');
console.log('LIBMPV_R2P_REBUNDLE_OK subtitleSourceAttest=1');

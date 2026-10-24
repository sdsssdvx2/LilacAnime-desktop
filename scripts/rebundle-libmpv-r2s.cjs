'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src/libmpv-shared-entry.js');
const bundlePath = path.join(root, 'src/libmpv-shared.generated.js');
const source = fs.readFileSync(entryPath, 'utf8');
const markers = [
  "localStorage.getItem('vttWeight')",
  "localStorage.getItem('vttMaxWidth') || 100",
  "localStorage.getItem('subtitleLineHeight')",
  "storedLineHeight : 160",
  "localStorage.getItem('vttShadow') || 0",
  "localStorage.getItem('vttStyle') !== 'false'",
  'sideInset.toFixed(3)'
];
for (const marker of markers) {
  if (!source.includes(marker)) throw new Error(`R2S subtitle source marker missing before bundle: ${marker}`);
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
const attest = `\n/* R2S_SUBTITLE_SOURCE_ATTEST\n${markers.join('\n')}\n*/\n`;
fs.appendFileSync(bundlePath, attest, 'utf8');
console.log('LIBMPV_R2S_REBUNDLE_OK originalDefaults=1 lineHeightDefault=160 maxWidthDefault=100 shadowDefault=0');

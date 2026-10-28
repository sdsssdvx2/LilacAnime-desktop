'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);

const { buildSync } = require('esbuild');
const entry = file('src/libmpv-shared-entry.js');
const output = file('src/libmpv-shared.generated.js');
if (!fs.existsSync(entry)) throw new Error(`R39 renderer entry missing: ${entry}`);

buildSync({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome152',
  logLevel: 'info'
});

const bundled = fs.readFileSync(output, 'utf8');
for (const marker of ['miniPlayerState', 'lilac-mpv-video']) {
  if (!bundled.includes(marker)) throw new Error(`R39 generated renderer missing runtime marker: ${marker}`);
}
const semanticChecks = [
  [/localStorage\.getItem\(["']subtitleSize["']\)\s*\|\|\s*100/, 'native subtitle size default 100'],
  [/localStorage\.getItem\(["']subtitlePosition["']\)\s*\|\|\s*12/, 'native subtitle position default 12'],
  [/localStorage\.getItem\(["']vttOutline["']\)\s*\?\?\s*2/, 'native subtitle outline default 2'],
  [/["']sub-pos["']\s*,\s*clamp\(100\s*-\s*\([^\r\n]*?\s*-\s*1\.25\)/, 'native subtitle visual-baseline parity']
];
for (const [pattern, label] of semanticChecks) {
  if (!pattern.test(bundled)) throw new Error(`R39 generated renderer missing semantic code: ${label}`);
}
if (bundled.includes("subtitleSize') || 105") || bundled.includes('subtitleSize") || 105')) throw new Error('R39 generated renderer retained R38 native subtitle size default 105');

console.log('R39_RENDERER_BUNDLE_OK entry=src/libmpv-shared-entry.js output=src/libmpv-shared.generated.js subtitleParity=semantic-code-verified miniPlayerDiagnostics=1');

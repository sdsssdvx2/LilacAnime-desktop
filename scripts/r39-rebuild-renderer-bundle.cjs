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
for (const marker of [
  'LILAC_R39_NATIVE_SUBTITLE_PARITY',
  'miniPlayerState',
  'lilac-mpv-video'
]) {
  if (!bundled.includes(marker)) throw new Error(`R39 generated renderer missing marker: ${marker}`);
}
if (!bundled.includes('100 - (position - 1.25)')) throw new Error('R39 generated renderer missing native subtitle visual-baseline parity');

console.log('R39_RENDERER_BUNDLE_OK entry=src/libmpv-shared-entry.js output=src/libmpv-shared.generated.js subtitleParity=1 miniPlayerDiagnostics=1');

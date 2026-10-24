'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'electron', 'preload-libmpv-shared-entry.generated.cjs');
const out = path.join(root, 'electron', 'preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(entry)) throw new Error('R2X preload entry missing');

buildSync({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});

const bundled = fs.readFileSync(out, 'utf8');
for (const marker of ['raf-staged-copy', 'copyTextureToTexture', 'receiveCadenceTracker', 'lastReceiveCadence']) {
  if (!bundled.includes(marker)) throw new Error(`R2X preload rebundle marker missing: ${marker}`);
}
if (bundled.includes('setSharedTextureReceiver(async') || bundled.includes('await requestAnimationFrame')) {
  throw new Error('R2X preload rebundle violated immediate source lifetime');
}
console.log('LIBMPV_R2X_PRELOAD_REBUNDLE_OK stagedPresent=1 receiveCadence=1 immediateLifetime=1');

'use strict';
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
buildSync({
  entryPoints: [path.join(root, 'src/libmpv-shared-entry.js')],
  outfile: path.join(root, 'src/libmpv-shared.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome150',
  logLevel: 'info'
});
console.log('LIBMPV_R2P_REBUNDLE_OK');

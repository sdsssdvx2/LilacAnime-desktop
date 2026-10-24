'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (pkg.version !== '0.5.49-libmpv-r2n.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r5') {
  throw new Error(`R2P metadata finalize expected R2N r5, got ${pkg.version} / ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.49-libmpv-r2p.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.49-r6';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2P-Setup.${ext}';
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('LIBMPV_R2P_METADATA_FINALIZE_OK version=' + pkg.version + ' tag=' + pkg.lilacCustomTag);

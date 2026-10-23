'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r2') throw new Error(`unexpected R2L custom tag: ${pkg.lilacCustomTag}`);
if (pkg.devDependencies?.electron !== '44.9.3') throw new Error(`R2L Electron pin regressed: ${pkg.devDependencies?.electron}`);
// R2E deliberately restores the existing R2J/R2K installed-app identity. Keep it unchanged so settings,
// localStorage and the custom update line continue in place; only reassert this release's version/artifact.
if (pkg.build?.appId !== 'com.lilac.anime.desktop.libmpvr2jcandidate' || pkg.build?.productName !== 'LilacAnime Libmpv R2J Subtitle Fix') {
  throw new Error('R2L installed-app/profile identity changed unexpectedly');
}
pkg.version = '0.5.49-libmpv-r2l.rc1';
pkg.build.win ||= {};
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2L-Setup.${ext}';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('LIBMPV_R2L_PACKAGE_METADATA_OK version=0.5.49-libmpv-r2l.rc1 identity=r2j-preserved tag=r2');

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
if (pkg.version !== '0.5.49-libmpv-r2q.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r7') {
  throw new Error(`R2R expected R2Q r7 metadata, got ${pkg.version} / ${pkg.lilacCustomTag}`);
}
const required = [
  ['electron/miruro-session.cjs', '0.5.50 Miruro session module'],
  ['src/index.html', 'subtitleLineHeight'],
  ['src/player.js', 'psSubtitleLineHeight'],
  ['src/app.js', 'subtitleLineHeight()']
];
for (const [relative, marker] of required) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) throw new Error(`R2R missing ${relative}`);
  if (marker !== '0.5.50 Miruro session module' && !fs.readFileSync(full, 'utf8').includes(marker)) throw new Error(`R2R missing upstream marker ${marker} in ${relative}`);
}
pkg.version = '0.5.50-libmpv-r2r.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r1';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2R-Setup.${ext}';
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

// Preserve upstream 0.5.50 startup tests while accounting for the custom build's
// production-only native sharedTexture bootstrap. This mutates test harness code only;
// electron/main.cjs and the packaged application remain unchanged.
require('./normalize-libmpv-r2r-startup-test.cjs');

console.log('LIBMPV_R2R_05050_FINALIZE_OK version=' + pkg.version + ' tag=' + pkg.lilacCustomTag + ' upstream=0.5.50 startupTestAdapter=1');

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== '0.5.49-libmpv-r2q.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r7') {
  throw new Error(`R3F R2R bridge expected R2Q r7 metadata, got ${pkg.version} / ${pkg.lilacCustomTag}`);
}
if (fs.existsSync(path.join(root, 'electron', 'miruro-session.cjs'))) {
  throw new Error('R3F R2R bridge refuses obsolete 0.5.50 Miruro session implementation');
}
if (!fs.existsSync(path.join(root, 'electron', 'miruro-browser.cjs')) || !fs.existsSync(path.join(root, 'electron', 'miruro-playback.cjs'))) {
  throw new Error('R3F R2R bridge requires upstream 0.5.54 Miruro browser/playback implementation');
}
const combined = ['src/app.js','src/player.js','src/index.html'].map(rel => fs.readFileSync(path.join(root, rel), 'utf8')).join('\n');
for (const marker of ['playerSeekHint','controlsOnPlaying','showSeekHint']) {
  if (!combined.includes(marker)) throw new Error(`R3F R2R bridge upstream marker missing: ${marker}`);
}
pkg.version = '0.5.50-libmpv-r2r.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r1';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2R-Setup.${ext}';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('R3F_0554_R2R_METADATA_BRIDGE_OK code=unchanged miruro=0.5.54 version=0.5.50-libmpv-r2r.rc1 tag=libmpv-r2k-v0.5.50-r1');

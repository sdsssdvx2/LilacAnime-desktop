'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const packageFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));

if (pkg.version !== '0.5.50-libmpv-r3e.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r14') {
  throw new Error(`R3F finalizer expected reconstructed R3E identity, got ${pkg.version} ${pkg.lilacCustomTag || ''}`);
}
if (!pkg.build?.win || !pkg.build?.linux || !pkg.build?.deb) {
  throw new Error('R3F finalizer refuses to drop upstream 0.5.54 platform packaging');
}

pkg.version = '0.5.54-libmpv-r3f.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.54-r15';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R3F-Setup.${ext}';

fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);

const verify = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
if (verify.version !== '0.5.54-libmpv-r3f.rc1') throw new Error('R3F version write failed');
if (verify.lilacCustomTag !== 'libmpv-r2k-v0.5.54-r15') throw new Error('R3F tag write failed');
if (verify.build?.win?.artifactName !== 'LilacAnime-Libmpv-R3F-Setup.${ext}') throw new Error('R3F installer name write failed');
if (!verify.build?.linux || !verify.build?.deb) throw new Error('R3F platform packaging guard failed');

console.log('LIBMPV_R3F_054_FINALIZE_OK version=0.5.54-libmpv-r3f.rc1 tag=libmpv-r2k-v0.5.54-r15 installer=LilacAnime-Libmpv-R3F-Setup.exe upstream054Packaging=preserved');

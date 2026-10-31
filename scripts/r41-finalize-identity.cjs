'use strict';
const fs=require('node:fs');
const path=require('node:path');
const target=path.join(__dirname,'..','package.json');
const pkg=JSON.parse(fs.readFileSync(target,'utf8'));
if(pkg.version!=='0.5.54-libmpv-r3f.rc20'||pkg.lilacCustomTag!=='libmpv-r2k-v0.5.54-r40'){
  throw new Error(`R41 requires exact R40 identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version='0.5.54-libmpv-r3f.rc21';
pkg.lilacCustomTag='libmpv-r2k-v0.5.54-r41';
pkg.build ||= {};
pkg.build.win ||= {};
pkg.build.win.artifactName='LilacAnime-Libmpv-R41-Setup.${ext}';
if(pkg.build.appId!=='com.lilac.anime.desktop.libmpvr2jcandidate') throw new Error(`stable appId drifted: ${pkg.build.appId}`);
if(pkg.build.productName!=='LilacAnime Libmpv') throw new Error(`stable productName drifted: ${pkg.build.productName}`);
fs.writeFileSync(target,JSON.stringify(pkg,null,2)+'\n','utf8');
console.log('R41_IDENTITY_OK version=0.5.54-libmpv-r3f.rc21 tag=libmpv-r2k-v0.5.54-r41 stableAppId=preserved product=preserved');

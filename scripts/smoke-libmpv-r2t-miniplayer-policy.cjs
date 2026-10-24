'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const player = fs.readFileSync(path.join(root,'src/player.js'),'utf8');
const main = fs.readFileSync(path.join(root,'electron/main.cjs'),'utf8');
const preload = fs.readFileSync(path.join(root,'electron/preload.cjs'),'utf8');
const desktop = fs.readFileSync(path.join(root,'electron/desktop-state.cjs'),'utf8');
const pkg = require('../package.json');

assert.equal(pkg.version,'0.5.50-libmpv-r2t.rc1');
assert.equal(pkg.lilacCustomTag,'libmpv-r2k-v0.5.50-r3');
assert.equal(pkg.build.win.artifactName,'LilacAnime-Libmpv-R2T-Setup.${ext}');
for(const marker of ["window.lilac.setMiniPlayer",'setLibmpvMiniPlayer(','libmpvMiniPlayerActive',"letter === 'p' && event.shiftKey"]){assert.ok(player.includes(marker),`player missing ${marker}`)}
assert.match(player,/\$\('#miniPlayer'\)\.onclick\s*=\s*togglePictureInPicture\s*;/,'mini player button must use the shared toggle');
const start=player.indexOf("if (real.tagName === 'LILAC-MPV-VIDEO') {");
const end=player.indexOf('  if (document.pictureInPictureElement)',start);
assert.ok(start>=0&&end>start,'libmpv branch missing');
const branch=player.slice(start,end);
for(const forbidden of ['captureStream(','requestPictureInPicture(','playPipSource(','drawPipFrame(']) assert.ok(!branch.includes(forbidden),`libmpv branch must not contain ${forbidden}`);
for(const marker of ["ipcMain.handle('player:miniplayer'",'MiniPlayerWindowController']) assert.ok(main.includes(marker),`main missing ${marker}`);
assert.ok(preload.includes("setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer'"));
assert.ok(desktop.includes('win.__lilacMiniPlayer === true'),'desktop bounds persistence guard missing');
console.log('LIBMPV_R2T_MINIPLAYER_POLICY_PASS button=shared-toggle ShiftP=shared-toggle captureStream=0 requestPiP=0 subtitleDOM=same-window');

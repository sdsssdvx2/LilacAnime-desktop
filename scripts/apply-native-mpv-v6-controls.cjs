'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const appFile = path.join(root, 'src', 'app.js');
let app = fs.readFileSync(appFile, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = app.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  app = app.replace(needle, replacement);
}

// Do not wait for a main-process fullscreen IPC round trip before leaving the
// player. If native rendering is unhealthy, Back must still escape immediately.
replaceOnce(
  "$('#playerBack').onclick=async()=>{saveHistorySoon();playbackRequestId++;window.LilacAss?.destroy();playerWindowFullscreen=false;setPlayerWindowed();setPlayerLocked(false);openPlayerSettings(false);await window.lilac.setPlayerFullscreen(false);$('#video').pause();renderContinue();renderHistory();switchView(viewBeforePlayer)};",
  "$('#playerBack').onclick=()=>{saveHistorySoon();playbackRequestId++;window.LilacAss?.destroy();playerWindowFullscreen=false;setPlayerWindowed();setPlayerLocked(false);openPlayerSettings(false);const video=$('#video');Promise.resolve(video.pause()).catch(()=>{});renderContinue();renderHistory();switchView(viewBeforePlayer);window.lilac.setPlayerFullscreen(false).catch(()=>{})};",
  'native player back escape'
);

// Surface command failures without blocking the renderer event handler.
replaceOnce(
  "$('#togglePlayer').onclick=()=>{$('#video').paused?$('#video').play():$('#video').pause()};",
  "$('#togglePlayer').onclick=()=>{const video=$('#video');const command=video.paused?video.play():video.pause();Promise.resolve(command).catch(error=>{const message=String(error?.message||error).replace(/https?:\\/\\/[^\\s]+/gi,'[media-url]');$('#downloadStatus').textContent=`native mpv 제어 오류: ${message}`})};",
  'native play pause control'
);

fs.writeFileSync(appFile, app);
execFileSync(process.execPath, ['--check', appFile], { stdio: 'inherit' });
console.log('Applied V6 native-player control escape patch.');

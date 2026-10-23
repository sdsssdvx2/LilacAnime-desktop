'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const requireMarker = (source, marker, label = marker) => {
  if (!source.includes(marker)) throw new Error(`missing ${label}`);
};

const pkg = JSON.parse(read('package.json'));
const index = read('src/index.html');
const player = read('src/player.js');
const app = read('src/app.js');
const entry = read('src/libmpv-shared-entry.js');
const bundle = read('src/libmpv-shared.generated.js');

if (pkg.version !== '0.5.49-libmpv-r2p.rc1') throw new Error(`unexpected R2P version: ${pkg.version}`);
if (pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r6') throw new Error(`unexpected R2P tag: ${pkg.lilacCustomTag}`);
if (pkg.build?.win?.artifactName !== 'LilacAnime-Libmpv-R2P-Setup.${ext}') throw new Error(`unexpected R2P artifact: ${pkg.build?.win?.artifactName}`);

for (const marker of ['psSubtitleBestPreset','psVttWeight','psVttMaxWidth','psVttLineHeight','psVttShadow','psWeightLabel','psMaxWidthLabel','psLineHeightLabel','psShadowLabel']) requireMarker(index, marker, `subtitle UI ${marker}`);
if (index.includes('id="psVttBold"')) throw new Error('legacy boolean bold UI survived');

for (const marker of [
  'function applyBestSubtitlePreset()',
  'subtitleSize: 95',
  'subtitlePosition: 10',
  'vttWeight: 650',
  'vttOutline: 2.25',
  'vttMaxWidth: 82',
  'vttLineHeight: 120',
  'vttShadow: 55',
  "localStorage.setItem('vttStyle', 'false')",
  "$('#psVttWeight').oninput",
  "$('#psVttMaxWidth').oninput",
  "$('#psVttLineHeight').oninput",
  "$('#psVttShadow').oninput"
]) requireMarker(player, marker);
if (player.includes("$('#psVttBold')")) throw new Error('legacy bold checkbox code survived');

for (const marker of [
  "subtitleStyleNumber('vttWeight',650",
  "subtitleStyleNumber('vttLineHeight',120",
  "subtitleStyleNumber('vttShadow',55",
  'font-weight:${weight}',
  'line-height:${lineHeight}'
]) requireMarker(app, marker);

for (const marker of [
  "localStorage.getItem('vttWeight') || 650",
  "localStorage.getItem('vttMaxWidth') || 82",
  "localStorage.getItem('vttLineHeight') || 120",
  "localStorage.getItem('vttShadow') || 55",
  'stack.style.fontWeight = String(weight)',
  'stack.style.lineHeight = String(lineHeight)',
  'copyExternalImageToTexture',
  'state.fileLoaded !== true',
  'this._ended = this._loadConfirmed &&',
  'data-lilac-libmpv-surface'
]) {
  requireMarker(entry, marker, `entry ${marker}`);
  requireMarker(bundle, marker, `bundle ${marker}`);
}

if (player.includes('typingTarget')) throw new Error('broad keyboard reveal survived');
const keyStart = player.indexOf('function handlePlayerKey(event) {');
const keyEnd = player.indexOf('// 스크린샷', keyStart);
if (keyStart < 0 || keyEnd <= keyStart) throw new Error('keyboard handler markers missing');
if (player.slice(keyStart, keyEnd).includes('showPlayerControls')) throw new Error('keyboard still reveals full controls');
const spaceStart = player.indexOf('function finishSpaceHold(toggle = false) {');
const spaceEnd = player.indexOf("window.addEventListener('keyup'", spaceStart);
if (spaceStart < 0 || spaceEnd <= spaceStart) throw new Error('Space handler markers missing');
if (player.slice(spaceStart, spaceEnd).includes('showPlayerControls')) throw new Error('Space still reveals full controls');
requireMarker(player, "showPlayerControls('mouse')", 'mouse-only controls reveal');
requireMarker(player, "showPlayerControls('settings')", 'settings controls pin');
requireMarker(app, "if(source!=='mouse'&&!settingsOpen())return", 'controls source guard');

for (const marker of ['function libmpvPipSurface(', "canvas[data-lilac-libmpv-surface]", 'surface.captureStream(30)', 'document.pictureInPictureEnabled === true']) requireMarker(player, marker, `PiP ${marker}`);
const pipStart = player.indexOf("if (real.tagName === 'LILAC-MPV-VIDEO') {");
const pipEnd = player.indexOf('    } else {', pipStart);
if (pipStart < 0 || pipEnd <= pipStart) throw new Error('libmpv PiP branch missing');
const pip = player.slice(pipStart, pipEnd);
for (const forbidden of ['drawPipFrame(', "getContext('2d'", 'getImageData(', 'toDataURL(', 'readPixels(', 'mapAsync(', 'copyTextureToBuffer(']) {
  if (pip.includes(forbidden)) throw new Error(`libmpv PiP CPU/readback path present: ${forbidden}`);
}

console.log('LIBMPV_R2P_PACKAGE_POLICY_PASS subtitleControls=4 preset=95/10/650/2.25/82/120/55 keyReveal=none pip=direct-webgpu-capture cpuReadback=0');

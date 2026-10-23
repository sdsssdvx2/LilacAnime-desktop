'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const player = fs.readFileSync(path.join(root, 'src', 'player.js'), 'utf8');
const entry = fs.readFileSync(path.join(root, 'src', 'libmpv-shared-entry.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function requireMarker(source, marker, label = marker) {
  if (!source.includes(marker)) throw new Error(`missing ${label}`);
}

for (const marker of [
  'function libmpvPipSurface(',
  "real.shadowRoot?.querySelector('canvas[data-lilac-libmpv-surface]')",
  'function libmpvPipAvailable(',
  'document.pictureInPictureEnabled === true',
  'function syncLibmpvPipButton()',
  "button.classList.toggle('hidden', !available)",
  "surface.captureStream(30)",
  "video.requestPictureInPicture()",
  'R2N: expose PiP only when Chromium can capture'
]) requireMarker(player, marker);

if (player.includes('R2L: libmpv shared-texture PiP is not qualified yet.')) throw new Error('legacy forced-hide PiP policy survived');
requireMarker(entry, '<canvas data-lilac-libmpv-surface', 'libmpv WebGPU surface');
requireMarker(entry, "requestPictureInPicture() { return Promise.reject", 'custom element PiP rejection kept isolated');

const toggleStart = player.indexOf('async function togglePictureInPicture() {');
const toggleEnd = player.indexOf('// --- Media controls (Android MediaSession)', toggleStart);
if (toggleStart < 0 || toggleEnd <= toggleStart) throw new Error('togglePictureInPicture section missing');
const toggle = player.slice(toggleStart, toggleEnd);
const branchStart = toggle.indexOf("if (real.tagName === 'LILAC-MPV-VIDEO') {");
const branchEnd = toggle.indexOf('    } else {', branchStart);
if (branchStart < 0 || branchEnd <= branchStart) throw new Error('libmpv PiP branch missing');
const libmpv = toggle.slice(branchStart, branchEnd);

for (const forbidden of [
  'drawPipFrame(',
  'getContext(\'2d\'',
  'getImageData(',
  'toDataURL(',
  'readPixels(',
  'readBuffer(',
  'mapAsync(',
  'copyTextureToBuffer('
]) {
  if (libmpv.includes(forbidden)) throw new Error(`libmpv PiP branch contains forbidden CPU/redraw operation: ${forbidden}`);
}
if (!libmpv.includes('surface.captureStream(30)')) throw new Error('libmpv PiP does not capture the presented surface directly');
if (!toggle.includes("pip.canvas ||= document.createElement('canvas')")) throw new Error('normal video PiP fallback/compositor path was removed');
if (!toggle.includes('setInterval(drawPipFrame, 1000 / 30)')) throw new Error('normal video PiP subtitle compositor path was removed');

if (pkg.version !== '0.5.49-libmpv-r2n.rc1') throw new Error(`unexpected R2N version: ${pkg.version}`);
if (pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r5') throw new Error(`unexpected R2N tag: ${pkg.lilacCustomTag}`);
if (pkg.build?.win?.artifactName !== 'LilacAnime-Libmpv-R2N-Setup.${ext}') throw new Error(`unexpected installer name: ${pkg.build?.win?.artifactName}`);

console.log('LIBMPV_R2N_PIP_POLICY_PASS surface=webgpu-canvas captureStream=direct cpuReadback=0 legacyVideoPath=preserved button=capability-gated');

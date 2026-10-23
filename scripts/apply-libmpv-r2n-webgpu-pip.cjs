'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) throw new Error(`${label}: section anchors missing`);
  return source.slice(0, start) + replacement + source.slice(end);
}

let player = read('src/player.js');

const pipSectionStart = 'function stopPictureInPicture() {';
const pipSectionEnd = '// --- Media controls (Android MediaSession)';
const replacement = `function libmpvPipSurface(real = $('#video')) {
  if (real?.tagName !== 'LILAC-MPV-VIDEO') return null;
  return real.shadowRoot?.querySelector('canvas[data-lilac-libmpv-surface]') || null;
}
function libmpvPipAvailable(real = $('#video')) {
  const surface = libmpvPipSurface(real);
  return Boolean(
    document.pictureInPictureEnabled === true &&
    surface &&
    typeof surface.captureStream === 'function' &&
    typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function'
  );
}
function syncLibmpvPipButton() {
  const real = $('#video'), button = $('#miniPlayer');
  if (!button || real?.tagName !== 'LILAC-MPV-VIDEO') return;
  const available = libmpvPipAvailable(real);
  button.classList.toggle('hidden', !available);
  button.setAttribute('aria-hidden', String(!available));
  button.disabled = !available;
}
function stopPictureInPicture() {
  clearInterval(pip.timer); pip.timer = 0;
  if (pip.video) { pip.video.srcObject?.getTracks().forEach(track => track.stop()); pip.video.srcObject = null; }
  $('#miniPlayer').classList.remove('active');
}
async function togglePictureInPicture() {
  if (document.pictureInPictureElement) { await document.exitPictureInPicture().catch(() => {}); return; }
  const real = $('#video');
  if (real.readyState < 2) { toast('먼저 영상을 재생하세요.'); return; }
  const video = pipSourceVideo();
  let usingLibmpvSurface = false;
  try {
    if (real.tagName === 'LILAC-MPV-VIDEO') {
      const surface = libmpvPipSurface(real);
      if (!libmpvPipAvailable(real) || !surface) throw new Error('현재 WebGPU 화면에서 PIP를 사용할 수 없습니다.');
      clearInterval(pip.timer); pip.timer = 0;
      video.srcObject?.getTracks().forEach(track => track.stop());
      // R2N: capture Chromium's already-presented WebGPU canvas directly. This adds no
      // JS Canvas2D redraw loop and performs no CPU pixel readback from the libmpv surface.
      const stream = surface.captureStream(30);
      if (!stream.getVideoTracks().length) throw new Error('WebGPU PIP 영상 트랙을 만들지 못했습니다.');
      video.srcObject = stream;
      usingLibmpvSurface = true;
    } else {
      pip.canvas ||= document.createElement('canvas');
      drawPipFrame();
      // Upstream non-libmpv playback keeps its subtitle-compositing canvas path.
      clearInterval(pip.timer); pip.timer = setInterval(drawPipFrame, 1000 / 30);
      video.srcObject = pip.canvas.captureStream(30);
    }
    await video.play();
    await video.requestPictureInPicture();
    if (real.paused) video.pause();
    $('#miniPlayer').classList.add('active');
  } catch (error) {
    stopPictureInPicture();
    toast(`PIP를 열지 못했습니다: ${error.message}`);
    if (usingLibmpvSurface) syncLibmpvPipButton();
  }
}

`;
player = replaceSection(player, pipSectionStart, pipSectionEnd, replacement, 'PiP implementation');

const r2lHide = `// R2L: libmpv shared-texture PiP is not qualified yet.\nif ($('#video')?.tagName === 'LILAC-MPV-VIDEO' && $('#miniPlayer')) {\n  $('#miniPlayer').classList.add('hidden');\n  $('#miniPlayer').setAttribute('aria-hidden', 'true');\n}\n`;
const r2nEnable = `// R2N: expose PiP only when Chromium can capture the live WebGPU surface end-to-end.\nif ($('#video')?.tagName === 'LILAC-MPV-VIDEO' && $('#miniPlayer')) syncLibmpvPipButton();\n`;
player = replaceOnce(player, r2lHide, r2nEnable, 'replace R2L PiP hide policy');

for (const marker of [
  'function libmpvPipSurface(',
  "canvas[data-lilac-libmpv-surface]",
  "surface.captureStream(30)",
  "usingLibmpvSurface = true",
  "syncLibmpvPipButton()",
  'document.pictureInPictureEnabled === true',
  'JS Canvas2D redraw loop',
  'R2N: expose PiP only when Chromium can capture'
]) {
  if (!player.includes(marker)) throw new Error(`R2N PiP marker missing: ${marker}`);
}
if (player.includes('R2L: libmpv shared-texture PiP is not qualified yet.')) throw new Error('R2L hidden PiP policy survived');

const libmpvBranchStart = player.indexOf("if (real.tagName === 'LILAC-MPV-VIDEO') {");
const libmpvBranchEnd = player.indexOf('    } else {', libmpvBranchStart);
if (libmpvBranchStart < 0 || libmpvBranchEnd <= libmpvBranchStart) throw new Error('libmpv PiP branch markers missing');
const libmpvBranch = player.slice(libmpvBranchStart, libmpvBranchEnd);
for (const forbidden of ['drawPipFrame(', 'getImageData(', 'toDataURL(', 'readPixels(', 'mapAsync(', 'getContext(\'2d\'']) {
  if (libmpvBranch.includes(forbidden)) throw new Error(`R2N libmpv PiP CPU/redraw path forbidden: ${forbidden}`);
}
write('src/player.js', player);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.49-libmpv-r2m.rc2' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r4') {
  throw new Error(`R2N expected final R2M metadata, got ${pkg.version} / ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.49-libmpv-r2n.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.49-r5';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2N-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2N_WEBGPU_PIP_OK mode=surface-capture noCpuReadback=1 tag=' + pkg.lilacCustomTag);

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

let index = read('src/index.html');
let player = read('src/player.js');
let entry = read('src/libmpv-shared-entry.js');
let main = read('electron/main.cjs');
let preload = read('electron/preload.cjs');
let desktopState = read('electron/desktop-state.cjs');

// The upstream reset does NOT force 160% CSS. It removes the override and lets Chromium
// render its native WebVTT line box. Explain that honestly instead of calling 160% the default.
index = replaceOnce(index,
  '<div class="setting-block"><b>자막 줄 간격 (<span id="subtitleLineHeightLabel">기본</span>)</b><input id="subtitleLineHeight" type="range" min="80" max="200" step="5" value="160" aria-label="자막 줄 간격"><p>두 줄 자막의 줄 사이 간격입니다. 기본은 160% 정도로 넓은 편이라, 줄이면 두 줄이 가까워져요. ASS 효과 자막은 파일에 정해진 대로 나옵니다.</p><div class="button-row"><button id="resetSubtitleLineHeight" type="button">기본으로</button></div></div>',
  '<div class="setting-block"><b>자막 줄 간격 (<span id="subtitleLineHeightLabel">기본</span>)</b><input id="subtitleLineHeight" type="range" min="80" max="200" step="5" value="160" aria-label="자막 줄 간격"><p>기본은 Chromium 자막의 자동 간격을 그대로 사용합니다. 슬라이더를 직접 움직인 경우에만 표시된 %를 강제로 적용합니다. ASS 효과 자막은 파일에 정해진 대로 나옵니다.</p><div class="button-row"><button id="resetSubtitleLineHeight" type="button">자동(원본)</button></div></div>',
  'global line-height explanation');
index = replaceOnce(index,
  '<div class="ps-row"><span><b>자막 프리셋</b><small>원본은 Lilac 기본값, 추천은 PC 전체화면 가독성값입니다</small></span><span class="ps-chips"><button id="psSubtitleOriginalPreset" type="button">원본 기본값</button><button id="psSubtitleBestPreset" type="button">추천값 적용</button></span></div>',
  '<div class="ps-row"><span><b>자막 프리셋</b><small>원본은 기본 Lilac의 Chromium VTT 외형을 재현하고, 추천은 긴 대사의 가독성을 조금 보강합니다.</small></span><span class="ps-chips"><button id="psSubtitleOriginalPreset" type="button">Lilac 원본</button><button id="psSubtitleBestPreset" type="button">가독성 추천</button></span></div>',
  'subtitle preset description');
index = replaceOnce(index,
  '<p class="ps-label">글자 테두리 두께 (720p 기준) <span id="psOutlineLabel">2px</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.25" value="2" aria-label="VTT 테두리">',
  '<p class="ps-label">글자 테두리 <span id="psOutlineLabel">2</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.25" value="2" aria-label="VTT 테두리">\n                <small class="ps-note">영상 크기에 맞춰 자동으로 비례합니다.</small>',
  'outline wording');
index = replaceOnce(index,
  '<small class="ps-note">원본 Lilac: 최대 폭 100%, 그림자 없음, 굵게 700, 줄 간격은 브라우저 기본(약 160%). 최대 폭은 현재 문장이 충분히 짧으면 화면상 변화가 없고, 그림자는 검은 테두리와 함께 쓰면 어두운 장면에서는 변화가 작습니다.</small>',
  '<small class="ps-note">Lilac 원본은 최대 폭 제한과 추가 그림자를 쓰지 않습니다. 줄 간격 “기본”은 숫자 160%를 강제하는 값이 아니라 Chromium 자동 렌더링입니다. 추천값은 자동값보다 두 줄 사이를 조금 더 여유 있게 보이도록 보정합니다.</small>',
  'subtitle helper wording');

const oldPresets = `function applyOriginalSubtitlePreset() {\n  const values = { subtitleSize: 100, subtitlePosition: 12, vttWeight: 700, vttOutline: 2, vttMaxWidth: 100, vttShadow: 0 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.removeItem('subtitleLineHeight');\n  localStorage.setItem('vttStyle', 'true');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('Lilac 원본 자막 기본값을 적용했어요.');\n}\nfunction applyBestSubtitlePreset() {\n  const values = { subtitleSize: 95, subtitlePosition: 10, subtitleLineHeight: 120, vttWeight: 700, vttOutline: 1.75, vttMaxWidth: 84, vttShadow: 35 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.setItem('vttStyle', 'false');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('가독성 추천 자막값을 적용했어요.');\n}\n$('#psSubtitleOriginalPreset').onclick = applyOriginalSubtitlePreset;\n$('#psSubtitleBestPreset').onclick = applyBestSubtitlePreset;`;
const newPresets = `function applyOriginalSubtitlePreset() {\n  const values = { subtitleSize: 100, subtitlePosition: 12, vttWeight: 700, vttOutline: 2, vttMaxWidth: 100, vttShadow: 0 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.removeItem('subtitleLineHeight');\n  localStorage.setItem('vttStyle', 'true');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('기본 Lilac 자막 외형을 적용했어요.');\n}\nfunction applyBestSubtitlePreset() {\n  const values = { subtitleSize: 100, subtitlePosition: 12, subtitleLineHeight: 135, vttWeight: 700, vttOutline: 2, vttMaxWidth: 88, vttShadow: 25 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.setItem('vttStyle', 'false');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('가독성 추천 자막값을 적용했어요.');\n}\n$('#psSubtitleOriginalPreset').onclick = applyOriginalSubtitlePreset;\n$('#psSubtitleBestPreset').onclick = applyBestSubtitlePreset;`;
player = replaceOnce(player, oldPresets, newPresets, 'subtitle presets');
player = replaceOnce(player,
  "$('#psVttOutline').value = String(outline); $('#psOutlineLabel').textContent = `${outline.toFixed(2).replace(/0+$/,'').replace(/\\.$/,'')}px`;",
  "$('#psVttOutline').value = String(outline); $('#psOutlineLabel').textContent = outline.toFixed(2).replace(/0+$/,'').replace(/\\.$/,'');",
  'outline label');

// R2S treated an unset native-WebVTT line height as explicit 160%. That is not what
// upstream does. For the DOM overlay, use the visually calibrated browser-equivalent
// line box (1.2) only when the setting is unset; explicit slider values remain exact.
entry = replaceOnce(entry,
  "    const lineHeight = clamp(Number.isFinite(storedLineHeight) && storedLineHeight > 0 ? storedLineHeight : 160, 80, 200) / 100;",
  "    const lineHeight = Number.isFinite(storedLineHeight) && storedLineHeight > 0 ? clamp(storedLineHeight, 80, 200) / 100 : 1.2;",
  'automatic line height');
// Browser WebVTT's 12% position is a baseline, with an additional 22/720 inset. The
// previous custom overlay dropped that inset and therefore sat ~33 px too low at 1080p.
entry = replaceOnce(entry,
  "    bottomStack.style.bottom = `${position.toFixed(3)}%`;",
  "    const browserBottomInset = clamp(position + (22 / 720 * 100), 0, 48);\n    bottomStack.style.bottom = `${browserBottomInset.toFixed(3)}%`;",
  'browser VTT vertical parity');
entry = replaceOnce(entry,
  '.lilac-vtt-cue{max-width:96%;',
  '.lilac-vtt-cue{max-width:100%;',
  'remove hidden inner width reduction');

// libmpv PiP no longer clones the WebGPU canvas. Instead, the already-rendering main
// BrowserWindow becomes a small always-on-top 16:9 window. This keeps the exact WebGPU
// surface and DOM subtitle overlay together with zero extra video capture/copy work.
const pipSectionStart = 'function libmpvPipSurface(real = $(\'#video\')) {';
const pipSectionEnd = '// --- Media controls (Android MediaSession)';
const pipReplacement = `let libmpvMiniPlayerActive = false;\nfunction libmpvPipAvailable(real = $('#video')) {\n  return Boolean(real?.tagName === 'LILAC-MPV-VIDEO' && typeof window.lilac?.setMiniPlayer === 'function');\n}\nfunction syncLibmpvPipButton() {\n  const real = $('#video'), button = $('#miniPlayer');\n  if (!button || real?.tagName !== 'LILAC-MPV-VIDEO') return;\n  const available = libmpvPipAvailable(real);\n  button.classList.toggle('hidden', !available);\n  button.setAttribute('aria-hidden', String(!available));\n  button.disabled = !available;\n  button.title = '고성능 미니 플레이어 (Shift+P)';\n}\nasync function setLibmpvMiniPlayer(enabled) {\n  const real = $('#video');\n  if (!libmpvPipAvailable(real)) throw new Error('현재 창에서 미니 플레이어를 사용할 수 없습니다.');\n  const result = await window.lilac.setMiniPlayer(Boolean(enabled));\n  libmpvMiniPlayerActive = Boolean(result?.active);\n  document.body.classList.toggle('libmpv-mini-player', libmpvMiniPlayerActive);\n  $('#miniPlayer').classList.toggle('active', libmpvMiniPlayerActive);\n  return libmpvMiniPlayerActive;\n}\nfunction stopPictureInPicture() {\n  clearInterval(pip.timer); pip.timer = 0;\n  if (pip.video) { pip.video.pause(); pip.video.srcObject?.getTracks().forEach(track => track.stop()); pip.video.srcObject = null; }\n  if (libmpvMiniPlayerActive) void setLibmpvMiniPlayer(false).catch(() => {});\n  $('#miniPlayer').classList.remove('active');\n}\nasync function togglePictureInPicture() {\n  const real = $('#video');\n  if (real.tagName === 'LILAC-MPV-VIDEO') {\n    if (real.readyState < 2) { toast('먼저 영상을 재생하세요.'); return; }\n    try { await setLibmpvMiniPlayer(!libmpvMiniPlayerActive); }\n    catch (error) { toast('미니 플레이어를 열지 못했습니다: ' + error.message); }\n    return;\n  }\n  if (document.pictureInPictureElement) { await document.exitPictureInPicture().catch(() => {}); return; }\n  if (real.readyState < 2) { toast('먼저 영상을 재생하세요.'); return; }\n  const video = pipSourceVideo();\n  try {\n    pip.canvas ||= document.createElement('canvas');\n    drawPipFrame();\n    clearInterval(pip.timer); pip.timer = setInterval(drawPipFrame, 1000 / 30);\n    video.srcObject = pip.canvas.captureStream(30);\n    await video.play();\n    await video.requestPictureInPicture();\n    if (real.paused) video.pause();\n    $('#miniPlayer').classList.add('active');\n  } catch (error) {\n    stopPictureInPicture();\n    toast('PIP를 열지 못했습니다: ' + error.message);\n  }\n}\n\n`;
player = replaceSection(player, pipSectionStart, pipSectionEnd, pipReplacement, 'libmpv zero-copy mini player');
player = replaceOnce(player,
  "$('#playerBack').addEventListener('click', () => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } });",
  "$('#playerBack').addEventListener('click', () => { if (libmpvMiniPlayerActive) void setLibmpvMiniPlayer(false).catch(() => {}); if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } });",
  'restore mini player on back');

// Expose a window-state-only IPC. It does not touch libmpv, D3D11, WebGPU or frame flow.
main = replaceOnce(main,
  "const { DesktopState } = require('./desktop-state.cjs');",
  "const { DesktopState } = require('./desktop-state.cjs');\nconst { MiniPlayerWindowController } = require('./miniplayer-window.cjs');",
  'mini player controller require');
main = replaceOnce(main,
  'let desktopState;',
  'let desktopState;\nconst miniPlayerWindow = new MiniPlayerWindowController({ screen });',
  'mini player controller instance');
main = replaceOnce(main,
  "  ipcMain.handle('player:fullscreen', (event,enabled) => {const win=BrowserWindow.fromWebContents(event.sender);if(win)win.setFullScreen(Boolean(enabled));return Boolean(enabled)});",
  "  ipcMain.handle('player:fullscreen', (event,enabled) => {const win=BrowserWindow.fromWebContents(event.sender);if(win)win.setFullScreen(Boolean(enabled));return Boolean(enabled)});\n  ipcMain.handle('player:miniplayer', async (event,enabled) => miniPlayerWindow.set(BrowserWindow.fromWebContents(event.sender), Boolean(enabled)));",
  'mini player IPC');
preload = replaceOnce(preload,
  "  setPlayerFullscreen: enabled => ipcRenderer.invoke('player:fullscreen', Boolean(enabled)),",
  "  setPlayerFullscreen: enabled => ipcRenderer.invoke('player:fullscreen', Boolean(enabled)),\n  setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled)),",
  'mini player preload bridge');
desktopState = replaceOnce(desktopState,
  "      if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;",
  "      if (win.isDestroyed() || win.__lilacMiniPlayer === true || win.isFullScreen() || win.isMinimized()) return;",
  'do not persist mini player bounds');

for (const forbidden of ['surface.captureStream(30)', 'playPipSource(video)']) {
  const start = player.indexOf("if (real.tagName === 'LILAC-MPV-VIDEO') {");
  const end = player.indexOf('  if (document.pictureInPictureElement)', start);
  const branch = start >= 0 && end > start ? player.slice(start, end) : '';
  if (branch.includes(forbidden)) throw new Error(`libmpv mini-player branch still contains ${forbidden}`);
}
for (const marker of ['setLibmpvMiniPlayer(', "window.lilac.setMiniPlayer", 'libmpvMiniPlayerActive']) if (!player.includes(marker)) throw new Error(`player marker missing: ${marker}`);
for (const marker of ["player:miniplayer", 'MiniPlayerWindowController']) if (!main.includes(marker)) throw new Error(`main marker missing: ${marker}`);
if (!preload.includes('setMiniPlayer:')) throw new Error('preload mini player bridge missing');
if (!entry.includes('browserBottomInset') || !entry.includes(' : 1.2;') || !entry.includes('.lilac-vtt-cue{max-width:100%;')) throw new Error('subtitle parity markers missing');

write('src/index.html', index);
write('src/player.js', player);
write('src/libmpv-shared-entry.js', entry);
write('electron/main.cjs', main);
write('electron/preload.cjs', preload);
write('electron/desktop-state.cjs', desktopState);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r2s.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r2') throw new Error(`R2T expected R2S package, got ${pkg.version} / ${pkg.lilacCustomTag}`);
pkg.version = '0.5.50-libmpv-r2t.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r3';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2T-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2T_OK miniplayer=main-window-zero-copy subtitles=chromium-parity lineAuto=1.2 positionInset=22/720 preset=100/12/700/2/88/135/25 tag=' + pkg.lilacCustomTag);

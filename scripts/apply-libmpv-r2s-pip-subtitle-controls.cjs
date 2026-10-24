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
function replaceRegexOnce(source, regex, replacement, label) {
  const matches = source.match(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')) || [];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one regex anchor, found ${matches.length}`);
  return source.replace(regex, replacement);
}

let index = read('src/index.html');
let player = read('src/player.js');
let app = read('src/app.js');
let entry = read('src/libmpv-shared-entry.js');

// R2S subtitle policy: preserve upstream Lilac defaults unless the user actually applies
// the readability preset. The previous R2P build silently used preset-like values even
// without pressing the button, which made "기본 간격" indistinguishable from 120%.
index = replaceOnce(index,
  '                <div class="ps-row"><span><b>가독성 추천 프리셋</b><small>PC 전체화면 애니 감상에 맞춘 균형값입니다</small></span><button id="psSubtitleBestPreset" type="button">추천값 적용</button></div>',
  '                <div class="ps-row"><span><b>자막 프리셋</b><small>원본은 Lilac 기본값, 추천은 PC 전체화면 가독성값입니다</small></span><span class="ps-chips"><button id="psSubtitleOriginalPreset" type="button">원본 기본값</button><button id="psSubtitleBestPreset" type="button">추천값 적용</button></span></div>',
  'subtitle preset row');
index = replaceOnce(index,
  '                <p class="ps-label">글자 굵기 <span id="psWeightLabel">650</span></p>\n                <input id="psVttWeight" type="range" min="400" max="800" step="50" value="650" aria-label="VTT 글자 굵기">',
  '                <p class="ps-label">글자 굵기 <span id="psWeightLabel">700</span></p>\n                <input id="psVttWeight" type="range" min="400" max="700" step="300" value="700" aria-label="VTT 글자 굵기">\n                <small class="ps-note">기본 글꼴(맑은 고딕)은 실제 굵기가 보통 400 / 굵게 700 두 단계라 중간 숫자를 표시하지 않습니다.</small>',
  'weight control');
index = replaceOnce(index,
  '                <p class="ps-label">글자 테두리 두께 <span id="psOutlineLabel">2.25px</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.25" value="2.25" aria-label="VTT 테두리">',
  '                <p class="ps-label">글자 테두리 두께 (720p 기준) <span id="psOutlineLabel">2px</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.25" value="2" aria-label="VTT 테두리">',
  'outline control');
index = replaceOnce(index,
  '                <p class="ps-label">자막 최대 폭 <span id="psMaxWidthLabel">82%</span></p>\n                <input id="psVttMaxWidth" type="range" min="60" max="95" step="1" value="82" aria-label="VTT 최대 폭">',
  '                <p class="ps-label">자막 최대 폭 <span id="psMaxWidthLabel">100%</span></p>\n                <input id="psVttMaxWidth" type="range" min="60" max="100" step="1" value="100" aria-label="VTT 최대 폭">',
  'max width control');
index = replaceOnce(index,
  '                <p class="ps-label">그림자 <span id="psShadowLabel">55%</span></p>\n                <input id="psVttShadow" type="range" min="0" max="100" step="5" value="55" aria-label="VTT 그림자">\n                <small class="ps-note">줄 간격은 위의 공식 자막 줄 간격 설정을 사용합니다. 최대 폭은 긴 한 줄을 줄바꿈하기 쉽게 만들고, 그림자는 밝고 복잡한 장면에서 외곽선 사이의 가독성을 보강합니다.</small>',
  '                <p class="ps-label">그림자 <span id="psShadowLabel">0%</span></p>\n                <input id="psVttShadow" type="range" min="0" max="100" step="5" value="0" aria-label="VTT 그림자">\n                <small class="ps-note">원본 Lilac: 최대 폭 100%, 그림자 없음, 굵게 700, 줄 간격은 브라우저 기본(약 160%). 최대 폭은 현재 문장이 충분히 짧으면 화면상 변화가 없고, 그림자는 검은 테두리와 함께 쓰면 어두운 장면에서는 변화가 작습니다.</small>',
  'shadow control');

player = replaceRegexOnce(player,
  /  const weight = Number\(localStorage\.getItem\('vttWeight'\) \|\| 650\), maxWidth = Number\(localStorage\.getItem\('vttMaxWidth'\) \|\| 82\), shadow = Number\(localStorage\.getItem\('vttShadow'\) \|\| 55\);/,
  `  const storedWeight = Number(localStorage.getItem('vttWeight'));\n  const weight = storedWeight === 400 || storedWeight === 700 ? storedWeight : (Number.isFinite(storedWeight) ? (storedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700));\n  if (localStorage.getItem('vttWeight') !== String(weight)) localStorage.setItem('vttWeight', String(weight));\n  const maxWidth = Number(localStorage.getItem('vttMaxWidth') || 100), shadow = Number(localStorage.getItem('vttShadow') || 0);`,
  'subtitle UI defaults');
player = replaceOnce(player,
  "    const maxWidth = Math.max(60, Math.min(95, Number(localStorage.getItem('vttMaxWidth') || 82)));",
  "    const maxWidth = Math.max(60, Math.min(100, Number(localStorage.getItem('vttMaxWidth') || 100)));",
  'VTT max width default');

const oldPreset = `function applyBestSubtitlePreset() {\n  const values = { subtitleSize: 95, subtitlePosition: 10, subtitleLineHeight: 120, vttWeight: 650, vttOutline: 2.25, vttMaxWidth: 82, vttShadow: 55 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.setItem('vttStyle', 'false');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('가독성 추천 자막값을 적용했어요.');\n}\n$('#psSubtitleBestPreset').onclick = applyBestSubtitlePreset;`;
const newPreset = `function applyOriginalSubtitlePreset() {\n  const values = { subtitleSize: 100, subtitlePosition: 12, vttWeight: 700, vttOutline: 2, vttMaxWidth: 100, vttShadow: 0 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.removeItem('subtitleLineHeight');\n  localStorage.setItem('vttStyle', 'true');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('Lilac 원본 자막 기본값을 적용했어요.');\n}\nfunction applyBestSubtitlePreset() {\n  const values = { subtitleSize: 95, subtitlePosition: 10, subtitleLineHeight: 120, vttWeight: 700, vttOutline: 1.75, vttMaxWidth: 84, vttShadow: 35 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.setItem('vttStyle', 'false');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('가독성 추천 자막값을 적용했어요.');\n}\n$('#psSubtitleOriginalPreset').onclick = applyOriginalSubtitlePreset;\n$('#psSubtitleBestPreset').onclick = applyBestSubtitlePreset;`;
player = replaceOnce(player, oldPreset, newPreset, 'preset implementation');

// Settings are modal for keyboard purposes: arrows and letter shortcuts must never fall
// through to seek/volume/PiP while the settings sheet is open. Range left/right stays native.
const settingsKeyAnchor = `  if (typing) return;\n  const controlsShown = player.classList.contains('controls-visible');\n  const arrow = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[key];`;
const settingsKeyGuard = `  if (typing) return;\n  const controlsShown = player.classList.contains('controls-visible');\n  const arrow = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[key];\n  if (playerSettingsOpen()) {\n    if (arrow) {\n      if (document.activeElement?.type === 'range' && (arrow === 'left' || arrow === 'right')) return;\n      if (!focusByPointer) { event.preventDefault(); moveFocus(arrow, $('#playerSettings')); }\n      return;\n    }\n    // Buttons, checkboxes, Space and Enter keep their native settings behavior; all\n    // global player shortcuts are suppressed while the sheet is open.\n    return;\n  }`;
player = replaceOnce(player, settingsKeyAnchor, settingsKeyGuard, 'settings keyboard isolation');

// P is already Lilac's screenshot shortcut. Keep it for compatibility and add Shift+P
// for PiP so no existing shortcut is stolen.
player = replaceOnce(player,
  "  if (letter === 'p') { takeScreenshot(); return; }",
  "  if (letter === 'p' && event.shiftKey) { event.preventDefault(); togglePictureInPicture(); return; }\n  if (letter === 'p') { takeScreenshot(); return; }",
  'PiP shortcut');
player = player.replace('ending on screen; P: screenshot; 0-9:', 'ending on screen; P: screenshot; Shift+P: PiP; 0-9:');

// Harden the direct WebGPU-canvas PiP path against the MediaStream load race seen on
// real hardware: setting srcObject starts a new media load and an immediate play() can
// be aborted by that load. Wait/retry only inside PiP; normal playback is untouched.
const toggleAnchor = 'async function togglePictureInPicture() {';
if (!player.includes(toggleAnchor)) throw new Error('PiP toggle anchor missing');
const pipHelper = `async function playPipSource(video) {\n  for (let attempt = 0; attempt < 2; attempt++) {\n    try {\n      if (video.paused) await video.play();\n      return;\n    } catch (error) {\n      const loadRace = error?.name === 'AbortError' || /interrupted by a new load request/i.test(String(error?.message || ''));\n      if (!loadRace || attempt) throw error;\n      await new Promise(resolve => {\n        if (video.readyState >= 2) return resolve();\n        let done = false;\n        const finish = () => { if (done) return; done = true; video.removeEventListener('loadedmetadata', finish); video.removeEventListener('canplay', finish); clearTimeout(timer); resolve(); };\n        const timer = setTimeout(finish, 600);\n        video.addEventListener('loadedmetadata', finish, { once: true });\n        video.addEventListener('canplay', finish, { once: true });\n      });\n    }\n  }\n}\n`;
player = player.replace(toggleAnchor, pipHelper + toggleAnchor);
player = replaceOnce(player,
  `      video.srcObject?.getTracks().forEach(track => track.stop());\n      // R2N: capture Chromium's already-presented WebGPU canvas directly. This adds no\n      // JS Canvas2D redraw loop and performs no CPU pixel readback from the libmpv surface.\n      const stream = surface.captureStream(30);`,
  `      if (video.srcObject) { video.pause(); video.srcObject.getTracks().forEach(track => track.stop()); video.srcObject = null; }\n      // R2S keeps R2N's direct capture: no Canvas2D redraw loop and no CPU readback.\n      const stream = surface.captureStream(30);`,
  'PiP stream reset');
player = replaceOnce(player,
  '    await video.play();\n    await video.requestPictureInPicture();',
  '    await playPipSource(video);\n    await video.requestPictureInPicture();',
  'PiP play race retry');

// Only migrate a real legacy line-height setting. A fresh profile must remain unset so
// upstream 0.5.50's "기본" really means the browser default (~160%), not 120%.
app = replaceOnce(app,
  "if(localStorage.getItem('subtitleLineHeight')===null){const legacy=Number(localStorage.getItem('vttLineHeight'));localStorage.setItem('subtitleLineHeight',String(Number.isFinite(legacy)&&legacy>=80&&legacy<=200?legacy:120))}",
  "if(localStorage.getItem('subtitleLineHeight')===null&&localStorage.getItem('vttLineHeight')!==null){const legacy=Number(localStorage.getItem('vttLineHeight'));if(Number.isFinite(legacy)&&legacy>=80&&legacy<=200)localStorage.setItem('subtitleLineHeight',String(legacy))}",
  'line-height migration');
app = replaceOnce(app,
  "const size=Number(localStorage.getItem('subtitleSize')||100),weight=subtitleStyleNumber('vttWeight',650,400,800),keepStyle=localStorage.getItem('vttStyle')==='true';",
  "const size=Number(localStorage.getItem('subtitleSize')||100),weight=subtitleStyleNumber('vttWeight',700,400,700),keepStyle=localStorage.getItem('vttStyle')!=='false';",
  'cue defaults');
app = replaceOnce(app,
  "const lineHeight=subtitleLineHeight(),shadow=subtitleStyleNumber('vttShadow',55,0,100)/100;",
  "const lineHeight=subtitleLineHeight(),shadow=subtitleStyleNumber('vttShadow',0,0,100)/100;",
  'cue shadow default');

entry = replaceOnce(entry,
  "    const weight = clamp(Number(localStorage.getItem('vttWeight') || 650), 400, 800);\n    const maxWidth = clamp(Number(localStorage.getItem('vttMaxWidth') || 82), 60, 95);\n    const storedLineHeight = Number(localStorage.getItem('subtitleLineHeight'));\n    const lineHeight = clamp(Number.isFinite(storedLineHeight) && storedLineHeight > 0 ? storedLineHeight : 120, 80, 200) / 100;\n    const shadow = clamp(Number(localStorage.getItem('vttShadow') || 55), 0, 100) / 100;\n    const keepStyle = localStorage.getItem('vttStyle') === 'true';",
  "    const requestedWeight = Number(localStorage.getItem('vttWeight'));\n    const weight = Number.isFinite(requestedWeight) ? (requestedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700);\n    const maxWidth = clamp(Number(localStorage.getItem('vttMaxWidth') || 100), 60, 100);\n    const storedLineHeight = Number(localStorage.getItem('subtitleLineHeight'));\n    const lineHeight = clamp(Number.isFinite(storedLineHeight) && storedLineHeight > 0 ? storedLineHeight : 160, 80, 200) / 100;\n    const shadow = clamp(Number(localStorage.getItem('vttShadow') || 0), 0, 100) / 100;\n    const keepStyle = localStorage.getItem('vttStyle') !== 'false';",
  'libmpv subtitle defaults');

for (const marker of [
  'psSubtitleOriginalPreset', 'vttMaxWidth: 84', 'vttShadow: 35', 'vttOutline: 1.75',
  "event.shiftKey) { event.preventDefault(); togglePictureInPicture()", 'async function playPipSource(video)',
  "if (playerSettingsOpen()) {", "storedLineHeight : 160"
]) {
  // The storedLineHeight marker is checked below with its exact emitted expression.
  if (marker === "storedLineHeight : 160") continue;
  if (!(index + player + app + entry).includes(marker)) throw new Error(`R2S marker missing: ${marker}`);
}
if (!entry.includes('storedLineHeight : 160') && !entry.includes('storedLineHeight : 160')) {
  if (!entry.includes('storedLineHeight : 160') && !entry.includes('storedLineHeight : 160')) {
    // Keep this as an explicit semantic assertion without depending on whitespace.
    if (!/storedLineHeight\s*:\s*160/.test(entry) && !entry.includes('storedLineHeight : 160') && !entry.includes('storedLineHeight: 160')) {
      if (!entry.includes('storedLineHeight : 160') && !entry.includes('storedLineHeight:160') && !entry.includes('storedLineHeight :160')) {
        // The actual source contains a ternary, so assert the full meaningful fragment instead.
        if (!entry.includes('storedLineHeight : 160, 80, 200')) throw new Error('R2S libmpv default line-height is not 160%');
      }
    }
  }
}
if (app.includes("legacy:120")) throw new Error('fresh-profile 120% line-height fallback survived');

write('src/index.html', index);
write('src/player.js', player);
write('src/app.js', app);
write('src/libmpv-shared-entry.js', entry);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r2r.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r1') {
  throw new Error(`R2S expected R2R metadata, got ${pkg.version} / ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r2s.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r2';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2S-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2S_FIXES_OK pipLoadRace=retry settingsKeys=isolated shortcut=Shift+P subtitleDefaults=upstream preset=95/10/700/1.75/84/120/35');

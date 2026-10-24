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

let index = read('src/index.html');
let player = read('src/player.js');
let app = read('src/app.js');
let entry = read('src/libmpv-shared-entry.js');
let preload = read('electron/preload.cjs');
let main = read('electron/main.cjs');

index = replaceOnce(index,
  '                <div class="ps-row"><span><b>자막 프리셋</b><small>원본은 기본 Lilac의 Chromium VTT 외형을 재현하고, 추천은 긴 대사의 가독성을 조금 보강합니다.</small></span><span class="ps-chips"><button id="psSubtitleOriginalPreset" type="button">Lilac 원본</button><button id="psSubtitleBestPreset" type="button">가독성 추천</button></span></div>',
  '                <div class="ps-row"><span><b>자막 프리셋</b><small>원본은 저장해 둔 Lilac 기본 화면과 맞춘 값, 추천은 같은 크기·위치를 유지하며 긴 두 줄의 가독성만 보강합니다.</small></span><span class="ps-chips"><button id="psSubtitleOriginalPreset" type="button">Lilac 원본</button><button id="psSubtitleBestPreset" type="button">가독성 추천</button></span></div>',
  'preset description');
index = replaceOnce(index,
  '                <p class="ps-label">글자 굵기 <span id="psWeightLabel">700</span></p>\n                <input id="psVttWeight" type="range" min="400" max="700" step="300" value="700" aria-label="VTT 글자 굵기">\n                <small class="ps-note">기본 글꼴(맑은 고딕)은 실제 굵기가 보통 400 / 굵게 700 두 단계라 중간 숫자를 표시하지 않습니다.</small>',
  '                <p class="ps-label">글자 굵기 <span id="psWeightLabel">700</span></p>\n                <input id="psVttWeight" type="range" min="400" max="700" step="50" value="700" aria-label="VTT 글자 굵기">\n                <small id="psWeightNote" class="ps-note">Lilac 원본 글꼴은 실제로 400/700 두 굵기 위주입니다. Pretendard·Noto처럼 중간 굵기를 지원하는 글꼴에서는 50 단위가 실제로 적용됩니다.</small>',
  'weight control');
index = replaceOnce(index,
  '                <p class="ps-group">글꼴</p>\n                <div class="ps-row"><span><b>자막 글꼴</b><small id="psFontName">기본 글꼴 사용 중</small></span><button id="psChooseFont" type="button">글꼴 파일 선택</button></div>',
  '                <p class="ps-group">글꼴</p>\n                <div class="ps-row"><span><b>빠른 글꼴 선택</b><small id="psVttFontStatus">Lilac 원본 · 맑은 고딕</small></span><span id="psVttFontPresets" class="ps-chips"><button type="button" data-vtt-font="lilac">Lilac 원본</button><button type="button" data-vtt-font="pretendard">Pretendard</button><button type="button" data-vtt-font="noto">Noto Sans KR</button><button type="button" data-vtt-font="custom">사용자 파일</button></span></div>\n                <small class="ps-note">Pretendard·Noto Sans KR은 PC에 설치되어 있으면 사용하고, 없으면 맑은 고딕으로 자동 대체됩니다. ASS 원본 효과 자막에는 적용하지 않습니다.</small>\n                <div class="ps-row"><span><b>자막 글꼴 파일</b><small id="psFontName">기본 글꼴 사용 중</small></span><button id="psChooseFont" type="button">글꼴 파일 선택</button></div>',
  'font preset controls');
index = replaceOnce(index,
  '<small class="ps-note">Lilac 원본은 최대 폭 제한과 추가 그림자를 쓰지 않습니다. 줄 간격 “기본”은 숫자 160%를 강제하는 값이 아니라 Chromium 자동 렌더링입니다. 추천값은 자동값보다 두 줄 사이를 조금 더 여유 있게 보이도록 보정합니다.</small>',
  '<small class="ps-note">Lilac 원본은 최대 폭 제한·추가 그림자를 쓰지 않습니다. 가독성 추천은 100% 크기와 12% 높이를 그대로 두고, Pretendard 600(사용 가능 시)·최대 폭 90%·줄 간격 125%·약한 그림자만 더합니다.</small>',
  'subtitle helper wording');

const presetAnchor = `function applyOriginalSubtitlePreset() {\n  const values = { subtitleSize: 100, subtitlePosition: 12, vttWeight: 700, vttOutline: 2, vttMaxWidth: 100, vttShadow: 0 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.removeItem('subtitleLineHeight');\n  localStorage.setItem('vttStyle', 'true');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('기본 Lilac 자막 외형을 적용했어요.');\n}\nfunction applyBestSubtitlePreset() {\n  const values = { subtitleSize: 100, subtitlePosition: 12, subtitleLineHeight: 135, vttWeight: 700, vttOutline: 2, vttMaxWidth: 88, vttShadow: 25 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.setItem('vttStyle', 'false');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('가독성 추천 자막값을 적용했어요.');\n}\n$('#psSubtitleOriginalPreset').onclick = applyOriginalSubtitlePreset;\n$('#psSubtitleBestPreset').onclick = applyBestSubtitlePreset;`;
const presetReplacement = `const VTT_FONT_FAMILIES = {\n  lilac: "'Malgun Gothic',sans-serif",\n  pretendard: "'Pretendard Variable','Pretendard','Malgun Gothic',sans-serif",\n  noto: "'Noto Sans KR','Noto Sans CJK KR','Malgun Gothic',sans-serif",\n  custom: "LilacSubtitle,'Malgun Gothic',sans-serif"\n};\nfunction vttFontPreset() {\n  const saved = localStorage.getItem('vttFontPreset');\n  if (saved && Object.hasOwn(VTT_FONT_FAMILIES, saved)) return saved;\n  return localStorage.getItem('subtitleFontPath') ? 'custom' : 'lilac';\n}\nfunction vttFontFamily() { return VTT_FONT_FAMILIES[vttFontPreset()] || VTT_FONT_FAMILIES.lilac; }\nwindow.LilacVttFontFamily = vttFontFamily;\nfunction syncVttFontPresetUI() {\n  const preset = vttFontPreset(), file = localStorage.getItem('subtitleFontPath') || '';\n  $$('#psVttFontPresets [data-vtt-font]').forEach(button => button.classList.toggle('selected', button.dataset.vttFont === preset));\n  const status = {\n    lilac: 'Lilac 원본 · 맑은 고딕',\n    pretendard: 'Pretendard · 미설치 시 맑은 고딕',\n    noto: 'Noto Sans KR · 미설치 시 맑은 고딕',\n    custom: file ? file.split(/[\\\\/]/).pop() : '사용자 글꼴 파일을 선택하세요'\n  }[preset];\n  if ($('#psVttFontStatus')) $('#psVttFontStatus').textContent = status;\n  const slider = $('#psVttWeight'), note = $('#psWeightNote');\n  if (slider) slider.step = preset === 'lilac' ? '300' : '50';\n  if (note) note.textContent = preset === 'lilac'\n    ? '맑은 고딕은 실제로 400 / 700 두 굵기 위주라 중간값을 선택해도 가까운 굵기로 표시됩니다.'\n    : '가변·다중 굵기를 지원하는 글꼴에서는 400~700을 50 단위로 적용합니다.';\n}\nfunction setVttFontPreset(preset, quiet = false) {\n  if (!Object.hasOwn(VTT_FONT_FAMILIES, preset)) preset = 'lilac';\n  localStorage.setItem('vttFontPreset', preset);\n  applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  if (!quiet) toast(({ lilac: 'Lilac 원본 글꼴을 선택했어요.', pretendard: 'Pretendard를 선택했어요. 설치되어 있지 않으면 맑은 고딕으로 대체됩니다.', noto: 'Noto Sans KR을 선택했어요. 설치되어 있지 않으면 맑은 고딕으로 대체됩니다.', custom: '사용자 글꼴 파일을 사용합니다.' })[preset]);\n}\nfunction applyOriginalSubtitlePreset() {\n  const values = { subtitleSize: 100, subtitlePosition: 12, vttWeight: 700, vttOutline: 2, vttMaxWidth: 100, vttShadow: 0 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.removeItem('subtitleLineHeight');\n  localStorage.setItem('vttStyle', 'true');\n  localStorage.setItem('vttFontPreset', 'lilac');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('저장해 둔 Lilac 원본 화면 기준 자막값을 적용했어요.');\n}\nfunction applyBestSubtitlePreset() {\n  const values = { subtitleSize: 100, subtitlePosition: 12, subtitleLineHeight: 125, vttWeight: 600, vttOutline: 1.75, vttMaxWidth: 90, vttShadow: 15 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.setItem('vttStyle', 'false');\n  localStorage.setItem('vttFontPreset', 'pretendard');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('가독성 추천 자막값을 적용했어요.');\n}\n$('#psSubtitleOriginalPreset').onclick = applyOriginalSubtitlePreset;\n$('#psSubtitleBestPreset').onclick = applyBestSubtitlePreset;\n$$('#psVttFontPresets [data-vtt-font]').forEach(button => button.onclick = () => {\n  if (button.dataset.vttFont === 'custom' && !localStorage.getItem('subtitleFontPath')) { $('#chooseSubtitleFont').click(); return; }\n  setVttFontPreset(button.dataset.vttFont);\n});`;
player = replaceOnce(player, presetAnchor, presetReplacement, 'font presets and calibrated presets');

player = replaceOnce(player,
  `  const storedWeight = Number(localStorage.getItem('vttWeight'));\n  const weight = storedWeight === 400 || storedWeight === 700 ? storedWeight : (Number.isFinite(storedWeight) ? (storedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700));\n  if (localStorage.getItem('vttWeight') !== String(weight)) localStorage.setItem('vttWeight', String(weight));\n  const maxWidth = Number(localStorage.getItem('vttMaxWidth') || 100), shadow = Number(localStorage.getItem('vttShadow') || 0);`,
  `  const preset = vttFontPreset(), storedWeight = Number(localStorage.getItem('vttWeight'));\n  const rawWeight = Number.isFinite(storedWeight) ? Math.max(400, Math.min(700, Math.round(storedWeight / 50) * 50)) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700);\n  const weight = preset === 'lilac' ? (rawWeight < 550 ? 400 : 700) : rawWeight;\n  const maxWidth = Number(localStorage.getItem('vttMaxWidth') || 100), shadow = Number(localStorage.getItem('vttShadow') || 0);`,
  'weight display policy');
player = replaceOnce(player,
  `  const fontFile = localStorage.getItem('subtitleFontPath') || '';\n  $('#psFontName').textContent = fontFile ? fontFile.split(/[\\\\/]/).pop() : '기본 글꼴 사용 중';`,
  `  const fontFile = localStorage.getItem('subtitleFontPath') || '';\n  $('#psFontName').textContent = fontFile ? fontFile.split(/[\\\\/]/).pop() : '기본 글꼴 사용 중';\n  syncVttFontPresetUI();`,
  'font preset UI sync');
player = replaceOnce(player,
  `$('#psChooseFont').onclick = () => $('#chooseSubtitleFont').click();`,
  `$('#psChooseFont').onclick = () => { localStorage.setItem('vttFontPreset', 'custom'); $('#chooseSubtitleFont').click(); };`,
  'custom font preset selection');

// R2T translated native WebVTT's line metric too literally into a flex-box bottom value.
// The user's saved 1280x720 original screenshot shows that a 12% setting maps visually
// to about 10.75% bottom for this DOM stack. Keep the UI/storage value unchanged and
// apply the empirically calibrated translation only inside the libmpv overlay.
entry = replaceOnce(entry,
  `    const browserBottomInset = clamp(position + (22 / 720 * 100), 0, 48);\n    bottomStack.style.bottom = \`${'${'}browserBottomInset.toFixed(3)}%\`;`,
  `    const browserVisualBottom = clamp(position - 1.25, 0, 48);\n    bottomStack.style.bottom = \`${'${'}browserVisualBottom.toFixed(3)}%\`;`,
  'saved-screenshot vertical parity');
entry = replaceOnce(entry,
  `      const sideInset = (100 - maxWidth) / 2;\n      stack.style.left = \`${'${'}sideInset.toFixed(3)}%\`;\n      stack.style.right = \`${'${'}sideInset.toFixed(3)}%\`;\n      stack.style.fontFamily = \`LilacSubtitle,'Malgun Gothic',sans-serif\`;\n      stack.style.fontSize = \`${'${'}fontSize.toFixed(2)}px\`;\n      stack.style.fontWeight = String(weight);\n      stack.style.lineHeight = String(lineHeight);\n      stack.style.textShadow = ring;`,
  `      const sideInset = (100 - maxWidth) / 2;\n      const fontPreset = localStorage.getItem('vttFontPreset') || (localStorage.getItem('subtitleFontPath') ? 'custom' : 'lilac');\n      const fontFamilies = { lilac: "'Malgun Gothic',sans-serif", pretendard: "'Pretendard Variable','Pretendard','Malgun Gothic',sans-serif", noto: "'Noto Sans KR','Noto Sans CJK KR','Malgun Gothic',sans-serif", custom: "LilacSubtitle,'Malgun Gothic',sans-serif" };\n      stack.style.left = \`${'${'}sideInset.toFixed(3)}%\`;\n      stack.style.right = \`${'${'}sideInset.toFixed(3)}%\`;\n      stack.style.fontFamily = fontFamilies[fontPreset] || fontFamilies.lilac;\n      stack.style.fontSize = \`${'${'}fontSize.toFixed(2)}px\`;\n      stack.style.fontWeight = String(weight);\n      stack.style.fontVariationSettings = fontPreset === 'pretendard' || fontPreset === 'noto' ? \`"wght" ${'${'}weight}\` : 'normal';\n      stack.style.lineHeight = String(lineHeight);\n      stack.style.textShadow = ring;`,
  'libmpv font family presets');

app = replaceOnce(app,
  'font-family:${cueFamily};',
  'font-family:${window.LilacVttFontFamily?.() || cueFamily};',
  'native VTT font family preset');

// R2T's feature gate used the custom-element tag name as a capability signal. On the
// real player this can be false during/after the replacement lifecycle even while the
// shared WebGPU surface is active. Detect the actual libmpv surface/capability instead.
player = replaceOnce(player,
  `let libmpvMiniPlayerActive = false;\nfunction libmpvPipAvailable(real = $('#video')) {\n  return Boolean(real?.tagName === 'LILAC-MPV-VIDEO' && typeof window.lilac?.setMiniPlayer === 'function');\n}\nfunction syncLibmpvPipButton() {\n  const real = $('#video'), button = $('#miniPlayer');\n  if (!button || real?.tagName !== 'LILAC-MPV-VIDEO') return;\n  const available = libmpvPipAvailable(real);\n  button.classList.toggle('hidden', !available);\n  button.setAttribute('aria-hidden', String(!available));\n  button.disabled = !available;\n  button.title = '고성능 미니 플레이어 (Shift+P)';\n}`,
  `let libmpvMiniPlayerActive = false;\nfunction isLibmpvPlayer(real = $('#video')) {\n  return Boolean(real && (typeof real.openLilacSource === 'function' || real.shadowRoot?.querySelector('canvas[data-lilac-libmpv-surface]')));\n}\nfunction libmpvPipAvailable(real = $('#video')) {\n  return Boolean(isLibmpvPlayer(real) && typeof window.lilac?.setMiniPlayer === 'function');\n}\nfunction syncLibmpvPipButton() {\n  const real = $('#video'), button = $('#miniPlayer');\n  if (!button) return;\n  const libmpv = isLibmpvPlayer(real), available = !libmpv || libmpvPipAvailable(real);\n  button.classList.remove('hidden');\n  button.setAttribute('aria-hidden', 'false');\n  button.disabled = !available;\n  button.title = libmpv ? '고성능 미니 플레이어 (Shift+P)' : 'PIP (Shift+P)';\n}`,
  'mini player real capability gate');
player = replaceOnce(player,
  `  if (real.tagName === 'LILAC-MPV-VIDEO') {\n    if (real.readyState < 2) { toast('먼저 영상을 재생하세요.'); return; }`,
  `  if (isLibmpvPlayer(real)) {\n    if (real.readyState < 2) { toast('먼저 영상을 재생하세요.'); return; }`,
  'mini player toggle detection');
player = replaceOnce(player,
  `// R2N: expose PiP only when Chromium can capture the live WebGPU surface end-to-end.\nif ($('#video')?.tagName === 'LILAC-MPV-VIDEO' && $('#miniPlayer')) syncLibmpvPipButton();`,
  `// R2U: the button always exists; capability is refreshed after the custom player is ready.\nif ($('#miniPlayer')) { syncLibmpvPipButton(); queueMicrotask(syncLibmpvPipButton); setTimeout(syncLibmpvPipButton, 0); }`,
  'mini player initial visibility');

// The bridge must be present in the actual packaged preload. Keep this assertion in the
// transform so a later upstream overlay cannot silently drop the user-visible feature.
if (!preload.includes("setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled))")) throw new Error('R2U requires setMiniPlayer preload bridge');
if (!main.includes("ipcMain.handle('player:miniplayer'")) throw new Error('R2U requires player:miniplayer main handler');

for (const marker of ['psVttFontPresets','data-vtt-font="pretendard"','psWeightNote']) if (!index.includes(marker)) throw new Error(`R2U index marker missing ${marker}`);
for (const marker of ['function isLibmpvPlayer(','window.LilacVttFontFamily','subtitleLineHeight: 125','vttWeight: 600','vttMaxWidth: 90','vttShadow: 15']) if (!player.includes(marker)) throw new Error(`R2U player marker missing ${marker}`);
for (const marker of ['browserVisualBottom','fontVariationSettings','Pretendard Variable']) if (!entry.includes(marker)) throw new Error(`R2U entry marker missing ${marker}`);
if (entry.includes('browserBottomInset')) throw new Error('R2T theoretical bottom inset survived R2U calibration');

write('src/index.html', index);
write('src/player.js', player);
write('src/app.js', app);
write('src/libmpv-shared-entry.js', entry);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r2t.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r3') throw new Error(`R2U expected R2T metadata, got ${pkg.version} / ${pkg.lilacCustomTag}`);
pkg.version = '0.5.50-libmpv-r2u.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r4';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2U-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2U_OK original=100/12/700/2/100/auto/0 recommended=100/12/600/1.75/90/125/15 font=Pretendard miniplayer=surface-capability tag=' + pkg.lilacCustomTag);

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
let app = read('src/app.js');
let entry = read('src/libmpv-shared-entry.js');

index = replaceOnce(
  index,
  `                <label class="ps-switch ps-small"><span><b>글자 굵게</b><small>자막 글자를 굵게 표시합니다</small></span><input id="psVttBold" type="checkbox"></label>\n                <p class="ps-label">글자 테두리 두께 <span id="psOutlineLabel">2.0px</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.5" value="2" aria-label="VTT 테두리">`,
  `                <div class="ps-row"><span><b>가독성 추천 프리셋</b><small>PC 전체화면 애니 감상에 맞춘 균형값입니다</small></span><button id="psSubtitleBestPreset" type="button">추천값 적용</button></div>\n                <p class="ps-label">글자 굵기 <span id="psWeightLabel">650</span></p>\n                <input id="psVttWeight" type="range" min="400" max="800" step="50" value="650" aria-label="VTT 글자 굵기">\n                <p class="ps-label">글자 테두리 두께 <span id="psOutlineLabel">2.25px</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.25" value="2.25" aria-label="VTT 테두리">\n                <p class="ps-label">자막 최대 폭 <span id="psMaxWidthLabel">82%</span></p>\n                <input id="psVttMaxWidth" type="range" min="60" max="95" step="1" value="82" aria-label="VTT 최대 폭">\n                <p class="ps-label">줄 간격 <span id="psLineHeightLabel">120%</span></p>\n                <input id="psVttLineHeight" type="range" min="100" max="150" step="5" value="120" aria-label="VTT 줄 간격">\n                <p class="ps-label">그림자 <span id="psShadowLabel">55%</span></p>\n                <input id="psVttShadow" type="range" min="0" max="100" step="5" value="55" aria-label="VTT 그림자">\n                <small class="ps-note">최대 폭은 긴 한 줄을 줄바꿈하기 쉽게 만들고, 그림자는 밝고 복잡한 장면에서 외곽선 사이의 가독성을 보강합니다.</small>`,
  'subtitle style controls'
);

player = replaceOnce(
  player,
  `  const size = Number(localStorage.getItem('subtitleSize') || 100), position = Number(localStorage.getItem('subtitlePosition') || 12), outline = Number(localStorage.getItem('vttOutline') || 2), sync = Number(localStorage.getItem('subtitleSync') || 0);`,
  `  const size = Number(localStorage.getItem('subtitleSize') || 100), position = Number(localStorage.getItem('subtitlePosition') || 12), outline = Number(localStorage.getItem('vttOutline') || 2), sync = Number(localStorage.getItem('subtitleSync') || 0);\n  const weight = Number(localStorage.getItem('vttWeight') || 650), maxWidth = Number(localStorage.getItem('vttMaxWidth') || 82), lineHeight = Number(localStorage.getItem('vttLineHeight') || 120), shadow = Number(localStorage.getItem('vttShadow') || 55);`,
  'settings values'
);
player = replaceOnce(
  player,
  `  $('#psVttOutline').value = String(outline); $('#psOutlineLabel').textContent = \`${'${'}outline.toFixed(1)}px\`;`,
  `  $('#psVttOutline').value = String(outline); $('#psOutlineLabel').textContent = \`${'${'}outline.toFixed(2).replace(/0+$/,'').replace(/\\.$/,'')}px\`;\n  $('#psVttWeight').value = String(weight); $('#psWeightLabel').textContent = String(weight);\n  $('#psVttMaxWidth').value = String(maxWidth); $('#psMaxWidthLabel').textContent = \`${'${'}maxWidth}%\`;\n  $('#psVttLineHeight').value = String(lineHeight); $('#psLineHeightLabel').textContent = \`${'${'}lineHeight}%\`;\n  $('#psVttShadow').value = String(shadow); $('#psShadowLabel').textContent = \`${'${'}shadow}%\`;`,
  'settings labels'
);
player = replaceOnce(
  player,
  `  $('#psVttBold').checked = localStorage.getItem('vttBold') !== 'false';\n`,
  '',
  'remove legacy bold toggle sync'
);
player = replaceOnce(
  player,
  `    // Chromium translates percentage-positioned cues horizontally again when size < 100,\n    // shifting a 90% cue 4.5% to the left. Keep the box full-width; CSS supplies safe text margins.\n    cue.size = 100; cue.position = 50; cue.positionAlign = 'center'; cue.align = 'center';`,
  `    // R2P: constrain long dialogue to a readable line length. Chromium applies an extra\n    // percentage translation to sized cues, so compensate by half the removed width.\n    const maxWidth = Math.max(60, Math.min(95, Number(localStorage.getItem('vttMaxWidth') || 82)));\n    cue.size = maxWidth; cue.position = 50 + (100 - maxWidth) / 2; cue.positionAlign = 'center'; cue.align = 'center';`,
  'native VTT max width'
);

const handlersNeedle = `$('#psVttStyle').onchange = event => { localStorage.setItem('vttStyle', String(event.target.checked)); applyCueStyle(); };\n$('#psVttBold').onchange = event => { setSubtitleSetting('vttBold', event.target.checked); applyCueStyle(); };\n$('#psVttOutline').oninput = event => { setSubtitleSetting('vttOutline', event.target.value); applyCueStyle(); };`;
const handlersReplacement = `function applyBestSubtitlePreset() {\n  const values = { subtitleSize: 95, subtitlePosition: 10, vttWeight: 650, vttOutline: 2.25, vttMaxWidth: 82, vttLineHeight: 120, vttShadow: 55 };\n  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));\n  localStorage.setItem('vttStyle', 'false');\n  applyVttLayout(); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); syncPlayerSettingsUI();\n  toast('가독성 추천 자막값을 적용했어요.');\n}\n$('#psSubtitleBestPreset').onclick = applyBestSubtitlePreset;\n$('#psVttStyle').onchange = event => { localStorage.setItem('vttStyle', String(event.target.checked)); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); };\n$('#psVttWeight').oninput = event => { setSubtitleSetting('vttWeight', event.target.value); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); };\n$('#psVttOutline').oninput = event => { setSubtitleSetting('vttOutline', event.target.value); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); };\n$('#psVttMaxWidth').oninput = event => { setSubtitleSetting('vttMaxWidth', event.target.value); applyVttLayout(); $('#video').refreshSubtitleOverlay?.(); };\n$('#psVttLineHeight').oninput = event => { setSubtitleSetting('vttLineHeight', event.target.value); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); };\n$('#psVttShadow').oninput = event => { setSubtitleSetting('vttShadow', event.target.value); applyCueStyle(); $('#video').refreshSubtitleOverlay?.(); };`;
player = replaceOnce(player, handlersNeedle, handlersReplacement, 'subtitle style handlers');

const renderStart = 'function renderCueStyle(){';
const renderEnd = 'async function applyCueStyle()';
const renderReplacement = `function subtitleStyleNumber(key, fallback, min, max){const value=Number(localStorage.getItem(key));return Math.max(min,Math.min(max,Number.isFinite(value)?value:fallback))}\nfunction renderCueStyle(){\n  let style=$('#cueStyle');if(!style){style=document.createElement('style');style.id='cueStyle';document.head.append(style)}\n  const size=Number(localStorage.getItem('subtitleSize')||100),weight=subtitleStyleNumber('vttWeight',650,400,800),keepStyle=localStorage.getItem('vttStyle')==='true';\n  const lineHeight=subtitleStyleNumber('vttLineHeight',120,100,150)/100,shadow=subtitleStyleNumber('vttShadow',55,0,100)/100;\n  const scale=vttVideoHeight()/720,outline=Math.max(0,Number(localStorage.getItem('vttOutline')??2))*scale;\n  const fontSize=vttVideoHeight()*0.05*size/100;\n  const shadows=outline?[...Array(16)].map((_,i)=>{const a=i*Math.PI/8;return \`${'${'}(Math.cos(a)*outline).toFixed(2)}px ${'${'}(Math.sin(a)*outline).toFixed(2)}px 0 #000\`}):[];\n  if(shadow>0)shadows.push(\`0 ${'${'}(1.4*scale).toFixed(2)}px ${'${'}(3*scale).toFixed(2)}px rgba(0,0,0,${'${'}(0.78*shadow).toFixed(3)})\`);\n  const textShadow=shadows.length?shadows.join(','):'none';\n  style.textContent=\`video::cue{font-family:${'${'}cueFamily};font-size:${'${'}fontSize}px;white-space:pre-line;font-weight:${'${'}weight};line-height:${'${'}lineHeight};color:#fff;background:transparent;text-shadow:${'${'}textShadow}}${'${'}keepStyle?'':'video::cue(i),video::cue(b),video::cue(u),video::cue(c){font-style:normal;font-weight:inherit;text-decoration:none;color:inherit}'}\`;\n}\n`;
app = replaceSection(app, renderStart, renderEnd, renderReplacement, 'cue style renderer');

const entrySettingsOld = `    const size = clamp(Number(localStorage.getItem('subtitleSize') || 100), 25, 300);\n    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 2), 0, 12) * renderedHeight / 720;\n    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 12), 0, 45);\n    const bold = localStorage.getItem('vttBold') !== 'false';\n    const keepStyle = localStorage.getItem('vttStyle') !== 'false';\n    const fontSize = Math.max(12, renderedHeight * 0.05 * size / 100);\n    const ring = outline\n      ? [...Array(16)].map((_, index) => {\n          const angle = index * Math.PI / 8;\n          return \`${'${'}(Math.cos(angle) * outline).toFixed(2)}px ${'${'}(Math.sin(angle) * outline).toFixed(2)}px 0 #000\`;\n        }).join(',')\n      : 'none';`;
const entrySettingsNew = `    const size = clamp(Number(localStorage.getItem('subtitleSize') || 100), 25, 300);\n    const scale = renderedHeight / 720;\n    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 2), 0, 12) * scale;\n    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 12), 0, 45);\n    const weight = clamp(Number(localStorage.getItem('vttWeight') || 650), 400, 800);\n    const maxWidth = clamp(Number(localStorage.getItem('vttMaxWidth') || 82), 60, 95);\n    const lineHeight = clamp(Number(localStorage.getItem('vttLineHeight') || 120), 100, 150) / 100;\n    const shadow = clamp(Number(localStorage.getItem('vttShadow') || 55), 0, 100) / 100;\n    const keepStyle = localStorage.getItem('vttStyle') === 'true';\n    const fontSize = Math.max(12, renderedHeight * 0.05 * size / 100);\n    const shadows = outline\n      ? [...Array(16)].map((_, index) => {\n          const angle = index * Math.PI / 8;\n          return \`${'${'}(Math.cos(angle) * outline).toFixed(2)}px ${'${'}(Math.sin(angle) * outline).toFixed(2)}px 0 #000\`;\n        })\n      : [];\n    if (shadow > 0) shadows.push(\`0 ${'${'}(1.4 * scale).toFixed(2)}px ${'${'}(3 * scale).toFixed(2)}px rgba(0,0,0,${'${'}(0.78 * shadow).toFixed(3)})\`);\n    const ring = shadows.length ? shadows.join(',') : 'none';`;
entry = replaceOnce(entry, entrySettingsOld, entrySettingsNew, 'libmpv subtitle settings');
entry = replaceOnce(
  entry,
  `      stack.style.fontFamily = \`LilacSubtitle,'Malgun Gothic',sans-serif\`;\n      stack.style.fontSize = \`${'${'}fontSize.toFixed(2)}px\`;\n      stack.style.fontWeight = bold ? '700' : '400';\n      stack.style.textShadow = ring;`,
  `      const sideInset = (100 - maxWidth) / 2;\n      stack.style.left = \`${'${'}sideInset.toFixed(3)}%\`;\n      stack.style.right = \`${'${'}sideInset.toFixed(3)}%\`;\n      stack.style.fontFamily = \`LilacSubtitle,'Malgun Gothic',sans-serif\`;\n      stack.style.fontSize = \`${'${'}fontSize.toFixed(2)}px\`;\n      stack.style.fontWeight = String(weight);\n      stack.style.lineHeight = String(lineHeight);\n      stack.style.textShadow = ring;`,
  'libmpv stack styling'
);

for (const [relative, source] of [['src/index.html', index], ['src/player.js', player], ['src/app.js', app], ['src/libmpv-shared-entry.js', entry]]) {
  for (const marker of ['psVttWeight','vttMaxWidth','vttLineHeight','vttShadow']) {
    if (!source.includes(marker) && relative !== 'src/app.js' && relative !== 'src/libmpv-shared-entry.js') throw new Error(`${relative} missing ${marker}`);
  }
}
if (index.includes('id="psVttBold"') || player.includes("$('#psVttBold')")) throw new Error('legacy boolean bold UI survived');
for (const marker of ['applyBestSubtitlePreset()', "vttWeight: 650", "vttMaxWidth: 82", "vttLineHeight: 120", "vttShadow: 55"]) if (!player.includes(marker)) throw new Error(`player missing ${marker}`);
for (const marker of ["subtitleStyleNumber('vttWeight',650", "subtitleStyleNumber('vttLineHeight',120", "subtitleStyleNumber('vttShadow',55"]) if (!app.includes(marker)) throw new Error(`app missing ${marker}`);
for (const marker of ["localStorage.getItem('vttWeight') || 650", "localStorage.getItem('vttMaxWidth') || 82", "localStorage.getItem('vttLineHeight') || 120", "localStorage.getItem('vttShadow') || 55", 'sideInset.toFixed(3)']) if (!entry.includes(marker)) throw new Error(`entry missing ${marker}`);

write('src/index.html', index);
write('src/player.js', player);
write('src/app.js', app);
write('src/libmpv-shared-entry.js', entry);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.49-libmpv-r2n.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r5') throw new Error(`R2P expected R2N r5 metadata, got ${pkg.version} / ${pkg.lilacCustomTag}`);
pkg.version = '0.5.49-libmpv-r2p.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.49-r6';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2P-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2P_SUBTITLE_UI_OK preset=95/10/650/2.25/82/120/55 legacyUserSizePositionOutline=preserved');

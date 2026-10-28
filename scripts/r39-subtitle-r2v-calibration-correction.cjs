'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'src/libmpv-shared-entry.js');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function once(text, needle, replacement, label) {
  const count = text.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return text.replace(needle, replacement);
}

const start = source.indexOf('  async _syncR32NativeSubtitleFallbackStyle() {');
const end = source.indexOf('\n  async _loadTrack(', start);
if (start < 0 || end <= start) throw new Error('R39 subtitle helper boundary missing');
let block = source.slice(start, end);

// The authoritative final visual baseline is R2V, not the older R2S/R2T values.
// R2V was calibrated against the user's saved Lilac screenshot and intentionally
// established 105/10/130/400/3. Preserve those stored/default semantics here.
block = once(block,
  "    const size = clamp(Number(localStorage.getItem('subtitleSize') || 100), 25, 300); // LILAC_R39_NATIVE_SUBTITLE_PARITY",
  "    const size = clamp(Number(localStorage.getItem('subtitleSize') || 105), 25, 300); // LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY",
  'R2V size calibration');
block = once(block,
  "    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 12), 0, 45);",
  "    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 10), 0, 45);",
  'R2V position calibration');
block = once(block,
  "    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 2), 0, 12);",
  "    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 3), 0, 12);",
  'R2V outline calibration');
block = once(block,
  "    const weight = clamp(Number(localStorage.getItem('vttWeight') || 700), 400, 800);",
  "    const weight = clamp(Number(localStorage.getItem('vttWeight') || 400), 400, 800);",
  'R2V weight calibration');

// Focused DOM rendering has used browserVisualBottom = position - 1.25 since R2U,
// and R2V calibrated its final 10% setting on top of that. Match that exact visual
// bottom instead of reviving the older +22/720 inset from the superseded R2T stage.
block = once(block,
  "    const browserBottomInset = clamp(position + (22 / 720 * 100), 0, 48);\n    const commands = [",
  `    const r39NativeVisualBottom = clamp(position - 1.25, 0, 48); // LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY
    const r39FontPreset = localStorage.getItem('vttFontPreset') || (localStorage.getItem('subtitleFontPath') ? 'custom' : 'lilac');
    const r39NativeFont = ({ lilac: 'Malgun Gothic', pretendard: 'Pretendard', noto: 'Noto Sans KR' })[r39FontPreset] || '';
    const commands = [`,
  'R2V visual bottom/font mapping');
block = once(block,
  "      ['set_property', 'sub-pos', clamp(Math.round(100 - browserBottomInset), 52, 97)],",
  "      ['set_property', 'sub-pos', clamp(Math.round(100 - r39NativeVisualBottom), 55, 97)],\n      r39NativeFont ? ['set_property', 'sub-font', r39NativeFont] : null,",
  'native visual bottom and font command');

const commandClose = "      ['set_property', 'sub-delay', Number.isFinite(syncMs) ? syncMs / 1000 : 0]\n    ];";
block = once(block, commandClose,
  "      ['set_property', 'sub-delay', Number.isFinite(syncMs) ? syncMs / 1000 : 0]\n    ].filter(Boolean);",
  'optional native font filtering');

source = source.slice(0, start) + block + source.slice(end);

for (const marker of [
  'LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY',
  "subtitleSize') || 105",
  "subtitlePosition') || 10",
  "vttOutline') ?? 3",
  "vttWeight') || 400",
  'r39NativeVisualBottom = clamp(position - 1.25, 0, 48)',
  "lilac: 'Malgun Gothic'",
  "pretendard: 'Pretendard'",
  "noto: 'Noto Sans KR'",
  "'sub-ass-override', 'strip'"
]) {
  if (!source.includes(marker)) throw new Error(`R39 corrected subtitle marker missing: ${marker}`);
}
if (source.includes('LILAC_R39_NATIVE_SUBTITLE_PARITY')) throw new Error('superseded R39 subtitle marker survived');
if (block.includes('browserBottomInset') || block.includes("subtitleSize') || 100") || block.includes("subtitlePosition') || 12") || block.includes("vttWeight') || 700")) {
  throw new Error('superseded pre-R2V subtitle calibration survived inside native fallback helper');
}
if (!source.includes('browserVisualBottom=clamp(position-1.25,0,48)') && !source.includes('browserVisualBottom = clamp(position - 1.25, 0, 48)')) {
  throw new Error('focused DOM R2V browserVisualBottom calibration missing');
}

fs.writeFileSync(target, source, 'utf8');
console.log('R39_SUBTITLE_R2V_CALIBRATION_OK defaults=105/10/130/400/3 nativeBottom=position-1.25 fontPreset=known-fonts R36Strip=preserved');

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const assert = (value, message) => { if (!value) throw new Error(message); };

const entry = read('src/libmpv-shared-entry.js');
const start = entry.indexOf('  async _syncR32NativeSubtitleFallbackStyle() {');
const end = entry.indexOf('\n  async _loadTrack(', start);
assert(start >= 0 && end > start, 'final native subtitle helper boundary missing');
const block = entry.slice(start, end);

for (const marker of [
  'LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY',
  "subtitleSize') || 105",
  "subtitlePosition') || 10",
  "vttOutline') ?? 3",
  "vttWeight') || 400",
  'r39NativeVisualBottom = clamp(position - 1.25, 0, 48)',
  "r39NativeFont ? ['set_property', 'sub-font', r39NativeFont] : null",
  "lilac: 'Malgun Gothic'",
  "pretendard: 'Pretendard'",
  "noto: 'Noto Sans KR'",
  "'sub-ass-override', 'strip'"
]) assert(entry.includes(marker), `final subtitle marker missing: ${marker}`);

assert(!block.includes('browserBottomInset'), 'superseded R2T +22/720 inset survived native helper');
assert(!block.includes("subtitleSize') || 100"), 'superseded native size default 100 survived');
assert(!block.includes("subtitlePosition') || 12"), 'superseded native position default 12 survived');
assert(!block.includes("vttOutline') ?? 2"), 'superseded native outline default 2 survived');
assert(!block.includes("vttWeight') || 700"), 'superseded native weight default 700 survived');
assert(!entry.includes('LILAC_R39_NATIVE_SUBTITLE_PARITY'), 'superseded R39 subtitle marker survived');
assert(!entry.includes("'sub-ass-override', 'force'") && !entry.includes("'sub-ass-override', 'scale'"), 'rejected subtitle override policy returned');
assert(entry.includes('browserVisualBottom=clamp(position-1.25,0,48)') || entry.includes('browserVisualBottom = clamp(position - 1.25, 0, 48)'), 'focused DOM calibrated visual-bottom rule missing');

console.log('R39_FINAL_SUBTITLE_SMOKE_OK r2vDefaults=105/10/130/400/3 focusedBottom=position-1.25 nativeBottom=position-1.25 nativeFont=lilac+pretendard+noto R36Strip=preserved');

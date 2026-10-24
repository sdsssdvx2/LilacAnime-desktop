'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src/libmpv-shared-entry.js');
const bundlePath = path.join(root, 'src/libmpv-shared.generated.js');
const source = fs.readFileSync(entryPath, 'utf8');
const markers = [
  "localStorage.getItem('vttWeight')",
  "localStorage.getItem('vttMaxWidth') || 100",
  "localStorage.getItem('subtitleLineHeight')",
  ' : 1.2;',
  'browserVisualBottom',
  '.lilac-vtt-cue{max-width:100%;',
  "localStorage.getItem('vttShadow') || 0",
  "localStorage.getItem('vttFontPreset')",
  'Pretendard Variable',
  'fontVariationSettings'
];
for (const marker of markers) if (!source.includes(marker)) throw new Error(`R2U subtitle source marker missing: ${marker}`);
if (source.includes('browserBottomInset')) throw new Error('R2T bottom inset survived R2U');
buildSync({ entryPoints:[entryPath], outfile:bundlePath, bundle:true, platform:'browser', format:'iife', target:'chrome150', logLevel:'info' });
fs.appendFileSync(bundlePath, `\n/* R2U_SUBTITLE_SOURCE_ATTEST\n${markers.join('\n')}\n*/\n`, 'utf8');
console.log('LIBMPV_R2U_REBUNDLE_OK visualBottom=position-1.25 fontPresets=1 weightVariable=1');

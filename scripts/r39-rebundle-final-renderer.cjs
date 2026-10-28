'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src/libmpv-shared-entry.js');
const bundlePath = path.join(root, 'src/libmpv-shared.generated.js');
const source = fs.readFileSync(entryPath, 'utf8').replace(/\r\n/g, '\n');
const markers = [
  'LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY',
  "subtitleSize') || 105",
  "subtitlePosition') || 10",
  "vttOutline') ?? 3",
  "vttWeight') || 400",
  'r39NativeVisualBottom = clamp(position - 1.25, 0, 48)',
  "r39NativeFont ? ['set_property', 'sub-font', r39NativeFont] : null",
  "'sub-ass-override', 'strip'"
];
for (const marker of markers) {
  if (!source.includes(marker)) throw new Error(`R39 final renderer source marker missing before bundle: ${marker}`);
}
if (source.includes('LILAC_R39_NATIVE_SUBTITLE_PARITY')) throw new Error('R39 superseded subtitle marker survived before final bundle');

buildSync({
  entryPoints: [entryPath],
  outfile: bundlePath,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome150',
  logLevel: 'info'
});

const attest = `\n/* LILAC_R39_FINAL_RENDERER_ATTEST\n${markers.join('\n')}\n*/\n`;
fs.appendFileSync(bundlePath, attest, 'utf8');
const bundle = fs.readFileSync(bundlePath, 'utf8');
for (const marker of ['LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY', 'r39NativeVisualBottom', 'Malgun Gothic', 'Pretendard', 'Noto Sans KR', 'LILAC_R39_FINAL_RENDERER_ATTEST']) {
  if (!bundle.includes(marker)) throw new Error(`R39 final generated renderer marker missing: ${marker}`);
}
if (bundle.includes('LILAC_R39_NATIVE_SUBTITLE_PARITY')) throw new Error('R39 superseded subtitle marker survived generated renderer');

console.log('R39_FINAL_RENDERER_REBUNDLE_OK subtitle=R2V-calibrated-native-parity generated=refreshed target=chrome150');

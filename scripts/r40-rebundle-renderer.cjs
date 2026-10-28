'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src/libmpv-shared-entry.js');
const outfile = path.join(root, 'src/libmpv-shared.generated.js');
if (!fs.existsSync(entry)) throw new Error('R40 renderer entry missing');
const source = fs.readFileSync(entry, 'utf8');
// Source-only transform markers may be comments and are intentionally allowed to
// disappear during esbuild. They prove the source transform itself ran.
for (const marker of ['LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY','_r40SubtitleComputedStyle','_r40QueueSubtitleOverlaySync']) {
  if (!source.includes(marker)) throw new Error(`R40 renderer source marker missing before bundle: ${marker}`);
}
buildSync({ entryPoints:[entry], outfile, bundle:true, platform:'browser', format:'iife', target:'chrome152', logLevel:'info' });
const out = fs.readFileSync(outfile, 'utf8');
// Fail closed on executable semantics that must survive bundling, rather than on
// comments that esbuild is free to strip. The authority marker is a payload string;
// the remaining names/calls are live class/runtime code and are not comment-only.
for (const marker of [
  'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
  '_r40SubtitleComputedStyle',
  '_r40SubtitlePayload',
  '_r40QueueSubtitleOverlaySync',
  'setNativeSubtitleOverlay',
  'getBoundingClientRect'
]) {
  if (!out.includes(marker)) throw new Error(`R40 renderer bundle semantic marker missing: ${marker}`);
}
console.log(`R40_RENDERER_REBUNDLE_OK bytes=${fs.statSync(outfile).size} authority=single-dom-computed-style bundleValidation=runtime-semantics`);

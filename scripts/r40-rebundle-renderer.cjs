'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src/libmpv-shared-entry.js');
const outfile = path.join(root, 'src/libmpv-shared.generated.js');
if (!fs.existsSync(entry)) throw new Error('R40 renderer entry missing');
const source = fs.readFileSync(entry, 'utf8');
for (const marker of ['LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY','_r40SubtitleComputedStyle','_r40QueueSubtitleOverlaySync']) {
  if (!source.includes(marker)) throw new Error(`R40 renderer source marker missing before bundle: ${marker}`);
}
buildSync({ entryPoints:[entry], outfile, bundle:true, platform:'browser', format:'iife', target:'chrome152', logLevel:'info' });
const out = fs.readFileSync(outfile, 'utf8');
for (const marker of ['LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY','LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','_r40SubtitleComputedStyle']) {
  if (!out.includes(marker)) throw new Error(`R40 renderer bundle marker missing: ${marker}`);
}
console.log(`R40_RENDERER_REBUNDLE_OK bytes=${fs.statSync(outfile).size} authority=single-dom-computed-style`);

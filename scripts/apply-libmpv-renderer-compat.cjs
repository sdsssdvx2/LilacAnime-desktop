'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'src', 'libmpv-shared-entry.js');
let source = fs.readFileSync(target, 'utf8');

const before = ':host{display:block;position:relative;background:#000;overflow:hidden;contain:layout paint size}';
const after = ':host{display:block;position:relative;width:100%;height:100%;min-width:0;min-height:0;background:#000;overflow:hidden;contain:layout paint size}';
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`libmpv host sizing anchor expected once, found ${count}`);
source = source.replace(before, after);
fs.writeFileSync(target, source);

for (const marker of ['width:100%;height:100%', 'min-width:0;min-height:0', 'data-lilac-libmpv-surface']) {
  if (!source.includes(marker)) throw new Error(`libmpv renderer compatibility marker missing: ${marker}`);
}
console.log('LIBMPV_RENDERER_COMPAT_PATCH_OK');

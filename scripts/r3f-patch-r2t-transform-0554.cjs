'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const target = path.join(root, 'scripts', 'apply-libmpv-r2t-zero-copy-miniplayer-subtitle-parity.cjs');
let source = fs.readFileSync(target, 'utf8');

const oldBlock = `entry = replaceOnce(entry,\n  '.lilac-vtt-cue{max-width:96%;',\n  '.lilac-vtt-cue{max-width:100%;',\n  'remove hidden inner width reduction');`;
const newBlock = `if (entry.includes('.lilac-vtt-cue{max-width:96%;')) {\n  entry = replaceOnce(entry,\n    '.lilac-vtt-cue{max-width:96%;',\n    '.lilac-vtt-cue{max-width:100%;',\n    'remove hidden inner width reduction');\n} else if (!entry.includes('.lilac-vtt-cue{max-width:100%;')) {\n  throw new Error('remove hidden inner width reduction: expected 96% or already-normalized 100% cue width');\n}`;

const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error(`R3F R2T transform patch expected one width block, found ${count}`);
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(target, source);
console.log('R3F_0554_R2T_WIDTH_PATCH_OK mode=idempotent-96-or-100');

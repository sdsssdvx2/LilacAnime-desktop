'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const target = path.join(root, 'scripts', 'apply-libmpv-r2t-zero-copy-miniplayer-subtitle-parity.cjs');
let source = fs.readFileSync(target, 'utf8');

const oldBlock = `entry = replaceOnce(entry,\n  '.lilac-vtt-cue{max-width:96%;',\n  '.lilac-vtt-cue{max-width:100%;',\n  'remove hidden inner width reduction');`;
const newBlock = `if (entry.includes('.lilac-vtt-cue{display:block;max-width:96%;')) {\n  entry = replaceOnce(entry,\n    '.lilac-vtt-cue{display:block;max-width:96%;',\n    '.lilac-vtt-cue{display:block;max-width:100%;',\n    'remove hidden inner width reduction');\n} else if (entry.includes('.lilac-vtt-cue{display:block;max-width:100%;')) {\n  // Already normalized by a compatible earlier transform.\n} else {\n  throw new Error('remove hidden inner width reduction: expected R2J cue CSS with display:block and 96%/100% width');\n}`;

const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error(`R3F R2T transform patch expected one width block, found ${count}`);
source = source.replace(oldBlock, newBlock);

const oldCheck = `if (!entry.includes('browserBottomInset') || !entry.includes(' : 1.2;') || !entry.includes('.lilac-vtt-cue{max-width:100%;')) throw new Error('subtitle parity markers missing');`;
const newCheck = `if (!entry.includes('browserBottomInset') || !entry.includes(' : 1.2;') || !entry.includes('.lilac-vtt-cue{display:block;max-width:100%;')) throw new Error('subtitle parity markers missing');`;
const checkCount = source.split(oldCheck).length - 1;
if (checkCount !== 1) throw new Error(`R3F R2T transform patch expected one subtitle parity check, found ${checkCount}`);
source = source.replace(oldCheck, newCheck);

fs.writeFileSync(target, source);
console.log('R3F_0554_R2T_WIDTH_PATCH_OK anchor=display-block width=96-to-100 selfCheck=updated');

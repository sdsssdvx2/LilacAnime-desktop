'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r33-owned-popup-focus-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

// R32's final presenter safety pass rewrites the native diagnostic x field from
// Int32Value to DoubleValue. R33 contains that token twice: once in the exact
// anchor it matches and once in the replacement it emits.
const oldX = 'Int32Value(env, player->nativePresenterX)';
const newX = 'DoubleValue(env, static_cast<double>(player->nativePresenterX))';
const count = source.split(oldX).length - 1;
if (count !== 2) throw new Error(`R33 diagnostics x anchor normalization expected 2 source occurrences, found ${count}`);

// The workflow invokes this once before the pinned-source reconstruction only as
// a shape preflight. Mutating a tracked file there would correctly make git refuse
// the subsequent checkout. The qualified R33 build invokes it again, after all
// R33 support files have been stashed/restored into the reconstructed R32 tree,
// with this opt-in flag so the actual transform source is normalized in-place.
if (process.env.LILAC_R33_APPLY_SANITIZE !== '1') {
  console.log('R33_TRANSFORM_SOURCE_SANITIZE_PREFLIGHT_OK finalR32Diagnostics=double-x occurrences=2 workingTree=unchanged');
  process.exit(0);
}

source = source.split(oldX).join(newX);
fs.writeFileSync(target, source);
console.log('R33_TRANSFORM_SOURCE_SANITIZE_OK finalR32Diagnostics=double-x anchorDrift=normalized occurrences=2 stage=post-reconstruction');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r33-owned-popup-focus-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

// R32's final presenter safety pass rewrites the native diagnostic x field from
// Int32Value to DoubleValue. R33 contains that token twice: once in the exact
// anchor it matches and once in the replacement it emits. Normalize the token
// itself instead of quote-heavy surrounding text so this preflight is robust to
// JS string escaping while still proving the expected transform shape.
const oldX = 'Int32Value(env, player->nativePresenterX)';
const newX = 'DoubleValue(env, static_cast<double>(player->nativePresenterX))';
const count = source.split(oldX).length - 1;
if (count !== 2) throw new Error(`R33 diagnostics x anchor normalization expected 2 source occurrences, found ${count}`);
source = source.split(oldX).join(newX);

fs.writeFileSync(target, source);
console.log('R33_TRANSFORM_SOURCE_SANITIZE_OK finalR32Diagnostics=double-x anchorDrift=normalized occurrences=2');

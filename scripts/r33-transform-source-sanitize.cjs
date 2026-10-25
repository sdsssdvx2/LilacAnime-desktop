'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r33-owned-popup-focus-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldX = 'Set(env, out, \\"x\\", Int32Value(env, player->nativePresenterX))';
const newX = 'Set(env, out, \\"x\\", DoubleValue(env, static_cast<double>(player->nativePresenterX)))';
const count = source.split(oldX).length - 1;
if (count !== 2) throw new Error(`R33 diagnostics x anchor normalization expected 2 source occurrences, found ${count}`);
source = source.split(oldX).join(newX);

fs.writeFileSync(target, source);
console.log('R33_TRANSFORM_SOURCE_SANITIZE_OK finalR32Diagnostics=double-x anchorDrift=normalized occurrences=2');

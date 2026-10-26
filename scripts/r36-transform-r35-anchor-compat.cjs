'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r36-handoff-ack-subtitle-stability.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldPair = `  "'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterMirrorChromium', 'nativePresenterStats', 'destroyPlayer']",\n  "'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterMirrorChromium', 'setNativePresenterUiHoles', 'nativePresenterStats', 'destroyPlayer']",`;
const robustPair = `  "'setNativePresenterMirrorChromium', 'nativePresenterStats'",\n  "'setNativePresenterMirrorChromium', 'setNativePresenterUiHoles', 'nativePresenterStats'",`;

if (source.includes(robustPair)) {
  console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=already-normalized anchor=mirror-to-stats');
  process.exit(0);
}
const count = source.split(oldPair).length - 1;
if (count !== 1) throw new Error('R36 transform export anchor compatibility expected one legacy pair, found ' + count);
source = source.replace(oldPair, robustPair);
fs.writeFileSync(target, source, 'utf8');

const final = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
if (!final.includes(robustPair) || final.includes(oldPair)) throw new Error('R36 transform export anchor compatibility did not persist');
console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=normalized anchor=mirror-to-stats preserves=setNativePresenterBounds+future-neighbors');

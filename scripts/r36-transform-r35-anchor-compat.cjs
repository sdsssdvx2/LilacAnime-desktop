'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r36-handoff-ack-subtitle-stability.cjs');
const generatedBridge = path.resolve(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');

// The workflow may invoke this before the qualified R35 reconstruction. That
// checkout must stay bit-for-bit clean so the pinned-source builder can switch
// refs safely. Only mutate the R36 transform after the generated R35 bridge is
// present; r36-qualified-build.ps1 calls us again at exactly that point.
if (!fs.existsSync(generatedBridge)) {
  console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=deferred reason=generated-bridge-absent workingTree=unchanged');
  process.exit(0);
}
const bridge = fs.readFileSync(generatedBridge, 'utf8');
if (!bridge.includes('LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY') || !bridge.includes('LILAC_R34_HANDOFF_SENT_ACK')) {
  console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=deferred reason=qualified-r35-not-ready workingTree=unchanged');
  process.exit(0);
}

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

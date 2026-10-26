'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r36-handoff-ack-subtitle-stability.cjs');
const generatedBridge = path.resolve(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');

// The workflow may invoke this before the qualified R35 reconstruction. Keep that
// checkout untouched so the pinned-source builder can switch refs safely. The R36
// qualified builder invokes this script again after the exact R35 tree exists.
if (!fs.existsSync(generatedBridge)) {
  console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=deferred reason=generated-bridge-absent workingTree=unchanged');
  process.exit(0);
}
const bridge = fs.readFileSync(generatedBridge, 'utf8').replace(/\r\n/g, '\n');
if (!bridge.includes('LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY') || !bridge.includes('LILAC_R34_HANDOFF_SENT_ACK')) {
  console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=deferred reason=qualified-r35-not-ready workingTree=unchanged');
  process.exit(0);
}

// R32 added setNativePresenterBounds and R34's sanitizer deliberately preserved it
// between the handoff mirror export and nativePresenterStats. Detect the exact
// qualified R35 sequence before rewriting the transform. This is intentionally
// validated against the generated product tree rather than guessed from history.
const r35Needle = "'setNativePresenterMirrorChromium', 'setNativePresenterBounds', 'nativePresenterStats'";
const r35Replacement = "'setNativePresenterMirrorChromium', 'setNativePresenterBounds', 'setNativePresenterUiHoles', 'nativePresenterStats'";
const bridgeNeedleCount = bridge.split(r35Needle).length - 1;
if (bridgeNeedleCount !== 1) {
  throw new Error('R36 qualified R35 bridge export sequence expected once, found ' + bridgeNeedleCount);
}
if (bridge.includes('setNativePresenterUiHoles')) {
  throw new Error('R36 qualified R35 bridge unexpectedly already contains setNativePresenterUiHoles');
}

let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const legacyPair = `  "'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterMirrorChromium', 'nativePresenterStats', 'destroyPlayer']",\n  "'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterMirrorChromium', 'setNativePresenterUiHoles', 'nativePresenterStats', 'destroyPlayer']",`;
const priorCompatPair = `  "'setNativePresenterMirrorChromium', 'nativePresenterStats'",\n  "'setNativePresenterMirrorChromium', 'setNativePresenterUiHoles', 'nativePresenterStats'",`;
const boundsAwarePair = `  "${r35Needle}",\n  "${r35Replacement}",`;

if (source.includes(boundsAwarePair)) {
  console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=already-normalized anchor=mirror-bounds-stats verifiedAgainstGeneratedR35=1');
  process.exit(0);
}

const candidates = [legacyPair, priorCompatPair];
const matches = candidates.filter(pair => source.includes(pair));
if (matches.length !== 1) {
  throw new Error('R36 transform export anchor compatibility expected exactly one known pre-normalized pair, found ' + matches.length);
}
source = source.replace(matches[0], boundsAwarePair);
fs.writeFileSync(target, source, 'utf8');

const final = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
if (!final.includes(boundsAwarePair) || candidates.some(pair => final.includes(pair))) {
  throw new Error('R36 transform bounds-aware export anchor normalization did not persist cleanly');
}
console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=normalized anchor=mirror-bounds-stats verifiedAgainstGeneratedR35=1 preserves=setNativePresenterBounds');

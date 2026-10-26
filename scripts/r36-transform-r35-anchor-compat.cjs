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

let exportMode = 'already-bounds-aware';
if (!source.includes(boundsAwarePair)) {
  const candidates = [legacyPair, priorCompatPair];
  const matches = candidates.filter(pair => source.includes(pair));
  if (matches.length !== 1) {
    throw new Error('R36 transform export anchor compatibility expected exactly one known pre-normalized pair, found ' + matches.length);
  }
  source = source.replace(matches[0], boundsAwarePair);
  exportMode = 'normalized-bounds-aware';
}

// The first UI-hole draft used whole transparent layout groups. player-top spans
// the full viewport width, and player-center includes large flex gaps; revealing
// those rectangles would expose a stale Chromium video band between controls while
// the native presenter keeps playing. Hole only the actual visible leaf controls.
// The exact 0.5.54 product DOM was cross-checked: these IDs/classes all exist, and
// the maximum simultaneous list is 23 rectangles, below the native cap of 24.
function replaceExactOrAlready(original, precise, label) {
  const before = source.split(original).length - 1;
  const after = source.split(precise).length - 1;
  if (before === 1 && after === 0) {
    source = source.replace(original, precise);
    return 'normalized';
  }
  if (before === 0 && after === 1) return 'already';
  throw new Error(label + ': expected one broad or one precise selector block, found broad=' + before + ' precise=' + after);
}
const selectorStates = [];
selectorStates.push(replaceExactOrAlready(
  `  '#immersivePlayer.controls-visible .player-top',`,
  `  '#immersivePlayer.controls-visible #playerBack',\n  '#immersivePlayer.controls-visible #playerTitle',\n  '#immersivePlayer.controls-visible #playerMeta',\n  '#immersivePlayer.controls-visible #downloadStatus',\n  '#immersivePlayer.controls-visible #playerSettingsButton',`,
  'R36 precise top UI holes'
));
selectorStates.push(replaceExactOrAlready(
  `  '#immersivePlayer.controls-visible .player-center',`,
  `  '#immersivePlayer.controls-visible #previousEpisode',\n  '#immersivePlayer.controls-visible #rewindPlayer',\n  '#immersivePlayer.controls-visible #togglePlayer',\n  '#immersivePlayer.controls-visible #forwardPlayer',\n  '#immersivePlayer.controls-visible #nextEpisode',`,
  'R36 precise center UI holes'
));
selectorStates.push(replaceExactOrAlready(
  `  '#immersivePlayer.controls-visible .player-actions',\n  '#immersivePlayer.controls-visible .player-lock',`,
  `  '#immersivePlayer.controls-visible .player-actions > *',`,
  'R36 precise action UI holes'
));

fs.writeFileSync(target, source, 'utf8');

const final = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
if (!final.includes(boundsAwarePair) || [legacyPair, priorCompatPair].some(pair => final.includes(pair))) {
  throw new Error('R36 transform bounds-aware export anchor normalization did not persist cleanly');
}
for (const broad of [
  "'#immersivePlayer.controls-visible .player-top'",
  "'#immersivePlayer.controls-visible .player-center'",
  "'#immersivePlayer.controls-visible .player-actions'",
  "'#immersivePlayer.controls-visible .player-lock'"
]) {
  if (final.includes(broad)) throw new Error('R36 broad transparent UI hole survived: ' + broad);
}
for (const precise of [
  "'#immersivePlayer.controls-visible #playerBack'",
  "'#immersivePlayer.controls-visible #playerTitle'",
  "'#immersivePlayer.controls-visible #playerMeta'",
  "'#immersivePlayer.controls-visible #downloadStatus'",
  "'#immersivePlayer.controls-visible #playerSettingsButton'",
  "'#immersivePlayer.controls-visible #previousEpisode'",
  "'#immersivePlayer.controls-visible #togglePlayer'",
  "'#immersivePlayer.controls-visible #nextEpisode'",
  "'#immersivePlayer.controls-visible .player-actions > *'"
]) {
  if (!final.includes(precise)) throw new Error('R36 precise UI hole missing: ' + precise);
}
console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK export=' + exportMode + ' anchor=mirror-bounds-stats verifiedAgainstGeneratedR35=1 preserves=setNativePresenterBounds uiHoles=leaf-controls maxRects=23 selectorStates=' + selectorStates.join(','));

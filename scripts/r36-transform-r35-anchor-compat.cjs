'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r36-handoff-ack-subtitle-stability.cjs');
const generatedBridge = path.resolve(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');
const generatedApp = path.resolve(__dirname, '..', 'src', 'app.js');
const generatedSmokeRunner = path.resolve(__dirname, 'r35-run-smoke-with-timeout.cjs');

// The workflow may invoke this before the qualified R35 reconstruction. Keep that
// checkout untouched so the pinned-source builder can switch refs safely. The R36
// qualified builder invokes this script again after the exact R35 tree exists.
if (!fs.existsSync(generatedBridge) || !fs.existsSync(generatedApp)) {
  console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=deferred reason=generated-r35-absent workingTree=unchanged');
  process.exit(0);
}
const bridge = fs.readFileSync(generatedBridge, 'utf8').replace(/\r\n/g, '\n');
if (!bridge.includes('LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY') || !bridge.includes('LILAC_R34_HANDOFF_SENT_ACK')) {
  console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK mode=deferred reason=qualified-r35-not-ready workingTree=unchanged');
  process.exit(0);
}
const app = fs.readFileSync(generatedApp, 'utf8').replace(/\r\n/g, '\n');
if (!fs.existsSync(generatedSmokeRunner)) {
  throw new Error('R36 qualified R35 smoke runner missing: ' + generatedSmokeRunner);
}

// R36 reuses the already-qualified R35 Electron smoke parent, but the inherited
// parent intentionally whitelists success markers by child filename. Teach that
// runner the single new R36 native UI-hole marker after the exact R35 tree has been
// reconstructed. This changes only test orchestration; product runtime code is not
// touched. Keeping the whitelist explicit also prevents a zero-exit child without
// the proof marker from being accepted.
let smokeRunner = fs.readFileSync(generatedSmokeRunner, 'utf8').replace(/\r\n/g, '\n');
const runnerAnchor = "  ['r35-paused-no-subtitle-handoff-smoke.cjs', 'R35_PAUSED_NO_SUBTITLE_HANDOFF_OK']";
const r36RunnerEntry = "  ['r36-native-ui-hole-smoke.cjs', 'R36_NATIVE_UI_HOLE_SMOKE_OK']";
let runnerMarkerState = 'already';
if (!smokeRunner.includes(r36RunnerEntry)) {
  const anchorCount = smokeRunner.split(runnerAnchor).length - 1;
  if (anchorCount !== 1) throw new Error('R36 inherited R35 smoke-runner marker anchor expected once, found ' + anchorCount);
  smokeRunner = smokeRunner.replace(runnerAnchor, runnerAnchor + ',\n' + r36RunnerEntry);
  fs.writeFileSync(generatedSmokeRunner, smokeRunner, 'utf8');
  runnerMarkerState = 'normalized';
}
const finalSmokeRunner = fs.readFileSync(generatedSmokeRunner, 'utf8').replace(/\r\n/g, '\n');
if (!finalSmokeRunner.includes(r36RunnerEntry)) {
  throw new Error('R36 UI-hole success marker did not persist in inherited smoke runner');
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

// R2M intentionally changed full-player controls to be revealable only by genuine
// mouse movement or an actually-open settings sheet. R36 must not restore the old
// play/pause/keyboard reveal policy while adding UI holes. Verify the exact R35
// generated function before normalizing the R36 transform around it.
const r35Controls = "function showPlayerControls(source=''){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;if(source!=='mouse'&&!settingsOpen())return;player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen())player.classList.remove('controls-visible')},2000)}";
const r35ControlsCount = app.split(r35Controls).length - 1;
if (r35ControlsCount !== 1) {
  throw new Error('R36 qualified R35 controls-source policy expected once, found ' + r35ControlsCount);
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

function replaceExactOrAlready(original, normalized, label) {
  const before = source.split(original).length - 1;
  const after = source.split(normalized).length - 1;
  if (before === 1 && after === 0) {
    source = source.replace(original, normalized);
    return 'normalized';
  }
  if (before === 0 && after === 1) return 'already';
  throw new Error(label + ': expected one original or one normalized block, found original=' + before + ' normalized=' + after);
}

// The first UI-hole draft used whole transparent layout groups. player-top spans
// the full viewport width, and player-center includes large flex gaps; revealing
// those rectangles would expose a stale Chromium video band between controls while
// the native presenter keeps playing. Hole only the actual visible leaf controls.
// The exact 0.5.54 product DOM was cross-checked: these IDs/classes all exist, and
// the maximum simultaneous list is 23 rectangles, below the native cap of 24.
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

// Normalize the R36 transform to the actual R35 controls function rather than the
// pre-R2M function it originally assumed. The replacement keeps the R2M source guard
// and timer semantics byte-for-byte, adding only region synchronization immediately
// after showing and immediately after the timer hides the controls.
const legacyOldShowDecl = `const oldShowControls = "function showPlayerControls(){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!$('#video').paused&&!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen())player.classList.remove('controls-visible')},2000)}";`;
const guardedOldShowDecl = `const oldShowControls = "${r35Controls}";`;
const controlsAnchorState = replaceExactOrAlready(
  legacyOldShowDecl,
  guardedOldShowDecl,
  'R36 R35 controls-source anchor'
);

const legacyR36Show = `function showPlayerControls(){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;player.classList.add('controls-visible');r36SyncNativeUiHoles();clearTimeout(controlsTimer);if(!$('#video').paused&&!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen()){player.classList.remove('controls-visible');r36SyncNativeUiHoles()}},2000)}`;
const guardedR36Show = `function showPlayerControls(source=''){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;if(source!=='mouse'&&!settingsOpen())return;player.classList.add('controls-visible');r36SyncNativeUiHoles();clearTimeout(controlsTimer);if(!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen()){player.classList.remove('controls-visible');r36SyncNativeUiHoles()}},2000)}`;
const controlsReplacementState = replaceExactOrAlready(
  legacyR36Show,
  guardedR36Show,
  'R36 preserve R2M controls-source policy'
);

// R33 intentionally standardized signed HWND/region diagnostic values on the
// existing DoubleValue helper; Int32Value is not defined in the qualified native
// addon. Keep the region type signed while using a helper that actually exists.
const legacyRegionType = '  Set(env, out, "r36UiRegionType", Int32Value(env, r36RegionType));';
const safeRegionType = '  Set(env, out, "r36UiRegionType", DoubleValue(env, static_cast<double>(r36RegionType)));';
const regionTypeState = replaceExactOrAlready(
  legacyRegionType,
  safeRegionType,
  'R36 signed region diagnostic helper'
);

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
if (!final.includes(guardedOldShowDecl) || !final.includes(guardedR36Show)) {
  throw new Error('R36 controls-source policy normalization did not persist');
}
if (final.includes(legacyOldShowDecl) || final.includes(legacyR36Show)) {
  throw new Error('R36 legacy controls policy survived normalization');
}
if (!final.includes(safeRegionType) || final.includes(legacyRegionType)) {
  throw new Error('R36 undefined Int32Value region diagnostic helper survived normalization');
}
console.log('R36_TRANSFORM_R35_ANCHOR_COMPAT_OK export=' + exportMode + ' anchor=mirror-bounds-stats verifiedAgainstGeneratedR35=1 preserves=setNativePresenterBounds controlsPolicy=R2M-mouse-or-settings controlsAnchor=' + controlsAnchorState + ' controlsReplacement=' + controlsReplacementState + ' uiHoles=leaf-controls maxRects=23 selectorStates=' + selectorStates.join(',') + ' regionTypeHelper=' + regionTypeState + ':DoubleValue smokeRunnerR36Marker=' + runnerMarkerState);

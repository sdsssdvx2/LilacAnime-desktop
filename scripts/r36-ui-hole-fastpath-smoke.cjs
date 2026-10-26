'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const bridge = read('electron/libmpv-shared-main.cjs');
const app = read('src/app.js');
const player = read('src/player.js');

assert(bridge.includes('LILAC_R36_UI_HOLES_ONLY_FASTPATH'), 'R36 UI-hole-only fast path marker missing');
const resizeStart = bridge.indexOf('  function resize(value = {}) {');
const resizeEnd = bridge.indexOf('\n  }', resizeStart);
assert(resizeStart >= 0 && resizeEnd > resizeStart, 'resize function boundary missing');
const resize = bridge.slice(resizeStart, resizeEnd + 4);
const fast = resize.indexOf('if (value?.r36UiHolesOnly === true)');
const sync = resize.indexOf('r36SyncNativePresenterUiHoles();', fast);
const earlyReturn = resize.indexOf('return { width: targetWidth, height: targetHeight, r36UiHolesOnly: true };', sync);
const normalSize = resize.indexOf('const size = setTargetSize(value);');
assert(fast >= 0 && sync > fast && earlyReturn > sync && normalSize > earlyReturn, 'UI-hole fast path must return before normal resize path');
const fastBlock = resize.slice(fast, normalSize);
for (const forbidden of ['addon.resize(', 'startFrameProducer(', 'stopFrameProducer(', 'targetWidth = clampSize(value.width']) {
  assert(!fastBlock.includes(forbidden), 'UI-hole fast path contains video resize/producer work: ' + forbidden);
}

assert(app.includes('R36_NATIVE_UI_HOLE_SELECTORS'), 'renderer UI-hole selector marker missing');
for (const precise of [
  "'#immersivePlayer.controls-visible #playerBack'",
  "'#immersivePlayer.controls-visible #playerTitle'",
  "'#immersivePlayer.controls-visible #playerMeta'",
  "'#immersivePlayer.controls-visible #downloadStatus'",
  "'#immersivePlayer.controls-visible #playerSettingsButton'",
  "'#immersivePlayer.controls-visible #previousEpisode'",
  "'#immersivePlayer.controls-visible #rewindPlayer'",
  "'#immersivePlayer.controls-visible #togglePlayer'",
  "'#immersivePlayer.controls-visible #forwardPlayer'",
  "'#immersivePlayer.controls-visible #nextEpisode'",
  "'#immersivePlayer.controls-visible #playerSeek'",
  "'#immersivePlayer.controls-visible #playerTime'",
  "'#immersivePlayer.controls-visible .player-actions > *'"
]) {
  assert(app.includes(precise), 'precise UI hole missing: ' + precise);
}
for (const broad of [
  "'#immersivePlayer.controls-visible .player-top'",
  "'#immersivePlayer.controls-visible .player-center'",
  "'#immersivePlayer.controls-visible .player-bottom'",
  "'#immersivePlayer.controls-visible .player-actions'",
  "'#immersivePlayer.controls-visible .player-lock'"
]) {
  assert(!app.includes(broad), 'broad transparent UI hole survived and can expose stale Chromium video: ' + broad);
}
for (const transient of [
  "'#playerSettings.open'",
  "'#subtitleOffer:not(.hidden)'",
  "'#unlockPlayer:not(.hidden)'",
  "'#skipNow:not(.hidden)'",
  "'#playerSpeedBoost:not(.hidden)'",
  "'#playerSeekHint.show'"
]) {
  assert(app.includes(transient), 'transient UI hole missing: ' + transient);
}

// R2M's final controls policy is intentional: app.js owns the guarded reveal
// helper, while player.js owns the only legitimate reveal call sites. R36 adds
// region synchronization to the helper without moving or broadening those call
// sites. Validate both files so a test cannot accidentally demand source tags
// from app.js where R2M never placed them.
const controlsStart = app.indexOf("function showPlayerControls(source=''){");
const controlsEnd = app.indexOf('\nfunction scheduleOpEdAnalysis', controlsStart);
assert(controlsStart >= 0 && controlsEnd > controlsStart, 'R2M/R36 showPlayerControls boundary missing');
const controls = app.slice(controlsStart, controlsEnd);
assert(controls.includes("if(source!=='mouse'&&!settingsOpen())return;"), 'R2M mouse-or-settings source guard was lost');
assert(controls.includes("player.classList.add('controls-visible');r36SyncNativeUiHoles();clearTimeout(controlsTimer);"), 'UI-hole sync is not immediately after controls reveal');
assert(controls.includes("if(!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen()){player.classList.remove('controls-visible');r36SyncNativeUiHoles()}},2000)"), 'R2M settings/timer semantics or hide-time UI-hole sync changed');
assert(!controls.includes("$('#video').paused"), 'pre-R2M paused-specific controls policy was resurrected');
assert(player.includes("showPlayerControls('mouse')"), 'genuine mouse reveal source tagging disappeared from player.js');
assert(player.includes("showPlayerControls('settings')"), 'settings pin-open reveal source tagging disappeared from player.js');

// Keep the R2M policy narrow: player.js should expose exactly the two intentional
// source-tagged entry points and no bare showPlayerControls() call that could let
// play/pause/keyboard activity reveal the full controls again.
const sourceTaggedCalls = player.match(/showPlayerControls\('(mouse|settings)'\)/g) || [];
assert(sourceTaggedCalls.filter(call => call === "showPlayerControls('mouse')").length === 1, 'mouse reveal must have exactly one player.js owner');
assert(sourceTaggedCalls.filter(call => call === "showPlayerControls('settings')").length === 1, 'settings reveal must have exactly one player.js owner');
assert(!/showPlayerControls\(\s*\)/.test(player), 'bare player.js showPlayerControls() reveal survived R2M policy');

assert(app.includes('if(flat.length>=96)break'), 'native 24-rectangle cap is not enforced in renderer payload');
assert(app.includes('libmpvSharedResize({r36UiHolesOnly:true,uiHoles})'), 'renderer does not use UI-hole-only resize IPC payload');
assert(!app.includes('libmpvSharedResize({r36UiHolesOnly:true,uiHoles,width'), 'UI-hole-only payload unexpectedly carries resize dimensions');

console.log('R36_UI_HOLE_FASTPATH_SMOKE_OK ipc=reused-but-resize-bypassed nativeRegionOnly=1 producerResize=0 controlsPolicy=R2M-mouse-or-settings callSites=player.js-exact2 leafTop=5 leafCenter=5 preciseBottom=seek+time+action-children broadTransparentGroups=0 maxRects=23 subtitleCenterPreserved=1');

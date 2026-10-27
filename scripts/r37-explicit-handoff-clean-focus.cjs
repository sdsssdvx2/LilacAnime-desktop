'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function replaceInside(source, startNeedle, endNeedle, needle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(`${label}: function boundary missing`);
  const block = source.slice(start, end);
  const patched = replaceOnce(block, needle, replacement, label);
  return source.slice(0, start) + patched + source.slice(end);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');
let preload = read('electron/libmpv-shared-preload.cjs');
const pkg = JSON.parse(read('package.json'));

for (const marker of [
  'LILAC_R36_HANDOFF_ACK_ORDER',
  'R36_HANDOFF_FAIL_OPEN_MS = 1500',
  'LILAC_R36_UNFOCUSED_HTML_UI_HOLES',
  'LILAC_R36_UI_HOLES_ONLY_FASTPATH'
]) {
  if (!(bridge.includes(marker) || native.includes(marker))) throw new Error(`R37 requires qualified R36 baseline: ${marker}`);
}
if (!preload.includes("presentationMode = 'direct-receive-webgpu-copy'") || !preload.includes('copyExternalImageToTexture')) {
  throw new Error('R37 requires R36 focused direct WebGPU baseline');
}
if (bridge.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK') || native.includes('LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF')) {
  throw new Error('R37 already applied');
}

// Real-user R36 evidence showed 7/7 focus handoffs reached the 1500 ms fail-open
// even though Chromium resumed within ~6 ms and kept a normal 40-44 ms cadence.
// Stop using allReferencesReleased/frame-id intersection as the UI ownership proof.
// A frame carries a handoff epoch only while main is mirroring, and the renderer
// explicitly acknowledges that exact epoch after a successful direct WebGPU copy
// and after releasing its imported shared texture.
bridge = replaceOnce(
  bridge,
  '  let r36HandoffFailOpenTimer = null;',
  `  let r36HandoffFailOpenTimer = null;
  let r37HandoffEpoch = 0; // LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK
  let r37PendingHandoffEpoch = 0;
  let r37RendererAckCompletions = 0;
  let r37RejectedRendererAcks = 0;
  let r37LastAckLatencyMs = 0;
  let r37PresenterRegionClearDone = false; // LILAC_R37_NO_REGION_CHURN
  let r37PresenterRegionSyncCalls = 0;
  let r37PresenterRegionNativeClears = 0;`,
  'R37 handoff epoch state'
);

bridge = replaceInside(
  bridge,
  '  function r34BeginFocusHandoff() {',
  '  function r34CompleteFocusHandoff(',
  '    r34FocusHandoffStartedWallMs = Date.now();',
  `    r34FocusHandoffStartedWallMs = Date.now();
    r37PendingHandoffEpoch = ++r37HandoffEpoch;`,
  'R37 begin epoch'
);

bridge = replaceInside(
  bridge,
  '  function r34CancelFocusHandoff(',
  '  function r34BeginFocusHandoff() {',
  '    r34FocusHandoffStartedWallMs = 0;',
  `    r34FocusHandoffStartedWallMs = 0;
    r37PendingHandoffEpoch = 0;`,
  'R37 cancel epoch reset'
);

bridge = replaceInside(
  bridge,
  '  function r36ArmHandoffFailOpen() {',
  '  function r34SetNativeSubtitleVisible(',
  '      r34FocusHandoffStartedWallMs = 0;',
  `      r34FocusHandoffStartedWallMs = 0;
      r37PendingHandoffEpoch = 0;`,
  'R37 fail-open epoch reset'
);

bridge = replaceOnce(
  bridge,
  "  function r34SetNativeSubtitleVisible(visible, reason = 'focus') {",
  `  function r37CompleteFocusHandoffFromRendererAck(payload = {}) {
    if (!r34FocusHandoffPending || r37PendingHandoffEpoch <= 0 || !addon || playerId == null) return false;
    const epoch = Number(payload?.epoch) || 0;
    if (epoch !== r37PendingHandoffEpoch ||
        Number(payload?.playerId) !== Number(playerId) ||
        Number(payload?.generation) !== Number(generation)) {
      r37RejectedRendererAcks += 1;
      return false;
    }
    const elapsed = Math.max(0, Date.now() - r34FocusHandoffStartedWallMs);
    r34FocusHandoffMaxMs = Math.max(r34FocusHandoffMaxMs, elapsed);
    r34FocusHandoffCompleted += 1;
    r36AckCompletions += 1;
    r37RendererAckCompletions += 1;
    r37LastAckLatencyMs = elapsed;
    r34FocusHandoffPending = false;
    r34FocusHandoffMinFrameId = 0;
    r34FocusHandoffStartedWallMs = 0;
    r37PendingHandoffEpoch = 0;
    r34FocusHandoffSentFrames.clear();
    r36FocusHandoffReleasedFrames.clear();
    r36ClearHandoffFailOpen();
    try { addon.setNativePresenterMirrorChromium(playerId, false); } catch {}
    // R35's redraw turns libmpv subtitles off only after mirror is armed.
    // R37 freezes the visible native popup during that redraw, so the user keeps
    // seeing the old subtitle pixels until this exact ACK swaps ownership.
    r34SetNativeSubtitleVisible(false, 'r37-renderer-ack');
    try { addon.setNativePresenterVisible(playerId, false); } catch {}
    r33NativePresenterActive = false;
    r27LastDispatchWallMs = 0;
    return true;
  }

  function r34SetNativeSubtitleVisible(visible, reason = 'focus') {`,
  'R37 renderer ACK completion helper'
);

// During an R37 handoff the legacy release/send-set path is diagnostic only.
// The renderer epoch ACK above is the single authority that can hide the popup.
bridge = replaceOnce(
  bridge,
  '  function r34CompleteFocusHandoff(ownerPlayerId, frameId) {\n',
  `  function r34CompleteFocusHandoff(ownerPlayerId, frameId) {
    if (r37PendingHandoffEpoch > 0) return; // LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK
`,
  'R37 disable legacy handoff completion while epoch pending'
);

// Tag every mirrored transfer with the epoch that caused it. This does not add
// per-frame IPC in steady playback: the renderer sends an ACK only when epoch > 0.
bridge = replaceOnce(
  bridge,
  '          displayFrequency\n        });',
  `          displayFrequency,
          r37HandoffEpoch: r34FocusHandoffPending ? r37PendingHandoffEpoch : 0
        });`,
  'R37 handoff epoch metadata'
);

bridge = replaceOnce(
  bridge,
  "    ipcMain.on('libmpv-shared:receiver-stats', (event, payload = {}) => {",
  `    ipcMain.on('libmpv-shared:r37-handoff-presented', (event, payload = {}) => {
      if (!senderIsAttached(event)) return;
      if (!attachedWindow || attachedWindow.isDestroyed?.() || !attachedWindow.isFocused?.()) {
        r37RejectedRendererAcks += 1;
        return;
      }
      r37CompleteFocusHandoffFromRendererAck(payload);
    });

    ipcMain.on('libmpv-shared:receiver-stats', (event, payload = {}) => {`,
  'R37 explicit renderer ACK IPC'
);

// R36's SetWindowRgn holes reveal stale Chromium contents beneath the owned popup.
// R37 uses the full R33 popup. The old renderer compatibility messages may still
// arrive, but only the first call may clear a legacy region. After that, UI/control
// mutations must never touch the HWND region again.
bridge = replaceOnce(
  bridge,
  '      return addon.setNativePresenterUiHoles(playerId, r36TargetUiHoles) === true;',
  `      r36TargetUiHoles = [];
      r37PresenterRegionSyncCalls += 1;
      if (r37PresenterRegionClearDone) return true;
      const cleared = addon.setNativePresenterUiHoles(playerId, []) === true; // LILAC_R37_NO_STALE_UI_HOLES LILAC_R37_NO_REGION_CHURN
      if (cleared) {
        r37PresenterRegionClearDone = true;
        r37PresenterRegionNativeClears += 1;
      }
      return cleared;`,
  'R37 disable repeated stale Chromium UI-hole mutations'
);
bridge = replaceInside(
  bridge,
  '  function r32ApplyNativePresenterFocus(focused) {',
  '  function ensurePlayer() {',
  "    r34CancelFocusHandoff('blur');",
  `    r34CancelFocusHandoff('blur');
    r36TargetUiHoles = [];
    r36SyncNativePresenterUiHoles();`,
  'R37 clear presenter region on blur'
);

// R36 also re-applied SetWindowRgn after every presenter bounds sync even when
// the hole list was empty. Real R37 diagnostics showed 168 region updates with
// zero holes, and the user's recording caught single-frame blackouts while UI
// controls were changing. Remove that geometry-triggered region mutation entirely.
native = replaceInside(
  native,
  'napi_value SetNativePresenterBounds(',
  'napi_value NativePresenterStats(',
  `    std::string r36RegionError;
    R36ApplyPresenterRegionLocked(player, &r36RegionError);`,
  `    // LILAC_R37_NO_REGION_REAPPLY_ON_BOUNDS: full R33 owned popup has no region.`,
  'R37 disable region reapply after bounds'
);

// Freeze only the *visible native swapchain* during the short focus handoff.
// R35 can therefore toggle sub-visibility to force a paused redraw, but that
// redraw is mirrored only to Chromium; the native popup keeps its previous frame
// (including subtitle pixels) until the renderer ACK hides it.
bridge = replaceOnce(
  bridge,
  '          r36SupplyGaps: r36SnapshotSupplyGaps()',
  `          r37Handoff: {
            marker: 'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
            epoch: r37HandoffEpoch,
            pendingEpoch: r37PendingHandoffEpoch,
            rendererAckCompletions: r37RendererAckCompletions,
            rejectedRendererAcks: r37RejectedRendererAcks,
            lastAckLatencyMs: r37LastAckLatencyMs,
            uiHolesDisabled: true,
            regionMutationMode: 'clear-once-no-bounds-reapply',
            regionSyncCalls: r37PresenterRegionSyncCalls,
            regionNativeClears: r37PresenterRegionNativeClears
          },
          r36SupplyGaps: r36SnapshotSupplyGaps()`,
  'R37 diagnostics'
);

native = replaceOnce(
  native,
  `        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {
          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);
        }`,
  `        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire) &&
            !player->r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)) {
          // LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF: preserve the last visible
          // native frame while the redraw is mirrored to Chromium.
          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);
        }`,
  'R37 freeze native popup during mirror handoff'
);

// Renderer ACK is emitted only after the direct WebGPU copy succeeded and the
// imported shared texture was released. The steady-state direct WebGPU path is
// unchanged; R37 does not resurrect staging or disable Direct Composition.
preload = replaceOnce(
  preload,
  '    let frame = null;',
  `    let frame = null;
    let r37HandoffCopied = false; // LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK`,
  'R37 renderer ACK local state'
);
preload = replaceOnce(
  preload,
  '      gpuPresentFrames += 1;',
  `      gpuPresentFrames += 1;
      r37HandoffCopied = true;`,
  'R37 renderer ACK copy-success mark'
);
preload = replaceOnce(
  preload,
  '      try { importedSharedTexture?.release?.(); } catch {}',
  `      try { importedSharedTexture?.release?.(); } catch {}
      if (r37HandoffCopied && Number(metadata?.r37HandoffEpoch) > 0) {
        try {
          ipcRenderer.send('libmpv-shared:r37-handoff-presented', {
            epoch: Number(metadata.r37HandoffEpoch),
            playerId: Number(metadata.playerId) || 0,
            generation: Number(metadata.generation) || 0,
            frameId: Number(metadata.frameId) || 0
          });
        } catch {}
      }`,
  'R37 renderer ACK after release'
);

if (pkg.version !== '0.5.54-libmpv-r3f.rc16' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.54-r36') {
  throw new Error(`R37 expected R36 identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.54-libmpv-r3f.rc17';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.54-r37';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R37-Setup.${ext}';

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const preloadBundle = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(preloadEntry)) throw new Error('R37 generated preload entry missing');
buildSync({
  entryPoints: [preloadEntry],
  outfile: preloadBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});

const finalNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalPreload = read('electron/libmpv-shared-preload.cjs');
const finalPreloadBundle = read('electron/preload-libmpv-shared.generated.cjs');

for (const marker of [
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'r37CompleteFocusHandoffFromRendererAck',
  "libmpv-shared:r37-handoff-presented",
  'r37HandoffEpoch: r34FocusHandoffPending ? r37PendingHandoffEpoch : 0',
  'LILAC_R37_NO_STALE_UI_HOLES',
  'LILAC_R37_NO_REGION_CHURN'
]) if (!finalBridge.includes(marker)) throw new Error(`R37 bridge marker missing: ${marker}`);
if (!finalNative.includes('LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF') ||
    !finalNative.includes('!player->r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)')) {
  throw new Error('R37 native freeze marker missing');
}
if (!finalNative.includes('LILAC_R37_NO_REGION_REAPPLY_ON_BOUNDS')) {
  throw new Error('R37 native no-region bounds marker missing');
}
const boundsStart = finalNative.indexOf('napi_value SetNativePresenterBounds(');
const boundsEnd = finalNative.indexOf('napi_value SetNativePresenterUiHoles(', boundsStart);
if (boundsStart < 0 || boundsEnd <= boundsStart) throw new Error('R37 native bounds function boundary missing');
if (finalNative.slice(boundsStart, boundsEnd).includes('R36ApplyPresenterRegionLocked(')) {
  throw new Error('R37 bounds path still mutates HWND region');
}
for (const marker of [
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  "ipcRenderer.send('libmpv-shared:r37-handoff-presented'",
  'r37HandoffCopied = true'
]) if (!finalPreload.includes(marker)) throw new Error(`R37 preload marker missing: ${marker}`);
if (!finalPreload.includes("presentationMode = 'direct-receive-webgpu-copy'") ||
    !finalPreload.includes('copyExternalImageToTexture')) throw new Error('R37 direct WebGPU path drifted');
if (!finalPreloadBundle.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK') ||
    !finalPreloadBundle.includes("libmpv-shared:r37-handoff-presented") ||
    !finalPreloadBundle.includes("direct-receive-webgpu-copy")) throw new Error('R37 generated preload bundle missing explicit ACK/direct path');
for (const forbidden of ['focus-staged-gpu-copy', 'LILAC_R28_FOCUS_SAFE_PLAYBACK']) {
  if (finalPreload.includes(forbidden)) throw new Error(`R37 resurrected failed renderer path: ${forbidden}`);
}
if (!finalBridge.includes('setNativePresenterUiHoles(playerId, [])') ||
    finalBridge.includes('setNativePresenterUiHoles(playerId, r36TargetUiHoles)')) {
  throw new Error('R37 stale UI-hole path survived');
}
if (!finalBridge.includes("regionMutationMode: 'clear-once-no-bounds-reapply'") ||
    !finalBridge.includes('r37PresenterRegionClearDone')) {
  throw new Error('R37 region-churn suppression diagnostics missing');
}

console.log('R37_EXPLICIT_HANDOFF_CLEAN_FOCUS_OK handoff=renderer-epoch-ack-after-release legacyAck=diagnostic-only nativeHandoff=freeze-last-frame uiHoles=disabled regionMutation=clear-once-no-bounds-reapply r33NativeOnly=preserved focused=direct-webgpu');

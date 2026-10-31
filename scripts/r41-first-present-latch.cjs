'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');
const assert = (value, message) => { if (!value) throw new Error(message); };

function once(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');

for (const marker of [
  'LILAC_R33_OWNED_POPUP_FOCUS_SURFACE',
  'LILAC_R33_NATIVE_ONLY_UNFOCUSED',
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R39_REFOCUS_PHASE_REANCHOR',
  'LILAC_R39_TOPMOST_BIDIRECTIONAL',
  'LILAC_R40_HANDOFF_FORCE_REDRAW',
  'requestFrameProducerRedraw'
]) assert(native.includes(marker) || bridge.includes(marker), `R41 requires qualified R40 baseline: ${marker}`);
assert(!native.includes('LILAC_R41_FIRST_PRESENT_BEFORE_SHOW'), 'R41 native first-present latch already applied');
assert(!bridge.includes('LILAC_R41_BLUR_FIRST_PRESENT_COMMIT'), 'R41 bridge first-present latch already applied');

native = once(
  native,
  '  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED\n',
  `  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED
  uint64_t r41VisibilityBaselineFrames = 0; // LILAC_R41_FIRST_PRESENT_BEFORE_SHOW
  uint64_t r41VisibilityArmCount = 0;
  uint64_t r41VisibilityDeferredCount = 0;
  uint64_t r41VisibilityCommitCount = 0;
  uint64_t r41VisibilityHideCount = 0;
  uint64_t r41VisibilityPrematureShowCount = 0;
`,
  'R41 first-present visibility diagnostics'
);

const visibleStart = native.indexOf('napi_value SetNativePresenterVisible(');
const visibleEnd = native.indexOf('napi_value SetNativePresenterBounds(', visibleStart);
if (visibleStart < 0 || visibleEnd <= visibleStart) throw new Error('R41 SetNativePresenterVisible boundary missing');
let visibleBlock = native.slice(visibleStart, visibleEnd);
visibleBlock = once(
  visibleBlock,
  '  player->nativePresenterRequested.store(visible, std::memory_order_release);\n  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);',
  `  const bool r41WasRequested = player->nativePresenterRequested.exchange(visible, std::memory_order_acq_rel);
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  if (visible && !r41WasRequested) {
    player->r41VisibilityBaselineFrames = player->nativePresenterFrames;
    player->r41VisibilityArmCount += 1;
  }
  const bool r41FirstPresentReady = visible &&
    player->nativePresenterFrames > player->r41VisibilityBaselineFrames;`,
  'R41 visibility request baseline'
);
visibleBlock = once(
  visibleBlock,
  '        (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);',
  '        (r41FirstPresentReady ? SWP_SHOWWINDOW : (visible ? 0 : SWP_HIDEWINDOW));',
  'R41 defer SetWindowPos show until first Present'
);
visibleBlock = once(
  visibleBlock,
  '    ShowWindow(player->nativePresenterHwnd, visible ? SW_SHOWNOACTIVATE : SW_HIDE);\n    player->nativePresenterVisible = visible && IsWindowVisible(player->nativePresenterHwnd);',
  `    const bool r41WasWindowVisible = player->nativePresenterVisible &&
      IsWindowVisible(player->nativePresenterHwnd);
    if (!visible) {
      ShowWindow(player->nativePresenterHwnd, SW_HIDE);
      player->nativePresenterVisible = false;
      player->r41VisibilityHideCount += 1;
    } else if (r41FirstPresentReady) {
      ShowWindow(player->nativePresenterHwnd, SW_SHOWNOACTIVATE);
      player->nativePresenterVisible = IsWindowVisible(player->nativePresenterHwnd);
      if (!r41WasWindowVisible && player->nativePresenterVisible) player->r41VisibilityCommitCount += 1;
    } else {
      player->nativePresenterVisible = IsWindowVisible(player->nativePresenterHwnd);
      player->r41VisibilityDeferredCount += 1;
    }
    if (visible && player->nativePresenterVisible && !r41FirstPresentReady) {
      player->r41VisibilityPrematureShowCount += 1;
    }`,
  'R41 show/hide first-present latch'
);
native = native.slice(0, visibleStart) + visibleBlock + native.slice(visibleEnd);

native = once(
  native,
  '  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));\n',
  `  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));
  Set(env, out, "r41FirstPresentMarker", StringValue(env, "LILAC_R41_FIRST_PRESENT_BEFORE_SHOW"));
  Set(env, out, "r41FirstPresentBaselineFrames", DoubleValue(env, static_cast<double>(player->r41VisibilityBaselineFrames)));
  Set(env, out, "r41FirstPresentReady", BoolValue(env,
    player->nativePresenterRequested.load(std::memory_order_acquire) &&
    player->nativePresenterFrames > player->r41VisibilityBaselineFrames));
  Set(env, out, "r41VisibilityArmCount", DoubleValue(env, static_cast<double>(player->r41VisibilityArmCount)));
  Set(env, out, "r41VisibilityDeferredCount", DoubleValue(env, static_cast<double>(player->r41VisibilityDeferredCount)));
  Set(env, out, "r41VisibilityCommitCount", DoubleValue(env, static_cast<double>(player->r41VisibilityCommitCount)));
  Set(env, out, "r41VisibilityHideCount", DoubleValue(env, static_cast<double>(player->r41VisibilityHideCount)));
  Set(env, out, "r41VisibilityPrematureShowCount", DoubleValue(env, static_cast<double>(player->r41VisibilityPrematureShowCount)));
`,
  'R41 native presenter stats'
);

bridge = once(
  bridge,
  '  let r39LastPumpPhaseWallMs = 0;',
  `  let r39LastPumpPhaseWallMs = 0;
  let r41BlurCommitTimer = null; // LILAC_R41_BLUR_FIRST_PRESENT_COMMIT
  let r41BlurCommitEpoch = 0;
  let r41BlurCommitPolls = 0;
  let r41BlurCommitCount = 0;
  let r41BlurCommitTimeouts = 0;
  let r41BlurForcedRedrawRequests = 0;
  let r41BlurForcedRedrawAccepted = 0;
  let r41BlurLastCommitMs = 0;
  let r41BlurMaxCommitMs = 0;`,
  'R41 bridge handoff state'
);

bridge = once(
  bridge,
  '  function r32ApplyNativePresenterFocus(focused) {',
  `  function r41CancelBlurCommit() {
    r41BlurCommitEpoch += 1;
    if (r41BlurCommitTimer) {
      clearTimeout(r41BlurCommitTimer);
      r41BlurCommitTimer = null;
    }
  }

  function r41ArmBlurFirstPresentCommit() {
    r41CancelBlurCommit();
    const epoch = r41BlurCommitEpoch;
    const started = Date.now();
    const poll = () => {
      r41BlurCommitTimer = null;
      if (epoch !== r41BlurCommitEpoch || !addon || playerId == null ||
          !active || !r33NativePresenterActive) return;
      r41BlurCommitPolls += 1;
      let stats = null;
      try { stats = addon.nativePresenterStats(playerId); } catch {}
      if (!stats || stats.requestedVisible !== true) return;
      if (stats.r41FirstPresentReady === true) {
        try {
          addon.setNativePresenterVisible(playerId, true);
          const committed = addon.nativePresenterStats(playerId);
          if (committed?.windowVisible === true) {
            const elapsed = Math.max(0, Date.now() - started);
            r41BlurCommitCount += 1;
            r41BlurLastCommitMs = elapsed;
            r41BlurMaxCommitMs = Math.max(r41BlurMaxCommitMs, elapsed);
            return;
          }
        } catch (error) {
          lastError = 'R41 native first-present commit failed: ' +
            String(error?.message || error).slice(0, 180);
          return;
        }
      }
      if (Date.now() - started >= 750) {
        r41BlurCommitTimeouts += 1;
        return;
      }
      r41BlurCommitTimer = setTimeout(poll, 4);
    };
    r41BlurCommitTimer = setTimeout(poll, 0);
  }

  function r32ApplyNativePresenterFocus(focused) {`,
  'R41 commit helper insertion'
);

const focusStart = bridge.indexOf('  function r32ApplyNativePresenterFocus(focused) {');
const focusEnd = bridge.indexOf('\n\n  function ensurePlayer() {', focusStart);
if (focusStart < 0 || focusEnd <= focusStart) throw new Error('R41 focus helper boundary missing');
let focusBlock = bridge.slice(focusStart, focusEnd);
focusBlock = once(
  focusBlock,
  '    const useNative = !Boolean(focused) && active && r32TargetVisible;',
  `    const useNative = !Boolean(focused) && active && r32TargetVisible;
    if (!useNative) r41CancelBlurCommit();`,
  'R41 cancel commit on focus'
);
const oldVisibleTry = `    try { addon.setNativePresenterVisible(playerId, useNative); } catch (error) {
      lastError = \`R33 owned popup focus failed: \${String(error?.message || error).slice(0, 180)}\`;
      r33NativePresenterActive = false;
    }`;
const newVisibleTry = `    try {
      addon.setNativePresenterVisible(playerId, useNative);
      if (useNative) {
        if (frameProducerStarted && typeof addon.requestFrameProducerRedraw === 'function') {
          r41BlurForcedRedrawRequests += 1;
          if (addon.requestFrameProducerRedraw(playerId) === true) r41BlurForcedRedrawAccepted += 1;
        }
        r41ArmBlurFirstPresentCommit();
      }
    } catch (error) {
      lastError = \`R41 owned popup first-present focus failed: \${String(error?.message || error).slice(0, 180)}\`;
      r33NativePresenterActive = false;
      r41CancelBlurCommit();
    }`;
focusBlock = once(focusBlock, oldVisibleTry, newVisibleTry, 'R41 blur redraw + commit arm');
bridge = bridge.slice(0, focusStart) + focusBlock + bridge.slice(focusEnd);

bridge = once(
  bridge,
  '        geometryResyncs: r33GeometryResyncs,',
  `        geometryResyncs: r33GeometryResyncs,
        r41FirstPresentCommit: {
          marker: 'LILAC_R41_BLUR_FIRST_PRESENT_COMMIT',
          polls: r41BlurCommitPolls,
          commits: r41BlurCommitCount,
          timeouts: r41BlurCommitTimeouts,
          forcedRedrawRequests: r41BlurForcedRedrawRequests,
          forcedRedrawAccepted: r41BlurForcedRedrawAccepted,
          lastCommitMs: r41BlurLastCommitMs,
          maxCommitMs: r41BlurMaxCommitMs
        },`,
  'R41 bridge diagnostics export'
);

for (const marker of ['LILAC_R41_FIRST_PRESENT_BEFORE_SHOW','r41FirstPresentReady','r41VisibilityPrematureShowCount']) {
  assert(native.includes(marker), `R41 native marker missing: ${marker}`);
}
for (const marker of ['LILAC_R41_BLUR_FIRST_PRESENT_COMMIT','r41ArmBlurFirstPresentCommit','r41BlurForcedRedrawAccepted']) {
  assert(bridge.includes(marker), `R41 bridge marker missing: ${marker}`);
}
const presentStart = native.indexOf('void R32PresentNativeFrame(');
const presentEnd = native.indexOf('bool SetOption(Player* player, const char* key, const char* value, std::string* error) {', presentStart);
if (presentStart < 0 || presentEnd <= presentStart) throw new Error('R41 native present function boundary missing');
const presentBody = native.slice(presentStart, presentEnd);
for (const forbidden of ['SetWindowPos(', 'ShowWindow(', 'GetClientRect(', 'ClientToScreen(']) {
  if (presentBody.includes(forbidden)) throw new Error(`R41 reintroduced worker HWND mutation: ${forbidden}`);
}
if (bridge.includes('focus-staged-gpu-copy') || bridge.includes('copyTextureToTexture')) {
  throw new Error('R41 resurrected forbidden R28 staged WebGPU path');
}
if (native.includes('--disable-direct-composition')) {
  throw new Error('R41 resurrected forbidden R25 Direct Composition disable');
}

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
console.log('R41_FIRST_PRESENT_LATCH_OK blur=arm+forced-redraw+first-present-commit workerHWND=unchanged focus=direct-webgpu r33=owned-popup r37=preserved r39=topmost-preserved');

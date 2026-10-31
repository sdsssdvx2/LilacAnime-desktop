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
function section(source, startNeedle, endNeedle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(`${label}: structural boundary missing`);
  if (source.indexOf(startNeedle, start + startNeedle.length) >= 0) throw new Error(`${label}: start boundary not unique`);
  return source.slice(0, start) + replacement + source.slice(end);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');

for (const marker of [
  'LILAC_R33_OWNED_POPUP_FOCUS_SURFACE',
  'LILAC_R33_NATIVE_ONLY_UNFOCUSED',
  'LILAC_R33_PRESENT_RESULT_PROOF',
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R39_REFOCUS_PHASE_REANCHOR',
  'LILAC_R39_TOPMOST_BIDIRECTIONAL',
  'LILAC_R40_HANDOFF_FORCE_REDRAW',
  'requestFrameProducerRedraw'
]) assert(native.includes(marker) || bridge.includes(marker), `R41 requires qualified R40 baseline: ${marker}`);
assert(!native.includes('LILAC_R41_FIRST_PRESENT_BEFORE_FULL_EXPOSURE'), 'R41 native warmup latch already applied');
assert(!bridge.includes('LILAC_R41_BLUR_FIRST_PRESENT_COMMIT'), 'R41 bridge warmup latch already applied');

native = once(
  native,
  '  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED\n',
  `  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED
  uint64_t r41VisibilityBaselineFrames = 0; // LILAC_R41_FIRST_PRESENT_BEFORE_FULL_EXPOSURE
  bool r41WarmupPending = false;
  bool r41FullExposureCommitted = false;
  uint64_t r41WarmupArmCount = 0;
  uint64_t r41WarmupShowCount = 0;
  uint64_t r41FullExposureCommitCount = 0;
  uint64_t r41VisibilityHideCount = 0;
  uint64_t r41PrematureFullExposureCount = 0;
  uint32_t r41WarmupMaxWidth = 0;
  uint32_t r41WarmupMaxHeight = 0;
`,
  'R41 warmup visibility diagnostics'
);

const visibilityReplacement = String.raw`RECT R41PresenterExposureRectLocked(Player* player, const RECT& fullRect, bool allowFullExposure) {
  RECT exposure = fullRect;
  if (player && player->r41WarmupPending && !allowFullExposure) {
    exposure.left = std::max<LONG>(fullRect.left, fullRect.right - 2);
    exposure.top = std::max<LONG>(fullRect.top, fullRect.bottom - 2);
    if (exposure.right <= exposure.left) exposure.right = exposure.left + 2;
    if (exposure.bottom <= exposure.top) exposure.bottom = exposure.top + 2;
  }
  return exposure;
}

napi_value SetNativePresenterVisible(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  bool visible = false;
  if (argc < 2 || !ReadUint32(env, argv[0], &id) || napi_get_value_bool(env, argv[1], &visible) != napi_ok) {
    Throw(env, "setNativePresenterVisible(playerId, visible) requires id and boolean");
    return nullptr;
  }
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return BoolValue(env, false);

  // Preserve R33's proven show-before-producer-arm ordering: a fully hidden HWND
  // can return DXGI_STATUS_OCCLUDED. R41 instead exposes only a 2x2 owned-popup
  // warmup surface, arms the producer, waits for an S_OK Present, and only then
  // allows this main-thread API to expand to the full video rectangle.
  if (!visible) player->nativePresenterRequested.store(false, std::memory_order_release);
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  const bool wasRequested = player->nativePresenterRequested.load(std::memory_order_acquire);
  if (visible && !wasRequested) {
    player->r41VisibilityBaselineFrames = player->nativePresenterFrames;
    player->r41WarmupPending = true;
    player->r41FullExposureCommitted = false;
    player->r41WarmupArmCount += 1;
  }
  const bool firstPresentReady = visible &&
    player->nativePresenterFrames > player->r41VisibilityBaselineFrames;
  const bool allowFullExposure = visible &&
    (!player->r41WarmupPending || firstPresentReady);

  bool actuallyVisible = false;
  bool usingWarmup = false;
  if (player->nativePresenterHwnd && IsWindow(player->nativePresenterHwnd)) {
    RECT screenRect{};
    std::string geometryError;
    if (R33PresenterScreenRect(player, &screenRect, &geometryError)) {
      const RECT exposureRect = R41PresenterExposureRectLocked(player, screenRect, allowFullExposure);
      const LONG exposureWidth = std::max<LONG>(2, exposureRect.right - exposureRect.left);
      const LONG exposureHeight = std::max<LONG>(2, exposureRect.bottom - exposureRect.top);
      usingWarmup = visible && player->r41WarmupPending && !allowFullExposure;
      if (usingWarmup) {
        player->r41WarmupMaxWidth = std::max<uint32_t>(player->r41WarmupMaxWidth, static_cast<uint32_t>(exposureWidth));
        player->r41WarmupMaxHeight = std::max<uint32_t>(player->r41WarmupMaxHeight, static_cast<uint32_t>(exposureHeight));
        if (exposureWidth > 2 || exposureHeight > 2) player->r41PrematureFullExposureCount += 1;
      }
      const bool r39OwnerTopmost = player->nativePresenterParent &&
        (GetWindowLongPtrW(player->nativePresenterParent, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
      const HWND r39InsertAfter = r39OwnerTopmost ? HWND_TOPMOST : nullptr;
      const UINT r39Flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER |
        (r39OwnerTopmost ? 0 : SWP_NOZORDER) |
        (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);
      SetWindowPos(player->nativePresenterHwnd, r39InsertAfter,
                   exposureRect.left, exposureRect.top,
                   exposureWidth, exposureHeight,
                   r39Flags); // LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC
    } else if (visible) {
      player->nativePresenterLastError = geometryError;
    }
    ShowWindow(player->nativePresenterHwnd, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
    actuallyVisible = visible && IsWindowVisible(player->nativePresenterHwnd);
  }
  player->nativePresenterVisible = actuallyVisible;
  if (visible) {
    player->nativePresenterRequested.store(actuallyVisible, std::memory_order_release);
    if (actuallyVisible && usingWarmup) player->r41WarmupShowCount += 1;
    if (actuallyVisible && player->r41WarmupPending && firstPresentReady) {
      player->r41WarmupPending = false;
      player->r41FullExposureCommitted = true;
      player->r41FullExposureCommitCount += 1;
    }
  } else {
    player->r41WarmupPending = false;
    player->r41FullExposureCommitted = false;
    player->r41VisibilityHideCount += 1;
  }
  return BoolValue(env, !visible || actuallyVisible);
}

`;
native = section(
  native,
  'napi_value SetNativePresenterVisible(',
  'napi_value SetNativePresenterBounds(',
  visibilityReplacement,
  'R41 warmup visibility function'
);

const boundsStart = native.indexOf('napi_value SetNativePresenterBounds(');
const boundsEnd = native.indexOf('napi_value NativePresenterStats(', boundsStart);
if (boundsStart < 0 || boundsEnd <= boundsStart) throw new Error('R41 native bounds boundary missing');
let boundsBlock = native.slice(boundsStart, boundsEnd);
boundsBlock = once(
  boundsBlock,
  `    SetWindowPos(player->nativePresenterHwnd, nullptr,
                 screenRect.left, screenRect.top,
                 std::max<LONG>(2, screenRect.right - screenRect.left),
                 std::max<LONG>(2, screenRect.bottom - screenRect.top),
                 SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER);`,
  `    const RECT r41ExposureRect = R41PresenterExposureRectLocked(
      player, screenRect, !player->r41WarmupPending);
    const LONG r41ExposureWidth = std::max<LONG>(2, r41ExposureRect.right - r41ExposureRect.left);
    const LONG r41ExposureHeight = std::max<LONG>(2, r41ExposureRect.bottom - r41ExposureRect.top);
    if (player->r41WarmupPending) {
      player->r41WarmupMaxWidth = std::max<uint32_t>(player->r41WarmupMaxWidth, static_cast<uint32_t>(r41ExposureWidth));
      player->r41WarmupMaxHeight = std::max<uint32_t>(player->r41WarmupMaxHeight, static_cast<uint32_t>(r41ExposureHeight));
      if (r41ExposureWidth > 2 || r41ExposureHeight > 2) player->r41PrematureFullExposureCount += 1;
    }
    SetWindowPos(player->nativePresenterHwnd, nullptr,
                 r41ExposureRect.left, r41ExposureRect.top,
                 r41ExposureWidth, r41ExposureHeight,
                 SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER);`,
  'R41 keep bounds sync inside warmup surface'
);
native = native.slice(0, boundsStart) + boundsBlock + native.slice(boundsEnd);

native = once(
  native,
  '  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));\n',
  `  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));
  Set(env, out, "r41FirstPresentMarker", StringValue(env, "LILAC_R41_FIRST_PRESENT_BEFORE_FULL_EXPOSURE"));
  Set(env, out, "r41FirstPresentBaselineFrames", DoubleValue(env, static_cast<double>(player->r41VisibilityBaselineFrames)));
  Set(env, out, "r41FirstPresentReady", BoolValue(env,
    player->nativePresenterRequested.load(std::memory_order_acquire) &&
    player->nativePresenterFrames > player->r41VisibilityBaselineFrames));
  Set(env, out, "r41WarmupPending", BoolValue(env, player->r41WarmupPending));
  Set(env, out, "r41FullExposureCommitted", BoolValue(env, player->r41FullExposureCommitted));
  Set(env, out, "r41WarmupArmCount", DoubleValue(env, static_cast<double>(player->r41WarmupArmCount)));
  Set(env, out, "r41WarmupShowCount", DoubleValue(env, static_cast<double>(player->r41WarmupShowCount)));
  Set(env, out, "r41FullExposureCommitCount", DoubleValue(env, static_cast<double>(player->r41FullExposureCommitCount)));
  Set(env, out, "r41VisibilityHideCount", DoubleValue(env, static_cast<double>(player->r41VisibilityHideCount)));
  Set(env, out, "r41PrematureFullExposureCount", DoubleValue(env, static_cast<double>(player->r41PrematureFullExposureCount)));
  Set(env, out, "r41WarmupMaxWidth", DoubleValue(env, static_cast<double>(player->r41WarmupMaxWidth)));
  Set(env, out, "r41WarmupMaxHeight", DoubleValue(env, static_cast<double>(player->r41WarmupMaxHeight)));
`,
  'R41 native presenter warmup stats'
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
          if (committed?.windowVisible === true && committed?.r41FullExposureCommitted === true) {
            const elapsed = Math.max(0, Date.now() - started);
            r41BlurCommitCount += 1;
            r41BlurLastCommitMs = elapsed;
            r41BlurMaxCommitMs = Math.max(r41BlurMaxCommitMs, elapsed);
            return;
          }
        } catch (error) {
          lastError = 'R41 native warmup exposure commit failed: ' +
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
  'R41 warmup commit helper insertion'
);

const focusStart = bridge.indexOf('  function r32ApplyNativePresenterFocus(focused) {');
const focusEnd = bridge.indexOf('\n\n  function ensurePlayer() {', focusStart);
if (focusStart < 0 || focusEnd <= focusStart) throw new Error('R41 focus helper boundary missing');
let focusBlock = bridge.slice(focusStart, focusEnd);
focusBlock = once(
  focusBlock,
  `    r39ReanchorPumpPhase(Boolean(focused) ? 'focus' : 'blur', Boolean(focused));`,
  `    r39ReanchorPumpPhase(Boolean(focused) ? 'focus' : 'blur', Boolean(focused));
    if (Boolean(focused)) r41CancelBlurCommit();`,
  'R41 cancel warmup commit on focus'
);
focusBlock = once(
  focusBlock,
  `    const accepted = addon.setNativePresenterVisible(playerId, useNative);
    nativeReady = useNative && accepted === true;
    r33NativePresenterActive = nativeReady;
    r34SetNativeSubtitleVisible(nativeReady, 'blur-native');`,
  `    const accepted = addon.setNativePresenterVisible(playerId, useNative);
    nativeReady = useNative && accepted === true;
    r33NativePresenterActive = nativeReady;
    r34SetNativeSubtitleVisible(nativeReady, 'blur-native');
    if (nativeReady) {
      if (frameProducerStarted && typeof addon.requestFrameProducerRedraw === 'function') {
        r41BlurForcedRedrawRequests += 1;
        try {
          if (addon.requestFrameProducerRedraw(playerId) === true) r41BlurForcedRedrawAccepted += 1;
        } catch (redrawError) {
          lastError = 'R41 blur warmup redraw request failed: ' + String(redrawError?.message || redrawError).slice(0, 180);
        }
      }
      r41ArmBlurFirstPresentCommit();
    }`,
  'R41 blur warmup redraw + commit arm'
);
bridge = bridge.slice(0, focusStart) + focusBlock + bridge.slice(focusEnd);

bridge = once(
  bridge,
  '        geometryResyncs: r33GeometryResyncs,',
  `        geometryResyncs: r33GeometryResyncs,
        r41FirstPresentCommit: {
          marker: 'LILAC_R41_BLUR_FIRST_PRESENT_COMMIT',
          mode: '2x2-visible-warmup-then-full-exposure',
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

for (const marker of ['LILAC_R41_FIRST_PRESENT_BEFORE_FULL_EXPOSURE','r41WarmupPending','r41FullExposureCommitted','r41PrematureFullExposureCount']) {
  assert(native.includes(marker), `R41 native marker missing: ${marker}`);
}
for (const marker of ['LILAC_R41_BLUR_FIRST_PRESENT_COMMIT','r41ArmBlurFirstPresentCommit','r41BlurForcedRedrawAccepted']) {
  assert(bridge.includes(marker), `R41 bridge marker missing: ${marker}`);
}
const presentStart = native.indexOf('bool R32PresentNativeFrame(');
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
console.log('R41_FIRST_PRESENT_LATCH_OK blur=2x2-visible-warmup+producer-redraw+S_OK-before-full-exposure workerHWND=unchanged r33=show-before-arm-preserved r37=preserved r39=topmost-preserved focus=direct-webgpu');

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
  if (count !== 1) throw new Error(label + ': expected exactly one anchor, found ' + count);
  return source.replace(needle, replacement);
}
function replaceInside(source, startNeedle, endNeedle, needle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(label + ': function boundary missing');
  const block = source.slice(start, end);
  const patched = replaceOnce(block, needle, replacement, label);
  return source.slice(0, start) + patched + source.slice(end);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');
let entry = read('src/libmpv-shared-entry.js');
let app = read('src/app.js');

for (const marker of ['LILAC_R34_HANDOFF_SENT_ACK','LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY','r34FocusHandoffSentFrames','r35FocusRedrawArms']) {
  if (!bridge.includes(marker)) throw new Error('R36 requires R35 handoff baseline: ' + marker);
}
for (const marker of ['LILAC_R33_OWNED_POPUP_FOCUS_SURFACE','LILAC_R33_NATIVE_ONLY_UNFOCUSED','LILAC_R34_NONBLOCKING_PRESENT']) {
  if (!native.includes(marker)) throw new Error('R36 requires R33/R34 native presenter baseline: ' + marker);
}
if (!entry.includes('LILAC_R35_ASS_PLACEMENT_RECOVERY') || !app.includes('track.dataset.lilacNativePath')) {
  throw new Error('R36 requires R35/R32 subtitle baseline');
}
if (bridge.includes('LILAC_R36_HANDOFF_ACK_ORDER') || native.includes('LILAC_R36_UNFOCUSED_HTML_UI_HOLES') || entry.includes('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC')) {
  throw new Error('R36 already applied');
}

// ---------------------------------------------------------------------------
// 1) Fix the real R35 release-before-send bookkeeping race.
// Electron may emit allReferencesReleased before the awaited send call resumes.
// Track both halves independently so either ordering can finish the handoff.
// ---------------------------------------------------------------------------
bridge = replaceOnce(
  bridge,
  '  const r34FocusHandoffSentFrames = new Set();',
  `  const r34FocusHandoffSentFrames = new Set(); // LILAC_R36_HANDOFF_ACK_ORDER
  const r36FocusHandoffReleasedFrames = new Set();
  const R36_HANDOFF_FAIL_OPEN_MS = 1500;
  const R36_SUPPLY_GAP_CAPACITY = 48;
  const r36SupplyGaps = new Array(R36_SUPPLY_GAP_CAPACITY);
  let r36SupplyGapNext = 0;
  let r36SupplyGapCount = 0;
  let r36ReleaseBeforeSend = 0;
  let r36SendAfterRelease = 0;
  let r36AckCompletions = 0;
  let r36MirrorArmFailures = 0;
  let r36FailOpenCount = 0;
  let r36LastFailOpenWallMs = 0;
  let r36HandoffFailOpenTimer = null;`,
  'R36 ack-order state'
);

const r36Helpers = String.raw`
  function r36ClearHandoffFailOpen() {
    if (r36HandoffFailOpenTimer) clearTimeout(r36HandoffFailOpenTimer);
    r36HandoffFailOpenTimer = null;
  }

  function r36PushSupplyGap(entry) {
    r36SupplyGaps[r36SupplyGapNext] = entry;
    r36SupplyGapNext = (r36SupplyGapNext + 1) % R36_SUPPLY_GAP_CAPACITY;
    r36SupplyGapCount = Math.min(R36_SUPPLY_GAP_CAPACITY, r36SupplyGapCount + 1);
  }

  function r36SnapshotSupplyGaps() {
    const out = [];
    const start = (r36SupplyGapNext - r36SupplyGapCount + R36_SUPPLY_GAP_CAPACITY) % R36_SUPPLY_GAP_CAPACITY;
    for (let i = 0; i < r36SupplyGapCount; i += 1) out.push({ ...r36SupplyGaps[(start + i) % R36_SUPPLY_GAP_CAPACITY] });
    return out;
  }

  function r36ArmHandoffFailOpen() {
    r36ClearHandoffFailOpen();
    const minFrameId = r34FocusHandoffMinFrameId;
    r36HandoffFailOpenTimer = setTimeout(() => {
      r36HandoffFailOpenTimer = null;
      if (!r34FocusHandoffPending || r34FocusHandoffMinFrameId !== minFrameId) return;
      const focused = Boolean(attachedWindow && !attachedWindow.isDestroyed?.() && attachedWindow.isFocused?.());
      if (!focused) return;
      r36FailOpenCount += 1;
      r36LastFailOpenWallMs = Date.now();
      r34FocusHandoffPending = false;
      r34FocusHandoffMinFrameId = 0;
      r34FocusHandoffStartedWallMs = 0;
      r34FocusHandoffSentFrames.clear();
      r36FocusHandoffReleasedFrames.clear();
      try { addon.setNativePresenterMirrorChromium(playerId, false); } catch {}
      r34SetNativeSubtitleVisible(false, 'r36-focus-fail-open');
      try { addon.setNativePresenterVisible(playerId, false); } catch {}
      r33NativePresenterActive = false;
      r27LastDispatchWallMs = 0;
    }, R36_HANDOFF_FAIL_OPEN_MS);
  }

`;
bridge = replaceOnce(
  bridge,
  "  function r34SetNativeSubtitleVisible(visible, reason = 'focus') {",
  r36Helpers + "  function r34SetNativeSubtitleVisible(visible, reason = 'focus') {",
  'R36 helper insertion'
);

bridge = replaceInside(
  bridge,
  '  function r34SetNativeSubtitleVisible(',
  '  function r34CancelFocusHandoff(',
  '    if (!addon || playerId == null || !active) return false;',
  '    if (!addon || playerId == null) return false;',
  'R36 subtitle visibility guard'
);

for (const [start, end, label] of [
  ['  function r34CancelFocusHandoff(', '  function r34BeginFocusHandoff(', 'cancel'],
  ['  function r34BeginFocusHandoff(', '  function r34CompleteFocusHandoff(', 'begin'],
  ['  function r34CompleteFocusHandoff(', '  function r32ApplyNativePresenterFocus(', 'complete']
]) {
  bridge = replaceInside(
    bridge,
    start,
    end,
    '    r34FocusHandoffSentFrames.clear();\n',
    '    r34FocusHandoffSentFrames.clear();\n    r36FocusHandoffReleasedFrames.clear();\n    r36ClearHandoffFailOpen();\n',
    'R36 ' + label + ' lifecycle reset'
  );
}

bridge = replaceInside(
  bridge,
  '  function r34BeginFocusHandoff(',
  '  function r34CompleteFocusHandoff(',
  `    try {
      return addon.setNativePresenterMirrorChromium(playerId, true) === true;
    } catch (error) {`,
  `    try {
      const armed = addon.setNativePresenterMirrorChromium(playerId, true) === true;
      if (armed) {
        r36ArmHandoffFailOpen();
        return true;
      }
      r36MirrorArmFailures += 1;
      r34FocusHandoffPending = false;
      r34FocusHandoffMinFrameId = 0;
      r34FocusHandoffStartedWallMs = 0;
      r34FocusHandoffSentFrames.clear();
      r36FocusHandoffReleasedFrames.clear();
      return false;
    } catch (error) {`,
  'R36 mirror arm hardening'
);

bridge = replaceOnce(
  bridge,
  '      if (r33NativePresenterActive && r34BeginFocusHandoff()) {',
  '      if (r33NativePresenterActive && active && r32TargetVisible && r34BeginFocusHandoff()) {',
  'R36 active focus handoff gate'
);

bridge = replaceOnce(
  bridge,
  '    r34CompleteFocusHandoff(ownerPlayerId, frameId);',
  `    if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {
      const releasedFrameId = Number(frameId);
      if (!r34FocusHandoffSentFrames.has(releasedFrameId)) r36ReleaseBeforeSend += 1;
      r36FocusHandoffReleasedFrames.add(releasedFrameId);
      while (r36FocusHandoffReleasedFrames.size > 24) r36FocusHandoffReleasedFrames.delete(r36FocusHandoffReleasedFrames.values().next().value);
    }
    r34CompleteFocusHandoff(ownerPlayerId, frameId);`,
  'R36 release-before-send tracking'
);

const oldSentMark = `      if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {
        r34FocusHandoffSentFrames.add(Number(frameId));
        while (r34FocusHandoffSentFrames.size > 24) r34FocusHandoffSentFrames.delete(r34FocusHandoffSentFrames.values().next().value);
      }
`;
const newSentMark = `      if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {
        const sentFrameId = Number(frameId);
        r34FocusHandoffSentFrames.add(sentFrameId);
        if (r36FocusHandoffReleasedFrames.has(sentFrameId)) {
          r36SendAfterRelease += 1;
          r34CompleteFocusHandoff(ownerPlayerId, sentFrameId);
        }
        while (r34FocusHandoffSentFrames.size > 24) r34FocusHandoffSentFrames.delete(r34FocusHandoffSentFrames.values().next().value);
      }
`;
bridge = replaceOnce(bridge, oldSentMark, newSentMark, 'R36 send-after-release completion');

bridge = replaceInside(
  bridge,
  '  function r34CompleteFocusHandoff(',
  '  function r32ApplyNativePresenterFocus(',
  '    r34FocusHandoffCompleted += 1;\n',
  '    r34FocusHandoffCompleted += 1;\n    r36AckCompletions += 1;\n',
  'R36 ack completion counter'
);

// ---------------------------------------------------------------------------
// 2) Keep unfocused native video, but punch precise holes through the owned popup
// for currently-visible Chromium player controls. Region updates happen only on
// UI/layout changes on Electron main; the producer thread remains CopyResource +
// nonblocking Present only. This fixes the structural R33 UI-covering regression.
// ---------------------------------------------------------------------------
native = replaceOnce(
  native,
  '  uint64_t r34PresentBusyFrames = 0; // LILAC_R34_NONBLOCKING_PRESENT\n',
  `  uint64_t r34PresentBusyFrames = 0; // LILAC_R34_NONBLOCKING_PRESENT
  RECT r36UiHoles[24]{}; // LILAC_R36_UNFOCUSED_HTML_UI_HOLES
  uint32_t r36UiHoleCount = 0;
  uint64_t r36UiRegionUpdates = 0;
  uint64_t r36UiRegionFailures = 0;
  std::string r36UiRegionLastError;
`,
  'R36 native UI-hole state'
);

const r36RegionHelpers = String.raw`
bool R36ApplyPresenterRegionLocked(Player* player, std::string* error) {
  if (!player || !player->nativePresenterHwnd || !IsWindow(player->nativePresenterHwnd)) {
    if (error) *error = "native presenter HWND unavailable for UI region";
    return false;
  }
  if (player->r36UiHoleCount == 0) {
    if (!SetWindowRgn(player->nativePresenterHwnd, nullptr, TRUE)) {
      const std::string message = "SetWindowRgn clear failed win32=" + std::to_string(GetLastError());
      player->r36UiRegionFailures += 1;
      player->r36UiRegionLastError = message;
      if (error) *error = message;
      return false;
    }
    player->r36UiRegionUpdates += 1;
    player->r36UiRegionLastError.clear();
    return true;
  }

  const int width = static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsWidth));
  const int height = static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsHeight));
  HRGN visible = CreateRectRgn(0, 0, width, height);
  if (!visible) {
    const std::string message = "CreateRectRgn full presenter failed win32=" + std::to_string(GetLastError());
    player->r36UiRegionFailures += 1;
    player->r36UiRegionLastError = message;
    if (error) *error = message;
    return false;
  }
  for (uint32_t i = 0; i < player->r36UiHoleCount; ++i) {
    const RECT hole = player->r36UiHoles[i];
    HRGN cut = CreateRectRgn(hole.left, hole.top, hole.right, hole.bottom);
    if (!cut || CombineRgn(visible, visible, cut, RGN_DIFF) == ERROR) {
      if (cut) DeleteObject(cut);
      DeleteObject(visible);
      const std::string message = "CombineRgn UI hole failed win32=" + std::to_string(GetLastError());
      player->r36UiRegionFailures += 1;
      player->r36UiRegionLastError = message;
      if (error) *error = message;
      return false;
    }
    DeleteObject(cut);
  }
  if (!SetWindowRgn(player->nativePresenterHwnd, visible, TRUE)) {
    DeleteObject(visible); // ownership transfers only on success
    const std::string message = "SetWindowRgn UI holes failed win32=" + std::to_string(GetLastError());
    player->r36UiRegionFailures += 1;
    player->r36UiRegionLastError = message;
    if (error) *error = message;
    return false;
  }
  player->r36UiRegionUpdates += 1;
  player->r36UiRegionLastError.clear();
  return true;
}

`;
native = replaceOnce(
  native,
  'napi_value SetNativePresenterVisible(napi_env env, napi_callback_info info) {',
  r36RegionHelpers + 'napi_value SetNativePresenterVisible(napi_env env, napi_callback_info info) {',
  'R36 region helper insertion'
);

native = replaceInside(
  native,
  'napi_value SetNativePresenterBounds(',
  'napi_value NativePresenterStats(',
  `    SetWindowPos(player->nativePresenterHwnd, nullptr,
                 screenRect.left, screenRect.top,
                 std::max<LONG>(2, screenRect.right - screenRect.left),
                 std::max<LONG>(2, screenRect.bottom - screenRect.top),
                 SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER);`,
  `    SetWindowPos(player->nativePresenterHwnd, nullptr,
                 screenRect.left, screenRect.top,
                 std::max<LONG>(2, screenRect.right - screenRect.left),
                 std::max<LONG>(2, screenRect.bottom - screenRect.top),
                 SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER);
    std::string r36RegionError;
    R36ApplyPresenterRegionLocked(player, &r36RegionError);`,
  'R36 reapply UI holes after bounds'
);

const r36UiHolesApi = String.raw`
napi_value SetNativePresenterUiHoles(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  bool isArray = false;
  if (argc < 2 || !ReadUint32(env, argv[0], &id) || napi_is_array(env, argv[1], &isArray) != napi_ok || !isArray) {
    Throw(env, "setNativePresenterUiHoles(playerId, flatRects) requires id and numeric array");
    return nullptr;
  }
  uint32_t length = 0;
  if (napi_get_array_length(env, argv[1], &length) != napi_ok || length > 96 || (length % 4) != 0) {
    Throw(env, "setNativePresenterUiHoles flatRects must contain at most 24 x/y/width/height rectangles");
    return nullptr;
  }
  int32_t raw[96]{};
  for (uint32_t i = 0; i < length; ++i) {
    napi_value value;
    if (napi_get_element(env, argv[1], i, &value) != napi_ok || napi_get_value_int32(env, value, &raw[i]) != napi_ok) {
      Throw(env, "setNativePresenterUiHoles flatRects values must be int32 numbers");
      return nullptr;
    }
  }

  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return BoolValue(env, false);
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  const int maxWidth = static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsWidth));
  const int maxHeight = static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsHeight));
  uint32_t count = 0;
  for (uint32_t i = 0; i + 3 < length && count < 24; i += 4) {
    const int x = raw[i], y = raw[i + 1], width = raw[i + 2], height = raw[i + 3];
    if (width <= 0 || height <= 0) continue;
    RECT hole{};
    hole.left = std::max(0, std::min(maxWidth, x));
    hole.top = std::max(0, std::min(maxHeight, y));
    hole.right = std::max(0, std::min(maxWidth, x + width));
    hole.bottom = std::max(0, std::min(maxHeight, y + height));
    if (hole.right <= hole.left || hole.bottom <= hole.top) continue;
    player->r36UiHoles[count++] = hole;
  }
  player->r36UiHoleCount = count;
  std::string error;
  if (!player->nativePresenterHwnd || !IsWindow(player->nativePresenterHwnd)) return BoolValue(env, true);
  const bool ok = R36ApplyPresenterRegionLocked(player, &error);
  if (!ok) player->nativePresenterLastError = error;
  return BoolValue(env, ok);
}

`;
native = replaceOnce(
  native,
  'napi_value NativePresenterStats(napi_env env, napi_callback_info info) {',
  r36UiHolesApi + 'napi_value NativePresenterStats(napi_env env, napi_callback_info info) {',
  'R36 UI-hole N-API'
);

native = replaceOnce(
  native,
  '    {"nativePresenterStats", nullptr, NativePresenterStats, nullptr, nullptr, nullptr, napi_default, nullptr},',
  '    {"setNativePresenterUiHoles", nullptr, SetNativePresenterUiHoles, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"nativePresenterStats", nullptr, NativePresenterStats, nullptr, nullptr, nullptr, napi_default, nullptr},',
  'R36 UI-hole export'
);

native = replaceOnce(
  native,
  '  Set(env, out, "r34PresentBusyFrames", DoubleValue(env, static_cast<double>(player->r34PresentBusyFrames)));\n',
  `  Set(env, out, "r34PresentBusyFrames", DoubleValue(env, static_cast<double>(player->r34PresentBusyFrames)));
  Set(env, out, "r36UiHoleCount", Uint32Value(env, player->r36UiHoleCount));
  Set(env, out, "r36UiRegionUpdates", DoubleValue(env, static_cast<double>(player->r36UiRegionUpdates)));
  Set(env, out, "r36UiRegionFailures", DoubleValue(env, static_cast<double>(player->r36UiRegionFailures)));
  Set(env, out, "r36UiRegionLastError", StringValue(env, player->r36UiRegionLastError));
  bool r36FirstHoleExcluded = false;
  int32_t r36RegionType = 0;
  if (player->r36UiHoleCount > 0 && player->nativePresenterHwnd && IsWindow(player->nativePresenterHwnd)) {
    HRGN probe = CreateRectRgn(0, 0, 1, 1);
    if (probe) {
      r36RegionType = GetWindowRgn(player->nativePresenterHwnd, probe);
      if (r36RegionType != ERROR) {
        const RECT hole = player->r36UiHoles[0];
        const int cx = hole.left + std::max<LONG>(0, hole.right - hole.left - 1) / 2;
        const int cy = hole.top + std::max<LONG>(0, hole.bottom - hole.top - 1) / 2;
        r36FirstHoleExcluded = PtInRegion(probe, cx, cy) == FALSE;
      }
      DeleteObject(probe);
    }
  }
  Set(env, out, "r36UiRegionType", Int32Value(env, r36RegionType));
  Set(env, out, "r36FirstHoleExcluded", BoolValue(env, r36FirstHoleExcluded));
`,
  'R36 UI-hole diagnostics'
);

bridge = replaceOnce(
  bridge,
  '  let r32TargetVisible = true;',
  '  let r32TargetVisible = true;\n  let r36TargetUiHoles = []; // LILAC_R36_UNFOCUSED_HTML_UI_HOLES',
  'R36 bridge UI-hole state'
);

bridge = replaceOnce(
  bridge,
  `    if (typeof value.visible === 'boolean') r32TargetVisible = value.visible;
    return { x: r32TargetX, y: r32TargetY, width: targetWidth, height: targetHeight, visible: r32TargetVisible };`,
  `    if (typeof value.visible === 'boolean') r32TargetVisible = value.visible;
    if (Array.isArray(value.uiHoles)) {
      const flat = [];
      for (let i = 0; i + 3 < value.uiHoles.length && flat.length < 96; i += 4) {
        const x = Math.round(Number(value.uiHoles[i]));
        const y = Math.round(Number(value.uiHoles[i + 1]));
        const width = Math.round(Number(value.uiHoles[i + 2]));
        const height = Math.round(Number(value.uiHoles[i + 3]));
        if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) flat.push(x, y, width, height);
      }
      r36TargetUiHoles = flat;
    }
    return { x: r32TargetX, y: r32TargetY, width: targetWidth, height: targetHeight, visible: r32TargetVisible, uiHoles: r36TargetUiHoles.slice() };`,
  'R36 bridge UI-hole payload'
);

const r36BridgeHoleHelper = String.raw`  function r36SyncNativePresenterUiHoles() {
    if (!addon || playerId == null || typeof addon.setNativePresenterUiHoles !== 'function') return false;
    try {
      return addon.setNativePresenterUiHoles(playerId, r36TargetUiHoles) === true;
    } catch (error) {
      lastError = 'R36 native presenter UI region failed: ' + String(error?.message || error).slice(0, 180);
      return false;
    }
  }

`;
bridge = replaceOnce(
  bridge,
  '  function r32SyncNativePresenterBounds() {',
  r36BridgeHoleHelper + '  function r32SyncNativePresenterBounds() {',
  'R36 bridge UI-hole helper insertion'
);
bridge = replaceInside(
  bridge,
  '  function r32SyncNativePresenterBounds()',
  '  function r32ConfigureNativePresenter()',
  '      return addon.setNativePresenterBounds(playerId, r32TargetX, r32TargetY, targetWidth, targetHeight) === true;',
  '      const boundsOk = addon.setNativePresenterBounds(playerId, r32TargetX, r32TargetY, targetWidth, targetHeight) === true;\n      if (boundsOk) r36SyncNativePresenterUiHoles();\n      return boundsOk;',
  'R36 bridge reapply holes after bounds'
);

// Renderer-side UI rectangles are coalesced through the existing resize IPC.
// No per-frame IPC is added. The 12 CSS-pixel pad covers the existing 6-8 px
// control entry transforms so the popup cannot clip UI during its fade/slide.
const oldShowControls = "function showPlayerControls(){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!$('#video').paused&&!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen())player.classList.remove('controls-visible')},2000)}";
const r36UiHoleRenderer = String.raw`const R36_NATIVE_UI_HOLE_SELECTORS=[
  '#immersivePlayer.controls-visible .player-top',
  '#immersivePlayer.controls-visible .player-center',
  '#immersivePlayer.controls-visible .player-bottom',
  '#immersivePlayer.controls-visible .player-lock',
  '#playerSettings.open',
  '#subtitleOffer:not(.hidden)',
  '#unlockPlayer:not(.hidden)',
  '#skipNow:not(.hidden)',
  '#playerSpeedBoost:not(.hidden)',
  '#playerSeekHint.show'
]; // LILAC_R36_UNFOCUSED_HTML_UI_HOLES
let r36NativeUiHoleSyncTimer=null,r36NativeUiHoleLastSignature='';
function r36NativeUiHolePayload(){
  const video=$('#video');if(!video?.isConnected||typeof window.lilac?.libmpvSharedResize!=='function')return null;
  const surface=video.getBoundingClientRect(),dpr=Math.max(1,Number(window.devicePixelRatio)||1);
  if(surface.width<=1||surface.height<=1)return null;
  const flat=[],pad=12;
  for(const selector of R36_NATIVE_UI_HOLE_SELECTORS){
    for(const element of document.querySelectorAll(selector)){
      const style=getComputedStyle(element),rect=element.getBoundingClientRect();
      if(style.display==='none'||style.visibility==='hidden'||rect.width<=1||rect.height<=1)continue;
      const left=Math.max(surface.left,rect.left-pad),top=Math.max(surface.top,rect.top-pad);
      const right=Math.min(surface.right,rect.right+pad),bottom=Math.min(surface.bottom,rect.bottom+pad);
      if(right-left<=1||bottom-top<=1)continue;
      flat.push(
        Math.round((left-surface.left)*dpr),
        Math.round((top-surface.top)*dpr),
        Math.round((right-left)*dpr),
        Math.round((bottom-top)*dpr)
      );
      if(flat.length>=96)break;
    }
    if(flat.length>=96)break;
  }
  return {
    x:Math.round(surface.left*dpr),y:Math.round(surface.top*dpr),
    width:Math.max(2,Math.round(surface.width*dpr)),height:Math.max(2,Math.round(surface.height*dpr)),
    visible:video.isConnected&&surface.width>1&&surface.height>1,uiHoles:flat
  };
}
function r36SyncNativeUiHoles(delay=0){
  clearTimeout(r36NativeUiHoleSyncTimer);
  r36NativeUiHoleSyncTimer=setTimeout(()=>{
    r36NativeUiHoleSyncTimer=null;
    const payload=r36NativeUiHolePayload();if(!payload)return;
    const signature=[payload.x,payload.y,payload.width,payload.height,payload.visible?1:0,...payload.uiHoles].join(',');
    if(signature===r36NativeUiHoleLastSignature)return;
    r36NativeUiHoleLastSignature=signature;
    Promise.resolve(window.lilac.libmpvSharedResize(payload)).catch(()=>{r36NativeUiHoleLastSignature=''});
  },Math.max(0,Number(delay)||0));
}
function r36InstallNativeUiHoleObservers(){
  const mutation=new MutationObserver(()=>r36SyncNativeUiHoles());
  for(const selector of ['#immersivePlayer','#playerSettings','#subtitleOffer','#unlockPlayer','#skipNow','#playerSpeedBoost','#playerSeekHint']){
    const element=$(selector);if(element)mutation.observe(element,{attributes:true,attributeFilter:['class','style','aria-hidden']});
  }
  const video=$('#video');if(video&&typeof ResizeObserver==='function')new ResizeObserver(()=>r36SyncNativeUiHoles()).observe(video);
  window.addEventListener('resize',()=>r36SyncNativeUiHoles(),{passive:true});
  window.addEventListener('blur',()=>r36SyncNativeUiHoles(),true);
  window.addEventListener('focus',()=>r36SyncNativeUiHoles(),true);
  r36SyncNativeUiHoles();
}
r36InstallNativeUiHoleObservers();
function showPlayerControls(){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;player.classList.add('controls-visible');r36SyncNativeUiHoles();clearTimeout(controlsTimer);if(!$('#video').paused&&!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen()){player.classList.remove('controls-visible');r36SyncNativeUiHoles()}},2000)}`;
app = replaceOnce(app, oldShowControls, r36UiHoleRenderer, 'R36 renderer UI-hole geometry');

// ---------------------------------------------------------------------------
// 3) Deterministic native fallback subtitles. Prefer the plain dialogue source;
// if an ASS file is the only source, strip authored positioning/styles so R32's
// explicit sub-pos/font-size/border mapping is authoritative. Never return force.
// ---------------------------------------------------------------------------
entry = replaceOnce(
  entry,
  "      ['set_property', 'sub-ass-override', 'scale'], // LILAC_R34_SUBTITLE_SINGLE_OWNER LILAC_R35_ASS_PLACEMENT_RECOVERY",
  "      ['set_property', 'sub-ass-override', 'strip'], // LILAC_R34_SUBTITLE_SINGLE_OWNER LILAC_R35_ASS_PLACEMENT_RECOVERY LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC",
  'R36 deterministic native subtitle style'
);
app = replaceOnce(
  app,
  "  const nativeSubtitlePath=(options.assPath&&typeof assEffectsEnabled==='function'&&assEffectsEnabled()?options.assPath:options.path)||'';",
  "  const nativeSubtitlePath=(options.path||options.assPath)||''; // LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE",
  'R36 plain native subtitle source preference'
);

// ---------------------------------------------------------------------------
// 4) One-capture stutter attribution. Retain cached state with each >60 ms main
// supply gap; do not add a native poll or work to the normal frame path otherwise.
// ---------------------------------------------------------------------------
const oldGapBlock = `      if (r27DispatchGapMs >= 60) {
        r27PushRing(r27MainAnomalies, 'anomaly', 'anomaly', {
          kind: 'dispatch-gap',
          frameId: Number(frameId) || 0,
          wallMs: r26DispatchWallMs,
          gapMs: r27DispatchGapMs,
          focused: r27MainFocused
        });
      }`;
const newGapBlock = `      if (r27DispatchGapMs >= 60) {
        r27PushRing(r27MainAnomalies, 'anomaly', 'anomaly', {
          kind: 'dispatch-gap',
          frameId: Number(frameId) || 0,
          wallMs: r26DispatchWallMs,
          gapMs: r27DispatchGapMs,
          focused: r27MainFocused
        });
        r36PushSupplyGap({
          frameId: Number(frameId) || 0,
          timestampUs: Number(timestampUs) || 0,
          wallMs: r26DispatchWallMs,
          gapMs: r27DispatchGapMs,
          focused: r27MainFocused,
          handoffPending: r34FocusHandoffPending,
          nativePresenterActive: r33NativePresenterActive,
          stateAgeMs: r31StateSampleWallMs > 0 ? Math.max(0, r26DispatchWallMs - r31StateSampleWallMs) : null,
          paused: lastState?.paused === true,
          pausedForCache: lastState?.pausedForCache === true,
          seeking: lastState?.seeking === true,
          time: Number(lastState?.time) || 0,
          speed: Number(lastState?.speed) || 0,
          cacheBufferingState: Number(lastState?.cacheBufferingState) || 0
        });
      }`;
bridge = replaceOnce(bridge, oldGapBlock, newGapBlock, 'R36 low-overhead supply-gap attribution');

bridge = replaceOnce(
  bridge,
  `          r35FocusRedrawArms,
          r35FocusRedrawFailures
`,
  `          r35FocusRedrawArms,
          r35FocusRedrawFailures,
          r36Ack: {
            marker: 'LILAC_R36_HANDOFF_ACK_ORDER',
            releasedBeforeSent: r36FocusHandoffReleasedFrames.size,
            releaseBeforeSendEvents: r36ReleaseBeforeSend,
            sendAfterReleaseEvents: r36SendAfterRelease,
            completions: r36AckCompletions,
            mirrorArmFailures: r36MirrorArmFailures,
            failOpenMs: R36_HANDOFF_FAIL_OPEN_MS,
            failOpenCount: r36FailOpenCount,
            lastFailOpenWallMs: r36LastFailOpenWallMs,
            uiHoleRects: Math.floor(r36TargetUiHoles.length / 4)
          },
          r36SupplyGaps: r36SnapshotSupplyGaps()
`,
  'R36 diagnostics'
);

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
write('src/libmpv-shared-entry.js', entry);
write('src/app.js', app);

buildSync({
  entryPoints: [file('src/libmpv-shared-entry.js')],
  outfile: file('src/libmpv-shared.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome152',
  logLevel: 'info'
});

const finalNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalEntry = read('src/libmpv-shared-entry.js');
const finalBundle = read('src/libmpv-shared.generated.js');
const finalApp = read('src/app.js');
for (const marker of [
  'LILAC_R36_HANDOFF_ACK_ORDER','r36FocusHandoffReleasedFrames','r36ReleaseBeforeSend','r36SendAfterRelease',
  'R36_HANDOFF_FAIL_OPEN_MS = 1500','r36SupplyGaps','r36-focus-fail-open',
  'r33NativePresenterActive && active && r32TargetVisible && r34BeginFocusHandoff()',
  'r36TargetUiHoles','r36SyncNativePresenterUiHoles'
]) if (!finalBridge.includes(marker)) throw new Error('R36 bridge marker missing: ' + marker);
for (const marker of [
  'LILAC_R36_UNFOCUSED_HTML_UI_HOLES','R36ApplyPresenterRegionLocked','SetNativePresenterUiHoles',
  'setNativePresenterUiHoles','r36FirstHoleExcluded','SetWindowRgn'
]) if (!finalNative.includes(marker)) throw new Error('R36 native UI-hole marker missing: ' + marker);
if (!finalEntry.includes("'sub-ass-override', 'strip'") || !finalEntry.includes('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC')) {
  throw new Error('R36 native subtitle strip source gate failed');
}
if (!finalBundle.includes('sub-ass-override') || !finalBundle.includes('strip')) throw new Error('R36 bundled subtitle strip semantics missing');
if (finalEntry.includes("'sub-ass-override', 'force'") || finalEntry.includes("'sub-ass-override', 'scale'")) {
  throw new Error('R36 retained non-deterministic/destructive native subtitle override');
}
for (const marker of ['LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE','R36_NATIVE_UI_HOLE_SELECTORS','r36NativeUiHolePayload','libmpvSharedResize(payload)']) {
  if (!finalApp.includes(marker)) throw new Error('R36 renderer marker missing: ' + marker);
}
if (!finalApp.includes("const nativeSubtitlePath=(options.path||options.assPath)||'';")) throw new Error('R36 plain native subtitle path gate failed');
if (finalBridge.includes('if (!addon || playerId == null || !active) return false;')) throw new Error('R36 retained active-dependent paused redraw guard');
const presentStart = finalNative.indexOf('bool R32PresentNativeFrame(');
const presentEnd = finalNative.indexOf('bool SetOption(', presentStart);
if (presentStart < 0 || presentEnd <= presentStart) throw new Error('R36 native present boundary missing');
const presentBody = finalNative.slice(presentStart, presentEnd);
for (const forbidden of ['SetWindowRgn(', 'CreateRectRgn(', 'CombineRgn(', 'SetWindowPos(', 'ShowWindow(']) {
  if (presentBody.includes(forbidden)) throw new Error('R36 producer hot path retained HWND/UI work: ' + forbidden);
}
console.log('R36_HANDOFF_ACK_SUBTITLE_STABILITY_OK ack=bidirectional-order+1500ms-fail-open mirror=bounded subtitle=plain-source+ass-strip ui=owned-popup-region-holes-main-only supplyGap=cached-state-ring r33NativeOnly=preserved');

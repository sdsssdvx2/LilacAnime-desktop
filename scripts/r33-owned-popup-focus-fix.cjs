'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) throw new Error(`${label}: section anchors missing`);
  if (source.indexOf(startMarker, start + startMarker.length) >= 0) throw new Error(`${label}: start anchor not unique`);
  return source.slice(0, start) + replacement + source.slice(end);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');

if (!native.includes('LILAC_R32_NATIVE_HWND_FOCUS_SURFACE') || !native.includes('LILAC_R32_PRESENTER_BOUNDS_MAIN_THREAD')) {
  throw new Error('R33 requires qualified R32 native focus presenter');
}
if (!bridge.includes('r32ApplyNativePresenterFocus') || !bridge.includes('r32SyncNativePresenterBounds')) {
  throw new Error('R33 requires qualified R32 bridge focus presenter');
}
if (native.includes('LILAC_R33_OWNED_POPUP_FOCUS_SURFACE') || bridge.includes('LILAC_R33_OWNED_POPUP_FOCUS_SURFACE')) {
  throw new Error('R33 already applied');
}

// R32 runtime evidence is decisive: during the two playback-time blur intervals the
// native presenter called Present successfully for essentially every expected source
// frame (516 frames, zero failures), yet the user still saw black flashing. A WS_CHILD
// therefore still competes with Chromium's child/compositor hierarchy. R33 makes the
// focus surface a non-activating OWNED WS_POPUP. Windows keeps an owned popup above its
// owner but in the owner's z-order group, so it is not a child-client paint target.
// The class has no black background brush and WS_EX_TRANSPARENT is removed; hit testing
// remains transparent through the existing WndProc.
native = replaceOnce(
  native,
  '  wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));',
  '  wc.hbrBackground = nullptr; // LILAC_R33_OWNED_POPUP_FOCUS_SURFACE: never erase to black between DXGI presents',
  'R33 remove black class brush'
);

native = replaceOnce(
  native,
  '  std::string nativePresenterLastError;\n',
  '  std::string nativePresenterLastError;\n  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED\n',
  'R33 native-only counter'
);

const configureReplacement = String.raw`bool R33PresenterScreenRect(Player* player, RECT* out, std::string* error) {
  if (!player || !out || !player->nativePresenterParent || !IsWindow(player->nativePresenterParent)) {
    if (error) *error = "native presenter owner HWND unavailable";
    return false;
  }
  POINT origin{ player->nativePresenterX, player->nativePresenterY };
  if (!ClientToScreen(player->nativePresenterParent, &origin)) {
    if (error) *error = "ClientToScreen native presenter failed win32=" + std::to_string(GetLastError());
    return false;
  }
  const LONG width = static_cast<LONG>(std::max<uint32_t>(2, player->nativePresenterBoundsWidth));
  const LONG height = static_cast<LONG>(std::max<uint32_t>(2, player->nativePresenterBoundsHeight));
  out->left = origin.x;
  out->top = origin.y;
  out->right = origin.x + width;
  out->bottom = origin.y + height;
  return true;
}

bool R32ConfigurePresenter(Player* player, HWND parent, std::string* error) {
  if (!player || !parent || !IsWindow(parent)) {
    *error = "invalid native presenter owner HWND";
    return false;
  }
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  if (player->nativePresenterHwnd && player->nativePresenterParent == parent && IsWindow(player->nativePresenterHwnd)) return true;
  player->nativePresenterBackBuffer.Reset();
  player->nativePresenterSwapChain.Reset();
  if (player->nativePresenterHwnd) DestroyWindow(player->nativePresenterHwnd);
  player->nativePresenterHwnd = nullptr;
  player->nativePresenterParent = parent;
  player->nativePresenterVisible = false;
  player->nativePresenterWidth = 0;
  player->nativePresenterHeight = 0;
  if (!R32RegisterPresenterClass(error)) return false;
  RECT screenRect{};
  if (!R33PresenterScreenRect(player, &screenRect, error)) return false;
  const int width = std::max<LONG>(2, screenRect.right - screenRect.left);
  const int height = std::max<LONG>(2, screenRect.bottom - screenRect.top);
  HWND hwnd = CreateWindowExW(
    WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
    kR32PresenterClass, L"", WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
    screenRect.left, screenRect.top, width, height,
    parent, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!hwnd) {
    *error = "CreateWindowExW owned native presenter failed win32=" + std::to_string(GetLastError());
    player->nativePresenterParent = nullptr;
    return false;
  }
  player->nativePresenterHwnd = hwnd;
  SetWindowPos(hwnd, nullptr, screenRect.left, screenRect.top, width, height,
               SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_HIDEWINDOW);
  return true;
}

`;
native = replaceSection(
  native,
  'bool R32ConfigurePresenter(Player* player, HWND parent, std::string* error) {',
  'bool R32EnsurePresenterSwapChain(',
  configureReplacement,
  'R33 owned popup configure'
);

const visibleReplacement = String.raw`napi_value SetNativePresenterVisible(napi_env env, napi_callback_info info) {
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
  player->nativePresenterRequested.store(visible, std::memory_order_release);
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  if (player->nativePresenterHwnd && IsWindow(player->nativePresenterHwnd)) {
    RECT screenRect{};
    std::string geometryError;
    if (R33PresenterScreenRect(player, &screenRect, &geometryError)) {
      SetWindowPos(player->nativePresenterHwnd, nullptr,
                   screenRect.left, screenRect.top,
                   std::max<LONG>(2, screenRect.right - screenRect.left),
                   std::max<LONG>(2, screenRect.bottom - screenRect.top),
                   SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER |
                     (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
    } else if (visible) {
      player->nativePresenterLastError = geometryError;
    }
    ShowWindow(player->nativePresenterHwnd, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
    player->nativePresenterVisible = visible && IsWindowVisible(player->nativePresenterHwnd);
  } else {
    player->nativePresenterVisible = false;
  }
  return BoolValue(env, true);
}

`;
native = replaceSection(
  native,
  'napi_value SetNativePresenterVisible(napi_env env, napi_callback_info info) {',
  'napi_value SetNativePresenterBounds(',
  visibleReplacement,
  'R33 owned popup visibility'
);

const boundsReplacement = String.raw`napi_value SetNativePresenterBounds(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  int32_t x = 0, y = 0;
  if (argc < 5 || !ReadUint32(env, argv[0], &id) ||
      napi_get_value_int32(env, argv[1], &x) != napi_ok ||
      napi_get_value_int32(env, argv[2], &y) != napi_ok ||
      !ReadUint32(env, argv[3], &width) || !ReadUint32(env, argv[4], &height)) {
    Throw(env, "setNativePresenterBounds(playerId, x, y, width, height) requires five numeric arguments");
    return nullptr;
  }
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return BoolValue(env, false);
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  player->nativePresenterX = x;
  player->nativePresenterY = y;
  player->nativePresenterBoundsWidth = std::max<uint32_t>(2, width);
  player->nativePresenterBoundsHeight = std::max<uint32_t>(2, height);
  if (player->nativePresenterHwnd && IsWindow(player->nativePresenterHwnd)) {
    RECT screenRect{};
    std::string geometryError;
    if (!R33PresenterScreenRect(player, &screenRect, &geometryError)) {
      player->nativePresenterLastError = geometryError;
      return BoolValue(env, false);
    }
    SetWindowPos(player->nativePresenterHwnd, nullptr,
                 screenRect.left, screenRect.top,
                 std::max<LONG>(2, screenRect.right - screenRect.left),
                 std::max<LONG>(2, screenRect.bottom - screenRect.top),
                 SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER);
  }
  return BoolValue(env, true);
}

`;
native = replaceSection(
  native,
  'napi_value SetNativePresenterBounds(napi_env env, napi_callback_info info) {',
  'napi_value NativePresenterStats(',
  boundsReplacement,
  'R33 owned popup bounds'
);

// When the popup owns presentation, do not enqueue the same frame for Chromium.
// Present() has already consumed a CopyResource into the swapchain on this same
// D3D11 immediate context. Return the producer slot immediately and avoid the JS
// TSFN/import/send/WebGPU path entirely until focus returns.
native = replaceOnce(
  native,
  `        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {\n          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }\n\n        bool queuedFrame = false;`,
  `        const bool r33NativeOwnsFrame = rc >= 0 &&\n          player->nativePresenterRequested.load(std::memory_order_acquire);\n        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {\n          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }\n\n        bool queuedFrame = false;`,
  'R33 native-only frame ownership decision'
);

const oldQueue = String.raw`            player->renderedFrames += 1;
            const auto now = std::chrono::steady_clock::now().time_since_epoch();
            const double timestampUs = static_cast<double>(
              std::chrono::duration_cast<std::chrono::microseconds>(now).count());
            player->producerReady.push_back({
              slotId, reservedFrameId, renderWidth, renderHeight,
              timestampUs, updateMs, textureMs, renderMs
            });
            player->producerProducedFrames += 1;
            player->producerQueueMax = std::max<uint64_t>(
              player->producerQueueMax, static_cast<uint64_t>(player->producerReady.size()));
            queuedFrame = true;`;
const newQueue = String.raw`            player->renderedFrames += 1;
            if (r33NativeOwnsFrame) {
              // LILAC_R33_NATIVE_ONLY_UNFOCUSED: native popup has already copied
              // this source texture. No Chromium import/send is needed.
              if (slot->inFlight && slot->frameId == reservedFrameId) slot->inFlight = false;
              player->r33NativeOnlyFrames += 1;
            } else {
              const auto now = std::chrono::steady_clock::now().time_since_epoch();
              const double timestampUs = static_cast<double>(
                std::chrono::duration_cast<std::chrono::microseconds>(now).count());
              player->producerReady.push_back({
                slotId, reservedFrameId, renderWidth, renderHeight,
                timestampUs, updateMs, textureMs, renderMs
              });
              player->producerProducedFrames += 1;
              player->producerQueueMax = std::max<uint64_t>(
                player->producerQueueMax, static_cast<uint64_t>(player->producerReady.size()));
              queuedFrame = true;
            }`;
native = replaceOnce(native, oldQueue, newQueue, 'R33 bypass Chromium queue while unfocused');

native = replaceOnce(
  native,
  '  Set(env, out, "visible", BoolValue(env, player->nativePresenterVisible));\n  Set(env, out, "x", Int32Value(env, player->nativePresenterX));',
  `  Set(env, out, "visible", BoolValue(env, player->nativePresenterVisible));\n  Set(env, out, "surfaceMode", StringValue(env, "owned-popup"));\n  const LONG_PTR r33Style = player->nativePresenterHwnd ? GetWindowLongPtrW(player->nativePresenterHwnd, GWL_STYLE) : 0;\n  const LONG_PTR r33ExStyle = player->nativePresenterHwnd ? GetWindowLongPtrW(player->nativePresenterHwnd, GWL_EXSTYLE) : 0;\n  const HWND r33Owner = player->nativePresenterHwnd ? GetWindow(player->nativePresenterHwnd, GW_OWNER) : nullptr;\n  Set(env, out, "isChild", BoolValue(env, (r33Style & WS_CHILD) != 0));\n  Set(env, out, "ownerMatches", BoolValue(env, r33Owner == player->nativePresenterParent));\n  Set(env, out, "windowVisible", BoolValue(env, player->nativePresenterHwnd && IsWindowVisible(player->nativePresenterHwnd)));\n  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));\n  RECT r33WindowRect{};\n  if (player->nativePresenterHwnd && GetWindowRect(player->nativePresenterHwnd, &r33WindowRect)) {\n    Set(env, out, "screenLeft", Int32Value(env, r33WindowRect.left));\n    Set(env, out, "screenTop", Int32Value(env, r33WindowRect.top));\n    Set(env, out, "screenWidth", Uint32Value(env, static_cast<uint32_t>(std::max<LONG>(0, r33WindowRect.right - r33WindowRect.left))));\n    Set(env, out, "screenHeight", Uint32Value(env, static_cast<uint32_t>(std::max<LONG>(0, r33WindowRect.bottom - r33WindowRect.top))));\n  }\n  Set(env, out, "x", Int32Value(env, player->nativePresenterX));`,
  'R33 presenter diagnostics'
);

// Keep the main-side focus state explicit for diagnostics and resync the owned
// popup whenever the owner moves/resizes/fullscreens. Renderer x/y are client
// coordinates; native ClientToScreen translates them at each sync.
bridge = replaceOnce(
  bridge,
  '  let r32TargetVisible = true;',
  `  let r32TargetVisible = true; // LILAC_R33_OWNED_POPUP_FOCUS_SURFACE\n  let r33NativePresenterActive = false;\n  let r33FocusTransitions = 0;\n  let r33GeometryResyncs = 0;`,
  'R33 bridge state'
);

const focusStart = bridge.indexOf('  function r32ApplyNativePresenterFocus(focused) {');
const focusEnd = bridge.indexOf('\n\n  function ensurePlayer() {', focusStart);
if (focusStart < 0 || focusEnd <= focusStart) throw new Error('R33 focus helper boundary missing');
const focusHelper = `  function r32ApplyNativePresenterFocus(focused) {\n    if (!addon || playerId == null) return;\n    const useNative = !Boolean(focused) && active && r32TargetVisible;\n    r33NativePresenterActive = useNative;\n    r33FocusTransitions += 1;\n    try { addon.setNativePresenterVisible(playerId, useNative); } catch (error) {\n      lastError = \`R33 owned popup focus failed: \${String(error?.message || error).slice(0, 180)}\`;\n      r33NativePresenterActive = false;\n    }\n    // The owned popup sits above the Electron owner while unfocused, so mirror the\n    // already-loaded subtitle track through libmpv only for this native surface.\n    try { addon.command(playerId, ['set_property', 'sub-visibility', useNative ? 'yes' : 'no']); } catch {}\n  }`;
bridge = bridge.slice(0, focusStart) + focusHelper + bridge.slice(focusEnd);

bridge = replaceOnce(
  bridge,
  `    const r27OnFocus = () => { r27RecordMainFocus('focus', true); r32ApplyNativePresenterFocus(true); };\n    const r27OnBlur = () => { r27RecordMainFocus('blur', false); r32ApplyNativePresenterFocus(false); };`,
  `    const r27OnFocus = () => { r27RecordMainFocus('focus', true); r32ApplyNativePresenterFocus(true); };\n    const r27OnBlur = () => { r27RecordMainFocus('blur', false); r32ApplyNativePresenterFocus(false); };\n    const r33OnGeometry = () => { r33GeometryResyncs += 1; r32SyncNativePresenterBounds(); };`,
  'R33 geometry listener declaration'
);

bridge = replaceOnce(
  bridge,
  `    win.on('focus', r27OnFocus);\n    win.on('blur', r27OnBlur);`,
  `    win.on('focus', r27OnFocus);\n    win.on('blur', r27OnBlur);\n    for (const eventName of ['move','resize','maximize','unmaximize','restore','enter-full-screen','leave-full-screen']) {\n      win.on(eventName, r33OnGeometry);\n    }`,
  'R33 geometry listener install'
);

bridge = replaceOnce(
  bridge,
  `      try { win.removeListener('focus', r27OnFocus); } catch {}\n      try { win.removeListener('blur', r27OnBlur); } catch {}`,
  `      try { win.removeListener('focus', r27OnFocus); } catch {}\n      try { win.removeListener('blur', r27OnBlur); } catch {}\n      for (const eventName of ['move','resize','maximize','unmaximize','restore','enter-full-screen','leave-full-screen']) {\n        try { win.removeListener(eventName, r33OnGeometry); } catch {}\n      }`,
  'R33 geometry listener cleanup'
);

bridge = replaceOnce(
  bridge,
  `      r32NativePresenter: typeof addon.nativePresenterStats === 'function' ? addon.nativePresenterStats(playerId) : null,\n      r30ProducerDrain: {`,
  `      r32NativePresenter: typeof addon.nativePresenterStats === 'function' ? addon.nativePresenterStats(playerId) : null,\n      r33FocusSurface: {\n        mode: 'owned-popup-native-only-unfocused',\n        active: r33NativePresenterActive,\n        focusTransitions: r33FocusTransitions,\n        geometryResyncs: r33GeometryResyncs\n      },\n      r30ProducerDrain: {`,
  'R33 diagnostics'
);

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);

const finalNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
const finalBridge = read('electron/libmpv-shared-main.cjs');
for (const marker of [
  'LILAC_R33_OWNED_POPUP_FOCUS_SURFACE', 'LILAC_R33_NATIVE_ONLY_UNFOCUSED',
  'WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN', 'WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW',
  'R33PresenterScreenRect', 'ownerMatches', 'nativeOnlyFrames'
]) if (!finalNative.includes(marker)) throw new Error(`R33 native marker missing: ${marker}`);
const configureStart = finalNative.indexOf('bool R32ConfigurePresenter(');
const configureEnd = finalNative.indexOf('bool R32EnsurePresenterSwapChain(', configureStart);
const configureBody = finalNative.slice(configureStart, configureEnd);
if (configureBody.includes('WS_CHILD') || configureBody.includes('WS_EX_TRANSPARENT')) throw new Error('R33 presenter still uses Chromium-competing child/transparent style');
const presentStart = finalNative.indexOf('void R32PresentNativeFrame(');
const presentEnd = finalNative.indexOf('bool SetOption(Player* player, const char* key, const char* value, std::string* error) {', presentStart);
const presentBody = finalNative.slice(presentStart, presentEnd);
for (const forbidden of ['SetWindowPos(', 'ShowWindow(', 'GetClientRect(', 'ClientToScreen(']) {
  if (presentBody.includes(forbidden)) throw new Error(`R33 producer presenter retained HWND operation: ${forbidden}`);
}
for (const marker of ['r33NativePresenterActive', 'r33OnGeometry', 'owned-popup-native-only-unfocused']) {
  if (!finalBridge.includes(marker)) throw new Error(`R33 bridge marker missing: ${marker}`);
}
console.log('R33_OWNED_POPUP_FOCUS_OK surface=owned-ws-popup chromiumCompetition=removed nativeOnlyUnfocused=1 focus=direct-webgpu geometry=client-to-screen ownerTracking=move+resize+fullscreen blackErase=disabled');

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
  return source.slice(0, start) + replacement + source.slice(end);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');
if (!native.includes('LILAC_R33_OWNED_POPUP_FOCUS_SURFACE') || !native.includes('LILAC_R33_NATIVE_ONLY_UNFOCUSED')) {
  throw new Error('R33 present-result proof requires owned-popup focus transform');
}
if (!bridge.includes('r33NativePresenterActive') || !bridge.includes('r32ApplyNativePresenterFocus')) {
  throw new Error('R33 present-result proof requires owned-popup bridge transform');
}
if (native.includes('LILAC_R33_PRESENT_RESULT_PROOF')) throw new Error('R33 present-result proof already applied');

// DXGI_STATUS_OCCLUDED is a success-coded HRESULT, but Microsoft defines it as
// "window content is not visible". R32 counted it as a presented frame. R33 must
// only suppress Chromium delivery after an actual S_OK present; otherwise fail
// open to the existing Chromium path instead of turning a transient occlusion into
// a persistent black video surface.
native = replaceOnce(
  native,
  '  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED\n',
  '  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED\n  uint64_t r33PresentSOkFrames = 0; // LILAC_R33_PRESENT_RESULT_PROOF\n  uint64_t r33PresentOccludedFrames = 0;\n  uint64_t r33PresentOtherStatusFrames = 0;\n  HRESULT r33LastPresentHr = S_OK;\n',
  'R33 present-result counters'
);

const presentReplacement = String.raw`bool R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {
  if (!player || !slot || !slot->texture || !player->nativePresenterRequested.load(std::memory_order_acquire)) return false;
  const auto started = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  if (!player->nativePresenterRequested.load(std::memory_order_acquire) || !player->nativePresenterHwnd) return false;
  std::string error;
  if (!R32EnsurePresenterSwapChain(player, width, height, &error)) {
    player->nativePresenterFailures += 1;
    player->r33PresentOtherStatusFrames += 1;
    player->nativePresenterLastError = error;
    return false;
  }
  player->context->CopyResource(player->nativePresenterBackBuffer.Get(), slot->texture.Get());
  const HRESULT hr = player->nativePresenterSwapChain->Present(0, 0);
  player->r33LastPresentHr = hr;
  if (hr == DXGI_STATUS_OCCLUDED) {
    player->r33PresentOccludedFrames += 1;
    player->nativePresenterLastError = "Present native presenter occluded " + HrHex(hr);
    return false;
  }
  if (hr != S_OK) {
    player->r33PresentOtherStatusFrames += 1;
    if (FAILED(hr)) player->nativePresenterFailures += 1;
    player->nativePresenterLastError = "Present native presenter non-S_OK " + HrHex(hr);
    return false;
  }
  const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  player->nativePresenterFrames += 1;
  player->r33PresentSOkFrames += 1;
  player->nativePresenterPresentTotalMs += elapsed;
  player->nativePresenterPresentMaxMs = std::max(player->nativePresenterPresentMaxMs, elapsed);
  player->nativePresenterLastError.clear();
  return true;
}

`;
native = replaceSection(
  native,
  'void R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {',
  'bool SetOption(Player* player, const char* key, const char* value, std::string* error) {',
  presentReplacement,
  'R33 S_OK-qualified presenter'
);

const visibilityReplacement = String.raw`napi_value SetNativePresenterVisible(napi_env env, napi_callback_info info) {
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

  // On hide, stop the producer first. On show, expose/position the HWND first and
  // only then arm native presentation. This closes the old race where the producer
  // could Present to a still-hidden window and receive DXGI_STATUS_OCCLUDED.
  if (!visible) player->nativePresenterRequested.store(false, std::memory_order_release);
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  bool actuallyVisible = false;
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
    actuallyVisible = visible && IsWindowVisible(player->nativePresenterHwnd);
  }
  player->nativePresenterVisible = actuallyVisible;
  if (visible) player->nativePresenterRequested.store(actuallyVisible, std::memory_order_release);
  return BoolValue(env, !visible || actuallyVisible);
}

`;
native = replaceSection(
  native,
  'napi_value SetNativePresenterVisible(napi_env env, napi_callback_info info) {',
  'napi_value SetNativePresenterBounds(',
  visibilityReplacement,
  'R33 show-before-arm visibility ordering'
);

native = replaceOnce(
  native,
  `        const bool r33NativeOwnsFrame = rc >= 0 &&\n          player->nativePresenterRequested.load(std::memory_order_acquire);\n        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {\n          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }\n\n        bool queuedFrame = false;`,
  `        bool r33NativeOwnsFrame = false;\n        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {\n          r33NativeOwnsFrame = R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }\n\n        bool queuedFrame = false;`,
  'R33 suppress Chromium only after S_OK native present'
);

native = replaceOnce(
  native,
  '  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));\n',
  `  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));\n  Set(env, out, "presentSOkFrames", DoubleValue(env, static_cast<double>(player->r33PresentSOkFrames)));\n  Set(env, out, "presentOccludedFrames", DoubleValue(env, static_cast<double>(player->r33PresentOccludedFrames)));\n  Set(env, out, "presentOtherStatusFrames", DoubleValue(env, static_cast<double>(player->r33PresentOtherStatusFrames)));\n  Set(env, out, "lastPresentHr", StringValue(env, HrHex(player->r33LastPresentHr)));\n`,
  'R33 present-result diagnostics'
);

// Treat the native N-API return value as an activation acknowledgement. If HWND
// visibility/geometry setup failed, keep the Chromium video and HTML subtitles as
// the authoritative fail-open path instead of claiming native mode from blur alone.
const focusStart = bridge.indexOf('  function r32ApplyNativePresenterFocus(focused) {');
const focusEnd = bridge.indexOf('\n\n  function ensurePlayer() {', focusStart);
if (focusStart < 0 || focusEnd <= focusStart) throw new Error('R33 bridge focus helper boundary missing for activation acknowledgement');
const focusHelper = `  function r32ApplyNativePresenterFocus(focused) {\n    if (!addon || playerId == null) return;\n    const useNative = !Boolean(focused) && active && r32TargetVisible;\n    let nativeReady = false; // LILAC_R33_PRESENT_ACTIVATION_ACK\n    r33FocusTransitions += 1;\n    try {\n      const accepted = addon.setNativePresenterVisible(playerId, useNative);\n      nativeReady = useNative && accepted === true;\n    } catch (error) {\n      lastError = \`R33 owned popup focus failed: \${String(error?.message || error).slice(0, 180)}\`;\n    }\n    r33NativePresenterActive = nativeReady;\n    // Native subtitles are enabled only after the popup actually acknowledged\n    // visibility. Otherwise Chromium remains the complete fail-open presentation.\n    try { addon.command(playerId, ['set_property', 'sub-visibility', nativeReady ? 'yes' : 'no']); } catch {}\n  }`;
bridge = bridge.slice(0, focusStart) + focusHelper + bridge.slice(focusEnd);

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
const finalNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
const finalBridge = read('electron/libmpv-shared-main.cjs');
for (const marker of ['LILAC_R33_PRESENT_RESULT_PROOF','presentSOkFrames','presentOccludedFrames','Present native presenter occluded','r33NativeOwnsFrame = R32PresentNativeFrame']) {
  if (!finalNative.includes(marker)) throw new Error(`R33 present-result marker missing: ${marker}`);
}
for (const marker of ['LILAC_R33_PRESENT_ACTIVATION_ACK','accepted === true','sub-visibility',"nativeReady ? 'yes' : 'no'"]) {
  if (!finalBridge.includes(marker)) throw new Error(`R33 activation acknowledgement marker missing: ${marker}`);
}
const producerCallAt = finalNative.indexOf('r33NativeOwnsFrame = R32PresentNativeFrame');
const queueAt = finalNative.indexOf('if (r33NativeOwnsFrame)', producerCallAt);
if (producerCallAt < 0 || queueAt <= producerCallAt) throw new Error('R33 S_OK gating ordering missing');
console.log('R33_PRESENT_RESULT_PROOF_OK nativeOnly=S_OK-only occluded=fail-open showOrder=HWND-visible-before-producer-arm activation=acknowledged diagnostics=S_OK+occluded+other');

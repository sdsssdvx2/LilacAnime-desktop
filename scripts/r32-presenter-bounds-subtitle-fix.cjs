'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

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
let entry = read('src/libmpv-shared-entry.js');
let app = read('src/app.js');

if (!native.includes('LILAC_R32_NATIVE_HWND_FOCUS_SURFACE') || !native.includes('R32PresentNativeFrame')) throw new Error('R32 native presenter baseline missing');
if (!bridge.includes('r32ConfigureNativePresenter') || !bridge.includes('r32ApplyNativePresenterFocus')) throw new Error('R32 presenter bridge baseline missing');
if (!entry.includes('_surfaceSize()') || !entry.includes('async _loadTrack(element)')) throw new Error('R32 renderer media baseline missing');
if (native.includes('LILAC_R32_PRESENTER_BOUNDS_MAIN_THREAD') || entry.includes('LILAC_R32_NATIVE_SUBTITLE_FALLBACK')) throw new Error('R32 presenter bounds/subtitle fix already applied');

// The first native-focus implementation used the whole BrowserWindow client area and
// called SetWindowPos from the producer thread every frame. That would cover HTML
// subtitles/controls and can cross-thread-block on the UI HWND. Keep all HWND
// geometry/visibility mutation on Electron main; the producer thread only copies the
// already-rendered texture and calls Present.
native = replaceOnce(
  native,
  '  bool nativePresenterVisible = false;\n  uint32_t nativePresenterWidth = 0;',
  '  bool nativePresenterVisible = false; // LILAC_R32_PRESENTER_BOUNDS_MAIN_THREAD\n  int32_t nativePresenterX = 0;\n  int32_t nativePresenterY = 0;\n  uint32_t nativePresenterBoundsWidth = 2;\n  uint32_t nativePresenterBoundsHeight = 2;\n  uint32_t nativePresenterWidth = 0;',
  'native presenter bounds fields'
);

const configureReplacement = String.raw`bool R32ConfigurePresenter(Player* player, HWND parent, std::string* error) {
  if (!player || !parent || !IsWindow(parent)) {
    *error = "invalid native presenter parent HWND";
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
  HWND hwnd = CreateWindowExW(
    WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
    kR32PresenterClass, L"", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
    player->nativePresenterX, player->nativePresenterY,
    static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsWidth)),
    static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsHeight)),
    parent, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!hwnd) {
    *error = "CreateWindowExW native presenter failed win32=" + std::to_string(GetLastError());
    player->nativePresenterParent = nullptr;
    return false;
  }
  player->nativePresenterHwnd = hwnd;
  SetWindowPos(hwnd, HWND_TOP, player->nativePresenterX, player->nativePresenterY,
               static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsWidth)),
               static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsHeight)),
               SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_HIDEWINDOW);
  return true;
}

`;
native = replaceSection(native, 'bool R32ConfigurePresenter(Player* player, HWND parent, std::string* error) {', 'bool R32EnsurePresenterSwapChain(', configureReplacement, 'main-thread presenter configure');

const presentReplacement = String.raw`void R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {
  if (!player || !slot || !slot->texture || !player->nativePresenterRequested.load(std::memory_order_acquire)) return;
  const auto started = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  if (!player->nativePresenterRequested.load(std::memory_order_acquire) || !player->nativePresenterHwnd) return;
  std::string error;
  if (!R32EnsurePresenterSwapChain(player, width, height, &error)) {
    player->nativePresenterFailures += 1;
    player->nativePresenterLastError = error;
    return;
  }
  player->context->CopyResource(player->nativePresenterBackBuffer.Get(), slot->texture.Get());
  const HRESULT hr = player->nativePresenterSwapChain->Present(0, 0);
  if (FAILED(hr) && hr != DXGI_STATUS_OCCLUDED) {
    player->nativePresenterFailures += 1;
    player->nativePresenterLastError = "Present native presenter failed " + HrHex(hr);
    return;
  }
  const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  player->nativePresenterFrames += 1;
  player->nativePresenterPresentTotalMs += elapsed;
  player->nativePresenterPresentMaxMs = std::max(player->nativePresenterPresentMaxMs, elapsed);
}

`;
native = replaceSection(native, 'void R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {', 'napi_value ConfigureNativePresenter(', presentReplacement, 'producer-present-only function');

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
    SetWindowPos(player->nativePresenterHwnd, HWND_TOP,
                 player->nativePresenterX, player->nativePresenterY,
                 static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsWidth)),
                 static_cast<int>(std::max<uint32_t>(2, player->nativePresenterBoundsHeight)),
                 SWP_NOACTIVATE | SWP_NOOWNERZORDER | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
    ShowWindow(player->nativePresenterHwnd, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
    player->nativePresenterVisible = visible;
  } else {
    player->nativePresenterVisible = false;
  }
  return BoolValue(env, true);
}

napi_value SetNativePresenterBounds(napi_env env, napi_callback_info info) {
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
    SetWindowPos(player->nativePresenterHwnd, HWND_TOP, x, y,
                 static_cast<int>(player->nativePresenterBoundsWidth),
                 static_cast<int>(player->nativePresenterBoundsHeight),
                 SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }
  return BoolValue(env, true);
}

`;
native = replaceSection(native, 'napi_value SetNativePresenterVisible(napi_env env, napi_callback_info info) {', 'napi_value NativePresenterStats(', visibleReplacement, 'main-thread visibility and bounds APIs');

native = replaceOnce(
  native,
  '    {"setNativePresenterVisible", nullptr, SetNativePresenterVisible, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"nativePresenterStats", nullptr, NativePresenterStats, nullptr, nullptr, nullptr, napi_default, nullptr},',
  '    {"setNativePresenterVisible", nullptr, SetNativePresenterVisible, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"setNativePresenterBounds", nullptr, SetNativePresenterBounds, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"nativePresenterStats", nullptr, NativePresenterStats, nullptr, nullptr, nullptr, napi_default, nullptr},',
  'export presenter bounds API'
);

native = replaceOnce(
  native,
  '  Set(env, out, "visible", BoolValue(env, player->nativePresenterVisible));\n  Set(env, out, "presentedFrames", DoubleValue(env, static_cast<double>(player->nativePresenterFrames)));',
  '  Set(env, out, "visible", BoolValue(env, player->nativePresenterVisible));\n  Set(env, out, "x", Int32Value(env, player->nativePresenterX));\n  Set(env, out, "y", Int32Value(env, player->nativePresenterY));\n  Set(env, out, "boundsWidth", Uint32Value(env, player->nativePresenterBoundsWidth));\n  Set(env, out, "boundsHeight", Uint32Value(env, player->nativePresenterBoundsHeight));\n  Set(env, out, "presentedFrames", DoubleValue(env, static_cast<double>(player->nativePresenterFrames)));',
  'presenter bounds diagnostics'
);

// Carry the physical DOM video rectangle through the existing resize/open payload.
bridge = replaceOnce(
  bridge,
  "'frameProducerStats', 'configureNativePresenter', 'setNativePresenterVisible', 'nativePresenterStats', 'destroyPlayer']",
  "'frameProducerStats', 'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterBounds', 'nativePresenterStats', 'destroyPlayer']",
  'require presenter bounds export'
);
bridge = replaceOnce(
  bridge,
  '  let targetWidth = 1280;\n  let targetHeight = 720;',
  '  let targetWidth = 1280;\n  let targetHeight = 720;\n  let r32TargetX = 0;\n  let r32TargetY = 0;\n  let r32TargetVisible = true;',
  'bridge presenter target rectangle state'
);
bridge = replaceOnce(
  bridge,
  `  function setTargetSize(value = {}) {\n    targetWidth = clampSize(value.width, targetWidth, 3840);\n    targetHeight = clampSize(value.height, targetHeight, 2160);\n    return { width: targetWidth, height: targetHeight };\n  }`,
  `  function setTargetSize(value = {}) {\n    targetWidth = clampSize(value.width, targetWidth, 3840);\n    targetHeight = clampSize(value.height, targetHeight, 2160);\n    const x = Math.round(Number(value.x));\n    const y = Math.round(Number(value.y));\n    if (Number.isFinite(x)) r32TargetX = x;\n    if (Number.isFinite(y)) r32TargetY = y;\n    if (typeof value.visible === 'boolean') r32TargetVisible = value.visible;\n    return { x: r32TargetX, y: r32TargetY, width: targetWidth, height: targetHeight, visible: r32TargetVisible };\n  }`,
  'bridge physical target rectangle'
);

const bridgeHelperStart = bridge.indexOf('  function r32ConfigureNativePresenter() {');
const bridgeHelperEnd = bridge.indexOf('\n\n  function ensurePlayer() {', bridgeHelperStart);
if (bridgeHelperStart < 0 || bridgeHelperEnd <= bridgeHelperStart) throw new Error('R32 bridge presenter helper section missing');
const bridgeHelpers = `  function r32SyncNativePresenterBounds() {\n    if (!addon || playerId == null || typeof addon.setNativePresenterBounds !== 'function') return false;\n    try {\n      return addon.setNativePresenterBounds(playerId, r32TargetX, r32TargetY, targetWidth, targetHeight) === true;\n    } catch (error) {\n      lastError = \`R32 native presenter bounds failed: \${String(error?.message || error).slice(0, 180)}\`;\n      return false;\n    }\n  }\n\n  function r32ConfigureNativePresenter() {\n    if (!addon || playerId == null || !attachedWindow || attachedWindow.isDestroyed()) return false;\n    const hwndText = r32ParentHwndText();\n    if (!hwndText) return false;\n    try {\n      addon.configureNativePresenter(playerId, hwndText);\n      r32SyncNativePresenterBounds();\n      addon.setNativePresenterVisible(playerId, false);\n      return true;\n    } catch (error) {\n      lastError = \`R32 native presenter configure failed: \${String(error?.message || error).slice(0, 180)}\`;\n      return false;\n    }\n  }\n\n  function r32ApplyNativePresenterFocus(focused) {\n    if (!addon || playerId == null) return;\n    const useNative = !Boolean(focused) && active && r32TargetVisible;\n    try { addon.setNativePresenterVisible(playerId, useNative); } catch (error) {\n      lastError = \`R32 native presenter focus failed: \${String(error?.message || error).slice(0, 180)}\`;\n    }\n    // The native child HWND sits above Chromium while unfocused, so mirror the\n    // already-loaded subtitle track through libmpv only for this native surface.\n    try { addon.command(playerId, ['set_property', 'sub-visibility', useNative ? 'yes' : 'no']); } catch {}\n  }`;
bridge = bridge.slice(0, bridgeHelperStart) + bridgeHelpers + bridge.slice(bridgeHelperEnd);

const resizeStart = bridge.indexOf('  function resize(value = {}) {');
const resizeEnd = bridge.indexOf('\n  }', resizeStart);
if (resizeStart < 0 || resizeEnd <= resizeStart) throw new Error('R32 resize function missing');
const resizeSlice = bridge.slice(resizeStart, resizeEnd + 4);
if (!resizeSlice.includes('const size = setTargetSize(value);')) throw new Error('R32 resize size update missing');
const resizedSlice = resizeSlice.replace('    const size = setTargetSize(value);', '    const size = setTargetSize(value);\n    r32SyncNativePresenterBounds();');
bridge = bridge.slice(0, resizeStart) + resizedSlice + bridge.slice(resizeEnd + 4);

// Return physical x/y as well as render dimensions. ResizeObserver supplies this to
// main whenever the video stage changes size; open() also sends it immediately.
entry = replaceOnce(
  entry,
  `  _surfaceSize() {\n    const rect = this.getBoundingClientRect();\n    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);\n    return {\n      width: clamp(Math.round(Math.max(2, rect.width) * dpr), 2, 3840),\n      height: clamp(Math.round(Math.max(2, rect.height) * dpr), 2, 2160)\n    };\n  }`,
  `  _surfaceSize() {\n    const rect = this.getBoundingClientRect();\n    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);\n    return {\n      x: Math.round(rect.left * dpr),\n      y: Math.round(rect.top * dpr),\n      width: clamp(Math.round(Math.max(2, rect.width) * dpr), 2, 3840),\n      height: clamp(Math.round(Math.max(2, rect.height) * dpr), 2, 2160),\n      visible: this.isConnected && rect.width > 1 && rect.height > 1\n    };\n  }`,
  'renderer physical surface rectangle'
);

const loadTrackAt = entry.indexOf('  async _loadTrack(element) {');
if (loadTrackAt < 0) throw new Error('R32 loadTrack method missing');
const styleHelper = `  async _syncR32NativeSubtitleFallbackStyle() {\n    if (!this._playerOpen) return;\n    const size = clamp(Number(localStorage.getItem('subtitleSize') || 105), 25, 300);\n    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 10), 0, 45);\n    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 3), 0, 12);\n    const syncMs = Number(localStorage.getItem('subtitleSync') || 0);\n    const weight = clamp(Number(localStorage.getItem('vttWeight') || 400), 400, 800);\n    const commands = [\n      ['set_property', 'sub-pos', clamp(Math.round(100 - position), 55, 97)],\n      ['set_property', 'sub-font-size', Math.max(12, Math.round(36 * size / 100))],\n      ['set_property', 'sub-border-size', outline],\n      ['set_property', 'sub-bold', weight >= 600 ? 'yes' : 'no'],\n      ['set_property', 'sub-delay', Number.isFinite(syncMs) ? syncMs / 1000 : 0]\n    ];\n    for (const command of commands) await this._command(command);\n  }\n\n`;
entry = entry.slice(0, loadTrackAt) + styleHelper + entry.slice(loadTrackAt);

entry = replaceOnce(
  entry,
  `      element.dispatchEvent(new Event('load'));\n`,
  `      element.dispatchEvent(new Event('load'));\n      // LILAC_R32_NATIVE_SUBTITLE_FALLBACK: keep one libmpv subtitle track loaded\n      // but invisible while focused. The raw native child HWND covers Chromium\n      // when blurred, so main toggles only this native subtitle visibility then.\n      const r32NativeSubtitle = element.dataset.lilacNativePath || element.src;\n      if (this._playerOpen && r32NativeSubtitle) {\n        await this._command(['set_property', 'sub-visibility', 'no']);\n        await this._command(['sub-remove']);\n        await this._command(['sub-add', r32NativeSubtitle, 'select']);\n        await this._syncR32NativeSubtitleFallbackStyle();\n        await this._command(['set_property', 'sub-visibility', document.hasFocus() ? 'no' : 'yes']);\n      }\n`,
  'load native subtitle fallback'
);

entry = replaceOnce(
  entry,
  `    if (index >= 0) this._tracks.splice(index, 1);\n    this.refreshSubtitleOverlay();`,
  `    if (index >= 0) this._tracks.splice(index, 1);\n    if (this._playerOpen) {\n      void this._command(['set_property', 'sub-visibility', 'no']);\n      void this._command(['sub-remove']);\n    }\n    this.refreshSubtitleOverlay();`,
  'remove native subtitle fallback with HTML track'
);

app = replaceOnce(
  app,
  `  const track=document.createElement('track');track.kind='subtitles';track.label=label;track.srclang='ko';track.src=src;track.default=true;video.append(track);`,
  `  const track=document.createElement('track');track.kind='subtitles';track.label=label;track.srclang='ko';track.src=src;track.default=true;\n  const nativeSubtitlePath=(options.assPath&&typeof assEffectsEnabled==='function'&&assEffectsEnabled()?options.assPath:options.path)||'';\n  if(nativeSubtitlePath)track.dataset.lilacNativePath=nativeSubtitlePath;\n  video.append(track);`,
  'attach native subtitle source path'
);

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
write('src/libmpv-shared-entry.js', entry);
write('src/app.js', app);

const rendererEntry = file('src/libmpv-shared-entry.js');
const rendererOut = file('src/libmpv-shared.generated.js');
buildSync({ entryPoints: [rendererEntry], outfile: rendererOut, bundle: true, platform: 'browser', format: 'iife', target: 'chrome150', logLevel: 'info' });

const finalNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalEntry = read('src/libmpv-shared-entry.js');
const finalBundle = read('src/libmpv-shared.generated.js');
const finalApp = read('src/app.js');
for (const marker of ['LILAC_R32_PRESENTER_BOUNDS_MAIN_THREAD','SetNativePresenterBounds','nativePresenterBoundsWidth','nativePresenterBoundsHeight']) {
  if (!finalNative.includes(marker)) throw new Error(`R32 bounds native marker missing: ${marker}`);
}
const presentStart = finalNative.indexOf('void R32PresentNativeFrame(');
const presentEnd = finalNative.indexOf('napi_value ConfigureNativePresenter(', presentStart);
if (presentStart < 0 || presentEnd <= presentStart) throw new Error('R32 present function audit boundary missing');
const presentBody = finalNative.slice(presentStart, presentEnd);
for (const forbidden of ['SetWindowPos(', 'ShowWindow(', 'GetClientRect(']) if (presentBody.includes(forbidden)) throw new Error(`producer presenter retained UI-thread operation: ${forbidden}`);
for (const marker of ['setNativePresenterBounds','r32SyncNativePresenterBounds',"'sub-visibility', useNative ? 'yes' : 'no'"]) {
  if (!finalBridge.includes(marker)) throw new Error(`R32 bounds/subtitle bridge marker missing: ${marker}`);
}
for (const marker of ['LILAC_R32_NATIVE_SUBTITLE_FALLBACK','dataset.lilacNativePath','sub-add','sub-visibility','rect.left * dpr','rect.top * dpr']) {
  if (!finalEntry.includes(marker) || (marker !== 'dataset.lilacNativePath' && marker !== 'sub-add' && marker !== 'sub-visibility' && !finalBundle.includes(marker))) {
    throw new Error(`R32 renderer fallback marker missing: ${marker}`);
  }
}
if (!finalApp.includes('track.dataset.lilacNativePath')) throw new Error('R32 app native subtitle path marker missing');
console.log('R32_PRESENTER_BOUNDS_SUBTITLE_OK bounds=video-rect hwndOps=main-only producer=copyresource+present subtitle=libmpv-unfocused focusedSubtitle=html-vtt rendererBundle=rebuilt');

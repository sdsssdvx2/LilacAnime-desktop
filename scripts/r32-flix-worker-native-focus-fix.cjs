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

let player = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');
let preload = read('electron/libmpv-shared-preload.cjs');
let flix = read('electron/flix-proxy.cjs');

if (!player.includes('FrameProducerReadyFrame') || !player.includes('producerCv.wait_for')) throw new Error('R32 requires R3E native producer source');
if (!bridge.includes('LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN') || !bridge.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R32 requires R30/R27 bridge baseline');
if (!preload.includes('LILAC_R31_FOCUS_COMPOSITOR_SHIELD')) throw new Error('R32 requires R31 focus shield baseline');
if (!flix.includes('function decodeSegment(body)') || !flix.includes('async function fetchRanges')) throw new Error('R32 requires Flix proxy baseline');
if ([player, bridge, preload, flix].some(source => source.includes('LILAC_R32_NATIVE_HWND_FOCUS_SURFACE') || source.includes('LILAC_R32_FLIX_WORKER_ISOLATION'))) throw new Error('R32 already applied');

// ---------------------------------------------------------------------------
// 1) FlixCloud proxy isolation. The R31 runtime trace showed second-scale main
// dispatch gaps while the proxy handled ~200 segments / 188 MiB. Keep the same
// localhost HTTP API but move all range fetching, Buffer.concat, XOR decode and
// prefetch work onto one worker_threads worker. Segment traffic never crosses
// main-process IPC; libmpv connects directly to the worker's loopback server.
// ---------------------------------------------------------------------------
flix = replaceOnce(
  flix,
  "const crypto=require('crypto');\n",
  "const crypto=require('crypto');\nconst {Worker,isMainThread,parentPort,workerData}=require('worker_threads'); // LILAC_R32_FLIX_WORKER_ISOLATION\n",
  'R32 Flix worker import'
);

const oldFlixExports = 'module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,fetchHedged,primeFlix,flixReadable};';
const newFlixExports = String.raw`
const r32DirectApi={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,primeFlix,flixReadable};

if(!isMainThread&&workerData?.lilacR32FlixWorker===true){
  parentPort.on('message',async message=>{
    const id=Number(message?.id)||0,op=String(message?.op||''),args=Array.isArray(message?.args)?message.args:[];
    try{
      if(typeof r32DirectApi[op]!=='function')throw new Error('unknown Flix worker operation');
      const value=await r32DirectApi[op](...args);
      parentPort.postMessage({id,ok:true,value});
    }catch(error){
      parentPort.postMessage({id,ok:false,error:String(error?.message||error).slice(0,500)});
    }
  });
}

let r32Worker=null,r32WorkerSeq=0;
const r32WorkerPending=new Map();
function r32EnsureWorker(){
  if(r32Worker)return r32Worker;
  const worker=new Worker(__filename,{workerData:{lilacR32FlixWorker:true}});
  worker.on('message',message=>{
    const pending=r32WorkerPending.get(Number(message?.id));if(!pending)return;
    r32WorkerPending.delete(Number(message.id));
    message?.ok?pending.resolve(message.value):pending.reject(new Error(String(message?.error||'Flix worker failed')));
  });
  const fail=error=>{
    if(r32Worker===worker)r32Worker=null;
    const reason=error instanceof Error?error:new Error(String(error||'Flix worker stopped'));
    for(const pending of r32WorkerPending.values())pending.reject(reason);
    r32WorkerPending.clear();
  };
  worker.on('error',fail);
  worker.on('exit',code=>{if(code!==0&&r32Worker===worker)fail(new Error(`Flix worker exited (${code})`));else if(r32Worker===worker)r32Worker=null;});
  r32Worker=worker;
  return worker;
}
function r32Rpc(op,args=[]){
  const worker=r32EnsureWorker(),id=++r32WorkerSeq;
  return new Promise((resolve,reject)=>{r32WorkerPending.set(id,{resolve,reject});worker.postMessage({id,op,args});});
}
function r32CloseWorker(){
  const worker=r32Worker;r32Worker=null;
  for(const pending of r32WorkerPending.values())pending.reject(new Error('Flix worker closed'));
  r32WorkerPending.clear();
  if(worker)void worker.terminate();
}

module.exports=isMainThread?{
  createFlixProxyUrl:(...args)=>r32Rpc('createFlixProxyUrl',args),
  createFlixAvProxyUrl:(...args)=>r32Rpc('createFlixAvProxyUrl',args),
  closeFlixProxy:r32CloseWorker,
  primeFlix:(...args)=>r32Rpc('primeFlix',args),
  flixReadable:(...args)=>r32Rpc('flixReadable',args),
  fetchHedged
}:r32DirectApi;`;
flix = replaceOnce(flix, oldFlixExports, newFlixExports, 'R32 Flix worker exports');

// ---------------------------------------------------------------------------
// 2) Native callback watchdog + Chromium-independent focus presenter.
// R31 proved 500 successful Canvas2D shield frames while black flashing remained.
// Therefore the fallback must live below the renderer/compositor. Reuse the same
// libmpv D3D11 texture and copy it to a raw WS_CHILD HWND swapchain only while the
// Electron window is unfocused. No second decoder, mpv.exe or CPU readback.
// ---------------------------------------------------------------------------

const presenterWindowProc = String.raw`
static const wchar_t* kR32PresenterClass = L"LilacR32NativeFocusPresenter";

LRESULT CALLBACK R32NativePresenterWndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == WM_NCHITTEST) return HTTRANSPARENT;
  if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATEANDEAT;
  if (message == WM_ERASEBKGND) return 1;
  return DefWindowProcW(hwnd, message, wParam, lParam);
}

`;
player = replaceOnce(player, 'struct TextureSlot {\n', presenterWindowProc + 'struct TextureSlot {\n', 'R32 presenter window proc');

player = replaceOnce(
  player,
  `  double producerRenderTotalMs = 0.0;\n  double producerRenderMaxMs = 0.0;\n\n  void StopFrameProducerWorker() {`,
  `  double producerRenderTotalMs = 0.0;\n  double producerRenderMaxMs = 0.0;\n\n  // LILAC_R32_NATIVE_HWND_FOCUS_SURFACE: a raw Win32/DXGI child surface used\n  // only while the Electron window is unfocused. It shares this player's D3D11\n  // device and rendered texture; no second decoder or Chromium presentation.\n  std::mutex nativePresenterMutex;\n  HWND nativePresenterParent = nullptr;\n  HWND nativePresenterHwnd = nullptr;\n  ComPtr<IDXGISwapChain> nativePresenterSwapChain;\n  ComPtr<ID3D11Texture2D> nativePresenterBackBuffer;\n  std::atomic<bool> nativePresenterRequested{false};\n  bool nativePresenterVisible = false;\n  uint32_t nativePresenterWidth = 0;\n  uint32_t nativePresenterHeight = 0;\n  uint64_t nativePresenterFrames = 0;\n  uint64_t nativePresenterFailures = 0;\n  double nativePresenterPresentTotalMs = 0.0;\n  double nativePresenterPresentMaxMs = 0.0;\n  std::string nativePresenterLastError;\n\n  void StopFrameProducerWorker() {`,
  'R32 presenter player fields'
);

player = replaceOnce(
  player,
  `    StopFrameProducerWorker();\n    napi_threadsafe_function tsfn = updateTsfn.exchange(nullptr, std::memory_order_acq_rel);`,
  `    StopFrameProducerWorker();\n    {\n      std::lock_guard<std::mutex> presenterLock(nativePresenterMutex);\n      nativePresenterRequested.store(false, std::memory_order_release);\n      nativePresenterBackBuffer.Reset();\n      nativePresenterSwapChain.Reset();\n      if (nativePresenterHwnd) { DestroyWindow(nativePresenterHwnd); nativePresenterHwnd = nullptr; }\n      nativePresenterParent = nullptr;\n      nativePresenterVisible = false;\n    }\n    napi_threadsafe_function tsfn = updateTsfn.exchange(nullptr, std::memory_order_acq_rel);`,
  'R32 presenter cleanup'
);

const presenterHelpers = String.raw`
bool R32RegisterPresenterClass(std::string* error) {
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = R32NativePresenterWndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  wc.lpszClassName = kR32PresenterClass;
  if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
    *error = "RegisterClassExW failed win32=" + std::to_string(GetLastError());
    return false;
  }
  return true;
}

bool R32ConfigurePresenter(Player* player, HWND parent, std::string* error) {
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
  RECT rect{};
  GetClientRect(parent, &rect);
  const int width = std::max<LONG>(2, rect.right - rect.left);
  const int height = std::max<LONG>(2, rect.bottom - rect.top);
  HWND hwnd = CreateWindowExW(
    WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
    kR32PresenterClass, L"", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
    0, 0, width, height, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!hwnd) {
    *error = "CreateWindowExW native presenter failed win32=" + std::to_string(GetLastError());
    player->nativePresenterParent = nullptr;
    return false;
  }
  player->nativePresenterHwnd = hwnd;
  SetWindowPos(hwnd, HWND_TOP, 0, 0, width, height, SWP_NOACTIVATE | SWP_HIDEWINDOW);
  return true;
}

bool R32EnsurePresenterSwapChain(Player* player, uint32_t width, uint32_t height, std::string* error) {
  if (!player->nativePresenterHwnd || !IsWindow(player->nativePresenterHwnd)) {
    *error = "native presenter HWND unavailable";
    return false;
  }
  if (player->nativePresenterSwapChain && player->nativePresenterBackBuffer &&
      player->nativePresenterWidth == width && player->nativePresenterHeight == height) return true;

  player->nativePresenterBackBuffer.Reset();
  if (player->nativePresenterSwapChain) {
    HRESULT resizeHr = player->nativePresenterSwapChain->ResizeBuffers(2, width, height, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
    if (FAILED(resizeHr)) {
      player->nativePresenterSwapChain.Reset();
    }
  }
  if (!player->nativePresenterSwapChain) {
    ComPtr<IDXGIDevice> dxgiDevice;
    HRESULT hr = player->device.As(&dxgiDevice);
    if (FAILED(hr)) { *error = "Query IDXGIDevice failed " + HrHex(hr); return false; }
    ComPtr<IDXGIAdapter> adapter;
    hr = dxgiDevice->GetAdapter(adapter.GetAddressOf());
    if (FAILED(hr)) { *error = "GetAdapter failed " + HrHex(hr); return false; }
    ComPtr<IDXGIFactory> factory;
    hr = adapter->GetParent(__uuidof(IDXGIFactory), reinterpret_cast<void**>(factory.GetAddressOf()));
    if (FAILED(hr)) { *error = "GetParent IDXGIFactory failed " + HrHex(hr); return false; }
    DXGI_SWAP_CHAIN_DESC desc{};
    desc.BufferDesc.Width = width;
    desc.BufferDesc.Height = height;
    desc.BufferDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.OutputWindow = player->nativePresenterHwnd;
    desc.Windowed = TRUE;
    desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    hr = factory->CreateSwapChain(player->device.Get(), &desc, player->nativePresenterSwapChain.GetAddressOf());
    if (FAILED(hr)) { *error = "CreateSwapChain native presenter failed " + HrHex(hr); return false; }
  }
  HRESULT hr = player->nativePresenterSwapChain->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(player->nativePresenterBackBuffer.GetAddressOf()));
  if (FAILED(hr)) { *error = "GetBuffer native presenter failed " + HrHex(hr); return false; }
  player->nativePresenterWidth = width;
  player->nativePresenterHeight = height;
  return true;
}

void R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {
  if (!player || !slot || !slot->texture || !player->nativePresenterRequested.load(std::memory_order_acquire)) return;
  const auto started = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  if (!player->nativePresenterRequested.load(std::memory_order_acquire) || !player->nativePresenterHwnd) return;
  std::string error;
  RECT rect{};
  GetClientRect(player->nativePresenterParent, &rect);
  const int childWidth = std::max<LONG>(2, rect.right - rect.left);
  const int childHeight = std::max<LONG>(2, rect.bottom - rect.top);
  SetWindowPos(player->nativePresenterHwnd, HWND_TOP, 0, 0, childWidth, childHeight, SWP_NOACTIVATE | (player->nativePresenterVisible ? 0 : SWP_HIDEWINDOW));
  if (!R32EnsurePresenterSwapChain(player, width, height, &error)) {
    player->nativePresenterFailures += 1;
    player->nativePresenterLastError = error;
    return;
  }
  player->context->CopyResource(player->nativePresenterBackBuffer.Get(), slot->texture.Get());
  const HRESULT hr = player->nativePresenterSwapChain->Present(0, 0);
  if (FAILED(hr)) {
    player->nativePresenterFailures += 1;
    player->nativePresenterLastError = "Present native presenter failed " + HrHex(hr);
    return;
  }
  if (!player->nativePresenterVisible) {
    ShowWindow(player->nativePresenterHwnd, SW_SHOWNOACTIVATE);
    SetWindowPos(player->nativePresenterHwnd, HWND_TOP, 0, 0, childWidth, childHeight, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    player->nativePresenterVisible = true;
  }
  const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  player->nativePresenterFrames += 1;
  player->nativePresenterPresentTotalMs += elapsed;
  player->nativePresenterPresentMaxMs = std::max(player->nativePresenterPresentMaxMs, elapsed);
}

`;
player = replaceOnce(player, 'bool SetOption(Player* player, const char* key, const char* value, std::string* error) {', presenterHelpers + 'bool SetOption(Player* player, const char* key, const char* value, std::string* error) {', 'R32 presenter helpers');

player = replaceOnce(
  player,
  'player->producerCv.wait_for(lock, std::chrono::milliseconds(6), [player]() {',
  'player->producerCv.wait_for(lock, std::chrono::milliseconds(250), [player]() { // LILAC_R32_NATIVE_CALLBACK_WATCHDOG',
  'R32 native producer watchdog'
);

player = replaceOnce(
  player,
  `        const double renderMs = std::chrono::duration<double, std::milli>(\n          std::chrono::steady_clock::now() - renderStarted).count();\n\n        bool queuedFrame = false;`,
  `        const double renderMs = std::chrono::duration<double, std::milli>(\n          std::chrono::steady_clock::now() - renderStarted).count();\n\n        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {\n          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }\n\n        bool queuedFrame = false;`,
  'R32 present same native producer texture'
);

const presenterApi = String.raw`
napi_value ConfigureNativePresenter(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  std::string hwndText;
  if (argc < 2 || !ReadUint32(env, argv[0], &id) || !ReadUtf8(env, argv[1], &hwndText)) {
    Throw(env, "configureNativePresenter(playerId, hwndText) requires id and parent HWND");
    return nullptr;
  }
  uintptr_t raw = 0;
  try { raw = static_cast<uintptr_t>(std::stoull(hwndText, nullptr, 10)); }
  catch (...) { Throw(env, "invalid native presenter HWND text"); return nullptr; }
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) { Throw(env, "unknown player id"); return nullptr; }
  std::string error;
  if (!R32ConfigurePresenter(player, reinterpret_cast<HWND>(raw), &error)) { Throw(env, error); return nullptr; }
  return BoolValue(env, true);
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
  player->nativePresenterRequested.store(visible, std::memory_order_release);
  if (!visible) {
    std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
    if (player->nativePresenterHwnd) ShowWindow(player->nativePresenterHwnd, SW_HIDE);
    player->nativePresenterVisible = false;
  }
  return BoolValue(env, true);
}

napi_value NativePresenterStats(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return NullValue(env);
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return NullValue(env);
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "marker", StringValue(env, "LILAC_R32_NATIVE_HWND_FOCUS_SURFACE"));
  Set(env, out, "configured", BoolValue(env, player->nativePresenterHwnd && IsWindow(player->nativePresenterHwnd)));
  Set(env, out, "requestedVisible", BoolValue(env, player->nativePresenterRequested.load(std::memory_order_acquire)));
  Set(env, out, "visible", BoolValue(env, player->nativePresenterVisible));
  Set(env, out, "presentedFrames", DoubleValue(env, static_cast<double>(player->nativePresenterFrames)));
  Set(env, out, "failures", DoubleValue(env, static_cast<double>(player->nativePresenterFailures)));
  Set(env, out, "avgPresentMs", DoubleValue(env, player->nativePresenterFrames ? player->nativePresenterPresentTotalMs / static_cast<double>(player->nativePresenterFrames) : 0.0));
  Set(env, out, "maxPresentMs", DoubleValue(env, player->nativePresenterPresentMaxMs));
  Set(env, out, "width", Uint32Value(env, player->nativePresenterWidth));
  Set(env, out, "height", Uint32Value(env, player->nativePresenterHeight));
  Set(env, out, "lastError", player->nativePresenterLastError.empty() ? NullValue(env) : StringValue(env, player->nativePresenterLastError));
  return out;
}

`;
player = replaceOnce(player, 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', presenterApi + 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', 'R32 presenter N-API functions');

player = replaceOnce(
  player,
  `    {"frameProducerStats", nullptr, FrameProducerStats, nullptr, nullptr, nullptr, napi_default, nullptr},\n`,
  `    {"frameProducerStats", nullptr, FrameProducerStats, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"configureNativePresenter", nullptr, ConfigureNativePresenter, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"setNativePresenterVisible", nullptr, SetNativePresenterVisible, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"nativePresenterStats", nullptr, NativePresenterStats, nullptr, nullptr, nullptr, napi_default, nullptr},\n`,
  'R32 presenter N-API exports'
);

// Main bridge: require, configure and toggle the native presenter from the same
// focus events already retained by R27.
bridge = replaceOnce(
  bridge,
  "'frameProducerStats', 'destroyPlayer']",
  "'frameProducerStats', 'configureNativePresenter', 'setNativePresenterVisible', 'nativePresenterStats', 'destroyPlayer']",
  'R32 require presenter exports'
);

const ensurePlayerAt = bridge.indexOf('  function ensurePlayer() {');
if (ensurePlayerAt < 0) throw new Error('R32 ensurePlayer boundary missing');
const bridgeHelpers = `  function r32ParentHwndText(win = attachedWindow) {\n    if (!win || win.isDestroyed?.()) return null;\n    try {\n      const raw = win.getNativeWindowHandle();\n      if (!Buffer.isBuffer(raw) || raw.length < 4) return null;\n      return raw.length >= 8 ? raw.readBigUInt64LE(0).toString(10) : String(raw.readUInt32LE(0));\n    } catch { return null; }\n  }\n\n  function r32ConfigureNativePresenter() {\n    if (!addon || playerId == null || !attachedWindow || attachedWindow.isDestroyed()) return false;\n    const hwndText = r32ParentHwndText();\n    if (!hwndText) return false;\n    try {\n      addon.configureNativePresenter(playerId, hwndText);\n      addon.setNativePresenterVisible(playerId, typeof attachedWindow.isFocused === 'function' ? !attachedWindow.isFocused() : false);\n      return true;\n    } catch (error) {\n      lastError = \`R32 native presenter configure failed: \${String(error?.message || error).slice(0, 180)}\`;\n      return false;\n    }\n  }\n\n  function r32ApplyNativePresenterFocus(focused) {\n    if (!addon || playerId == null) return;\n    try { addon.setNativePresenterVisible(playerId, !Boolean(focused) && active); } catch (error) {\n      lastError = \`R32 native presenter focus failed: \${String(error?.message || error).slice(0, 180)}\`;\n    }\n  }\n\n`;
bridge = bridge.slice(0, ensurePlayerAt) + bridgeHelpers + bridge.slice(ensurePlayerAt);

bridge = replaceOnce(
  bridge,
  `    if (!Number.isInteger(playerId) || playerId <= 0) throw new Error('libmpv player creation failed');\n    return playerId;`,
  `    if (!Number.isInteger(playerId) || playerId <= 0) throw new Error('libmpv player creation failed');\n    r32ConfigureNativePresenter();\n    return playerId;`,
  'R32 configure presenter on player creation'
);

bridge = replaceOnce(
  bridge,
  `    active = true;\n    schedulePump(0);`,
  `    active = true;\n    r32ConfigureNativePresenter();\n    r32ApplyNativePresenterFocus(typeof attachedWindow?.isFocused === 'function' ? attachedWindow.isFocused() : true);\n    schedulePump(0);`,
  'R32 presenter visibility on open'
);

bridge = replaceOnce(
  bridge,
  `    active = false;\n    generation += 1;`,
  `    active = false;\n    r32ApplyNativePresenterFocus(true);\n    generation += 1;`,
  'R32 hide presenter on stop'
);

bridge = replaceOnce(
  bridge,
  `    const r27OnFocus = () => r27RecordMainFocus('focus', true);\n    const r27OnBlur = () => r27RecordMainFocus('blur', false);`,
  `    const r27OnFocus = () => { r27RecordMainFocus('focus', true); r32ApplyNativePresenterFocus(true); };\n    const r27OnBlur = () => { r27RecordMainFocus('blur', false); r32ApplyNativePresenterFocus(false); };`,
  'R32 native presenter focus listeners'
);

bridge = replaceOnce(
  bridge,
  `    r27RecordMainFocus('attach', typeof win.isFocused === 'function' ? win.isFocused() : false);`,
  `    r27RecordMainFocus('attach', typeof win.isFocused === 'function' ? win.isFocused() : false);\n    if (playerId != null) r32ConfigureNativePresenter();`,
  'R32 configure on window attach'
);

bridge = replaceOnce(
  bridge,
  `      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      r30ProducerDrain: {`,
  `      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      r32NativePresenter: typeof addon.nativePresenterStats === 'function' ? addon.nativePresenterStats(playerId) : null,\n      r30ProducerDrain: {`,
  'R32 native presenter diagnostics'
);

// R31 Canvas2D shield is deliberately disabled. Its runtime counters proved that
// it rendered successfully while the visible black flashing persisted.
preload = replaceOnce(
  preload,
  '      const r31UseFocusShield = r27RendererFocused === false;',
  '      const r31UseFocusShield = false; // LILAC_R32_NATIVE_HWND_FOCUS_SURFACE handles unfocused presentation',
  'R32 disable R31 unfocused canvas shield'
);
preload = replaceOnce(
  preload,
  '          const r31MirrorNow = r31FocusRecoveryFrames > 0 || !r31FocusShieldReady || (r31FocusedMirrorCounter % 8 === 1);',
  '          const r31MirrorNow = false; // R32 native HWND makes Canvas2D prewarm unnecessary',
  'R32 disable R31 canvas prewarm'
);
preload = replaceOnce(
  preload,
  '    if (r31FocusShieldReady) r31SetFocusShieldVisible(true);',
  '    r31SetFocusShieldVisible(false); // R32 native HWND owns the blur fallback',
  'R32 keep R31 shield hidden on blur'
);

write('native/libmpv-d3d11-bridge/player_addon.cc', player);
write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);
write('electron/flix-proxy.cjs', flix);

const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const preloadOut = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(preloadEntry)) throw new Error('R32 preload entry missing');
buildSync({ entryPoints: [preloadEntry], outfile: preloadOut, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'info' });

const checks = {
  player: read('native/libmpv-d3d11-bridge/player_addon.cc'),
  bridge: read('electron/libmpv-shared-main.cjs'),
  preload: read('electron/libmpv-shared-preload.cjs'),
  bundled: read('electron/preload-libmpv-shared.generated.cjs'),
  flix: read('electron/flix-proxy.cjs')
};
for (const marker of ['LILAC_R32_NATIVE_HWND_FOCUS_SURFACE','ConfigureNativePresenter','SetNativePresenterVisible','NativePresenterStats','R32PresentNativeFrame','std::chrono::milliseconds(250)']) {
  if (!checks.player.includes(marker)) throw new Error(`R32 native marker missing: ${marker}`);
}
for (const marker of ['configureNativePresenter','setNativePresenterVisible','nativePresenterStats','r32ConfigureNativePresenter','r32ApplyNativePresenterFocus']) {
  if (!checks.bridge.includes(marker)) throw new Error(`R32 bridge marker missing: ${marker}`);
}
if (!checks.preload.includes('const r31UseFocusShield = false') || !checks.bundled.includes('R32_NATIVE_HWND_FOCUS_SURFACE')) throw new Error('R32 renderer shield disable missing');
for (const marker of ['LILAC_R32_FLIX_WORKER_ISOLATION','new Worker(__filename','r32Rpc(','lilacR32FlixWorker']) {
  if (!checks.flix.includes(marker)) throw new Error(`R32 Flix worker marker missing: ${marker}`);
}

console.log('R32_FOCUS_STUTTER_FIX_OK focus=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread nativeWatchdogMs=250 focusedPresenter=direct-webgpu r31CanvasShield=disabled');

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

let player = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');

if (!bridge.includes('async function deliverImportedFrame') || !bridge.includes('nextNativeFrameDeadlinePerfAt')) {
  throw new Error('R3B requires the complete R3A decoupled-delivery + absolute-phase baseline');
}
if (!player.includes('kSharedTextureSlots = 24')) throw new Error('R3B requires the qualified 24-slot native baseline');

player = replaceOnce(player,
  '#include <array>\n#include <chrono>',
  '#include <array>\n#include <atomic>\n#include <chrono>',
  'atomic include');

player = replaceOnce(player,
  '  decltype(&mpv_render_context_create) render_context_create = nullptr;\n  decltype(&mpv_render_context_update) render_context_update = nullptr;',
  '  decltype(&mpv_render_context_create) render_context_create = nullptr;\n  decltype(&mpv_render_context_set_update_callback) render_context_set_update_callback = nullptr;\n  decltype(&mpv_render_context_update) render_context_update = nullptr;',
  'render update callback API field');

player = replaceOnce(player,
  '  LOAD_MPV("mpv_render_context_create", render_context_create);\n  LOAD_MPV("mpv_render_context_update", render_context_update);',
  '  LOAD_MPV("mpv_render_context_create", render_context_create);\n  LOAD_MPV("mpv_render_context_set_update_callback", render_context_set_update_callback);\n  LOAD_MPV("mpv_render_context_update", render_context_update);',
  'load render update callback API');

player = replaceOnce(player,
  '  bool eof = false;\n  std::string lastError;\n\n  ~Player() { Destroy(); }',
  `  bool eof = false;\n  std::string lastError;\n  std::atomic<napi_threadsafe_function> updateTsfn{nullptr};\n  std::atomic<bool> updateCallbackEnabled{false};\n  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  ~Player() { Destroy(); }`,
  'player update callback state');

player = replaceOnce(player,
  `  void Destroy() {\n    if (render) {\n      gMpv.render_context_free(render);`,
  `  void Destroy() {\n    updateCallbackEnabled.store(false, std::memory_order_release);\n    if (render && gMpv.render_context_set_update_callback) {\n      gMpv.render_context_set_update_callback(render, nullptr, nullptr);\n    }\n    while (updateCallbacksInFlight.load(std::memory_order_acquire) != 0) Sleep(0);\n    napi_threadsafe_function tsfn = updateTsfn.exchange(nullptr, std::memory_order_acq_rel);\n    if (tsfn) napi_release_threadsafe_function(tsfn, napi_tsfn_abort);\n    if (render) {\n      gMpv.render_context_free(render);`,
  'safe update callback teardown');

player = replaceOnce(player,
  'std::unordered_map<uint32_t, std::unique_ptr<Player>> gPlayers;\n\nbool SetOption',
  `std::unordered_map<uint32_t, std::unique_ptr<Player>> gPlayers;\n\nvoid CallUpdateJs(napi_env env, napi_value jsCallback, void*, void*) {\n  if (!env || !jsCallback) return;\n  napi_value undefined;\n  if (napi_get_undefined(env, &undefined) != napi_ok) return;\n  napi_call_function(env, undefined, jsCallback, 0, nullptr, nullptr);\n}\n\nvoid RenderUpdateWake(void* context) {\n  Player* player = static_cast<Player*>(context);\n  if (!player) return;\n  player->updateCallbacksInFlight.fetch_add(1, std::memory_order_acq_rel);\n  if (player->updateCallbackEnabled.load(std::memory_order_acquire)) {\n    napi_threadsafe_function tsfn = player->updateTsfn.load(std::memory_order_acquire);\n    if (tsfn) {\n      const napi_status status = napi_call_threadsafe_function(tsfn, nullptr, napi_tsfn_nonblocking);\n      (void)status; // Queue-full/closing is intentionally coalesced; the fallback pump remains armed.\n    }\n  }\n  player->updateCallbacksInFlight.fetch_sub(1, std::memory_order_acq_rel);\n}\n\nbool SetOption`,
  'native update wake helpers');

player = replaceOnce(player,
  'napi_value Open(napi_env env, napi_callback_info info) {',
  `napi_value SetUpdateCallback(napi_env env, napi_callback_info info) {\n  size_t argc = 2;\n  napi_value argv[2];\n  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);\n  uint32_t id = 0;\n  napi_valuetype callbackType = napi_undefined;\n  if (argc < 2 || !ReadUint32(env, argv[0], &id) || napi_typeof(env, argv[1], &callbackType) != napi_ok || callbackType != napi_function) {\n    Throw(env, "setUpdateCallback(playerId, callback) requires id and function");\n    return nullptr;\n  }\n\n  std::lock_guard<std::mutex> lock(gMutex);\n  Player* player = FindPlayer(id);\n  if (!player || !player->render) {\n    Throw(env, "unknown or uninitialized player id");\n    return nullptr;\n  }\n  if (player->updateTsfn.load(std::memory_order_acquire)) {\n    Throw(env, "update callback already installed");\n    return nullptr;\n  }\n\n  napi_value resourceName;\n  napi_create_string_utf8(env, "lilac-libmpv-render-update", NAPI_AUTO_LENGTH, &resourceName);\n  napi_threadsafe_function tsfn = nullptr;\n  const napi_status status = napi_create_threadsafe_function(\n    env, argv[1], nullptr, resourceName,\n    1, 1, nullptr, nullptr, nullptr, CallUpdateJs, &tsfn);\n  if (status != napi_ok || !tsfn) {\n    Throw(env, "napi_create_threadsafe_function failed");\n    return nullptr;\n  }\n\n  player->updateTsfn.store(tsfn, std::memory_order_release);\n  player->updateCallbackEnabled.store(true, std::memory_order_release);\n  gMpv.render_context_set_update_callback(player->render, RenderUpdateWake, player);\n  return BoolValue(env, true);\n}\n\nnapi_value Open(napi_env env, napi_callback_info info) {`,
  'setUpdateCallback N-API function');

player = replaceOnce(player,
  '    {"poll", nullptr, Poll, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},',
  '    {"poll", nullptr, Poll, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"setUpdateCallback", nullptr, SetUpdateCallback, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},',
  'export setUpdateCallback');

bridge = replaceOnce(bridge,
  "for (const name of ['createPlayer', 'open', 'command', 'poll', 'renderFrame', 'releaseFrame', 'destroyPlayer'])",
  "for (const name of ['createPlayer', 'open', 'command', 'poll', 'setUpdateCallback', 'renderFrame', 'releaseFrame', 'destroyPlayer'])",
  'require native update callback export');

bridge = replaceOnce(bridge,
  '  let pumpTimerDuePerfAt = 0;\n  const MAX_PENDING_DELIVERY_FRAMES = 12;',
  `  let pumpTimerDuePerfAt = 0;\n  let nativeUpdateCallbackInstalled = false;\n  const MAX_PENDING_DELIVERY_FRAMES = 12;`,
  'bridge callback install state');

// R3A phase-deadline appends its two metrics after pumpRenderMaxMs. Anchor the
// complete post-R3A tail so future ordering mistakes fail loudly instead of
// silently dropping either diagnostic family.
bridge = replaceOnce(bridge,
  '    pumpRenderTotalMs: 0,\n    pumpRenderMaxMs: 0,\n    pumpPhaseCatchupPeriods: 0,\n    pumpPhaseLateMaxMs: 0\n  };',
  `    pumpRenderTotalMs: 0,\n    pumpRenderMaxMs: 0,\n    pumpPhaseCatchupPeriods: 0,\n    pumpPhaseLateMaxMs: 0,\n    nativeUpdateSignals: 0,\n    nativeUpdateWakeups: 0\n  };`,
  'callback diagnostics after absolute-phase diagnostics');

bridge = replaceOnce(bridge,
  `  function schedulePump(delay = 4) {\n    if (!active || disposed) return;`,
  `  function wakePumpFromNative() {\n    metrics.nativeUpdateSignals += 1;\n    if (!active || disposed || !addon || playerId == null) return;\n    if (pumpTimer) {\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n      pumpTimerDuePerfAt = 0;\n    }\n    if (pumpRunning) return;\n    metrics.nativeUpdateWakeups += 1;\n    void pump();\n  }\n\n  function schedulePump(delay = 4) {\n    if (!active || disposed) return;`,
  'event-driven native wake');

bridge = replaceOnce(bridge,
  `    const created = addon.createPlayer();\n    playerId = Number(created.playerId);\n    if (!Number.isInteger(playerId) || playerId <= 0) throw new Error('libmpv player creation failed');\n    return playerId;`,
  `    const created = addon.createPlayer();\n    playerId = Number(created.playerId);\n    if (!Number.isInteger(playerId) || playerId <= 0) throw new Error('libmpv player creation failed');\n    addon.setUpdateCallback(playerId, wakePumpFromNative);\n    nativeUpdateCallbackInstalled = true;\n    return playerId;`,
  'install update callback on player creation');

bridge = replaceOnce(bridge,
  '    let nextDelay = 4;',
  '    let nextDelay = nativeUpdateCallbackInstalled ? 250 : 4;',
  'callback-driven fallback delay');

bridge = replaceOnce(bridge,
  `      if (!nativeFrame?.updated) {\n        nextDelay = nextActivePumpDelay();\n        return;\n      }`,
  `      if (!nativeFrame?.updated) {\n        nextDelay = nativeUpdateCallbackInstalled ? 250 : nextActivePumpDelay();\n        return;\n      }`,
  'no-frame callback fallback');

bridge = replaceOnce(bridge,
  `      lastNativeFramePerfAt = performance.now();\n      advanceNativeFrameDeadline(lastNativeFramePerfAt);\n      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);`,
  `      lastNativeFramePerfAt = performance.now();\n      advanceNativeFrameDeadline(lastNativeFramePerfAt);\n      nextDelay = nativeUpdateCallbackInstalled ? 250 : nextActivePumpDelay(lastNativeFramePerfAt);`,
  'frame callback fallback');

bridge = replaceOnce(bridge,
  `        try { addon.destroyPlayer(closingPlayerId); } catch {}\n        if (playerId === closingPlayerId) playerId = null;`,
  `        try { addon.destroyPlayer(closingPlayerId); } catch {}\n        if (playerId === closingPlayerId) {\n          playerId = null;\n          nativeUpdateCallbackInstalled = false;\n        }`,
  'reset callback install state');

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r3a.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r10') {
  throw new Error(`expected R3A identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r3b.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r11';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R3B-Setup.${ext}';

for (const marker of [
  'mpv_render_context_set_update_callback',
  'napi_create_threadsafe_function',
  'RenderUpdateWake',
  'setUpdateCallback',
  'updateCallbacksInFlight'
]) if (!player.includes(marker)) throw new Error(`R3B native marker missing: ${marker}`);
for (const marker of [
  'wakePumpFromNative',
  'nativeUpdateCallbackInstalled',
  'nativeUpdateSignals',
  'nativeUpdateWakeups',
  'addon.setUpdateCallback(playerId, wakePumpFromNative)',
  'nativeUpdateCallbackInstalled ? 250',
  'pumpPhaseCatchupPeriods',
  'pumpPhaseLateMaxMs'
]) if (!bridge.includes(marker)) throw new Error(`R3B bridge marker missing: ${marker}`);
if (bridge.includes('await sharedTexture.sendSharedTexture')) throw new Error('R3B regressed decoupled delivery');

write('native/libmpv-d3d11-bridge/player_addon.cc', player);
write('electron/libmpv-shared-main.cjs', bridge);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

console.log('LIBMPV_R3B_OK wake=mpv-render-update-tsfn pump=direct callbackFallbackMs=250 delivery=decoupled');

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
function replaceAllExpected(source, needle, replacement, expected, label) {
  const count = source.split(needle).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected} anchors, found ${count}`);
  return source.split(needle).join(replacement);
}

let player = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');

if (!player.includes('napi_value PollPlayback') || !player.includes('mpv_render_context_set_update_callback')) {
  throw new Error('R3D render worker requires R3C/R3B native baseline');
}
if (!bridge.includes('fullDiagnostics ? addon.poll(playerId) : addon.pollPlayback(playerId)')) {
  throw new Error('R3D render worker requires R3C bridge baseline');
}

player = replaceOnce(player,
  '#include <chrono>\n#include <cstdint>',
  '#include <chrono>\n#include <condition_variable>\n#include <cstdint>\n#include <deque>',
  'worker synchronization includes');
player = replaceOnce(player,
  '#include <string>\n#include <unordered_map>',
  '#include <string>\n#include <thread>\n#include <unordered_map>',
  'worker thread include');

player = replaceOnce(player,
  `  bool inFlight = false;\n  uint64_t frameId = 0;`,
  `  bool inFlight = false;\n  bool readyForJs = false;\n  uint64_t frameId = 0;\n  double timestampUs = 0;`,
  'texture worker state');
player = replaceOnce(player,
  `    inFlight = false;\n    frameId = 0;`,
  `    inFlight = false;\n    readyForJs = false;\n    frameId = 0;\n    timestampUs = 0;`,
  'texture worker reset');

player = replaceOnce(player,
  `  std::atomic<napi_threadsafe_function> updateTsfn{nullptr};\n  std::atomic<bool> updateCallbackEnabled{false};\n  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  ~Player() { Destroy(); }`,
  `  std::atomic<napi_threadsafe_function> updateTsfn{nullptr};\n  std::atomic<bool> updateCallbackEnabled{false};\n  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  std::mutex renderWorkerMutex;\n  std::condition_variable renderWorkerCv;\n  std::thread renderWorker;\n  std::atomic<bool> renderWorkerStarted{false};\n  std::atomic<bool> renderWorkerStop{false};\n  std::atomic<bool> renderWorkerWakePending{false};\n  std::atomic<uint32_t> renderWorkerCallbacksInFlight{0};\n  std::atomic<napi_threadsafe_function> frameReadyTsfn{nullptr};\n  uint32_t renderTargetWidth = 0;\n  uint32_t renderTargetHeight = 0;\n  std::deque<uint32_t> readySlots;\n  std::atomic<uint64_t> workerWakeSignals{0};\n  std::atomic<uint64_t> workerUpdateCalls{0};\n  std::atomic<uint64_t> workerRenderCalls{0};\n  std::atomic<uint64_t> workerRenderedFrames{0};\n  std::atomic<uint64_t> workerRenderUsTotal{0};\n  std::atomic<uint64_t> workerRenderUsMax{0};\n  std::atomic<uint64_t> workerDroppedReady{0};\n  std::atomic<uint64_t> workerBackpressure{0};\n  std::string workerLastError;\n\n  void StopRenderWorker();\n\n  ~Player() { Destroy(); }`,
  'player render worker state');

player = replaceOnce(player,
  `  void Destroy() {\n    updateCallbackEnabled.store(false, std::memory_order_release);`,
  `  void Destroy() {\n    StopRenderWorker();\n    updateCallbackEnabled.store(false, std::memory_order_release);`,
  'stop worker before render context destruction');

// Worker code lives after EnsureTexture/SampleTexture so it can allocate and render
// the same qualified shared textures. The worker is the sole production caller of
// mpv_render_context_update/render once started.
const drainAnchor = 'void DrainEvents(Player* player) {';
const drainIndex = player.indexOf(drainAnchor);
if (drainIndex < 0) throw new Error('worker helper insertion anchor missing');
const workerHelpers = `void AtomicMax(std::atomic<uint64_t>* target, uint64_t value) {\n  uint64_t current = target->load(std::memory_order_relaxed);\n  while (current < value && !target->compare_exchange_weak(current, value, std::memory_order_relaxed)) {}\n}\n\nvoid RenderWorkerWake(void* context) {\n  Player* player = static_cast<Player*>(context);\n  if (!player) return;\n  player->renderWorkerCallbacksInFlight.fetch_add(1, std::memory_order_acq_rel);\n  if (player->renderWorkerStarted.load(std::memory_order_acquire)) {\n    player->workerWakeSignals.fetch_add(1, std::memory_order_relaxed);\n    player->renderWorkerWakePending.store(true, std::memory_order_release);\n    player->renderWorkerCv.notify_one();\n  }\n  player->renderWorkerCallbacksInFlight.fetch_sub(1, std::memory_order_acq_rel);\n}\n\nvoid RenderWorkerLoop(Player* player) {\n  if (!player) return;\n  constexpr size_t kMaxReadyFrames = 4;\n  while (!player->renderWorkerStop.load(std::memory_order_acquire)) {\n    uint32_t width = 0, height = 0;\n    {\n      std::unique_lock<std::mutex> lock(player->renderWorkerMutex);\n      player->renderWorkerCv.wait_for(lock, std::chrono::milliseconds(2), [&] {\n        return player->renderWorkerStop.load(std::memory_order_acquire) ||\n               player->renderWorkerWakePending.load(std::memory_order_acquire);\n      });\n      if (player->renderWorkerStop.load(std::memory_order_acquire)) break;\n      width = player->renderTargetWidth;\n      height = player->renderTargetHeight;\n    }\n    player->renderWorkerWakePending.store(false, std::memory_order_release);\n    if (width < 2 || height < 2 || !player->render) continue;\n\n    const uint64_t flags = gMpv.render_context_update(player->render);\n    player->workerUpdateCalls.fetch_add(1, std::memory_order_relaxed);\n    if (!(flags & MPV_RENDER_UPDATE_FRAME)) continue;\n\n    TextureSlot* slot = nullptr;\n    uint32_t slotId = 0;\n    {\n      std::lock_guard<std::mutex> lock(player->renderWorkerMutex);\n      for (uint32_t i = 0; i < player->slots.size(); i += 1) {\n        if (!player->slots[i].inFlight) { slot = &player->slots[i]; slotId = i; break; }\n      }\n    }\n    if (!slot) {\n      player->workerBackpressure.fetch_add(1, std::memory_order_relaxed);\n      continue;\n    }\n\n    std::string error;\n    if (!EnsureTexture(player, slot, width, height, &error)) {\n      std::lock_guard<std::mutex> lock(player->renderWorkerMutex);\n      player->workerLastError = error;\n      continue;\n    }\n\n    mpv_d3d11_fbo fbo{};\n    fbo.tex = slot->texture.Get();\n    int blockForTargetTime = 0;\n    mpv_render_param params[] = {\n      {MPV_RENDER_PARAM_D3D11_FBO, &fbo},\n      {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},\n      {MPV_RENDER_PARAM_INVALID, nullptr}\n    };\n    const auto renderStarted = std::chrono::steady_clock::now();\n    const int rc = gMpv.render_context_render(player->render, params);\n    const auto renderEnded = std::chrono::steady_clock::now();\n    const uint64_t renderUs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(renderEnded - renderStarted).count());\n    player->workerRenderCalls.fetch_add(1, std::memory_order_relaxed);\n    player->workerRenderUsTotal.fetch_add(renderUs, std::memory_order_relaxed);\n    AtomicMax(&player->workerRenderUsMax, renderUs);\n    if (rc < 0) {\n      std::lock_guard<std::mutex> lock(player->renderWorkerMutex);\n      player->workerLastError = \"mpv_render_context_render(d3d11) failed: \" + MpvError(rc);\n      continue;\n    }\n\n    const double timestampUs = static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(renderEnded.time_since_epoch()).count());\n    {\n      std::lock_guard<std::mutex> lock(player->renderWorkerMutex);\n      while (player->readySlots.size() >= kMaxReadyFrames) {\n        const uint32_t staleId = player->readySlots.front();\n        player->readySlots.pop_front();\n        if (staleId < player->slots.size()) {\n          TextureSlot& stale = player->slots[staleId];\n          if (stale.readyForJs) {\n            stale.readyForJs = false;\n            stale.inFlight = false;\n            stale.frameId = 0;\n            stale.timestampUs = 0;\n            player->workerDroppedReady.fetch_add(1, std::memory_order_relaxed);\n          }\n        }\n      }\n      slot->inFlight = true;\n      slot->readyForJs = true;\n      slot->frameId = player->nextFrameId++;\n      slot->timestampUs = timestampUs;\n      player->readySlots.push_back(slotId);\n    }\n    player->workerRenderedFrames.fetch_add(1, std::memory_order_relaxed);\n    napi_threadsafe_function tsfn = player->frameReadyTsfn.load(std::memory_order_acquire);\n    if (tsfn) (void)napi_call_threadsafe_function(tsfn, nullptr, napi_tsfn_nonblocking);\n  }\n}\n\nvoid Player::StopRenderWorker() {\n  if (!renderWorkerStarted.exchange(false, std::memory_order_acq_rel)) return;\n  if (render && gMpv.render_context_set_update_callback) {\n    gMpv.render_context_set_update_callback(render, nullptr, nullptr);\n  }\n  while (renderWorkerCallbacksInFlight.load(std::memory_order_acquire) != 0) Sleep(0);\n  renderWorkerStop.store(true, std::memory_order_release);\n  renderWorkerCv.notify_all();\n  if (renderWorker.joinable()) renderWorker.join();\n  napi_threadsafe_function tsfn = frameReadyTsfn.exchange(nullptr, std::memory_order_acq_rel);\n  if (tsfn) napi_release_threadsafe_function(tsfn, napi_tsfn_abort);\n  std::lock_guard<std::mutex> lock(renderWorkerMutex);\n  readySlots.clear();\n  for (auto& slot : slots) {\n    if (slot.readyForJs) {\n      slot.readyForJs = false;\n      slot.inFlight = false;\n      slot.frameId = 0;\n      slot.timestampUs = 0;\n    }\n  }\n}\n\nvoid SetWorkerMetrics(napi_env env, napi_value out, Player* player) {\n  const uint64_t calls = player->workerRenderCalls.load(std::memory_order_relaxed);\n  const uint64_t totalUs = player->workerRenderUsTotal.load(std::memory_order_relaxed);\n  size_t ready = 0;\n  std::string workerError;\n  {\n    std::lock_guard<std::mutex> lock(player->renderWorkerMutex);\n    ready = player->readySlots.size();\n    workerError = player->workerLastError;\n  }\n  Set(env, out, \"renderWorkerStarted\", BoolValue(env, player->renderWorkerStarted.load(std::memory_order_acquire)));\n  Set(env, out, \"renderWorkerReadyFrames\", Uint32Value(env, static_cast<uint32_t>(ready)));\n  Set(env, out, \"renderWorkerWakeSignals\", DoubleValue(env, static_cast<double>(player->workerWakeSignals.load(std::memory_order_relaxed))));\n  Set(env, out, \"renderWorkerUpdateCalls\", DoubleValue(env, static_cast<double>(player->workerUpdateCalls.load(std::memory_order_relaxed))));\n  Set(env, out, \"renderWorkerRenderCalls\", DoubleValue(env, static_cast<double>(calls)));\n  Set(env, out, \"renderWorkerFrames\", DoubleValue(env, static_cast<double>(player->workerRenderedFrames.load(std::memory_order_relaxed))));\n  Set(env, out, \"renderWorkerAvgRenderMs\", DoubleValue(env, calls ? (static_cast<double>(totalUs) / static_cast<double>(calls)) / 1000.0 : 0));\n  Set(env, out, \"renderWorkerMaxRenderMs\", DoubleValue(env, static_cast<double>(player->workerRenderUsMax.load(std::memory_order_relaxed)) / 1000.0));\n  Set(env, out, \"renderWorkerDroppedReady\", DoubleValue(env, static_cast<double>(player->workerDroppedReady.load(std::memory_order_relaxed))));\n  Set(env, out, \"renderWorkerBackpressure\", DoubleValue(env, static_cast<double>(player->workerBackpressure.load(std::memory_order_relaxed))));\n  Set(env, out, \"renderWorkerLastError\", workerError.empty() ? NullValue(env) : StringValue(env, workerError));\n}\n\n`;
player = player.slice(0, drainIndex) + workerHelpers + player.slice(drainIndex);

player = replaceAllExpected(player,
  '  Set(env, out, "backpressureDrops", DoubleValue(env, static_cast<double>(player->droppedForBackpressure)));\n',
  '  Set(env, out, "backpressureDrops", DoubleValue(env, static_cast<double>(player->droppedForBackpressure)));\n  SetWorkerMetrics(env, out, player);\n',
  2,
  'worker metrics in playback/full polls');

player = replaceOnce(player,
  'napi_value SetUpdateCallback(napi_env env, napi_callback_info info) {',
  `napi_value StartRenderWorker(napi_env env, napi_callback_info info) {\n  size_t argc = 4;\n  napi_value argv[4];\n  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);\n  uint32_t id = 0, width = 0, height = 0;\n  napi_valuetype callbackType = napi_undefined;\n  if (argc < 4 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height) ||\n      napi_typeof(env, argv[3], &callbackType) != napi_ok || callbackType != napi_function) {\n    Throw(env, \"startRenderWorker(playerId, width, height, callback) requires id, size, function\");\n    return nullptr;\n  }\n  width = (std::max)(2u, (std::min)(width, 3840u));\n  height = (std::max)(2u, (std::min)(height, 2160u));\n\n  std::lock_guard<std::mutex> lock(gMutex);\n  Player* player = FindPlayer(id);\n  if (!player || !player->render) { Throw(env, \"unknown or uninitialized player id\"); return nullptr; }\n  if (player->updateTsfn.load(std::memory_order_acquire)) {\n    Throw(env, \"legacy update callback is already installed\");\n    return nullptr;\n  }\n  if (player->renderWorkerStarted.load(std::memory_order_acquire)) {\n    std::lock_guard<std::mutex> workerLock(player->renderWorkerMutex);\n    player->renderTargetWidth = width;\n    player->renderTargetHeight = height;\n    player->renderWorkerCv.notify_one();\n    return BoolValue(env, true);\n  }\n\n  napi_value resourceName;\n  napi_create_string_utf8(env, \"lilac-libmpv-frame-ready\", NAPI_AUTO_LENGTH, &resourceName);\n  napi_threadsafe_function tsfn = nullptr;\n  const napi_status status = napi_create_threadsafe_function(\n    env, argv[3], nullptr, resourceName, 1, 1, nullptr, nullptr, nullptr, CallUpdateJs, &tsfn);\n  if (status != napi_ok || !tsfn) { Throw(env, \"frame-ready TSFN creation failed\"); return nullptr; }\n\n  {\n    std::lock_guard<std::mutex> workerLock(player->renderWorkerMutex);\n    player->renderTargetWidth = width;\n    player->renderTargetHeight = height;\n    player->readySlots.clear();\n    player->workerLastError.clear();\n  }\n  player->frameReadyTsfn.store(tsfn, std::memory_order_release);\n  player->renderWorkerStop.store(false, std::memory_order_release);\n  player->renderWorkerWakePending.store(true, std::memory_order_release);\n  player->renderWorkerStarted.store(true, std::memory_order_release);\n  gMpv.render_context_set_update_callback(player->render, RenderWorkerWake, player);\n  try {\n    player->renderWorker = std::thread(RenderWorkerLoop, player);\n  } catch (...) {\n    player->renderWorkerStarted.store(false, std::memory_order_release);\n    gMpv.render_context_set_update_callback(player->render, nullptr, nullptr);\n    player->frameReadyTsfn.store(nullptr, std::memory_order_release);\n    napi_release_threadsafe_function(tsfn, napi_tsfn_abort);\n    Throw(env, \"failed to start native render worker\");\n    return nullptr;\n  }\n  player->renderWorkerCv.notify_one();\n  return BoolValue(env, true);\n}\n\nnapi_value TakeFrame(napi_env env, napi_callback_info info) {\n  size_t argc = 3;\n  napi_value argv[3];\n  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);\n  uint32_t id = 0, width = 0, height = 0;\n  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {\n    Throw(env, \"takeFrame(playerId, width, height) requires integers\");\n    return nullptr;\n  }\n  width = (std::max)(2u, (std::min)(width, 3840u));\n  height = (std::max)(2u, (std::min)(height, 2160u));\n\n  std::lock_guard<std::mutex> lock(gMutex);\n  Player* player = FindPlayer(id);\n  if (!player || !player->renderWorkerStarted.load(std::memory_order_acquire)) {\n    Throw(env, \"render worker is not started\");\n    return nullptr;\n  }\n\n  TextureSlot* slot = nullptr;\n  uint32_t slotId = 0;\n  uint64_t frameId = 0;\n  double timestampUs = 0;\n  bool targetChanged = false;\n  {\n    std::lock_guard<std::mutex> workerLock(player->renderWorkerMutex);\n    if (player->renderTargetWidth != width || player->renderTargetHeight != height) {\n      targetChanged = true;\n      player->renderTargetWidth = width;\n      player->renderTargetHeight = height;\n      while (!player->readySlots.empty()) {\n        const uint32_t staleId = player->readySlots.front();\n        player->readySlots.pop_front();\n        if (staleId < player->slots.size()) {\n          TextureSlot& stale = player->slots[staleId];\n          if (stale.readyForJs) { stale.readyForJs = false; stale.inFlight = false; stale.frameId = 0; stale.timestampUs = 0; }\n        }\n      }\n    }\n    while (!player->readySlots.empty()) {\n      slotId = player->readySlots.front();\n      player->readySlots.pop_front();\n      if (slotId >= player->slots.size()) continue;\n      TextureSlot& candidate = player->slots[slotId];\n      if (!candidate.readyForJs || !candidate.inFlight || !candidate.frameId) continue;\n      candidate.readyForJs = false;\n      slot = &candidate;\n      frameId = candidate.frameId;\n      timestampUs = candidate.timestampUs;\n      break;\n    }\n  }\n  if (targetChanged) {\n    player->renderWorkerWakePending.store(true, std::memory_order_release);\n    player->renderWorkerCv.notify_one();\n  }\n\n  napi_value out;\n  napi_create_object(env, &out);\n  if (!slot) { Set(env, out, \"updated\", BoolValue(env, false)); return out; }\n\n  player->renderedFrames += 1;\n  napi_value handleBuffer;\n  void* copied = nullptr;\n  napi_create_buffer_copy(env, sizeof(HANDLE), &slot->sharedHandle, &copied, &handleBuffer);\n  Set(env, out, \"updated\", BoolValue(env, true));\n  Set(env, out, \"backpressure\", BoolValue(env, false));\n  Set(env, out, \"slotId\", Uint32Value(env, slotId));\n  Set(env, out, \"frameId\", DoubleValue(env, static_cast<double>(frameId)));\n  Set(env, out, \"width\", Uint32Value(env, slot->width));\n  Set(env, out, \"height\", Uint32Value(env, slot->height));\n  Set(env, out, \"pixelFormat\", StringValue(env, \"bgra\"));\n  Set(env, out, \"ntHandle\", handleBuffer);\n  Set(env, out, \"timestampUs\", DoubleValue(env, timestampUs));\n  return out;\n}\n\nnapi_value SetUpdateCallback(napi_env env, napi_callback_info info) {`,
  'worker N-API methods');

// Legacy renderFrame remains for existing native regression tests, but is blocked
// while the production worker owns the render context.
player = replaceOnce(player,
  `  if (!player || !player->render) {\n    Throw(env, \"unknown or uninitialized player id\");\n    return nullptr;\n  }\n  const uint64_t flags = gMpv.render_context_update(player->render);`,
  `  if (!player || !player->render) {\n    Throw(env, \"unknown or uninitialized player id\");\n    return nullptr;\n  }\n  if (player->renderWorkerStarted.load(std::memory_order_acquire)) {\n    Throw(env, \"renderFrame unavailable while native render worker is active\");\n    return nullptr;\n  }\n  const uint64_t flags = gMpv.render_context_update(player->render);`,
  'prevent concurrent legacy render API use');

player = replaceOnce(player,
  `  TextureSlot& slot = player->slots[slotId];\n  const uint64_t frameId = static_cast<uint64_t>(frameIdNumber);\n  if (!slot.inFlight || slot.frameId != frameId) return BoolValue(env, false);\n  slot.inFlight = false;\n  return BoolValue(env, true);`,
  `  TextureSlot& slot = player->slots[slotId];\n  const uint64_t frameId = static_cast<uint64_t>(frameIdNumber);\n  {\n    std::lock_guard<std::mutex> workerLock(player->renderWorkerMutex);\n    if (!slot.inFlight || slot.frameId != frameId) return BoolValue(env, false);\n    slot.inFlight = false;\n    slot.readyForJs = false;\n    slot.frameId = 0;\n    slot.timestampUs = 0;\n  }\n  player->renderWorkerCv.notify_one();\n  return BoolValue(env, true);`,
  'worker-safe release');

player = replaceOnce(player,
  '    {"pollPlayback", nullptr, PollPlayback, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"setUpdateCallback", nullptr, SetUpdateCallback, nullptr, nullptr, nullptr, napi_default, nullptr},',
  '    {"pollPlayback", nullptr, PollPlayback, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"startRenderWorker", nullptr, StartRenderWorker, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"takeFrame", nullptr, TakeFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"setUpdateCallback", nullptr, SetUpdateCallback, nullptr, nullptr, nullptr, napi_default, nullptr},',
  'export worker APIs');

// Main process: the native worker owns render timing. JS only drains completed
// frames, so even a slow D3D render can no longer block Electron's main loop.
bridge = replaceOnce(bridge,
  "for (const name of ['createPlayer', 'open', 'command', 'poll', 'pollPlayback', 'setUpdateCallback', 'renderFrame', 'releaseFrame', 'destroyPlayer'])",
  "for (const name of ['createPlayer', 'open', 'command', 'poll', 'pollPlayback', 'startRenderWorker', 'takeFrame', 'renderFrame', 'releaseFrame', 'destroyPlayer'])",
  'require worker addon API');

bridge = replaceOnce(bridge,
  `  let nativeUpdateCallbackInstalled = false;\n  let nativeWakePending = false;`,
  `  let nativeUpdateCallbackInstalled = false;\n  let nativeRenderWorkerStarted = false;\n  let nativeWakePending = false;`,
  'main worker started state');

bridge = replaceOnce(bridge,
  `    nativeUpdateSignals: 0,\n    nativeUpdateWakeups: 0\n  };`,
  `    nativeUpdateSignals: 0,\n    nativeUpdateWakeups: 0,\n    workerReadySignals: 0,\n    workerReadyWakeups: 0\n  };`,
  'main worker ready metrics');

const oldWake = `  function wakePumpFromNative() {\n    metrics.nativeUpdateSignals += 1;\n    if (!active || disposed || !addon || playerId == null) return;\n    if (pumpTimer) {\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n      pumpTimerDuePerfAt = 0;\n    }\n    if (pumpRunning) {\n      nativeWakePending = true;\n      return;\n    }\n    nativeWakePending = false;\n    metrics.nativeUpdateWakeups += 1;\n    void pump();\n  }`;
const newWake = `  function wakePumpFromWorker() {\n    metrics.workerReadySignals += 1;\n    if (!active || disposed || !addon || playerId == null) return;\n    if (pumpTimer) {\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n      pumpTimerDuePerfAt = 0;\n    }\n    if (pumpRunning) {\n      nativeWakePending = true;\n      return;\n    }\n    nativeWakePending = false;\n    metrics.workerReadyWakeups += 1;\n    void pump();\n  }`;
bridge = replaceOnce(bridge, oldWake, newWake, 'replace mpv callback wake with completed-frame wake');

bridge = replaceOnce(bridge,
  `    addon.setUpdateCallback(playerId, wakePumpFromNative);\n    nativeUpdateCallbackInstalled = true;\n    return playerId;`,
  `    return playerId;`,
  'do not install JS render-update callback');

bridge = replaceOnce(bridge,
  `    addon.open(currentPlayerId, preparedUrl);\n    active = true;`,
  `    if (!nativeRenderWorkerStarted) {\n      addon.startRenderWorker(currentPlayerId, targetWidth, targetHeight, wakePumpFromWorker);\n      nativeRenderWorkerStarted = true;\n    }\n    addon.open(currentPlayerId, preparedUrl);\n    active = true;`,
  'start worker immediately before playback');

bridge = replaceOnce(bridge,
  `    let nextDelay = 4;`,
  `    let nextDelay = 16;`,
  'nonblocking completed-frame fallback interval');
bridge = replaceOnce(bridge,
  `      if (!nativeUpdateCallbackInstalled && !pumpExpectedFps) refreshPumpTimingState(ownerPlayerId);\n      if (pendingFrames.size >= MAX_PENDING_DELIVERY_FRAMES) {`,
  `      if (pendingFrames.size >= MAX_PENDING_DELIVERY_FRAMES) {`,
  'remove render timing poll from JS acquisition path');
bridge = replaceOnce(bridge,
  `        nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  `        nativeFrame = addon.takeFrame(ownerPlayerId, targetWidth, targetHeight);`,
  'nonblocking worker frame acquisition');
bridge = replaceOnce(bridge,
  `        nextDelay = nextActivePumpDelay();\n        return;`,
  `        nextDelay = 16;\n        return;`,
  'no completed frame fallback');
bridge = replaceOnce(bridge,
  `      lastNativeFramePerfAt = performance.now();\n      advanceNativeFrameDeadline(lastNativeFramePerfAt);\n      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);`,
  `      lastNativeFramePerfAt = performance.now();\n      advanceNativeFrameDeadline(lastNativeFramePerfAt);\n      nextDelay = 16;`,
  'worker controls native render timing');
bridge = replaceOnce(bridge,
  `        if (nativeUpdateCallbackInstalled && nativeWakePending) {\n          nativeWakePending = false;\n          metrics.nativeUpdateWakeups += 1;`,
  `        if (nativeRenderWorkerStarted && nativeWakePending) {\n          nativeWakePending = false;\n          metrics.workerReadyWakeups += 1;`,
  'drain ready signal latched during takeFrame pump');
bridge = replaceOnce(bridge,
  `          playerId = null;\n          nativeUpdateCallbackInstalled = false;`,
  `          playerId = null;\n          nativeUpdateCallbackInstalled = false;\n          nativeRenderWorkerStarted = false;`,
  'reset worker state after destroy');

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r3c.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r12') {
  throw new Error(`expected R3C identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r3d.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r13';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R3D-Setup.${ext}';

for (const marker of [
  'std::thread renderWorker', 'RenderWorkerLoop', 'StartRenderWorker', 'TakeFrame',
  'renderWorkerAvgRenderMs', 'renderFrame unavailable while native render worker is active'
]) if (!player.includes(marker)) throw new Error(`R3D native worker marker missing: ${marker}`);
for (const marker of [
  'nativeRenderWorkerStarted', 'wakePumpFromWorker',
  'addon.startRenderWorker(currentPlayerId, targetWidth, targetHeight, wakePumpFromWorker)',
  'addon.takeFrame(ownerPlayerId, targetWidth, targetHeight)', 'workerReadySignals'
]) if (!bridge.includes(marker)) throw new Error(`R3D bridge worker marker missing: ${marker}`);
if (bridge.includes('addon.setUpdateCallback(playerId, wakePumpFromNative)')) throw new Error('R3D legacy JS update callback wiring survived');
if (bridge.includes('nativeFrame = addon.renderFrame(ownerPlayerId')) throw new Error('R3D synchronous render remains in production pump');
if (bridge.includes('await sharedTexture.sendSharedTexture')) throw new Error('R3D regressed decoupled delivery');

write('native/libmpv-d3d11-bridge/player_addon.cc', player);
write('electron/libmpv-shared-main.cjs', bridge);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

console.log('LIBMPV_R3D_WORKER_OK renderThread=native-dedicated jsAcquire=takeFrame-nonblocking readyQueue=4 delivery=async');

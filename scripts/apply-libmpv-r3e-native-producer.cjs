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

if (!player.includes('nativeRenderMs') || !player.includes('mpv_render_context_set_update_callback') || !player.includes('kSharedTextureSlots = 24')) {
  throw new Error('R3E requires the complete R3D native baseline');
}
if (!bridge.includes('NO_FRAME_BACKOFF_MS = 6') || !bridge.includes('async function deliverImportedFrame')) {
  throw new Error('R3E requires the complete R3D bridge baseline');
}
if (player.includes('FrameProducerReadyFrame') || bridge.includes('frameProducerStarted')) {
  throw new Error('R3E native producer already applied');
}

// Windows headers define min/max macros unless explicitly disabled. The producer
// uses std::max for timing metrics.
player = replaceOnce(player,
  '#include <node_api.h>\n#include <windows.h>\n',
  '#include <node_api.h>\n#define NOMINMAX\n#include <windows.h>\n',
  'disable Windows min/max macros');
player = replaceOnce(player,
  '#include <array>\n#include <atomic>\n#include <chrono>\n',
  '#include <algorithm>\n#include <array>\n#include <atomic>\n#include <chrono>\n#include <condition_variable>\n#include <deque>\n',
  'producer STL includes 1');
player = replaceOnce(player,
  '#include <string>\n#include <unordered_map>\n',
  '#include <string>\n#include <thread>\n#include <unordered_map>\n',
  'producer STL includes 2');

player = replaceOnce(player,
  'struct Player {\n',
  `struct FrameProducerReadyFrame {\n  uint32_t slotId = 0;\n  uint64_t frameId = 0;\n  uint32_t width = 0;\n  uint32_t height = 0;\n  double timestampUs = 0.0;\n  double updateMs = 0.0;\n  double textureMs = 0.0;\n  double renderMs = 0.0;\n};\n\nstruct Player {\n`,
  'producer frame metadata');

player = replaceOnce(player,
  `  std::atomic<napi_threadsafe_function> updateTsfn{nullptr};\n  std::atomic<bool> updateCallbackEnabled{false};\n  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  ~Player() { Destroy(); }`,
  `  std::atomic<napi_threadsafe_function> updateTsfn{nullptr};\n  std::atomic<bool> updateCallbackEnabled{false};\n  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  // R3E production frame producer. mpv's raw render callback wakes this native\n  // worker directly, so JS event-loop stalls cannot stop render-context service.\n  std::mutex producerMutex;\n  std::condition_variable producerCv;\n  std::thread producerThread;\n  std::atomic<bool> producerEnabled{false};\n  std::atomic<bool> producerWakePending{false};\n  std::atomic<bool> producerStop{false};\n  uint32_t producerWidth = 0;\n  uint32_t producerHeight = 0;\n  std::deque<FrameProducerReadyFrame> producerReady;\n  std::atomic<uint64_t> producerRawWakeSignals{0};\n  std::atomic<uint64_t> producerJsSignals{0};\n  uint64_t producerWakeups = 0;\n  uint64_t producerRenderCalls = 0;\n  uint64_t producerProducedFrames = 0;\n  uint64_t producerNoFramePolls = 0;\n  uint64_t producerBackpressure = 0;\n  uint64_t producerQueueMax = 0;\n  double producerUpdateTotalMs = 0.0;\n  double producerUpdateMaxMs = 0.0;\n  double producerTextureTotalMs = 0.0;\n  double producerTextureMaxMs = 0.0;\n  double producerRenderTotalMs = 0.0;\n  double producerRenderMaxMs = 0.0;\n\n  void StopFrameProducerWorker() {\n    producerEnabled.store(false, std::memory_order_release);\n    // Publish stop before any producer mutex acquisition. A slow D3D11 render\n    // may be in flight, and stop must become visible before the next drain turn.\n    producerStop.store(true, std::memory_order_release);\n    producerCv.notify_all();\n    if (producerThread.joinable()) producerThread.join();\n    producerWakePending.store(false, std::memory_order_release);\n\n    // Frames still in producerReady were never handed to Electron. Release only\n    // those reservations; popped/imported frames stay in-flight until the normal\n    // allReferencesReleased callback returns ownership.\n    std::lock_guard<std::mutex> lock(producerMutex);\n    for (const auto& ready : producerReady) {\n      if (ready.slotId >= slots.size()) continue;\n      TextureSlot& slot = slots[ready.slotId];\n      if (slot.inFlight && slot.frameId == ready.frameId) slot.inFlight = false;\n    }\n    producerReady.clear();\n  }\n\n  ~Player() { Destroy(); }`,
  'producer player state');

player = replaceOnce(player,
  `    while (updateCallbacksInFlight.load(std::memory_order_acquire) != 0) Sleep(0);\n    napi_threadsafe_function tsfn = updateTsfn.exchange(nullptr, std::memory_order_acq_rel);`,
  `    while (updateCallbacksInFlight.load(std::memory_order_acquire) != 0) Sleep(0);\n    StopFrameProducerWorker();\n    napi_threadsafe_function tsfn = updateTsfn.exchange(nullptr, std::memory_order_acq_rel);`,
  'stop producer before releasing update TSFN');

// Raw mpv callbacks go straight to the producer while it is enabled. The JS TSFN
// is intentionally delayed until the worker has actually queued a rendered frame.
player = replaceOnce(player,
  `  player->updateCallbacksInFlight.fetch_add(1, std::memory_order_acq_rel);\n  if (player->updateCallbackEnabled.load(std::memory_order_acquire)) {\n    napi_threadsafe_function tsfn = player->updateTsfn.load(std::memory_order_acquire);\n    if (tsfn) {\n      const napi_status status = napi_call_threadsafe_function(tsfn, nullptr, napi_tsfn_nonblocking);\n      (void)status; // Queue-full/closing is intentionally coalesced; the fallback pump remains armed.\n    }\n  }\n  player->updateCallbacksInFlight.fetch_sub(1, std::memory_order_acq_rel);`,
  `  player->updateCallbacksInFlight.fetch_add(1, std::memory_order_acq_rel);\n  const bool producerOwnsWake = player->producerEnabled.load(std::memory_order_acquire);\n  if (producerOwnsWake) {\n    player->producerRawWakeSignals.fetch_add(1, std::memory_order_relaxed);\n    player->producerWakePending.store(true, std::memory_order_release);\n    player->producerCv.notify_one();\n  }\n  if (!producerOwnsWake && player->updateCallbackEnabled.load(std::memory_order_acquire)) {\n    napi_threadsafe_function tsfn = player->updateTsfn.load(std::memory_order_acquire);\n    if (tsfn) {\n      const napi_status status = napi_call_threadsafe_function(tsfn, nullptr, napi_tsfn_nonblocking);\n      (void)status; // Queue-full/closing is intentionally coalesced; JS keeps a fallback drain timer.\n    }\n  }\n  player->updateCallbacksInFlight.fetch_sub(1, std::memory_order_acq_rel);`,
  'raw callback routes to native producer');

const workerHelper = String.raw`
bool StartFrameProducerWorker(Player* player, uint32_t width, uint32_t height) {
  if (!player || !player->render || width < 2 || height < 2) return false;
  if (player->producerThread.joinable()) return true;
  {
    std::lock_guard<std::mutex> lock(player->producerMutex);
    player->producerWidth = width;
    player->producerHeight = height;
    player->producerReady.clear();
    player->producerWakeups = 0;
    player->producerRenderCalls = 0;
    player->producerProducedFrames = 0;
    player->producerNoFramePolls = 0;
    player->producerBackpressure = 0;
    player->producerQueueMax = 0;
    player->producerUpdateTotalMs = 0.0;
    player->producerUpdateMaxMs = 0.0;
    player->producerTextureTotalMs = 0.0;
    player->producerTextureMaxMs = 0.0;
    player->producerRenderTotalMs = 0.0;
    player->producerRenderMaxMs = 0.0;
  }
  player->producerRawWakeSignals.store(0, std::memory_order_release);
  player->producerJsSignals.store(0, std::memory_order_release);
  player->producerStop.store(false, std::memory_order_release);
  player->producerWakePending.store(true, std::memory_order_release);
  player->producerEnabled.store(true, std::memory_order_release);

  player->producerThread = std::thread([player]() {
    for (;;) {
      {
        std::unique_lock<std::mutex> lock(player->producerMutex);
        player->producerCv.wait_for(lock, std::chrono::milliseconds(6), [player]() {
          return player->producerStop.load(std::memory_order_acquire) ||
            player->producerWakePending.load(std::memory_order_acquire);
        });
        if (player->producerStop.load(std::memory_order_acquire)) break;
        player->producerWakePending.store(false, std::memory_order_release);
        player->producerWakeups += 1;
      }

      // One wake may represent several coalesced mpv updates. Drain a bounded
      // burst while preserving a stop check before every render turn.
      for (uint32_t drain = 0; drain < 8; drain += 1) {
        if (player->producerStop.load(std::memory_order_acquire)) break;

        const auto updateStarted = std::chrono::steady_clock::now();
        const uint64_t flags = gMpv.render_context_update(player->render);
        const double updateMs = std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - updateStarted).count();
        {
          std::lock_guard<std::mutex> lock(player->producerMutex);
          player->producerUpdateTotalMs += updateMs;
          player->producerUpdateMaxMs = std::max(player->producerUpdateMaxMs, updateMs);
          if (!(flags & MPV_RENDER_UPDATE_FRAME)) player->producerNoFramePolls += 1;
        }
        if (!(flags & MPV_RENDER_UPDATE_FRAME)) break;

        TextureSlot* slot = nullptr;
        uint32_t slotId = 0;
        uint64_t reservedFrameId = 0;
        uint32_t renderWidth = 0;
        uint32_t renderHeight = 0;
        double textureMs = 0.0;
        {
          // Reserve the slot under producerMutex, then release the mutex before
          // the potentially slow libmpv/D3D11 render. JS dequeue/release/stats
          // remain independent even if render_context_render stalls.
          std::lock_guard<std::mutex> lock(player->producerMutex);
          for (uint32_t i = 0; i < player->slots.size(); i += 1) {
            if (!player->slots[i].inFlight) {
              slot = &player->slots[i];
              slotId = i;
              break;
            }
          }
          if (!slot) {
            player->producerBackpressure += 1;
            break;
          }
          renderWidth = player->producerWidth;
          renderHeight = player->producerHeight;
          std::string error;
          const auto textureStarted = std::chrono::steady_clock::now();
          const bool textureReady = EnsureTexture(player, slot, renderWidth, renderHeight, &error);
          textureMs = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - textureStarted).count();
          player->producerTextureTotalMs += textureMs;
          player->producerTextureMaxMs = std::max(player->producerTextureMaxMs, textureMs);
          if (!textureReady) {
            player->lastError = error;
            break;
          }
          reservedFrameId = player->nextFrameId++;
          slot->inFlight = true;
          slot->frameId = reservedFrameId;
        }

        mpv_d3d11_fbo fbo{};
        fbo.tex = slot->texture.Get();
        int blockForTargetTime = 0;
        mpv_render_param params[] = {
          {MPV_RENDER_PARAM_D3D11_FBO, &fbo},
          {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},
          {MPV_RENDER_PARAM_INVALID, nullptr}
        };
        const auto renderStarted = std::chrono::steady_clock::now();
        const int rc = gMpv.render_context_render(player->render, params);
        const double renderMs = std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - renderStarted).count();

        bool queuedFrame = false;
        {
          std::lock_guard<std::mutex> lock(player->producerMutex);
          player->producerRenderCalls += 1;
          player->producerRenderTotalMs += renderMs;
          player->producerRenderMaxMs = std::max(player->producerRenderMaxMs, renderMs);
          if (rc < 0 || player->producerStop.load(std::memory_order_acquire)) {
            if (slot->inFlight && slot->frameId == reservedFrameId) slot->inFlight = false;
            if (rc < 0) player->lastError = MpvError(rc);
          } else {
            player->renderedFrames += 1;
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
          }
        }
        if (rc < 0 || player->producerStop.load(std::memory_order_acquire)) break;

        if (queuedFrame && player->updateCallbackEnabled.load(std::memory_order_acquire)) {
          napi_threadsafe_function tsfn = player->updateTsfn.load(std::memory_order_acquire);
          if (tsfn) {
            const napi_status status = napi_call_threadsafe_function(tsfn, nullptr, napi_tsfn_nonblocking);
            if (status == napi_ok) player->producerJsSignals.fetch_add(1, std::memory_order_relaxed);
          }
        }
      }
    }
  });
  player->producerCv.notify_one();
  return true;
}

`;
player = replaceOnce(player,
  'bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {',
  workerHelper + 'bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {',
  'frame producer worker');

const producerApi = String.raw`
napi_value StartFrameProducer(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {
    Throw(env, "startFrameProducer expects playerId, width, height");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || !player->render) return BoolValue(env, false);
  if (!player->updateTsfn.load(std::memory_order_acquire)) {
    Throw(env, "startFrameProducer requires setUpdateCallback first");
    return nullptr;
  }
  return BoolValue(env, StartFrameProducerWorker(player, width, height));
}

napi_value StopFrameProducer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return BoolValue(env, false);
  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return BoolValue(env, false);
  player->StopFrameProducerWorker();
  return BoolValue(env, true);
}

napi_value ResizeFrameProducer(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {
    return BoolValue(env, false);
  }
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || width < 2 || height < 2) return BoolValue(env, false);
  {
    std::lock_guard<std::mutex> lock(player->producerMutex);
    player->producerWidth = width;
    player->producerHeight = height;
  }
  player->producerWakePending.store(true, std::memory_order_release);
  player->producerCv.notify_one();
  return BoolValue(env, true);
}

napi_value PopProducedFrame(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return NullValue(env);
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return NullValue(env);
  std::lock_guard<std::mutex> lock(player->producerMutex);
  if (player->producerReady.empty()) return NullValue(env);
  const FrameProducerReadyFrame ready = player->producerReady.front();
  player->producerReady.pop_front();
  if (ready.slotId >= player->slots.size()) return NullValue(env);
  TextureSlot& slot = player->slots[ready.slotId];
  if (!slot.inFlight || slot.frameId != ready.frameId || !slot.sharedHandle) return NullValue(env);

  napi_value out;
  napi_create_object(env, &out);
  void* copied = nullptr;
  napi_value handleBuffer;
  napi_create_buffer_copy(env, sizeof(HANDLE), &slot.sharedHandle, &copied, &handleBuffer);
  Set(env, out, "updated", BoolValue(env, true));
  Set(env, out, "backpressure", BoolValue(env, false));
  Set(env, out, "slotId", Uint32Value(env, ready.slotId));
  Set(env, out, "frameId", DoubleValue(env, static_cast<double>(ready.frameId)));
  Set(env, out, "width", Uint32Value(env, ready.width));
  Set(env, out, "height", Uint32Value(env, ready.height));
  Set(env, out, "pixelFormat", StringValue(env, "bgra"));
  Set(env, out, "timestampUs", DoubleValue(env, ready.timestampUs));
  Set(env, out, "nativeUpdateMs", DoubleValue(env, ready.updateMs));
  Set(env, out, "nativeEnsureTextureMs", DoubleValue(env, ready.textureMs));
  Set(env, out, "nativeRenderMs", DoubleValue(env, ready.renderMs));
  Set(env, out, "ntHandle", handleBuffer);
  return out;
}

napi_value ReleaseProducedFrame(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, slotId = 0;
  double frameIdNumber = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &slotId) ||
      napi_get_value_double(env, argv[2], &frameIdNumber) != napi_ok) return BoolValue(env, false);
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || slotId >= player->slots.size()) return BoolValue(env, false);
  {
    std::lock_guard<std::mutex> lock(player->producerMutex);
    TextureSlot& slot = player->slots[slotId];
    const uint64_t frameId = static_cast<uint64_t>(frameIdNumber);
    if (!slot.inFlight || slot.frameId != frameId) return BoolValue(env, false);
    slot.inFlight = false;
  }
  player->producerWakePending.store(true, std::memory_order_release);
  player->producerCv.notify_one();
  return BoolValue(env, true);
}

napi_value FrameProducerStats(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return NullValue(env);
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return NullValue(env);
  std::lock_guard<std::mutex> lock(player->producerMutex);
  napi_value out;
  napi_create_object(env, &out);
  const double updateAvg = player->producerWakeups > 0 ? player->producerUpdateTotalMs / static_cast<double>(player->producerWakeups) : 0.0;
  const double textureAvg = player->producerProducedFrames > 0 ? player->producerTextureTotalMs / static_cast<double>(player->producerProducedFrames) : 0.0;
  const double renderAvg = player->producerRenderCalls > 0 ? player->producerRenderTotalMs / static_cast<double>(player->producerRenderCalls) : 0.0;
  Set(env, out, "enabled", BoolValue(env, player->producerEnabled.load(std::memory_order_acquire)));
  Set(env, out, "rawWakeSignals", DoubleValue(env, static_cast<double>(player->producerRawWakeSignals.load(std::memory_order_acquire))));
  Set(env, out, "jsSignals", DoubleValue(env, static_cast<double>(player->producerJsSignals.load(std::memory_order_acquire))));
  Set(env, out, "workerWakeups", DoubleValue(env, static_cast<double>(player->producerWakeups)));
  Set(env, out, "renderCalls", DoubleValue(env, static_cast<double>(player->producerRenderCalls)));
  Set(env, out, "producedFrames", DoubleValue(env, static_cast<double>(player->producerProducedFrames)));
  Set(env, out, "noFramePolls", DoubleValue(env, static_cast<double>(player->producerNoFramePolls)));
  Set(env, out, "backpressure", DoubleValue(env, static_cast<double>(player->producerBackpressure)));
  Set(env, out, "readyFrames", DoubleValue(env, static_cast<double>(player->producerReady.size())));
  Set(env, out, "queueMax", DoubleValue(env, static_cast<double>(player->producerQueueMax)));
  Set(env, out, "avgUpdateMs", DoubleValue(env, updateAvg));
  Set(env, out, "maxUpdateMs", DoubleValue(env, player->producerUpdateMaxMs));
  Set(env, out, "avgTextureMs", DoubleValue(env, textureAvg));
  Set(env, out, "maxTextureMs", DoubleValue(env, player->producerTextureMaxMs));
  Set(env, out, "avgRenderMs", DoubleValue(env, renderAvg));
  Set(env, out, "maxRenderMs", DoubleValue(env, player->producerRenderMaxMs));
  return out;
}

`;
player = replaceOnce(player,
  'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {',
  producerApi + 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {',
  'producer N-API functions');

player = replaceOnce(player,
  '    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n',
  '    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"startFrameProducer", nullptr, StartFrameProducer, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"stopFrameProducer", nullptr, StopFrameProducer, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"resizeFrameProducer", nullptr, ResizeFrameProducer, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"popProducedFrame", nullptr, PopProducedFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"releaseProducedFrame", nullptr, ReleaseProducedFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"frameProducerStats", nullptr, FrameProducerStats, nullptr, nullptr, nullptr, napi_default, nullptr},\n',
  'producer N-API exports');

// Protect full diagnostics from observing the slot table while the producer is
// reserving/releasing a slot. The worker never holds producerMutex during render.
player = replaceOnce(player,
  `  uint32_t inFlightSlots = 0;\n  for (const auto& slot : player->slots) if (slot.inFlight) inFlightSlots += 1;\n  Set(env, out, "textureSlotCount", Uint32Value(env, static_cast<uint32_t>(player->slots.size())));\n  Set(env, out, "textureSlotsInFlight", Uint32Value(env, inFlightSlots));`,
  `  uint32_t inFlightSlots = 0;\n  {\n    std::lock_guard<std::mutex> producerLock(player->producerMutex);\n    for (const auto& slot : player->slots) if (slot.inFlight) inFlightSlots += 1;\n  }\n  Set(env, out, "textureSlotCount", Uint32Value(env, static_cast<uint32_t>(player->slots.size())));\n  Set(env, out, "textureSlotsInFlight", Uint32Value(env, inFlightSlots));`,
  'producer-safe slot diagnostics');

// --- Main-process bridge: render discovery becomes queue draining. ---
bridge = replaceOnce(bridge,
  "for (const name of ['createPlayer', 'open', 'command', 'poll', 'pollPlayback', 'setUpdateCallback', 'renderFrame', 'releaseFrame', 'destroyPlayer'])",
  "for (const name of ['createPlayer', 'open', 'command', 'poll', 'pollPlayback', 'setUpdateCallback', 'renderFrame', 'releaseFrame', 'startFrameProducer', 'stopFrameProducer', 'resizeFrameProducer', 'popProducedFrame', 'releaseProducedFrame', 'frameProducerStats', 'destroyPlayer'])",
  'require frame producer exports');

bridge = replaceOnce(bridge,
  `  let nativeUpdateCallbackInstalled = false;\n  let nativeWakePending = false;\n  let noFrameBurstCount = 0;`,
  `  let nativeUpdateCallbackInstalled = false;\n  let nativeWakePending = false;\n  let frameProducerStarted = false;\n  let noFrameBurstCount = 0;`,
  'bridge producer state');

bridge = replaceOnce(bridge,
  `    if (!pendingFrames.has(key)) return;\n    pendingFrames.delete(key);`,
  `    if (!pendingFrames.has(key)) return;\n    const pending = pendingFrames.get(key);\n    pendingFrames.delete(key);`,
  'retain pending ownership kind');
bridge = replaceOnce(bridge,
  `    try { addon?.releaseFrame(ownerPlayerId, slotId, frameId); } catch {}`,
  `    try {\n      if (pending?.producer && typeof addon?.releaseProducedFrame === 'function') {\n        addon.releaseProducedFrame(ownerPlayerId, slotId, frameId);\n      } else {\n        addon?.releaseFrame(ownerPlayerId, slotId, frameId);\n      }\n    } catch {}`,
  'release producer-owned slot safely');

bridge = replaceOnce(bridge,
  `        nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  `        nativeFrame = frameProducerStarted\n          ? addon.popProducedFrame(ownerPlayerId)\n          : addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  'drain native producer instead of rendering on JS thread');

bridge = replaceOnce(bridge,
  `      if (!nativeFrame?.updated) {\n        metrics.noFramePolls += 1;\n        nextDelay = nextActivePumpDelay(performance.now(), true);\n        return;\n      }`,
  `      if (!nativeFrame?.updated) {\n        metrics.noFramePolls += 1;\n        nextDelay = frameProducerStarted ? NO_FRAME_BACKOFF_MS : nextActivePumpDelay(performance.now(), true);\n        return;\n      }`,
  'producer queue empty fallback');

bridge = replaceOnce(bridge,
  `      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);\n      const frameNow = Date.now();`,
  `      nextDelay = frameProducerStarted ? 0 : nextActivePumpDelay(lastNativeFramePerfAt);\n      const frameNow = Date.now();`,
  'immediately drain producer backlog');

bridge = replaceOnce(bridge,
  `      nativeCadence = nativeCadenceTracker.add({\n        atMs: performance.now(),\n        frameId: Number(nativeFrame.frameId) || 0,`,
  `      const producerTimestampMs = Number(nativeFrame.timestampUs) > 0\n        ? Number(nativeFrame.timestampUs) / 1000\n        : performance.now();\n      nativeCadence = nativeCadenceTracker.add({\n        atMs: producerTimestampMs,\n        frameId: Number(nativeFrame.frameId) || 0,`,
  'measure native cadence at producer completion time');

bridge = replaceOnce(bridge,
  `      pendingFrames.set(key, { playerId: ownerPlayerId, slotId, frameId, at: Date.now() });`,
  `      pendingFrames.set(key, {\n        playerId: ownerPlayerId, slotId, frameId, at: Date.now(), producer: frameProducerStarted\n      });`,
  'track producer ownership for release');

bridge = replaceOnce(bridge,
  `    addon.open(currentPlayerId, preparedUrl);\n    active = true;\n    schedulePump(0);`,
  `    addon.open(currentPlayerId, preparedUrl);\n    frameProducerStarted = false;\n    try {\n      frameProducerStarted = addon.startFrameProducer(currentPlayerId, targetWidth, targetHeight) === true;\n    } catch (error) {\n      lastError = \`native frame producer start failed; using legacy JS render path: \${String(error?.message || error).slice(0, 160)}\`;\n      frameProducerStarted = false;\n    }\n    active = true;\n    schedulePump(0);`,
  'start native producer for each source');

bridge = replaceOnce(bridge,
  `  function resize(value = {}) {\n    const size = setTargetSize(value);\n    return { ok: true, ...size };\n  }`,
  `  function resize(value = {}) {\n    const size = setTargetSize(value);\n    if (frameProducerStarted && playerId != null && addon) {\n      try { addon.resizeFrameProducer(playerId, size.width, size.height); } catch {}\n    }\n    return { ok: true, ...size };\n  }`,
  'resize native producer');

bridge = replaceOnce(bridge,
  `  async function stopPlayer({ destroy = false } = {}) {\n    active = false;`,
  `  async function stopPlayer({ destroy = false } = {}) {\n    if (frameProducerStarted && playerId != null && addon) {\n      try { addon.stopFrameProducer(playerId); } catch {}\n    }\n    frameProducerStarted = false;\n    active = false;`,
  'stop native producer before mpv stop');

bridge = replaceOnce(bridge,
  `      target: { width: targetWidth, height: targetHeight },\n      pendingFrames: pendingFrames.size,`,
  `      target: { width: targetWidth, height: targetHeight },\n      frameProducerMode: frameProducerStarted ? 'native-callback-worker' : 'legacy-js-render',\n      frameProducer: frameProducerStarted ? addon.frameProducerStats(playerId) : null,\n      pendingFrames: pendingFrames.size,`,
  'expose frame producer diagnostics');

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r3d.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r13') {
  throw new Error(`expected R3D identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r3e.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r14';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R3E-Setup.${ext}';

for (const marker of [
  'FrameProducerReadyFrame', 'StartFrameProducerWorker', 'producerRawWakeSignals',
  'producerJsSignals', 'producerCv.notify_one()', 'startFrameProducer',
  'resizeFrameProducer', 'popProducedFrame', 'releaseProducedFrame', 'frameProducerStats',
  'before the potentially slow libmpv/D3D11 render'
]) if (!player.includes(marker)) throw new Error(`R3E native producer marker missing: ${marker}`);
if (player.includes('MPV_RENDER_PARAM_ADVANCED_CONTROL')) throw new Error('R3E must not enable advanced-control');

for (const marker of [
  'frameProducerStarted', "frameProducerMode: frameProducerStarted ? 'native-callback-worker'",
  'addon.startFrameProducer', 'addon.popProducedFrame', 'addon.releaseProducedFrame',
  'addon.resizeFrameProducer', 'addon.stopFrameProducer', 'producerTimestampMs',
  'producer: frameProducerStarted'
]) if (!bridge.includes(marker)) throw new Error(`R3E bridge producer marker missing: ${marker}`);
if (bridge.includes('await sharedTexture.sendSharedTexture')) throw new Error('R3E regressed asynchronous transport');
if (!bridge.includes("presentation") && false) throw new Error('unreachable placeholder');

write('native/libmpv-d3d11-bridge/player_addon.cc', player);
write('electron/libmpv-shared-main.cjs', bridge);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

console.log('LIBMPV_R3E_OK producer=native-callback-worker slots=24 renderMutex=unlocked js=drain-only fallback=legacy advancedControl=off');

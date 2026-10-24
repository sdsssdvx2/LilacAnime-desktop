'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let s = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = s.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  s = s.replace(needle, replacement);
}

if (!s.includes('nativeRenderMs') || !s.includes('mpv_render_context_set_update_callback') || !s.includes('kSharedTextureSlots = 24')) {
  throw new Error('autonomous producer probe requires complete generated R3D source');
}
if (s.includes('StartAutonomousProbe')) throw new Error('autonomous producer probe already applied');

replaceOnce('#include <chrono>\n', '#include <chrono>\n#include <condition_variable>\n#include <deque>\n', 'autonomous includes 1');
replaceOnce('#include <mutex>\n', '#include <mutex>\n#include <thread>\n', 'autonomous includes 2');

replaceOnce(
  'struct Player {\n',
  `struct AutonomousReadyFrame {\n  uint32_t slotId = 0;\n  uint64_t frameId = 0;\n  uint32_t width = 0;\n  uint32_t height = 0;\n  double timestampUs = 0.0;\n  double updateMs = 0.0;\n  double textureMs = 0.0;\n  double renderMs = 0.0;\n};\n\nstruct Player {\n`,
  'autonomous frame metadata');

replaceOnce(
  '  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  ~Player() { Destroy(); }',
  `  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  // Test-only native producer. The raw mpv render callback can wake this worker\n  // without waiting for N-API/JS. It intentionally calls only render API work.\n  std::mutex autonomousMutex;\n  std::condition_variable autonomousCv;\n  std::thread autonomousThread;\n  std::atomic<bool> autonomousEnabled{false};\n  std::atomic<bool> autonomousWakePending{false};\n  bool autonomousStop = false;\n  uint32_t autonomousWidth = 0;\n  uint32_t autonomousHeight = 0;\n  std::deque<AutonomousReadyFrame> autonomousReady;\n  std::atomic<uint64_t> autonomousRawWakeSignals{0};\n  uint64_t autonomousWakeups = 0;\n  uint64_t autonomousRenderCalls = 0;\n  uint64_t autonomousProducedFrames = 0;\n  uint64_t autonomousNoFramePolls = 0;\n  uint64_t autonomousBackpressure = 0;\n  double autonomousUpdateTotalMs = 0.0;\n  double autonomousUpdateMaxMs = 0.0;\n  double autonomousTextureTotalMs = 0.0;\n  double autonomousTextureMaxMs = 0.0;\n  double autonomousRenderTotalMs = 0.0;\n  double autonomousRenderMaxMs = 0.0;\n\n  void StopAutonomousProbeWorker() {\n    autonomousEnabled.store(false, std::memory_order_release);\n    {\n      std::lock_guard<std::mutex> lock(autonomousMutex);\n      autonomousStop = true;\n    }\n    autonomousCv.notify_all();\n    if (autonomousThread.joinable()) autonomousThread.join();\n    autonomousWakePending.store(false, std::memory_order_release);\n  }\n\n  ~Player() { Destroy(); }`,
  'autonomous player state');

replaceOnce(
  `    while (updateCallbacksInFlight.load(std::memory_order_acquire) != 0) Sleep(0);\n    napi_threadsafe_function tsfn = updateTsfn.exchange(nullptr, std::memory_order_acq_rel);`,
  `    while (updateCallbacksInFlight.load(std::memory_order_acquire) != 0) Sleep(0);\n    StopAutonomousProbeWorker();\n    napi_threadsafe_function tsfn = updateTsfn.exchange(nullptr, std::memory_order_acq_rel);`,
  'autonomous teardown before render free');

replaceOnce(
  `  player->updateCallbacksInFlight.fetch_add(1, std::memory_order_acq_rel);\n  if (player->updateCallbackEnabled.load(std::memory_order_acquire)) {`,
  `  player->updateCallbacksInFlight.fetch_add(1, std::memory_order_acq_rel);\n  if (player->autonomousEnabled.load(std::memory_order_acquire)) {\n    player->autonomousRawWakeSignals.fetch_add(1, std::memory_order_relaxed);\n    player->autonomousWakePending.store(true, std::memory_order_release);\n    player->autonomousCv.notify_one();\n  }\n  if (player->updateCallbackEnabled.load(std::memory_order_acquire)) {`,
  'raw callback wakes native worker before JS TSFN');

const workerHelper = String.raw`
bool StartAutonomousProbeWorker(Player* player, uint32_t width, uint32_t height) {
  if (!player || !player->render || width < 2 || height < 2) return false;
  if (player->autonomousThread.joinable()) return true;
  {
    std::lock_guard<std::mutex> lock(player->autonomousMutex);
    player->autonomousStop = false;
    player->autonomousWidth = width;
    player->autonomousHeight = height;
    player->autonomousReady.clear();
    player->autonomousWakeups = 0;
    player->autonomousRenderCalls = 0;
    player->autonomousProducedFrames = 0;
    player->autonomousNoFramePolls = 0;
    player->autonomousBackpressure = 0;
    player->autonomousUpdateTotalMs = 0.0;
    player->autonomousUpdateMaxMs = 0.0;
    player->autonomousTextureTotalMs = 0.0;
    player->autonomousTextureMaxMs = 0.0;
    player->autonomousRenderTotalMs = 0.0;
    player->autonomousRenderMaxMs = 0.0;
  }
  player->autonomousRawWakeSignals.store(0, std::memory_order_release);
  player->autonomousWakePending.store(true, std::memory_order_release);
  player->autonomousEnabled.store(true, std::memory_order_release);
  player->autonomousThread = std::thread([player]() {
    for (;;) {
      {
        std::unique_lock<std::mutex> lock(player->autonomousMutex);
        player->autonomousCv.wait_for(lock, std::chrono::milliseconds(6), [player]() {
          return player->autonomousStop || player->autonomousWakePending.load(std::memory_order_acquire);
        });
        if (player->autonomousStop) break;
        player->autonomousWakePending.store(false, std::memory_order_release);
        player->autonomousWakeups += 1;
      }

      // Drain all currently announced render updates before sleeping again.
      for (uint32_t drain = 0; drain < 8; drain += 1) {
        const auto updateStarted = std::chrono::steady_clock::now();
        const uint64_t flags = gMpv.render_context_update(player->render);
        const double updateMs = std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - updateStarted).count();
        {
          std::lock_guard<std::mutex> lock(player->autonomousMutex);
          player->autonomousUpdateTotalMs += updateMs;
          player->autonomousUpdateMaxMs = std::max(player->autonomousUpdateMaxMs, updateMs);
        }
        if (!(flags & MPV_RENDER_UPDATE_FRAME)) {
          std::lock_guard<std::mutex> lock(player->autonomousMutex);
          player->autonomousNoFramePolls += 1;
          break;
        }

        std::lock_guard<std::mutex> lock(player->autonomousMutex);
        TextureSlot* slot = nullptr;
        uint32_t slotId = 0;
        for (uint32_t i = 0; i < player->slots.size(); i += 1) {
          if (!player->slots[i].inFlight) {
            slot = &player->slots[i];
            slotId = i;
            break;
          }
        }
        if (!slot) {
          player->autonomousBackpressure += 1;
          break;
        }

        std::string error;
        const auto textureStarted = std::chrono::steady_clock::now();
        const bool textureReady = EnsureTexture(
          player, slot, player->autonomousWidth, player->autonomousHeight, &error);
        const double textureMs = std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - textureStarted).count();
        player->autonomousTextureTotalMs += textureMs;
        player->autonomousTextureMaxMs = std::max(player->autonomousTextureMaxMs, textureMs);
        if (!textureReady) {
          player->lastError = error;
          break;
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
        player->autonomousRenderCalls += 1;
        player->autonomousRenderTotalMs += renderMs;
        player->autonomousRenderMaxMs = std::max(player->autonomousRenderMaxMs, renderMs);
        if (rc < 0) {
          player->lastError = MpvError(rc);
          break;
        }

        slot->inFlight = true;
        slot->frameId = player->nextFrameId++;
        player->renderedFrames += 1;
        const auto now = std::chrono::steady_clock::now().time_since_epoch();
        const double timestampUs = static_cast<double>(
          std::chrono::duration_cast<std::chrono::microseconds>(now).count());
        player->autonomousReady.push_back({
          slotId, slot->frameId, player->autonomousWidth, player->autonomousHeight,
          timestampUs, updateMs, textureMs, renderMs
        });
        player->autonomousProducedFrames += 1;
      }
    }
  });
  player->autonomousCv.notify_one();
  return true;
}

`;
replaceOnce(
  'bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {',
  workerHelper + 'bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {',
  'autonomous worker helper');

const napiApi = String.raw`
napi_value StartAutonomousProbe(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {
    Throw(env, "startAutonomousProbe expects playerId, width, height");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || !player->render) return BoolValue(env, false);
  if (!player->updateTsfn.load(std::memory_order_acquire)) {
    Throw(env, "startAutonomousProbe requires setUpdateCallback first");
    return nullptr;
  }
  return BoolValue(env, StartAutonomousProbeWorker(player, width, height));
}

napi_value StopAutonomousProbe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return BoolValue(env, false);
  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return BoolValue(env, false);
  player->StopAutonomousProbeWorker();
  return BoolValue(env, true);
}

napi_value PopAutonomousProbeFrame(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return NullValue(env);
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return NullValue(env);
  std::lock_guard<std::mutex> lock(player->autonomousMutex);
  if (player->autonomousReady.empty()) return NullValue(env);
  const AutonomousReadyFrame ready = player->autonomousReady.front();
  player->autonomousReady.pop_front();
  if (ready.slotId >= player->slots.size()) return NullValue(env);
  TextureSlot& slot = player->slots[ready.slotId];
  if (!slot.inFlight || slot.frameId != ready.frameId || !slot.sharedHandle) return NullValue(env);

  napi_value out;
  napi_create_object(env, &out);
  void* copied = nullptr;
  napi_value handleBuffer;
  napi_create_buffer_copy(env, sizeof(HANDLE), &slot.sharedHandle, &copied, &handleBuffer);
  Set(env, out, "slotId", Uint32Value(env, ready.slotId));
  Set(env, out, "frameId", DoubleValue(env, static_cast<double>(ready.frameId)));
  Set(env, out, "width", Uint32Value(env, ready.width));
  Set(env, out, "height", Uint32Value(env, ready.height));
  Set(env, out, "timestampUs", DoubleValue(env, ready.timestampUs));
  Set(env, out, "nativeUpdateMs", DoubleValue(env, ready.updateMs));
  Set(env, out, "nativeEnsureTextureMs", DoubleValue(env, ready.textureMs));
  Set(env, out, "nativeRenderMs", DoubleValue(env, ready.renderMs));
  Set(env, out, "ntHandle", handleBuffer);
  return out;
}

napi_value ReleaseAutonomousProbeFrame(napi_env env, napi_callback_info info) {
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
  std::lock_guard<std::mutex> lock(player->autonomousMutex);
  TextureSlot& slot = player->slots[slotId];
  const uint64_t frameId = static_cast<uint64_t>(frameIdNumber);
  if (!slot.inFlight || slot.frameId != frameId) return BoolValue(env, false);
  slot.inFlight = false;
  return BoolValue(env, true);
}

napi_value AutonomousProbeStats(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return NullValue(env);
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return NullValue(env);
  std::lock_guard<std::mutex> lock(player->autonomousMutex);
  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "enabled", BoolValue(env, player->autonomousEnabled.load(std::memory_order_acquire)));
  Set(env, out, "rawWakeSignals", DoubleValue(env, static_cast<double>(player->autonomousRawWakeSignals.load(std::memory_order_acquire))));
  Set(env, out, "workerWakeups", DoubleValue(env, static_cast<double>(player->autonomousWakeups)));
  Set(env, out, "renderCalls", DoubleValue(env, static_cast<double>(player->autonomousRenderCalls)));
  Set(env, out, "producedFrames", DoubleValue(env, static_cast<double>(player->autonomousProducedFrames)));
  Set(env, out, "noFramePolls", DoubleValue(env, static_cast<double>(player->autonomousNoFramePolls)));
  Set(env, out, "backpressure", DoubleValue(env, static_cast<double>(player->autonomousBackpressure)));
  Set(env, out, "readyFrames", DoubleValue(env, static_cast<double>(player->autonomousReady.size())));
  Set(env, out, "updateTotalMs", DoubleValue(env, player->autonomousUpdateTotalMs));
  Set(env, out, "updateMaxMs", DoubleValue(env, player->autonomousUpdateMaxMs));
  Set(env, out, "textureTotalMs", DoubleValue(env, player->autonomousTextureTotalMs));
  Set(env, out, "textureMaxMs", DoubleValue(env, player->autonomousTextureMaxMs));
  Set(env, out, "renderTotalMs", DoubleValue(env, player->autonomousRenderTotalMs));
  Set(env, out, "renderMaxMs", DoubleValue(env, player->autonomousRenderMaxMs));
  return out;
}

`;
replaceOnce('napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', napiApi + 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', 'autonomous N-API');

replaceOnce(
  '    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n',
  '    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"startAutonomousProbe", nullptr, StartAutonomousProbe, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"stopAutonomousProbe", nullptr, StopAutonomousProbe, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"popAutonomousProbeFrame", nullptr, PopAutonomousProbeFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"releaseAutonomousProbeFrame", nullptr, ReleaseAutonomousProbeFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"autonomousProbeStats", nullptr, AutonomousProbeStats, nullptr, nullptr, nullptr, napi_default, nullptr},\n',
  'autonomous N-API exports');

for (const marker of [
  'AutonomousReadyFrame', 'autonomousRawWakeSignals', 'autonomousCv.notify_one()',
  'StartAutonomousProbeWorker', 'startAutonomousProbe', 'popAutonomousProbeFrame',
  'releaseAutonomousProbeFrame', 'autonomousProbeStats', 'milliseconds(6)'
]) if (!s.includes(marker)) throw new Error(`autonomous probe marker missing: ${marker}`);
if (s.includes('MPV_RENDER_PARAM_ADVANCED_CONTROL')) throw new Error('advanced-control must remain disabled in autonomous probe');

fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_AUTONOMOUS_PROBE_OK rawCallback=native-cv worker=render-api-only jsIndependent=1 advancedControl=0 slots=24');

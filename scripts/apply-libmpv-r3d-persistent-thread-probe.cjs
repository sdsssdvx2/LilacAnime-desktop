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

if (!s.includes('nativeRenderMs') || !s.includes('mpv_render_context_set_update_callback')) {
  throw new Error('persistent thread probe requires complete R3D generated source');
}
if (s.includes('RenderPersistentThreadProbe')) throw new Error('persistent thread probe already applied');

replaceOnce('#include <chrono>\n', '#include <chrono>\n#include <condition_variable>\n', 'condition variable include');
replaceOnce('#include <mutex>\n', '#include <mutex>\n#include <thread>\n', 'thread include');

replaceOnce(
  '  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  ~Player() { Destroy(); }',
  `  std::atomic<uint32_t> updateCallbacksInFlight{0};\n\n  // Test-only persistent render worker state. It deliberately does not deliver\n  // frames to JS; it isolates whether keeping mpv_render_* calls on one dedicated\n  // OS thread changes render latency without per-call thread creation overhead.\n  std::mutex probeMutex;\n  std::condition_variable probeRequestCv;\n  std::condition_variable probeDoneCv;\n  std::thread probeThread;\n  bool probeStop = false;\n  bool probeRequest = false;\n  bool probeDone = false;\n  uint32_t probeWidth = 0;\n  uint32_t probeHeight = 0;\n  bool probeUpdated = false;\n  bool probeBackpressure = false;\n  int probeRenderRc = 0;\n  double probeUpdateMs = 0.0;\n  double probeEnsureTextureMs = 0.0;\n  double probeRenderMs = 0.0;\n  std::string probeError;\n\n  ~Player() { Destroy(); }`,
  'persistent probe player state');

replaceOnce(
  '  void Destroy() {\n    updateCallbackEnabled.store(false, std::memory_order_release);',
  `  void Destroy() {\n    {\n      std::lock_guard<std::mutex> probeLock(probeMutex);\n      probeStop = true;\n      probeRequestCv.notify_all();\n    }\n    if (probeThread.joinable()) probeThread.join();\n    updateCallbackEnabled.store(false, std::memory_order_release);`,
  'persistent probe teardown');

const helper = String.raw`
bool StartPersistentProbeWorker(Player* player) {
  if (!player || !player->render) return false;
  if (player->probeThread.joinable()) return true;
  player->probeStop = false;
  player->probeRequest = false;
  player->probeDone = false;
  player->probeThread = std::thread([player]() {
    for (;;) {
      uint32_t width = 0;
      uint32_t height = 0;
      {
        std::unique_lock<std::mutex> lock(player->probeMutex);
        player->probeRequestCv.wait(lock, [player]() { return player->probeStop || player->probeRequest; });
        if (player->probeStop) break;
        width = player->probeWidth;
        height = player->probeHeight;
        player->probeRequest = false;
      }

      bool updated = false;
      bool backpressure = false;
      int renderRc = 0;
      double updateMs = 0.0;
      double ensureTextureMs = 0.0;
      double renderMs = 0.0;
      std::string error;

      const auto updateStarted = std::chrono::steady_clock::now();
      const uint64_t flags = gMpv.render_context_update(player->render);
      updateMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - updateStarted).count();
      if (flags & MPV_RENDER_UPDATE_FRAME) {
        updated = true;
        TextureSlot* slot = nullptr;
        for (auto& candidate : player->slots) {
          if (!candidate.inFlight) {
            slot = &candidate;
            break;
          }
        }
        if (!slot) {
          backpressure = true;
        } else {
          const auto textureStarted = std::chrono::steady_clock::now();
          const bool textureReady = EnsureTexture(player, slot, width, height, &error);
          ensureTextureMs = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - textureStarted).count();
          if (textureReady) {
            mpv_d3d11_fbo fbo{};
            fbo.tex = slot->texture.Get();
            int blockForTargetTime = 0;
            mpv_render_param params[] = {
              {MPV_RENDER_PARAM_D3D11_FBO, &fbo},
              {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},
              {MPV_RENDER_PARAM_INVALID, nullptr}
            };
            const auto renderStarted = std::chrono::steady_clock::now();
            renderRc = gMpv.render_context_render(player->render, params);
            renderMs = std::chrono::duration<double, std::milli>(
              std::chrono::steady_clock::now() - renderStarted).count();
            if (renderRc < 0 && error.empty()) error = MpvError(renderRc);
          }
        }
      }

      {
        std::lock_guard<std::mutex> lock(player->probeMutex);
        player->probeUpdated = updated;
        player->probeBackpressure = backpressure;
        player->probeRenderRc = renderRc;
        player->probeUpdateMs = updateMs;
        player->probeEnsureTextureMs = ensureTextureMs;
        player->probeRenderMs = renderMs;
        player->probeError = std::move(error);
        player->probeDone = true;
      }
      player->probeDoneCv.notify_one();
    }
  });
  return true;
}

`;
replaceOnce('bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {', helper + 'bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {', 'persistent probe helper');

const napiProbe = String.raw`
napi_value RenderPersistentThreadProbe(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {
    Throw(env, "renderPersistentThreadProbe expects playerId, width, height");
    return nullptr;
  }

  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || !player->render) {
    napi_value out;
    napi_create_object(env, &out);
    Set(env, out, "playerFound", BoolValue(env, false));
    return out;
  }
  if (!StartPersistentProbeWorker(player)) {
    Throw(env, "failed to start persistent render probe worker");
    return nullptr;
  }

  bool updated = false;
  bool backpressure = false;
  int renderRc = 0;
  double updateMs = 0.0;
  double ensureTextureMs = 0.0;
  double renderMs = 0.0;
  std::string error;
  {
    std::unique_lock<std::mutex> lock(player->probeMutex);
    player->probeWidth = width;
    player->probeHeight = height;
    player->probeDone = false;
    player->probeRequest = true;
    player->probeRequestCv.notify_one();
    player->probeDoneCv.wait(lock, [player]() { return player->probeDone || player->probeStop; });
    if (player->probeStop && !player->probeDone) {
      Throw(env, "persistent render probe stopped before completion");
      return nullptr;
    }
    updated = player->probeUpdated;
    backpressure = player->probeBackpressure;
    renderRc = player->probeRenderRc;
    updateMs = player->probeUpdateMs;
    ensureTextureMs = player->probeEnsureTextureMs;
    renderMs = player->probeRenderMs;
    error = player->probeError;
  }

  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "playerFound", BoolValue(env, true));
  Set(env, out, "updated", BoolValue(env, updated));
  Set(env, out, "backpressure", BoolValue(env, backpressure));
  Set(env, out, "nativeUpdateMs", DoubleValue(env, updateMs));
  Set(env, out, "nativeEnsureTextureMs", DoubleValue(env, ensureTextureMs));
  Set(env, out, "nativeRenderMs", DoubleValue(env, renderMs));
  Set(env, out, "renderRc", DoubleValue(env, static_cast<double>(renderRc)));
  if (!error.empty()) Set(env, out, "error", StringValue(env, error));
  return out;
}

`;
replaceOnce('napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', napiProbe + 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', 'persistent probe N-API');
replaceOnce(
  '{"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n',
  '{"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"renderPersistentThreadProbe", nullptr, RenderPersistentThreadProbe, nullptr, nullptr, nullptr, napi_default, nullptr},\n',
  'persistent probe export');

for (const marker of [
  '#include <condition_variable>', '#include <thread>', 'StartPersistentProbeWorker',
  'RenderPersistentThreadProbe', '"renderPersistentThreadProbe"', 'probeRequestCv', 'probeDoneCv'
]) {
  if (!s.includes(marker)) throw new Error(`missing persistent probe marker: ${marker}`);
}
fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_PERSISTENT_THREAD_PROBE_OK worker=per-player persistent=1 joinPerCall=0 testOnly=1');

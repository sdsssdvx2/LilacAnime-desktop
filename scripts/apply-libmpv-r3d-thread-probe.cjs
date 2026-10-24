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

if (!s.includes('nativeRenderMs') || !s.includes('MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME')) {
  throw new Error('thread probe requires R3D generated native source');
}
if (s.includes('RenderThreadProbe')) {
  throw new Error('thread probe already applied');
}

replaceOnce('#include <mutex>\n', '#include <mutex>\n#include <thread>\n', 'thread include');

const probe = String.raw`
struct ThreadRenderProbeResult {
  bool playerFound = false;
  bool updated = false;
  bool backpressure = false;
  int renderRc = 0;
  double nativeUpdateMs = 0.0;
  double nativeEnsureTextureMs = 0.0;
  double nativeRenderMs = 0.0;
  std::string error;
};

napi_value RenderThreadProbe(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {
    Throw(env, "renderThreadProbe expects playerId, width, height");
    return nullptr;
  }

  ThreadRenderProbeResult result;
  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || !player->render) {
    napi_value out;
    napi_create_object(env, &out);
    Set(env, out, "playerFound", BoolValue(env, false));
    return out;
  }
  result.playerFound = true;

  std::thread renderThread([&]() {
    const auto updateStarted = std::chrono::steady_clock::now();
    const uint64_t flags = gMpv.render_context_update(player->render);
    result.nativeUpdateMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - updateStarted).count();
    if (!(flags & MPV_RENDER_UPDATE_FRAME)) return;
    result.updated = true;

    TextureSlot* slot = nullptr;
    for (uint32_t i = 0; i < player->slots.size(); i += 1) {
      if (!player->slots[i].inFlight) {
        slot = &player->slots[i];
        break;
      }
    }
    if (!slot) {
      result.backpressure = true;
      return;
    }

    const auto textureStarted = std::chrono::steady_clock::now();
    if (!EnsureTexture(player, slot, width, height, &result.error)) {
      result.nativeEnsureTextureMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - textureStarted).count();
      return;
    }
    result.nativeEnsureTextureMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - textureStarted).count();

    mpv_d3d11_fbo fbo{};
    fbo.tex = slot->texture.Get();
    int blockForTargetTime = 0;
    mpv_render_param params[] = {
      {MPV_RENDER_PARAM_D3D11_FBO, &fbo},
      {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},
      {MPV_RENDER_PARAM_INVALID, nullptr}
    };
    const auto renderStarted = std::chrono::steady_clock::now();
    result.renderRc = gMpv.render_context_render(player->render, params);
    result.nativeRenderMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - renderStarted).count();
  });
  renderThread.join();

  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "playerFound", BoolValue(env, result.playerFound));
  Set(env, out, "updated", BoolValue(env, result.updated));
  Set(env, out, "backpressure", BoolValue(env, result.backpressure));
  Set(env, out, "nativeUpdateMs", DoubleValue(env, result.nativeUpdateMs));
  Set(env, out, "nativeEnsureTextureMs", DoubleValue(env, result.nativeEnsureTextureMs));
  Set(env, out, "nativeRenderMs", DoubleValue(env, result.nativeRenderMs));
  Set(env, out, "renderRc", DoubleValue(env, static_cast<double>(result.renderRc)));
  if (!result.error.empty()) Set(env, out, "error", StringValue(env, result.error));
  return out;
}

`;
replaceOnce('napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', probe + 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', 'probe function');
replaceOnce('{"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n', '{"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"renderThreadProbe", nullptr, RenderThreadProbe, nullptr, nullptr, nullptr, napi_default, nullptr},\n', 'probe export');

for (const marker of ['#include <thread>', 'RenderThreadProbe', '"renderThreadProbe"', 'std::thread renderThread']) {
  if (!s.includes(marker)) throw new Error(`missing thread-probe marker: ${marker}`);
}
fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_THREAD_PROBE_OK renderApi=separate-os-thread join=synchronous testOnly=1');

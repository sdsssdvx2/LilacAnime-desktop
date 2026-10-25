'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

if (!source.includes('nativeRenderMs') || !source.includes('MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME')) {
  throw new Error('fresh/redraw probe requires transformed R3D native baseline');
}

const probe = String.raw`
napi_value RenderRedrawProbe(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {
    Throw(env, "renderRedrawProbe(playerId, width, height) requires integers");
    return nullptr;
  }
  width = (std::max)(2u, (std::min)(width, 3840u));
  height = (std::max)(2u, (std::min)(height, 2160u));

  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || !player->render) {
    Throw(env, "unknown or uninitialized player id");
    return nullptr;
  }
  DrainEvents(player);

  const auto updateStarted = std::chrono::steady_clock::now();
  const uint64_t flags = gMpv.render_context_update(player->render);
  const double nativeUpdateMs = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - updateStarted).count();

  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "updateFlags", DoubleValue(env, static_cast<double>(flags)));
  Set(env, out, "nativeUpdateMs", DoubleValue(env, nativeUpdateMs));
  if (flags & MPV_RENDER_UPDATE_FRAME) {
    Set(env, out, "ready", BoolValue(env, false));
    Set(env, out, "pendingFreshFrame", BoolValue(env, true));
    return out;
  }

  TextureSlot* slot = nullptr;
  for (uint32_t i = 0; i < player->slots.size(); i += 1) {
    if (!player->slots[i].inFlight) {
      slot = &player->slots[i];
      break;
    }
  }
  if (!slot) {
    Set(env, out, "ready", BoolValue(env, false));
    Set(env, out, "backpressure", BoolValue(env, true));
    return out;
  }

  std::string error;
  const auto ensureStarted = std::chrono::steady_clock::now();
  const bool textureReady = EnsureTexture(player, slot, width, height, &error);
  const double nativeEnsureTextureMs = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - ensureStarted).count();
  Set(env, out, "nativeEnsureTextureMs", DoubleValue(env, nativeEnsureTextureMs));
  if (!textureReady) {
    Throw(env, error);
    return nullptr;
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
  const double nativeRedrawRenderMs = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - renderStarted).count();
  Set(env, out, "nativeRedrawRenderMs", DoubleValue(env, nativeRedrawRenderMs));
  if (rc < 0) {
    Throw(env, "mpv_render_context_render(d3d11 redraw) failed: " + MpvError(rc));
    return nullptr;
  }

  Set(env, out, "ready", BoolValue(env, true));
  Set(env, out, "pendingFreshFrame", BoolValue(env, false));
  Set(env, out, "backpressure", BoolValue(env, false));
  return out;
}

`;

replaceOnce('napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', probe + 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', 'insert redraw probe');
replaceOnce(
  '    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"releaseFrame", nullptr, ReleaseFrame, nullptr, nullptr, nullptr, napi_default, nullptr},',
  '    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"renderRedrawProbe", nullptr, RenderRedrawProbe, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"releaseFrame", nullptr, ReleaseFrame, nullptr, nullptr, nullptr, napi_default, nullptr},',
  'export redraw probe'
);

for (const marker of [
  'napi_value RenderRedrawProbe',
  'pendingFreshFrame',
  'nativeRedrawRenderMs',
  '{"renderRedrawProbe", nullptr, RenderRedrawProbe'
]) {
  if (!source.includes(marker)) throw new Error(`fresh/redraw marker missing: ${marker}`);
}

fs.writeFileSync(target, source);
console.log('LIBMPV_R3D_FRESH_REDRAW_PROBE_OK guard=update-no-pending redraw=current-frame blockForTargetTime=0');

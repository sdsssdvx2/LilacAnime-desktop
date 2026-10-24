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
  throw new Error('private target probe requires complete R3D generated native source');
}
if (s.includes('RenderPrivateTargetProbe')) throw new Error('private target probe already applied');

replaceOnce(
  '  std::string lastError;\n',
  `  std::string lastError;\n  // Test-only non-shared D3D11 render target. This isolates the cost of libmpv\n  // rendering into an NT-handle-shareable texture from the rest of the pipeline.\n  ComPtr<ID3D11Texture2D> privateProbeTexture;\n  uint32_t privateProbeWidth = 0;\n  uint32_t privateProbeHeight = 0;\n`,
  'private probe player fields');

replaceOnce(
  '    context.Reset();\n    device.Reset();',
  `    privateProbeTexture.Reset();\n    privateProbeWidth = 0;\n    privateProbeHeight = 0;\n    context.Reset();\n    device.Reset();`,
  'private probe teardown');

const helper = String.raw`
bool EnsurePrivateProbeTexture(Player* player, uint32_t width, uint32_t height, std::string* error) {
  if (player->privateProbeTexture && player->privateProbeWidth == width && player->privateProbeHeight == height) {
    return true;
  }
  player->privateProbeTexture.Reset();
  player->privateProbeWidth = 0;
  player->privateProbeHeight = 0;

  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width;
  desc.Height = height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  desc.CPUAccessFlags = 0;
  desc.MiscFlags = 0; // Deliberately NOT shared and has no NT handle.

  HRESULT hr = player->device->CreateTexture2D(&desc, nullptr, &player->privateProbeTexture);
  if (FAILED(hr)) {
    *error = "Create private probe texture failed " + HrHex(hr);
    return false;
  }
  player->privateProbeWidth = width;
  player->privateProbeHeight = height;
  return true;
}

`;
replaceOnce('bool EnsureTexture(Player* player, TextureSlot* slot, uint32_t width, uint32_t height, std::string* error) {', helper + 'bool EnsureTexture(Player* player, TextureSlot* slot, uint32_t width, uint32_t height, std::string* error) {', 'private texture helper');

const napiProbe = String.raw`
napi_value RenderPrivateTargetProbe(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {
    Throw(env, "renderPrivateTargetProbe expects playerId, width, height");
    return nullptr;
  }

  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  napi_value out;
  napi_create_object(env, &out);
  if (!player || !player->render) {
    Set(env, out, "playerFound", BoolValue(env, false));
    return out;
  }
  Set(env, out, "playerFound", BoolValue(env, true));

  const auto updateStarted = std::chrono::steady_clock::now();
  const uint64_t flags = gMpv.render_context_update(player->render);
  const double nativeUpdateMs = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - updateStarted).count();
  Set(env, out, "nativeUpdateMs", DoubleValue(env, nativeUpdateMs));
  if (!(flags & MPV_RENDER_UPDATE_FRAME)) {
    Set(env, out, "updated", BoolValue(env, false));
    return out;
  }
  Set(env, out, "updated", BoolValue(env, true));

  std::string error;
  const auto textureStarted = std::chrono::steady_clock::now();
  const bool textureReady = EnsurePrivateProbeTexture(player, width, height, &error);
  const double nativeEnsureTextureMs = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - textureStarted).count();
  Set(env, out, "nativeEnsureTextureMs", DoubleValue(env, nativeEnsureTextureMs));
  if (!textureReady) {
    Set(env, out, "renderRc", DoubleValue(env, -1));
    Set(env, out, "error", StringValue(env, error));
    return out;
  }

  mpv_d3d11_fbo fbo{};
  fbo.tex = player->privateProbeTexture.Get();
  int blockForTargetTime = 0;
  mpv_render_param params[] = {
    {MPV_RENDER_PARAM_D3D11_FBO, &fbo},
    {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},
    {MPV_RENDER_PARAM_INVALID, nullptr}
  };
  const auto renderStarted = std::chrono::steady_clock::now();
  const int rc = gMpv.render_context_render(player->render, params);
  const double nativeRenderMs = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - renderStarted).count();
  Set(env, out, "nativeRenderMs", DoubleValue(env, nativeRenderMs));
  Set(env, out, "renderRc", DoubleValue(env, static_cast<double>(rc)));
  if (rc < 0) Set(env, out, "error", StringValue(env, MpvError(rc)));
  return out;
}

`;
replaceOnce('napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', napiProbe + 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {', 'private target N-API');
replaceOnce(
  '{"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n',
  '{"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"renderPrivateTargetProbe", nullptr, RenderPrivateTargetProbe, nullptr, nullptr, nullptr, napi_default, nullptr},\n',
  'private target export');

for (const marker of [
  'EnsurePrivateProbeTexture', 'desc.MiscFlags = 0; // Deliberately NOT shared',
  'RenderPrivateTargetProbe', '"renderPrivateTargetProbe"', 'privateProbeTexture'
]) {
  if (!s.includes(marker)) throw new Error(`missing private-target marker: ${marker}`);
}
fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_PRIVATE_TARGET_PROBE_OK shared=0 ntHandle=0 format=bgra8 testOnly=1');

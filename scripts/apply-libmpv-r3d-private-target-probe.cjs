'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  'struct TextureSlot {\n  ComPtr<ID3D11Texture2D> texture;\n',
  'struct TextureSlot {\n  ComPtr<ID3D11Texture2D> texture;\n  ComPtr<ID3D11Texture2D> privateRenderTexture;\n',
  'private render target member'
);

replaceOnce(
  '    texture.Reset();\n    width = 0;\n',
  '    texture.Reset();\n    privateRenderTexture.Reset();\n    width = 0;\n',
  'private render target reset'
);

replaceOnce(
  'std::unordered_map<uint32_t, std::unique_ptr<Player>> gPlayers;\n',
  `std::unordered_map<uint32_t, std::unique_ptr<Player>> gPlayers;\n\nbool PrivateTargetProbeEnabled() {\n  const char* value = std::getenv("LILAC_LIBMPV_TEST_PRIVATE_TARGET");\n  return value && std::strcmp(value, "1") == 0;\n}\n`,
  'private target env gate'
);

replaceOnce(
  '  if (slot->texture && slot->width == width && slot->height == height) return true;\n',
  '  const bool privateTarget = PrivateTargetProbeEnabled();\n  if (slot->texture && slot->width == width && slot->height == height && (!privateTarget || slot->privateRenderTexture)) return true;\n',
  'private target cache condition'
);

replaceOnce(
  '  slot->width = width;\n  slot->height = height;\n  return true;\n}',
  `  if (privateTarget) {\n    D3D11_TEXTURE2D_DESC privateDesc = desc;\n    privateDesc.MiscFlags = 0;\n    HRESULT privateHr = player->device->CreateTexture2D(&privateDesc, nullptr, &slot->privateRenderTexture);\n    if (FAILED(privateHr)) {\n      *error = "Create private render texture failed " + HrHex(privateHr);\n      return false;\n    }\n  }\n  slot->width = width;\n  slot->height = height;\n  return true;\n}`,
  'create private render target'
);

replaceOnce(
  '  mpv_d3d11_fbo fbo{};\n  fbo.tex = slot->texture.Get();\n',
  '  mpv_d3d11_fbo fbo{};\n  const bool privateTargetProbe = PrivateTargetProbeEnabled();\n  fbo.tex = privateTargetProbe ? slot->privateRenderTexture.Get() : slot->texture.Get();\n  Set(env, out, "privateTargetProbe", BoolValue(env, privateTargetProbe));\n',
  'select private or shared render target'
);

replaceOnce(
  '  if (rc < 0) {\n    Throw(env, "mpv_render_context_render(d3d11) failed: " + MpvError(rc));\n    return nullptr;\n  }\n\n  slot->inFlight = true;\n',
  `  if (rc < 0) {\n    Throw(env, "mpv_render_context_render(d3d11) failed: " + MpvError(rc));\n    return nullptr;\n  }\n\n  double nativeExportCopySubmitMs = 0;\n  if (privateTargetProbe) {\n    const auto exportCopyStarted = std::chrono::steady_clock::now();\n    player->context->CopyResource(slot->texture.Get(), slot->privateRenderTexture.Get());\n    nativeExportCopySubmitMs = std::chrono::duration<double, std::milli>(\n      std::chrono::steady_clock::now() - exportCopyStarted).count();\n  }\n  Set(env, out, "nativeExportCopySubmitMs", DoubleValue(env, nativeExportCopySubmitMs));\n\n  slot->inFlight = true;\n`,
  'private to shared GPU copy'
);

for (const marker of [
  'privateRenderTexture',
  'LILAC_LIBMPV_TEST_PRIVATE_TARGET',
  'privateTargetProbe',
  'nativeExportCopySubmitMs',
  'CopyResource(slot->texture.Get(), slot->privateRenderTexture.Get())'
]) {
  if (!source.includes(marker)) throw new Error(`private-target probe marker missing: ${marker}`);
}
if (!source.includes('MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME')) throw new Error('timing-disable render parameter missing');

fs.writeFileSync(target, source);
console.log('LIBMPV_R3D_PRIVATE_TARGET_PROBE_OK modes=direct-shared,private-then-copy timing=render+copy-submit');

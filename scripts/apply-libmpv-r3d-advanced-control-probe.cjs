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

if (!source.includes('napi_value PollPlayback') || !source.includes('mpv_render_context_set_update_callback')) {
  throw new Error('R3D advanced-control probe requires R3C native baseline');
}

replaceOnce(
  `  mpv_d3d11_init_params initParams{};\n  initParams.device = player->device.Get();\n  const char* apiType = MPV_RENDER_API_TYPE_D3D11;\n  mpv_render_param params[] = {\n    {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(apiType)},\n    {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &initParams},\n    {MPV_RENDER_PARAM_INVALID, nullptr}\n  };`,
  `  mpv_d3d11_init_params initParams{};\n  initParams.device = player->device.Get();\n  const char* apiType = MPV_RENDER_API_TYPE_D3D11;\n  int advancedControl = 0;\n  char advancedEnv[8]{};\n  const DWORD advancedLength = GetEnvironmentVariableA(\"LILAC_LIBMPV_ADVANCED_CONTROL\", advancedEnv, static_cast<DWORD>(sizeof(advancedEnv)));\n  if (advancedLength > 0 && std::string(advancedEnv) == \"1\") advancedControl = 1;\n  mpv_render_param params[] = {\n    {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(apiType)},\n    {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &initParams},\n    {MPV_RENDER_PARAM_ADVANCED_CONTROL, &advancedControl},\n    {MPV_RENDER_PARAM_INVALID, nullptr}\n  };`,
  'env-controlled advanced render context');

replaceOnce(
  `  for (const auto& option : options) {\n    if (!SetOption(player.get(), option.first, option.second, &error)) {\n      Throw(env, error);\n      return nullptr;\n    }\n  }`,
  `  for (const auto& option : options) {\n    if (!SetOption(player.get(), option.first, option.second, &error)) {\n      Throw(env, error);\n      return nullptr;\n    }\n  }\n  char forceDrEnv[8]{};\n  const DWORD forceDrLength = GetEnvironmentVariableA(\"LILAC_LIBMPV_FORCE_DR\", forceDrEnv, static_cast<DWORD>(sizeof(forceDrEnv)));\n  if (forceDrLength > 0 && std::string(forceDrEnv) == \"1\") {\n    if (!SetOption(player.get(), \"vd-lavc-dr\", \"yes\", &error)) {\n      Throw(env, error);\n      return nullptr;\n    }\n  }`,
  'optional forced decoder direct rendering');

for (const marker of [
  'LILAC_LIBMPV_ADVANCED_CONTROL',
  'MPV_RENDER_PARAM_ADVANCED_CONTROL',
  'LILAC_LIBMPV_FORCE_DR',
  'SetOption(player.get(), "vd-lavc-dr", "yes"'
]) if (!source.includes(marker)) throw new Error(`R3D probe marker missing: ${marker}`);

fs.writeFileSync(target, source);
console.log('LIBMPV_R3D_ADVANCED_PROBE_OK advancedControl=env forceDr=env default=legacy');

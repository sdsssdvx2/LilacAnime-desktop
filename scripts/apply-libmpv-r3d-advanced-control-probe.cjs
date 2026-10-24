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

if (!s.includes('RenderPersistentThreadProbe') || !s.includes('nativeRenderMs')) {
  throw new Error('advanced-control probe requires persistent-thread R3D test source');
}
if (s.includes('LILAC_LIBMPV_TEST_ADVANCED_CONTROL')) throw new Error('advanced-control probe already applied');

replaceOnce(
  `  mpv_d3d11_init_params initParams{};\n  initParams.device = player->device.Get();\n  const char* apiType = MPV_RENDER_API_TYPE_D3D11;\n  mpv_render_param params[] = {\n    {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(apiType)},\n    {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &initParams},\n    {MPV_RENDER_PARAM_INVALID, nullptr}\n  };`,
  `  mpv_d3d11_init_params initParams{};\n  initParams.device = player->device.Get();\n  const char* apiType = MPV_RENDER_API_TYPE_D3D11;\n  char advancedControlEnv[8]{};\n  const DWORD advancedControlLen = GetEnvironmentVariableA(\n    "LILAC_LIBMPV_TEST_ADVANCED_CONTROL", advancedControlEnv, static_cast<DWORD>(sizeof(advancedControlEnv)));\n  const bool advancedControlEnabled = advancedControlLen > 0 && std::strcmp(advancedControlEnv, "1") == 0;\n  int advancedControl = advancedControlEnabled ? 1 : 0;\n  mpv_render_param params[] = {\n    {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(apiType)},\n    {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &initParams},\n    {MPV_RENDER_PARAM_ADVANCED_CONTROL, &advancedControl},\n    {MPV_RENDER_PARAM_INVALID, nullptr}\n  };`,
  'advanced-control render context param');

replaceOnce(
  `  Set(env, out, "deviceMode", StringValue(env, deviceMode));\n  Set(env, out, "featureLevel", StringValue(env, featureLevel));`,
  `  Set(env, out, "deviceMode", StringValue(env, deviceMode));\n  Set(env, out, "advancedControl", BoolValue(env, advancedControlEnabled));\n  Set(env, out, "featureLevel", StringValue(env, featureLevel));`,
  'advanced-control creation diagnostic');

for (const marker of [
  'LILAC_LIBMPV_TEST_ADVANCED_CONTROL',
  'MPV_RENDER_PARAM_ADVANCED_CONTROL',
  'advancedControlEnabled',
  '"advancedControl"'
]) if (!s.includes(marker)) throw new Error(`advanced-control marker missing: ${marker}`);

fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_ADVANCED_CONTROL_PROBE_OK optIn=env persistentWorkerRequired=1 testOnly=1');

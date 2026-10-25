'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function one(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

if (!source.includes('nativeRenderMs') || !source.includes('nextFramePresent') || !source.includes('MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME')) {
  throw new Error('render-path probe requires exact R3D + frame-info baseline');
}
if (source.includes('LILAC_LIBMPV_TEST_HWDEC') || source.includes('LILAC_LIBMPV_TEST_SKIP_RENDERING')) {
  throw new Error('render-path probe already applied');
}

one(
  `  const std::pair<const char*, const char*> options[] = {\n    {"terminal", "no"},`,
  `  const char* testHwdec = std::getenv("LILAC_LIBMPV_TEST_HWDEC");\n  const char* probeHwdec = (testHwdec && std::strcmp(testHwdec, "no") == 0) ? "no" : "auto-safe";\n\n  const std::pair<const char*, const char*> options[] = {\n    {"terminal", "no"},`,
  'pre-init hwdec probe option'
);

one(
  `    {"vo", "libmpv"},\n    {"hwdec", "auto-safe"}\n  };`,
  `    {"vo", "libmpv"},\n    {"hwdec", probeHwdec}\n  };`,
  'hwdec option value'
);

one(
  `  Set(env, out, "mpvClientApiVersion", DoubleValue(env, static_cast<double>(gMpv.client_api_version())));\n  return out;`,
  `  Set(env, out, "mpvClientApiVersion", DoubleValue(env, static_cast<double>(gMpv.client_api_version())));\n  Set(env, out, "probeHwdec", StringValue(env, probeHwdec));\n  return out;`,
  'createPlayer probe identity'
);

one(
  `  int blockForTargetTime = 0;\n  mpv_render_param params[] = {\n    {MPV_RENDER_PARAM_D3D11_FBO, &fbo},\n    {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},\n    {MPV_RENDER_PARAM_INVALID, nullptr}\n  };`,
  `  int blockForTargetTime = 0;\n  const char* testSkipRendering = std::getenv("LILAC_LIBMPV_TEST_SKIP_RENDERING");\n  int skipRendering = (testSkipRendering && std::strcmp(testSkipRendering, "1") == 0) ? 1 : 0;\n  Set(env, out, "skipRenderingProbe", BoolValue(env, skipRendering != 0));\n  mpv_render_param params[] = {\n    {MPV_RENDER_PARAM_D3D11_FBO, &fbo},\n    {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},\n    {MPV_RENDER_PARAM_SKIP_RENDERING, &skipRendering},\n    {MPV_RENDER_PARAM_INVALID, nullptr}\n  };`,
  'skip-render render param'
);

for (const marker of [
  'LILAC_LIBMPV_TEST_HWDEC',
  'probeHwdec',
  'LILAC_LIBMPV_TEST_SKIP_RENDERING',
  'skipRenderingProbe',
  'MPV_RENDER_PARAM_SKIP_RENDERING'
]) {
  if (!source.includes(marker)) throw new Error(`render-path marker missing: ${marker}`);
}

fs.writeFileSync(target, source);
console.log('LIBMPV_R3D_RENDER_PATH_PROBE_OK hwdec=auto-safe|no skipRendering=0|1 independent-process-required=1');

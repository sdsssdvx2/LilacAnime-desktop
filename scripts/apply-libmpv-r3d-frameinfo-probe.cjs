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
  throw new Error('frameinfo probe requires transformed R3D baseline');
}

replaceOnce(
  '  decltype(&mpv_render_context_render) render_context_render = nullptr;\n  decltype(&mpv_render_context_free) render_context_free = nullptr;',
  '  decltype(&mpv_render_context_render) render_context_render = nullptr;\n  decltype(&mpv_render_context_get_info) render_context_get_info = nullptr;\n  decltype(&mpv_render_context_free) render_context_free = nullptr;',
  'MpvApi frame-info function pointer'
);

replaceOnce(
  '  LOAD_MPV("mpv_render_context_render", render_context_render);\n  LOAD_MPV("mpv_render_context_free", render_context_free);',
  '  LOAD_MPV("mpv_render_context_render", render_context_render);\n  LOAD_MPV("mpv_render_context_get_info", render_context_get_info);\n  LOAD_MPV("mpv_render_context_free", render_context_free);',
  'load frame-info symbol'
);

const anchor = '  Set(env, out, "nativeUpdateMs", DoubleValue(env, nativeUpdateMs));\n  if (!(flags & MPV_RENDER_UPDATE_FRAME)) return out;';
const replacement = `  Set(env, out, "nativeUpdateMs", DoubleValue(env, nativeUpdateMs));\n\n  mpv_render_frame_info nextFrameInfo{};\n  mpv_render_param nextFrameParam{MPV_RENDER_PARAM_NEXT_FRAME_INFO, &nextFrameInfo};\n  const int nextFrameInfoRc = gMpv.render_context_get_info(player->render, nextFrameParam);\n  Set(env, out, "nextFrameInfoRc", DoubleValue(env, static_cast<double>(nextFrameInfoRc)));\n  if (nextFrameInfoRc >= 0) {\n    const uint64_t infoFlags = nextFrameInfo.flags;\n    Set(env, out, "nextFrameInfoFlags", DoubleValue(env, static_cast<double>(infoFlags)));\n    Set(env, out, "nextFramePresent", BoolValue(env, (infoFlags & MPV_RENDER_FRAME_INFO_PRESENT) != 0));\n    Set(env, out, "nextFrameRedraw", BoolValue(env, (infoFlags & MPV_RENDER_FRAME_INFO_REDRAW) != 0));\n    Set(env, out, "nextFrameRepeat", BoolValue(env, (infoFlags & MPV_RENDER_FRAME_INFO_REPEAT) != 0));\n    Set(env, out, "nextFrameBlockVsync", BoolValue(env, (infoFlags & MPV_RENDER_FRAME_INFO_BLOCK_VSYNC) != 0));\n    Set(env, out, "nextFrameTargetTimeNs", DoubleValue(env, static_cast<double>(nextFrameInfo.target_time)));\n  }\n  if (!(flags & MPV_RENDER_UPDATE_FRAME)) return out;`;
replaceOnce(anchor, replacement, 'RenderFrame next-frame classification');

for (const marker of [
  'render_context_get_info',
  'MPV_RENDER_PARAM_NEXT_FRAME_INFO',
  'nextFramePresent',
  'nextFrameRedraw',
  'nextFrameRepeat',
  'nextFrameBlockVsync',
  'nextFrameTargetTimeNs'
]) {
  if (!source.includes(marker)) throw new Error(`frameinfo marker missing: ${marker}`);
}

fs.writeFileSync(target, source);
console.log('LIBMPV_R3D_FRAMEINFO_PROBE_OK flags=present,redraw,repeat,block-vsync target-time=1');

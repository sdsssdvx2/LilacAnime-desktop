'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);
function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');
if (!native.includes('LILAC_R33_NATIVE_ONLY_UNFOCUSED') || !bridge.includes('LILAC_R33_OWNED_POPUP_FOCUS_SURFACE')) throw new Error('R33 stall attribution requires R33 focus fix');
if (native.includes('LILAC_R33_STALL_ATTRIBUTION') || bridge.includes('LILAC_R33_STALL_ATTRIBUTION')) throw new Error('R33 stall attribution already applied');

native = replaceOnce(
  native,
  '  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED\n',
  `  uint64_t r33NativeOnlyFrames = 0; // LILAC_R33_NATIVE_ONLY_UNFOCUSED\n  uint64_t r33LongRenderCount = 0; // LILAC_R33_STALL_ATTRIBUTION\n  double r33LastLongRenderMs = 0.0;\n  double r33MaxLongRenderMs = 0.0;\n  double r33LastLongRenderWallMs = 0.0;\n`,
  'R33 native render stall fields'
);

native = replaceOnce(
  native,
  '    player->producerRenderMaxMs = 0.0;\n',
  `    player->producerRenderMaxMs = 0.0;\n    player->r33LongRenderCount = 0;\n    player->r33LastLongRenderMs = 0.0;\n    player->r33MaxLongRenderMs = 0.0;\n    player->r33LastLongRenderWallMs = 0.0;\n`,
  'R33 native render stall reset'
);

native = replaceOnce(
  native,
  '          player->producerRenderMaxMs = std::max(player->producerRenderMaxMs, renderMs);\n',
  `          player->producerRenderMaxMs = std::max(player->producerRenderMaxMs, renderMs);\n          if (renderMs >= 60.0) {\n            player->r33LongRenderCount += 1;\n            player->r33LastLongRenderMs = renderMs;\n            player->r33MaxLongRenderMs = std::max(player->r33MaxLongRenderMs, renderMs);\n            const auto r33WallNow = std::chrono::system_clock::now().time_since_epoch();\n            player->r33LastLongRenderWallMs = static_cast<double>(\n              std::chrono::duration_cast<std::chrono::milliseconds>(r33WallNow).count());\n          }\n`,
  'R33 retain long native render event'
);

native = replaceOnce(
  native,
  '  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));\n',
  `  Set(env, out, "nativeOnlyFrames", DoubleValue(env, static_cast<double>(player->r33NativeOnlyFrames)));\n  Set(env, out, "longRenderThresholdMs", DoubleValue(env, 60.0));\n  Set(env, out, "longRenderCount", DoubleValue(env, static_cast<double>(player->r33LongRenderCount)));\n  Set(env, out, "lastLongRenderMs", DoubleValue(env, player->r33LastLongRenderMs));\n  Set(env, out, "maxLongRenderMs", DoubleValue(env, player->r33MaxLongRenderMs));\n  Set(env, out, "lastLongRenderWallMs", DoubleValue(env, player->r33LastLongRenderWallMs));\n`,
  'R33 native stall diagnostics'
);

bridge = replaceOnce(
  bridge,
  '  let r33GeometryResyncs = 0;\n',
  `  let r33GeometryResyncs = 0; // LILAC_R33_STALL_ATTRIBUTION\n  const R33_HEARTBEAT_MS = 50;\n  const R33_HEARTBEAT_STALL_MS = 80;\n  let r33HeartbeatLastPerfMs = performance.now();\n  let r33EventLoopStallCount = 0;\n  let r33EventLoopMaxGapMs = 0;\n  let r33EventLoopLastGapMs = 0;\n  let r33EventLoopLastWallMs = 0;\n  const r33HeartbeatTimer = setInterval(() => {\n    const now = performance.now();\n    const gap = Math.max(0, now - r33HeartbeatLastPerfMs);\n    r33HeartbeatLastPerfMs = now;\n    if (active && gap >= R33_HEARTBEAT_STALL_MS) {\n      r33EventLoopStallCount += 1;\n      r33EventLoopLastGapMs = gap;\n      r33EventLoopMaxGapMs = Math.max(r33EventLoopMaxGapMs, gap);\n      r33EventLoopLastWallMs = Date.now();\n    }\n  }, R33_HEARTBEAT_MS);\n  r33HeartbeatTimer.unref?.();\n`,
  'R33 main heartbeat state'
);

bridge = replaceOnce(
  bridge,
  `        geometryResyncs: r33GeometryResyncs\n      },`,
  `        geometryResyncs: r33GeometryResyncs,\n        eventLoopHeartbeat: {\n          intervalMs: R33_HEARTBEAT_MS,\n          stallThresholdMs: R33_HEARTBEAT_STALL_MS,\n          stallCount: r33EventLoopStallCount,\n          maxGapMs: r33EventLoopMaxGapMs,\n          lastGapMs: r33EventLoopLastGapMs,\n          lastWallMs: r33EventLoopLastWallMs\n        }\n      },`,
  'R33 heartbeat diagnostics'
);

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
for (const marker of ['LILAC_R33_STALL_ATTRIBUTION','r33LongRenderCount','lastLongRenderWallMs']) if (!read('native/libmpv-d3d11-bridge/player_addon.cc').includes(marker)) throw new Error(`R33 native attribution marker missing ${marker}`);
for (const marker of ['LILAC_R33_STALL_ATTRIBUTION','R33_HEARTBEAT_MS','eventLoopHeartbeat']) if (!read('electron/libmpv-shared-main.cjs').includes(marker)) throw new Error(`R33 bridge attribution marker missing ${marker}`);
console.log('R33_STALL_ATTRIBUTION_OK mainHeartbeatMs=50 mainStallThresholdMs=80 nativeRenderThresholdMs=60 overhead=fixed-low-rate');

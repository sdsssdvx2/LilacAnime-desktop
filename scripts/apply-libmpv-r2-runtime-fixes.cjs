'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function count(source, needle) {
  return source.split(needle).length - 1;
}

function replaceOnce(source, needle, replacement, label) {
  const found = count(source, needle);
  if (found !== 1) throw new Error(`${label}: expected exactly one anchor, found ${found}`);
  return source.replace(needle, replacement);
}

function replaceAllExpected(source, needle, replacement, expected, label) {
  const found = count(source, needle);
  if (found !== expected) throw new Error(`${label}: expected ${expected} anchors, found ${found}`);
  return source.split(needle).join(replacement);
}

// This transform intentionally runs AFTER apply-libmpv-d2-diagnostics.cjs.
// It fixes the exact SURFACE-AUDIO-R1 regressions observed on the user's 1080p
// ReAnime sample: ~3.6fps presentation, ~89% backpressure, dead-feeling input,
// duplicate subtitles, and insufficient audio-track observability.

let preload = read('electron/libmpv-shared-preload.cjs');
preload = replaceOnce(
  preload,
  `let lastFrameAt = 0;\n\nconst nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));`,
  `let lastFrameAt = 0;\nlet lastStatsSentAt = 0;\nlet drawSamples = 0;\nlet drawTotalMs = 0;\nlet lastDrawMs = 0;\nlet maxDrawMs = 0;`,
  'receiver lifetime state'
);
preload = replaceOnce(
  preload,
  `function sendStats(extra = {}) {\n  try {\n    ipcRenderer.send('libmpv-shared:receiver-stats', {\n      receivedFrames,\n      presentedFrames,\n      droppedNoSurface,\n      drawFailures,\n      lastFrameAt,\n      ...extra\n    });\n  } catch {}\n}`,
  `function sendStats(extra = {}, force = false) {\n  const now = Date.now();\n  if (!force && now - lastStatsSentAt < 250) return;\n  lastStatsSentAt = now;\n  try {\n    ipcRenderer.send('libmpv-shared:receiver-stats', {\n      receivedFrames,\n      presentedFrames,\n      droppedNoSurface,\n      drawFailures,\n      lastFrameAt,\n      lastDrawMs: Math.round(lastDrawMs * 1000) / 1000,\n      maxDrawMs: Math.round(maxDrawMs * 1000) / 1000,\n      avgDrawMs: drawSamples ? Math.round((drawTotalMs / drawSamples) * 1000) / 1000 : 0,\n      ...extra\n    });\n  } catch {}\n}`,
  'receiver stats throttling'
);
preload = replaceOnce(
  preload,
  `  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata = {}) => {`,
  `  sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }, metadata = {}) => {`,
  'synchronous receiver callback'
);
preload = replaceOnce(
  preload,
  `      frame = importedSharedTexture.getVideoFrame();\n      context.drawImage(frame, 0, 0, width, height);\n\n      // Keep the VideoFrame and imported shared texture alive across compositor\n      // turns. The local v3 probe proved that releasing immediately can leave a\n      // stale first frame on Windows; two turns keeps the normal 24/30/60fps\n      // path below the three-slot producer lifetime budget without a CPU readback.\n      await nextFrame();\n      await nextFrame();\n      presentedFrames += 1;`,
  `      frame = importedSharedTexture.getVideoFrame();\n      const drawStarted = performance.now();\n      context.drawImage(frame, 0, 0, width, height);\n      lastDrawMs = performance.now() - drawStarted;\n      drawSamples += 1;\n      drawTotalMs += lastDrawMs;\n      maxDrawMs = Math.max(maxDrawMs, lastDrawMs);\n      // drawImage(VideoFrame) queues the GPU-backed copy. Chromium owns the GPU\n      // lifetime after this call, so holding all three imported textures across\n      // extra animation frames only starves the producer.\n      presentedFrames += 1;`,
  'remove two-frame shared texture hold'
);
preload = preload.replace(
  `      sendStats({\n        lastFrameId: Number(metadata?.frameId) || 0,\n        reason: 'draw-failed',\n        error: String(error?.message || error).slice(0, 160)\n      });`,
  `      sendStats({\n        lastFrameId: Number(metadata?.frameId) || 0,\n        reason: 'draw-failed',\n        error: String(error?.message || error).slice(0, 160)\n      }, true);`
);
write('electron/libmpv-shared-preload.cjs', preload);

let bridge = read('electron/libmpv-shared-main.cjs');
bridge = replaceOnce(
  bridge,
  `    backpressure: 0,\n    lastFrameAt: 0,\n    lastReleaseAt: 0,\n    lastFrameId: 0,\n    maxPending: 0\n  };`,
  `    backpressure: 0,\n    firstFrameAt: 0,\n    lastFrameAt: 0,\n    lastReleaseAt: 0,\n    lastFrameId: 0,\n    maxPending: 0,\n    releaseLatencyTotalMs: 0,\n    releaseLatencyMaxMs: 0,\n    lastReleaseLatencyMs: 0\n  };\n\n  function metricsSnapshot() {\n    const frameSpanMs = metrics.firstFrameAt && metrics.lastFrameAt > metrics.firstFrameAt\n      ? metrics.lastFrameAt - metrics.firstFrameAt\n      : 0;\n    return {\n      ...metrics,\n      effectiveSentFps: frameSpanMs > 0 && metrics.sentFrames > 1\n        ? Math.round(((metrics.sentFrames - 1) * 1000000) / frameSpanMs) / 1000\n        : 0,\n      backpressureRatio: metrics.pumpTicks > 0\n        ? Math.round((metrics.backpressure / metrics.pumpTicks) * 1000000) / 1000000\n        : 0,\n      avgReleaseLatencyMs: metrics.receiverReleases > 0\n        ? Math.round((metrics.releaseLatencyTotalMs / metrics.receiverReleases) * 1000) / 1000\n        : 0\n    };\n  }`,
  'bridge performance metrics'
);
bridge = replaceOnce(
  bridge,
  `  function releaseNativeFrame(ownerPlayerId, slotId, frameId) {\n    const key = pendingKey(ownerPlayerId, slotId, frameId);\n    if (!pendingFrames.has(key)) return;\n    pendingFrames.delete(key);\n    metrics.receiverReleases += 1;\n    metrics.lastReleaseAt = Date.now();\n    try { addon?.releaseFrame(ownerPlayerId, slotId, frameId); } catch {}\n  }`,
  `  function releaseNativeFrame(ownerPlayerId, slotId, frameId) {\n    const key = pendingKey(ownerPlayerId, slotId, frameId);\n    const pending = pendingFrames.get(key);\n    if (!pending) return;\n    pendingFrames.delete(key);\n    const now = Date.now();\n    const latency = Math.max(0, now - pending.at);\n    metrics.receiverReleases += 1;\n    metrics.lastReleaseAt = now;\n    metrics.lastReleaseLatencyMs = latency;\n    metrics.releaseLatencyTotalMs += latency;\n    metrics.releaseLatencyMaxMs = Math.max(metrics.releaseLatencyMaxMs, latency);\n    try { addon?.releaseFrame(ownerPlayerId, slotId, frameId); } catch {}\n    schedulePump(0);\n  }`,
  'release-driven pump wakeup'
);
bridge = replaceOnce(
  bridge,
  `  function schedulePump(delay = 0) {\n    if (!active || disposed || pumpTimer) return;\n    pumpTimer = setTimeout(() => {\n      pumpTimer = null;\n      void pump();\n    }, Math.max(0, delay));\n  }`,
  `  function schedulePump(delay = 16) {\n    if (!active || disposed) return;\n    const wait = Math.max(0, Number(delay) || 0);\n    if (pumpTimer) {\n      if (wait > 0) return;\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n    }\n    pumpTimer = setTimeout(() => {\n      pumpTimer = null;\n      void pump();\n    }, wait);\n  }`,
  'paced pump scheduler'
);
bridge = replaceOnce(
  bridge,
  `    const ownerPlayerId = playerId;\n    const ownerGeneration = generation;\n    try {`,
  `    const ownerPlayerId = playerId;\n    const ownerGeneration = generation;\n    let nextDelay = 16;\n    try {`,
  'pump next delay state'
);
bridge = replaceOnce(
  bridge,
  `      const nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);\n      if (nativeFrame?.backpressure) metrics.backpressure += 1;\n      if (!nativeFrame?.updated) return;\n      metrics.nativeFrames += 1;\n      metrics.lastFrameAt = Date.now();`,
  `      const nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);\n      if (nativeFrame?.backpressure) {\n        metrics.backpressure += 1;\n        nextDelay = 100;\n        return;\n      }\n      if (!nativeFrame?.updated) {\n        nextDelay = 16;\n        return;\n      }\n      metrics.nativeFrames += 1;\n      const frameNow = Date.now();\n      if (!metrics.firstFrameAt) metrics.firstFrameAt = frameNow;\n      metrics.lastFrameAt = frameNow;`,
  'backpressure-aware pump pacing'
);
bridge = replaceOnce(
  bridge,
  `      if (active && !disposed) schedulePump(5);`,
  `      if (active && !disposed) schedulePump(nextDelay);`,
  'remove 5ms spin'
);
bridge = replaceAllExpected(bridge, `metrics: { ...metrics }`, `metrics: metricsSnapshot()`, 2, 'diagnostic metric snapshots');
bridge = replaceAllExpected(bridge, `runtimeRevision: 'SURFACE-AUDIO-R1'`, `runtimeRevision: 'FRAME-INPUT-SUBTITLE-R2'`, 1, 'bridge runtime revision');
write('electron/libmpv-shared-main.cjs', bridge);

let entry = read('src/libmpv-shared-entry.js');
// apply-libmpv-renderer-compat.cjs runs in the D2 preflight and has already added
// width/height/min-size declarations by the time this transform executes.
entry = replaceOnce(
  entry,
  `:host{display:block;position:relative;width:100%;height:100%;min-width:0;min-height:0;background:#000;overflow:hidden;contain:layout paint size}`,
  `:host{display:block;position:relative;width:100%;height:100%;min-width:0;min-height:0;background:#000;overflow:hidden;contain:layout paint size;pointer-events:none}`,
  'non-intercepting post-compat video surface'
);
entry = replaceOnce(
  entry,
  `      if (this._playerOpen && element.src && !element.src.startsWith('blob:')) {\n        void this._command(['sub-add', element.src, 'select']);\n      }\n`,
  `      // Lilac remains the single subtitle renderer. Do not also add the same\n      // track to mpv or two subtitle layers are rendered.\n`,
  'single subtitle renderer'
);
entry = replaceAllExpected(entry, `runtimeRevision: 'SURFACE-AUDIO-R1'`, `runtimeRevision: 'FRAME-INPUT-SUBTITLE-R2'`, 1, 'renderer runtime revision');
write('src/libmpv-shared-entry.js', entry);

let player = read('native/libmpv-d3d11-bridge/player_addon.cc');
player = replaceOnce(
  player,
  `void SetMaybeString(napi_env env, napi_value object, const char* key, Player* player, const char* property) {\n  std::string value;\n  Set(env, object, key, GetStringProperty(player, property, &value) ? StringValue(env, value) : NullValue(env));\n}\n\nnapi_value CreatePlayer`,
  `void SetMaybeString(napi_env env, napi_value object, const char* key, Player* player, const char* property) {\n  std::string value;\n  Set(env, object, key, GetStringProperty(player, property, &value) ? StringValue(env, value) : NullValue(env));\n}\n\nnapi_value SafeTrackSummary(napi_env env, Player* player) {\n  napi_value tracks;\n  napi_create_array(env, &tracks);\n  int64_t trackCount = 0;\n  if (!GetInt64Property(player, \"track-list/count\", &trackCount) || trackCount <= 0) return tracks;\n  const int64_t limit = trackCount < 16 ? trackCount : 16;\n  uint32_t outputIndex = 0;\n  for (int64_t i = 0; i < limit; i += 1) {\n    const std::string prefix = \"track-list/\" + std::to_string(i) + \"/\";\n    std::string type;\n    if (!GetStringProperty(player, (prefix + \"type\").c_str(), &type)) continue;\n    if (type != \"audio\" && type != \"video\" && type != \"sub\") continue;\n    napi_value item;\n    napi_create_object(env, &item);\n    Set(env, item, \"type\", StringValue(env, type));\n    std::string value;\n    if (GetStringProperty(player, (prefix + \"codec\").c_str(), &value)) Set(env, item, \"codec\", StringValue(env, value));\n    if (GetStringProperty(player, (prefix + \"lang\").c_str(), &value)) Set(env, item, \"lang\", StringValue(env, value));\n    bool flag = false;\n    if (GetFlagProperty(player, (prefix + \"selected\").c_str(), &flag)) Set(env, item, \"selected\", BoolValue(env, flag));\n    if (GetFlagProperty(player, (prefix + \"default\").c_str(), &flag)) Set(env, item, \"default\", BoolValue(env, flag));\n    napi_set_element(env, tracks, outputIndex++, item);\n  }\n  return tracks;\n}\n\nnapi_value CreatePlayer`,
  'bounded safe track summary helper'
);
player = replaceOnce(
  player,
  `  for (const auto& option : options) {\n    if (!SetOption(player.get(), option.first, option.second, &error)) {\n      Throw(env, error);\n      return nullptr;\n    }\n  }\n\n  int rc = gMpv.initialize(player->handle);`,
  `  for (const auto& option : options) {\n    if (!SetOption(player.get(), option.first, option.second, &error)) {\n      Throw(env, error);\n      return nullptr;\n    }\n  }\n\n  char testAo[8]{};\n  const DWORD testAoLength = GetEnvironmentVariableA(\"LILAC_LIBMPV_TEST_AO_NULL\", testAo, static_cast<DWORD>(sizeof(testAo)));\n  if (testAoLength > 0 && std::string(testAo) == \"1\") {\n    if (!SetOption(player.get(), \"ao\", \"null\", &error)) {\n      Throw(env, error);\n      return nullptr;\n    }\n  }\n\n  int rc = gMpv.initialize(player->handle);`,
  'CI null audio output option'
);
player = replaceOnce(
  player,
  `  SetMaybeString(env, out, \"hwdecCurrent\", player, \"hwdec-current\");`,
  `  SetMaybeString(env, out, \"hwdecCurrent\", player, \"hwdec-current\");\n  Set(env, out, \"tracks\", SafeTrackSummary(env, player));`,
  'safe track diagnostics output'
);
write('native/libmpv-d3d11-bridge/player_addon.cc', player);

const checks = [
  ['electron/libmpv-shared-preload.cjs', ['lastDrawMs', 'avgDrawMs'], ['await nextFrame()', 'const nextFrame =']],
  ['electron/libmpv-shared-main.cjs', ['effectiveSentFps', 'backpressureRatio', 'avgReleaseLatencyMs', 'schedulePump(nextDelay)'], ['schedulePump(5)']],
  ['src/libmpv-shared-entry.js', ['FRAME-INPUT-SUBTITLE-R2', 'pointer-events:none'], ["['sub-add'"]],
  ['native/libmpv-d3d11-bridge/player_addon.cc', ['SafeTrackSummary', 'track-list/count', 'LILAC_LIBMPV_TEST_AO_NULL'], ['external-filename', 'external-title']]
];
for (const [relative, required, forbidden] of checks) {
  const source = read(relative);
  for (const marker of required) if (!source.includes(marker)) throw new Error(`${relative} missing ${marker}`);
  for (const marker of forbidden) if (source.includes(marker)) throw new Error(`${relative} still contains forbidden ${marker}`);
}

console.log('LIBMPV_R2_RUNTIME_FIXES_OK');

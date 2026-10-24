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

let player = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');

if (!player.includes('napi_value SetUpdateCallback') || !bridge.includes('nativeUpdateCallbackInstalled')) {
  throw new Error('R3C requires R3B callback baseline');
}
if (!bridge.includes('nativeWakePending')) throw new Error('R3C requires R3B pending-wake latch');

// The 250ms renderer state poll needs only HTMLMediaElement-like timing/status.
// Keep codec/track/cache diagnostics in the existing full poll() and provide a
// deliberately small polling surface for routine playback state.
player = replaceOnce(player,
  'napi_value Poll(napi_env env, napi_callback_info info) {',
  `napi_value PollPlayback(napi_env env, napi_callback_info info) {\n  size_t argc = 1;\n  napi_value argv[1];\n  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);\n  uint32_t id = 0;\n  if (argc < 1 || !ReadUint32(env, argv[0], &id)) {\n    Throw(env, "pollPlayback(playerId) requires id");\n    return nullptr;\n  }\n\n  std::lock_guard<std::mutex> lock(gMutex);\n  Player* player = FindPlayer(id);\n  if (!player) {\n    Throw(env, "unknown player id");\n    return nullptr;\n  }\n  DrainEvents(player);\n\n  napi_value out;\n  napi_create_object(env, &out);\n  Set(env, out, "fileLoaded", BoolValue(env, player->fileLoaded));\n  Set(env, out, "eof", BoolValue(env, player->eof));\n  Set(env, out, "lastError", player->lastError.empty() ? NullValue(env) : StringValue(env, player->lastError));\n  Set(env, out, "renderedFrames", DoubleValue(env, static_cast<double>(player->renderedFrames)));\n  Set(env, out, "backpressureDrops", DoubleValue(env, static_cast<double>(player->droppedForBackpressure)));\n  SetMaybeDouble(env, out, "time", player, "time-pos");\n  SetMaybeDouble(env, out, "duration", player, "duration");\n  SetMaybeDouble(env, out, "fps", player, "container-fps");\n  SetMaybeInt64(env, out, "width", player, "width");\n  SetMaybeInt64(env, out, "height", player, "height");\n  SetMaybeFlag(env, out, "paused", player, "pause");\n  SetMaybeFlag(env, out, "pausedForCache", player, "paused-for-cache");\n  return out;\n}\n\nnapi_value Poll(napi_env env, napi_callback_info info) {`,
  'lightweight playback poll');

player = replaceOnce(player,
  '    {"poll", nullptr, Poll, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"setUpdateCallback", nullptr, SetUpdateCallback, nullptr, nullptr, nullptr, napi_default, nullptr},',
  '    {"poll", nullptr, Poll, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"pollPlayback", nullptr, PollPlayback, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"setUpdateCallback", nullptr, SetUpdateCallback, nullptr, nullptr, nullptr, napi_default, nullptr},',
  'export lightweight playback poll');

// RenderFrame must stay on the mpv render API side. Draining the normal client
// event queue here mixes normal libmpv API work into the render hot path and can
// turn a periodic state/property stall into a missed video deadline.
player = replaceOnce(player,
  `  DrainEvents(player);\n  const uint64_t flags = gMpv.render_context_update(player->render);`,
  `  const uint64_t flags = gMpv.render_context_update(player->render);`,
  'remove normal client event drain from renderFrame');

bridge = replaceOnce(bridge,
  "for (const name of ['createPlayer', 'open', 'command', 'poll', 'setUpdateCallback', 'renderFrame', 'releaseFrame', 'destroyPlayer'])",
  "for (const name of ['createPlayer', 'open', 'command', 'poll', 'pollPlayback', 'setUpdateCallback', 'renderFrame', 'releaseFrame', 'destroyPlayer'])",
  'require lightweight playback poll');

// R3B callback is a low-latency wake hint, not the sole clock. Keep the proven
// phase-aware timer armed so callback coalescing or runner/driver peculiarities
// can never reduce source cadence.
bridge = replaceOnce(bridge,
  '    let nextDelay = nativeUpdateCallbackInstalled ? 250 : 4;',
  '    let nextDelay = 4;',
  'restore phase timer default');
bridge = replaceOnce(bridge,
  '        nextDelay = nativeUpdateCallbackInstalled ? 250 : nextActivePumpDelay();',
  '        nextDelay = nextActivePumpDelay();',
  'restore phase timer when no frame');
bridge = replaceOnce(bridge,
  '      nextDelay = nativeUpdateCallbackInstalled ? 250 : nextActivePumpDelay(lastNativeFramePerfAt);',
  '      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);',
  'restore phase timer after frame');

// Do not run the full diagnostic poll from the frame-discovery path. The normal
// 250ms renderer state request below supplies FPS/paused state using pollPlayback.
bridge = replaceOnce(bridge,
  '      refreshPumpTimingState(ownerPlayerId);',
  `      if (!nativeUpdateCallbackInstalled && !pumpExpectedFps) refreshPumpTimingState(ownerPlayerId);`,
  'remove full poll from callback render hot path');

bridge = replaceOnce(bridge,
  '  function state() {',
  '  function state({ fullDiagnostics = false } = {}) {',
  'state mode');
bridge = replaceOnce(bridge,
  '      lastState = addon.poll(playerId);',
  `      lastState = fullDiagnostics ? addon.poll(playerId) : addon.pollPlayback(playerId);\n      const stateFps = Number(lastState?.fps) || Number(lastState?.estimatedVfFps) || 0;\n      if (Number.isFinite(stateFps) && stateFps >= 10 && stateFps <= 240) pumpExpectedFps = stateFps;`,
  'lightweight routine state and cadence cache');
bridge = replaceOnce(bridge,
  `      ...state(),\n      receiverReady: { ...receiverReady },`,
  `      ...state({ fullDiagnostics: true }),\n      receiverReady: { ...receiverReady },`,
  'full diagnostic state only on explicit diagnostic request');

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r3b.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r11') {
  throw new Error(`expected R3B identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r3c.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r12';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R3C-Setup.${ext}';

for (const marker of ['napi_value PollPlayback', 'pollPlayback(playerId)', '"pollPlayback"']) {
  if (!player.includes(marker)) throw new Error(`R3C native marker missing: ${marker}`);
}
if (player.includes('DrainEvents(player);\n  const uint64_t flags = gMpv.render_context_update')) {
  throw new Error('R3C renderFrame still drains normal libmpv events');
}
for (const marker of [
  "fullDiagnostics ? addon.poll(playerId) : addon.pollPlayback(playerId)",
  'state({ fullDiagnostics: true })',
  '!nativeUpdateCallbackInstalled && !pumpExpectedFps',
  'nextDelay = nextActivePumpDelay()',
  'nextDelay = nextActivePumpDelay(lastNativeFramePerfAt)'
]) if (!bridge.includes(marker)) throw new Error(`R3C bridge marker missing: ${marker}`);
if (bridge.includes('nativeUpdateCallbackInstalled ? 250')) throw new Error('R3C callback-only 250ms fallback survived');
if (bridge.includes('await sharedTexture.sendSharedTexture')) throw new Error('R3C regressed decoupled delivery');

write('native/libmpv-d3d11-bridge/player_addon.cc', player);
write('electron/libmpv-shared-main.cjs', bridge);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

console.log('LIBMPV_R3C_OK statePoll=lightweight diagnosticsPoll=explicit renderHotPath=render-api-only wake=callback+phase-timer');

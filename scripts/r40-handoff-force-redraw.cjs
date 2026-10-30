'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');
const assert = (value, message) => { if (!value) throw new Error(message); };

function once(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function between(source, startNeedle, endNeedle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0 || end <= start || source.indexOf(startNeedle, start + startNeedle.length) >= 0) {
    throw new Error(`${label}: structural boundary invalid`);
  }
  return source.slice(0, start) + replacement + source.slice(end + endNeedle.length);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');

for (const marker of [
  'LILAC_R40_CALLBACK_AUTHORITATIVE_PRODUCER',
  'producerWaitingForSlot',
  'producerSignalWakeups',
  'FrameProducerReadyFrame',
  'mpv_render_context_render'
]) assert(native.includes(marker), `R40 handoff redraw requires pacing-native baseline: ${marker}`);
for (const marker of [
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'function r34BeginFocusHandoff()',
  'frameProducerStarted',
  'setNativePresenterMirrorChromium'
]) assert(bridge.includes(marker), `R40 handoff redraw requires R37/R40 bridge baseline: ${marker}`);
if (native.includes('LILAC_R40_HANDOFF_FORCE_REDRAW') || bridge.includes('LILAC_R40_HANDOFF_FORCE_REDRAW')) {
  throw new Error('R40 handoff forced redraw already applied');
}

// libmpv's render API can redraw the previous frame when no new frame is
// available. Keep render-context ownership on the existing producer thread and
// expose only a one-shot wake/request to JS. This replaces R35's old paused
// subtitle visibility toggle without changing playback position or subtitle state.
native = once(
  native,
  '  std::atomic<bool> producerWaitingForSlot{false}; // LILAC_R40_CALLBACK_AUTHORITATIVE_PRODUCER\n',
  `  std::atomic<bool> producerWaitingForSlot{false}; // LILAC_R40_CALLBACK_AUTHORITATIVE_PRODUCER\n  std::atomic<bool> producerForceRedrawPending{false}; // LILAC_R40_HANDOFF_FORCE_REDRAW\n  std::atomic<uint64_t> producerForcedRedrawRequests{0};\n  std::atomic<uint64_t> producerForcedRedrawFrames{0};\n  std::atomic<uint64_t> producerForcedRedrawRequeues{0};\n`,
  'native forced-redraw state'
);

native = once(
  native,
  '  player->producerWaitingForSlot.store(false, std::memory_order_release);\n  player->producerWakePending.store(true, std::memory_order_release);',
  `  player->producerWaitingForSlot.store(false, std::memory_order_release);\n  player->producerForceRedrawPending.store(false, std::memory_order_release);\n  player->producerForcedRedrawRequests.store(0, std::memory_order_release);\n  player->producerForcedRedrawFrames.store(0, std::memory_order_release);\n  player->producerForcedRedrawRequeues.store(0, std::memory_order_release);\n  player->producerWakePending.store(true, std::memory_order_release);`,
  'reset forced-redraw state at producer start'
);

// Stop must invalidate a pending one-shot before the worker exits.
const stopStart = native.indexOf('  void StopFrameProducerWorker() {');
const stopEnd = native.indexOf('\n\n  ~Player()', stopStart);
if (stopStart < 0 || stopEnd <= stopStart) throw new Error('StopFrameProducerWorker boundary missing');
let stopBlock = native.slice(stopStart, stopEnd);
stopBlock = once(
  stopBlock,
  '    producerWakePending.store(false, std::memory_order_release);',
  `    producerWakePending.store(false, std::memory_order_release);\n    producerForceRedrawPending.store(false, std::memory_order_release);`,
  'clear forced-redraw on stop'
);
native = native.slice(0, stopStart) + stopBlock + native.slice(stopEnd);

const updateStartNeedle = '        const auto updateStarted = std::chrono::steady_clock::now();';
const updateEndNeedle = '        if (!(flags & MPV_RENDER_UPDATE_FRAME)) break;';
const updateStart = native.indexOf(updateStartNeedle);
const updateEnd = native.indexOf(updateEndNeedle, updateStart);
if (updateStart < 0 || updateEnd <= updateStart) throw new Error('producer update/render eligibility boundary missing');
const updateBlock = native.slice(updateStart, updateEnd + updateEndNeedle.length);
if (!updateBlock.includes('producerNoFramePolls += 1') || !updateBlock.includes('render_context_update')) {
  throw new Error('producer update block no longer matches R3E/R40 semantics');
}
const forcedUpdateBlock = `        const bool r40ForceRedraw = player->producerForceRedrawPending.exchange(false, std::memory_order_acq_rel);\n        const auto updateStarted = std::chrono::steady_clock::now();\n        const uint64_t flags = gMpv.render_context_update(player->render);\n        const double updateMs = std::chrono::duration<double, std::milli>(\n          std::chrono::steady_clock::now() - updateStarted).count();\n        {\n          std::lock_guard<std::mutex> lock(player->producerMutex);\n          player->producerUpdateTotalMs += updateMs;\n          player->producerUpdateMaxMs = std::max(player->producerUpdateMaxMs, updateMs);\n          if (!(flags & MPV_RENDER_UPDATE_FRAME) && !r40ForceRedraw) player->producerNoFramePolls += 1;\n        }\n        if (!(flags & MPV_RENDER_UPDATE_FRAME) && !r40ForceRedraw) break;`;
native = native.slice(0, updateStart) + forcedUpdateBlock + native.slice(updateEnd + updateEndNeedle.length);

native = once(
  native,
  `          if (!slot) {\n            player->producerBackpressure += 1;\n            player->producerWaitingForSlot.store(true, std::memory_order_release);\n            break;\n          }\n          player->producerWaitingForSlot.store(false, std::memory_order_release);`,
  `          if (!slot) {\n            player->producerBackpressure += 1;\n            player->producerWaitingForSlot.store(true, std::memory_order_release);\n            if (r40ForceRedraw) {\n              player->producerForceRedrawPending.store(true, std::memory_order_release);\n              player->producerForcedRedrawRequeues.fetch_add(1, std::memory_order_relaxed);\n            }\n            break;\n          }\n          player->producerWaitingForSlot.store(false, std::memory_order_release);`,
  'preserve forced redraw across real slot backpressure'
);

// R33 wraps the Chromium queue in a native-only ownership branch, and later
// handoff hardening may insert diagnostics between producedFrames and queueMax.
// Count the completed one-shot at the semantic success point inside the producer
// worker instead of depending on those two statements remaining adjacent.
const producerWorkerStart = native.indexOf('bool StartFrameProducerWorker(');
const producerWorkerEnd = native.indexOf('\nnapi_value StartFrameProducer(', producerWorkerStart);
if (producerWorkerStart < 0 || producerWorkerEnd <= producerWorkerStart) {
  throw new Error('StartFrameProducerWorker structural boundary missing');
}
let producerWorkerBlock = native.slice(producerWorkerStart, producerWorkerEnd);
for (const marker of ['player->producerReady.push_back({', 'player->producerQueueMax = std::max<uint64_t>(']) {
  if (!producerWorkerBlock.includes(marker)) throw new Error(`completed forced redraw frame context missing: ${marker}`);
}
producerWorkerBlock = once(
  producerWorkerBlock,
  '            player->producerProducedFrames += 1;',
  `            player->producerProducedFrames += 1;\n            if (r40ForceRedraw) player->producerForcedRedrawFrames.fetch_add(1, std::memory_order_relaxed);`,
  'count completed forced redraw frame'
);
native = native.slice(0, producerWorkerStart) + producerWorkerBlock + native.slice(producerWorkerEnd);

const redrawApi = String.raw`
napi_value RequestFrameProducerRedraw(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return BoolValue(env, false);
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || !player->render || !player->producerEnabled.load(std::memory_order_acquire)) return BoolValue(env, false);
  player->producerForcedRedrawRequests.fetch_add(1, std::memory_order_relaxed);
  player->producerForceRedrawPending.store(true, std::memory_order_release);
  player->producerWakePending.store(true, std::memory_order_release);
  player->producerCv.notify_one();
  return BoolValue(env, true);
}

`;
native = once(
  native,
  'napi_value FrameProducerStats(napi_env env, napi_callback_info info) {',
  redrawApi + 'napi_value FrameProducerStats(napi_env env, napi_callback_info info) {',
  'insert forced-redraw N-API'
);

native = once(
  native,
  '  Set(env, out, "releaseWakeups", DoubleValue(env, static_cast<double>(player->producerReleaseWakeups)));\n  Set(env, out, "waitingForSlot", BoolValue(env, player->producerWaitingForSlot.load(std::memory_order_acquire)));',
  `  Set(env, out, "releaseWakeups", DoubleValue(env, static_cast<double>(player->producerReleaseWakeups)));\n  Set(env, out, "waitingForSlot", BoolValue(env, player->producerWaitingForSlot.load(std::memory_order_acquire)));\n  Set(env, out, "forcedRedrawPending", BoolValue(env, player->producerForceRedrawPending.load(std::memory_order_acquire)));\n  Set(env, out, "forcedRedrawRequests", DoubleValue(env, static_cast<double>(player->producerForcedRedrawRequests.load(std::memory_order_acquire))));\n  Set(env, out, "forcedRedrawFrames", DoubleValue(env, static_cast<double>(player->producerForcedRedrawFrames.load(std::memory_order_acquire))));\n  Set(env, out, "forcedRedrawRequeues", DoubleValue(env, static_cast<double>(player->producerForcedRedrawRequeues.load(std::memory_order_acquire))));`,
  'export forced-redraw producer diagnostics'
);

native = once(
  native,
  '    {"frameProducerStats", nullptr, FrameProducerStats, nullptr, nullptr, nullptr, napi_default, nullptr},',
  `    {"requestFrameProducerRedraw", nullptr, RequestFrameProducerRedraw, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"frameProducerStats", nullptr, FrameProducerStats, nullptr, nullptr, nullptr, napi_default, nullptr},`,
  'export forced-redraw N-API method'
);

// Require the new native API in the bridge's existing producer method list.
const producerMethodsAnchor = "'releaseProducedFrame', 'frameProducerStats'";
bridge = once(
  bridge,
  producerMethodsAnchor,
  "'releaseProducedFrame', 'requestFrameProducerRedraw', 'frameProducerStats'",
  'require forced-redraw bridge API'
);

bridge = once(
  bridge,
  '  let nativeWakePendingFrameId = 0; // LILAC_R40_FRESH_FRAME_WAKE_GATING\n  let frameProducerStarted = false;',
  `  let nativeWakePendingFrameId = 0; // LILAC_R40_FRESH_FRAME_WAKE_GATING\n  let frameProducerStarted = false;\n  let r40HandoffRedrawRequests = 0; // LILAC_R40_HANDOFF_FORCE_REDRAW\n  let r40HandoffRedrawAccepted = 0;`,
  'bridge forced-redraw diagnostics state'
);

const handoffStart = bridge.indexOf('  function r34BeginFocusHandoff() {');
const handoffEnd = bridge.indexOf('\n\n  function r34CompleteFocusHandoff(', handoffStart);
if (handoffStart < 0 || handoffEnd <= handoffStart) throw new Error('R34 begin handoff boundary missing');
let handoffBlock = bridge.slice(handoffStart, handoffEnd);
// R36 hardened the R34 arm into an explicit `armed` result before R37 added the
// epoch. Attach the one-shot request inside that existing success branch so the
// fail-open timer and all R37 ownership semantics remain unchanged.
handoffBlock = once(
  handoffBlock,
  `      if (armed) {\n        r36ArmHandoffFailOpen();\n        return true;\n      }`,
  `      if (armed) {\n        if (frameProducerStarted && typeof addon.requestFrameProducerRedraw === 'function') {\n          r40HandoffRedrawRequests += 1;\n          try {\n            if (addon.requestFrameProducerRedraw(playerId) === true) r40HandoffRedrawAccepted += 1;\n          } catch (redrawError) {\n            lastError = 'R40 handoff redraw request failed: ' + String(redrawError?.message || redrawError).slice(0, 180);\n          }\n        }\n        r36ArmHandoffFailOpen();\n        return true;\n      }`,
  'request one-shot redraw after handoff mirror arm'
);
bridge = bridge.slice(0, handoffStart) + handoffBlock + bridge.slice(handoffEnd);

bridge = once(
  bridge,
  '            regionNativeClears: r37PresenterRegionNativeClears\n',
  `            regionNativeClears: r37PresenterRegionNativeClears,\n            r40HandoffRedrawRequests,\n            r40HandoffRedrawAccepted\n`,
  'bridge handoff redraw diagnostics export'
);

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);

const finalNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
const finalBridge = read('electron/libmpv-shared-main.cjs');
for (const marker of [
  'LILAC_R40_HANDOFF_FORCE_REDRAW',
  'producerForceRedrawPending',
  'producerForcedRedrawRequests',
  'producerForcedRedrawFrames',
  'RequestFrameProducerRedraw',
  'requestFrameProducerRedraw'
]) assert(finalNative.includes(marker), `R40 forced-redraw native marker missing: ${marker}`);
for (const marker of [
  'LILAC_R40_HANDOFF_FORCE_REDRAW',
  'requestFrameProducerRedraw',
  'r40HandoffRedrawRequests',
  'r40HandoffRedrawAccepted'
]) assert(finalBridge.includes(marker), `R40 forced-redraw bridge marker missing: ${marker}`);

console.log('R40_HANDOFF_FORCE_REDRAW_OK trigger=R37-handoff oneShot=native-producer-thread currentFrame=libmpv-render-redraw playbackPosition=unchanged nativeSubtitle=unchanged backpressure=requeue');

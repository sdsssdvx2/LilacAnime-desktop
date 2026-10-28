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
function replaceFunction(source, marker, nextMarker, replacement, label) {
  const start = source.indexOf(marker);
  const end = source.indexOf(nextMarker, start + marker.length);
  if (start < 0 || end <= start || source.indexOf(marker, start + marker.length) >= 0) throw new Error(`${label}: function boundary invalid`);
  return source.slice(0, start) + replacement + source.slice(end);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');

for (const marker of ['LILAC_R33_NATIVE_ONLY_UNFOCUSED', 'LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC', 'FrameProducerReadyFrame', 'producerWakePending', 'producerNoFramePolls']) {
  assert(native.includes(marker), `R40 requires R39 native baseline: ${marker}`);
}
for (const marker of ['LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN', 'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK', 'LILAC_R39_REFOCUS_FORCE_WAKE', 'wakePumpFromNative', 'nativeWakePending']) {
  assert(bridge.includes(marker), `R40 requires R39 bridge baseline: ${marker}`);
}
assert(!native.includes('LILAC_R40_CALLBACK_AUTHORITATIVE_PRODUCER'), 'R40 native pacing already applied');
assert(!bridge.includes('LILAC_R40_FRESH_FRAME_WAKE_GATING'), 'R40 bridge pacing already applied');

// ---------------------------------------------------------------------------
// Native producer: raw mpv render callbacks are authoritative. R39 hardware
// diagnostics showed 4022 worker wakeups for 2281 raw callbacks / 1701 frames.
// releaseProducedFrame() woke the producer for every returned slot even when 23+
// slots were already free, and the worker also woke every 6 ms as a polling
// watchdog. Wake on slot release only if producer backpressure actually found no
// free slot; otherwise wait for a real render callback. Keep a 250 ms recovery
// watchdog so a lost callback cannot freeze playback.
// ---------------------------------------------------------------------------
native = once(native,
  '  std::atomic<bool> producerStop{false};\n  uint32_t producerWidth = 0;',
  `  std::atomic<bool> producerStop{false};\n  std::atomic<bool> producerWaitingForSlot{false}; // LILAC_R40_CALLBACK_AUTHORITATIVE_PRODUCER\n  uint32_t producerWidth = 0;`,
  'producer slot-wait state');
native = once(native,
  '  uint64_t producerWakeups = 0;\n  uint64_t producerRenderCalls = 0;',
  `  uint64_t producerWakeups = 0;\n  uint64_t producerSignalWakeups = 0;\n  uint64_t producerWatchdogWakeups = 0;\n  uint64_t producerReleaseWakeups = 0;\n  uint64_t producerRenderCalls = 0;`,
  'producer wake diagnostics');
native = once(native,
  '    player->producerWakeups = 0;\n    player->producerRenderCalls = 0;',
  `    player->producerWakeups = 0;\n    player->producerSignalWakeups = 0;\n    player->producerWatchdogWakeups = 0;\n    player->producerReleaseWakeups = 0;\n    player->producerRenderCalls = 0;`,
  'reset producer wake diagnostics');
native = once(native,
  '  player->producerStop.store(false, std::memory_order_release);\n  player->producerWakePending.store(true, std::memory_order_release);',
  `  player->producerStop.store(false, std::memory_order_release);\n  player->producerWaitingForSlot.store(false, std::memory_order_release);\n  player->producerWakePending.store(true, std::memory_order_release);`,
  'reset producer slot wait');

const oldWait = `        player->producerCv.wait_for(lock, std::chrono::milliseconds(6), [player]() {\n          return player->producerStop.load(std::memory_order_acquire) ||\n            player->producerWakePending.load(std::memory_order_acquire);\n        });\n        if (player->producerStop.load(std::memory_order_acquire)) break;\n        player->producerWakePending.store(false, std::memory_order_release);\n        player->producerWakeups += 1;`;
const newWait = `        const bool r40Signaled = player->producerCv.wait_for(\n          lock, std::chrono::milliseconds(250), [player]() {\n            return player->producerStop.load(std::memory_order_acquire) ||\n              player->producerWakePending.load(std::memory_order_acquire);\n          });\n        if (player->producerStop.load(std::memory_order_acquire)) break;\n        const bool r40HadPending = player->producerWakePending.exchange(false, std::memory_order_acq_rel);\n        player->producerWakeups += 1;\n        if (r40Signaled && r40HadPending) player->producerSignalWakeups += 1;\n        else player->producerWatchdogWakeups += 1;`;
native = once(native, oldWait, newWait, 'replace 6ms producer poll with callback+250ms watchdog');

native = once(native,
  `          if (!slot) {\n            player->producerBackpressure += 1;\n            break;\n          }`,
  `          if (!slot) {\n            player->producerBackpressure += 1;\n            player->producerWaitingForSlot.store(true, std::memory_order_release);\n            break;\n          }\n          player->producerWaitingForSlot.store(false, std::memory_order_release);`,
  'mark actual slot backpressure');

const oldReleaseWake = `  player->producerWakePending.store(true, std::memory_order_release);\n  player->producerCv.notify_one();\n  return BoolValue(env, true);`;
const releaseWakeMatches = native.split(oldReleaseWake).length - 1;
if (releaseWakeMatches < 1) throw new Error('producer release wake anchor missing');
// Apply only inside ReleaseProducedFrame; resize intentionally still wakes.
const releaseStart = native.indexOf('napi_value ReleaseProducedFrame(');
const releaseEnd = native.indexOf('napi_value FrameProducerStats(', releaseStart);
if (releaseStart < 0 || releaseEnd <= releaseStart) throw new Error('ReleaseProducedFrame boundary missing');
let releaseBlock = native.slice(releaseStart, releaseEnd);
releaseBlock = once(releaseBlock, oldReleaseWake,
  `  if (player->producerWaitingForSlot.exchange(false, std::memory_order_acq_rel)) {\n    player->producerReleaseWakeups += 1;\n    player->producerWakePending.store(true, std::memory_order_release);\n    player->producerCv.notify_one();\n  }\n  return BoolValue(env, true);`,
  'wake producer on release only after backpressure');
native = native.slice(0, releaseStart) + releaseBlock + native.slice(releaseEnd);

// Carry the exact queued frame id through the TSFN. This lets main-process JS
// reject a callback that arrives after a watchdog already drained that frame.
native = once(native,
  `void CallUpdateJs(napi_env env, napi_value jsCallback, void*, void*) {\n  if (!env || !jsCallback) return;\n  napi_value undefined;\n  if (napi_get_undefined(env, &undefined) != napi_ok) return;\n  napi_call_function(env, undefined, jsCallback, 0, nullptr, nullptr);\n}`,
  `void CallUpdateJs(napi_env env, napi_value jsCallback, void*, void* data) {\n  std::unique_ptr<uint64_t> r40FrameId(static_cast<uint64_t*>(data));\n  if (!env || !jsCallback) return;\n  napi_value undefined;\n  if (napi_get_undefined(env, &undefined) != napi_ok) return;\n  if (r40FrameId) {\n    napi_value arg;\n    if (napi_create_double(env, static_cast<double>(*r40FrameId), &arg) == napi_ok) {\n      napi_call_function(env, undefined, jsCallback, 1, &arg, nullptr);\n      return;\n    }\n  }\n  napi_call_function(env, undefined, jsCallback, 0, nullptr, nullptr);\n}`,
  'TSFN frame-id payload');

const oldProducerSignal = `            const napi_status status = napi_call_threadsafe_function(tsfn, nullptr, napi_tsfn_nonblocking);\n            if (status == napi_ok) player->producerJsSignals.fetch_add(1, std::memory_order_relaxed);`;
const newProducerSignal = `            auto* r40SignalFrameId = new uint64_t(reservedFrameId);\n            const napi_status status = napi_call_threadsafe_function(tsfn, r40SignalFrameId, napi_tsfn_nonblocking);\n            if (status == napi_ok) {\n              player->producerJsSignals.fetch_add(1, std::memory_order_relaxed);\n            } else {\n              delete r40SignalFrameId;\n            }`;
native = once(native, oldProducerSignal, newProducerSignal, 'producer TSFN frame-id signal');

native = once(native,
  '  Set(env, out, "workerWakeups", DoubleValue(env, static_cast<double>(player->producerWakeups)));\n  Set(env, out, "renderCalls", DoubleValue(env, static_cast<double>(player->producerRenderCalls)));',
  `  Set(env, out, "workerWakeups", DoubleValue(env, static_cast<double>(player->producerWakeups)));\n  Set(env, out, "signalWakeups", DoubleValue(env, static_cast<double>(player->producerSignalWakeups)));\n  Set(env, out, "watchdogWakeups", DoubleValue(env, static_cast<double>(player->producerWatchdogWakeups)));\n  Set(env, out, "releaseWakeups", DoubleValue(env, static_cast<double>(player->producerReleaseWakeups)));\n  Set(env, out, "waitingForSlot", BoolValue(env, player->producerWaitingForSlot.load(std::memory_order_acquire)));\n  Set(env, out, "renderCalls", DoubleValue(env, static_cast<double>(player->producerRenderCalls)));`,
  'producer wake diagnostics export');

// ---------------------------------------------------------------------------
// JS drain: a watchdog can beat the queued frame's TSFN to the event loop. R3B's
// boolean pending wake then pumps the same already-drained frame a second time and
// records an empty poll. Gate callbacks with their frame id and only retain a
// pending wake if it names a frame newer than the newest frame already drained.
// Also tag every pump by reason so the next diagnostic can prove which path is
// empty instead of inferring it from aggregate counters.
// ---------------------------------------------------------------------------
bridge = once(bridge,
  '  let nativeWakePending = false;\n  let frameProducerStarted = false;',
  `  let nativeWakePending = false;\n  let nativeWakePendingFrameId = 0; // LILAC_R40_FRESH_FRAME_WAKE_GATING\n  let frameProducerStarted = false;`,
  'pending frame id state');
bridge = once(bridge,
  '    nativeUpdateSignals: 0,\n    nativeUpdateWakeups: 0,',
  `    nativeUpdateSignals: 0,\n    nativeUpdateWakeups: 0,\n    r40FreshFrameSignals: 0,\n    r40StaleFrameSignals: 0,\n    r40SignalFrameIdMax: 0,\n    r40PumpTimerTicks: 0,\n    r40PumpNativeSignalTicks: 0,\n    r40PumpPendingSignalTicks: 0,\n    r40PumpOtherTicks: 0,\n    r40NoFrameTimerTicks: 0,\n    r40NoFrameNativeSignalTicks: 0,\n    r40NoFramePendingSignalTicks: 0,`,
  'R40 JS wake metrics');

const wakeReplacement = `  function wakePumpFromNative(signaledFrameId = 0) {\n    metrics.nativeUpdateSignals += 1;\n    const signalFrameId = Math.max(0, Number(signaledFrameId) || 0);\n    if (signalFrameId > 0) {\n      metrics.r40SignalFrameIdMax = Math.max(metrics.r40SignalFrameIdMax, signalFrameId);\n      if (signalFrameId <= Number(metrics.lastFrameId || 0)) {\n        metrics.r40StaleFrameSignals += 1;\n        return;\n      }\n      metrics.r40FreshFrameSignals += 1;\n    }\n    if (!active || disposed || !addon || playerId == null) return;\n    if (pumpTimer) {\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n      pumpTimerDuePerfAt = 0;\n    }\n    if (pumpRunning) {\n      nativeWakePending = true;\n      nativeWakePendingFrameId = Math.max(nativeWakePendingFrameId, signalFrameId);\n      return;\n    }\n    nativeWakePending = false;\n    nativeWakePendingFrameId = 0;\n    metrics.nativeUpdateWakeups += 1;\n    void pump('native-signal');\n  }\n\n`;
bridge = replaceFunction(bridge, '  function wakePumpFromNative() {', '  function schedulePump(', wakeReplacement, 'fresh-frame wake function');

// Tag timer-driven drains. Only the schedulePump body is changed.
const scheduleStart = bridge.indexOf('  function schedulePump(');
const scheduleEnd = bridge.indexOf('\n\n  function ', scheduleStart + 1);
if (scheduleStart < 0 || scheduleEnd <= scheduleStart) throw new Error('schedulePump boundary missing');
let scheduleBlock = bridge.slice(scheduleStart, scheduleEnd);
scheduleBlock = once(scheduleBlock, '      void pump();', "      void pump('timer');", 'tag timer pump');
bridge = bridge.slice(0, scheduleStart) + scheduleBlock + bridge.slice(scheduleEnd);

bridge = once(bridge, '  async function pump() {', "  async function pump(reason = 'other') {", 'pump reason argument');
bridge = once(bridge,
  '    pumpRunning = true;\n    const ownerPlayerId = playerId;',
  `    pumpRunning = true;\n    const r40PumpReason = String(reason || 'other');\n    if (r40PumpReason === 'timer') metrics.r40PumpTimerTicks += 1;\n    else if (r40PumpReason === 'native-signal') metrics.r40PumpNativeSignalTicks += 1;\n    else if (r40PumpReason === 'pending-signal') metrics.r40PumpPendingSignalTicks += 1;\n    else metrics.r40PumpOtherTicks += 1;\n    const ownerPlayerId = playerId;`,
  'count pump reasons');
bridge = once(bridge,
  '      if (!nativeFrame?.updated) {\n        metrics.noFramePolls += 1;',
  `      if (!nativeFrame?.updated) {\n        metrics.noFramePolls += 1;\n        if (r40PumpReason === 'timer') metrics.r40NoFrameTimerTicks += 1;\n        else if (r40PumpReason === 'native-signal') metrics.r40NoFrameNativeSignalTicks += 1;\n        else if (r40PumpReason === 'pending-signal') metrics.r40NoFramePendingSignalTicks += 1;`,
  'count empty pumps by reason');

const oldFinally = `        if (nativeUpdateCallbackInstalled && nativeWakePending) {\n          nativeWakePending = false;\n          metrics.nativeUpdateWakeups += 1;\n          void pump();\n        } else {\n          schedulePump(nextDelay);\n        }`;
const newFinally = `        if (nativeUpdateCallbackInstalled && nativeWakePending &&\n            (nativeWakePendingFrameId <= 0 || nativeWakePendingFrameId > Number(metrics.lastFrameId || 0))) {\n          nativeWakePending = false;\n          nativeWakePendingFrameId = 0;\n          metrics.nativeUpdateWakeups += 1;\n          void pump('pending-signal');\n        } else {\n          nativeWakePending = false;\n          nativeWakePendingFrameId = 0;\n          schedulePump(nextDelay);\n        }`;
bridge = once(bridge, oldFinally, newFinally, 'drop stale pending callback wake');

bridge = once(bridge,
  '    generation += 1;\n    nativeWakePending = false;\n    lastNativeFramePerfAt = 0;',
  `    generation += 1;\n    nativeWakePending = false;\n    nativeWakePendingFrameId = 0;\n    lastNativeFramePerfAt = 0;`,
  'reset pending signal id on source change');

for (const marker of [
  'LILAC_R40_CALLBACK_AUTHORITATIVE_PRODUCER', 'producerWaitingForSlot', 'producerSignalWakeups',
  'producerWatchdogWakeups', 'producerReleaseWakeups', 'std::chrono::milliseconds(250)',
  'r40SignalFrameId', 'signalWakeups', 'watchdogWakeups', 'releaseWakeups'
]) assert(native.includes(marker), `R40 native marker missing: ${marker}`);
for (const marker of [
  'LILAC_R40_FRESH_FRAME_WAKE_GATING', 'nativeWakePendingFrameId', 'r40FreshFrameSignals',
  'r40StaleFrameSignals', "pump('native-signal')", "pump('pending-signal')", "pump('timer')",
  'r40NoFrameTimerTicks'
]) assert(bridge.includes(marker), `R40 bridge marker missing: ${marker}`);
assert(!native.includes('std::chrono::milliseconds(6)'), 'R40 6ms producer polling survived');
assert(bridge.includes('R30_PRODUCER_JS_WATCHDOG_MS = 250'), 'R40 lost R30 JS watchdog');
assert(bridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX'), 'R40 lost R24 serial-latest mailbox');
assert(bridge.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK'), 'R40 lost R37 explicit handoff');
assert(!bridge.includes('focus-staged-gpu-copy') && !bridge.includes('copyTextureToTexture'), 'R40 resurrected forbidden staged WebGPU path');

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
console.log('R40_CALLBACK_PACING_OK native=raw-callback+250ms-watchdog releaseWake=backpressure-only js=frame-id-fresh-gated pumpReasons=instrumented r24=preserved r30=newest-only r37=preserved');

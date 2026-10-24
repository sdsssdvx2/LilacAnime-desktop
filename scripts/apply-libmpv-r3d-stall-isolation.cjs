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

if (!player.includes('napi_value PollPlayback') || !player.includes('mpv_render_context_set_update_callback')) {
  throw new Error('R3D requires the complete R3C native baseline');
}
if (!bridge.includes('nativeWakePending') || !bridge.includes('nextNativeFrameDeadlinePerfAt')) {
  throw new Error('R3D requires the complete R3C callback + absolute-phase bridge baseline');
}
if (bridge.includes('nativeUpdateCallbackInstalled ? 250')) {
  throw new Error('R3D refuses the obsolete callback-only 250ms fallback');
}

// Attribute synchronous native time precisely. The outer JS pumpRender metric tells
// us that addon.renderFrame() occupied ~245ms on user hardware, but not whether
// mpv_render_context_update(), target texture preparation, or the actual D3D11
// render call consumed it. Return per-call timings directly with the frame result.
player = replaceOnce(player,
  `  const uint64_t flags = gMpv.render_context_update(player->render);\n\n  napi_value out;\n  napi_create_object(env, &out);`,
  `  const auto updateStarted = std::chrono::steady_clock::now();\n  const uint64_t flags = gMpv.render_context_update(player->render);\n  const double nativeUpdateMs = std::chrono::duration<double, std::milli>(\n    std::chrono::steady_clock::now() - updateStarted).count();\n\n  napi_value out;\n  napi_create_object(env, &out);\n  Set(env, out, "nativeUpdateMs", DoubleValue(env, nativeUpdateMs));`,
  'native render-context update timing');

player = replaceOnce(player,
  `  std::string error;\n  if (!EnsureTexture(player, slot, width, height, &error)) {`,
  `  std::string error;\n  const auto ensureTextureStarted = std::chrono::steady_clock::now();\n  const bool textureReady = EnsureTexture(player, slot, width, height, &error);\n  const double nativeEnsureTextureMs = std::chrono::duration<double, std::milli>(\n    std::chrono::steady_clock::now() - ensureTextureStarted).count();\n  Set(env, out, "nativeEnsureTextureMs", DoubleValue(env, nativeEnsureTextureMs));\n  if (!textureReady) {`,
  'native target texture timing');

player = replaceOnce(player,
  `  int rc = gMpv.render_context_render(player->render, params);\n  if (rc < 0) {`,
  `  const auto renderStarted = std::chrono::steady_clock::now();\n  int rc = gMpv.render_context_render(player->render, params);\n  const double nativeRenderMs = std::chrono::duration<double, std::milli>(\n    std::chrono::steady_clock::now() - renderStarted).count();\n  Set(env, out, "nativeRenderMs", DoubleValue(env, nativeRenderMs));\n  if (rc < 0) {`,
  'native D3D11 render timing');

// Keep callback wakeups authoritative for low latency, but stop hammering
// render_context_update every 2ms indefinitely when a frame is not ready exactly
// at the predicted deadline. Three 2ms retries preserve a tight deadline window;
// after that, a 6ms watchdog remains armed until the next callback/frame. This is
// still far below the previous 16ms fixed poll and never becomes callback-only.
bridge = replaceOnce(bridge,
  `  let nativeUpdateCallbackInstalled = false;\n  let nativeWakePending = false;\n  const MAX_PENDING_DELIVERY_FRAMES = 12;`,
  `  let nativeUpdateCallbackInstalled = false;\n  let nativeWakePending = false;\n  let noFrameBurstCount = 0;\n  const NO_FRAME_BURST_RETRIES = 3;\n  const NO_FRAME_BACKOFF_MS = 6;\n  const MAX_PENDING_DELIVERY_FRAMES = 12;`,
  'bounded no-frame retry state');

const oldDelay = `  function nextActivePumpDelay(now = performance.now()) {\n    if (lastState?.paused) return 50;\n    const interval = expectedSourceFrameIntervalMs();\n    if (!interval || !nextNativeFrameDeadlinePerfAt) return 4;\n    const untilLead = (nextNativeFrameDeadlinePerfAt - ACTIVE_PUMP_LEAD_MS) - now;\n    if (untilLead > ACTIVE_PUMP_RETRY_MS) {\n      return Math.max(ACTIVE_PUMP_RETRY_MS, Math.min(32, Math.floor(untilLead)));\n    }\n    return ACTIVE_PUMP_RETRY_MS;\n  }`;
const newDelay = `  function nextActivePumpDelay(now = performance.now(), noFrame = false) {\n    if (lastState?.paused) return 50;\n    const interval = expectedSourceFrameIntervalMs();\n    if (!interval || !nextNativeFrameDeadlinePerfAt) return noFrame ? NO_FRAME_BACKOFF_MS : 4;\n    const untilLead = (nextNativeFrameDeadlinePerfAt - ACTIVE_PUMP_LEAD_MS) - now;\n    if (untilLead > ACTIVE_PUMP_RETRY_MS) {\n      if (noFrame) noFrameBurstCount = 0;\n      return Math.max(ACTIVE_PUMP_RETRY_MS, Math.min(32, Math.floor(untilLead)));\n    }\n    if (!noFrame) return ACTIVE_PUMP_RETRY_MS;\n    noFrameBurstCount += 1;\n    return noFrameBurstCount <= NO_FRAME_BURST_RETRIES ? ACTIVE_PUMP_RETRY_MS : NO_FRAME_BACKOFF_MS;\n  }`;
bridge = replaceOnce(bridge, oldDelay, newDelay, 'bounded phase retry scheduler');

bridge = replaceOnce(bridge,
  `  function wakePumpFromNative() {\n    metrics.nativeUpdateSignals += 1;`,
  `  function wakePumpFromNative() {\n    metrics.nativeUpdateSignals += 1;\n    noFrameBurstCount = 0;`,
  'callback resets no-frame backoff');

bridge = replaceOnce(bridge,
  `    pumpPhaseCatchupPeriods: 0,\n    pumpPhaseLateMaxMs: 0,\n    nativeUpdateSignals: 0,\n    nativeUpdateWakeups: 0\n  };`,
  `    pumpPhaseCatchupPeriods: 0,\n    pumpPhaseLateMaxMs: 0,\n    nativeUpdateSignals: 0,\n    nativeUpdateWakeups: 0,\n    nativeUpdateTimingSamples: 0,\n    nativeUpdateTimingTotalMs: 0,\n    nativeUpdateTimingMaxMs: 0,\n    nativeEnsureTextureSamples: 0,\n    nativeEnsureTextureTotalMs: 0,\n    nativeEnsureTextureMaxMs: 0,\n    nativeRenderSamples: 0,\n    nativeRenderTotalMs: 0,\n    nativeRenderMaxMs: 0,\n    noFramePolls: 0,\n    updatedFramePolls: 0,\n    statePollPlaybackSamples: 0,\n    statePollPlaybackTotalMs: 0,\n    statePollPlaybackMaxMs: 0,\n    fullDiagnosticsPollSamples: 0,\n    fullDiagnosticsPollTotalMs: 0,\n    fullDiagnosticsPollMaxMs: 0\n  };`,
  'R3D stall attribution metrics');

bridge = replaceOnce(bridge,
  `      avgPumpRenderMs: metrics.pumpRenderSamples > 0\n        ? Math.round((metrics.pumpRenderTotalMs / metrics.pumpRenderSamples) * 1000) / 1000\n        : 0,\n      deliveryInFlight,\n      nativeCadence`,
  `      avgPumpRenderMs: metrics.pumpRenderSamples > 0\n        ? Math.round((metrics.pumpRenderTotalMs / metrics.pumpRenderSamples) * 1000) / 1000\n        : 0,\n      avgNativeUpdateMs: metrics.nativeUpdateTimingSamples > 0\n        ? Math.round((metrics.nativeUpdateTimingTotalMs / metrics.nativeUpdateTimingSamples) * 1000) / 1000\n        : 0,\n      avgNativeEnsureTextureMs: metrics.nativeEnsureTextureSamples > 0\n        ? Math.round((metrics.nativeEnsureTextureTotalMs / metrics.nativeEnsureTextureSamples) * 1000) / 1000\n        : 0,\n      avgNativeRenderMs: metrics.nativeRenderSamples > 0\n        ? Math.round((metrics.nativeRenderTotalMs / metrics.nativeRenderSamples) * 1000) / 1000\n        : 0,\n      avgStatePollPlaybackMs: metrics.statePollPlaybackSamples > 0\n        ? Math.round((metrics.statePollPlaybackTotalMs / metrics.statePollPlaybackSamples) * 1000) / 1000\n        : 0,\n      avgFullDiagnosticsPollMs: metrics.fullDiagnosticsPollSamples > 0\n        ? Math.round((metrics.fullDiagnosticsPollTotalMs / metrics.fullDiagnosticsPollSamples) * 1000) / 1000\n        : 0,\n      deliveryInFlight,\n      nativeCadence`,
  'R3D derived stall attribution metrics');

const timingRecorder = `      const nativeUpdateMs = Number(nativeFrame?.nativeUpdateMs);\n      if (Number.isFinite(nativeUpdateMs) && nativeUpdateMs >= 0) {\n        metrics.nativeUpdateTimingSamples += 1;\n        metrics.nativeUpdateTimingTotalMs += nativeUpdateMs;\n        metrics.nativeUpdateTimingMaxMs = Math.max(metrics.nativeUpdateTimingMaxMs, nativeUpdateMs);\n      }\n      const nativeEnsureTextureMs = Number(nativeFrame?.nativeEnsureTextureMs);\n      if (Number.isFinite(nativeEnsureTextureMs) && nativeEnsureTextureMs >= 0) {\n        metrics.nativeEnsureTextureSamples += 1;\n        metrics.nativeEnsureTextureTotalMs += nativeEnsureTextureMs;\n        metrics.nativeEnsureTextureMaxMs = Math.max(metrics.nativeEnsureTextureMaxMs, nativeEnsureTextureMs);\n      }\n      const nativeRenderMs = Number(nativeFrame?.nativeRenderMs);\n      if (Number.isFinite(nativeRenderMs) && nativeRenderMs >= 0) {\n        metrics.nativeRenderSamples += 1;\n        metrics.nativeRenderTotalMs += nativeRenderMs;\n        metrics.nativeRenderMaxMs = Math.max(metrics.nativeRenderMaxMs, nativeRenderMs);\n      }\n`;
bridge = replaceOnce(bridge,
  `      if (!nativeFrame?.updated) {`,
  `${timingRecorder}      if (!nativeFrame?.updated) {`,
  'insert native stage timing recorder');
bridge = replaceOnce(bridge,
  `      if (!nativeFrame?.updated) {\n        nextDelay = nextActivePumpDelay();\n        return;\n      }`,
  `      if (!nativeFrame?.updated) {\n        metrics.noFramePolls += 1;\n        nextDelay = nextActivePumpDelay(performance.now(), true);\n        return;\n      }`,
  'bounded no-frame retry path');
bridge = replaceOnce(bridge,
  `      metrics.nativeFrames += 1;\n      lastNativeFramePerfAt = performance.now();`,
  `      noFrameBurstCount = 0;\n      metrics.updatedFramePolls += 1;\n      metrics.nativeFrames += 1;\n      lastNativeFramePerfAt = performance.now();`,
  'reset retry burst on discovered frame');

bridge = replaceOnce(bridge,
  `      lastState = fullDiagnostics ? addon.poll(playerId) : addon.pollPlayback(playerId);\n      const stateFps = Number(lastState?.fps) || Number(lastState?.estimatedVfFps) || 0;`,
  `      const stateStarted = performance.now();\n      lastState = fullDiagnostics ? addon.poll(playerId) : addon.pollPlayback(playerId);\n      const stateElapsed = Math.max(0, performance.now() - stateStarted);\n      if (fullDiagnostics) {\n        metrics.fullDiagnosticsPollSamples += 1;\n        metrics.fullDiagnosticsPollTotalMs += stateElapsed;\n        metrics.fullDiagnosticsPollMaxMs = Math.max(metrics.fullDiagnosticsPollMaxMs, stateElapsed);\n      } else {\n        metrics.statePollPlaybackSamples += 1;\n        metrics.statePollPlaybackTotalMs += stateElapsed;\n        metrics.statePollPlaybackMaxMs = Math.max(metrics.statePollPlaybackMaxMs, stateElapsed);\n      }\n      const stateFps = Number(lastState?.fps) || Number(lastState?.estimatedVfFps) || 0;`,
  'measure state polling outside the render pump');

bridge = replaceOnce(bridge,
  `    generation += 1;\n    nativeWakePending = false;\n    lastNativeFramePerfAt = 0;`,
  `    generation += 1;\n    nativeWakePending = false;\n    noFrameBurstCount = 0;\n    lastNativeFramePerfAt = 0;`,
  'reset R3D retry state for a new source');

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r3c.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r12') {
  throw new Error(`expected R3C identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r3d.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r13';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R3D-Setup.${ext}';

for (const marker of [
  'nativeUpdateMs',
  'nativeEnsureTextureMs',
  'nativeRenderMs'
]) if (!player.includes(marker)) throw new Error(`R3D native timing marker missing: ${marker}`);
for (const marker of [
  'NO_FRAME_BURST_RETRIES = 3',
  'NO_FRAME_BACKOFF_MS = 6',
  'nextActivePumpDelay(performance.now(), true)',
  'nativeUpdateTimingMaxMs',
  'nativeEnsureTextureMaxMs',
  'nativeRenderMaxMs',
  'statePollPlaybackMaxMs',
  'fullDiagnosticsPollMaxMs',
  'noFramePolls',
  'updatedFramePolls'
]) if (!bridge.includes(marker)) throw new Error(`R3D bridge marker missing: ${marker}`);
if (bridge.includes('nativeUpdateCallbackInstalled ? 250')) throw new Error('R3D regressed callback-only fallback');
if (bridge.includes('await sharedTexture.sendSharedTexture')) throw new Error('R3D regressed producer/transport decoupling');

write('native/libmpv-d3d11-bridge/player_addon.cc', player);
write('electron/libmpv-shared-main.cjs', bridge);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

console.log('LIBMPV_R3D_OK timing=update,texture,render,state polling=bounded-deadline-burst callback=immediate fallbackMaxMs=6');

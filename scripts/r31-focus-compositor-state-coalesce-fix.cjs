'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');
let preload = read('electron/libmpv-shared-preload.cjs');
let renderer = read('src/libmpv-shared-entry.js');

if (!bridge.includes('LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN')) throw new Error('R31 requires R30 producer drain baseline');
if (!bridge.includes('LILAC_R27_FOCUS_STALL_RETENTION') || !preload.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R31 requires R27 focus diagnostics');
if (!preload.includes("presentationMode = 'direct-receive-webgpu-copy'")) throw new Error('R31 requires direct WebGPU focused path');
if (!preload.includes('copyExternalImageToTexture')) throw new Error('R31 requires direct WebGPU copy');
if (!preload.includes('importedSharedTexture?.release')) throw new Error('R31 requires managed SharedTextureImported.release');
if (!renderer.includes('_pollTimer ||= setInterval(() => void this._pollState(), 250);')) throw new Error('R31 requires 250ms renderer state cadence baseline');
if (bridge.includes('LILAC_R31_STATE_COALESCE') || preload.includes('LILAC_R31_FOCUS_COMPOSITOR_SHIELD') || renderer.includes('LILAC_R31_STATE_CLOCK')) throw new Error('R31 already applied');
for (const forbidden of ['LILAC_R28_FOCUS_SAFE_PLAYBACK', 'r28FocusStagingTexture', 'focus-staged-gpu-copy', 'copyTextureToTexture', 'LILAC_R29_GPU_SAFE_LIFETIME', 'r29GpuSafeReleaseCallbacks', 'importedSharedTexture?.subtle?.release']) {
  if (preload.includes(forbidden)) throw new Error(`R31 refuses failed renderer path: ${forbidden}`);
}

// ---------------------------------------------------------------------------
// 1) Main-process state polling: keep the 250ms renderer/UI cadence, but stop
// synchronously entering libmpv on every tick. R30 hardware evidence recorded a
// 127ms pollPlayback() call, and any such synchronous call blocks JS frame drain.
// Cache native playback state for 1s; renderer extrapolates currentTime from the
// sample wall clock so subtitles/progress remain smooth at their existing cadence.
// ---------------------------------------------------------------------------
bridge = replaceOnce(
  bridge,
  `  let r30ProducerBacklogDropped = 0;\n  let noFrameBurstCount = 0;`,
  `  let r30ProducerBacklogDropped = 0;\n  const R31_PLAYBACK_STATE_POLL_MS = 1000; // LILAC_R31_STATE_COALESCE\n  let r31LastPlaybackPollPerfMs = -Infinity;\n  let r31StateSampleWallMs = 0;\n  let r31StateNativePolls = 0;\n  let r31StateCacheHits = 0;\n  let noFrameBurstCount = 0;`,
  'R31 state coalesce state'
);

const oldStatePoll = `      const stateStarted = performance.now();\n      lastState = fullDiagnostics ? addon.poll(playerId) : addon.pollPlayback(playerId);\n      const stateElapsed = Math.max(0, performance.now() - stateStarted);\n      if (fullDiagnostics) {\n        metrics.fullDiagnosticsPollSamples += 1;\n        metrics.fullDiagnosticsPollTotalMs += stateElapsed;\n        metrics.fullDiagnosticsPollMaxMs = Math.max(metrics.fullDiagnosticsPollMaxMs, stateElapsed);\n      } else {\n        metrics.statePollPlaybackSamples += 1;\n        metrics.statePollPlaybackTotalMs += stateElapsed;\n        metrics.statePollPlaybackMaxMs = Math.max(metrics.statePollPlaybackMaxMs, stateElapsed);\n      }\n      const stateFps = Number(lastState?.fps) || Number(lastState?.estimatedVfFps) || 0;`;
const newStatePoll = `      const stateStarted = performance.now();\n      let r31NativeStatePolled = false;\n      if (fullDiagnostics) {\n        lastState = addon.poll(playerId);\n        r31StateSampleWallMs = Date.now();\n        r31LastPlaybackPollPerfMs = performance.now();\n        r31StateNativePolls += 1;\n        r31NativeStatePolled = true;\n      } else {\n        const r31NowPerf = performance.now();\n        if (!lastState || r31StateSampleWallMs <= 0 || r31NowPerf - r31LastPlaybackPollPerfMs >= R31_PLAYBACK_STATE_POLL_MS) {\n          lastState = addon.pollPlayback(playerId);\n          r31StateSampleWallMs = Date.now();\n          r31LastPlaybackPollPerfMs = performance.now();\n          r31StateNativePolls += 1;\n          r31NativeStatePolled = true;\n        } else {\n          r31StateCacheHits += 1;\n        }\n      }\n      const stateElapsed = Math.max(0, performance.now() - stateStarted);\n      if (fullDiagnostics) {\n        metrics.fullDiagnosticsPollSamples += 1;\n        metrics.fullDiagnosticsPollTotalMs += stateElapsed;\n        metrics.fullDiagnosticsPollMaxMs = Math.max(metrics.fullDiagnosticsPollMaxMs, stateElapsed);\n      } else if (r31NativeStatePolled) {\n        metrics.statePollPlaybackSamples += 1;\n        metrics.statePollPlaybackTotalMs += stateElapsed;\n        metrics.statePollPlaybackMaxMs = Math.max(metrics.statePollPlaybackMaxMs, stateElapsed);\n      }\n      const stateFps = Number(lastState?.fps) || Number(lastState?.estimatedVfFps) || 0;`;
bridge = replaceOnce(bridge, oldStatePoll, newStatePoll, 'R31 coalesce synchronous native playback state');

bridge = replaceOnce(
  bridge,
  `      lastError,\n      ...(lastState || {})`,
  `      lastError,\n      r31StateCoalesce: 'LILAC_R31_STATE_COALESCE',\n      r31StateNativePollIntervalMs: R31_PLAYBACK_STATE_POLL_MS,\n      r31StateSampleWallMs,\n      r31StateNativePolls,\n      r31StateCacheHits,\n      r31StateCacheAgeMs: r31StateSampleWallMs > 0 ? Math.max(0, Date.now() - r31StateSampleWallMs) : 0,\n      ...(lastState || {})`,
  'R31 state diagnostics fields'
);

bridge = replaceOnce(
  bridge,
  `    addon.command(playerId, commandArray);\n    return { ok: true };`,
  `    addon.command(playerId, commandArray);\n    if (commandArray[0] === 'set_property' && ['time-pos', 'pause', 'speed'].includes(commandArray[1])) {\n      r31LastPlaybackPollPerfMs = -Infinity;\n    }\n    return { ok: true };`,
  'R31 invalidate state cache on timing commands'
);

// ---------------------------------------------------------------------------
// 2) Renderer compositor shield. R30 proves frame production, transfer and WebGPU
// submission continue while unfocused, but the user still sees black flashes.
// Therefore leave focused direct WebGPU untouched and, only while unfocused,
// cover its swapchain canvas with a normal Canvas2D surface. This is NOT R28's
// failed WebGPU staging texture: the unfocused final presentation path exits
// WebGPU entirely. A low-rate hidden mirror keeps the shield warm before blur.
// ---------------------------------------------------------------------------
preload = replaceOnce(
  preload,
  `let lastGpuError = null;`,
  `let lastGpuError = null;\nlet r31DirectWebgpuFrames = 0; // LILAC_R31_FOCUS_COMPOSITOR_SHIELD\nlet r31FocusShieldFrames = 0;\nlet r31FocusShieldFailures = 0;\nlet r31FocusShieldFallbackWebgpuFrames = 0;\nlet r31FocusShieldActive = false;\nlet r31FocusShieldReady = false;\nlet r31FocusRecoveryFrames = 0;\nlet r31FocusedMirrorCounter = 0;\nlet r31FocusShieldDrawSamples = 0;\nlet r31FocusShieldDrawTotalMs = 0;\nlet r31FocusShieldDrawMaxMs = 0;\nlet r31HeldVideoFrames = 0;\nlet r31HeldVideoFramesMax = 0;`,
  'R31 focus shield counters'
);

const sendStatsAt = preload.indexOf('function sendStats(');
if (sendStatsAt < 0 || preload.indexOf('function sendStats(', sendStatsAt + 1) >= 0) throw new Error('R31 sendStats boundary must be unique');
const shieldHelpers = `function r31FocusShieldSurface(host, sourceCanvas, width, height) {\n  if (!host?.shadowRoot || !sourceCanvas) return null;\n  let shield = host.shadowRoot.querySelector('canvas[data-lilac-libmpv-focus-shield]');\n  if (!shield) {\n    shield = document.createElement('canvas');\n    shield.dataset.lilacLibmpvFocusShield = '1';\n    shield.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;pointer-events:none;z-index:1;opacity:0;';\n    host.shadowRoot.appendChild(shield);\n  }\n  if (shield.width !== width) shield.width = width;\n  if (shield.height !== height) shield.height = height;\n  return shield;\n}\n\nfunction r31SetFocusShieldVisible(visible) {\n  const { host, canvas } = findSurface();\n  const width = Math.max(2, Number(canvas?.width) || 2);\n  const height = Math.max(2, Number(canvas?.height) || 2);\n  const shield = r31FocusShieldSurface(host, canvas, width, height);\n  if (!shield) return false;\n  const nextVisible = Boolean(visible);\n  shield.style.opacity = nextVisible ? '1' : '0';\n  r31FocusShieldActive = nextVisible;\n  return true;\n}\n\nfunction r31DrawFocusShield(frame, host, sourceCanvas, width, height) {\n  const shield = r31FocusShieldSurface(host, sourceCanvas, width, height);\n  if (!shield) throw new Error('R31 Canvas2D focus shield unavailable');\n  const context = shield.getContext('2d', { alpha: false, desynchronized: true });\n  if (!context) throw new Error('R31 Canvas2D focus shield context unavailable');\n  let held = null;\n  try { held = typeof frame?.clone === 'function' ? frame.clone() : null; } catch {}\n  const drawStarted = performance.now();\n  context.drawImage(held || frame, 0, 0, width, height);\n  const elapsed = Math.max(0, performance.now() - drawStarted);\n  r31FocusShieldDrawSamples += 1;\n  r31FocusShieldDrawTotalMs += elapsed;\n  r31FocusShieldDrawMaxMs = Math.max(r31FocusShieldDrawMaxMs, elapsed);\n  r31FocusShieldReady = true;\n  if (held) {\n    r31HeldVideoFrames += 1;\n    r31HeldVideoFramesMax = Math.max(r31HeldVideoFramesMax, r31HeldVideoFrames);\n    setTimeout(() => {\n      try { held.close?.(); } catch {}\n      r31HeldVideoFrames = Math.max(0, r31HeldVideoFrames - 1);\n    }, 34);\n  }\n  return elapsed;\n}\n\nif (typeof window !== 'undefined') {\n  window.addEventListener('blur', () => {\n    r31FocusRecoveryFrames = 0;\n    if (r31FocusShieldReady) r31SetFocusShieldVisible(true);\n  });\n  window.addEventListener('focus', () => {\n    // Keep the last Canvas2D frame over the WebGPU canvas until two new focused\n    // direct frames have been submitted. No rAF or GPU fence is introduced.\n    r31FocusRecoveryFrames = 2;\n  });\n}\n\n`;
preload = preload.slice(0, sendStatsAt) + shieldHelpers + preload.slice(sendStatsAt);

preload = replaceOnce(
  preload,
  `      ...extra\n`,
  `      r31FocusCompositorShield: 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD',\n      r31DirectWebgpuFrames,\n      r31FocusShieldFrames,\n      r31FocusShieldFailures,\n      r31FocusShieldFallbackWebgpuFrames,\n      r31FocusShieldActive,\n      r31FocusShieldReady,\n      r31FocusRecoveryFrames,\n      r31FocusShieldDrawAvgMs: r31FocusShieldDrawSamples > 0 ? Math.round((r31FocusShieldDrawTotalMs / r31FocusShieldDrawSamples) * 1000) / 1000 : 0,\n      r31FocusShieldDrawMaxMs: Math.round(r31FocusShieldDrawMaxMs * 1000) / 1000,\n      r31HeldVideoFrames,\n      r31HeldVideoFramesMax,\n      ...extra\n`,
  'R31 receiver stats fields'
);

preload = replaceOnce(
  preload,
  `    worstTransportFrameId: r26WorstTransportFrameId,\n    r27: {`,
  `    worstTransportFrameId: r26WorstTransportFrameId,\n    r31: {\n      focusCompositorShield: 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD',\n      mode: 'focused-direct-webgpu/unfocused-canvas2d-shield',\n      directWebgpuFrames: r31DirectWebgpuFrames,\n      focusShieldFrames: r31FocusShieldFrames,\n      focusShieldFailures: r31FocusShieldFailures,\n      fallbackWebgpuFrames: r31FocusShieldFallbackWebgpuFrames,\n      shieldActive: r31FocusShieldActive,\n      shieldReady: r31FocusShieldReady,\n      focusRecoveryFrames: r31FocusRecoveryFrames,\n      drawAvgMs: r31FocusShieldDrawSamples > 0 ? Math.round((r31FocusShieldDrawTotalMs / r31FocusShieldDrawSamples) * 1000) / 1000 : 0,\n      drawMaxMs: Math.round(r31FocusShieldDrawMaxMs * 1000) / 1000,\n      heldVideoFrames: r31HeldVideoFrames,\n      heldVideoFramesMax: r31HeldVideoFramesMax\n    },\n    r27: {`,
  'R31 on-demand focus shield diagnostics'
);

const oldDraw = `      const drawStarted = performance.now();\n      try {\n        gpu.device.queue.copyExternalImageToTexture(\n          { source: frame },\n          { texture: gpu.context.getCurrentTexture() },\n          { width, height, depthOrArrayLayers: 1 }\n        );\n      } catch (error) {\n        gpuCopyFailures += 1;\n        lastGpuError = String(error?.message || error).slice(0, 160);\n        throw error;\n      }`;
const newDraw = `      const drawStarted = performance.now();\n      const r31UseFocusShield = r27RendererFocused === false;\n      let r31ShieldFailedThisFrame = false;\n      try {\n        if (r31UseFocusShield) {\n          try {\n            r31DrawFocusShield(frame, host, canvas, width, height);\n            r31FocusShieldFrames += 1;\n            r31SetFocusShieldVisible(true);\n          } catch (shieldError) {\n            r31FocusShieldFailures += 1;\n            r31ShieldFailedThisFrame = true;\n            lastGpuError = \`R31 shield: \${String(shieldError?.message || shieldError).slice(0, 120)}\`;\n            gpu.device.queue.copyExternalImageToTexture(\n              { source: frame },\n              { texture: gpu.context.getCurrentTexture() },\n              { width, height, depthOrArrayLayers: 1 }\n            );\n            r31FocusShieldFallbackWebgpuFrames += 1;\n          }\n        } else {\n          gpu.device.queue.copyExternalImageToTexture(\n            { source: frame },\n            { texture: gpu.context.getCurrentTexture() },\n            { width, height, depthOrArrayLayers: 1 }\n          );\n          r31DirectWebgpuFrames += 1;\n          r31FocusedMirrorCounter += 1;\n          const r31MirrorNow = r31FocusRecoveryFrames > 0 || !r31FocusShieldReady || (r31FocusedMirrorCounter % 8 === 1);\n          if (r31MirrorNow) {\n            try { r31DrawFocusShield(frame, host, canvas, width, height); } catch { r31FocusShieldFailures += 1; }\n          }\n          if (r31FocusRecoveryFrames > 0) {\n            r31FocusRecoveryFrames -= 1;\n            if (r31FocusRecoveryFrames === 0) r31SetFocusShieldVisible(false);\n          } else if (r31FocusShieldActive) {\n            r31SetFocusShieldVisible(false);\n          }\n        }\n      } catch (error) {\n        gpuCopyFailures += 1;\n        if (!r31ShieldFailedThisFrame) lastGpuError = String(error?.message || error).slice(0, 160);\n        throw error;\n      }`;
preload = replaceOnce(preload, oldDraw, newDraw, 'R31 focus-dependent compositor path');

// ---------------------------------------------------------------------------
// 3) Renderer media clock extrapolation. Keep the existing 250ms _pollState()
// event cadence but make currentTime continuous between 1s native samples.
// ---------------------------------------------------------------------------
renderer = replaceOnce(
  renderer,
  `    this._time = 0;\n    this._duration = 0;`,
  `    this._time = 0;\n    this._stateClockTime = 0; // LILAC_R31_STATE_CLOCK\n    this._stateSampleWallMs = 0;\n    this._duration = 0;`,
  'R31 renderer clock fields'
);
renderer = replaceOnce(
  renderer,
  `    this._time = 0;\n    this._duration = 0;\n    this._width = 0;`,
  `    this._time = 0;\n    this._stateClockTime = 0;\n    this._stateSampleWallMs = 0;\n    this._duration = 0;\n    this._width = 0;`,
  'R31 reset renderer clock'
);
renderer = replaceOnce(
  renderer,
  `  get src() { return this.getAttribute('src') || ''; }`,
  `  _estimatedCurrentTime() {\n    const base = Number(this._stateClockTime);\n    if (!Number.isFinite(base) || this._stateSampleWallMs <= 0 || this._paused) return Math.max(0, Number(this._time) || 0);\n    const elapsed = Math.max(0, Date.now() - this._stateSampleWallMs) / 1000;\n    const estimated = base + elapsed * (Number(this._playbackRate) || 1);\n    return this._duration > 0 ? clamp(estimated, 0, this._duration) : Math.max(0, estimated);\n  }\n\n  get src() { return this.getAttribute('src') || ''; }`,
  'R31 estimated media clock helper'
);
renderer = replaceOnce(
  renderer,
  `  get currentTime() { return this._time; }\n  set currentTime(value) {\n    const next = Math.max(0, Number(value) || 0);\n    this._time = next;`,
  `  get currentTime() { return this._estimatedCurrentTime(); }\n  set currentTime(value) {\n    const next = Math.max(0, Number(value) || 0);\n    this._time = next;\n    this._stateClockTime = next;\n    this._stateSampleWallMs = Date.now();`,
  'R31 continuous currentTime getter'
);
renderer = replaceOnce(
  renderer,
  `      const previousTime = this._time;\n      const previousDuration = this._duration;`,
  `      const previousTime = this.currentTime;\n      const previousDuration = this._duration;`,
  'R31 compare extrapolated currentTime'
);
renderer = replaceOnce(
  renderer,
  `      if (Number.isFinite(Number(state.time))) this._time = Math.max(0, Number(state.time));\n      if (Number.isFinite(Number(state.duration))) this._duration = Math.max(0, Number(state.duration));\n      if (Number.isFinite(Number(state.width))) this._width = Math.max(0, Number(state.width));\n      if (Number.isFinite(Number(state.height))) this._height = Math.max(0, Number(state.height));\n      if (typeof state.paused === 'boolean') this._paused = state.paused;`,
  `      if (Number.isFinite(Number(state.duration))) this._duration = Math.max(0, Number(state.duration));\n      if (Number.isFinite(Number(state.width))) this._width = Math.max(0, Number(state.width));\n      if (Number.isFinite(Number(state.height))) this._height = Math.max(0, Number(state.height));\n      if (typeof state.paused === 'boolean') this._paused = state.paused;\n      if (Number.isFinite(Number(state.time))) {\n        this._stateClockTime = Math.max(0, Number(state.time));\n        const sampleWall = Number(state.r31StateSampleWallMs);\n        this._stateSampleWallMs = Number.isFinite(sampleWall) && sampleWall > 0 ? sampleWall : Date.now();\n        this._time = this._estimatedCurrentTime();\n      }`,
  'R31 consume sampled state clock'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);
write('src/libmpv-shared-entry.js', renderer);

const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const preloadOut = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(preloadEntry)) throw new Error('R31 preload entry missing');
buildSync({ entryPoints: [preloadEntry], outfile: preloadOut, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'info' });

const rendererEntry = file('src/libmpv-shared-entry.js');
const rendererOut = file('src/libmpv-shared.generated.js');
buildSync({ entryPoints: [rendererEntry], outfile: rendererOut, bundle: true, platform: 'browser', format: 'iife', target: 'chrome150', logLevel: 'info' });

const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalPreload = read('electron/libmpv-shared-preload.cjs');
const bundledPreload = read('electron/preload-libmpv-shared.generated.cjs');
const finalRenderer = read('src/libmpv-shared-entry.js');
const bundledRenderer = read('src/libmpv-shared.generated.js');

for (const marker of ['LILAC_R31_STATE_COALESCE', 'R31_PLAYBACK_STATE_POLL_MS = 1000', 'r31StateSampleWallMs', 'r31StateCacheHits']) {
  if (!finalBridge.includes(marker)) throw new Error(`R31 bridge marker missing: ${marker}`);
}
for (const marker of ['LILAC_R31_FOCUS_COMPOSITOR_SHIELD', 'data-lilac-libmpv-focus-shield', 'r31DrawFocusShield', 'focused-direct-webgpu/unfocused-canvas2d-shield', 'copyExternalImageToTexture']) {
  if (!finalPreload.includes(marker) || !bundledPreload.includes(marker)) throw new Error(`R31 preload marker missing: ${marker}`);
}
for (const marker of ['LILAC_R31_STATE_CLOCK', '_estimatedCurrentTime()', 'r31StateSampleWallMs']) {
  if (!finalRenderer.includes(marker) || !bundledRenderer.includes(marker)) throw new Error(`R31 renderer marker missing: ${marker}`);
}
for (const forbidden of ['LILAC_R28_FOCUS_SAFE_PLAYBACK', 'r28FocusStagingTexture', 'focus-staged-gpu-copy', 'copyTextureToTexture', 'LILAC_R29_GPU_SAFE_LIFETIME', 'r29GpuSafeReleaseCallbacks', 'importedSharedTexture?.subtle?.release', 'onSubmittedWorkDone(']) {
  if (finalPreload.includes(forbidden) || bundledPreload.includes(forbidden)) throw new Error(`R31 forbidden renderer path survived: ${forbidden}`);
}
if (finalPreload.includes('requestAnimationFrame(') || bundledPreload.includes('requestAnimationFrame(')) throw new Error('R31 preload reintroduced rAF gating');
if (!finalPreload.includes('importedSharedTexture?.release') || !finalPreload.includes("presentationMode = 'direct-receive-webgpu-copy'")) throw new Error('R31 lost managed direct WebGPU baseline');
if (!finalBridge.includes('LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN') || !finalBridge.includes('r30PopLatestProducedFrame')) throw new Error('R31 lost R30 producer repair');

console.log('R31_FOCUS_COMPOSITOR_STATE_OK focused=direct-webgpu unfocused=canvas2d-shield prewarm=1of8 recoveryFrames=2 heldCloneMs=34 stateNativePollMs=1000 stateUiClock=wall-extrapolated nativeBytes=unchanged');

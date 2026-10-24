'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');

if (!bridge.includes('ACTIVE_PUMP_RETRY_MS = 2') || !bridge.includes('pumpExpectedFps')) {
  throw new Error('R3A requires the R2Y phase-aware producer pump');
}
if (!bridge.includes('nativeCadenceTracker') || !bridge.includes('sendSharedTextureSamples')) {
  throw new Error('R3A requires R2X/R2Z pipeline diagnostics');
}

// User-hardware R2Z diagnostics proved that renderer receive/present timing now
// mirrors native timing, while sendSharedTexture occasionally takes tens of ms.
// The producer pump still awaits that Promise before scheduling the next
// renderFrame(), so transport latency can become producer-discovery latency.
// Keep the hardware-qualified native renderer untouched and split the two clocks:
// renderFrame() remains single-threaded/phase-paced, while already-imported
// shared textures are delivered by bounded asynchronous work.
bridge = replaceOnce(
  bridge,
  '  let lastPumpStatePollPerfAt = 0;',
  `  let lastPumpStatePollPerfAt = 0;\n  let deliveryInFlight = 0;\n  let pumpTimerDuePerfAt = 0;\n  const MAX_PENDING_DELIVERY_FRAMES = 12;`,
  'R3A delivery/pump state'
);

bridge = replaceOnce(
  bridge,
  `    lastSendSharedTextureMs: 0\n  };`,
  `    lastSendSharedTextureMs: 0,\n    sendInvokeSamples: 0,\n    sendInvokeTotalMs: 0,\n    sendInvokeMaxMs: 0,\n    deliveryStarted: 0,\n    deliveryCompleted: 0,\n    deliveryMaxInFlight: 0,\n    deliveryThrottleCount: 0,\n    pumpTimerSamples: 0,\n    pumpTimerLagTotalMs: 0,\n    pumpTimerLagMaxMs: 0,\n    pumpStatePollSamples: 0,\n    pumpStatePollTotalMs: 0,\n    pumpStatePollMaxMs: 0,\n    pumpRenderSamples: 0,\n    pumpRenderTotalMs: 0,\n    pumpRenderMaxMs: 0\n  };`,
  'R3A stall diagnostics metrics'
);

bridge = replaceOnce(
  bridge,
  `      avgSendSharedTextureMs: metrics.sendSharedTextureSamples > 0\n        ? Math.round((metrics.sendSharedTextureTotalMs / metrics.sendSharedTextureSamples) * 1000) / 1000\n        : 0,\n      nativeCadence`,
  `      avgSendSharedTextureMs: metrics.sendSharedTextureSamples > 0\n        ? Math.round((metrics.sendSharedTextureTotalMs / metrics.sendSharedTextureSamples) * 1000) / 1000\n        : 0,\n      avgSendInvokeMs: metrics.sendInvokeSamples > 0\n        ? Math.round((metrics.sendInvokeTotalMs / metrics.sendInvokeSamples) * 1000) / 1000\n        : 0,\n      avgPumpTimerLagMs: metrics.pumpTimerSamples > 0\n        ? Math.round((metrics.pumpTimerLagTotalMs / metrics.pumpTimerSamples) * 1000) / 1000\n        : 0,\n      avgPumpStatePollMs: metrics.pumpStatePollSamples > 0\n        ? Math.round((metrics.pumpStatePollTotalMs / metrics.pumpStatePollSamples) * 1000) / 1000\n        : 0,\n      avgPumpRenderMs: metrics.pumpRenderSamples > 0\n        ? Math.round((metrics.pumpRenderTotalMs / metrics.pumpRenderSamples) * 1000) / 1000\n        : 0,\n      deliveryInFlight,\n      nativeCadence`,
  'R3A derived stall metrics'
);

const oldTimingRefresh = `  function refreshPumpTimingState(ownerPlayerId, now = performance.now()) {\n    if (pumpExpectedFps > 0 && now - lastPumpStatePollPerfAt < 250) return;\n    lastPumpStatePollPerfAt = now;\n    try {\n      const snapshot = addon.poll(ownerPlayerId);\n      if (!snapshot) return;\n      lastState = snapshot;\n      const fps = Number(snapshot.fps) || Number(snapshot.estimatedVfFps) || 0;\n      if (Number.isFinite(fps) && fps >= 10 && fps <= 240) pumpExpectedFps = fps;\n    } catch {}\n  }`;
const newTimingRefresh = `  function refreshPumpTimingState(ownerPlayerId, now = performance.now()) {\n    if (pumpExpectedFps > 0 && now - lastPumpStatePollPerfAt < 1000) return;\n    lastPumpStatePollPerfAt = now;\n    const started = performance.now();\n    try {\n      const snapshot = addon.poll(ownerPlayerId);\n      if (!snapshot) return;\n      lastState = snapshot;\n      const fps = Number(snapshot.fps) || Number(snapshot.estimatedVfFps) || 0;\n      if (Number.isFinite(fps) && fps >= 10 && fps <= 240) pumpExpectedFps = fps;\n    } catch {} finally {\n      const elapsed = Math.max(0, performance.now() - started);\n      metrics.pumpStatePollSamples += 1;\n      metrics.pumpStatePollTotalMs += elapsed;\n      metrics.pumpStatePollMaxMs = Math.max(metrics.pumpStatePollMaxMs, elapsed);\n    }\n  }`;
bridge = replaceOnce(bridge, oldTimingRefresh, newTimingRefresh, 'R3A low-frequency timed state poll');

const oldSchedule = `  function schedulePump(delay = 4) {\n    if (!active || disposed) return;\n    const wait = Math.max(0, Number(delay) || 0);\n    if (pumpTimer) {\n      if (wait > 0) return;\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n    }\n    pumpTimer = setTimeout(() => {\n      pumpTimer = null;\n      void pump();\n    }, wait);\n  }`;
const newSchedule = `  function schedulePump(delay = 4) {\n    if (!active || disposed) return;\n    const wait = Math.max(0, Number(delay) || 0);\n    if (pumpTimer) {\n      if (wait > 0) return;\n      clearTimeout(pumpTimer);\n      pumpTimer = null;\n    }\n    pumpTimerDuePerfAt = performance.now() + wait;\n    pumpTimer = setTimeout(() => {\n      pumpTimer = null;\n      const firedAt = performance.now();\n      const lag = Math.max(0, firedAt - pumpTimerDuePerfAt);\n      metrics.pumpTimerSamples += 1;\n      metrics.pumpTimerLagTotalMs += lag;\n      metrics.pumpTimerLagMaxMs = Math.max(metrics.pumpTimerLagMaxMs, lag);\n      pumpTimerDuePerfAt = 0;\n      void pump();\n    }, wait);\n  }`;
bridge = replaceOnce(bridge, oldSchedule, newSchedule, 'R3A timer-lag diagnostics');

bridge = replaceOnce(
  bridge,
  `      metrics.pumpTicks += 1;\n      refreshPumpTimingState(ownerPlayerId);\n      const nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  `      metrics.pumpTicks += 1;\n      refreshPumpTimingState(ownerPlayerId);\n      if (pendingFrames.size >= MAX_PENDING_DELIVERY_FRAMES) {\n        metrics.deliveryThrottleCount += 1;\n        nextDelay = ACTIVE_PUMP_RETRY_MS;\n        return;\n      }\n      const renderStarted = performance.now();\n      let nativeFrame;\n      try {\n        nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);\n      } finally {\n        const renderElapsed = Math.max(0, performance.now() - renderStarted);\n        metrics.pumpRenderSamples += 1;\n        metrics.pumpRenderTotalMs += renderElapsed;\n        metrics.pumpRenderMaxMs = Math.max(metrics.pumpRenderMaxMs, renderElapsed);\n      }`,
  'R3A timed nonblocking render discovery'
);

const pumpMarker = '  async function pump() {';
const pumpIndex = bridge.indexOf(pumpMarker);
if (pumpIndex < 0) throw new Error('R3A pump insertion point missing');
const deliveryHelper = `  async function deliverImportedFrame(delivery) {\n    const {\n      imported, ownerPlayerId, ownerGeneration, slotId, frameId, width, height,\n      timestampUs, fps, displayFrequency\n    } = delivery || {};\n    if (!imported) return;\n    deliveryInFlight += 1;\n    metrics.deliveryStarted += 1;\n    metrics.deliveryMaxInFlight = Math.max(metrics.deliveryMaxInFlight, deliveryInFlight);\n    let sendStarted = 0;\n    try {\n      if (!active || ownerGeneration !== generation || ownerPlayerId !== playerId || !attachedWindow || attachedWindow.isDestroyed()) return;\n      sendStarted = performance.now();\n      let sendPromise;\n      const invokeStarted = performance.now();\n      try {\n        sendPromise = sharedTexture.sendSharedTexture({\n          frame: attachedWindow.webContents.mainFrame,\n          importedSharedTexture: imported\n        }, {\n          kind: 'lilac-libmpv-frame',\n          playerId: ownerPlayerId,\n          generation: ownerGeneration,\n          slotId,\n          frameId,\n          width,\n          height,\n          timestampUs,\n          fps,\n          displayFrequency\n        });\n      } finally {\n        const invokeElapsed = Math.max(0, performance.now() - invokeStarted);\n        metrics.sendInvokeSamples += 1;\n        metrics.sendInvokeTotalMs += invokeElapsed;\n        metrics.sendInvokeMaxMs = Math.max(metrics.sendInvokeMaxMs, invokeElapsed);\n      }\n      await sendPromise;\n      metrics.sentFrames += 1;\n    } catch (error) {\n      metrics.sendFailures += 1;\n      lastError = \`shared texture send failed: \${String(error?.message || error).slice(0, 180)}\`;\n    } finally {\n      if (sendStarted > 0) {\n        const sendElapsed = Math.max(0, performance.now() - sendStarted);\n        metrics.sendSharedTextureSamples += 1;\n        metrics.sendSharedTextureTotalMs += sendElapsed;\n        metrics.sendSharedTextureMaxMs = Math.max(metrics.sendSharedTextureMaxMs, sendElapsed);\n        metrics.lastSendSharedTextureMs = sendElapsed;\n      }\n      deliveryInFlight = Math.max(0, deliveryInFlight - 1);\n      metrics.deliveryCompleted += 1;\n      try { imported?.release?.(); } catch {}\n    }\n  }\n\n`;
bridge = bridge.slice(0, pumpIndex) + deliveryHelper + bridge.slice(pumpIndex);

const sendStart = bridge.indexOf('      let sendStarted = 0;\n      try {', bridge.indexOf(pumpMarker));
const sendEndMarker = '        try { imported?.release?.(); } catch {}\n      }';
const sendEnd = bridge.indexOf(sendEndMarker, sendStart);
if (sendStart < 0 || sendEnd <= sendStart) throw new Error('R3A legacy awaited delivery block not found');
const sendReplacement = `      const delivery = {\n        imported,\n        ownerPlayerId,\n        ownerGeneration,\n        slotId,\n        frameId,\n        width: Number(nativeFrame.width),\n        height: Number(nativeFrame.height),\n        timestampUs: Number(nativeFrame.timestampUs) || 0,\n        fps: Number(pumpExpectedFps) || Number(lastState?.fps) || 0,\n        displayFrequency: Number(displayState.frequency) || 0\n      };\n      // Ownership moves to the delivery task. Crucially, the producer no longer\n      // awaits transport completion before scheduling the next renderFrame poll.\n      imported = null;\n      void deliverImportedFrame(delivery);`;
bridge = bridge.slice(0, sendStart) + sendReplacement + bridge.slice(sendEnd + sendEndMarker.length);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r2z.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r9') {
  throw new Error(`expected R2Z identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r3a.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r10';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R3A-Setup.${ext}';

for (const marker of [
  'MAX_PENDING_DELIVERY_FRAMES = 12',
  'async function deliverImportedFrame',
  'void deliverImportedFrame(delivery)',
  'sendInvokeMaxMs',
  'pumpTimerLagMaxMs',
  'pumpStatePollMaxMs',
  'pumpRenderMaxMs',
  'deliveryMaxInFlight',
  'now - lastPumpStatePollPerfAt < 1000'
]) {
  if (!bridge.includes(marker)) throw new Error(`R3A bridge marker missing: ${marker}`);
}
if (bridge.includes('await sharedTexture.sendSharedTexture')) {
  throw new Error('R3A producer still directly awaits sharedTexture delivery');
}
if (!bridge.includes('await sendPromise')) throw new Error('R3A delivery lifetime await missing');
if (!bridge.includes('ACTIVE_PUMP_RETRY_MS = 2') || !bridge.includes('nextActivePumpDelay')) {
  throw new Error('R3A lost R2Y phase-aware scheduling');
}

write('electron/libmpv-shared-main.cjs', bridge);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
console.log('LIBMPV_R3A_OK producer=phase-aware-nonblocking delivery=async-bounded nativePayload=unchanged diagnostics=timer,poll,render,send-invoke');

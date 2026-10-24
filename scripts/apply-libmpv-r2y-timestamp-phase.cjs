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
if (!bridge.includes('ACTIVE_PUMP_RETRY_MS = 2') || !bridge.includes('nextActivePumpDelay')) {
  throw new Error('R2Y FPS phase requires the R2Y adaptive pump first');
}

// nativeFrame.timestampUs is generated from steady_clock at renderFrame return,
// not media PTS, so it must never be used to learn the source period. Poll the
// already-exposed libmpv FPS at a low frequency instead. The last discovered
// frame still provides phase; source FPS provides period.
bridge = replaceOnce(
  bridge,
  '  let lastNativeFramePerfAt = 0;',
  `  let lastNativeFramePerfAt = 0;\n  let pumpExpectedFps = 0;\n  let lastPumpStatePollPerfAt = 0;`,
  'FPS phase predictor state'
);
bridge = replaceOnce(
  bridge,
  `  function expectedSourceFrameIntervalMs() {\n    const fps = Number(lastState?.fps) || 0;\n    if (!Number.isFinite(fps) || fps < 10 || fps > 240) return 0;\n    return 1000 / fps;\n  }`,
  `  function refreshPumpTimingState(ownerPlayerId, now = performance.now()) {\n    if (pumpExpectedFps > 0 && now - lastPumpStatePollPerfAt < 250) return;\n    lastPumpStatePollPerfAt = now;\n    try {\n      const snapshot = addon.poll(ownerPlayerId);\n      if (!snapshot) return;\n      lastState = snapshot;\n      const fps = Number(snapshot.fps) || Number(snapshot.estimatedVfFps) || 0;\n      if (Number.isFinite(fps) && fps >= 10 && fps <= 240) pumpExpectedFps = fps;\n    } catch {}\n  }\n\n  function expectedSourceFrameIntervalMs() {\n    const fps = Number(pumpExpectedFps) || Number(lastState?.fps) || 0;\n    if (!Number.isFinite(fps) || fps < 10 || fps > 240) return 0;\n    return 1000 / fps;\n  }`,
  'read source period from libmpv FPS'
);
bridge = replaceOnce(
  bridge,
  `      metrics.pumpTicks += 1;\n      const nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  `      metrics.pumpTicks += 1;\n      refreshPumpTimingState(ownerPlayerId);\n      const nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);`,
  'refresh source timing before frame poll'
);
bridge = replaceOnce(
  bridge,
  `    generation += 1;\n    lastError = null;\n    lastState = null;`,
  `    generation += 1;\n    lastNativeFramePerfAt = 0;\n    pumpExpectedFps = 0;\n    lastPumpStatePollPerfAt = 0;\n    lastError = null;\n    lastState = null;`,
  'reset FPS phase predictor for new source'
);

for (const marker of ['pumpExpectedFps', 'refreshPumpTimingState', 'lastPumpStatePollPerfAt', 'Number(snapshot.fps)', 'now - lastPumpStatePollPerfAt < 250']) {
  if (!bridge.includes(marker)) throw new Error(`R2Y FPS predictor marker missing: ${marker}`);
}
if (bridge.includes('measuredIntervalMs') || bridge.includes('lastNativeTimestampUs')) {
  throw new Error('R2Y must not learn cadence from renderFrame steady-clock timestamps');
}
write('electron/libmpv-shared-main.cjs', bridge);
console.log('LIBMPV_R2Y_FPS_PHASE_OK sourcePeriod=libmpv-fps phase=last-frame-discovery pollMs=250');

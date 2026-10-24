'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

if (!source.includes('async function deliverImportedFrame') || !source.includes('ACTIVE_PUMP_RETRY_MS = 2')) {
  throw new Error('R3A phase deadline requires decoupled delivery and phase-aware pump first');
}
if (!source.includes('now - lastPumpStatePollPerfAt < 250')) {
  throw new Error('R3A phase deadline requires responsive 250ms state polling');
}

replaceOnce(
  `  let lastNativeFramePerfAt = 0;\n  let pumpExpectedFps = 0;`,
  `  let lastNativeFramePerfAt = 0;\n  let nextNativeFrameDeadlinePerfAt = 0;\n  let pumpExpectedFps = 0;`,
  'absolute source deadline state'
);

replaceOnce(
  `    pumpRenderSamples: 0,\n    pumpRenderTotalMs: 0,\n    pumpRenderMaxMs: 0\n  };`,
  `    pumpRenderSamples: 0,\n    pumpRenderTotalMs: 0,\n    pumpRenderMaxMs: 0,\n    pumpPhaseCatchupPeriods: 0,\n    pumpPhaseLateMaxMs: 0\n  };`,
  'absolute phase diagnostics'
);

replaceOnce(
  `      lastState = snapshot;\n      const fps = Number(snapshot.fps) || Number(snapshot.estimatedVfFps) || 0;`,
  `      lastState = snapshot;\n      if (snapshot.paused) nextNativeFrameDeadlinePerfAt = 0;\n      const fps = Number(snapshot.fps) || Number(snapshot.estimatedVfFps) || 0;`,
  'reset source phase while paused'
);

const oldPredictor = `  function nextActivePumpDelay(now = performance.now()) {\n    if (lastState?.paused) return 50;\n    const interval = expectedSourceFrameIntervalMs();\n    if (!interval || !lastNativeFramePerfAt) return 4;\n    const untilLead = (lastNativeFramePerfAt + interval - ACTIVE_PUMP_LEAD_MS) - now;\n    if (untilLead > ACTIVE_PUMP_RETRY_MS) {\n      return Math.max(ACTIVE_PUMP_RETRY_MS, Math.min(32, Math.floor(untilLead)));\n    }\n    return ACTIVE_PUMP_RETRY_MS;\n  }`;
const newPredictor = `  function nextActivePumpDelay(now = performance.now()) {\n    if (lastState?.paused) return 50;\n    const interval = expectedSourceFrameIntervalMs();\n    if (!interval || !nextNativeFrameDeadlinePerfAt) return 4;\n    const untilLead = (nextNativeFrameDeadlinePerfAt - ACTIVE_PUMP_LEAD_MS) - now;\n    if (untilLead > ACTIVE_PUMP_RETRY_MS) {\n      return Math.max(ACTIVE_PUMP_RETRY_MS, Math.min(32, Math.floor(untilLead)));\n    }\n    return ACTIVE_PUMP_RETRY_MS;\n  }\n\n  function advanceNativeFrameDeadline(now = performance.now()) {\n    const interval = expectedSourceFrameIntervalMs();\n    if (!interval) {\n      nextNativeFrameDeadlinePerfAt = 0;\n      return;\n    }\n    if (!nextNativeFrameDeadlinePerfAt) {\n      nextNativeFrameDeadlinePerfAt = now + interval;\n      return;\n    }\n    const lateBy = Math.max(0, now - nextNativeFrameDeadlinePerfAt);\n    metrics.pumpPhaseLateMaxMs = Math.max(metrics.pumpPhaseLateMaxMs, lateBy);\n    let next = nextNativeFrameDeadlinePerfAt + interval;\n    let catchup = 0;\n    while (next <= now && catchup < 240) {\n      next += interval;\n      catchup += 1;\n    }\n    if (catchup > 0) metrics.pumpPhaseCatchupPeriods += catchup;\n    nextNativeFrameDeadlinePerfAt = next;\n  }`;
replaceOnce(oldPredictor, newPredictor, 'absolute-deadline phase predictor');

replaceOnce(
  `      metrics.nativeFrames += 1;\n      lastNativeFramePerfAt = performance.now();\n      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);\n      const frameNow = Date.now();`,
  `      metrics.nativeFrames += 1;\n      lastNativeFramePerfAt = performance.now();\n      advanceNativeFrameDeadline(lastNativeFramePerfAt);\n      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);\n      const frameNow = Date.now();`,
  'advance absolute deadline on discovered frame'
);

replaceOnce(
  `    generation += 1;\n    lastNativeFramePerfAt = 0;\n    pumpExpectedFps = 0;`,
  `    generation += 1;\n    lastNativeFramePerfAt = 0;\n    nextNativeFrameDeadlinePerfAt = 0;\n    pumpExpectedFps = 0;`,
  'reset absolute deadline for new source'
);

for (const marker of [
  'nextNativeFrameDeadlinePerfAt',
  'advanceNativeFrameDeadline',
  'pumpPhaseCatchupPeriods',
  'pumpPhaseLateMaxMs',
  'nextNativeFrameDeadlinePerfAt - ACTIVE_PUMP_LEAD_MS',
  'if (snapshot.paused) nextNativeFrameDeadlinePerfAt = 0'
]) {
  if (!source.includes(marker)) throw new Error(`R3A absolute phase marker missing: ${marker}`);
}
if (source.includes('lastNativeFramePerfAt + interval - ACTIVE_PUMP_LEAD_MS')) {
  throw new Error('R3A relative discovery-time phase predictor survived');
}

fs.writeFileSync(target, source);
console.log('LIBMPV_R3A_PHASE_DEADLINE_OK phase=absolute-source-deadline lateWakeup=non-accumulating pause=reanchor');

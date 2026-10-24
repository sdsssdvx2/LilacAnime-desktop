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
  throw new Error('R2Y timestamp phase requires the R2Y adaptive pump first');
}

bridge = replaceOnce(
  bridge,
  '  let lastNativeFramePerfAt = 0;',
  `  let lastNativeFramePerfAt = 0;\n  let lastNativeTimestampUs = 0;\n  let predictedNativeIntervalMs = 0;`,
  'native timestamp predictor state'
);
bridge = replaceOnce(
  bridge,
  `  function expectedSourceFrameIntervalMs() {\n    const fps = Number(lastState?.fps) || 0;\n    if (!Number.isFinite(fps) || fps < 10 || fps > 240) return 0;\n    return 1000 / fps;\n  }`,
  `  function expectedSourceFrameIntervalMs() {\n    if (predictedNativeIntervalMs >= 4 && predictedNativeIntervalMs <= 100) return predictedNativeIntervalMs;\n    const fps = Number(lastState?.fps) || 0;\n    if (!Number.isFinite(fps) || fps < 10 || fps > 240) return 0;\n    return 1000 / fps;\n  }`,
  'prefer measured native timestamp cadence'
);
bridge = replaceOnce(
  bridge,
  `      metrics.nativeFrames += 1;\n      lastNativeFramePerfAt = performance.now();\n      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);\n      const frameNow = Date.now();`,
  `      metrics.nativeFrames += 1;\n      const nativeTimestampUs = Number(nativeFrame.timestampUs) || 0;\n      if (nativeTimestampUs > 0 && lastNativeTimestampUs > 0 && nativeTimestampUs > lastNativeTimestampUs) {\n        const measuredIntervalMs = (nativeTimestampUs - lastNativeTimestampUs) / 1000;\n        if (measuredIntervalMs >= 4 && measuredIntervalMs <= 100) {\n          predictedNativeIntervalMs = predictedNativeIntervalMs > 0\n            ? (predictedNativeIntervalMs * 0.75) + (measuredIntervalMs * 0.25)\n            : measuredIntervalMs;\n        }\n      }\n      if (nativeTimestampUs > 0) lastNativeTimestampUs = nativeTimestampUs;\n      lastNativeFramePerfAt = performance.now();\n      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);\n      const frameNow = Date.now();`,
  'learn source cadence from native timestamps'
);
bridge = replaceOnce(
  bridge,
  `    generation += 1;\n    lastError = null;\n    lastState = null;`,
  `    generation += 1;\n    lastNativeFramePerfAt = 0;\n    lastNativeTimestampUs = 0;\n    predictedNativeIntervalMs = 0;\n    lastError = null;\n    lastState = null;`,
  'reset cadence predictor for new source'
);

for (const marker of ['lastNativeTimestampUs', 'predictedNativeIntervalMs', 'measuredIntervalMs', 'predictedNativeIntervalMs * 0.75']) {
  if (!bridge.includes(marker)) throw new Error(`R2Y timestamp predictor marker missing: ${marker}`);
}
write('electron/libmpv-shared-main.cjs', bridge);
console.log('LIBMPV_R2Y_TIMESTAMP_PHASE_OK sourceCadence=native-timestamp-smoothed fallback=poll-fps');

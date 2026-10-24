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
let preload = read('electron/libmpv-shared-preload.cjs');

if (!bridge.includes('displayState = { id: null, frequency: 0, scaleFactor: 0 }')) throw new Error('R2X diagnostics requires R2W display diagnostics');
if (!preload.includes("presentationMode = 'raf-staged-copy'")) throw new Error('R2X diagnostics requires staged presenter first');

// Main-process cadence tells us whether frames already arrive late from libmpv,
// while sendSharedTexture timing exposes serialization stalls before the renderer.
bridge = replaceOnce(
  bridge,
  "const { sharedTexture } = require('electron');",
  "const { sharedTexture } = require('electron');\nconst { createRollingCadenceTracker } = require('./libmpv-cadence.cjs');",
  'bridge cadence helper import'
);
bridge = replaceOnce(
  bridge,
  '  let displayState = { id: null, frequency: 0, scaleFactor: 0 };',
  `  let displayState = { id: null, frequency: 0, scaleFactor: 0 };\n  const nativeCadenceTracker = createRollingCadenceTracker({ windowMs: 10000, discontinuityMs: 1500 });\n  let nativeCadence = null;`,
  'native cadence state'
);
bridge = replaceOnce(
  bridge,
  `    lastSendError: null\n  };`,
  `    lastSendError: null,\n    sendSharedTextureSamples: 0,\n    sendSharedTextureTotalMs: 0,\n    sendSharedTextureMaxMs: 0,\n    lastSendSharedTextureMs: 0\n  };`,
  'send latency metrics'
);
bridge = replaceOnce(
  bridge,
  `      avgReleaseLatencyMs: metrics.receiverReleases > 0\n        ? Math.round((metrics.releaseLatencyTotalMs / metrics.receiverReleases) * 1000) / 1000\n        : 0`,
  `      avgReleaseLatencyMs: metrics.receiverReleases > 0\n        ? Math.round((metrics.releaseLatencyTotalMs / metrics.receiverReleases) * 1000) / 1000\n        : 0,\n      avgSendSharedTextureMs: metrics.sendSharedTextureSamples > 0\n        ? Math.round((metrics.sendSharedTextureTotalMs / metrics.sendSharedTextureSamples) * 1000) / 1000\n        : 0,\n      nativeCadence`,
  'metrics snapshot source diagnostics'
);
bridge = replaceOnce(
  bridge,
  `      metrics.lastFrameAt = frameNow;\n      metrics.lastFrameId = Number(nativeFrame.frameId) || metrics.lastFrameId;`,
  `      metrics.lastFrameAt = frameNow;\n      metrics.lastFrameId = Number(nativeFrame.frameId) || metrics.lastFrameId;\n      nativeCadence = nativeCadenceTracker.add({\n        atMs: performance.now(),\n        frameId: Number(nativeFrame.frameId) || 0,\n        expectedFps: Number(lastState?.fps) || 0,\n        displayFrequency: Number(displayState.frequency) || 0\n      });`,
  'record native output cadence'
);
bridge = replaceOnce(
  bridge,
  `      try {\n        if (!active || ownerGeneration !== generation || ownerPlayerId !== playerId || !attachedWindow || attachedWindow.isDestroyed()) return;\n        await sharedTexture.sendSharedTexture({`,
  `      let sendStarted = 0;\n      try {\n        if (!active || ownerGeneration !== generation || ownerPlayerId !== playerId || !attachedWindow || attachedWindow.isDestroyed()) return;\n        sendStarted = performance.now();\n        await sharedTexture.sendSharedTexture({`,
  'start sendSharedTexture timing'
);
bridge = replaceOnce(
  bridge,
  `      } finally {\n        try { imported?.release?.(); } catch {}\n      }`,
  `      } finally {\n        if (sendStarted > 0) {\n          const sendElapsed = Math.max(0, performance.now() - sendStarted);\n          metrics.sendSharedTextureSamples += 1;\n          metrics.sendSharedTextureTotalMs += sendElapsed;\n          metrics.sendSharedTextureMaxMs = Math.max(metrics.sendSharedTextureMaxMs, sendElapsed);\n          metrics.lastSendSharedTextureMs = sendElapsed;\n        }\n        try { imported?.release?.(); } catch {}\n      }`,
  'finish sendSharedTexture timing'
);

// Renderer receive cadence is a separate clock point from final rAF presentation.
// With nativeCadence -> receiveCadence -> cadence in one diagnostic snapshot, a
// single hardware run tells us which boundary introduces any remaining 100ms hold.
preload = replaceOnce(
  preload,
  `const cadenceTracker = createRollingCadenceTracker({ windowMs: 10000, discontinuityMs: 1500 });\nlet lastCadence = null;`,
  `const cadenceTracker = createRollingCadenceTracker({ windowMs: 10000, discontinuityMs: 1500 });\nconst receiveCadenceTracker = createRollingCadenceTracker({ windowMs: 10000, discontinuityMs: 1500 });\nlet lastCadence = null;\nlet lastReceiveCadence = null;`,
  'receiver cadence tracker'
);
preload = replaceOnce(
  preload,
  `    receivedFrames += 1;\n    lastFrameAt = Date.now();`,
  `    receivedFrames += 1;\n    lastFrameAt = Date.now();\n    lastReceiveCadence = receiveCadenceTracker.add({\n      atMs: performance.now(),\n      frameId: Number(metadata.frameId) || 0,\n      expectedFps: Number(metadata.fps) || 0,\n      displayFrequency: Number(metadata.displayFrequency) || 0\n    });`,
  'record renderer receive cadence'
);
preload = replaceOnce(
  preload,
  `      cadence: lastCadence,\n      droppedNoSurface,`,
  `      cadence: lastCadence,\n      receiveCadence: lastReceiveCadence,\n      droppedNoSurface,`,
  'receiver cadence stats payload'
);

const oldCadenceParser = `      const cadenceSource = payload?.cadence && typeof payload.cadence === 'object' ? payload.cadence : null;\n      const cadenceNumber = key => {\n        const value = Number(cadenceSource?.[key]);\n        return Number.isFinite(value) ? value : 0;\n      };\n      const cadence = cadenceSource ? {\n        rollingWindowMs: cadenceNumber('rollingWindowMs'),\n        observedSpanMs: cadenceNumber('observedSpanMs'),\n        sampleCount: cadenceNumber('sampleCount'),\n        actualPresentedFps: cadenceNumber('actualPresentedFps'),\n        expectedFps: cadenceNumber('expectedFps'),\n        expectedIntervalMs: cadenceNumber('expectedIntervalMs'),\n        intervalP50Ms: cadenceNumber('intervalP50Ms'),\n        intervalP95Ms: cadenceNumber('intervalP95Ms'),\n        intervalMaxMs: cadenceNumber('intervalMaxMs'),\n        jitterStdMs: cadenceNumber('jitterStdMs'),\n        refreshQuantizedErrorStdMs: cadenceNumber('refreshQuantizedErrorStdMs'),\n        toleranceMs: cadenceNumber('toleranceMs'),\n        lateFrameCount: cadenceNumber('lateFrameCount'),\n        repeatedFrameCount: cadenceNumber('repeatedFrameCount'),\n        irregularPresentCount: cadenceNumber('irregularPresentCount'),\n        longGapCount: cadenceNumber('longGapCount'),\n        lastLongGapMs: cadenceNumber('lastLongGapMs'),\n        displayFrequency: cadenceNumber('displayFrequency'),\n        displayRefreshIntervalMs: cadenceNumber('displayRefreshIntervalMs'),\n        sourceFpsDeviationPct: cadenceNumber('sourceFpsDeviationPct')\n      } : null;`;
const newCadenceParser = `      const parseCadence = source => {\n        if (!source || typeof source !== 'object') return null;\n        const number = key => {\n          const value = Number(source?.[key]);\n          return Number.isFinite(value) ? value : 0;\n        };\n        return {\n          rollingWindowMs: number('rollingWindowMs'),\n          observedSpanMs: number('observedSpanMs'),\n          sampleCount: number('sampleCount'),\n          actualPresentedFps: number('actualPresentedFps'),\n          expectedFps: number('expectedFps'),\n          expectedIntervalMs: number('expectedIntervalMs'),\n          intervalP50Ms: number('intervalP50Ms'),\n          intervalP95Ms: number('intervalP95Ms'),\n          intervalMaxMs: number('intervalMaxMs'),\n          jitterStdMs: number('jitterStdMs'),\n          refreshQuantizedErrorStdMs: number('refreshQuantizedErrorStdMs'),\n          toleranceMs: number('toleranceMs'),\n          lateFrameCount: number('lateFrameCount'),\n          repeatedFrameCount: number('repeatedFrameCount'),\n          irregularPresentCount: number('irregularPresentCount'),\n          longGapCount: number('longGapCount'),\n          lastLongGapMs: number('lastLongGapMs'),\n          displayFrequency: number('displayFrequency'),\n          displayRefreshIntervalMs: number('displayRefreshIntervalMs'),\n          sourceFpsDeviationPct: number('sourceFpsDeviationPct')\n        };\n      };\n      const cadence = parseCadence(payload?.cadence);\n      const receiveCadence = parseCadence(payload?.receiveCadence);`;
bridge = replaceOnce(bridge, oldCadenceParser, newCadenceParser, 'dual cadence parser');
bridge = replaceOnce(
  bridge,
  `        cadence,\n        updatedAt: Date.now()`,
  `        cadence,\n        receiveCadence,\n        updatedAt: Date.now()`,
  'receiver receive cadence diagnostic'
);

for (const marker of ['avgSendSharedTextureMs', 'sendSharedTextureMaxMs', 'nativeCadenceTracker', 'nativeCadence = nativeCadenceTracker.add']) {
  if (!bridge.includes(marker)) throw new Error(`R2X bridge diagnostic marker missing: ${marker}`);
}
for (const marker of ['receiveCadenceTracker', 'lastReceiveCadence', 'receiveCadence: lastReceiveCadence']) {
  if (!preload.includes(marker)) throw new Error(`R2X preload diagnostic marker missing: ${marker}`);
}

write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);

console.log('LIBMPV_R2X_PIPELINE_DIAGNOSTICS_OK stages=native,send,receive,present windowMs=10000');

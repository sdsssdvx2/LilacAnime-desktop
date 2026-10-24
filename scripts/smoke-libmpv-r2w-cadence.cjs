'use strict';
const assert = require('node:assert/strict');
const { createRollingCadenceTracker } = require('../electron/libmpv-cadence.cjs');

function feed(intervals, { fps = 23.976024627685547, hz = 60, startFrame = 1 } = {}) {
  const tracker = createRollingCadenceTracker();
  let t = 0;
  let frameId = startFrame;
  let out = tracker.add({ atMs: t, frameId, expectedFps: fps, displayFrequency: hz });
  for (const interval of intervals) {
    t += interval;
    frameId += 1;
    out = tracker.add({ atMs: t, frameId, expectedFps: fps, displayFrequency: hz });
  }
  return { tracker, out, t, frameId };
}

const exact = feed(Array.from({ length: 220 }, () => 1000 / 23.976024627685547)).out;
assert.ok(exact.actualPresentedFps > 23.95 && exact.actualPresentedFps < 24.01, JSON.stringify(exact));
assert.equal(exact.lateFrameCount, 0);
assert.equal(exact.irregularPresentCount, 0);
assert.ok(exact.jitterStdMs < 0.01);

const cadence60 = feed(Array.from({ length: 220 }, (_, index) => index % 2 ? 50 : (1000 / 30))).out;
assert.ok(cadence60.actualPresentedFps > 23.8 && cadence60.actualPresentedFps < 24.2, JSON.stringify(cadence60));
assert.equal(cadence60.lateFrameCount, 0, JSON.stringify(cadence60));
assert.equal(cadence60.irregularPresentCount, 0, JSON.stringify(cadence60));
assert.ok(cadence60.refreshQuantizedErrorStdMs < 0.01, JSON.stringify(cadence60));

const anomaly = feed([41.7, 41.7, 100, 41.7]).out;
assert.ok(anomaly.lateFrameCount >= 1, JSON.stringify(anomaly));
assert.ok(anomaly.irregularPresentCount >= 1, JSON.stringify(anomaly));

const repeated = createRollingCadenceTracker();
repeated.add({ atMs: 0, frameId: 7, expectedFps: 23.976, displayFrequency: 60 });
const repeatOut = repeated.add({ atMs: 41.7, frameId: 7, expectedFps: 23.976, displayFrequency: 60 });
assert.equal(repeatOut.repeatedFrameCount, 1, JSON.stringify(repeatOut));
assert.equal(repeatOut.irregularPresentCount, 1, JSON.stringify(repeatOut));

const segmented = createRollingCadenceTracker();
segmented.add({ atMs: 0, frameId: 1, expectedFps: 23.976, displayFrequency: 60 });
segmented.add({ atMs: 41.7, frameId: 2, expectedFps: 23.976, displayFrequency: 60 });
const afterPause = segmented.add({ atMs: 3041.7, frameId: 3, expectedFps: 23.976, displayFrequency: 60 });
assert.equal(afterPause.longGapCount, 1, JSON.stringify(afterPause));
assert.equal(afterPause.sampleCount, 1, JSON.stringify(afterPause));
assert.equal(afterPause.lateFrameCount, 0, JSON.stringify(afterPause));

console.log('LIBMPV_R2W_CADENCE_SMOKE_OK', JSON.stringify({ exact, cadence60, anomaly, repeatOut, afterPause }));

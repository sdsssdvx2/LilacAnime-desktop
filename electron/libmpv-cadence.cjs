'use strict';

const round3 = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
const validRate = value => Number.isFinite(value) && value > 1 && value <= 360;

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function createRollingCadenceTracker({ windowMs = 10000, discontinuityMs = 1500 } = {}) {
  let samples = [];
  let discontinuities = [];
  let expectedFps = 0;
  let displayFrequency = 0;

  function trim(now) {
    const cutoff = now - windowMs;
    while (samples.length && samples[0].atMs < cutoff) samples.shift();
    while (discontinuities.length && discontinuities[0].atMs < cutoff) discontinuities.shift();
  }

  function snapshot() {
    const intervals = [];
    let repeatedFrameCount = 0;
    for (let i = 1; i < samples.length; i += 1) {
      intervals.push(samples[i].atMs - samples[i - 1].atMs);
      if (samples[i].frameId > 0 && samples[i].frameId === samples[i - 1].frameId) repeatedFrameCount += 1;
    }
    const sorted = intervals.slice().sort((a, b) => a - b);
    const spanMs = samples.length > 1 ? samples.at(-1).atMs - samples[0].atMs : 0;
    const actualPresentedFps = spanMs > 0 ? ((samples.length - 1) * 1000) / spanMs : 0;
    const expectedIntervalMs = validRate(expectedFps) ? 1000 / expectedFps : 0;
    const displayRefreshIntervalMs = validRate(displayFrequency) ? 1000 / displayFrequency : 0;
    const toleranceMs = expectedIntervalMs
      ? Math.max(4, displayRefreshIntervalMs ? displayRefreshIntervalMs * 1.25 : expectedIntervalMs * 0.28)
      : 0;
    let lateFrameCount = 0;
    let irregularPresentCount = 0;
    for (let i = 0; i < intervals.length; i += 1) {
      const interval = intervals[i];
      const repeated = samples[i + 1].frameId > 0 && samples[i + 1].frameId === samples[i].frameId;
      const early = expectedIntervalMs > 0 && interval < expectedIntervalMs - toleranceMs;
      const late = expectedIntervalMs > 0 && interval > expectedIntervalMs + toleranceMs;
      if (late) lateFrameCount += 1;
      if (repeated || early || late) irregularPresentCount += 1;
    }
    const quantizedErrors = displayRefreshIntervalMs > 0
      ? intervals.map(interval => interval - Math.round(interval / displayRefreshIntervalMs) * displayRefreshIntervalMs)
      : [];
    return {
      rollingWindowMs: windowMs,
      observedSpanMs: round3(spanMs),
      sampleCount: samples.length,
      actualPresentedFps: round3(actualPresentedFps),
      expectedFps: round3(expectedFps),
      expectedIntervalMs: round3(expectedIntervalMs),
      intervalP50Ms: round3(percentile(sorted, 0.50)),
      intervalP95Ms: round3(percentile(sorted, 0.95)),
      intervalMaxMs: round3(sorted.length ? sorted.at(-1) : 0),
      jitterStdMs: round3(stddev(intervals)),
      refreshQuantizedErrorStdMs: round3(stddev(quantizedErrors)),
      toleranceMs: round3(toleranceMs),
      lateFrameCount,
      repeatedFrameCount,
      irregularPresentCount,
      longGapCount: discontinuities.length,
      lastLongGapMs: round3(discontinuities.length ? discontinuities.at(-1).gapMs : 0),
      displayFrequency: round3(displayFrequency),
      displayRefreshIntervalMs: round3(displayRefreshIntervalMs),
      sourceFpsDeviationPct: expectedFps > 0 && actualPresentedFps > 0
        ? round3(Math.abs(actualPresentedFps - expectedFps) / expectedFps * 100)
        : 0
    };
  }

  function add({ atMs, frameId = 0, expectedFps: nextExpectedFps = 0, displayFrequency: nextDisplayFrequency = 0 } = {}) {
    const now = Number(atMs);
    if (!Number.isFinite(now)) return snapshot();
    if (validRate(Number(nextExpectedFps))) expectedFps = Number(nextExpectedFps);
    if (validRate(Number(nextDisplayFrequency))) displayFrequency = Number(nextDisplayFrequency);
    const previous = samples.at(-1);
    if (previous) {
      const gapMs = now - previous.atMs;
      if (gapMs > discontinuityMs) {
        discontinuities.push({ atMs: now, gapMs });
        samples = [];
      }
    }
    samples.push({ atMs: now, frameId: Number(frameId) || 0 });
    trim(now);
    return snapshot();
  }

  function reset() {
    samples = [];
    discontinuities = [];
    expectedFps = 0;
    displayFrequency = 0;
  }

  return { add, snapshot, reset };
}

module.exports = { createRollingCadenceTracker };

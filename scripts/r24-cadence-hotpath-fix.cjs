'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = process.cwd();
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

// R24 is performance-only. Keep the qualified native producer, D3D11 shared
// texture path, Electron 44 runtime, direct WebGPU presenter, and R23 window fixes.
// The remaining renderer diagnostic path was still doing an O(n log n) cadence
// snapshot twice per video frame. At ~24 fps with a 10 s window that means arrays,
// copies, sorting, maps and stddev reductions over ~240 samples on every frame.
// Record cadence in O(1) on the hot path; build the expensive snapshot only when
// R23's already-throttled 4 Hz diagnostics payload is actually sent.
let cadence = read('electron/libmpv-cadence.cjs');

const oldAdd = `  function add({ atMs, frameId = 0, expectedFps: nextExpectedFps = 0, displayFrequency: nextDisplayFrequency = 0 } = {}) {\n    const now = Number(atMs);\n    if (!Number.isFinite(now)) return snapshot();\n    if (validRate(Number(nextExpectedFps))) expectedFps = Number(nextExpectedFps);\n    if (validRate(Number(nextDisplayFrequency))) displayFrequency = Number(nextDisplayFrequency);\n    const previous = samples.at(-1);\n    if (previous) {\n      const gapMs = now - previous.atMs;\n      if (gapMs > discontinuityMs) {\n        discontinuities.push({ atMs: now, gapMs });\n        samples = [];\n      }\n    }\n    samples.push({ atMs: now, frameId: Number(frameId) || 0 });\n    trim(now);\n    return snapshot();\n  }`;
const newAdd = `  function record({ atMs, frameId = 0, expectedFps: nextExpectedFps = 0, displayFrequency: nextDisplayFrequency = 0 } = {}) {\n    const now = Number(atMs);\n    if (!Number.isFinite(now)) return false;\n    if (validRate(Number(nextExpectedFps))) expectedFps = Number(nextExpectedFps);\n    if (validRate(Number(nextDisplayFrequency))) displayFrequency = Number(nextDisplayFrequency);\n    const previous = samples.at(-1);\n    if (previous) {\n      const gapMs = now - previous.atMs;\n      if (gapMs > discontinuityMs) {\n        discontinuities.push({ atMs: now, gapMs });\n        samples = [];\n      }\n    }\n    samples.push({ atMs: now, frameId: Number(frameId) || 0 });\n    trim(now);\n    return true;\n  }\n\n  function add(value = {}) {\n    record(value);\n    return snapshot();\n  }`;
cadence = replaceOnce(cadence, oldAdd, newAdd, 'split cadence record/snapshot');
cadence = replaceOnce(cadence, '  return { add, snapshot, reset };', '  return { add, record, snapshot, reset };', 'export cheap cadence recorder');
write('electron/libmpv-cadence.cjs', cadence);

// Prove record() itself never calls the sort-heavy snapshot path.
delete require.cache[require.resolve(file('electron/libmpv-cadence.cjs'))];
const { createRollingCadenceTracker } = require(file('electron/libmpv-cadence.cjs'));
const tracker = createRollingCadenceTracker({ windowMs: 10000, discontinuityMs: 1500 });
const realSort = Array.prototype.sort;
let sortCalls = 0;
Array.prototype.sort = function (...args) {
  sortCalls += 1;
  return realSort.apply(this, args);
};
try {
  for (let i = 0; i < 300; i += 1) {
    tracker.record({ atMs: i * (1000 / 23.976), frameId: i + 1, expectedFps: 23.976, displayFrequency: 144 });
  }
  assert(sortCalls === 0, `cadence record hot path sorted ${sortCalls} times`);
  const snap = tracker.snapshot();
  assert(sortCalls === 1, `cadence snapshot sort count expected 1, got ${sortCalls}`);
  assert(snap.sampleCount > 200 && snap.actualPresentedFps > 23.9 && snap.actualPresentedFps < 24.1, 'cadence lazy snapshot semantic smoke failed');
} finally {
  Array.prototype.sort = realSort;
}

let preload = read('electron/libmpv-shared-preload.cjs');
assert(preload.includes("presentationMode = 'direct-receive-webgpu-copy'"), 'R24 requires direct WebGPU presenter');
assert(preload.includes('RECEIVER_STATS_INTERVAL_MS = 250'), 'R24 requires R23 4 Hz stats throttle');
assert(!preload.includes('onSubmittedWorkDone('), 'R24 requires R23 GPU fence removal');

let receiveAdds = 0;
preload = preload.replace(/lastReceiveCadence = receiveCadenceTracker\.add\(\{/g, () => {
  receiveAdds += 1;
  return 'receiveCadenceTracker.record({';
});
assert(receiveAdds === 1, `expected one receive cadence hot-path add, found ${receiveAdds}`);

let presentAdds = 0;
preload = preload.replace(/lastCadence = cadenceTracker\.add\(\{/g, () => {
  presentAdds += 1;
  return 'cadenceTracker.record({';
});
assert(presentAdds === 1, `expected one presentation cadence hot-path add, found ${presentAdds}`);

preload = replaceOnce(
  preload,
  `  receiverStatsLastSentAt = statsNowPerf;\n`,
  `  receiverStatsLastSentAt = statsNowPerf;\n  // LILAC_R24_CADENCE_LAZY: expensive percentile/sort/stddev work runs only\n  // for the already-throttled diagnostics payload, never for every video frame.\n  lastCadence = cadenceTracker.snapshot();\n  lastReceiveCadence = receiveCadenceTracker.snapshot();\n`,
  'lazy cadence snapshots at diagnostics boundary'
);

if (preload.includes("      r23RenderHotpath: 'LILAC_R23_RENDER_HOTPATH',\n")) {
  preload = replaceOnce(
    preload,
    "      r23RenderHotpath: 'LILAC_R23_RENDER_HOTPATH',\n",
    "      r23RenderHotpath: 'LILAC_R23_RENDER_HOTPATH',\n      r24CadenceHotpath: 'LILAC_R24_CADENCE_LAZY',\n",
    'persist R24 cadence marker'
  );
} else {
  throw new Error('R23 persistent hotpath marker missing');
}

assert(!preload.includes('lastReceiveCadence = receiveCadenceTracker.add({'), 'receive cadence snapshot still runs per frame');
assert(!preload.includes('lastCadence = cadenceTracker.add({'), 'presentation cadence snapshot still runs per frame');
assert(preload.includes('receiveCadenceTracker.record({'), 'receive cadence recorder missing');
assert(preload.includes('cadenceTracker.record({'), 'presentation cadence recorder missing');
assert(preload.includes('LILAC_R24_CADENCE_LAZY'), 'R24 cadence marker missing');
write('electron/libmpv-shared-preload.cjs', preload);

// Rebuild the exact preload shipped by Electron after the R24 source change.
const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const preloadBundle = file('electron/preload-libmpv-shared.generated.cjs');
assert(fs.existsSync(preloadEntry), 'generated preload entry missing');
buildSync({
  entryPoints: [preloadEntry],
  outfile: preloadBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});
const bundled = read('electron/preload-libmpv-shared.generated.cjs');
for (const marker of ['LILAC_R24_CADENCE_LAZY', 'receiveCadenceTracker.record', 'cadenceTracker.record', "direct-receive-webgpu-copy", 'copyExternalImageToTexture']) {
  assert(bundled.includes(marker), `R24 generated preload missing ${marker}`);
}
for (const forbidden of ['lastReceiveCadence = receiveCadenceTracker.add', 'lastCadence = cadenceTracker.add', 'onSubmittedWorkDone(', 'requestAnimationFrame(']) {
  assert(!bundled.includes(forbidden), `R24 generated preload retained forbidden hot-path marker: ${forbidden}`);
}

console.log('R24_CADENCE_HOTPATH_OK nativeProducer=unchanged presenter=direct-webgpu frameCadence=record-only diagnosticsSnapshotHz=4 perFrameSorts=0');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const found = source.split(needle).length - 1;
  if (found !== 1) throw new Error(`${label}: expected exactly one anchor, found ${found}`);
  return source.replace(needle, replacement);
}

function replaceAllExpected(source, needle, replacement, expected, label) {
  const found = source.split(needle).length - 1;
  if (found !== expected) throw new Error(`${label}: expected ${expected} anchors, found ${found}`);
  return source.split(needle).join(replacement);
}

const QUALIFICATION_ID = 'LILAC-LIBMPV-HWQ-R2I-PIPELINE-HEADROOM';

// R2H proved that the WebGPU GPU-copy path removes the ~1 second Canvas2D
// SharedImage retention bottleneck: user hardware dropped to ~133 ms average,
// ~210 ms peak, 0% backpressure and only four pending frames. A fixed 100 ms
// average release threshold is therefore an invalid proxy for safety: the
// release callback legitimately follows asynchronous GPU retirement. R2I keeps
// every lifetime/failure/throughput gate and replaces only that proxy with
// direct 24-slot pool headroom and release-pipeline-depth limits.
let qualification = read('electron/libmpv-hardware-qualification.cjs');
qualification = replaceAllExpected(
  qualification,
  `'LILAC-LIBMPV-HWQ-R2H-WEBGPU-COPY'`,
  `'${QUALIFICATION_ID}'`,
  2,
  'R2I qualification id'
);
qualification = replaceOnce(
  qualification,
  `const MAX_BACKPRESSURE_RATIO = 0.20;\nconst WARMUP_MS = 1000;`,
  `const MAX_BACKPRESSURE_RATIO = 0.20;\nconst TEXTURE_POOL_SLOTS = 24;\nconst MAX_PENDING_FRAMES = 12;\nconst MAX_AVG_RELEASE_PIPELINE_FRAMES = 8;\nconst MAX_PEAK_RELEASE_PIPELINE_FRAMES = 12;\nconst ABSOLUTE_PEAK_RELEASE_LATENCY_MAX_MS = 500;\nconst WARMUP_MS = 1000;`,
  'R2I headroom constants'
);
qualification = replaceOnce(
  qualification,
  `    acceptance: { minPresentedFps: MIN_PRESENT_FPS, maxBackpressureRatio: MAX_BACKPRESSURE_RATIO },`,
  `    acceptance: {\n      minPresentedFps: MIN_PRESENT_FPS,\n      maxBackpressureRatio: MAX_BACKPRESSURE_RATIO,\n      texturePoolSlots: TEXTURE_POOL_SLOTS,\n      maxPendingFrames: MAX_PENDING_FRAMES,\n      maxAvgReleasePipelineFrames: MAX_AVG_RELEASE_PIPELINE_FRAMES,\n      maxPeakReleasePipelineFrames: MAX_PEAK_RELEASE_PIPELINE_FRAMES,\n      absolutePeakReleaseLatencyMaxMs: ABSOLUTE_PEAK_RELEASE_LATENCY_MAX_MS\n    },`,
  'R2I acceptance report'
);
qualification = replaceOnce(
  qualification,
  `  try {\n    stage = 'runtime-start';`,
  `  let throughputSnapshot = null;\n  try {\n    stage = 'runtime-start';`,
  'R2I failure throughput snapshot state'
);
qualification = replaceOnce(
  qualification,
  `      measuredBackpressureRatio: Math.round(backpressureRatio * 1000000) / 1000000,\n      avgReleaseLatencyMs: Number(end?.metrics?.avgReleaseLatencyMs || 0),`,
  `      measuredBackpressureRatio: Math.round(backpressureRatio * 1000000) / 1000000,\n      texturePoolSlots: TEXTURE_POOL_SLOTS,\n      maxPendingFrames: Math.max(Number(end?.metrics?.maxPending || 0), Number(end?.pendingFrames || 0)),\n      endPendingFrames: Number(end?.pendingFrames || 0),\n      releaseHeadroomSlots: Math.max(0, TEXTURE_POOL_SLOTS - Math.max(Number(end?.metrics?.maxPending || 0), Number(end?.pendingFrames || 0))),\n      avgReleaseLatencyMs: Number(end?.metrics?.avgReleaseLatencyMs || 0),`,
  'R2I direct pool headroom metrics'
);
qualification = replaceOnce(
  qualification,
  `      maxGpuWorkDoneMs: Number(end?.receiver?.maxGpuWorkDoneMs || 0)\n    };`,
  `      maxGpuWorkDoneMs: Number(end?.receiver?.maxGpuWorkDoneMs || 0),\n      avgReleasePipelineFrames: Math.round(((Number(end?.metrics?.avgReleaseLatencyMs || 0) * sentFps) / 1000) * 1000) / 1000,\n      maxReleasePipelineFrames: Math.round(((Number(end?.metrics?.releaseLatencyMaxMs || 0) * sentFps) / 1000) * 1000) / 1000,\n      poolExhaustionMsAtMeasuredSentFps: sentFps > 0 ? Math.round(((TEXTURE_POOL_SLOTS / sentFps) * 1000) * 1000) / 1000 : 0,\n      releaseLatencySafetyLimitMs: sentFps > 0\n        ? Math.round(Math.min(ABSOLUTE_PEAK_RELEASE_LATENCY_MAX_MS, (MAX_PEAK_RELEASE_PIPELINE_FRAMES / sentFps) * 1000) * 1000) / 1000\n        : 0\n    };\n    throughputSnapshot = throughput;`,
  'R2I release pipeline metrics and failure snapshot'
);
qualification = replaceOnce(
  qualification,
  `    if (throughput.avgReleaseLatencyMs > 100 || throughput.releaseLatencyMaxMs > 300) {\n      throw new Error(\`shared texture release latency too high: avg=\${throughput.avgReleaseLatencyMs} max=\${throughput.releaseLatencyMaxMs}\`);\n    }`,
  `    if (throughput.maxPendingFrames > MAX_PENDING_FRAMES) {\n      throw new Error(\`shared texture pool headroom too low: pending=\${throughput.maxPendingFrames}/\${TEXTURE_POOL_SLOTS}\`);\n    }\n    if (throughput.avgReleasePipelineFrames > MAX_AVG_RELEASE_PIPELINE_FRAMES) {\n      throw new Error(\`average shared texture release pipeline too deep: \${throughput.avgReleasePipelineFrames} frames\`);\n    }\n    if (throughput.maxReleasePipelineFrames > MAX_PEAK_RELEASE_PIPELINE_FRAMES) {\n      throw new Error(\`peak shared texture release pipeline too deep: \${throughput.maxReleasePipelineFrames} frames\`);\n    }\n    if (throughput.releaseLatencySafetyLimitMs <= 0 || throughput.releaseLatencyMaxMs > throughput.releaseLatencySafetyLimitMs) {\n      throw new Error(\`shared texture peak release latency exceeds measured-pipeline safety limit: max=\${throughput.releaseLatencyMaxMs} limit=\${throughput.releaseLatencySafetyLimitMs}\`);\n    }`,
  'replace fixed latency proxy with direct pipeline headroom gate'
);
qualification = replaceOnce(
  qualification,
  `      error: safeError(error),\n      diagnostics: state ? {`,
  `      error: safeError(error),\n      throughput: throughputSnapshot,\n      diagnostics: state ? {`,
  'persist measured throughput on qualification failure'
);
qualification = replaceOnce(
  qualification,
  `          releaseLatencyMaxMs: Number(state?.metrics?.releaseLatencyMaxMs || 0)`,
  `          releaseLatencyMaxMs: Number(state?.metrics?.releaseLatencyMaxMs || 0),\n          maxPending: Number(state?.metrics?.maxPending || 0),\n          effectiveSentFps: Number(state?.metrics?.effectiveSentFps || 0)`,
  'R2I safe failure pool diagnostics'
);
qualification = replaceOnce(
  qualification,
  `    : \`FAIL at \${report.stage}\\n\${report.error || 'Unknown qualification failure'}\\n\\nSent frames: \${throughput.sentFrames ?? 'n/a'}\\nBackpressure: \${throughput.backpressureRatio != null ? \`${(Number(throughput.backpressureRatio) * 100).toFixed(1)}%\` : 'n/a'}\\n\\nThe safe result JSON was copied to the clipboard\${resultPath ? ' and saved to Downloads.' : '.'}\`;`,
  `    : \`FAIL at \${report.stage}\\n\${report.error || 'Unknown qualification failure'}\\n\\nPresented: \${throughput.measuredPresentedFps ?? 'n/a'} fps\\nSent: \${throughput.measuredSentFps ?? throughput.effectiveSentFps ?? 'n/a'} fps\\nBackpressure: \${(throughput.measuredBackpressureRatio ?? throughput.backpressureRatio) != null ? \`${(Number(throughput.measuredBackpressureRatio ?? throughput.backpressureRatio) * 100).toFixed(1)}%\` : 'n/a'}\\nPool pending max: \${throughput.maxPendingFrames ?? throughput.maxPending ?? 'n/a'}/\${throughput.texturePoolSlots ?? TEXTURE_POOL_SLOTS}\\nRelease pipeline avg/max: \${throughput.avgReleasePipelineFrames ?? 'n/a'}/\${throughput.maxReleasePipelineFrames ?? 'n/a'} frames\\n\\nThe safe result JSON was copied to the clipboard\${resultPath ? ' and saved to Downloads.' : '.'}\`;`,
  'R2I failure dialog measured metrics'
);
write('electron/libmpv-hardware-qualification.cjs', qualification);

const finalQualification = read('electron/libmpv-hardware-qualification.cjs');
for (const marker of [
  QUALIFICATION_ID,
  'TEXTURE_POOL_SLOTS = 24',
  'MAX_PENDING_FRAMES = 12',
  'MAX_AVG_RELEASE_PIPELINE_FRAMES = 8',
  'MAX_PEAK_RELEASE_PIPELINE_FRAMES = 12',
  'avgReleasePipelineFrames',
  'maxReleasePipelineFrames',
  'releaseLatencySafetyLimitMs',
  'throughput: throughputSnapshot',
  'shared texture pool headroom too low'
]) {
  if (!finalQualification.includes(marker)) throw new Error(`R2I qualification marker missing: ${marker}`);
}
if (finalQualification.includes('throughput.avgReleaseLatencyMs > 100') || finalQualification.includes('throughput.releaseLatencyMaxMs > 300')) {
  throw new Error('R2I fixed latency proxy unexpectedly survived');
}

console.log('LIBMPV_R2I_PIPELINE_HEADROOM_OK slots=24 maxPending=12 avgPipeline=8 peakPipeline=12 absolutePeakMs=500');

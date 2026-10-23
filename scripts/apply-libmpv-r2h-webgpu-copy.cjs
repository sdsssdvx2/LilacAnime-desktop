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

const QUALIFICATION_ID = 'LILAC-LIBMPV-HWQ-R2H-WEBGPU-COPY';

// R2H keeps the proven R2F immediate receiver lifetime, but changes the renderer
// from Canvas2D drawImage(VideoFrame) to an explicit GPU->GPU copy into the
// WebGPU canvas texture. The source VideoFrame/imported texture is released in
// the same receiver turn after the copy has been enqueued; Chromium retains the
// source internally until the GPU copy is complete.
let preload = read('electron/libmpv-shared-preload.cjs');
preload = replaceOnce(
  preload,
  `const contextCache = new WeakMap();`,
  `const gpuStateCache = new WeakMap();\nconst rendererMode = 'webgpu-copy';\nlet gpuInitFailures = 0;\nlet gpuInitDrops = 0;\nlet gpuCopyFrames = 0;\nlet gpuCopyFailures = 0;\nlet gpuCopySubmitSamples = 0;\nlet gpuCopySubmitTotalMs = 0;\nlet gpuCopySubmitMaxMs = 0;\nlet gpuWorkDoneSamples = 0;\nlet gpuWorkDoneTotalMs = 0;\nlet gpuWorkDoneMaxMs = 0;\nlet lastGpuError = null;`,
  'WebGPU renderer state'
);
preload = replaceOnce(
  preload,
  `function contextFor(canvas) {\n  let context = contextCache.get(canvas);\n  if (!context) {\n    context = canvas.getContext('2d', { alpha: false, desynchronized: true });\n    if (context) contextCache.set(canvas, context);\n  }\n  return context;\n}`,
  `function gpuStateFor(canvas) {\n  let state = gpuStateCache.get(canvas);\n  if (state) return state;\n  state = { status: 'initializing', canvas, adapter: null, device: null, context: null, format: null, width: 0, height: 0, error: null };\n  gpuStateCache.set(canvas, state);\n  void (async () => {\n    try {\n      if (!navigator.gpu) throw new Error('WebGPU unavailable');\n      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });\n      if (!adapter) throw new Error('WebGPU adapter unavailable');\n      const device = await adapter.requestDevice();\n      const context = canvas.getContext('webgpu');\n      if (!context) throw new Error('WebGPU canvas context unavailable');\n      state.adapter = adapter;\n      state.device = device;\n      state.context = context;\n      state.format = navigator.gpu.getPreferredCanvasFormat();\n      state.status = 'ready';\n      device.lost.then(info => {\n        state.status = 'failed';\n        state.error = String(info?.message || 'WebGPU device lost').slice(0, 160);\n        lastGpuError = state.error;\n        gpuInitFailures += 1;\n      }).catch(() => {});\n    } catch (error) {\n      state.status = 'failed';\n      state.error = String(error?.message || error).slice(0, 160);\n      lastGpuError = state.error;\n      gpuInitFailures += 1;\n    }\n  })();\n  return state;\n}\n\nfunction configureGpu(state, canvas, width, height) {\n  if (!state || state.status !== 'ready' || !state.device || !state.context) return false;\n  if (state.width === width && state.height === height) return true;\n  const usage = globalThis.GPUTextureUsage;\n  if (!usage) throw new Error('GPUTextureUsage unavailable');\n  state.context.configure({\n    device: state.device,\n    format: state.format,\n    alphaMode: 'opaque',\n    usage: usage.COPY_DST | usage.RENDER_ATTACHMENT\n  });\n  state.width = width;\n  state.height = height;\n  return true;\n}`,
  'replace Canvas2D cache with WebGPU copy state'
);
preload = replaceOnce(
  preload,
  `      context2d: Boolean(canvas && contextFor(canvas))`,
  `      context2d: false,\n      webgpu: Boolean(canvas && navigator.gpu),\n      rendererMode`,
  'surface probe renderer mode'
);
preload = replaceOnce(
  preload,
  `      textureReleaseFailures,\n      ...extra`,
  `      textureReleaseFailures,\n      rendererMode,\n      gpuReady: Boolean(findSurface().canvas && gpuStateCache.get(findSurface().canvas)?.status === 'ready'),\n      gpuInitFailures,\n      gpuInitDrops,\n      gpuCopyFrames,\n      gpuCopyFailures,\n      avgGpuCopySubmitMs: gpuCopySubmitSamples ? Math.round((gpuCopySubmitTotalMs / gpuCopySubmitSamples) * 1000) / 1000 : 0,\n      maxGpuCopySubmitMs: Math.round(gpuCopySubmitMaxMs * 1000) / 1000,\n      avgGpuWorkDoneMs: gpuWorkDoneSamples ? Math.round((gpuWorkDoneTotalMs / gpuWorkDoneSamples) * 1000) / 1000 : 0,\n      maxGpuWorkDoneMs: Math.round(gpuWorkDoneMaxMs * 1000) / 1000,\n      lastGpuError,\n      ...extra`,
  'WebGPU receiver diagnostics'
);
preload = replaceOnce(
  preload,
  `      const context = contextFor(canvas);\n      if (!context) throw new Error('2D canvas context unavailable');\n      frame = importedSharedTexture.getVideoFrame();\n      videoFramesCreated += 1;\n      activeVideoFrames += 1;\n      const drawStarted = performance.now();\n      context.drawImage(frame, 0, 0, width, height);\n      lastDrawMs = performance.now() - drawStarted;\n      drawSamples += 1;\n      drawTotalMs += lastDrawMs;\n      maxDrawMs = Math.max(maxDrawMs, lastDrawMs);\n      // R2F qualification: drawImage has queued the GPU-backed draw. Close the\n      // VideoFrame and release the imported texture in this same receiver turn so\n      // producer ownership cannot accumulate behind compositor callbacks.\n      presentedFrames += 1;`,
  `      const gpu = gpuStateFor(canvas);\n      if (gpu.status !== 'ready') {\n        if (gpu.status === 'failed') throw new Error(gpu.error || 'WebGPU initialization failed');\n        gpuInitDrops += 1;\n        sendStats({ lastFrameId: Number(metadata.frameId) || 0, playerId: Number(metadata.playerId) || 0, width, height, reason: 'gpu-initializing' });\n        return;\n      }\n      configureGpu(gpu, canvas, width, height);\n      frame = importedSharedTexture.getVideoFrame();\n      videoFramesCreated += 1;\n      activeVideoFrames += 1;\n      const drawStarted = performance.now();\n      try {\n        gpu.device.queue.copyExternalImageToTexture(\n          { source: frame },\n          { texture: gpu.context.getCurrentTexture() },\n          { width, height, depthOrArrayLayers: 1 }\n        );\n      } catch (error) {\n        gpuCopyFailures += 1;\n        lastGpuError = String(error?.message || error).slice(0, 160);\n        throw error;\n      }\n      lastDrawMs = performance.now() - drawStarted;\n      gpuCopyFrames += 1;\n      gpuCopySubmitSamples += 1;\n      gpuCopySubmitTotalMs += lastDrawMs;\n      gpuCopySubmitMaxMs = Math.max(gpuCopySubmitMaxMs, lastDrawMs);\n      drawSamples += 1;\n      drawTotalMs += lastDrawMs;\n      maxDrawMs = Math.max(maxDrawMs, lastDrawMs);\n      if (gpuCopyFrames % 24 === 1) {\n        const workStarted = performance.now();\n        void gpu.device.queue.onSubmittedWorkDone().then(() => {\n          const elapsed = performance.now() - workStarted;\n          gpuWorkDoneSamples += 1;\n          gpuWorkDoneTotalMs += elapsed;\n          gpuWorkDoneMaxMs = Math.max(gpuWorkDoneMaxMs, elapsed);\n        }).catch(error => {\n          lastGpuError = String(error?.message || error).slice(0, 160);\n        });\n      }\n      // copyExternalImageToTexture enqueues an explicit GPU copy into Chromium's\n      // canvas texture. The source frame can be closed now; Electron/Chromium\n      // keeps the underlying SharedImage alive until the queued GPU copy retires.\n      presentedFrames += 1;`,
  'replace direct Canvas2D draw with WebGPU GPU-copy path'
);
write('electron/libmpv-shared-preload.cjs', preload);

let bridge = read('electron/libmpv-shared-main.cjs');
bridge = replaceOnce(
  bridge,
  `        textureReleaseFailures: numeric('textureReleaseFailures'),\n        lastFrameAt: numeric('lastFrameAt'),`,
  `        textureReleaseFailures: numeric('textureReleaseFailures'),\n        rendererMode: payload?.rendererMode ? String(payload.rendererMode).slice(0, 40) : null,\n        gpuReady: payload?.gpuReady === true,\n        gpuInitFailures: numeric('gpuInitFailures'),\n        gpuInitDrops: numeric('gpuInitDrops'),\n        gpuCopyFrames: numeric('gpuCopyFrames'),\n        gpuCopyFailures: numeric('gpuCopyFailures'),\n        avgGpuCopySubmitMs: numeric('avgGpuCopySubmitMs'),\n        maxGpuCopySubmitMs: numeric('maxGpuCopySubmitMs'),\n        avgGpuWorkDoneMs: numeric('avgGpuWorkDoneMs'),\n        maxGpuWorkDoneMs: numeric('maxGpuWorkDoneMs'),\n        lastGpuError: payload?.lastGpuError ? String(payload.lastGpuError).slice(0, 160) : null,\n        lastFrameAt: numeric('lastFrameAt'),`,
  'bridge WebGPU stats parser'
);
write('electron/libmpv-shared-main.cjs', bridge);

let qualification = read('electron/libmpv-hardware-qualification.cjs');
qualification = replaceAllExpected(qualification, `'LILAC-LIBMPV-HWQ-R2F-E44'`, `'${QUALIFICATION_ID}'`, 2, 'R2H qualification id');
qualification = replaceOnce(
  qualification,
  `    lifetimeDiagnostics: preload.includes('activeVideoFrames') && preload.includes('videoFrameCloseFailures') && preload.includes('textureReleaseFailures'),`,
  `    lifetimeDiagnostics: preload.includes('activeVideoFrames') && preload.includes('videoFrameCloseFailures') && preload.includes('textureReleaseFailures'),\n    gpuCopyRenderer: preload.includes("rendererMode = 'webgpu-copy'") && preload.includes('copyExternalImageToTexture') && !preload.includes("getContext('2d'"),`,
  'qualification WebGPU architecture marker'
);
qualification = replaceOnce(
  qualification,
  `      textureReleaseFailures: Number(end?.receiver?.textureReleaseFailures || 0)\n    };`,
  `      textureReleaseFailures: Number(end?.receiver?.textureReleaseFailures || 0),\n      rendererMode: end?.receiver?.rendererMode || null,\n      gpuReady: end?.receiver?.gpuReady === true,\n      gpuInitFailures: Number(end?.receiver?.gpuInitFailures || 0),\n      gpuInitDrops: Number(end?.receiver?.gpuInitDrops || 0),\n      gpuCopyFrames: Number(end?.receiver?.gpuCopyFrames || 0),\n      gpuCopyFailures: Number(end?.receiver?.gpuCopyFailures || 0),\n      avgGpuCopySubmitMs: Number(end?.receiver?.avgGpuCopySubmitMs || 0),\n      maxGpuCopySubmitMs: Number(end?.receiver?.maxGpuCopySubmitMs || 0),\n      avgGpuWorkDoneMs: Number(end?.receiver?.avgGpuWorkDoneMs || 0),\n      maxGpuWorkDoneMs: Number(end?.receiver?.maxGpuWorkDoneMs || 0)\n    };`,
  'qualification WebGPU throughput diagnostics'
);
qualification = replaceOnce(
  qualification,
  `    const unclosedVideoFrames = Math.max(0, throughput.videoFramesCreated - throughput.videoFramesClosed);`,
  `    if (throughput.rendererMode !== 'webgpu-copy' || throughput.gpuReady !== true) throw new Error('WebGPU copy renderer did not become ready');\n    if (throughput.gpuInitFailures !== 0) throw new Error(\`WebGPU initialization failures: \${throughput.gpuInitFailures}\`);\n    if (throughput.gpuCopyFailures !== 0) throw new Error(\`WebGPU copy failures: \${throughput.gpuCopyFailures}\`);\n    if (throughput.gpuCopyFrames < throughput.measuredPresentedFrames) throw new Error('presented frame bypassed WebGPU copy path');\n    const unclosedVideoFrames = Math.max(0, throughput.videoFramesCreated - throughput.videoFramesClosed);`,
  'qualification WebGPU gates'
);
qualification = replaceOnce(
  qualification,
  `          textureReleaseFailures: Number(state?.receiver?.textureReleaseFailures || 0)\n        },`,
  `          textureReleaseFailures: Number(state?.receiver?.textureReleaseFailures || 0),\n          rendererMode: state?.receiver?.rendererMode || null,\n          gpuReady: state?.receiver?.gpuReady === true,\n          gpuInitFailures: Number(state?.receiver?.gpuInitFailures || 0),\n          gpuInitDrops: Number(state?.receiver?.gpuInitDrops || 0),\n          gpuCopyFrames: Number(state?.receiver?.gpuCopyFrames || 0),\n          gpuCopyFailures: Number(state?.receiver?.gpuCopyFailures || 0),\n          avgGpuCopySubmitMs: Number(state?.receiver?.avgGpuCopySubmitMs || 0),\n          maxGpuCopySubmitMs: Number(state?.receiver?.maxGpuCopySubmitMs || 0),\n          avgGpuWorkDoneMs: Number(state?.receiver?.avgGpuWorkDoneMs || 0),\n          maxGpuWorkDoneMs: Number(state?.receiver?.maxGpuWorkDoneMs || 0),\n          lastGpuError: state?.receiver?.lastGpuError || null\n        },`,
  'qualification WebGPU failure diagnostics'
);
write('electron/libmpv-hardware-qualification.cjs', qualification);

const finalPreload = read('electron/libmpv-shared-preload.cjs');
for (const forbidden of ["getContext('2d'", 'nextCompositorTurn', 'setSharedTextureReceiver(async']) {
  if (finalPreload.includes(forbidden)) throw new Error(`R2H forbidden renderer marker remains: ${forbidden}`);
}
for (const marker of ["rendererMode = 'webgpu-copy'", "getContext('webgpu')", 'copyExternalImageToTexture', 'onSubmittedWorkDone', 'textureReleaseCalls']) {
  if (!finalPreload.includes(marker)) throw new Error(`R2H preload marker missing: ${marker}`);
}
const finalQualification = read('electron/libmpv-hardware-qualification.cjs');
for (const marker of [QUALIFICATION_ID, 'gpuCopyRenderer', 'WebGPU copy renderer did not become ready', 'avgGpuWorkDoneMs']) {
  if (!finalQualification.includes(marker)) throw new Error(`R2H qualification marker missing: ${marker}`);
}

console.log('LIBMPV_R2H_WEBGPU_COPY_OK mode=webgpu-copy compositorHold=0');

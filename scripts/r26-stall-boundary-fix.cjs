'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

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

if (!bridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX')) throw new Error('R26 requires R24 latest-frame mailbox');
if (!preload.includes('LILAC_R24_CADENCE_LAZY')) throw new Error('R26 requires R24 lazy cadence diagnostics');
if (!preload.includes("presentationMode = 'direct-receive-webgpu-copy'")) throw new Error('R26 requires direct WebGPU presenter');
if (preload.includes('LILAC_R26_STALL_BOUNDARY_TRACE') || bridge.includes('LILAC_R26_STALL_BOUNDARY_TRACE')) throw new Error('R26 trace already applied');

// Keep the normal playback path behavior-identical. Each process writes only to a
// fixed-size O(1) ring. The renderer ring crosses IPC only when the existing
// diagnostics API is explicitly requested, never once per frame.
bridge = replaceOnce(
  bridge,
  '  let deliveryQueuedLatest = null; // LILAC_R24_LATEST_FRAME_MAILBOX',
  `  let deliveryQueuedLatest = null; // LILAC_R24_LATEST_FRAME_MAILBOX LILAC_R26_STALL_BOUNDARY_TRACE\n  const R26_TRACE_CAPACITY = 256;\n  const r26MainTrace = new Array(R26_TRACE_CAPACITY);\n  let r26MainTraceNext = 0;\n  let r26MainTraceCount = 0;\n  let r26TraceRequestId = 0;\n  const r26TraceWaiters = new Map();\n\n  function r26PushMainTrace(entry) {\n    r26MainTrace[r26MainTraceNext] = entry;\n    r26MainTraceNext = (r26MainTraceNext + 1) % R26_TRACE_CAPACITY;\n    r26MainTraceCount = Math.min(R26_TRACE_CAPACITY, r26MainTraceCount + 1);\n    return entry;\n  }\n\n  function r26SnapshotMainTrace() {\n    const out = [];\n    const start = (r26MainTraceNext - r26MainTraceCount + R26_TRACE_CAPACITY) % R26_TRACE_CAPACITY;\n    for (let i = 0; i < r26MainTraceCount; i += 1) out.push({ ...r26MainTrace[(start + i) % R26_TRACE_CAPACITY] });\n    return out;\n  }\n\n  function r26RequestRendererTrace(timeoutMs = 250) {\n    if (!attachedWindow || attachedWindow.isDestroyed() || attachedWindow.webContents.isDestroyed()) return Promise.resolve(null);\n    const requestId = ++r26TraceRequestId;\n    return new Promise(resolve => {\n      const timer = setTimeout(() => {\n        r26TraceWaiters.delete(requestId);\n        resolve({ ok: false, timeout: true, requestId });\n      }, Math.max(25, timeoutMs));\n      r26TraceWaiters.set(requestId, payload => {\n        clearTimeout(timer);\n        resolve(payload);\n      });\n      try {\n        attachedWindow.webContents.send('libmpv-shared:r26-trace-request', { requestId });\n      } catch {\n        clearTimeout(timer);\n        r26TraceWaiters.delete(requestId);\n        resolve({ ok: false, sendFailed: true, requestId });\n      }\n    });\n  }`,
  'main trace ring state'
);

bridge = replaceOnce(
  bridge,
  `      sendStarted = performance.now();\n      let sendPromise;\n      const invokeStarted = performance.now();`,
  `      sendStarted = performance.now();\n      const r26DispatchWallMs = Date.now();\n      const r26DispatchPerfMs = performance.now();\n      const r26Trace = r26PushMainTrace({\n        frameId: Number(frameId) || 0,\n        timestampUs: Number(timestampUs) || 0,\n        dispatchWallMs: r26DispatchWallMs,\n        invokeMs: 0,\n        sendDoneWallMs: 0,\n        sendMs: 0\n      });\n      let sendPromise;\n      const invokeStarted = performance.now();`,
  'main dispatch timestamp'
);
bridge = replaceOnce(
  bridge,
  `          timestampUs,\n          fps,\n          displayFrequency\n        });`,
  `          timestampUs,\n          fps,\n          displayFrequency,\n          r26DispatchWallMs\n        });`,
  'dispatch wall clock metadata'
);
bridge = replaceOnce(
  bridge,
  `        const invokeElapsed = Math.max(0, performance.now() - invokeStarted);\n        metrics.sendInvokeSamples += 1;`,
  `        const invokeElapsed = Math.max(0, performance.now() - invokeStarted);\n        r26Trace.invokeMs = invokeElapsed;\n        metrics.sendInvokeSamples += 1;`,
  'main invoke trace'
);
bridge = replaceOnce(
  bridge,
  `      await sendPromise;\n      metrics.sentFrames += 1;`,
  `      await sendPromise;\n      r26Trace.sendDoneWallMs = Date.now();\n      r26Trace.sendMs = Math.max(0, performance.now() - r26DispatchPerfMs);\n      metrics.sentFrames += 1;`,
  'main send completion trace'
);

const oldDiagnostics = `    ipcMain.handle('libmpv-shared:diagnostics', () => ({\n      diagnosticVersion: 'LIBMPV-SHARED-D1',\n      ...state(),\n      receiverReady: { ...receiverReady },\n      receiver: { ...receiverStats },\n      relay: relay.stats()\n    }));`;
const newDiagnostics = `    ipcMain.handle('libmpv-shared:diagnostics', async () => {\n      const rendererTrace = await r26RequestRendererTrace();\n      return {\n        diagnosticVersion: 'LIBMPV-SHARED-D1',\n        ...state(),\n        receiverReady: { ...receiverReady },\n        receiver: { ...receiverStats },\n        relay: relay.stats(),\n        r26BoundaryTrace: {\n          version: 1,\n          capacity: R26_TRACE_CAPACITY,\n          capturedAtWallMs: Date.now(),\n          main: r26SnapshotMainTrace(),\n          renderer: rendererTrace\n        }\n      };\n    });`;
bridge = replaceOnce(bridge, oldDiagnostics, newDiagnostics, 'on-demand diagnostics trace snapshot');
bridge = replaceOnce(
  bridge,
  `    ipcMain.on('libmpv-shared:receiver-ready', (event, payload = {}) => {`,
  `    ipcMain.on('libmpv-shared:r26-trace-response', (event, payload = {}) => {\n      if (!senderIsAttached(event)) return;\n      const requestId = Number(payload?.requestId) || 0;\n      const resolve = r26TraceWaiters.get(requestId);\n      if (!resolve) return;\n      r26TraceWaiters.delete(requestId);\n      resolve(payload);\n    });\n\n    ipcMain.on('libmpv-shared:receiver-ready', (event, payload = {}) => {`,
  'renderer trace response listener'
);

preload = replaceOnce(
  preload,
  'let lastFrameAt = 0;',
  `let lastFrameAt = 0; // LILAC_R26_STALL_BOUNDARY_TRACE\nconst R26_TRACE_CAPACITY = 256;\nconst r26RendererTrace = new Array(R26_TRACE_CAPACITY);\nlet r26RendererTraceNext = 0;\nlet r26RendererTraceCount = 0;\nlet r26LastReceiverPerfMs = 0;\nlet r26MaxTransportMs = 0;\nlet r26MaxReceiverGapMs = 0;\nlet r26MaxCallbackMs = 0;\nlet r26WorstTransportFrameId = 0;\n\nfunction r26PushRendererTrace(entry) {\n  r26RendererTrace[r26RendererTraceNext] = entry;\n  r26RendererTraceNext = (r26RendererTraceNext + 1) % R26_TRACE_CAPACITY;\n  r26RendererTraceCount = Math.min(R26_TRACE_CAPACITY, r26RendererTraceCount + 1);\n  return entry;\n}\n\nfunction r26SnapshotRendererTrace() {\n  const events = [];\n  const start = (r26RendererTraceNext - r26RendererTraceCount + R26_TRACE_CAPACITY) % R26_TRACE_CAPACITY;\n  for (let i = 0; i < r26RendererTraceCount; i += 1) events.push({ ...r26RendererTrace[(start + i) % R26_TRACE_CAPACITY] });\n  return {\n    ok: true,\n    version: 1,\n    capacity: R26_TRACE_CAPACITY,\n    capturedAtWallMs: Date.now(),\n    maxTransportMs: r26MaxTransportMs,\n    maxReceiverGapMs: r26MaxReceiverGapMs,\n    maxCallbackMs: r26MaxCallbackMs,\n    worstTransportFrameId: r26WorstTransportFrameId,\n    events\n  };\n}\n\nipcRenderer.on('libmpv-shared:r26-trace-request', (_event, payload = {}) => {\n  const requestId = Number(payload?.requestId) || 0;\n  try {\n    ipcRenderer.send('libmpv-shared:r26-trace-response', { requestId, ...r26SnapshotRendererTrace() });\n  } catch {}\n});`,
  'renderer trace ring state'
);

preload = replaceOnce(
  preload,
  `    receivedFrames += 1;\n    lastFrameAt = Date.now();`,
  `    receivedFrames += 1;\n    lastFrameAt = Date.now();\n    const r26ReceiverWallMs = lastFrameAt;\n    const r26ReceiverPerfMs = performance.now();\n    const r26DispatchWallMs = Number(metadata?.r26DispatchWallMs) || 0;\n    const r26TransportMs = r26DispatchWallMs > 0 ? Math.max(0, r26ReceiverWallMs - r26DispatchWallMs) : 0;\n    const r26ReceiverGapMs = r26LastReceiverPerfMs > 0 ? Math.max(0, r26ReceiverPerfMs - r26LastReceiverPerfMs) : 0;\n    r26LastReceiverPerfMs = r26ReceiverPerfMs;\n    r26MaxReceiverGapMs = Math.max(r26MaxReceiverGapMs, r26ReceiverGapMs);\n    if (r26TransportMs >= r26MaxTransportMs) {\n      r26MaxTransportMs = r26TransportMs;\n      r26WorstTransportFrameId = Number(metadata?.frameId) || 0;\n    }\n    const r26Trace = r26PushRendererTrace({\n      frameId: Number(metadata?.frameId) || 0,\n      dispatchWallMs: r26DispatchWallMs,\n      receiverWallMs: r26ReceiverWallMs,\n      transportMs: r26TransportMs,\n      receiverGapMs: r26ReceiverGapMs,\n      getVideoFrameMs: 0,\n      gpuCopyMs: 0,\n      presentAfterReceiverMs: 0,\n      releaseAfterReceiverMs: 0,\n      callbackMs: 0\n    });`,
  'renderer receive boundary timestamp'
);
preload = replaceOnce(
  preload,
  `      frame = importedSharedTexture.getVideoFrame();\n      videoFramesCreated += 1;`,
  `      const r26GetVideoFrameStarted = performance.now();\n      frame = importedSharedTexture.getVideoFrame();\n      r26Trace.getVideoFrameMs = Math.max(0, performance.now() - r26GetVideoFrameStarted);\n      videoFramesCreated += 1;`,
  'VideoFrame acquisition trace'
);
preload = replaceOnce(
  preload,
  `      lastDrawMs = performance.now() - drawStarted;\n      gpuCopyFrames += 1;`,
  `      lastDrawMs = performance.now() - drawStarted;\n      r26Trace.gpuCopyMs = lastDrawMs;\n      gpuCopyFrames += 1;`,
  'WebGPU copy trace'
);
preload = replaceOnce(
  preload,
  `      presentedFrames += 1;\n      gpuPresentFrames += 1;`,
  `      r26Trace.presentAfterReceiverMs = Math.max(0, performance.now() - r26ReceiverPerfMs);\n      presentedFrames += 1;\n      gpuPresentFrames += 1;`,
  'logical present boundary trace'
);
preload = replaceOnce(
  preload,
  `      if (lifetimeFailure) {\n        sendStats({`,
  `      r26Trace.releaseAfterReceiverMs = Math.max(0, performance.now() - r26ReceiverPerfMs);\n      r26Trace.callbackMs = r26Trace.releaseAfterReceiverMs;\n      r26MaxCallbackMs = Math.max(r26MaxCallbackMs, r26Trace.callbackMs);\n      if (lifetimeFailure) {\n        sendStats({`,
  'source release boundary trace'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);

const entry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const out = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(entry)) throw new Error('R26 preload entry missing');
buildSync({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});

const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalPreload = read('electron/libmpv-shared-preload.cjs');
const bundled = read('electron/preload-libmpv-shared.generated.cjs');
for (const marker of ['LILAC_R26_STALL_BOUNDARY_TRACE', 'r26DispatchWallMs', 'r26BoundaryTrace', 'r26SnapshotMainTrace', 'libmpv-shared:r26-trace-response']) {
  if (!finalBridge.includes(marker)) throw new Error(`R26 bridge marker missing: ${marker}`);
}
for (const marker of ['LILAC_R26_STALL_BOUNDARY_TRACE', 'r26TransportMs', 'r26SnapshotRendererTrace', 'getVideoFrameMs', 'gpuCopyMs', 'libmpv-shared:r26-trace-request']) {
  if (!finalPreload.includes(marker)) throw new Error(`R26 preload marker missing: ${marker}`);
  if (!bundled.includes(marker)) throw new Error(`R26 bundled preload marker missing: ${marker}`);
}
for (const forbidden of ['requestAnimationFrame(', 'onSubmittedWorkDone(']) {
  if (finalPreload.includes(forbidden) || bundled.includes(forbidden)) throw new Error(`R26 reintroduced forbidden renderer sync: ${forbidden}`);
}
if (!finalBridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX') || !finalPreload.includes('LILAC_R24_CADENCE_LAZY')) throw new Error('R26 lost R24 baseline markers');
if (!finalPreload.includes("presentationMode = 'direct-receive-webgpu-copy'")) throw new Error('R26 lost direct WebGPU presenter');

console.log('R26_STALL_BOUNDARY_TRACE_OK capacity=256 hotpath=ring-only diagnostics=on-demand stages=main-dispatch,renderer-entry,getVideoFrame,gpu-copy,present-mark,release');

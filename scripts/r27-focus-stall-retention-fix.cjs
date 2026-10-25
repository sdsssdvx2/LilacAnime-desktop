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

if (!bridge.includes('LILAC_R26_STALL_BOUNDARY_TRACE')) throw new Error('R27 requires R26 main boundary trace');
if (!preload.includes('LILAC_R26_STALL_BOUNDARY_TRACE')) throw new Error('R27 requires R26 renderer boundary trace');
if (bridge.includes('LILAC_R27_FOCUS_STALL_RETENTION') || preload.includes('LILAC_R27_FOCUS_STALL_RETENTION')) throw new Error('R27 already applied');

bridge = replaceOnce(
  bridge,
  `  const r26TraceWaiters = new Map();`,
  `  const r26TraceWaiters = new Map();\n  const R27_ANOMALY_CAPACITY = 64; // LILAC_R27_FOCUS_STALL_RETENTION\n  const r27MainAnomalies = new Array(R27_ANOMALY_CAPACITY);\n  const r27MainFocusEvents = new Array(R27_ANOMALY_CAPACITY);\n  let r27MainAnomalyNext = 0;\n  let r27MainAnomalyCount = 0;\n  let r27MainFocusNext = 0;\n  let r27MainFocusCount = 0;\n  let r27MainFocused = false;\n  let r27LastDispatchWallMs = 0;\n\n  function r27PushRing(ring, nextKey, countKey, entry) {\n    if (nextKey === 'anomaly') {\n      r27MainAnomalies[r27MainAnomalyNext] = entry;\n      r27MainAnomalyNext = (r27MainAnomalyNext + 1) % R27_ANOMALY_CAPACITY;\n      r27MainAnomalyCount = Math.min(R27_ANOMALY_CAPACITY, r27MainAnomalyCount + 1);\n    } else {\n      r27MainFocusEvents[r27MainFocusNext] = entry;\n      r27MainFocusNext = (r27MainFocusNext + 1) % R27_ANOMALY_CAPACITY;\n      r27MainFocusCount = Math.min(R27_ANOMALY_CAPACITY, r27MainFocusCount + 1);\n    }\n    return entry;\n  }\n\n  function r27SnapshotRing(ring, next, count) {\n    const out = [];\n    const start = (next - count + R27_ANOMALY_CAPACITY) % R27_ANOMALY_CAPACITY;\n    for (let i = 0; i < count; i += 1) out.push({ ...ring[(start + i) % R27_ANOMALY_CAPACITY] });\n    return out;\n  }\n\n  function r27RecordMainFocus(kind, focused) {\n    r27MainFocused = Boolean(focused);\n    r27PushRing(r27MainFocusEvents, 'focus', 'focus', { kind, wallMs: Date.now(), focused: r27MainFocused });\n  }`,
  'main R27 ring state'
);

bridge = replaceOnce(
  bridge,
  `      const r26DispatchWallMs = Date.now();\n      const r26DispatchPerfMs = performance.now();\n      const r26Trace = r26PushMainTrace({`,
  `      const r26DispatchWallMs = Date.now();\n      const r26DispatchPerfMs = performance.now();\n      const r27DispatchGapMs = r27LastDispatchWallMs > 0 ? Math.max(0, r26DispatchWallMs - r27LastDispatchWallMs) : 0;\n      r27LastDispatchWallMs = r26DispatchWallMs;\n      if (r27DispatchGapMs >= 60) {\n        r27PushRing(r27MainAnomalies, 'anomaly', 'anomaly', {\n          kind: 'dispatch-gap',\n          frameId: Number(frameId) || 0,\n          wallMs: r26DispatchWallMs,\n          gapMs: r27DispatchGapMs,\n          focused: r27MainFocused\n        });\n      }\n      const r26Trace = r26PushMainTrace({`,
  'main dispatch gap retention'
);

bridge = replaceOnce(
  bridge,
  `        dispatchWallMs: r26DispatchWallMs,\n        invokeMs: 0,`,
  `        dispatchWallMs: r26DispatchWallMs,\n        dispatchGapMs: r27DispatchGapMs,\n        mainFocused: r27MainFocused,\n        invokeMs: 0,`,
  'main trace focus fields'
);

bridge = replaceOnce(
  bridge,
  `          displayFrequency,\n          r26DispatchWallMs\n        });`,
  `          displayFrequency,\n          r26DispatchWallMs,\n          r27MainFocused,\n          r27DispatchGapMs\n        });`,
  'frame metadata focus fields'
);

bridge = replaceOnce(
  bridge,
  `          renderer: rendererTrace\n        }\n      };`,
  `          renderer: rendererTrace\n        },\n        r27FocusStallRetention: {\n          version: 1,\n          thresholdMs: 60,\n          capacity: R27_ANOMALY_CAPACITY,\n          mainFocused: r27MainFocused,\n          mainAnomalies: r27SnapshotRing(r27MainAnomalies, r27MainAnomalyNext, r27MainAnomalyCount),\n          mainFocusEvents: r27SnapshotRing(r27MainFocusEvents, r27MainFocusNext, r27MainFocusCount)\n        }\n      };`,
  'main diagnostics R27 snapshot'
);

bridge = replaceOnce(
  bridge,
  `  async function attachWindow(win) {\n    attachedWindow = win;`,
  `  async function attachWindow(win) {\n    attachedWindow = win;\n    const r27OnFocus = () => r27RecordMainFocus('focus', true);\n    const r27OnBlur = () => r27RecordMainFocus('blur', false);\n    r27RecordMainFocus('attach', typeof win.isFocused === 'function' ? win.isFocused() : false);\n    win.on('focus', r27OnFocus);\n    win.on('blur', r27OnBlur);`,
  'main focus listeners'
);

bridge = replaceOnce(
  bridge,
  `    win.once('closed', () => {\n      if (attachedWindow === win) attachedWindow = null;`,
  `    win.once('closed', () => {\n      try { win.removeListener('focus', r27OnFocus); } catch {}\n      try { win.removeListener('blur', r27OnBlur); } catch {}\n      r27RecordMainFocus('closed', false);\n      if (attachedWindow === win) attachedWindow = null;`,
  'main focus listener cleanup'
);

preload = replaceOnce(
  preload,
  `let r26WorstTransportFrameId = 0;`,
  `let r26WorstTransportFrameId = 0;\nconst R27_ANOMALY_CAPACITY = 64; // LILAC_R27_FOCUS_STALL_RETENTION\nconst r27RendererAnomalies = new Array(R27_ANOMALY_CAPACITY);\nconst r27RendererFocusEvents = new Array(R27_ANOMALY_CAPACITY);\nlet r27RendererAnomalyNext = 0;\nlet r27RendererAnomalyCount = 0;\nlet r27RendererFocusNext = 0;\nlet r27RendererFocusCount = 0;\nlet r27RendererFocused = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true;\nlet r27VisibilityState = typeof document !== 'undefined' ? String(document.visibilityState || 'unknown') : 'unknown';\nlet r27WorstReceiverGap = null;\nlet r27WorstCallback = null;\n\nfunction r27PushRendererRing(kind, entry) {\n  if (kind === 'anomaly') {\n    r27RendererAnomalies[r27RendererAnomalyNext] = entry;\n    r27RendererAnomalyNext = (r27RendererAnomalyNext + 1) % R27_ANOMALY_CAPACITY;\n    r27RendererAnomalyCount = Math.min(R27_ANOMALY_CAPACITY, r27RendererAnomalyCount + 1);\n  } else {\n    r27RendererFocusEvents[r27RendererFocusNext] = entry;\n    r27RendererFocusNext = (r27RendererFocusNext + 1) % R27_ANOMALY_CAPACITY;\n    r27RendererFocusCount = Math.min(R27_ANOMALY_CAPACITY, r27RendererFocusCount + 1);\n  }\n  return entry;\n}\n\nfunction r27SnapshotRendererRing(ring, next, count) {\n  const out = [];\n  const start = (next - count + R27_ANOMALY_CAPACITY) % R27_ANOMALY_CAPACITY;\n  for (let i = 0; i < count; i += 1) out.push({ ...ring[(start + i) % R27_ANOMALY_CAPACITY] });\n  return out;\n}\n\nfunction r27RecordRendererFocus(kind) {\n  r27RendererFocused = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : r27RendererFocused;\n  r27VisibilityState = typeof document !== 'undefined' ? String(document.visibilityState || r27VisibilityState) : r27VisibilityState;\n  r27PushRendererRing('focus', { kind, wallMs: Date.now(), focused: r27RendererFocused, visibilityState: r27VisibilityState });\n}\n\nif (typeof window !== 'undefined') {\n  window.addEventListener('focus', () => r27RecordRendererFocus('focus'));\n  window.addEventListener('blur', () => r27RecordRendererFocus('blur'));\n}\nif (typeof document !== 'undefined') {\n  document.addEventListener('visibilitychange', () => r27RecordRendererFocus('visibilitychange'));\n}\nr27RecordRendererFocus('init');`,
  'renderer R27 state'
);

preload = replaceOnce(
  preload,
  `    worstTransportFrameId: r26WorstTransportFrameId,\n    events`,
  `    worstTransportFrameId: r26WorstTransportFrameId,\n    r27: {\n      thresholdMs: 60,\n      capacity: R27_ANOMALY_CAPACITY,\n      focused: r27RendererFocused,\n      visibilityState: r27VisibilityState,\n      worstReceiverGap: r27WorstReceiverGap ? { ...r27WorstReceiverGap } : null,\n      worstCallback: r27WorstCallback ? { ...r27WorstCallback } : null,\n      anomalies: r27SnapshotRendererRing(r27RendererAnomalies, r27RendererAnomalyNext, r27RendererAnomalyCount),\n      focusEvents: r27SnapshotRendererRing(r27RendererFocusEvents, r27RendererFocusNext, r27RendererFocusCount)\n    },\n    events`,
  'renderer diagnostics retained anomalies'
);

preload = replaceOnce(
  preload,
  `    r26MaxReceiverGapMs = Math.max(r26MaxReceiverGapMs, r26ReceiverGapMs);\n    if (r26TransportMs >= r26MaxTransportMs) {`,
  `    r26MaxReceiverGapMs = Math.max(r26MaxReceiverGapMs, r26ReceiverGapMs);\n    const r27FrameId = Number(metadata?.frameId) || 0;\n    const r27MainFocusedForFrame = metadata?.r27MainFocused === true;\n    if (!r27WorstReceiverGap || r26ReceiverGapMs >= r27WorstReceiverGap.gapMs) {\n      r27WorstReceiverGap = {\n        frameId: r27FrameId, wallMs: r26ReceiverWallMs, gapMs: r26ReceiverGapMs, transportMs: r26TransportMs,\n        rendererFocused: r27RendererFocused, visibilityState: r27VisibilityState, mainFocused: r27MainFocusedForFrame\n      };\n    }\n    if (r26ReceiverGapMs >= 60 || r26TransportMs >= 10) {\n      r27PushRendererRing('anomaly', {\n        kind: r26TransportMs >= 10 ? 'transport-delay' : 'receiver-gap',\n        frameId: r27FrameId, wallMs: r26ReceiverWallMs, gapMs: r26ReceiverGapMs, transportMs: r26TransportMs,\n        mainDispatchGapMs: Number(metadata?.r27DispatchGapMs) || 0,\n        rendererFocused: r27RendererFocused, visibilityState: r27VisibilityState, mainFocused: r27MainFocusedForFrame\n      });\n    }\n    if (r26TransportMs >= r26MaxTransportMs) {`,
  'renderer gap anomaly retention'
);

preload = replaceOnce(
  preload,
  `      frameId: Number(metadata?.frameId) || 0,\n      dispatchWallMs: r26DispatchWallMs,`,
  `      frameId: Number(metadata?.frameId) || 0,\n      dispatchWallMs: r26DispatchWallMs,\n      mainDispatchGapMs: Number(metadata?.r27DispatchGapMs) || 0,\n      mainFocused: metadata?.r27MainFocused === true,\n      rendererFocused: r27RendererFocused,\n      visibilityState: r27VisibilityState,`,
  'renderer trace focus fields'
);

preload = replaceOnce(
  preload,
  `      r26Trace.callbackMs = r26Trace.releaseAfterReceiverMs;\n      r26MaxCallbackMs = Math.max(r26MaxCallbackMs, r26Trace.callbackMs);`,
  `      r26Trace.callbackMs = r26Trace.releaseAfterReceiverMs;\n      r26MaxCallbackMs = Math.max(r26MaxCallbackMs, r26Trace.callbackMs);\n      if (!r27WorstCallback || r26Trace.callbackMs >= r27WorstCallback.callbackMs) {\n        r27WorstCallback = {\n          frameId: Number(metadata?.frameId) || 0, wallMs: Date.now(), callbackMs: r26Trace.callbackMs,\n          gpuCopyMs: r26Trace.gpuCopyMs, rendererFocused: r27RendererFocused, visibilityState: r27VisibilityState,\n          mainFocused: metadata?.r27MainFocused === true\n        };\n      }\n      if (r26Trace.callbackMs >= 5 || r26Trace.gpuCopyMs >= 5) {\n        r27PushRendererRing('anomaly', {\n          kind: r26Trace.gpuCopyMs >= 5 ? 'gpu-copy' : 'renderer-callback',\n          frameId: Number(metadata?.frameId) || 0, wallMs: Date.now(), callbackMs: r26Trace.callbackMs, gpuCopyMs: r26Trace.gpuCopyMs,\n          rendererFocused: r27RendererFocused, visibilityState: r27VisibilityState, mainFocused: metadata?.r27MainFocused === true\n        });\n      }`,
  'renderer callback anomaly retention'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);

const entry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const out = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(entry)) throw new Error('R27 preload entry missing');
buildSync({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'info' });

const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalPreload = read('electron/libmpv-shared-preload.cjs');
const bundled = read('electron/preload-libmpv-shared.generated.cjs');
for (const marker of ['LILAC_R27_FOCUS_STALL_RETENTION', 'r27MainAnomalies', 'r27MainFocusEvents', 'r27DispatchGapMs', 'r27FocusStallRetention']) {
  if (!finalBridge.includes(marker)) throw new Error(`R27 main marker missing: ${marker}`);
}
for (const marker of ['LILAC_R27_FOCUS_STALL_RETENTION', 'r27RendererAnomalies', 'r27RendererFocusEvents', 'r27WorstReceiverGap', 'visibilitychange']) {
  if (!finalPreload.includes(marker)) throw new Error(`R27 preload marker missing: ${marker}`);
}
for (const marker of ['r27RendererAnomalies', 'r27RendererFocusEvents', 'r27WorstReceiverGap', 'visibilitychange']) {
  if (!bundled.includes(marker)) throw new Error(`R27 bundled marker missing: ${marker}`);
}
for (const forbidden of ['requestAnimationFrame(', 'onSubmittedWorkDone(']) {
  if (finalPreload.includes(forbidden) || bundled.includes(forbidden)) throw new Error(`R27 reintroduced forbidden renderer sync: ${forbidden}`);
}
if (!finalBridge.includes('LILAC_R26_STALL_BOUNDARY_TRACE') || !finalPreload.includes('LILAC_R26_STALL_BOUNDARY_TRACE')) throw new Error('R27 lost R26 trace');
if (!finalBridge.includes('LILAC_R24_LATEST_FRAME_MAILBOX') || !finalPreload.includes("presentationMode = 'direct-receive-webgpu-copy'")) throw new Error('R27 lost qualified playback baseline');

console.log('R27_FOCUS_STALL_RETENTION_OK anomalyCapacity=64 thresholdMs=60 focus=main+renderer visibility=renderer persistent=rare-events-only');

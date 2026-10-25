'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');
let renderer = read('src/libmpv-shared-entry.js');
const preload = read('electron/libmpv-shared-preload.cjs');
const flixCore = read('electron/flix-proxy.cjs');

if (!bridge.includes('LILAC_R31_STATE_COALESCE')) throw new Error('R32 requires R31 state-coalesce baseline');
if (!preload.includes('LILAC_R31_FOCUS_COMPOSITOR_SHIELD')) throw new Error('R32 requires R31 compositor-shield fallback');
if (!bridge.includes('LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN') || !bridge.includes('r30PopLatestProducedFrame')) throw new Error('R32 requires R30 producer drain');
if (!bridge.includes('LILAC_R27_FOCUS_STALL_RETENTION') || !bridge.includes('r27MainFocused')) throw new Error('R32 requires R27 main focus state');
if (!flixCore.includes('function decodeSegment') || !flixCore.includes('async function fetchRanges') || !flixCore.includes('http.createServer(handle)')) throw new Error('R32 Flix proxy baseline mismatch');
if (bridge.includes('LILAC_R32_NATIVE_FOCUS_PRESENTER') || flixCore.includes('LILAC_R32_FLIX_WORKER')) throw new Error('R32 already applied');

// ---------------------------------------------------------------------------
// 1) FlixCloud isolation. The R31 hardware log showed the Electron main loop can
// disappear for 1-2.6 seconds while the Flix proxy is handling hundreds of MB.
// Move the complete proxy HTTP server, range fan-out, Buffer.concat and XOR decode
// into one Worker thread. libmpv still talks directly to its loopback HTTP server;
// there is no per-segment IPC through Electron main.
// ---------------------------------------------------------------------------
write('electron/flix-proxy-worker-core.cjs', flixCore);
write('electron/flix-proxy-worker.cjs', `'use strict';\n\nconst { parentPort } = require('node:worker_threads');\nconst core = require('./flix-proxy-worker-core.cjs');\n\nconst methods = new Set(['createFlixProxyUrl','createFlixAvProxyUrl','primeFlix','flixReadable','closeFlixProxy']);\nparentPort.on('message', async message => {\n  const id = Number(message?.id) || 0;\n  const method = String(message?.method || '');\n  if (!id || !methods.has(method) || typeof core[method] !== 'function') {\n    parentPort.postMessage({ id, ok: false, error: 'unsupported Flix worker method' });\n    return;\n  }\n  try {\n    const result = await core[method](...(Array.isArray(message.args) ? message.args : []));\n    parentPort.postMessage({ id, ok: true, result });\n  } catch (error) {\n    parentPort.postMessage({ id, ok: false, error: String(error?.message || error).slice(0, 500) });\n  }\n});\n`);

write('electron/flix-proxy.cjs', `'use strict';\n\nconst path = require('node:path');\nconst { Worker } = require('node:worker_threads');\n\nconst LILAC_R32_FLIX_WORKER = true;\nlet worker = null;\nlet nextId = 0;\nlet generation = 0;\nconst pending = new Map();\nconst stats = { starts: 0, exits: 0, rpcCalls: 0, rpcFailures: 0, lastError: null, startedAt: 0 };\n\nfunction workerFile() {\n  const normal = path.join(__dirname, 'flix-proxy-worker.cjs');\n  return normal.includes('app.asar' + path.sep)\n    ? normal.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)\n    : normal;\n}\n\nfunction rejectPending(error) {\n  for (const { reject } of pending.values()) reject(error);\n  pending.clear();\n}\n\nfunction ensureWorker() {\n  if (worker) return worker;\n  const myGeneration = ++generation;\n  const created = new Worker(workerFile(), { name: 'LilacFlixProxyR32' });\n  created.unref();\n  worker = created;\n  stats.starts += 1;\n  stats.startedAt = Date.now();\n  created.on('message', message => {\n    if (worker !== created || generation !== myGeneration) return;\n    const id = Number(message?.id) || 0;\n    const waiter = pending.get(id);\n    if (!waiter) return;\n    pending.delete(id);\n    if (message?.ok === true) waiter.resolve(message.result);\n    else {\n      stats.rpcFailures += 1;\n      stats.lastError = String(message?.error || 'Flix worker RPC failed').slice(0, 500);\n      waiter.reject(new Error(stats.lastError));\n    }\n  });\n  const failed = error => {\n    if (worker !== created) return;\n    stats.exits += 1;\n    stats.lastError = String(error?.message || error || 'Flix worker exited').slice(0, 500);\n    worker = null;\n    rejectPending(new Error(stats.lastError));\n  };\n  created.once('error', failed);\n  created.once('exit', code => { if (worker === created) failed(new Error(\`Flix worker exited (\${code})\`)); });\n  return created;\n}\n\nfunction rpc(method, args = []) {\n  const active = ensureWorker();\n  const id = ++nextId;\n  stats.rpcCalls += 1;\n  return new Promise((resolve, reject) => {\n    pending.set(id, { resolve, reject, method, at: Date.now() });\n    try { active.postMessage({ id, method, args }); }\n    catch (error) { pending.delete(id); reject(error); }\n  });\n}\n\nconst createFlixProxyUrl = (...args) => rpc('createFlixProxyUrl', args);\nconst createFlixAvProxyUrl = (...args) => rpc('createFlixAvProxyUrl', args);\nconst primeFlix = (...args) => rpc('primeFlix', args);\nconst flixReadable = (...args) => rpc('flixReadable', args);\nasync function closeFlixProxy() {\n  if (!worker) return;\n  const closing = worker;\n  try { await rpc('closeFlixProxy'); } catch {}\n  if (worker === closing) worker = null;\n  try { await closing.terminate(); } catch {}\n}\nfunction fetchHedged() { throw new Error('fetchHedged is worker-internal in R32'); }\nfunction flixWorkerStats() { return { marker: 'LILAC_R32_FLIX_WORKER', ...stats, running: Boolean(worker), pending: pending.size }; }\n\nmodule.exports = { createFlixProxyUrl, createFlixAvProxyUrl, closeFlixProxy, fetchHedged, primeFlix, flixReadable, flixWorkerStats };\n`);

// ---------------------------------------------------------------------------
// 2) Give main the physical client rectangle of the custom video element. The
// native child HWND uses parent-client pixel coordinates and occupies only video.
// ---------------------------------------------------------------------------
renderer = replaceOnce(
  renderer,
  `  _surfaceSize() {\n    const rect = this.getBoundingClientRect();\n    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);\n    return {\n      width: clamp(Math.round(Math.max(2, rect.width) * dpr), 2, 3840),\n      height: clamp(Math.round(Math.max(2, rect.height) * dpr), 2, 2160)\n    };\n  }`,
  `  _surfaceSize() {\n    const rect = this.getBoundingClientRect();\n    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);\n    return {\n      x: Math.round(rect.left * dpr),\n      y: Math.round(rect.top * dpr),\n      width: clamp(Math.round(Math.max(2, rect.width) * dpr), 2, 3840),\n      height: clamp(Math.round(Math.max(2, rect.height) * dpr), 2, 2160),\n      visible: this.isConnected && rect.width > 1 && rect.height > 1\n    };\n  }`,
  'R32 physical surface rectangle'
);

// ---------------------------------------------------------------------------
// 3) Native focus presenter. Focused playback stays byte-for-byte on the existing
// direct WebGPU send path. While blurred, already-rendered producer textures go to
// a tiny Win32 helper: DuplicateHandle -> OpenSharedResource1 -> CopyResource ->
// child-HWND swapchain Present. No second decoder, no external mpv.exe, no CPU copy.
// If the helper is unavailable, R31 Canvas2D continues as the automatic fallback.
// ---------------------------------------------------------------------------
bridge = replaceOnce(
  bridge,
  `const { sharedTexture } = require('electron');`,
  `const { sharedTexture } = require('electron');\nconst { spawn } = require('node:child_process');`,
  'R32 child process import'
);

bridge = replaceOnce(
  bridge,
  `  let targetWidth = 1280;\n  let targetHeight = 720;\n  let generation = 0;`,
  `  let targetWidth = 1280;\n  let targetHeight = 720;\n  let targetX = 0; // LILAC_R32_NATIVE_FOCUS_PRESENTER\n  let targetY = 0;\n  let targetVisible = true;\n  let r32Presenter = null;\n  let r32PresenterReady = false;\n  let r32PresenterVisibleWanted = false;\n  let r32PresenterDisabled = false;\n  let r32PresenterStarts = 0;\n  let r32PresenterSubmitted = 0;\n  let r32PresenterPresented = 0;\n  let r32PresenterFailures = 0;\n  let r32PresenterFallbackFrames = 0;\n  let r32PresenterLastError = null;\n  const r32PresenterPending = new Map();\n  let generation = 0;`,
  'R32 presenter state'
);

const clampAt = bridge.indexOf('  function clampSize(value, fallback, max) {');
if (clampAt < 0 || bridge.indexOf('  function clampSize(value, fallback, max) {', clampAt + 1) >= 0) throw new Error('R32 clamp boundary must be unique');
const presenterHelpers = `  function r32NativeWindowHandleDecimal(win) {\n    const raw = win.getNativeWindowHandle();\n    if (raw.length >= 8 && process.arch === 'x64') return raw.readBigUInt64LE(0).toString();\n    return String(raw.readUInt32LE(0));\n  }\n\n  function r32PresenterPath() {\n    return unpackedPath('win32-libmpv-focus-presenter.exe');\n  }\n\n  function r32HandleDecimal(value) {\n    try {\n      if (Buffer.isBuffer(value)) {\n        if (value.length >= 8 && process.arch === 'x64') return value.readBigUInt64LE(0).toString();\n        if (value.length >= 4) return String(value.readUInt32LE(0));\n      }\n      if (value instanceof Uint8Array) return r32HandleDecimal(Buffer.from(value.buffer, value.byteOffset, value.byteLength));\n    } catch {}\n    return '';\n  }\n\n  function r32Write(line) {\n    if (!r32Presenter || r32Presenter.exitCode != null || !r32Presenter.stdin || r32Presenter.stdin.destroyed) return false;\n    try { r32Presenter.stdin.write(line); return true; }\n    catch (error) { r32PresenterLastError = String(error?.message || error).slice(0, 180); return false; }\n  }\n\n  function r32SendBounds() {\n    if (!r32PresenterReady) return;\n    r32Write(\`B \${targetX} \${targetY} \${targetWidth} \${targetHeight}\\n\`);\n  }\n\n  function r32SetPresenterVisible(visible) {\n    r32PresenterVisibleWanted = Boolean(visible && targetVisible);\n    if (!r32PresenterReady) return;\n    r32Write(\`V \${r32PresenterVisibleWanted ? 1 : 0}\\n\`);\n  }\n\n  function r32ReleasePresenterPending() {\n    for (const pending of r32PresenterPending.values()) {\n      try { releaseNativeFrame(pending.ownerPlayerId, pending.slotId, pending.frameId); } catch {}\n    }\n    r32PresenterPending.clear();\n  }\n\n  function r32StopPresenter() {\n    const old = r32Presenter;\n    r32Presenter = null;\n    r32PresenterReady = false;\n    r32PresenterVisibleWanted = false;\n    r32ReleasePresenterPending();\n    if (old && old.exitCode == null) {\n      try { old.stdin?.write('Q\\n'); } catch {}\n      setTimeout(() => { try { if (old.exitCode == null) old.kill(); } catch {} }, 250).unref?.();\n    }\n  }\n\n  function r32EnsurePresenter() {\n    if (process.platform !== 'win32' || r32PresenterDisabled || !attachedWindow || attachedWindow.isDestroyed()) return false;\n    if (r32Presenter && r32Presenter.exitCode == null) return true;\n    const exe = r32PresenterPath();\n    if (!fs.existsSync(exe)) {\n      r32PresenterDisabled = true;\n      r32PresenterLastError = 'R32 native focus presenter helper is unavailable';\n      return false;\n    }\n    let proc;\n    try {\n      proc = spawn(exe, [r32NativeWindowHandleDecimal(attachedWindow), String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });\n    } catch (error) {\n      r32PresenterLastError = String(error?.message || error).slice(0, 180);\n      r32PresenterFailures += 1;\n      return false;\n    }\n    r32Presenter = proc;\n    r32PresenterReady = false;\n    r32PresenterStarts += 1;\n    let stdout = '';\n    let stderr = '';\n    proc.stdout?.setEncoding('utf8');\n    proc.stderr?.setEncoding('utf8');\n    proc.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-600); });\n    proc.stdout?.on('data', chunk => {\n      stdout += String(chunk);\n      const lines = stdout.split(/\\r?\\n/);\n      stdout = lines.pop() || '';\n      for (const raw of lines) {\n        const line = raw.trim();\n        if (!line) continue;\n        if (line.startsWith('READY ')) {\n          r32PresenterReady = true;\n          r32SendBounds();\n          r32SetPresenterVisible(r27MainFocused === false);\n          continue;\n        }\n        let match = /^P\\s+(\\d+)\\s+(\\d+)$/.exec(line);\n        if (match) {\n          const slotId = Number(match[1]);\n          const frameId = Number(match[2]);\n          const key = \`\${slotId}:\${frameId}\`;\n          const pending = r32PresenterPending.get(key);\n          if (pending) {\n            r32PresenterPending.delete(key);\n            r32PresenterPresented += 1;\n            releaseNativeFrame(pending.ownerPlayerId, pending.slotId, pending.frameId);\n          }\n          continue;\n        }\n        match = /^E\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)$/.exec(line);\n        if (match) {\n          const slotId = Number(match[1]);\n          const frameId = Number(match[2]);\n          const key = \`\${slotId}:\${frameId}\`;\n          const pending = r32PresenterPending.get(key);\n          if (pending) {\n            r32PresenterPending.delete(key);\n            releaseNativeFrame(pending.ownerPlayerId, pending.slotId, pending.frameId);\n          }\n          r32PresenterFailures += 1;\n          r32PresenterLastError = \`native presenter frame failed HRESULT=\${match[3]}\`;\n          if (r32PresenterFailures >= 3) { r32PresenterDisabled = true; r32SetPresenterVisible(false); }\n          continue;\n        }\n        if (line.startsWith('ERR ')) {\n          r32PresenterFailures += 1;\n          r32PresenterLastError = line.slice(0, 180);\n        }\n      }\n    });\n    const onExit = code => {\n      if (r32Presenter !== proc) return;\n      r32Presenter = null;\n      r32PresenterReady = false;\n      r32PresenterFailures += 1;\n      r32PresenterLastError = stderr || \`native focus presenter exited (\${code ?? 'unknown'})\`;\n      r32ReleasePresenterPending();\n    };\n    proc.once('error', error => { r32PresenterLastError = String(error?.message || error).slice(0, 180); });\n    proc.once('exit', onExit);\n    return true;\n  }\n\n  function r32SubmitPresenterFrame(ownerPlayerId, nativeFrame) {\n    if (r32PresenterDisabled || r27MainFocused !== false || !targetVisible) return false;\n    if (!r32EnsurePresenter() || !r32PresenterReady) { r32PresenterFallbackFrames += 1; return false; }\n    const slotId = Number(nativeFrame?.slotId);\n    const frameId = Number(nativeFrame?.frameId);\n    const width = Number(nativeFrame?.width);\n    const height = Number(nativeFrame?.height);\n    const handle = r32HandleDecimal(nativeFrame?.ntHandle);\n    if (!Number.isInteger(slotId) || !Number.isFinite(frameId) || !handle || !(width > 1) || !(height > 1)) {\n      r32PresenterFallbackFrames += 1;\n      return false;\n    }\n    const key = \`\${slotId}:\${frameId}\`;\n    r32PresenterPending.set(key, { ownerPlayerId, slotId, frameId, at: Date.now() });\n    if (!r32Write(\`F \${slotId} \${frameId} \${handle} \${width} \${height}\\n\`)) {\n      r32PresenterPending.delete(key);\n      r32PresenterFallbackFrames += 1;\n      return false;\n    }\n    r32PresenterSubmitted += 1;\n    return true;\n  }\n\n`;
bridge = bridge.slice(0, clampAt) + presenterHelpers + bridge.slice(clampAt);

bridge = replaceOnce(
  bridge,
  `  function setTargetSize(value = {}) {\n    targetWidth = clampSize(value.width, targetWidth, 3840);\n    targetHeight = clampSize(value.height, targetHeight, 2160);\n    return { width: targetWidth, height: targetHeight };\n  }`,
  `  function setTargetSize(value = {}) {\n    targetWidth = clampSize(value.width, targetWidth, 3840);\n    targetHeight = clampSize(value.height, targetHeight, 2160);\n    const nextX = Math.round(Number(value.x));\n    const nextY = Math.round(Number(value.y));\n    if (Number.isFinite(nextX)) targetX = Math.max(-16384, Math.min(16384, nextX));\n    if (Number.isFinite(nextY)) targetY = Math.max(-16384, Math.min(16384, nextY));\n    if (typeof value.visible === 'boolean') targetVisible = value.visible;\n    r32SendBounds();\n    r32SetPresenterVisible(r27MainFocused === false);\n    return { x: targetX, y: targetY, width: targetWidth, height: targetHeight, visible: targetVisible };\n  }`,
  'R32 target rectangle'
);

bridge = replaceOnce(
  bridge,
  `      pendingFrames.set(key, {\n        playerId: ownerPlayerId, slotId, frameId, at: Date.now(), producer: frameProducerStarted\n      });\n      metrics.maxPending = Math.max(metrics.maxPending, pendingFrames.size);`,
  `      pendingFrames.set(key, {\n        playerId: ownerPlayerId, slotId, frameId, at: Date.now(), producer: frameProducerStarted\n      });\n      metrics.maxPending = Math.max(metrics.maxPending, pendingFrames.size);\n\n      if (frameProducerStarted && r27MainFocused === false && r32SubmitPresenterFrame(ownerPlayerId, nativeFrame)) {\n        return;\n      }`,
  'R32 blurred native presentation branch'
);

bridge = replaceOnce(
  bridge,
  `      pendingFrames: pendingFrames.size,`,
  `      r32NativeFocusPresenter: {\n        marker: 'LILAC_R32_NATIVE_FOCUS_PRESENTER',\n        mode: 'focused-direct-webgpu/unfocused-win32-d3d11-child',\n        ready: r32PresenterReady,\n        disabled: r32PresenterDisabled,\n        visibleWanted: r32PresenterVisibleWanted,\n        starts: r32PresenterStarts,\n        submittedFrames: r32PresenterSubmitted,\n        presentedFrames: r32PresenterPresented,\n        failures: r32PresenterFailures,\n        fallbackFrames: r32PresenterFallbackFrames,\n        pendingFrames: r32PresenterPending.size,\n        lastError: r32PresenterLastError,\n        target: { x: targetX, y: targetY, width: targetWidth, height: targetHeight, visible: targetVisible }\n      },\n      pendingFrames: pendingFrames.size,`,
  'R32 presenter diagnostics'
);

bridge = replaceOnce(
  bridge,
  `    const r27OnFocus = () => r27RecordMainFocus('focus', true);\n    const r27OnBlur = () => r27RecordMainFocus('blur', false);\n    r27RecordMainFocus('attach', typeof win.isFocused === 'function' ? win.isFocused() : false);`,
  `    const r27OnFocus = () => {\n      r27RecordMainFocus('focus', true);\n      r32SetPresenterVisible(false);\n    };\n    const r27OnBlur = () => {\n      r27RecordMainFocus('blur', false);\n      r32EnsurePresenter();\n      r32SetPresenterVisible(true);\n    };\n    r27RecordMainFocus('attach', typeof win.isFocused === 'function' ? win.isFocused() : false);\n    r32EnsurePresenter();\n    r32SetPresenterVisible(r27MainFocused === false);`,
  'R32 focus routing'
);

bridge = replaceOnce(
  bridge,
  `      r27RecordMainFocus('closed', false);\n      if (attachedWindow === win) attachedWindow = null;`,
  `      r27RecordMainFocus('closed', false);\n      r32StopPresenter();\n      if (attachedWindow === win) attachedWindow = null;`,
  'R32 presenter window cleanup'
);

bridge = replaceOnce(
  bridge,
  `    frameProducerStarted = false;\n    active = false;`,
  `    frameProducerStarted = false;\n    r32SetPresenterVisible(false);\n    active = false;`,
  'R32 hide presenter on stop'
);

bridge = replaceOnce(
  bridge,
  `    pendingFrames.clear();\n    attachedWindow = null;`,
  `    pendingFrames.clear();\n    r32StopPresenter();\n    attachedWindow = null;`,
  'R32 dispose presenter'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('src/libmpv-shared-entry.js', renderer);

const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalRenderer = read('src/libmpv-shared-entry.js');
const wrapper = read('electron/flix-proxy.cjs');
const worker = read('electron/flix-proxy-worker.cjs');
const core = read('electron/flix-proxy-worker-core.cjs');
for (const marker of ['LILAC_R32_NATIVE_FOCUS_PRESENTER','r32SubmitPresenterFrame','DuplicateHandle','focused-direct-webgpu/unfocused-win32-d3d11-child']) {
  if (marker === 'DuplicateHandle') continue;
  if (!finalBridge.includes(marker)) throw new Error(`R32 bridge marker missing: ${marker}`);
}
for (const marker of ['x: Math.round(rect.left * dpr)','y: Math.round(rect.top * dpr)','visible: this.isConnected']) {
  if (!finalRenderer.includes(marker)) throw new Error(`R32 renderer bounds marker missing: ${marker}`);
}
for (const marker of ['LILAC_R32_FLIX_WORKER','new Worker','flix-proxy-worker.cjs','flixWorkerStats']) {
  if (!wrapper.includes(marker)) throw new Error(`R32 worker wrapper marker missing: ${marker}`);
}
if (!worker.includes("createFlixProxyUrl") || !core.includes('async function fetchRanges') || !core.includes('function decodeSegment')) throw new Error('R32 worker payload incomplete');
if (!preload.includes('LILAC_R31_FOCUS_COMPOSITOR_SHIELD')) throw new Error('R32 unexpectedly removed R31 fallback');

console.log('R32_FLIX_WORKER_FOCUS_SURFACE_OK flix=worker-loopback-server focused=direct-webgpu unfocused=win32-d3d11-child fallback=R31-canvas2d secondDecoder=0 cpuCopy=0');

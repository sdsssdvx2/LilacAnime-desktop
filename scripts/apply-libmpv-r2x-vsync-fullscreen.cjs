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

let main = read('electron/main.cjs');
let preload = read('electron/libmpv-shared-preload.cjs');
let bridge = read('electron/libmpv-shared-main.cjs');
let entry = read('src/libmpv-shared-entry.js');
let playerCss = read('src/player-android.css');

if (!main.includes('LILAC_R2W_ASPECT_CADENCE')) throw new Error('R2X requires R2W first');
if (main.includes('LILAC_R2X_VSYNC_FULLSCREEN')) throw new Error('R2X transform already applied');
if (!preload.includes("rendererMode = 'webgpu-copy'")) throw new Error('R2X requires R2H WebGPU copy renderer');
if (!preload.includes('observePresentationCadence(metadata)')) throw new Error('R2X requires R2W cadence observer');

// Keep the user's desired 16:9 manual-resize lock separate from whether the
// native constraint is currently applied. Native fullscreen owns the screen
// geometry, so suspend setAspectRatio while fullscreen and restore it afterwards.
write('electron/window-aspect.cjs', `'use strict';\n\nconst VIDEO_ASPECT_RATIO = 16 / 9;\n\nfunction usableWindow(win) {\n  return Boolean(win && !win.isDestroyed?.());\n}\n\nfunction isVideoAspectLocked(win) {\n  return Boolean(usableWindow(win) && win.__lilacVideoAspectLocked === true);\n}\n\nfunction isVideoAspectSuspended(win) {\n  return Boolean(usableWindow(win) && win.__lilacVideoAspectSuspended === true);\n}\n\nfunction applyVideoAspect(win) {\n  if (!usableWindow(win)) return { locked: false, suspended: false, applied: false, ratio: 0 };\n  const locked = win.__lilacVideoAspectLocked === true;\n  const suspended = win.__lilacVideoAspectSuspended === true;\n  const ratio = locked && !suspended ? VIDEO_ASPECT_RATIO : 0;\n  let applied = false;\n  if (typeof win.setAspectRatio === 'function') {\n    win.setAspectRatio(ratio);\n    applied = true;\n  }\n  return { locked, suspended, applied, ratio };\n}\n\nfunction setVideoAspectLocked(win, enabled) {\n  if (!usableWindow(win)) return { locked: false, suspended: false, applied: false, ratio: 0 };\n  win.__lilacVideoAspectLocked = Boolean(enabled);\n  return applyVideoAspect(win);\n}\n\nfunction setVideoAspectSuspended(win, suspended) {\n  if (!usableWindow(win)) return { locked: false, suspended: false, applied: false, ratio: 0 };\n  win.__lilacVideoAspectSuspended = Boolean(suspended);\n  return applyVideoAspect(win);\n}\n\nfunction bindVideoAspectFullscreen(win) {\n  if (!usableWindow(win) || win.__lilacVideoAspectFullscreenBound === true) return false;\n  win.__lilacVideoAspectFullscreenBound = true;\n  if (typeof win.on === 'function') {\n    win.on('enter-full-screen', () => setVideoAspectSuspended(win, true));\n    win.on('leave-full-screen', () => setVideoAspectSuspended(win, false));\n  }\n  return true;\n}\n\nmodule.exports = {\n  VIDEO_ASPECT_RATIO,\n  isVideoAspectLocked,\n  isVideoAspectSuspended,\n  applyVideoAspect,\n  setVideoAspectLocked,\n  setVideoAspectSuspended,\n  bindVideoAspectFullscreen\n};\n`);

main = replaceOnce(
  main,
  "const { setVideoAspectLocked } = require('./window-aspect.cjs'); // LILAC_R2W_ASPECT_CADENCE",
  "const { setVideoAspectLocked, setVideoAspectSuspended, bindVideoAspectFullscreen } = require('./window-aspect.cjs'); // LILAC_R2W_ASPECT_CADENCE LILAC_R2X_VSYNC_FULLSCREEN",
  'R2X aspect helper import'
);
main = replaceOnce(
  main,
  '  mainWindow = win;\n  desktopState.attach(win);',
  '  mainWindow = win;\n  bindVideoAspectFullscreen(win);\n  desktopState.attach(win);',
  'bind fullscreen aspect lifecycle'
);
main = replaceOnce(
  main,
  "  ipcMain.handle('player:fullscreen', (event,enabled) => {const win=BrowserWindow.fromWebContents(event.sender);if(win)win.setFullScreen(Boolean(enabled));return Boolean(enabled)});",
  `  ipcMain.handle('player:fullscreen', (event,enabled) => {\n    const win=BrowserWindow.fromWebContents(event.sender);\n    const fullscreen=Boolean(enabled);\n    if(!win||win.isDestroyed?.())return fullscreen;\n    if(fullscreen){\n      // Release the native resize constraint before Windows takes ownership of\n      // fullscreen geometry. The desired 16:9 policy remains stored on the window.\n      setVideoAspectSuspended(win,true);\n      try{win.setFullScreen(true)}catch(error){setVideoAspectSuspended(win,false);throw error}\n    }else{\n      win.setFullScreen(false);\n      // Electron only documents asynchronous fullscreen transitions on macOS.\n      // Windows/Linux can restore immediately; the leave-full-screen listener is\n      // still the authoritative fallback for OS-driven exits on every platform.\n      if(process.platform!=='darwin')setVideoAspectSuspended(win,false);\n    }\n    return fullscreen;\n  });`,
  'fullscreen aspect suspension'
);

// R2W measured genuine presentation jitter on the user's 144 Hz display. Keep
// the qualified source lifetime: copy the VideoFrame immediately into a private
// GPU texture, then close/release it in the same receiver turn. Only the final
// private-GPU-texture -> canvas swapchain copy is paced by requestAnimationFrame.
preload = replaceOnce(
  preload,
  "const rendererMode = 'webgpu-copy';",
  "const rendererMode = 'webgpu-copy';\nconst presentationMode = 'raf-staged-copy';",
  'presentation mode marker'
);
preload = replaceOnce(
  preload,
  'let lastGpuError = null;',
  `let lastGpuError = null;\nlet gpuPresentFrames = 0;\nlet gpuPresentFailures = 0;\nlet gpuPresentSubmitSamples = 0;\nlet gpuPresentSubmitTotalMs = 0;\nlet gpuPresentSubmitMaxMs = 0;\nlet gpuCoalescedFrames = 0;`,
  'presentation diagnostics state'
);
preload = replaceOnce(
  preload,
  "  state = { status: 'initializing', canvas, adapter: null, device: null, context: null, format: null, width: 0, height: 0, error: null };",
  "  state = { status: 'initializing', canvas, adapter: null, device: null, context: null, format: null, width: 0, height: 0, stagingTexture: null, presentRaf: 0, latestFrameId: 0, lastPresentedFrameId: 0, latestExpectedFps: 0, latestDisplayFrequency: 0, latestPlayerId: 0, error: null };",
  'GPU staging state'
);
const oldConfigure = `function configureGpu(state, canvas, width, height) {\n  if (!state || state.status !== 'ready' || !state.device || !state.context) return false;\n  if (state.width === width && state.height === height) return true;\n  const usage = globalThis.GPUTextureUsage;\n  if (!usage) throw new Error('GPUTextureUsage unavailable');\n  state.context.configure({\n    device: state.device,\n    format: state.format,\n    alphaMode: 'opaque',\n    usage: usage.COPY_DST | usage.RENDER_ATTACHMENT\n  });\n  state.width = width;\n  state.height = height;\n  return true;\n}`;
const newConfigure = `function configureGpu(state, canvas, width, height) {\n  if (!state || state.status !== 'ready' || !state.device || !state.context) return false;\n  if (state.width === width && state.height === height && state.stagingTexture) return true;\n  const usage = globalThis.GPUTextureUsage;\n  if (!usage) throw new Error('GPUTextureUsage unavailable');\n  state.context.configure({\n    device: state.device,\n    format: state.format,\n    alphaMode: 'opaque',\n    usage: usage.COPY_DST | usage.RENDER_ATTACHMENT\n  });\n  try { state.stagingTexture?.destroy?.(); } catch {}\n  state.stagingTexture = state.device.createTexture({\n    size: { width, height, depthOrArrayLayers: 1 },\n    format: state.format,\n    usage: usage.COPY_DST | usage.COPY_SRC | usage.RENDER_ATTACHMENT\n  });\n  state.width = width;\n  state.height = height;\n  state.latestFrameId = 0;\n  state.lastPresentedFrameId = 0;\n  return true;\n}\n\nfunction scheduleGpuPresent(state) {\n  if (!state || state.presentRaf || state.status !== 'ready') return;\n  state.presentRaf = requestAnimationFrame(atMs => {\n    state.presentRaf = 0;\n    const frameId = Number(state.latestFrameId) || 0;\n    if (!frameId || frameId === Number(state.lastPresentedFrameId) || !state.stagingTexture) return;\n    const started = performance.now();\n    try {\n      const encoder = state.device.createCommandEncoder();\n      encoder.copyTextureToTexture(\n        { texture: state.stagingTexture },\n        { texture: state.context.getCurrentTexture() },\n        { width: state.width, height: state.height, depthOrArrayLayers: 1 }\n      );\n      state.device.queue.submit([encoder.finish()]);\n      const elapsed = performance.now() - started;\n      gpuPresentFrames += 1;\n      gpuPresentSubmitSamples += 1;\n      gpuPresentSubmitTotalMs += elapsed;\n      gpuPresentSubmitMaxMs = Math.max(gpuPresentSubmitMaxMs, elapsed);\n      state.lastPresentedFrameId = frameId;\n      presentedFrames += 1;\n      const scalarMetadata = {\n        frameId,\n        playerId: Number(state.latestPlayerId) || 0,\n        fps: Number(state.latestExpectedFps) || 0,\n        displayFrequency: Number(state.latestDisplayFrequency) || 0\n      };\n      observePresentationCadence(scalarMetadata, atMs);\n      sendStats({\n        lastFrameId: frameId,\n        playerId: scalarMetadata.playerId,\n        width: state.width,\n        height: state.height,\n        reason: 'presented'\n      });\n    } catch (error) {\n      gpuPresentFailures += 1;\n      lastGpuError = String(error?.message || error).slice(0, 160);\n      sendStats({ lastFrameId: frameId, reason: 'gpu-present-failed', error: lastGpuError }, true);\n    }\n  });\n}`;
preload = replaceOnce(preload, oldConfigure, newConfigure, 'staged WebGPU configuration');

const oldObserver = `function observePresentationCadence(metadata = {}) {\n  const frameId = Number(metadata.frameId) || 0;\n  const expectedFps = Number(metadata.fps) || 0;\n  const displayFrequency = Number(metadata.displayFrequency) || 0;\n  requestAnimationFrame(atMs => {\n    lastCadence = cadenceTracker.add({ atMs, frameId, expectedFps, displayFrequency });\n  });\n}`;
const newObserver = `function observePresentationCadence(metadata = {}, atMs = performance.now()) {\n  const frameId = Number(metadata.frameId) || 0;\n  const expectedFps = Number(metadata.fps) || 0;\n  const displayFrequency = Number(metadata.displayFrequency) || 0;\n  lastCadence = cadenceTracker.add({ atMs, frameId, expectedFps, displayFrequency });\n}`;
preload = replaceOnce(preload, oldObserver, newObserver, 'true presentation cadence observer');

preload = replaceOnce(
  preload,
  '      lastGpuError,\n      ...extra',
  `      lastGpuError,\n      presentationMode,\n      gpuPresentFrames,\n      gpuPresentFailures,\n      gpuCoalescedFrames,\n      avgGpuPresentSubmitMs: gpuPresentSubmitSamples ? Math.round((gpuPresentSubmitTotalMs / gpuPresentSubmitSamples) * 1000) / 1000 : 0,\n      maxGpuPresentSubmitMs: Math.round(gpuPresentSubmitMaxMs * 1000) / 1000,\n      ...extra`,
  'presentation diagnostics payload'
);
preload = replaceOnce(
  preload,
  '{ texture: gpu.context.getCurrentTexture() },',
  '{ texture: gpu.stagingTexture },',
  'copy source into private staging texture'
);
preload = replaceOnce(
  preload,
  `      // copyExternalImageToTexture enqueues an explicit GPU copy into Chromium's\n      // canvas texture. The source frame can be closed now; Electron/Chromium\n      // keeps the underlying SharedImage alive until the queued GPU copy retires.\n      presentedFrames += 1;\n      observePresentationCadence(metadata);`,
  `      // The source shared image is copied into a private WebGPU texture now.\n      // Source ownership still ends in this receiver turn; only the private GPU\n      // texture survives until the next compositor opportunity.\n      const nextFrameId = Number(metadata.frameId) || 0;\n      if (gpu.presentRaf && gpu.latestFrameId && gpu.latestFrameId !== gpu.lastPresentedFrameId && gpu.latestFrameId !== nextFrameId) {\n        gpuCoalescedFrames += 1;\n      }\n      gpu.latestFrameId = nextFrameId;\n      gpu.latestPlayerId = Number(metadata.playerId) || 0;\n      gpu.latestExpectedFps = Number(metadata.fps) || 0;\n      gpu.latestDisplayFrequency = Number(metadata.displayFrequency) || 0;\n      scheduleGpuPresent(gpu);`,
  'defer only final swapchain presentation'
);

bridge = replaceOnce(
  bridge,
  "        lastGpuError: payload?.lastGpuError ? String(payload.lastGpuError).slice(0, 160) : null,\n        lastFrameAt: numeric('lastFrameAt'),",
  `        lastGpuError: payload?.lastGpuError ? String(payload.lastGpuError).slice(0, 160) : null,\n        presentationMode: payload?.presentationMode ? String(payload.presentationMode).slice(0, 40) : null,\n        gpuPresentFrames: numeric('gpuPresentFrames'),\n        gpuPresentFailures: numeric('gpuPresentFailures'),\n        gpuCoalescedFrames: numeric('gpuCoalescedFrames'),\n        avgGpuPresentSubmitMs: numeric('avgGpuPresentSubmitMs'),\n        maxGpuPresentSubmitMs: numeric('maxGpuPresentSubmitMs'),\n        lastFrameAt: numeric('lastFrameAt'),`,
  'bridge presentation diagnostics'
);

// Canvas is a replaced element: object-fit:contain preserves the 1920x1080
// picture when Chromium exposes a 1920x1078 content viewport during transitions.
entry = replaceOnce(
  entry,
  'canvas{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;pointer-events:none}',
  'canvas{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;pointer-events:none;object-fit:contain}',
  'preserve canvas picture aspect'
);

// Keep top controls in a stable safe-area across F toggles. The settings panel
// starts below the 42px Windows caption overlay, so it does not need the old
// 150px horizontal displacement in windowed mode.
playerCss = replaceOnce(
  playerCss,
  '.immersive-player.windowed .player-top { padding-right: 158px; }',
  '.immersive-player .player-top { padding-right: 158px; }',
  'stable top-right safe area'
);
playerCss = replaceOnce(
  playerCss,
  '.immersive-player.windowed .player-settings { right: 150px; }',
  '.immersive-player .player-settings { right: 16px; }',
  'stable settings panel position'
);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r2w.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r6') {
  throw new Error(`expected R2W identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r2x.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r7';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2X-Setup.${ext}';

for (const marker of ['LILAC_R2X_VSYNC_FULLSCREEN', 'bindVideoAspectFullscreen(win)', 'setVideoAspectSuspended(win,true)']) {
  if (!main.includes(marker)) throw new Error(`R2X main marker missing: ${marker}`);
}
for (const marker of ["presentationMode = 'raf-staged-copy'", 'stagingTexture', 'copyTextureToTexture', 'scheduleGpuPresent(gpu)', 'observePresentationCadence(scalarMetadata, atMs)']) {
  if (!preload.includes(marker)) throw new Error(`R2X preload marker missing: ${marker}`);
}
if (preload.includes('{ texture: gpu.context.getCurrentTexture() },\n          { width, height, depthOrArrayLayers: 1 }')) {
  throw new Error('R2X source frame still copies directly into swapchain');
}
if (preload.includes('await requestAnimationFrame') || preload.includes('setSharedTextureReceiver(async')) {
  throw new Error('R2X must not extend source shared-texture lifetime across rAF');
}
if (!entry.includes('object-fit:contain')) throw new Error('R2X canvas aspect containment missing');
if (playerCss.includes('.immersive-player.windowed .player-settings { right: 150px; }')) throw new Error('R2X stale settings offset survived');

write('electron/main.cjs', main);
write('electron/libmpv-shared-preload.cjs', preload);
write('electron/libmpv-shared-main.cjs', bridge);
write('src/libmpv-shared-entry.js', entry);
write('src/player-android.css', playerCss);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

// Refresh both generated bundles because R2X changes the isolated preload and
// the custom video element source. Native addon/DLL files are not rebuilt.
const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const preloadBundle = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(preloadEntry)) throw new Error('R2X preload bundle entry missing');
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
const bundledPreload = read('electron/preload-libmpv-shared.generated.cjs');
for (const marker of ['raf-staged-copy', 'copyTextureToTexture', 'scheduleGpuPresent']) {
  if (!bundledPreload.includes(marker)) throw new Error(`R2X generated preload missing: ${marker}`);
}
if (bundledPreload.includes('setSharedTextureReceiver(async') || bundledPreload.includes('await requestAnimationFrame')) {
  throw new Error('R2X generated preload changed immediate source lifetime');
}

console.log('LIBMPV_R2X_OK presentation=raf-staged-copy sourceLifetime=immediate fullscreenAspect=suspended canvasAspect=contain uiSafeArea=stable');

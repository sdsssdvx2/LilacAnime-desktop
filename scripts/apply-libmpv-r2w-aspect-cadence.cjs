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
  if (count !== 1) throw new Error(`${label}: expected 1 match, got ${count}`);
  return source.replace(needle, replacement);
}

let mini = read('electron/miniplayer-window.cjs');
let main = read('electron/main.cjs');
let bridge = read('electron/libmpv-shared-main.cjs');
let preload = read('electron/libmpv-shared-preload.cjs');

if (main.includes('LILAC_R2W_ASPECT_CADENCE')) throw new Error('R2W transform already applied');

// Native aspect-ratio constraints only affect manual user resizing. Programmatic
// setBounds/setSize calls used by mini-player enter/leave remain authoritative.
mini = replaceOnce(mini,
  "'use strict';",
  "'use strict';\n\nconst { isVideoAspectLocked, setVideoAspectLocked } = require('./window-aspect.cjs');",
  'mini aspect helper import');
mini = replaceOnce(mini,
  "      resizable: win.isResizable?.() !== false\n    };",
  "      resizable: win.isResizable?.() !== false,\n      aspectLocked: isVideoAspectLocked(win)\n    };",
  'mini saved aspect state');
mini = replaceOnce(mini,
  "    win.setMinimumSize?.(320, 180);\n    win.setResizable?.(true);",
  "    win.setMinimumSize?.(320, 180);\n    win.setResizable?.(true);\n    setVideoAspectLocked(win, true);",
  'mini native aspect lock');
mini = replaceOnce(mini,
  "    win.setMinimumSize?.(...state.minimumSize);\n    win.setResizable?.(state.resizable);",
  "    win.setMinimumSize?.(...state.minimumSize);\n    win.setResizable?.(state.resizable);\n    setVideoAspectLocked(win, state.aspectLocked);",
  'mini aspect restore');

main = replaceOnce(main,
  "const { MiniPlayerWindowController } = require('./miniplayer-window.cjs');",
  "const { MiniPlayerWindowController } = require('./miniplayer-window.cjs');\nconst { setVideoAspectLocked } = require('./window-aspect.cjs'); // LILAC_R2W_ASPECT_CADENCE",
  'main aspect helper import');
main = replaceOnce(main,
  "  app,\n  ipcMain,\n  userAgent: ANDROID_WEBVIEW_UA,",
  "  app,\n  ipcMain,\n  screen,\n  userAgent: ANDROID_WEBVIEW_UA,",
  'bridge screen injection');
main = replaceOnce(main,
  "  const setWindowButtons=(event,change)=>{const win=BrowserWindow.fromWebContents(event.sender);if(!win||win.isDestroyed())return;windowButtons.set(win,{...windowButtons.get(win),...change});paintWindowButtons(win)};",
  "  const setWindowButtons=(event,change)=>{const win=BrowserWindow.fromWebContents(event.sender);if(!win||win.isDestroyed())return;const next={...windowButtons.get(win),...change};windowButtons.set(win,next);paintWindowButtons(win);setVideoAspectLocked(win,next.mode==='player'||next.mode==='hidden')};",
  'normal player native aspect policy');

bridge = replaceOnce(bridge,
  "function createLibmpvSharedBridge({ app, ipcMain, headersFor = () => ({}), userAgent = '' }) {",
  "function createLibmpvSharedBridge({ app, ipcMain, screen = null, headersFor = () => ({}), userAgent = '' }) {",
  'bridge screen option');
bridge = replaceOnce(bridge,
  "  let lastError = null;",
  `  let lastError = null;\n  let displayState = { id: null, frequency: 0, scaleFactor: 0 };\n\n  function refreshDisplayState() {\n    try {\n      if (!screen || !attachedWindow || attachedWindow.isDestroyed?.()) return displayState;\n      const display = screen.getDisplayMatching(attachedWindow.getBounds());\n      const frequency = Number(display?.displayFrequency);\n      const scaleFactor = Number(display?.scaleFactor);\n      displayState = {\n        id: Number.isFinite(Number(display?.id)) ? Number(display.id) : null,\n        frequency: Number.isFinite(frequency) && frequency > 0 ? frequency : 0,\n        scaleFactor: Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 0\n      };\n    } catch {}\n    return displayState;\n  }`,
  'display state diagnostics');
bridge = replaceOnce(bridge,
  "          timestampUs: Number(nativeFrame.timestampUs) || 0",
  "          timestampUs: Number(nativeFrame.timestampUs) || 0,\n          fps: Number(lastState?.fps) || 0,\n          displayFrequency: Number(displayState.frequency) || 0",
  'frame cadence metadata');
bridge = replaceOnce(bridge,
  "  function state() {\n    if (!active || playerId == null || !addon) {",
  "  function state() {\n    refreshDisplayState();\n    if (!active || playerId == null || !addon) {",
  'refresh display state');
bridge = replaceOnce(bridge,
  "      receiver: { ...receiverStats },\n      relay: relay.stats()",
  "      receiver: { ...receiverStats },\n      display: { ...displayState },\n      relay: relay.stats()",
  'diagnostics display info');
bridge = replaceOnce(bridge,
  `      const numeric = key => {\n        const value = Number(payload?.[key]);\n        return Number.isFinite(value) ? value : 0;\n      };\n      receiverStats = {`,
  `      const numeric = key => {\n        const value = Number(payload?.[key]);\n        return Number.isFinite(value) ? value : 0;\n      };\n      const cadenceSource = payload?.cadence && typeof payload.cadence === 'object' ? payload.cadence : null;\n      const cadenceNumber = key => {\n        const value = Number(cadenceSource?.[key]);\n        return Number.isFinite(value) ? value : 0;\n      };\n      const cadence = cadenceSource ? {\n        rollingWindowMs: cadenceNumber('rollingWindowMs'),\n        observedSpanMs: cadenceNumber('observedSpanMs'),\n        sampleCount: cadenceNumber('sampleCount'),\n        actualPresentedFps: cadenceNumber('actualPresentedFps'),\n        expectedFps: cadenceNumber('expectedFps'),\n        expectedIntervalMs: cadenceNumber('expectedIntervalMs'),\n        intervalP50Ms: cadenceNumber('intervalP50Ms'),\n        intervalP95Ms: cadenceNumber('intervalP95Ms'),\n        intervalMaxMs: cadenceNumber('intervalMaxMs'),\n        jitterStdMs: cadenceNumber('jitterStdMs'),\n        refreshQuantizedErrorStdMs: cadenceNumber('refreshQuantizedErrorStdMs'),\n        toleranceMs: cadenceNumber('toleranceMs'),\n        lateFrameCount: cadenceNumber('lateFrameCount'),\n        repeatedFrameCount: cadenceNumber('repeatedFrameCount'),\n        irregularPresentCount: cadenceNumber('irregularPresentCount'),\n        longGapCount: cadenceNumber('longGapCount'),\n        lastLongGapMs: cadenceNumber('lastLongGapMs'),\n        displayFrequency: cadenceNumber('displayFrequency'),\n        displayRefreshIntervalMs: cadenceNumber('displayRefreshIntervalMs'),\n        sourceFpsDeviationPct: cadenceNumber('sourceFpsDeviationPct')\n      } : null;\n      receiverStats = {`,
  'receiver cadence parser');
bridge = replaceOnce(bridge,
  "        updatedAt: Date.now()",
  "        cadence,\n        updatedAt: Date.now()",
  'receiver cadence diagnostics');

// Observe compositor opportunities with requestAnimationFrame after the GPU copy is
// enqueued. The callback captures only scalar metadata; VideoFrame/imported-texture
// ownership is still released immediately by the already-qualified R2H path.
preload = replaceOnce(preload,
  "const { ipcRenderer, sharedTexture } = require('electron');",
  "const { ipcRenderer, sharedTexture } = require('electron');\nconst { createRollingCadenceTracker } = require('./libmpv-cadence.cjs');",
  'cadence helper import');
preload = replaceOnce(preload,
  "let lastFrameAt = 0;",
  `let lastFrameAt = 0;\nconst cadenceTracker = createRollingCadenceTracker({ windowMs: 10000, discontinuityMs: 1500 });\nlet lastCadence = null;\n\nfunction observePresentationCadence(metadata = {}) {\n  const frameId = Number(metadata.frameId) || 0;\n  const expectedFps = Number(metadata.fps) || 0;\n  const displayFrequency = Number(metadata.displayFrequency) || 0;\n  requestAnimationFrame(atMs => {\n    lastCadence = cadenceTracker.add({ atMs, frameId, expectedFps, displayFrequency });\n  });\n}`,
  'rolling cadence observer');
preload = replaceOnce(preload,
  "      receivedFrames,\n      presentedFrames,",
  "      receivedFrames,\n      presentedFrames,\n      cadence: lastCadence,",
  'cadence in receiver stats');
preload = replaceOnce(preload,
  "      presentedFrames += 1;",
  "      presentedFrames += 1;\n      observePresentationCadence(metadata);",
  'observe presented cadence');

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.50-libmpv-r2v.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.50-r5') {
  throw new Error(`expected R2V identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.50-libmpv-r2w.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.50-r6';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2W-Setup.${ext}';

for (const marker of [
  "setVideoAspectLocked(win,next.mode==='player'||next.mode==='hidden')",
  'LILAC_R2W_ASPECT_CADENCE'
]) if (!main.includes(marker)) throw new Error(`R2W main marker missing: ${marker}`);
for (const marker of ['aspectLocked: isVideoAspectLocked(win)', 'setVideoAspectLocked(win, true)', 'setVideoAspectLocked(win, state.aspectLocked)']) {
  if (!mini.includes(marker)) throw new Error(`R2W mini marker missing: ${marker}`);
}
for (const marker of ['displayFrequency: Number(displayState.frequency)', "actualPresentedFps: cadenceNumber('actualPresentedFps')", 'display: { ...displayState }']) {
  if (!bridge.includes(marker)) throw new Error(`R2W bridge marker missing: ${marker}`);
}
for (const marker of ['createRollingCadenceTracker', 'observePresentationCadence(metadata)', 'cadence: lastCadence']) {
  if (!preload.includes(marker)) throw new Error(`R2W preload marker missing: ${marker}`);
}
if (preload.includes('await requestAnimationFrame') || preload.includes('await nextFrame')) throw new Error('R2W cadence observer must not hold frame ownership across rAF');

write('electron/miniplayer-window.cjs', mini);
write('electron/main.cjs', main);
write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

// The shared preload was originally bundled near the beginning of the transform
// chain. R2W changes its source at the end, so rebuild only that preload bundle.
// This is a source-to-bundle refresh; it does not alter the native player or renderer.
const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const preloadBundle = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(preloadEntry)) throw new Error('R2W preload bundle entry missing');
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
const bundledPreload = fs.readFileSync(preloadBundle, 'utf8');
for (const marker of ['createRollingCadenceTracker', 'actualPresentedFps', 'observePresentationCadence']) {
  if (!bundledPreload.includes(marker)) throw new Error(`R2W generated preload missing: ${marker}`);
}
if (bundledPreload.includes('await requestAnimationFrame') || bundledPreload.includes('await nextFrame')) {
  throw new Error('R2W generated preload unexpectedly retains frame ownership across rAF');
}

console.log('LIBMPV_R2W_ASPECT_CADENCE_OK nativeAspect=16:9 cadenceWindowMs=10000 pipeline=observation-only preload=rebundled');

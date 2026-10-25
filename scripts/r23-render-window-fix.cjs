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

// R23 performance scope is deliberately renderer-only. User hardware shows the
// native/libmpv producer at 23.973 fps vs 23.976 expected with zero late frames,
// while the receiver/presenter still sees occasional 66.5 ms gaps. Do not touch
// the already-qualified R3E native producer or D3D11 shared-texture path.
let preload = read('electron/libmpv-shared-preload.cjs');
assert(preload.includes("presentationMode = 'direct-receive-webgpu-copy'"), 'R23 requires direct WebGPU presenter');
assert(preload.includes('copyExternalImageToTexture'), 'R23 requires WebGPU copy path');
assert(!preload.includes('requestAnimationFrame('), 'R23 must not start from an rAF presenter');

const statsSignature = /function sendStats\(extra = \{\}(?:, force = false)?\) \{\n/;
const statsMatch = preload.match(statsSignature);
assert(statsMatch, 'R23 receiver stats function not found');
preload = preload.replace(statsSignature,
`// LILAC_R23_RENDER_HOTPATH: keep frame/cadence accounting local every frame, but\n// do not serialize a large diagnostics payload over IPC for every 24 fps frame.\nconst RECEIVER_STATS_INTERVAL_MS = 250;\nlet receiverStatsLastSentAt = -Infinity;\nlet receiverStatsSuppressed = 0;\nfunction sendStats(extra = {}, force = false) {\n  const now = performance.now();\n  if (!force && now - receiverStatsLastSentAt < RECEIVER_STATS_INTERVAL_MS) {\n    receiverStatsSuppressed += 1;\n    return;\n  }\n  receiverStatsLastSentAt = now;\n`);

// Preserve the diagnostic schema while removing the periodic WebGPU queue fence.
// onSubmittedWorkDone is useful for qualification, but requesting it every ~24
// source frames is unnecessary in the shipping hot path and user diagnostics
// recorded an occasional 51.7 ms completion sample. The actual copy/presentation
// path remains byte-for-byte equivalent around copyExternalImageToTexture.
const fenceBlock = `      if (gpuCopyFrames % 24 === 1) {\n        const workStarted = performance.now();\n        void gpu.device.queue.onSubmittedWorkDone().then(() => {\n          const elapsed = performance.now() - workStarted;\n          gpuWorkDoneSamples += 1;\n          gpuWorkDoneTotalMs += elapsed;\n          gpuWorkDoneMaxMs = Math.max(gpuWorkDoneMaxMs, elapsed);\n        }).catch(error => {\n          lastGpuError = String(error?.message || error).slice(0, 160);\n        });\n      }\n`;
preload = replaceOnce(preload, fenceBlock,
  `      // LILAC_R23_GPU_FENCE_DIAGNOSTICS_DISABLED: no queue completion fence in the production frame path.\n`,
  'remove periodic WebGPU completion fence');

// Expose how much diagnostic traffic was intentionally coalesced without changing
// any playback counter/cadence semantics.
if (preload.includes('      ...extra\n')) {
  preload = replaceOnce(preload, '      ...extra\n', '      receiverStatsSuppressed,\n      ...extra\n', 'receiver stats suppression metric');
}

assert(preload.includes('RECEIVER_STATS_INTERVAL_MS = 250'), 'receiver stats throttle missing');
assert(preload.includes('LILAC_R23_GPU_FENCE_DIAGNOSTICS_DISABLED'), 'GPU fence removal marker missing');
assert(!preload.includes('onSubmittedWorkDone('), 'shipping preload still requests WebGPU queue completion fences');
assert(preload.includes('copyExternalImageToTexture'), 'R23 changed actual WebGPU copy primitive');
write('electron/libmpv-shared-preload.cjs', preload);

// Rebuild the actual preload shipped by the application. R22/R15 history showed
// that validating source while shipping a stale generated bundle is not enough.
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
for (const marker of ['LILAC_R23_RENDER_HOTPATH', 'RECEIVER_STATS_INTERVAL_MS', 'direct-receive-webgpu-copy', 'copyExternalImageToTexture']) {
  assert(bundled.includes(marker), `R23 generated preload missing ${marker}`);
}
assert(!bundled.includes('onSubmittedWorkDone('), 'R23 generated preload retained WebGPU completion fence');
assert(!bundled.includes('requestAnimationFrame('), 'R23 generated preload accidentally reintroduced rAF presentation');

// Window drag regression: the whole immersive player is no-drag, and the old
// drag region lived only on .player-top. That element has pointer-events:none
// while controls are hidden, so the full-window video leaves no reliable drag
// hit target. Add a dedicated strip that is present in both windowed playback
// and the libmpv mini-player regardless of control visibility.
let windowCss = read('src/window.css');
const dragMarker = '/* LILAC_R23_WINDOW_DRAG */';
if (!windowCss.includes(dragMarker)) {
  windowCss += `\n\n${dragMarker}\n.immersive-player.windowed::before,\nbody.libmpv-mini-player .immersive-player::before {\n  content: "";\n  position: absolute;\n  top: 0; left: 0; right: 0;\n  height: 54px;\n  z-index: 1;\n  pointer-events: auto;\n  -webkit-app-region: drag;\n}\n.immersive-player.windowed .player-top,\nbody.libmpv-mini-player .immersive-player .player-top {\n  -webkit-app-region: drag;\n}\n.immersive-player.windowed .player-top :is(button,input,select,a,[role="button"]),\nbody.libmpv-mini-player .immersive-player .player-top :is(button,input,select,a,[role="button"]),\n.immersive-player .player-settings {\n  -webkit-app-region: no-drag;\n}\nbody.libmpv-mini-player .immersive-player { cursor: default; }\n`;
}
write('src/window.css', windowCss);
assert(read('src/window.css').includes('body.libmpv-mini-player .immersive-player::before'), 'mini-player drag strip missing');

// Replace only the window-state controller. No libmpv/D3D11/WebGPU code is
// touched here. The key ordering change is: wait for unmaximize -> set bounds ->
// show -> pin topmost. Reapply topmost after show/restore because Windows can
// reset z-order during a state transition.
const miniController = `'use strict';\n\nconst waitForWindowEvent = (win, event, timeout = 1000) => new Promise(resolve => {\n  let settled = false;\n  const done = () => {\n    if (settled) return;\n    settled = true;\n    clearTimeout(timer);\n    win.removeListener?.(event, done);\n    resolve();\n  };\n  const timer = setTimeout(done, timeout);\n  win.once?.(event, done);\n});\n\nclass MiniPlayerWindowController {\n  constructor({ screen, margin = 16, maxWidth = 640 } = {}) {\n    if (!screen) throw new Error('screen is required');\n    this.screen = screen;\n    this.margin = margin;\n    this.maxWidth = maxWidth;\n    this.states = new WeakMap();\n  }\n\n  active(win) { return Boolean(win && this.states.has(win)); }\n\n  async set(win, enabled) {\n    if (!win || win.isDestroyed?.()) return { active: false };\n    return enabled ? this.enter(win) : this.leave(win);\n  }\n\n  async enter(win) {\n    if (this.states.has(win)) {\n      const state = this.states.get(win);\n      state?.pin?.();\n      return { active: true, bounds: win.getBounds?.(), alwaysOnTop: Boolean(win.isAlwaysOnTop?.()) };\n    }\n    const bounds = win.getNormalBounds?.() || win.getBounds();\n    const state = {\n      bounds: { ...bounds },\n      maximized: Boolean(win.isMaximized?.()),\n      fullScreen: Boolean(win.isFullScreen?.()),\n      alwaysOnTop: Boolean(win.isAlwaysOnTop?.()),\n      minimumSize: win.getMinimumSize?.() || [0, 0],\n      resizable: win.isResizable?.() !== false,\n      pin: null\n    };\n    this.states.set(win, state);\n    win.__lilacMiniPlayer = true;\n\n    if (win.isFullScreen?.()) {\n      const left = waitForWindowEvent(win, 'leave-full-screen');\n      win.setFullScreen(false);\n      await left;\n    }\n    if (win.isMaximized?.()) {\n      const restored = waitForWindowEvent(win, 'unmaximize');\n      win.unmaximize();\n      await restored;\n    }\n\n    win.setMinimumSize?.(320, 180);\n    win.setResizable?.(true);\n    const display = this.screen.getDisplayMatching(state.bounds) || this.screen.getPrimaryDisplay();\n    const area = display.workArea;\n    let width = Math.min(this.maxWidth, Math.max(480, Math.floor(area.width * 0.36)));\n    let height = Math.round(width * 9 / 16);\n    if (height > area.height - this.margin * 2) {\n      height = Math.max(180, area.height - this.margin * 2);\n      width = Math.round(height * 16 / 9);\n    }\n    const next = {\n      x: area.x + area.width - width - this.margin,\n      y: area.y + area.height - height - this.margin,\n      width,\n      height\n    };\n\n    const pin = () => {\n      if (this.states.get(win) !== state || win.isDestroyed?.()) return;\n      win.setAlwaysOnTop?.(true, 'floating');\n      if (win.isAlwaysOnTop?.() === false) win.setAlwaysOnTop?.(true);\n      win.moveTop?.();\n    };\n    state.pin = pin;\n    win.on?.('show', pin);\n    win.on?.('restore', pin);\n\n    win.setBounds?.(next, true);\n    win.show?.();\n    pin();\n    win.focus?.();\n    pin();\n    return { active: true, bounds: next, alwaysOnTop: Boolean(win.isAlwaysOnTop?.()) };\n  }\n\n  async leave(win) {\n    const state = this.states.get(win);\n    if (!state) return { active: false };\n    this.states.delete(win);\n    win.__lilacMiniPlayer = false;\n    if (state.pin) {\n      win.removeListener?.('show', state.pin);\n      win.removeListener?.('restore', state.pin);\n    }\n    if (win.isDestroyed?.()) return { active: false };\n\n    win.setAlwaysOnTop?.(state.alwaysOnTop);\n    win.setMinimumSize?.(...state.minimumSize);\n    win.setResizable?.(state.resizable);\n    if (win.isFullScreen?.()) {\n      const left = waitForWindowEvent(win, 'leave-full-screen');\n      win.setFullScreen(false);\n      await left;\n    }\n    if (win.isMaximized?.()) {\n      const restored = waitForWindowEvent(win, 'unmaximize');\n      win.unmaximize();\n      await restored;\n    }\n    win.setBounds?.(state.bounds, true);\n    if (state.maximized) win.maximize?.();\n    if (state.fullScreen) {\n      const entered = waitForWindowEvent(win, 'enter-full-screen');\n      win.setFullScreen(true);\n      await entered;\n    }\n    return { active: false, bounds: state.bounds, alwaysOnTop: Boolean(win.isAlwaysOnTop?.()) };\n  }\n}\n\nmodule.exports = { MiniPlayerWindowController };\n`;
write('electron/miniplayer-window.cjs', miniController);

const finalController = read('electron/miniplayer-window.cjs');
for (const marker of ["waitForWindowEvent(win, 'unmaximize')", "setAlwaysOnTop?.(true, 'floating')", "win.on?.('show', pin)", 'win.moveTop?.()']) {
  assert(finalController.includes(marker), `R23 mini-player controller missing ${marker}`);
}

console.log('R23_RENDER_WINDOW_FIX_OK presenter=direct-webgpu nativeProducer=unchanged statsHz=4 gpuFence=off drag=windowed+mini topmost=reapply-after-bounds');

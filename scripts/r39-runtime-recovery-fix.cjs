'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');
let entry = read('src/libmpv-shared-entry.js');
let player = read('src/player.js');
let main = read('electron/main.cjs');
let preload = read('electron/preload.cjs');
let desktopState = read('electron/desktop-state.cjs');
const pkg = JSON.parse(read('package.json'));

for (const marker of [
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF',
  "presentationMode = 'direct-receive-webgpu-copy'",
  'LILAC_R38_UPDATE_ACTIVITY_CHECK',
  'LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC'
]) {
  const all = bridge + entry + main + read('electron/libmpv-shared-preload.cjs') + read('native/libmpv-d3d11-bridge/player_addon.cc');
  if (!all.includes(marker)) throw new Error(`R39 requires qualified R38 baseline marker: ${marker}`);
}
if (pkg.version !== '0.5.54-libmpv-r3f.rc18' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.54-r38') {
  throw new Error(`R39 expected R38 identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}

// ---------------------------------------------------------------------------
// 1. Refocus cadence recovery.
// Real R38 hardware showed normal 23.976 cadence once settled but active-playback
// supply gaps after native-only -> direct-WebGPU transitions. R30's native producer
// can keep running while Chromium delivery is intentionally absent; do not carry an
// old JS-side absolute deadline across that ownership boundary. Re-anchor only when
// the visible R33 native presenter was actually active, preserving steady focused
// cadence and the R37 explicit ACK handoff itself.
bridge = replaceOnce(
  bridge,
  '  let r37PresenterRegionNativeClears = 0;',
  `  let r37PresenterRegionNativeClears = 0;
  let r39FocusReanchors = 0; // LILAC_R39_REFOCUS_PHASE_REANCHOR
  let r39LastFocusReanchorWallMs = 0;
  let r39FocusAwaitingFirstFrame = false;
  let r39LastFocusFirstFrameMs = 0;
  let r39MaxFocusFirstFrameMs = 0;
  let r39ActivePlaybackGapCount = 0;
  let r39ActivePlaybackGapMaxMs = 0;
  let r39InteractionGapCount = 0;`,
  'R39 cadence diagnostics state'
);

bridge = replaceOnce(
  bridge,
  '  function r32ApplyNativePresenterFocus(focused) {',
  `  function r39ReanchorFocusedPump(reason = 'focus') {
    nextNativeFrameDeadlinePerfAt = 0;
    lastNativeFramePerfAt = 0;
    noFrameBurstCount = 0;
    r39FocusReanchors += 1;
    r39LastFocusReanchorWallMs = Date.now();
    r39FocusAwaitingFirstFrame = true;
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
      pumpTimerDuePerfAt = 0;
    }
    if (!active || disposed || !addon || playerId == null) return;
    if (pumpRunning) nativeWakePending = true;
    else schedulePump(0);
  }

  function r32ApplyNativePresenterFocus(focused) {`,
  'R39 refocus reanchor helper'
);
bridge = replaceOnce(
  bridge,
  `    if (Boolean(focused)) {
      if (r33NativePresenterActive && active && r32TargetVisible && r34BeginFocusHandoff()) {`,
  `    if (Boolean(focused)) {
      if (r33NativePresenterActive) r39ReanchorFocusedPump('native-to-direct-webgpu');
      if (r33NativePresenterActive && active && r32TargetVisible && r34BeginFocusHandoff()) {`,
  'R39 reanchor only on native-to-WebGPU transition'
);

bridge = replaceOnce(
  bridge,
  '      const r26DispatchWallMs = Date.now();\n      const r26DispatchPerfMs = performance.now();',
  `      const r26DispatchWallMs = Date.now();
      const r26DispatchPerfMs = performance.now();
      if (r39FocusAwaitingFirstFrame && r27MainFocused && r39LastFocusReanchorWallMs > 0) {
        r39LastFocusFirstFrameMs = Math.max(0, r26DispatchWallMs - r39LastFocusReanchorWallMs);
        r39MaxFocusFirstFrameMs = Math.max(r39MaxFocusFirstFrameMs, r39LastFocusFirstFrameMs);
        r39FocusAwaitingFirstFrame = false;
      }`,
  'R39 first focused frame latency'
);
bridge = replaceOnce(
  bridge,
  `      if (r27DispatchGapMs >= 60) {
        r27PushRing(r27MainAnomalies, 'anomaly', 'anomaly', {`,
  `      if (r27DispatchGapMs >= 60) {
        const r39GapActivePlayback = lastState?.paused !== true && lastState?.pausedForCache !== true && lastState?.seeking !== true;
        if (r39GapActivePlayback) {
          r39ActivePlaybackGapCount += 1;
          r39ActivePlaybackGapMaxMs = Math.max(r39ActivePlaybackGapMaxMs, r27DispatchGapMs);
        } else {
          r39InteractionGapCount += 1;
        }
        r27PushRing(r27MainAnomalies, 'anomaly', 'anomaly', {`,
  'R39 classify real playback gaps'
);
bridge = replaceOnce(
  bridge,
  `          focused: r27MainFocused,
          handoffPending: r34FocusHandoffPending,`,
  `          focused: r27MainFocused,
          classification: r39GapActivePlayback ? 'active-playback' : 'interaction-or-buffering',
          activePlayback: r39GapActivePlayback,
          handoffPending: r34FocusHandoffPending,`,
  'R39 supply-gap classification fields'
);
bridge = replaceOnce(
  bridge,
  '          r37Handoff: {',
  `          r39RuntimeRecovery: {
            marker: 'LILAC_R39_REFOCUS_PHASE_REANCHOR',
            focusReanchors: r39FocusReanchors,
            lastFocusReanchorWallMs: r39LastFocusReanchorWallMs,
            awaitingFirstFrame: r39FocusAwaitingFirstFrame,
            lastFocusFirstFrameMs: r39LastFocusFirstFrameMs,
            maxFocusFirstFrameMs: r39MaxFocusFirstFrameMs,
            activePlaybackGapCount: r39ActivePlaybackGapCount,
            activePlaybackGapMaxMs: r39ActivePlaybackGapMaxMs,
            interactionGapCount: r39InteractionGapCount
          },
          r37Handoff: {`,
  'R39 cadence diagnostics payload'
);

// ---------------------------------------------------------------------------
// 2. Native subtitle parity.
// R38's published package used visibly different fallback defaults from the DOM
// renderer (105/10/3/400 vs 100/12/2/700-ish). Keep the safe two-renderer ownership
// model required by R33/R37, but make the native fallback consume the same user
// settings and visually equivalent baseline. No profile migration/reset is needed.
entry = replaceOnce(
  entry,
  `    const size = clamp(Number(localStorage.getItem('subtitleSize') || 105), 25, 300);
    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 10), 0, 45);
    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 3), 0, 12);
    const syncMs = Number(localStorage.getItem('subtitleSync') || 0);
    const weight = clamp(Number(localStorage.getItem('vttWeight') || 400), 400, 800);`,
  `    const size = clamp(Number(localStorage.getItem('subtitleSize') || 100), 25, 300); // LILAC_R39_NATIVE_SUBTITLE_PARITY
    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 12), 0, 45);
    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 2), 0, 12);
    const syncMs = Number(localStorage.getItem('subtitleSync') || 0);
    const requestedWeightRaw = localStorage.getItem('vttWeight');
    const requestedWeight = requestedWeightRaw === null ? NaN : Number(requestedWeightRaw);
    const weight = Number.isFinite(requestedWeight)
      ? clamp(Math.round(requestedWeight / 50) * 50, 400, 700)
      : (localStorage.getItem('vttBold') === 'false' ? 400 : 700);`,
  'R39 native subtitle defaults match DOM'
);
entry = replaceOnce(
  entry,
  "      ['set_property', 'sub-pos', clamp(Math.round(100 - position), 55, 97)],",
  "      ['set_property', 'sub-pos', clamp(100 - (position - 1.25), 55, 97)], // match DOM browserVisualBottom",
  'R39 native subtitle vertical parity'
);

// ---------------------------------------------------------------------------
// 3. Real mini-player/topmost observability and self-healing.
// R38 contains the full renderer->preload->main path, but previous qualification
// used a fake BrowserWindow and could not prove the actual Win32 topmost bit.
// Strengthen Windows to the documented pop-up-menu level, verify isAlwaysOnTop,
// re-pin on blur/show/restore/topmost loss, and expose state in user diagnostics.
const miniController = `'use strict';\n\nconst waitForWindowEvent = (win, event, timeout = 1000) => new Promise(resolve => {\n  let settled = false;\n  const done = () => {\n    if (settled) return;\n    settled = true;\n    clearTimeout(timer);\n    win.removeListener?.(event, done);\n    resolve();\n  };\n  const timer = setTimeout(done, timeout);\n  win.once?.(event, done);\n});\nconst wait = ms => new Promise(resolve => setTimeout(resolve, ms));\n\nclass MiniPlayerWindowController {\n  constructor({ screen, margin = 16, maxWidth = 640 } = {}) {\n    if (!screen) throw new Error('screen is required');\n    this.screen = screen;\n    this.margin = margin;\n    this.maxWidth = maxWidth;\n    this.states = new WeakMap();\n    this.diagnostics = new WeakMap();\n  }\n\n  active(win) { return Boolean(win && this.states.has(win)); }\n\n  _diag(win) {\n    let diag = this.diagnostics.get(win);\n    if (!diag) {\n      diag = { marker: 'LILAC_R39_MINIPLAYER_TOPMOST', requested: false, pinAttempts: 0, pinFailures: 0, lastPinAt: 0, lastError: null };\n      this.diagnostics.set(win, diag);\n    }\n    return diag;\n  }\n\n  snapshot(win) {\n    if (!win || win.isDestroyed?.()) return { marker: 'LILAC_R39_MINIPLAYER_TOPMOST', active: false, destroyed: true };\n    const diag = this._diag(win);\n    return {\n      ...diag,\n      active: this.active(win),\n      alwaysOnTop: Boolean(win.isAlwaysOnTop?.()),\n      bounds: win.getBounds?.() || null,\n      focused: Boolean(win.isFocused?.()),\n      visible: Boolean(win.isVisible?.()),\n      fullScreen: Boolean(win.isFullScreen?.()),\n      maximized: Boolean(win.isMaximized?.()),\n      topmostLevel: process.platform === 'win32' ? 'pop-up-menu' : 'floating'\n    };\n  }\n\n  async set(win, enabled) {\n    if (!win || win.isDestroyed?.()) return { marker: 'LILAC_R39_MINIPLAYER_TOPMOST', active: false, destroyed: true };\n    return enabled ? this.enter(win) : this.leave(win);\n  }\n\n  async enter(win) {\n    if (this.states.has(win)) {\n      const state = this.states.get(win);\n      state?.pin?.('reenter');\n      return this.snapshot(win);\n    }\n    const bounds = win.getNormalBounds?.() || win.getBounds();\n    const diag = this._diag(win);\n    diag.requested = true; diag.lastError = null;\n    const state = {\n      bounds: { ...bounds },\n      maximized: Boolean(win.isMaximized?.()),\n      fullScreen: Boolean(win.isFullScreen?.()),\n      alwaysOnTop: Boolean(win.isAlwaysOnTop?.()),\n      minimumSize: win.getMinimumSize?.() || [0, 0],\n      resizable: win.isResizable?.() !== false,\n      listeners: []\n    };\n    this.states.set(win, state);\n    win.__lilacMiniPlayer = true;\n\n    try {\n      if (win.isFullScreen?.()) {\n        const left = waitForWindowEvent(win, 'leave-full-screen');\n        win.setFullScreen(false);\n        await left;\n      }\n      if (win.isMaximized?.()) {\n        const restored = waitForWindowEvent(win, 'unmaximize');\n        win.unmaximize();\n        await restored;\n      }\n\n      win.setMinimumSize?.(320, 180);\n      win.setResizable?.(true);\n      const display = this.screen.getDisplayMatching(state.bounds) || this.screen.getPrimaryDisplay();\n      const area = display.workArea;\n      let width = Math.min(this.maxWidth, Math.max(480, Math.floor(area.width * 0.36)));\n      let height = Math.round(width * 9 / 16);\n      if (height > area.height - this.margin * 2) {\n        height = Math.max(180, area.height - this.margin * 2);\n        width = Math.round(height * 16 / 9);\n      }\n      const next = { x: area.x + area.width - width - this.margin, y: area.y + area.height - height - this.margin, width, height };\n\n      const pin = reason => {\n        if (this.states.get(win) !== state || win.isDestroyed?.()) return false;\n        diag.pinAttempts += 1; diag.lastPinAt = Date.now();\n        try {\n          const level = process.platform === 'win32' ? 'pop-up-menu' : 'floating';\n          win.setAlwaysOnTop?.(true, level);\n          if (win.isAlwaysOnTop?.() === false) win.setAlwaysOnTop?.(true);\n          win.moveTop?.();\n          const ok = win.isAlwaysOnTop?.() !== false;\n          if (!ok) { diag.pinFailures += 1; diag.lastError = 'always-on-top verification failed: ' + String(reason || 'pin'); }\n          return ok;\n        } catch (error) {\n          diag.pinFailures += 1; diag.lastError = String(error?.message || error).slice(0, 200); return false;\n        }\n      };\n      state.pin = pin;\n      const bind = (event, fn) => { win.on?.(event, fn); state.listeners.push([event, fn]); };\n      bind('show', () => pin('show'));\n      bind('restore', () => pin('restore'));\n      bind('focus', () => pin('focus'));\n      bind('blur', () => pin('blur'));\n      bind('always-on-top-changed', (_event, onTop) => { if (!onTop) setTimeout(() => pin('topmost-lost'), 0); });\n\n      win.setBounds?.(next, true);\n      win.show?.();\n      pin('after-show');\n      win.focus?.();\n      pin('after-focus');\n      await wait(50);\n      if (!pin('verify-50ms')) throw new Error(diag.lastError || 'always-on-top verification failed');\n      return this.snapshot(win);\n    } catch (error) {\n      diag.lastError = String(error?.message || error).slice(0, 200);\n      throw error;\n    }\n  }\n\n  async leave(win) {\n    const state = this.states.get(win);\n    const diag = this._diag(win);\n    diag.requested = false;\n    if (!state) return this.snapshot(win);\n    this.states.delete(win);\n    win.__lilacMiniPlayer = false;\n    for (const [event, fn] of state.listeners || []) win.removeListener?.(event, fn);\n    if (win.isDestroyed?.()) return { ...diag, active: false, destroyed: true };\n\n    win.setAlwaysOnTop?.(state.alwaysOnTop);\n    win.setMinimumSize?.(...state.minimumSize);\n    win.setResizable?.(state.resizable);\n    if (win.isFullScreen?.()) {\n      const left = waitForWindowEvent(win, 'leave-full-screen');\n      win.setFullScreen(false);\n      await left;\n    }\n    if (win.isMaximized?.()) {\n      const restored = waitForWindowEvent(win, 'unmaximize');\n      win.unmaximize();\n      await restored;\n    }\n    win.setBounds?.(state.bounds, true);\n    if (state.maximized) win.maximize?.();\n    if (state.fullScreen) {\n      const entered = waitForWindowEvent(win, 'enter-full-screen');\n      win.setFullScreen(true);\n      await entered;\n    }\n    return this.snapshot(win);\n  }\n}\n\nmodule.exports = { MiniPlayerWindowController };\n`;
write('electron/miniplayer-window.cjs', miniController);

main = replaceOnce(
  main,
  "  ipcMain.handle('player:miniplayer', async (event,enabled) => miniPlayerWindow.set(BrowserWindow.fromWebContents(event.sender), Boolean(enabled)));",
  `  ipcMain.handle('player:miniplayer', async (event,enabled) => miniPlayerWindow.set(BrowserWindow.fromWebContents(event.sender), Boolean(enabled)));
  ipcMain.handle('player:miniplayer-state', event => miniPlayerWindow.snapshot(BrowserWindow.fromWebContents(event.sender)));`,
  'R39 mini-player diagnostics IPC'
);
preload = replaceOnce(
  preload,
  "  setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled)),",
  `  setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled)),
  miniPlayerState: () => ipcRenderer.invoke('player:miniplayer-state'),`,
  'R39 mini-player diagnostics preload'
);
player = replaceOnce(
  player,
  `  const result=await invokeMiniPlayer(Boolean(enabled));
  libmpvMiniPlayerActive = Boolean(result?.active);`,
  `  const result=await invokeMiniPlayer(Boolean(enabled));
  if (enabled && result?.active !== true) throw new Error(result?.lastError || '미니 플레이어 전환이 적용되지 않았습니다.');
  if (enabled && result?.alwaysOnTop !== true) throw new Error(result?.lastError || '미니 플레이어 맨 위 고정을 확인하지 못했습니다.');
  libmpvMiniPlayerActive = Boolean(result?.active);`,
  'R39 renderer verifies mini-player/topmost result'
);
entry = replaceOnce(
  entry,
  '      bridge: main || null\n    };',
  `      bridge: main || null,
      miniPlayer: await window.lilac?.miniPlayerState?.().catch(error => ({ error: String(error?.message || error).slice(0, 180) })) || null
    };`,
  'R39 include mini-player in diagnostics'
);

// Keep mini-player bounds out of normal desktop-state persistence. R38 already had
// this guard; assert it rather than silently changing profile behavior.
if (!desktopState.includes('win.__lilacMiniPlayer === true')) throw new Error('R39 requires mini-player desktop-state guard');

// R39 identity. Updater channel remains the custom R2K release stream.
pkg.version = '0.5.54-libmpv-r3f.rc19';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.54-r39';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R39-Setup.${ext}';
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
write('electron/libmpv-shared-main.cjs', bridge);
write('src/libmpv-shared-entry.js', entry);
write('src/player.js', player);
write('electron/main.cjs', main);
write('electron/preload.cjs', preload);

// Source gates: preserve the fixes that removed black flashes and never resurrect
// the failed R25/R28 paths.
const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalEntry = read('src/libmpv-shared-entry.js');
const finalPlayer = read('src/player.js');
const finalMain = read('electron/main.cjs');
const finalPreload = read('electron/preload.cjs');
const finalMini = read('electron/miniplayer-window.cjs');
const sharedPreload = read('electron/libmpv-shared-preload.cjs');
for (const marker of [
  'LILAC_R39_REFOCUS_PHASE_REANCHOR', 'r39ReanchorFocusedPump', "classification: r39GapActivePlayback ? 'active-playback'", 'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK'
]) if (!finalBridge.includes(marker)) throw new Error(`R39 bridge marker missing: ${marker}`);
for (const marker of ['LILAC_R39_NATIVE_SUBTITLE_PARITY', "subtitleSize') || 100", "subtitlePosition') || 12", "vttOutline') ?? 2", "100 - (position - 1.25)"]) if (!finalEntry.includes(marker)) throw new Error(`R39 subtitle marker missing: ${marker}`);
for (const marker of ['LILAC_R39_MINIPLAYER_TOPMOST', "'pop-up-menu'", "bind('blur'", "bind('always-on-top-changed'", 'pinFailures']) if (!finalMini.includes(marker)) throw new Error(`R39 mini-player marker missing: ${marker}`);
if (!finalMain.includes("player:miniplayer-state") || !finalPreload.includes('miniPlayerState:') || !finalPlayer.includes('맨 위 고정을 확인하지 못했습니다') || !finalEntry.includes('miniPlayer: await')) throw new Error('R39 mini-player diagnostics chain incomplete');
if (!sharedPreload.includes("presentationMode = 'direct-receive-webgpu-copy'") || !sharedPreload.includes('copyExternalImageToTexture')) throw new Error('R39 focused direct WebGPU changed');
for (const forbidden of ['focus-staged-gpu-copy', 'copyTextureToTexture(', '--disable-direct-composition']) {
  const all = finalBridge + sharedPreload + finalMain;
  if (all.includes(forbidden)) throw new Error(`R39 forbidden failed-path marker present: ${forbidden}`);
}

console.log('R39_RUNTIME_RECOVERY_FIX_OK blackFlash=R37-preserved focused=direct-webgpu refocus=phase-reanchor gaps=classified subtitle=native-parity pip=verified-topmost+diagnostics updater=R38-preserved');

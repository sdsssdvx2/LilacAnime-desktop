'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => {
  fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
  fs.writeFileSync(file(relative), value, 'utf8');
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

function replaceInside(source, startNeedle, endNeedle, needle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(`${label}: function boundary missing`);
  const block = source.slice(start, end);
  const count = block.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one in-boundary anchor, found ${count}`);
  return source.slice(0, start) + block.replace(needle, replacement) + source.slice(end);
}

function replaceRegexOnce(source, regex, replacement, label) {
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const matches = source.match(new RegExp(regex.source, flags)) || [];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one regex match, found ${matches.length}`);
  return source.replace(regex, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');
let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let entry = read('src/libmpv-shared-entry.js');
let main = read('electron/main.cjs');
let preload = read('electron/preload.cjs');

for (const marker of [
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R37_NO_STALE_UI_HOLES',
  'nextNativeFrameDeadlinePerfAt',
  'advanceNativeFrameDeadline',
  'r32ApplyNativePresenterFocus'
]) assert(bridge.includes(marker), `R39 requires R37 bridge baseline: ${marker}`);
for (const marker of ['LILAC_R33_OWNED_POPUP_FOCUS_SURFACE', 'LILAC_R33_NATIVE_ONLY_UNFOCUSED']) {
  assert(native.includes(marker), `R39 requires R33 native popup baseline: ${marker}`);
}
assert(entry.includes('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC'), 'R39 requires R36 deterministic native subtitle baseline');
assert(main.includes('LILAC_R38_UPDATE_ACTIVITY_CHECK'), 'R39 requires R38 updater lifecycle baseline');
assert(preload.includes('setMiniPlayer:'), 'R39 requires libmpv mini-player preload bridge');
assert(fs.existsSync(file('electron/miniplayer-window.cjs')), 'R39 mini-player controller missing');
if ([bridge, native, entry, main, preload].some(source => source.includes('LILAC_R39_'))) throw new Error('R39 already applied');

// ---------------------------------------------------------------------------
// A) Refocus cadence repair.
// User R38 diagnostics show steady focused presentation at 23.99 fps with ~0.6 ms
// cadence jitter, but after long native-only blur intervals the main dispatch path
// records 156/1109/386/98 ms and later 140/75/67 ms gaps. The absolute source
// deadline survived the native-only interval, leaving a stale phase that must catch
// up when Chromium delivery resumes. Re-anchor the focused pump at every focus-mode
// transition; wake immediately only on focus, never while entering native-only mode.
// ---------------------------------------------------------------------------
bridge = replaceOnce(
  bridge,
  '  let r37PresenterRegionNativeClears = 0;',
  `  let r37PresenterRegionNativeClears = 0;
  let r39PumpPhaseReanchors = 0; // LILAC_R39_REFOCUS_PHASE_REANCHOR
  let r39PumpPhaseWakeups = 0;
  let r39LastPumpPhaseReason = '';
  let r39LastPumpPhaseWallMs = 0;`,
  'R39 phase diagnostic state'
);

bridge = replaceOnce(
  bridge,
  "  function r34SetNativeSubtitleVisible(visible, reason = 'focus') {",
  `  function r39ReanchorPumpPhase(reason = 'focus', wake = false) {
    // R3A's absolute deadline is meaningful only inside one continuous Chromium
    // delivery epoch. Native-only blur intentionally stops Chromium frame delivery.
    lastNativeFramePerfAt = 0;
    nextNativeFrameDeadlinePerfAt = 0;
    r27LastDispatchWallMs = 0;
    r39PumpPhaseReanchors += 1;
    r39LastPumpPhaseReason = String(reason || 'focus');
    r39LastPumpPhaseWallMs = Date.now();
    if (wake) {
      r39PumpPhaseWakeups += 1;
      schedulePump(0);
    }
  }

  function r34SetNativeSubtitleVisible(visible, reason = 'focus') {`,
  'R39 phase helper'
);

bridge = replaceInside(
  bridge,
  '  function r32ApplyNativePresenterFocus(focused) {',
  '  function ensurePlayer() {',
  '    r33FocusTransitions += 1;',
  `    r33FocusTransitions += 1;
    // Reset the stale absolute source phase before either ownership transition.
    // Focus wakes the Chromium pump immediately; blur only invalidates the phase.
    r39ReanchorPumpPhase(Boolean(focused) ? 'focus' : 'blur', Boolean(focused));`,
  'R39 focus phase reanchor'
);

bridge = replaceOnce(
  bridge,
  "        r33FocusSurface: {\n          mode: 'owned-popup-native-only-unfocused',",
  `        r33FocusSurface: {
          mode: 'owned-popup-native-only-unfocused',
          r39PumpPhase: {
            marker: 'LILAC_R39_REFOCUS_PHASE_REANCHOR',
            reanchors: r39PumpPhaseReanchors,
            wakeups: r39PumpPhaseWakeups,
            lastReason: r39LastPumpPhaseReason,
            lastWallMs: r39LastPumpPhaseWallMs
          },`,
  'R39 phase diagnostics'
);

// ---------------------------------------------------------------------------
// B) PiP / mini-player z-order repair.
// The BrowserWindow can be topmost while the R33 unfocused video is actually drawn
// by a separate owned WS_POPUP. R33 deliberately used SWP_NOZORDER, so that native
// popup did not explicitly follow a topmost mini-player owner. When the owner is
// topmost, promote the popup to HWND_TOPMOST at the exact moment it becomes visible.
// Ordinary non-topmost playback keeps the original no-z-order behavior.
// ---------------------------------------------------------------------------
const oldNativeVisible = `      SetWindowPos(player->nativePresenterHwnd, nullptr,
                   screenRect.left, screenRect.top,
                   std::max<LONG>(2, screenRect.right - screenRect.left),
                   std::max<LONG>(2, screenRect.bottom - screenRect.top),
                   SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER |
                     (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));`;
const newNativeVisible = `      const bool r39OwnerTopmost = player->nativePresenterParent &&
        (GetWindowLongPtrW(player->nativePresenterParent, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
      const HWND r39InsertAfter = r39OwnerTopmost ? HWND_TOPMOST : nullptr;
      const UINT r39Flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER |
        (r39OwnerTopmost ? 0 : SWP_NOZORDER) |
        (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);
      SetWindowPos(player->nativePresenterHwnd, r39InsertAfter,
                   screenRect.left, screenRect.top,
                   std::max<LONG>(2, screenRect.right - screenRect.left),
                   std::max<LONG>(2, screenRect.bottom - screenRect.top),
                   r39Flags); // LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC`;
native = replaceInside(
  native,
  'napi_value SetNativePresenterVisible(',
  'napi_value SetNativePresenterBounds(',
  oldNativeVisible,
  newNativeVisible,
  'R39 native popup topmost sync'
);

native = replaceOnce(
  native,
  '  Set(env, out, "ownerMatches", BoolValue(env, r33Owner == player->nativePresenterParent));\n  Set(env, out, "windowVisible", BoolValue(env, player->nativePresenterHwnd && IsWindowVisible(player->nativePresenterHwnd)));',
  `  Set(env, out, "ownerMatches", BoolValue(env, r33Owner == player->nativePresenterParent));
  const bool r39OwnerTopmost = player->nativePresenterParent &&
    (GetWindowLongPtrW(player->nativePresenterParent, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
  const bool r39WindowTopmost = player->nativePresenterHwnd &&
    (GetWindowLongPtrW(player->nativePresenterHwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
  Set(env, out, "ownerTopmost", BoolValue(env, r39OwnerTopmost)); // LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC
  Set(env, out, "windowTopmost", BoolValue(env, r39WindowTopmost));
  Set(env, out, "windowVisible", BoolValue(env, player->nativePresenterHwnd && IsWindowVisible(player->nativePresenterHwnd)));`,
  'R39 native popup topmost diagnostics'
);

// Strengthen the BrowserWindow side too. The self-healing pin is active only while
// mini-player mode is active and therefore adds no steady background playback work.
const miniController = `'use strict';

const waitForWindowEvent = (win, event, timeout = 1000) => new Promise(resolve => {
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    win.removeListener?.(event, done);
    resolve();
  };
  const timer = setTimeout(done, timeout);
  win.once?.(event, done);
});

class MiniPlayerWindowController {
  constructor({ screen, margin = 16, maxWidth = 640 } = {}) {
    if (!screen) throw new Error('screen is required');
    this.screen = screen;
    this.margin = margin;
    this.maxWidth = maxWidth;
    this.states = new WeakMap();
  }

  active(win) { return Boolean(win && this.states.has(win)); }

  snapshot(win) {
    const state = win && this.states.get(win);
    if (state?.diag) return { ...state.diag, bounds: win.getBounds?.() || state.diag.bounds };
    return {
      marker: 'LILAC_R39_MINIPLAYER_TOPMOST',
      active: false,
      alwaysOnTop: Boolean(win && !win.isDestroyed?.() && win.isAlwaysOnTop?.()),
      pinCount: 0,
      pinFailures: 0,
      lastPinAt: 0,
      level: 'screen-saver'
    };
  }

  async set(win, enabled) {
    if (!win || win.isDestroyed?.()) return { active: false };
    return enabled ? this.enter(win) : this.leave(win);
  }

  async enter(win) {
    if (this.states.has(win)) {
      const state = this.states.get(win);
      state?.pin?.('reenter');
      return this.snapshot(win);
    }
    const bounds = win.getNormalBounds?.() || win.getBounds();
    const state = {
      bounds: { ...bounds },
      maximized: Boolean(win.isMaximized?.()),
      fullScreen: Boolean(win.isFullScreen?.()),
      alwaysOnTop: Boolean(win.isAlwaysOnTop?.()),
      minimumSize: win.getMinimumSize?.() || [0, 0],
      resizable: win.isResizable?.() !== false,
      pin: null,
      hooks: [],
      diag: {
        marker: 'LILAC_R39_MINIPLAYER_TOPMOST',
        active: true,
        alwaysOnTop: false,
        pinCount: 0,
        pinFailures: 0,
        lastPinAt: 0,
        lastReason: 'enter',
        level: 'screen-saver',
        bounds: null
      }
    };
    this.states.set(win, state);
    win.__lilacMiniPlayer = true;
    win.__lilacMiniPlayerDiagnostics = state.diag;

    if (win.isFullScreen?.()) {
      const left = waitForWindowEvent(win, 'leave-full-screen');
      win.setFullScreen(false);
      await left;
    }
    if (win.isMaximized?.()) {
      const restored = waitForWindowEvent(win, 'unmaximize');
      win.unmaximize();
      await restored;
    }

    win.setMinimumSize?.(320, 180);
    win.setResizable?.(true);
    const display = this.screen.getDisplayMatching(state.bounds) || this.screen.getPrimaryDisplay();
    const area = display.workArea;
    let width = Math.min(this.maxWidth, Math.max(480, Math.floor(area.width * 0.36)));
    let height = Math.round(width * 9 / 16);
    if (height > area.height - this.margin * 2) {
      height = Math.max(180, area.height - this.margin * 2);
      width = Math.round(height * 16 / 9);
    }
    const next = {
      x: area.x + area.width - width - this.margin,
      y: area.y + area.height - height - this.margin,
      width,
      height
    };
    state.diag.bounds = { ...next };

    let pinning = false;
    const pin = (reason = 'event') => {
      if (pinning || this.states.get(win) !== state || win.isDestroyed?.()) return;
      pinning = true;
      try {
        state.diag.pinCount += 1;
        state.diag.lastPinAt = Date.now();
        state.diag.lastReason = String(reason);
        try { win.setAlwaysOnTop?.(true, 'screen-saver'); }
        catch { win.setAlwaysOnTop?.(true, 'floating'); }
        if (win.isAlwaysOnTop?.() === false) win.setAlwaysOnTop?.(true);
        win.moveTop?.();
        state.diag.alwaysOnTop = Boolean(win.isAlwaysOnTop?.());
        if (!state.diag.alwaysOnTop) state.diag.pinFailures += 1;
      } catch {
        state.diag.pinFailures += 1;
      } finally {
        win.__lilacMiniPlayerDiagnostics = state.diag;
        pinning = false;
      }
    };
    state.pin = pin;

    const hook = (event, handler) => {
      win.on?.(event, handler);
      state.hooks.push([event, handler]);
    };
    hook('show', () => pin('show'));
    hook('restore', () => pin('restore'));
    hook('focus', () => pin('focus'));
    hook('blur', () => pin('blur'));
    hook('always-on-top-changed', (_event, isAlwaysOnTop) => {
      state.diag.alwaysOnTop = Boolean(isAlwaysOnTop);
      if (!isAlwaysOnTop) setTimeout(() => pin('topmost-lost'), 0);
    });

    win.setBounds?.(next, true);
    win.show?.();
    pin('show-complete');
    win.focus?.();
    pin('focus-complete');
    return this.snapshot(win);
  }

  async leave(win) {
    const state = this.states.get(win);
    if (!state) return { active: false };
    this.states.delete(win);
    win.__lilacMiniPlayer = false;
    for (const [event, handler] of state.hooks || []) win.removeListener?.(event, handler);
    if (win.isDestroyed?.()) return { active: false };

    win.setAlwaysOnTop?.(state.alwaysOnTop);
    win.setMinimumSize?.(...state.minimumSize);
    win.setResizable?.(state.resizable);
    if (win.isFullScreen?.()) {
      const left = waitForWindowEvent(win, 'leave-full-screen');
      win.setFullScreen(false);
      await left;
    }
    if (win.isMaximized?.()) {
      const restored = waitForWindowEvent(win, 'unmaximize');
      win.unmaximize();
      await restored;
    }
    win.setBounds?.(state.bounds, true);
    if (state.maximized) win.maximize?.();
    if (state.fullScreen) {
      const entered = waitForWindowEvent(win, 'enter-full-screen');
      win.setFullScreen(true);
      await entered;
    }
    const finalDiag = {
      ...state.diag,
      active: false,
      alwaysOnTop: Boolean(win.isAlwaysOnTop?.()),
      lastReason: 'leave',
      bounds: win.getBounds?.() || state.bounds
    };
    win.__lilacMiniPlayerDiagnostics = finalDiag;
    return finalDiag;
  }
}

module.exports = { MiniPlayerWindowController };
`;
write('electron/miniplayer-window.cjs', miniController);

main = replaceOnce(
  main,
  "  ipcMain.handle('player:miniplayer', async (event,enabled) => miniPlayerWindow.set(BrowserWindow.fromWebContents(event.sender), Boolean(enabled)));",
  `  ipcMain.handle('player:miniplayer', async (event,enabled) => miniPlayerWindow.set(BrowserWindow.fromWebContents(event.sender), Boolean(enabled))); // LILAC_R39_MINIPLAYER_TOPMOST
  ipcMain.handle('player:miniplayer-state', async event => miniPlayerWindow.snapshot(BrowserWindow.fromWebContents(event.sender)));`,
  'R39 mini-player diagnostics IPC'
);
preload = replaceOnce(
  preload,
  "  setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled)),",
  `  setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled)), // LILAC_R39_MINIPLAYER_TOPMOST
  miniPlayerState: () => ipcRenderer.invoke('player:miniplayer-state'),`,
  'R39 mini-player diagnostics preload'
);

bridge = replaceOnce(
  bridge,
  "        r33FocusSurface: {\n          mode: 'owned-popup-native-only-unfocused',",
  `        r39MiniPlayer: attachedWindow?.__lilacMiniPlayerDiagnostics || {
          marker: 'LILAC_R39_MINIPLAYER_TOPMOST',
          active: false,
          alwaysOnTop: Boolean(attachedWindow && !attachedWindow.isDestroyed?.() && attachedWindow.isAlwaysOnTop?.()),
          pinCount: 0,
          pinFailures: 0,
          lastPinAt: 0,
          level: 'screen-saver'
        },
        r33FocusSurface: {
          mode: 'owned-popup-native-only-unfocused',`,
  'R39 mini-player bridge diagnostics'
);

// ---------------------------------------------------------------------------
// C) Native subtitle parity repair.
// Keep the R36 deterministic plain-source + strip policy, but align its baseline
// defaults and vertical position with the Chromium DOM path. The DOM path includes
// the browser-equivalent 22/720 bottom inset; the native fallback previously did not.
// ---------------------------------------------------------------------------
const styleStart = entry.indexOf('  async _syncR32NativeSubtitleFallbackStyle() {');
const styleEnd = entry.indexOf('\n  async _loadTrack(', styleStart);
assert(styleStart >= 0 && styleEnd > styleStart, 'R39 native subtitle style helper boundary missing');
let styleBlock = entry.slice(styleStart, styleEnd);
styleBlock = replaceRegexOnce(styleBlock,
  /const size = clamp\(Number\(localStorage\.getItem\('subtitleSize'\) \|\| \d+\), 25, 300\);/,
  "const size = clamp(Number(localStorage.getItem('subtitleSize') || 100), 25, 300); // LILAC_R39_NATIVE_SUBTITLE_PARITY",
  'R39 subtitle size default');
styleBlock = replaceRegexOnce(styleBlock,
  /const position = clamp\(Number\(localStorage\.getItem\('subtitlePosition'\) \|\| \d+\), 0, 45\);/,
  "const position = clamp(Number(localStorage.getItem('subtitlePosition') || 12), 0, 45);",
  'R39 subtitle position default');
styleBlock = replaceRegexOnce(styleBlock,
  /const outline = clamp\(Number\(localStorage\.getItem\('vttOutline'\) \?\? [\d.]+\), 0, 12\);/,
  "const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 2), 0, 12);",
  'R39 subtitle outline default');
styleBlock = replaceRegexOnce(styleBlock,
  /const weight = clamp\(Number\(localStorage\.getItem\('vttWeight'\) \|\| \d+\), 400, 800\);/,
  "const weight = clamp(Number(localStorage.getItem('vttWeight') || 700), 400, 800);",
  'R39 subtitle weight default');
styleBlock = replaceOnce(
  styleBlock,
  '    const commands = [',
  `    const browserBottomInset = clamp(position + (22 / 720 * 100), 0, 48);
    const commands = [`,
  'R39 native browser inset'
);
styleBlock = replaceRegexOnce(styleBlock,
  /\['set_property', 'sub-pos', clamp\(Math\.round\(100 - position\), 55, 97\)\]/,
  "['set_property', 'sub-pos', clamp(Math.round(100 - browserBottomInset), 52, 97)]",
  'R39 native subtitle vertical parity');
entry = entry.slice(0, styleStart) + styleBlock + entry.slice(styleEnd);

// Keep all known-safe invariants explicit.
assert(bridge.includes('LILAC_R39_REFOCUS_PHASE_REANCHOR'), 'R39 phase marker missing');
assert(bridge.includes("r39ReanchorPumpPhase(Boolean(focused) ? 'focus' : 'blur', Boolean(focused))"), 'R39 focus reanchor call missing');
assert(native.includes('LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC'), 'R39 native topmost marker missing');
assert(native.includes('HWND_TOPMOST'), 'R39 native topmost promotion missing');
assert(entry.includes('LILAC_R39_NATIVE_SUBTITLE_PARITY') && entry.includes('browserBottomInset'), 'R39 subtitle parity marker missing');
assert(entry.includes("'sub-ass-override', 'strip'"), 'R39 lost R36 deterministic subtitle strip policy');
assert(!entry.includes("'sub-ass-override', 'force'") && !entry.includes("'sub-ass-override', 'scale'"), 'R39 resurrected rejected subtitle override policy');
assert(main.includes('LILAC_R38_UPDATE_ACTIVITY_CHECK'), 'R39 changed/lost R38 updater lifecycle wiring');
assert(main.includes('LILAC_R39_MINIPLAYER_TOPMOST') && preload.includes('miniPlayerState:'), 'R39 mini-player diagnostics bridge missing');
assert(!bridge.includes('focus-staged-gpu-copy'), 'R39 resurrected failed staged WebGPU path');
assert(!native.includes('--disable-direct-composition'), 'R39 resurrected failed Direct Composition disable path');

write('electron/libmpv-shared-main.cjs', bridge);
write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('src/libmpv-shared-entry.js', entry);
write('electron/main.cjs', main);
write('electron/preload.cjs', preload);

console.log('R39_REFOCUS_PIP_SUBTITLE_FIX_OK refocus=absolute-phase-reanchor+immediate-focused-wake pip=browser+owned-popup-topmost subtitle=dom-baseline+browser-inset blackFlashPath=R37-preserved updater=R38-preserved');

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_HTML = 64 * 1024;
const MAX_CUES = 16;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function cleanStyle(style = {}) {
  const out = {};
  for (const [key, value] of Object.entries(style || {})) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    const text = String(value ?? '');
    if (text.length <= 2048) out[key] = text;
  }
  return out;
}
function sanitizePayload(payload = {}) {
  const rect = payload.stackRect || {};
  const cues = Array.isArray(payload.cues) ? payload.cues.slice(0, MAX_CUES).map(cue => ({
    html: String(cue?.html || '').slice(0, MAX_HTML),
    style: cleanStyle(cue?.style)
  })) : [];
  const fontPath = String(payload.fontPath || '');
  let fontUrl = '';
  if (fontPath && path.isAbsolute(fontPath)) {
    try { fontUrl = pathToFileURL(fontPath).href; } catch {}
  }
  return {
    marker: 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
    revision: Math.max(0, Math.floor(finite(payload.revision))),
    active: payload.active === true && cues.length > 0,
    stackRect: {
      x: finite(rect.x), y: finite(rect.y),
      width: Math.max(0, finite(rect.width)), height: Math.max(0, finite(rect.height))
    },
    stackStyle: cleanStyle(payload.stackStyle),
    stackGap: String(payload.stackGap || '0px').slice(0, 128),
    stackAlignItems: String(payload.stackAlignItems || 'center').slice(0, 64),
    stackJustifyContent: String(payload.stackJustifyContent || 'normal').slice(0, 64),
    fontUrl,
    cues
  };
}

class R40SubtitleOverlayWindowController {
  constructor({ BrowserWindow, baseDir = __dirname } = {}) {
    if (!BrowserWindow) throw new Error('R40 subtitle overlay requires BrowserWindow');
    this.BrowserWindow = BrowserWindow;
    this.baseDir = baseDir;
    this.window = null;
    this.parent = null;
    this.ready = false;
    this.pending = null;
    this.deferredActivePayload = null; // LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY
    this.visible = false;
    this.updates = 0;
    this.showCount = 0;
    this.hideCount = 0;
    this.syncCount = 0;
    this.deferredCount = 0;
    this.deferredReplayCount = 0;
    this.failures = 0;
    this.lastReason = 'init';
    this.lastError = '';
  }

  async ensure(parent) {
    if (!parent || parent.isDestroyed?.()) return null;
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new this.BrowserWindow({
      parent,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(this.baseDir, 'r40-subtitle-overlay-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    this.window = win;
    this.parent = parent;
    this.ready = false;
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setMenuBarVisibility?.(false);
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.ready = false;
        this.visible = false;
      }
    });
    win.webContents.on('did-finish-load', () => {
      if (this.window !== win) return;
      this.ready = true;
      if (this.pending) win.webContents.send('r40-subtitle-overlay:render', this.pending);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      this.failures += 1;
      this.lastError = `renderer-gone:${details?.reason || 'unknown'}`;
      this.ready = false;
      this.visible = false;
    });
    await win.loadFile(path.join(this.baseDir, 'r40-subtitle-overlay.html'));
    this.sync(parent, 'create');
    return win;
  }

  sync(parent = this.parent, reason = 'sync') {
    const win = this.window;
    if (!win || win.isDestroyed() || !parent || parent.isDestroyed?.()) return false;
    try {
      const bounds = parent.getContentBounds();
      win.setBounds({ x: bounds.x, y: bounds.y, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) }, false);
      const topmost = Boolean(parent.isAlwaysOnTop?.());
      if (topmost) win.setAlwaysOnTop(true, 'screen-saver');
      else win.setAlwaysOnTop(false);
      if (this.visible) {
        win.showInactive();
        win.moveTop?.();
      }
      this.syncCount += 1;
      this.lastReason = reason;
      return true;
    } catch (error) {
      this.failures += 1;
      this.lastError = String(error?.message || error).slice(0, 240);
      return false;
    }
  }

  _inactivePayload(source = this.pending) {
    return source ? { ...source, active:false, cues:[] } : { active:false, cues:[] };
  }

  async update(parent, payload = {}) {
    const safe = sanitizePayload(payload);
    this.updates += 1;
    const parentInvalid = !parent || parent.isDestroyed?.() || parent.isMinimized?.() || !parent.isVisible?.();
    if (!safe.active || parentInvalid) {
      this.deferredActivePayload = null;
      this.pending = this._inactivePayload(safe);
      this.hide('inactive-or-unavailable');
      return { ok: true, visible: false, ...this.snapshot() };
    }

    // Renderer document blur can lead BrowserWindow blur by a small amount. Do not
    // discard the active cue merely because main-process focus has not caught up.
    // Keep only the newest active payload and replay it exactly once from owner blur.
    if (parent.isFocused?.()) {
      this.deferredActivePayload = safe;
      this.deferredCount += 1;
      this.pending = this._inactivePayload(safe);
      this.hide('deferred-owner-focused', { preserveDeferred:true });
      return { ok: true, visible: false, deferred: true, ...this.snapshot() };
    }

    this.deferredActivePayload = null;
    this.pending = safe;
    const win = await this.ensure(parent);
    if (!win) return { ok: false, visible: false, ...this.snapshot() };
    this.sync(parent, 'payload');
    if (this.ready && !win.webContents.isDestroyed()) win.webContents.send('r40-subtitle-overlay:render', safe);
    if (!win.isVisible()) this.showCount += 1;
    this.visible = true;
    win.showInactive();
    win.moveTop?.();
    this.lastReason = 'payload-active';
    return { ok: true, visible: true, ...this.snapshot() };
  }

  async reconcileDeferred(parent = this.parent, reason = 'owner-blur') {
    const deferred = this.deferredActivePayload;
    if (!deferred) return { ok:true, replayed:false, ...this.snapshot() };
    if (!parent || parent.isDestroyed?.() || parent.isMinimized?.() || !parent.isVisible?.()) {
      this.deferredActivePayload = null;
      this.hide(`${reason}-unavailable`);
      return { ok:true, replayed:false, ...this.snapshot() };
    }
    if (parent.isFocused?.()) return { ok:true, replayed:false, deferred:true, ...this.snapshot() };
    this.deferredActivePayload = null;
    this.deferredReplayCount += 1;
    const result = await this.update(parent, deferred);
    this.lastReason = result?.visible ? `${reason}-replayed` : `${reason}-replay-hidden`;
    return { ...result, replayed:true };
  }

  hide(reason = 'hide', { preserveDeferred = false } = {}) {
    const win = this.window;
    if (!preserveDeferred) this.deferredActivePayload = null;
    this.pending = this._inactivePayload(this.pending);
    if (win && !win.isDestroyed()) {
      try { if (this.ready && !win.webContents.isDestroyed()) win.webContents.send('r40-subtitle-overlay:render', this.pending); } catch {}
      if (win.isVisible()) this.hideCount += 1;
      try { win.hide(); } catch {}
    }
    this.visible = false;
    this.lastReason = reason;
  }

  destroy(reason = 'destroy') {
    this.hide(reason);
    const win = this.window;
    this.window = null;
    this.ready = false;
    this.parent = null;
    this.pending = null;
    this.deferredActivePayload = null;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
  }

  snapshot() {
    const win = this.window;
    return {
      marker: 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
      active: this.visible,
      ready: this.ready,
      windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
      alwaysOnTop: Boolean(win && !win.isDestroyed() && win.isAlwaysOnTop?.()),
      deferredActive: Boolean(this.deferredActivePayload),
      updates: this.updates,
      showCount: this.showCount,
      hideCount: this.hideCount,
      syncCount: this.syncCount,
      deferredCount: this.deferredCount,
      deferredReplayCount: this.deferredReplayCount,
      failures: this.failures,
      lastReason: this.lastReason,
      lastError: this.lastError
    };
  }
}

module.exports = { R40SubtitleOverlayWindowController, sanitizePayload };

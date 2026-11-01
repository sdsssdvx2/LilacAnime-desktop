'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const controllerPath = path.join(root, 'electron', 'r40-subtitle-overlay-window.cjs');
const mainPath = path.join(root, 'electron', 'main.cjs');
const packagePath = path.join(root, 'package.json');
const marker = 'LILAC_R44_PREWARMED_SUBTITLE_OVERLAY';

function once(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`R44 anchor missing: ${label}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`R44 anchor duplicated: ${label}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

let controller = fs.readFileSync(controllerPath, 'utf8').replace(/\r\n/g, '\n');
let main = fs.readFileSync(mainPath, 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

for (const required of [
  'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
  'LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY',
  'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND',
  'r43-inactive-payload-kept-hwnd',
  'r43-payload-active-existing-hwnd'
]) {
  if (!controller.includes(required)) throw new Error(`R44 requires qualified R43 controller marker ${required}`);
}
if (controller.includes(marker) || main.includes(marker)) throw new Error('R44 transform already applied');

controller = once(
  controller,
  "    this.r43Marker = 'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND';\n    this.updates = 0;",
  "    this.r43Marker = 'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND';\n    this.r44Marker = 'LILAC_R44_PREWARMED_SUBTITLE_OVERLAY';\n    this.ensurePromise = null;\n    this.revealPending = false;\n    this.prewarmRequests = 0;\n    this.prewarmShows = 0;\n    this.prewarmReveals = 0;\n    this.firstShowSafeReveals = 0;\n    this.zOrderReanchors = 0;\n    this.transitionTrace = [];\n    this.updates = 0;",
  'constructor R44 state'
);

controller = once(
  controller,
  "  async ensure(parent) {\n    if (!parent || parent.isDestroyed?.()) return null;\n    if (this.window && !this.window.isDestroyed()) return this.window;",
  `  _r44Trace(kind, parent = this.parent, extra = {}) {
    let opacity = null;
    const win = this.window;
    try { opacity = win && !win.isDestroyed() && typeof win.getOpacity === 'function' ? win.getOpacity() : null; } catch {}
    this.transitionTrace.push({
      wallMs: Date.now(), kind,
      focused: Boolean(parent && !parent.isDestroyed?.() && parent.isFocused?.()),
      minimized: Boolean(parent && !parent.isDestroyed?.() && parent.isMinimized?.()),
      hwndVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
      controllerVisible: Boolean(this.visible),
      contentActive: Boolean(this.contentActive),
      ready: Boolean(this.ready),
      revealPending: Boolean(this.revealPending),
      opacity,
      ...extra
    });
    if (this.transitionTrace.length > 128) this.transitionTrace.splice(0, this.transitionTrace.length - 128);
  }

  async _r44RevealAfterPaint(win, parent, reason) {
    if (!win || win.isDestroyed()) return false;
    this.revealPending = true;
    this._r44Trace('reveal-wait', parent, { reason });
    try {
      if (this.ready && !win.webContents.isDestroyed()) {
        await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      }
    } catch (error) {
      this.failures += 1;
      this.lastError = String(error?.message || error).slice(0, 240);
    }
    if (this.window !== win || win.isDestroyed() || !this.visible || !win.isVisible()) {
      this.revealPending = false;
      this._r44Trace('reveal-cancel-hidden', parent, { reason });
      return false;
    }
    if (!parent || parent.isDestroyed?.() || parent.isFocused?.() || parent.isMinimized?.() || this.ownerLifecycleSuppressed) {
      this.revealPending = false;
      this._r44Trace('reveal-cancel-owner', parent, { reason });
      return false;
    }
    try { if (typeof win.setOpacity === 'function') win.setOpacity(1); } catch {}
    this.revealPending = false;
    this._r44Trace('reveal-visible', parent, { reason });
    return true;
  }

  async ensure(parent) {
    if (!parent || parent.isDestroyed?.()) return null;
    if (this.window && !this.window.isDestroyed()) {
      if (!this.ready && this.ensurePromise) {
        try { await this.ensurePromise; } catch {}
      }
      return this.window && !this.window.isDestroyed() ? this.window : null;
    }`,
  'serialize concurrent ensure calls'
);

controller = once(
  controller,
  "        this.window = null;\n        this.ready = false;\n        this.visible = false;\n        this.contentActive = false;",
  "        this.window = null;\n        this.ready = false;\n        this.ensurePromise = null;\n        this.revealPending = false;\n        this.visible = false;\n        this.contentActive = false;",
  'closed R44 state reset'
);

controller = once(
  controller,
  "      this.ready = false;\n      this.visible = false;\n      this.contentActive = false;",
  "      this.ready = false;\n      this.ensurePromise = null;\n      this.revealPending = false;\n      this.visible = false;\n      this.contentActive = false;",
  'renderer-gone R44 state reset'
);

controller = once(
  controller,
  "    await win.loadFile(path.join(this.baseDir, 'r40-subtitle-overlay.html'));\n    this.sync(parent, 'create');\n    return win;",
  "    this.ensurePromise = win.loadFile(path.join(this.baseDir, 'r40-subtitle-overlay.html'));\n    try { await this.ensurePromise; } finally { if (this.window === win) this.ensurePromise = null; }\n    this.sync(parent, 'create');\n    this._r44Trace('load-ready', parent);\n    return win;",
  'shared load promise'
);

controller = once(
  controller,
  `      if (this.visible) {
        // R43: an already-visible transparent owned HWND must not be re-shown for
        // geometry/z-order sync. showInactive() is reserved for the first active
        // cue of an unfocused owner session so DWM never re-animates cue changes.
        if (!win.isVisible()) win.showInactive();
        win.moveTop?.();
      }`,
  `      if (this.visible) {
        // ${marker}: cue updates must not churn Win32 owned-popup z-order. Re-anchor
        // only for actual owner geometry/lifecycle changes; prewarm/first-show do
        // their own single explicit moveTop after the HWND enters the session.
        if (!win.isVisible()) win.showInactive();
        const reanchor = !['payload', 'r43-inactive-clear-keep-hwnd'].includes(reason);
        if (reanchor) { win.moveTop?.(); this.zOrderReanchors += 1; }
      }`,
  'stable overlay z-order'
);

controller = once(
  controller,
  "  async update(parent, payload = {}) {",
  `  async prewarm(parent, reason = 'owner-blur') {
    this.prewarmRequests += 1;
    this._r44Trace('prewarm-request', parent, { reason });
    if (!parent || parent.isDestroyed?.() || parent.isFocused?.() || parent.isMinimized?.() || this.ownerLifecycleSuppressed) {
      this._r44Trace('prewarm-skip-owner', parent, { reason });
      return { ok:true, prewarmed:false, ...this.snapshot() };
    }
    const win = await this.ensure(parent);
    if (!win || win.isDestroyed()) return { ok:false, prewarmed:false, ...this.snapshot() };
    if (parent.isDestroyed?.() || parent.isFocused?.() || parent.isMinimized?.() || this.ownerLifecycleSuppressed) {
      this._r44Trace('prewarm-cancel-after-load', parent, { reason });
      return { ok:true, prewarmed:false, ...this.snapshot() };
    }
    this.pending = this._inactivePayload(this.pending);
    this.sync(parent, 'r44-prewarm-bounds');
    try {
      if (this.ready && !win.webContents.isDestroyed()) win.webContents.send('r40-subtitle-overlay:render', this.pending);
    } catch {}
    if (!win.isVisible()) {
      try { if (typeof win.setOpacity === 'function') win.setOpacity(0); } catch {}
      this.showCount += 1;
      this.prewarmShows += 1;
      this.visible = true;
      this.contentActive = false;
      win.showInactive();
      win.moveTop?.();
      this.zOrderReanchors += 1;
      this._r44Trace('prewarm-show-opacity-zero', parent, { reason });
      const revealed = await this._r44RevealAfterPaint(win, parent, reason);
      if (revealed) this.prewarmReveals += 1;
    } else {
      this.visible = true;
      this.contentActive = false;
      if (!this.revealPending) { try { if (typeof win.setOpacity === 'function') win.setOpacity(1); } catch {} }
      this._r44Trace('prewarm-existing-hwnd', parent, { reason });
    }
    this.lastReason = 'r44-prewarmed-owner-blur';
    return { ok:true, prewarmed:true, ...this.snapshot() };
  }

  async update(parent, payload = {}) {`,
  'R44 prewarm method'
);

controller = once(
  controller,
  `    const wasWindowVisible = win.isVisible();
    if (!wasWindowVisible) this.showCount += 1;
    this.visible = true;
    this.contentActive = true;
    if (!wasWindowVisible) win.showInactive();
    win.moveTop?.();
    this.lastReason = wasWindowVisible ? 'r43-payload-active-existing-hwnd' : 'payload-active';`,
  `    const wasWindowVisible = win.isVisible();
    if (!wasWindowVisible) {
      this.showCount += 1;
      try { if (typeof win.setOpacity === 'function') win.setOpacity(0); } catch {}
      this.visible = true;
      this.contentActive = true;
      win.showInactive();
      win.moveTop?.();
      this.zOrderReanchors += 1;
      this._r44Trace('active-first-show-opacity-zero', parent, { revision: safe.revision });
      if (await this._r44RevealAfterPaint(win, parent, 'r44-active-first-show')) this.firstShowSafeReveals += 1;
    } else {
      this.visible = true;
      this.contentActive = true;
      if (!this.revealPending) { try { if (typeof win.setOpacity === 'function') win.setOpacity(1); } catch {} }
      this._r44Trace('active-existing-prewarmed-hwnd', parent, { revision: safe.revision });
    }
    this.lastReason = wasWindowVisible ? 'r44-payload-active-prewarmed-hwnd' : 'r44-payload-active-safe-first-show';`,
  'opacity-zero first active show'
);

controller = once(
  controller,
  "      if (win.isVisible()) this.hideCount += 1;\n      try { win.hide(); } catch {}",
  "      if (win.isVisible()) this.hideCount += 1;\n      this._r44Trace('hard-hide-start', this.parent, { reason });\n      this.revealPending = false;\n      try { if (typeof win.setOpacity === 'function') win.setOpacity(0); } catch {}\n      try { win.hide(); } catch {}\n      this._r44Trace('hard-hide-done', this.parent, { reason });",
  'opacity-zero hard hide'
);

controller = once(
  controller,
  "      r43Marker: this.r43Marker,\n      active: this.contentActive,",
  "      r43Marker: this.r43Marker,\n      r44Marker: this.r44Marker,\n      active: this.contentActive,\n      revealPending: this.revealPending,\n      prewarmRequests: this.prewarmRequests,\n      prewarmShows: this.prewarmShows,\n      prewarmReveals: this.prewarmReveals,\n      firstShowSafeReveals: this.firstShowSafeReveals,\n      zOrderReanchors: this.zOrderReanchors,\n      transitionTrace: this.transitionTrace.slice(),",
  'R44 diagnostic snapshot'
);

controller = once(
  controller,
  "    this.ready = false;\n    this.parent = null;",
  "    this.ready = false;\n    this.ensurePromise = null;\n    this.revealPending = false;\n    this.parent = null;",
  'destroy R44 reset'
);

main = once(
  main,
  "  win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'));\n  win.on('hide', () => r40SubtitleOverlay?.hide('owner-hidden'));",
  "  win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'));\n  // LILAC_R44_PREWARMED_SUBTITLE_OVERLAY: establish the empty transparent owned\n  // HWND before the first unfocused cue. If R40 captured an active cue during the\n  // renderer/BrowserWindow focus race, replay it only after prewarm is committed.\n  win.on('blur', () => {\n    try {\n      const task = r40SubtitleOverlay?.prewarm(win, 'owner-blur');\n      if (task && typeof task.then === 'function') {\n        void task.then(() => r40SubtitleOverlay?.reconcileDeferred(win, 'owner-blur')).catch(() => {});\n      }\n    } catch {}\n  });\n  win.on('hide', () => r40SubtitleOverlay?.hide('owner-hidden'));",
  'owner blur prewarm lifecycle'
);

const expectedVersion = process.env.R43_APP_VERSION || '0.5.54-libmpv-r3f.rc22';
const expectedTag = process.env.R43_RELEASE_TAG || 'libmpv-r2k-v0.5.54-r43';
const r44Version = process.env.R44_APP_VERSION || '0.5.54-libmpv-r3f.rc23';
const r44Tag = process.env.R44_RELEASE_TAG || 'libmpv-r2k-v0.5.54-r44';
if (pkg.version !== expectedVersion || pkg.lilacCustomTag !== expectedTag) {
  throw new Error(`R44 expected qualified R43 identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
if (!pkg.build || !pkg.build.win) throw new Error('R44 package build config missing');
pkg.version = r44Version;
pkg.lilacCustomTag = r44Tag;
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R44-Setup.${ext}';

fs.writeFileSync(controllerPath, controller, 'utf8');
fs.writeFileSync(mainPath, main, 'utf8');
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const finalController = fs.readFileSync(controllerPath, 'utf8');
const finalMain = fs.readFileSync(mainPath, 'utf8');
for (const required of [marker, 'prewarm-show-opacity-zero', 'active-first-show-opacity-zero', 'await this.ensurePromise', 'r44-payload-active-prewarmed-hwnd', 'transitionTrace: this.transitionTrace.slice()']) {
  if (!finalController.includes(required)) throw new Error(`R44 controller missing ${required}`);
}
if (!finalMain.includes(marker) || !finalMain.includes("prewarm(win, 'owner-blur')")) throw new Error('R44 main blur prewarm hook missing');
for (const text of [finalController, finalMain]) {
  for (const forbidden of ['copyTextureToTexture', 'focus-staged-gpu-copy', '--disable-direct-composition']) {
    if (text.includes(forbidden)) throw new Error(`R44 introduced forbidden path ${forbidden}`);
  }
}

console.log(`R44_OVERLAY_PREWARM_RACE_FIX_OK version=${r44Version} tag=${r44Tag} firstCue=prewarmed+opacity0-double-raf concurrentEnsure=serialized cueZOrder=stable hardHide=opacity0`);

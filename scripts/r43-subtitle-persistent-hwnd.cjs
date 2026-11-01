'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const controllerPath = path.join(root, 'electron', 'r40-subtitle-overlay-window.cjs');
const packagePath = path.join(root, 'package.json');
const marker = 'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND';

function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`R43 transform anchor missing: ${label}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`R43 transform anchor duplicated: ${label}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

let text = fs.readFileSync(controllerPath, 'utf8').replace(/\r\n/g, '\n');
if (text.includes(marker)) throw new Error('R43 transform already applied');
if (!text.includes('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY') || !text.includes('LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY')) {
  throw new Error('R43 requires the qualified R40/R41 subtitle overlay baseline');
}

text = replaceOnce(
  text,
  "    this.visible = false;\n    this.updates = 0;",
  "    this.visible = false; // HWND session visibility\n    this.contentActive = false; // subtitle DOM authority; HWND may remain transparent\n    this.updates = 0;\n    this.r43Marker = 'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND';",
  'constructor visibility state'
);

text = replaceOnce(
  text,
  "        this.visible = false;\n      }\n    });",
  "        this.visible = false;\n        this.contentActive = false;\n      }\n    });",
  'closed state'
);

text = replaceOnce(
  text,
  "      this.ready = false;\n      this.visible = false;\n    });\n    await win.loadFile",
  "      this.ready = false;\n      this.visible = false;\n      this.contentActive = false;\n    });\n    await win.loadFile",
  'renderer-gone state'
);

text = replaceOnce(
  text,
  "      if (this.visible) {\n        win.showInactive();\n        win.moveTop?.();\n      }",
  "      if (this.visible) {\n        // R43: an already-visible transparent owned HWND must not be re-shown for\n        // geometry/z-order sync. showInactive() is reserved for the first active\n        // cue of an unfocused owner session so DWM never re-animates cue changes.\n        if (!win.isVisible()) win.showInactive();\n        win.moveTop?.();\n      }",
  'sync showInactive'
);

const oldBlocked = `    let blockedReason = '';
    if (!safe.active) blockedReason = 'inactive-payload';
    else if (!state.parentPresent) blockedReason = 'parent-missing';
    else if (state.parentDestroyed) blockedReason = 'parent-destroyed';
    else if (state.parentMinimized) blockedReason = 'parent-minimized';
    else if (this.ownerLifecycleSuppressed) blockedReason = this.ownerLifecycleReason || 'owner-lifecycle-suppressed';
    if (blockedReason) {
      this.deferredActivePayload = null;
      this.pending = this._inactivePayload(safe);
      this.hide(blockedReason);
      return { ok: true, visible: false, ...this.snapshot() };
    }
`;
const newBlocked = `    // ${marker}
    // Structural owner/lifecycle blocks still hard-hide the overlay HWND. A plain
    // subtitle cue gap while the owner remains genuinely unfocused is different:
    // clear the DOM but keep the already-visible transparent owned HWND alive.
    // This removes the Windows/DWM show animation diagnosed by R42 without changing
    // focused direct-WebGPU, R33 native video, ownership, hit testing or z-order.
    let blockedReason = '';
    if (!state.parentPresent) blockedReason = 'parent-missing';
    else if (state.parentDestroyed) blockedReason = 'parent-destroyed';
    else if (state.parentMinimized) blockedReason = 'parent-minimized';
    else if (this.ownerLifecycleSuppressed) blockedReason = this.ownerLifecycleReason || 'owner-lifecycle-suppressed';
    if (blockedReason) {
      this.deferredActivePayload = null;
      this.pending = this._inactivePayload(safe);
      this.hide(blockedReason);
      return { ok: true, visible: false, ...this.snapshot() };
    }

    if (!safe.active) {
      this.deferredActivePayload = null;
      this.pending = this._inactivePayload(safe);
      const win = this.window;
      if (!state.parentFocused && win && !win.isDestroyed() && win.isVisible()) {
        try {
          if (this.ready && !win.webContents.isDestroyed()) {
            win.webContents.send('r40-subtitle-overlay:render', this.pending);
          }
        } catch {}
        this.visible = true;
        this.contentActive = false;
        this.sync(parent, 'r43-inactive-clear-keep-hwnd');
        this.lastReason = 'r43-inactive-payload-kept-hwnd';
        return { ok: true, visible: false, keptWindowVisible: true, ...this.snapshot() };
      }
      this.hide(state.parentFocused ? 'inactive-owner-focused' : 'inactive-payload');
      return { ok: true, visible: false, ...this.snapshot() };
    }
`;
text = replaceOnce(text, oldBlocked, newBlocked, 'inactive/structural block');

text = replaceOnce(
  text,
  "    if (!win.isVisible()) this.showCount += 1;\n    this.visible = true;\n    win.showInactive();\n    win.moveTop?.();\n    this.lastReason = 'payload-active';",
  "    const wasWindowVisible = win.isVisible();\n    if (!wasWindowVisible) this.showCount += 1;\n    this.visible = true;\n    this.contentActive = true;\n    if (!wasWindowVisible) win.showInactive();\n    win.moveTop?.();\n    this.lastReason = wasWindowVisible ? 'r43-payload-active-existing-hwnd' : 'payload-active';",
  'active show path'
);

text = replaceOnce(
  text,
  "    this.visible = false;\n    this.lastReason = reason;\n  }\n\n  destroy(reason = 'destroy')",
  "    this.visible = false;\n    this.contentActive = false;\n    this.lastReason = reason;\n  }\n\n  destroy(reason = 'destroy')",
  'hard hide content state'
);

text = replaceOnce(
  text,
  "      marker: 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',\n      active: this.visible,",
  "      marker: 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',\n      r43Marker: this.r43Marker,\n      active: this.contentActive,\n      hwndSessionVisible: this.visible,",
  'snapshot semantics'
);

fs.writeFileSync(controllerPath, text, 'utf8');

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const expectedR41Version = process.env.R41_APP_VERSION || '0.5.54-libmpv-r3f.rc21';
const expectedR41Tag = process.env.R41_RELEASE_TAG || 'libmpv-r2k-v0.5.54-r41';
const r43Version = process.env.R43_APP_VERSION || '0.5.54-libmpv-r3f.rc22';
const r43Tag = process.env.R43_RELEASE_TAG || 'libmpv-r2k-v0.5.54-r43';
if (pkg.version !== expectedR41Version || pkg.lilacCustomTag !== expectedR41Tag) {
  throw new Error(`R43 expected reconstructed R41 package identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
if (!pkg.build || !pkg.build.win) throw new Error('R43 package build config missing');
pkg.version = r43Version;
pkg.lilacCustomTag = r43Tag;
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R43-Setup.${ext}';
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const after = fs.readFileSync(controllerPath, 'utf8');
for (const need of [marker, 'r43-inactive-payload-kept-hwnd', "if (!wasWindowVisible) win.showInactive()", 'active: this.contentActive']) {
  if (!after.includes(need)) throw new Error(`R43 transformed controller missing ${need}`);
}
if (after.includes('--disable-direct-composition') || after.includes('focus-staged-gpu-copy') || after.includes('copyTextureToTexture')) {
  throw new Error('R43 introduced a forbidden presentation path');
}

console.log(`R43_SUBTITLE_PERSISTENT_HWND_TRANSFORM_OK version=${r43Version} tag=${r43Tag} cueGap=dom-clear+hwnd-kept-visible activeCue=no-reshow focused=hard-hide`);

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src', 'mpv-native-entry.js');
let entry = fs.readFileSync(entryPath, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D5';")) {
  throw new Error('V13D6 expects the V13D5 renderer transform first');
}

// Electron DOM geometry is expressed in CSS pixels, while the raw Win32 child
// HWND uses device pixels. On a 125% Windows display, passing 1536x864 directly
// created a 1536x864 physical child inside a 1920x1080 client, which exactly
// explains the 20% black strip on the right and the undersized video surface.
// Scale the complete HWND geometry and every region hole by devicePixelRatio.
const oldBounds = `  _hostBounds() {
    const stage = document.querySelector('#videoStage');
    const rect = (stage || this).getBoundingClientRect();
    const holes = [];
    const addHole = element => {
      if (!element) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const hole = element.getBoundingClientRect();
      const left = Math.max(rect.left, hole.left);
      const top = Math.max(rect.top, hole.top);
      const right = Math.min(rect.right, hole.right);
      const bottom = Math.min(rect.bottom, hole.bottom);
      if (right <= left || bottom <= top) return;
      holes.push({
        x: Math.max(0, Math.round(left - rect.left)),
        y: Math.max(0, Math.round(top - rect.top)),
        w: Math.max(1, Math.round(right - left)),
        h: Math.max(1, Math.round(bottom - top))
      });
    };
    addHole(document.querySelector('#immersivePlayer .player-top'));
    addHole(document.querySelector('#immersivePlayer .player-bottom'));
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width || innerWidth)),
      height: Math.max(1, Math.round(rect.height || innerHeight)),
      visible: this._playerVisible() && this._hostOpen,
      holes
    };
  }`;

const newBounds = `  _hostBounds() {
    const stage = document.querySelector('#videoStage');
    const rect = (stage || this).getBoundingClientRect();
    const scale = Math.max(0.5, Number(window.devicePixelRatio) || 1);
    const holes = [];
    const addHole = element => {
      if (!element) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const hole = element.getBoundingClientRect();
      const left = Math.max(rect.left, hole.left);
      const top = Math.max(rect.top, hole.top);
      const right = Math.min(rect.right, hole.right);
      const bottom = Math.min(rect.bottom, hole.bottom);
      if (right <= left || bottom <= top) return;
      holes.push({
        x: Math.max(0, Math.round((left - rect.left) * scale)),
        y: Math.max(0, Math.round((top - rect.top) * scale)),
        w: Math.max(1, Math.round((right - left) * scale)),
        h: Math.max(1, Math.round((bottom - top) * scale))
      });
    };
    addHole(document.querySelector('#immersivePlayer .player-top'));
    addHole(document.querySelector('#immersivePlayer .player-bottom'));
    addHole(document.querySelector('#playerSettings.open'));
    return {
      x: Math.round(rect.left * scale),
      y: Math.round(rect.top * scale),
      width: Math.max(1, Math.round((rect.width || innerWidth) * scale)),
      height: Math.max(1, Math.round((rect.height || innerHeight) * scale)),
      visible: this._playerVisible() && this._hostOpen,
      holes
    };
  }`;
entry = replaceOnce(entry, oldBounds, newBounds, 'V13D6 device-pixel HWND geometry and settings hole');

// V13D5 still hid the whole native video whenever the settings sheet opened.
// Keep the video alive and expose only the settings rectangle through the HWND
// region hole above, so the panel remains visible/clickable without a black frame.
entry = replaceOnce(
  entry,
  "  _playerVisible() {\n    const view = document.querySelector('#playerView');\n    const settings = document.querySelector('#playerSettings');\n    return Boolean(view?.classList.contains('active') && !settings?.classList.contains('open') && !this._diagModalActive && !document.querySelector('#lilacAutoDiagModal'));\n  }",
  "  _playerVisible() {\n    const view = document.querySelector('#playerView');\n    return Boolean(view?.classList.contains('active') && !this._diagModalActive && !document.querySelector('#lilacAutoDiagModal'));\n  }",
  'V13D6 keep native video visible behind settings sheet'
);

entry = entry.replaceAll('V13D5', 'V13D6');

fs.writeFileSync(entryPath, entry);

buildSync({
  entryPoints: [entryPath],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

for (const relative of ['src/mpv-native-entry.js', 'src/mpv-native.generated.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'inherit' });
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const marker of ['V13D6', 'devicePixelRatio', "#playerSettings.open", "!this._diagModalActive"]) {
    if (!text.includes(marker)) throw new Error(`V13D6 marker missing: ${relative} -> ${marker}`);
  }
}

const finalEntry = fs.readFileSync(entryPath, 'utf8');
if (finalEntry.includes("!settings?.classList.contains('open')")) {
  throw new Error('V13D6 whole-player settings hide path remains');
}
if (!finalEntry.includes("Math.round((rect.width || innerWidth) * scale)")) {
  throw new Error('V13D6 DPI-scaled HWND width missing');
}

console.log('V13D6 Windows DPI scaling and settings-region hole applied.');

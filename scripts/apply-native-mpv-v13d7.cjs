'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src', 'mpv-native-entry.js');
const bridgePath = path.join(root, 'electron', 'mpv-native-main.cjs');
let entry = fs.readFileSync(entryPath, 'utf8');
let bridge = fs.readFileSync(bridgePath, 'utf8');

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D6';")) {
  throw new Error('V13D7 expects the V13D6 renderer transform first');
}

// V13D5/V13D6 generated region holes in the renderer, but the main-process
// bridge still erased them before every host sync. With V13D6's full 1920x1080
// DPI-correct child HWND this removed every click-through area and covered the
// complete Electron UI. Preserve normalized holes all the way to the Win32
// helper so SetWindowRgn can actually expose the Lilac controls/settings.
const eraseLine = '    lastRelativeBounds.holes = [];\n';
const eraseCount = bridge.split(eraseLine).length - 1;
if (eraseCount !== 2) {
  throw new Error(`V13D7 expected exactly two forced hole resets, found ${eraseCount}`);
}
bridge = bridge.replaceAll(eraseLine, '');

// Add a safe diagnostic summary of the bounds that actually reached the main
// process. No URL, headers, tokens, paths, handles, or command lines are added.
const diagAnchor = "    overlayVisible: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),\n    disposed\n";
const diagReplacement = "    overlayVisible: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),\n    hostBounds: lastRelativeBounds ? {\n      x: lastRelativeBounds.x, y: lastRelativeBounds.y,\n      width: lastRelativeBounds.width, height: lastRelativeBounds.height,\n      visible: lastRelativeBounds.visible,\n      holeCount: Array.isArray(lastRelativeBounds.holes) ? lastRelativeBounds.holes.length : 0\n    } : null,\n    disposed\n";
const diagCount = bridge.split(diagAnchor).length - 1;
if (diagCount !== 1) throw new Error(`V13D7 diagnostics anchor expected once, found ${diagCount}`);
bridge = bridge.replace(diagAnchor, diagReplacement);

entry = entry.replaceAll('V13D6', 'V13D7');

fs.writeFileSync(entryPath, entry);
fs.writeFileSync(bridgePath, bridge);

buildSync({
  entryPoints: [entryPath],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

for (const relative of ['src/mpv-native-entry.js', 'src/mpv-native.generated.js', 'electron/mpv-native-main.cjs']) {
  execFileSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'inherit' });
}

const finalEntry = fs.readFileSync(entryPath, 'utf8');
const finalBridge = fs.readFileSync(bridgePath, 'utf8');
if (!finalEntry.includes("const LILAC_AUTODIAG_VERSION = 'V13D7';")) {
  throw new Error('V13D7 diagnostic version missing');
}
if (finalBridge.includes('lastRelativeBounds.holes = [];')) {
  throw new Error('V13D7 forced hole reset remains');
}
for (const marker of ['holeCount:', 'helperBoundsLine(lastRelativeBounds)', 'normalizeBounds(bounds)']) {
  if (!finalBridge.includes(marker)) throw new Error(`V13D7 bridge marker missing: ${marker}`);
}

console.log('V13D7 preserved Win32 input holes end-to-end and added safe applied-bounds diagnostics.');

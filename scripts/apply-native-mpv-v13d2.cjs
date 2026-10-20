'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'mpv-native-entry.js');
let source = fs.readFileSync(entry, 'utf8');

if (!source.includes('function ensureNativeDockLayout()')) {
  throw new Error('V13D2 expects the dock transform to run after apply-native-mpv-overlay.cjs');
}

const connectedNeedle = "  connectedCallback() {\n    ensureHostStyle();";
if (!source.includes(connectedNeedle)) {
  throw new Error('V13D2 connectedCallback anchor missing');
}
source = source.replace(
  connectedNeedle,
  "  connectedCallback() {\n    ensureNativeDockLayout();"
);

const rendererNeedle = "      bottomRect: rectSummary(document.querySelector('#immersivePlayer .player-bottom')),\n      playerActive: Boolean(document.querySelector('#playerView')?.classList.contains('active')),";
if (!source.includes(rendererNeedle)) {
  throw new Error('V13D2 renderer diagnostic anchor missing');
}
source = source.replace(
  rendererNeedle,
  "      bottomRect: rectSummary(document.querySelector('#immersivePlayer .player-bottom')),\n      dockStylePresent: Boolean(document.querySelector('#lilacNativeDockStyle')),\n      centerDocked: document.querySelector('#immersivePlayer .player-center')?.parentElement === document.querySelector('#immersivePlayer .player-bottom'),\n      nativeBounds: video?._hostBounds?.() || null,\n      playerActive: Boolean(document.querySelector('#playerView')?.classList.contains('active')),"
);

source = source.replaceAll('V13D1', 'V13D2');
source = source.replaceAll('V13 docked-hwnd-mpv', 'V13D2 docked-hwnd-mpv');

fs.writeFileSync(entry, source);

buildSync({
  entryPoints: [entry],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

const generated = fs.readFileSync(path.join(root, 'src', 'mpv-native.generated.js'), 'utf8');
for (const marker of ['V13D2', 'ensureNativeDockLayout', 'centerDocked', 'dockStylePresent']) {
  if (!generated.includes(marker)) throw new Error(`V13D2 marker missing: ${marker}`);
}
if (!source.includes("  connectedCallback() {\n    ensureNativeDockLayout();")) {
  throw new Error('V13D2 dock initializer was not installed');
}

console.log('V13D2 dock initialization fix applied and diagnostics extended.');

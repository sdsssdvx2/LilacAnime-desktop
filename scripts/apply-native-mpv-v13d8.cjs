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

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D7';")) {
  throw new Error('V13D8 expects the V13D7 renderer transform first');
}
if (bridge.includes('lastRelativeBounds.holes = [];')) {
  throw new Error('V13D8 expects V13D7 forced-hole-reset removal first');
}

// Renderer hole objects use {x,y,w,h}. The main-process normalizer historically
// only read {x,y,width,height}, silently normalizing every renderer hole to 0x0
// and filtering it out. Accept both schemas so the top/bottom/settings regions
// actually reach helperBoundsLine() and SetWindowRgn in the Win32 host helper.
const oldNormalizeHole = `  function normalizeHole(value, width, height) {
    const x = Math.max(0, Math.min(width, Math.round(Number(value?.x) || 0)));
    const y = Math.max(0, Math.min(height, Math.round(Number(value?.y) || 0)));
    const w = Math.max(0, Math.min(width - x, Math.round(Number(value?.width) || 0)));
    const h = Math.max(0, Math.min(height - y, Math.round(Number(value?.height) || 0)));
    return { x, y, width: w, height: h };
  }`;
const newNormalizeHole = `  function normalizeHole(value, width, height) {
    const x = Math.max(0, Math.min(width, Math.round(Number(value?.x) || 0)));
    const y = Math.max(0, Math.min(height, Math.round(Number(value?.y) || 0)));
    const rawWidth = Number(value?.width ?? value?.w);
    const rawHeight = Number(value?.height ?? value?.h);
    const w = Math.max(0, Math.min(width - x, Math.round(Number.isFinite(rawWidth) ? rawWidth : 0)));
    const h = Math.max(0, Math.min(height - y, Math.round(Number.isFinite(rawHeight) ? rawHeight : 0)));
    return { x, y, width: w, height: h };
  }`;
bridge = replaceOnce(bridge, oldNormalizeHole, newNormalizeHole, 'V13D8 dual hole schema normalizer');

// Expand the safe applied-bounds diagnostic so the next report proves not only
// holeCount but the sanitized geometry that made it through main-process
// normalization. These are only local UI coordinates/sizes.
const oldDiag = `    hostBounds: lastRelativeBounds ? {
      x: lastRelativeBounds.x, y: lastRelativeBounds.y,
      width: lastRelativeBounds.width, height: lastRelativeBounds.height,
      visible: lastRelativeBounds.visible,
      holeCount: Array.isArray(lastRelativeBounds.holes) ? lastRelativeBounds.holes.length : 0
    } : null,
`;
const newDiag = `    hostBounds: lastRelativeBounds ? {
      x: lastRelativeBounds.x, y: lastRelativeBounds.y,
      width: lastRelativeBounds.width, height: lastRelativeBounds.height,
      visible: lastRelativeBounds.visible,
      holeCount: Array.isArray(lastRelativeBounds.holes) ? lastRelativeBounds.holes.length : 0,
      holes: Array.isArray(lastRelativeBounds.holes) ? lastRelativeBounds.holes.map(hole => ({
        x: hole.x, y: hole.y, width: hole.width, height: hole.height
      })) : []
    } : null,
`;
bridge = replaceOnce(bridge, oldDiag, newDiag, 'V13D8 applied hole geometry diagnostics');

entry = entry.replaceAll('V13D7', 'V13D8');

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
if (!finalEntry.includes("const LILAC_AUTODIAG_VERSION = 'V13D8';")) {
  throw new Error('V13D8 diagnostic version missing');
}
for (const marker of ['value?.width ?? value?.w', 'value?.height ?? value?.h', 'holes: Array.isArray(lastRelativeBounds.holes)']) {
  if (!finalBridge.includes(marker)) throw new Error(`V13D8 bridge marker missing: ${marker}`);
}
if (finalBridge.includes('lastRelativeBounds.holes = [];')) {
  throw new Error('V13D8 forced hole reset regressed');
}

console.log('V13D8 accepts renderer w/h holes and reports normalized applied hole geometry.');

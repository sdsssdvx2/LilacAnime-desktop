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

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D8';")) {
  throw new Error('V13D9 expects the V13D8 renderer transform first');
}

// V13D8 proved that region holes now reach the Win32 helper correctly, but the
// holes were the complete 68px top dock and 132px bottom dock. That permanently
// removed video from two full-width bands. Keep the validated region mechanism,
// but punch holes only for the actual visible/control groups that need Chromium
// pixels and pointer input. The raw mpv HWND can then fill the rest of 1920x1080.
entry = replaceOnce(
  entry,
  `    const addHole = element => {
      if (!element) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const hole = element.getBoundingClientRect();`,
  `    const addHole = element => {
      if (!element) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity || '1') <= 0.01) return;
      const hole = element.getBoundingClientRect();`,
  'V13D9 visible-hole filter'
);

entry = replaceOnce(
  entry,
  `    addHole(document.querySelector('#immersivePlayer .player-top'));
    addHole(document.querySelector('#immersivePlayer .player-bottom'));
    addHole(document.querySelector('#playerSettings.open'));`,
  `    addHole(document.querySelector('#playerBack'));
    const heading = document.querySelector('#immersivePlayer .player-heading');
    Array.from(heading?.children || []).slice(0, 3).forEach(addHole);
    addHole(document.querySelector('#downloadStatus'));
    addHole(document.querySelector('#playerSettingsButton'));

    addHole(document.querySelector('#immersivePlayer .player-seek'));
    addHole(document.querySelector('#immersivePlayer .player-center'));
    const bottomRow = document.querySelector('#immersivePlayer .player-bottom-row');
    Array.from(bottomRow?.children || []).slice(0, 4).forEach(addHole);
    addHole(document.querySelector('#immersivePlayer .skip-chip:not(.hidden)'));

    addHole(document.querySelector('#playerSettings.open'));
    addHole(document.querySelector('#immersivePlayer .subtitle-sheet.open'));
    addHole(document.querySelector('#subtitleOffer:not(.hidden)'));
    addHole(document.querySelector('#unlockPlayer:not(.hidden)'));
    addHole(document.querySelector('#lilacAutoDiagReady'));`,
  'V13D9 compact UI holes'
);

entry = entry.replaceAll('V13D8', 'V13D9');

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
}

const finalEntry = fs.readFileSync(entryPath, 'utf8');
if (!finalEntry.includes("const LILAC_AUTODIAG_VERSION = 'V13D9';")) {
  throw new Error('V13D9 diagnostic version missing');
}
for (const marker of [
  "#playerBack", ".player-heading", ".player-seek", ".player-center",
  ".player-bottom-row", "#playerSettings.open", "#lilacAutoDiagReady",
  "Number.parseFloat(style.opacity || '1')"
]) {
  if (!finalEntry.includes(marker)) throw new Error(`V13D9 compact-hole marker missing: ${marker}`);
}
if (finalEntry.includes("addHole(document.querySelector('#immersivePlayer .player-top'))")) {
  throw new Error('V13D9 full-width top dock hole remains');
}
if (finalEntry.includes("addHole(document.querySelector('#immersivePlayer .player-bottom'))")) {
  throw new Error('V13D9 full-width bottom dock hole remains');
}

console.log('V13D9 compact visible-control Win32 holes applied.');

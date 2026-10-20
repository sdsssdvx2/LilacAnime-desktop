'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src', 'mpv-native-entry.js');
const appPath = path.join(root, 'src', 'app.js');
let entry = fs.readFileSync(entryPath, 'utf8');
let app = fs.readFileSync(appPath, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D3';")) {
  throw new Error('V13D4 expects the V13D3 renderer transform first');
}
if (!entry.includes("style.id = 'lilacNativeDockStyle';")) {
  throw new Error('V13D4 dock style anchor missing');
}

// V13D2 accidentally serialized the separator as two backslashes plus n inside
// the JavaScript string literal. At runtime that became a literal "\\n" in CSS,
// so the style element existed while most dock rules did not parse/apply.
const dockStart = entry.indexOf("style.id = 'lilacNativeDockStyle';");
const dockEnd = entry.indexOf('document.head.append(style);', dockStart);
if (dockStart < 0 || dockEnd < 0) throw new Error('V13D4 dock block bounds missing');
const dockBlock = entry.slice(dockStart, dockEnd);
const badSeparator = '\\\\nbody.player-mode';
const goodSeparator = '\\nbody.player-mode';
const separatorCount = dockBlock.split(badSeparator).length - 1;
if (separatorCount < 5) throw new Error(`V13D4 expected broken dock separators, found ${separatorCount}`);
const fixedDockBlock = dockBlock.replaceAll(badSeparator, goodSeparator);
entry = entry.slice(0, dockStart) + fixedDockBlock + entry.slice(dockEnd);

// The raw HWND cannot sit behind JASSUB/DOM subtitle canvases. Native builds use
// the already-generated VTT fallback and let mpv render it inside the HWND.
// This also keeps the UI from claiming that ASS effects are active when they are not.
app = replaceOnce(
  app,
  "function assEffectsEnabled(){return localStorage.getItem('assEffects')!=='false'}",
  "function assEffectsEnabled(){return !window.LilacNativeMpv?.enabled&&localStorage.getItem('assEffects')!=='false'}",
  'V13D4 native subtitle renderer gate'
);

// Make the acceptance report verify computed application, not just style-element
// presence / DOM reparenting.
entry = replaceOnce(
  entry,
  "      centerDocked: document.querySelector('#immersivePlayer .player-center')?.parentElement === document.querySelector('#immersivePlayer .player-bottom'),\n      nativeBounds: video?._hostBounds?.() || null,",
  "      centerDocked: document.querySelector('#immersivePlayer .player-center')?.parentElement === document.querySelector('#immersivePlayer .player-bottom'),\n      dockCssApplied: getComputedStyle(document.querySelector('#immersivePlayer .player-center')).position === 'static',\n      centerAligned: (() => { const rect = document.querySelector('#immersivePlayer .player-center')?.getBoundingClientRect(); return rect ? Math.abs((rect.left + rect.width / 2) - innerWidth / 2) <= 4 : false; })(),\n      nativeBounds: video?._hostBounds?.() || null,",
  'V13D4 dock acceptance diagnostics'
);

entry = entry.replaceAll('V13D3', 'V13D4');

fs.writeFileSync(entryPath, entry);
fs.writeFileSync(appPath, app);

buildSync({
  entryPoints: [entryPath],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

for (const relative of ['src/mpv-native-entry.js', 'src/mpv-native.generated.js', 'src/app.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'inherit' });
}

const finalEntry = fs.readFileSync(entryPath, 'utf8');
const finalApp = fs.readFileSync(appPath, 'utf8');
const finalDockStart = finalEntry.indexOf("style.id = 'lilacNativeDockStyle';");
const finalDockEnd = finalEntry.indexOf('document.head.append(style);', finalDockStart);
const finalDock = finalEntry.slice(finalDockStart, finalDockEnd);
if (finalDock.includes(badSeparator)) throw new Error('V13D4 broken dock separator remains');
for (const marker of ['V13D4', 'dockCssApplied', 'centerAligned']) {
  if (!finalEntry.includes(marker)) throw new Error(`V13D4 renderer marker missing: ${marker}`);
}
if (!finalApp.includes("return !window.LilacNativeMpv?.enabled&&localStorage.getItem('assEffects')!=='false'")) {
  throw new Error('V13D4 native subtitle gate missing');
}

console.log('V13D4 dock CSS parsing and native subtitle renderer fix applied.');

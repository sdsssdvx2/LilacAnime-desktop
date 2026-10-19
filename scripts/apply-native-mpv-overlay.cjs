'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const hostedPath = path.join(root, 'src', 'mpv-native-entry.js');
const preloadPath = path.join(root, 'electron', 'preload.cjs');
let hosted = fs.readFileSync(hostedPath, 'utf8');
let preload = fs.readFileSync(preloadPath, 'utf8');

if (!hosted.includes('LILAC_AUTODIAG_VERSION')) throw new Error('overlay transform expects autodiag source first');

hosted = hosted.replace(/  _hostBounds\(\) \{[\s\S]*?\n  \}\n\n  async _syncBounds\(\)/, `  _hostBounds() {
    const stage = document.querySelector('#videoStage');
    const rect = (stage || this).getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width || innerWidth)),
      height: Math.max(1, Math.round(rect.height || innerHeight)),
      visible: this._playerVisible() && this._hostOpen,
      holes: []
    };
  }

  async _syncBounds()`);

if (!hosted.includes("window.lilac?.nativeOverlaySubtitle")) {
  hosted = hosted.replace(
    '      this._lastState = state;\n',
    `      this._lastState = state;
      if (window.lilac?.nativeOverlaySubtitle) {
        const subtitleLines = [];
        for (const track of this._tracks) {
          if (track.mode !== 'showing') continue;
          for (const cue of track.activeCues || []) if (cue?.text) subtitleLines.push(String(cue.text));
        }
        window.lilac.nativeOverlaySubtitle({
          text: [...new Set(subtitleLines)].join('\\n'),
          style: {
            size: Number(localStorage.getItem('subtitleSize') || 100),
            position: Number(localStorage.getItem('subtitlePosition') || 12),
            outline: Number(localStorage.getItem('vttOutline') || 2),
            bold: localStorage.getItem('vttBold') !== 'false'
          }
        });
      }
`
  );
}

hosted = hosted.replace(
  'function showAutoDiagReport(report) {\n',
  `function showAutoDiagReport(report) {
  if (window.lilac?.nativeOverlayReport) {
    window.lilac.nativeOverlayReport(report);
    return;
  }
`
);
hosted = hosted.replaceAll('V11D1', 'V12O1');
hosted = hosted.replaceAll('V11 raw-hwnd-mpv', 'V12 overlay-hwnd-mpv');
hosted = hosted.replaceAll('V10 raw-win32-mpv', 'V12 overlay-hwnd-mpv');
hosted = hosted.replaceAll('V7 hosted-mpv', 'V12 overlay-hwnd-mpv');

if (!preload.includes('nativeOverlaySubtitle:')) {
  const anchor = "  nativeMpvDiagnostics: () => ipcRenderer.invoke('native-mpv:diagnostics'),";
  if (!preload.includes(anchor)) throw new Error('native mpv preload anchor missing');
  preload = preload.replace(anchor, `${anchor}\n  nativeOverlaySubtitle: payload => ipcRenderer.send('native-overlay:subtitle', payload),\n  nativeOverlayReport: report => ipcRenderer.send('native-overlay:report', report),`);
}

fs.writeFileSync(hostedPath, hosted);
fs.writeFileSync(preloadPath, preload);

const preloadEntry = path.join(root, 'electron', 'preload-native-entry.generated.cjs');
fs.writeFileSync(preloadEntry, "require('./preload.cjs');\n");
buildSync({
  entryPoints: [preloadEntry],
  outfile: path.join(root, 'electron', 'preload-native.generated.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});

buildSync({
  entryPoints: [hostedPath],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

for (const [file, marker] of [
  ['src/mpv-native-entry.js', 'holes: []'],
  ['src/mpv-native-entry.js', 'nativeOverlaySubtitle'],
  ['src/mpv-native-entry.js', 'nativeOverlayReport'],
  ['electron/preload-native.generated.cjs', 'nativeOverlaySubtitle'],
  ['electron/mpv-native-main.cjs', 'native-overlay:state'],
  ['electron/mpv-overlay.html', 'Lilac mpv overlay'],
  ['electron/mpv-overlay.js', 'window.mpvOverlay']
]) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (!text.includes(marker)) throw new Error(`overlay marker missing: ${file} -> ${marker}`);
}

console.log('V12O1 transparent overlay integration applied.');

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const hostedPath = path.join(root, 'src', 'mpv-native-entry.js');
const preloadPath = path.join(root, 'electron', 'preload.cjs');
const bridgePath = path.join(root, 'electron', 'mpv-native-main.cjs');
let hosted = fs.readFileSync(hostedPath, 'utf8');
let preload = fs.readFileSync(preloadPath, 'utf8');
let bridge = fs.readFileSync(bridgePath, 'utf8');

if (!hosted.includes('LILAC_AUTODIAG_VERSION')) throw new Error('docked transform expects autodiag source first');

// V12 proved that a full-screen transparent BrowserWindow becomes an opaque
// black composition surface above the raw mpv HWND on this Windows setup.
// Keep the validated raw HWND video path, but stop creating the full-screen
// overlay completely. Lilac controls live in fixed top/bottom docks outside
// the native video rectangle, while mpv itself renders subtitles.
bridge = bridge.replace(
  /  function overlaySend[\s\S]*?\n  function connectAndBatch/,
  `  function overlaySend() {}\n\n  function syncOverlayBounds() {}\n\n  function ensureOverlay() { return null; }\n\n  function connectAndBatch`
);

if (!bridge.includes('let subtitleTempPath = null;')) {
  bridge = bridge.replace('  let lastPid = null;\n', '  let lastPid = null;\n  let subtitleTempPath = null;\n');
}

if (!bridge.includes('async function applyNativeSubtitleText')) {
  const subtitleRuntime = String.raw`
  function cleanupNativeSubtitle() {
    const target = subtitleTempPath;
    subtitleTempPath = null;
    if (!target) return;
    try { fs.unlinkSync(target); } catch {}
  }

  async function applyNativeSubtitleText(text, style = {}) {
    const source = String(text || '');
    if (!child || child.exitCode != null || !pipeName) return { ok: false, error: 'mpv inactive' };
    if (!source.trim()) {
      await allowedCommand(['set_property', 'sid', 'no']).catch(() => null);
      cleanupNativeSubtitle();
      return { ok: true, hidden: true };
    }
    if (Buffer.byteLength(source, 'utf8') > 4 * 1024 * 1024) throw new Error('subtitle text too large');
    cleanupNativeSubtitle();
    const dir = path.join(app.getPath('temp'), 'LilacAnimeNativePrototype');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'subtitle-' + process.pid + '-' + Date.now() + '.vtt');
    fs.writeFileSync(target, source, 'utf8');
    subtitleTempPath = target;

    const size = Math.max(50, Math.min(300, Number(style?.size) || 100));
    const position = Math.max(3, Math.min(30, Number(style?.position) || 12));
    const outline = Math.max(0.5, Math.min(6, Number(style?.outline) || 2));
    const delaySeconds = (Number(style?.delayMs) || 0) / 1000;
    const commands = [
      ['sub-add', target, 'select'],
      ['set_property', 'sub-scale', size / 100],
      ['set_property', 'sub-pos', Math.max(55, Math.min(97, 100 - position))],
      ['set_property', 'sub-border-size', outline],
      ['set_property', 'sub-delay', delaySeconds]
    ];
    const replies = await connectAndBatch(commands, 1600);
    return {
      ok: replies[0]?.error === 'success',
      styleApplied: replies.slice(1).filter(reply => reply?.error === 'success').length
    };
  }
`;
  bridge = bridge.replace('  function attachWindow(win) {', subtitleRuntime + '\n  function attachWindow(win) {');
}

bridge = bridge.replace(
  '  async function closePlayer() {\n',
  '  async function closePlayer() {\n    cleanupNativeSubtitle();\n'
);

if (!bridge.includes("ipcMain.handle('native-mpv:subtitle-text'")) {
  bridge = bridge.replace(
    "  ipcMain.handle('native-mpv:command', async (_event, command) => allowedCommand(command));",
    "  ipcMain.handle('native-mpv:command', async (_event, command) => allowedCommand(command));\n  ipcMain.handle('native-mpv:subtitle-text', async (_event, text, style = {}) => applyNativeSubtitleText(text, style));"
  );
}
bridge = bridge.replace(
  "'native-mpv:prepare','native-mpv:open','native-mpv:state','native-mpv:bounds','native-mpv:command','native-mpv:close','native-mpv:diagnostics',",
  "'native-mpv:prepare','native-mpv:open','native-mpv:state','native-mpv:bounds','native-mpv:command','native-mpv:subtitle-text','native-mpv:close','native-mpv:diagnostics',"
);

// Dock the original Lilac controls outside the HWND instead of layering a
// transparent browser surface on top of it.
const dockRuntime = String.raw`
function ensureNativeDockLayout() {
  ensureHostStyle();
  if (!document.querySelector('#lilacNativeDockStyle')) {
    const style = document.createElement('style');
    style.id = 'lilacNativeDockStyle';
    style.textContent = `
      body.player-mode #immersivePlayer{display:block!important;background:#000!important}
      body.player-mode .player-shade{display:none!important}
      body.player-mode .player-top{top:0!important;left:0!important;right:0!important;height:68px!important;padding:10px 20px!important;background:#07070a!important;opacity:1!important;pointer-events:auto!important;transform:none!important;z-index:60!important}
      body.player-mode .player-bottom{left:0!important;right:0!important;bottom:0!important;height:132px!important;padding:8px 22px 10px!important;background:#07070a!important;opacity:1!important;pointer-events:auto!important;transform:none!important;z-index:60!important;display:flex!important;flex-direction:column!important;justify-content:center!important;gap:4px!important}
      body.player-mode .player-bottom>.player-center{position:static!important;left:auto!important;top:auto!important;bottom:auto!important;transform:none!important;margin:0 auto!important;opacity:1!important;pointer-events:auto!important;gap:18px!important;z-index:61!important}
      body.player-mode .player-bottom>.player-center .player-play{width:50px!important;height:50px!important}
      body.player-mode .player-bottom>.player-center .player-play svg{width:24px!important;height:24px!important}
      body.player-mode .player-bottom>.player-center .player-skip{width:42px!important;height:42px!important}
      body.player-mode .player-bottom>.player-center .player-skip svg{width:30px!important;height:30px!important}
      body.player-mode .player-bottom>.player-center .player-episode{width:42px!important;height:42px!important}
      body.player-mode .player-bottom-row{margin-top:0!important}
      body.player-mode #nativeMpvDiag{top:74px!important}
      body.player-mode .player-loading{top:68px!important;bottom:132px!important}
    `;
    document.head.append(style);
  }
  const bottom = document.querySelector('#immersivePlayer .player-bottom');
  const center = document.querySelector('#immersivePlayer .player-center');
  if (bottom && center && center.parentElement !== bottom) {
    bottom.insertBefore(center, bottom.querySelector('.player-bottom-row'));
  }
}
`;
if (!hosted.includes('function ensureNativeDockLayout')) {
  hosted = hosted.replace('function diag(text) {', dockRuntime + '\nfunction diag(text) {');
}
hosted = hosted.replace('    ensureHostStyle();\n    diag(', '    ensureNativeDockLayout();\n    diag(');

hosted = hosted.replace(/  _hostBounds\(\) \{[\s\S]*?\n  \}\n\n  async _syncBounds\(\)/, `  _hostBounds() {
    const stage = document.querySelector('#videoStage');
    const rect = (stage || this).getBoundingClientRect();
    const top = document.querySelector('#immersivePlayer .player-top')?.getBoundingClientRect();
    const bottom = document.querySelector('#immersivePlayer .player-bottom')?.getBoundingClientRect();
    const topEdge = Math.max(rect.top, Number(top?.bottom) || rect.top + 68);
    const bottomEdge = Math.min(rect.bottom, Number(bottom?.top) || rect.bottom - 132);
    return {
      x: Math.round(rect.left),
      y: Math.round(topEdge),
      width: Math.max(1, Math.round(rect.width || innerWidth)),
      height: Math.max(1, Math.round(bottomEdge - topEdge)),
      visible: this._playerVisible() && this._hostOpen,
      holes: []
    };
  }

  async _syncBounds()`);

// Push the currently selected VTT into mpv itself. This avoids the native HWND
// airspace problem entirely and makes subtitle style/sync settings effective.
hosted = hosted.replace(
  "  set mode(value) {\n    this._mode = ['disabled', 'hidden', 'showing'].includes(value) ? value : 'hidden';\n  }",
  "  set mode(value) {\n    this._mode = ['disabled', 'hidden', 'showing'].includes(value) ? value : 'hidden';\n    void this.owner?._syncNativeSubtitle?.();\n  }"
);
hosted = hosted.replace(
  '      const cues = parseVtt(await response.text());',
  '      const subtitleText = await response.text();\n      track._sourceText = subtitleText;\n      const cues = parseVtt(subtitleText);'
);
hosted = hosted.replace(
  "      if (this._hostOpen && element.src && !element.src.startsWith('blob:')) {\n        void this._command(['sub-add', element.src, 'select']);\n      }",
  "      if (track.mode === 'showing') void this._syncNativeSubtitle();"
);
hosted = hosted.replace(
  '  refreshSubtitleOverlay() {}',
  `  _nativeSubtitleStyle() {
    return {
      size: Number(localStorage.getItem('subtitleSize') || 100),
      position: Number(localStorage.getItem('subtitlePosition') || 12),
      outline: Number(localStorage.getItem('vttOutline') || 2),
      bold: localStorage.getItem('vttBold') !== 'false',
      delayMs: Number(localStorage.getItem('subtitleSync') || 0)
    };
  }

  async _syncNativeSubtitle() {
    if (!this._hostOpen || !window.lilac?.nativeMpvSubtitleText) return false;
    const selected = this._tracks.find(track => track.mode === 'showing' && track._sourceText);
    const result = await window.lilac.nativeMpvSubtitleText(selected?._sourceText || '', this._nativeSubtitleStyle()).catch(() => null);
    return Boolean(result?.ok);
  }

  refreshSubtitleOverlay() { void this._syncNativeSubtitle(); }`
);
hosted = hosted.replace(
  "      await this._command(['set_property', 'speed', this._playbackRate]);\n      diag(`host opened",
  "      await this._command(['set_property', 'speed', this._playbackRate]);\n      await this._syncNativeSubtitle();\n      diag(`host opened"
);
hosted = hosted.replace(
  '    if (at >= 0) this._tracks.splice(at, 1);\n  }',
  '    if (at >= 0) this._tracks.splice(at, 1);\n    void this._syncNativeSubtitle();\n  }'
);

// The automatic diagnostic dialog is normal Lilac DOM. Hide the raw HWND while
// the report is open so the report is guaranteed visible/clickable, then restore
// the player exactly where it was.
hosted = hosted.replace('function showAutoDiagReport(report) {', 'function showAutoDiagReport(report, onClose = null) {');
hosted = hosted.replace(
  '  close.onclick = () => modal.remove();',
  '  close.onclick = () => { modal.remove(); try { onClose?.(); } catch {} };'
);
hosted = hosted.replace(
  '  showAutoDiagReport(report);\n}',
  `  const restoreBounds = video?._hostBounds?.();
  const wasPaused = Boolean(video?.paused);
  if (restoreBounds && window.lilac?.nativeMpvBounds) await window.lilac.nativeMpvBounds({ ...restoreBounds, visible: false }).catch(() => {});
  if (!wasPaused) await window.lilac?.nativeMpvCommand?.(['set_property', 'pause', true]).catch(() => {});
  showAutoDiagReport(report, () => {
    void video?._syncBounds?.();
    if (!wasPaused) void window.lilac?.nativeMpvCommand?.(['set_property', 'pause', false]).catch(() => {});
  });
}`
);

hosted = hosted.replaceAll('V11D1', 'V13D1');
hosted = hosted.replaceAll('V12O1', 'V13D1');
hosted = hosted.replaceAll('V12 overlay-hwnd-mpv', 'V13 docked-hwnd-mpv');
hosted = hosted.replaceAll('V11 raw-hwnd-mpv', 'V13 docked-hwnd-mpv');
hosted = hosted.replaceAll('V10 raw-win32-mpv', 'V13 docked-hwnd-mpv');
hosted = hosted.replaceAll('V7 hosted-mpv', 'V13 docked-hwnd-mpv');

if (!preload.includes('nativeMpvSubtitleText:')) {
  const anchor = "  nativeMpvDiagnostics: () => ipcRenderer.invoke('native-mpv:diagnostics'),";
  if (!preload.includes(anchor)) throw new Error('native mpv preload anchor missing');
  preload = preload.replace(anchor, `${anchor}\n  nativeMpvSubtitleText: (text, style = {}) => ipcRenderer.invoke('native-mpv:subtitle-text', text, style),`);
}

fs.writeFileSync(hostedPath, hosted);
fs.writeFileSync(preloadPath, preload);
fs.writeFileSync(bridgePath, bridge);

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
  ['src/mpv-native-entry.js', 'ensureNativeDockLayout'],
  ['src/mpv-native-entry.js', '_syncNativeSubtitle'],
  ['src/mpv-native-entry.js', 'V13D1'],
  ['electron/preload-native.generated.cjs', 'nativeMpvSubtitleText'],
  ['electron/mpv-native-main.cjs', 'applyNativeSubtitleText'],
  ['electron/mpv-native-main.cjs', 'function ensureOverlay() { return null; }']
]) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (!text.includes(marker)) throw new Error(`docked marker missing: ${file} -> ${marker}`);
}

console.log('V13D1 docked raw-HWND integration applied: no transparent overlay, mpv subtitles enabled.');

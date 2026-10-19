'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function count(source, needle) {
  return source.split(needle).length - 1;
}

function replaceOnce(source, needle, replacement, label) {
  const found = count(source, needle);
  if (found !== 1) throw new Error(`${label}: expected exactly one anchor, found ${found}`);
  return source.replace(needle, replacement);
}

let main = read('electron/main.cjs');
let preload = read('electron/preload.cjs');
let updater = read('electron/updater.cjs');
let index = read('src/index.html');
let app = read('src/app.js');
let anime4k = read('src/anime4k.js');
let bridge = read('electron/mpv-native-main.cjs');
let hosted = read('src/mpv-native-entry.js');

if (main.includes('LILAC_NATIVE_MPV_SOURCE_PATCH')) throw new Error('native mpv source patch is already applied');

// V8: do not use a BrowserWindow as the mpv --wid target. Its Chromium surface
// paints over mpv's Win32 child window and leaves audio-only black playback.
// BaseWindow is a raw native window until a WebContentsView is attached, so mpv
// can own the whole client area without a competing Chromium compositor surface.
bridge = replaceOnce(
  bridge,
  "const { BrowserWindow } = require('electron');",
  "const { BaseWindow } = require('electron');",
  'V8 raw host import'
);

bridge = replaceOnce(
  bridge,
  `  function nativeHandleDecimal(win) {\n    const raw = win.getNativeWindowHandle();\n    if (raw.length >= 8 && process.arch === 'x64') return raw.readBigUInt64LE(0).toString();\n    return String(raw.readUInt32LE(0));\n  }`,
  `  function nativeHandleDecimal(win) {\n    const raw = win.getNativeWindowHandle();\n    // mpv's win32 --wid contract expects the HWND cast to uint32_t.\n    if (process.platform === 'win32') return String(raw.readUInt32LE(0));\n    if (raw.length >= 8 && process.arch === 'x64') return raw.readBigUInt64LE(0).toString();\n    return String(raw.readUInt32LE(0));\n  }`,
  'V8 uint32 HWND'
);

bridge = replaceOnce(
  bridge,
  '      hostWindow = new BrowserWindow({',
  '      hostWindow = new BaseWindow({',
  'V8 BaseWindow host'
);

bridge = replaceOnce(
  bridge,
  `        focusable: true,\n        webPreferences: {\n          sandbox: true,\n          contextIsolation: true,\n          nodeIntegration: false,\n          backgroundThrottling: false\n        }`,
  `        focusable: false`,
  'V8 remove Chromium host surface'
);

bridge = replaceOnce(
  bridge,
  `      hostWindow.setMenuBarVisibility(false);\n      void hostWindow.loadURL('data:text/html,<meta charset="utf-8"><body style="margin:0;background:#000;overflow:hidden"></body>').catch(() => {});\n`,
  '',
  'V8 remove BrowserWindow content'
);

bridge = replaceOnce(
  bridge,
  `      '--force-window=yes',\n      \`--wid=\${hwnd}\`,`,
  `      '--force-window=yes',\n      '--no-border',\n      \`--wid=\${hwnd}\`,`,
  'V8 borderless mpv child'
);

bridge = replaceOnce(
  bridge,
  `      '--osc=yes',\n      '--input-default-bindings=yes',`,
  `      '--osc=no',\n      '--input-default-bindings=no',`,
  'V8 Lilac-only controls'
);

bridge = replaceOnce(
  bridge,
  "    child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });",
  "    child = spawn(executable, args, { windowsHide: false, stdio: 'ignore' });",
  'V8 do not hide embedded GUI window'
);

// The native child window is always above Chromium. Keep all Lilac controls out
// of its rectangle rather than pretending DOM overlays can sit above it.
hosted = replaceOnce(
  hosted,
  `    body.player-mode .player-center {\n      top: auto !important;\n      bottom: 78px !important;\n      transform: translateX(-50%) !important;\n      z-index: 50 !important;\n    }`,
  `    body.player-mode .player-top,\n    body.player-mode .player-center,\n    body.player-mode .player-bottom {\n      z-index: 50 !important;\n    }\n    body.player-mode .player-center {\n      top: auto !important;\n      bottom: 118px !important;\n      transform: translateX(-50%) !important;\n    }`,
  'V8 intentional control dock'
);

hosted = hosted.replaceAll('V7 hosted-mpv', 'V8 hosted-mpv');

hosted = replaceOnce(
  hosted,
  `  _hostBounds() {\n    const rect = this.getBoundingClientRect();\n    const topInset = Math.min(72, Math.max(0, rect.height * 0.10));\n    const bottomInset = Math.min(150, Math.max(84, rect.height * 0.17));\n    return {\n      x: rect.left,\n      y: rect.top + topInset,\n      width: Math.max(1, rect.width),\n      height: Math.max(90, rect.height - topInset - bottomInset),\n      visible: this._playerVisible() && this._hostOpen\n    };\n  }`,
  `  _hostBounds() {\n    const rect = this.getBoundingClientRect();\n    const topBar = document.querySelector('#immersivePlayer .player-top')?.getBoundingClientRect();\n    const center = document.querySelector('#immersivePlayer .player-center')?.getBoundingClientRect();\n    const bottom = document.querySelector('#immersivePlayer .player-bottom')?.getBoundingClientRect();\n    const top = Math.max(rect.top, Number(topBar?.bottom) || rect.top) + 8;\n    const lowerEdges = [rect.bottom];\n    if (center && Number.isFinite(center.top) && center.top > top) lowerEdges.push(center.top - 10);\n    if (bottom && Number.isFinite(bottom.top) && bottom.top > top) lowerEdges.push(bottom.top - 10);\n    const bottomEdge = Math.max(top + 90, Math.min(...lowerEdges));\n    return {\n      x: Math.round(rect.left),\n      y: Math.round(top),\n      width: Math.max(1, Math.round(rect.width)),\n      height: Math.max(90, Math.round(bottomEdge - top)),\n      visible: this._playerVisible() && this._hostOpen\n    };\n  }`,
  'V8 DOM-measured video viewport'
);

main = replaceOnce(
  main,
  "const { createSubtitleSync } = require('./subtitle-sync.cjs');",
  "const { createSubtitleSync } = require('./subtitle-sync.cjs');\nconst { createNativeMpvBridge } = require('./mpv-native-main.cjs'); // LILAC_NATIVE_MPV_SOURCE_PATCH",
  'main native bridge import'
);

main = replaceOnce(
  main,
  'let playerStreamHeaders = null;',
  `let playerStreamHeaders = null;\nconst nativeMpv = createNativeMpvBridge({\n  app,\n  ipcMain,\n  userAgent: ANDROID_WEBVIEW_UA,\n  headersFor(parsed, supplied = {}) {\n    const resolved = parsed?.host ? (resolvedStreamHeaders.get(parsed.host) || {}) : {};\n    return { ...resolved, ...(playerStreamHeaders || {}), ...(supplied || {}) };\n  }\n});`,
  'main bridge initialization'
);

main = replaceOnce(
  main,
  "      preload: path.join(__dirname, 'preload.cjs'),",
  "      preload: path.join(__dirname, 'preload-native.generated.cjs'),\n      sandbox: false,",
  'main preload path and native sandbox setting'
);

main = replaceOnce(
  main,
  "app.setAppUserModelId('com.lilac.anime.desktop');",
  "app.setAppUserModelId('com.lilac.anime.desktop.nativeprototype');",
  'prototype AppUserModelId'
);

main = replaceOnce(
  main,
  '  if (!singleInstanceLock) return;',
  '  if (!singleInstanceLock) return;\n  await nativeMpv.ensure();',
  'main ready native init'
);

main = replaceOnce(
  main,
  "  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));",
  `  await nativeMpv.attachWindow(win);\n  win.webContents.once('render-process-gone', () => {\n    void nativeMpv.dispose().finally(() => app.quit());\n  });\n  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));`,
  'main attach native player window'
);

main = replaceOnce(main, 'function createWindow() {', 'async function createWindow() {', 'async createWindow');

main += `\n\n// LILAC_NATIVE_MPV_CLEANUP\napp.on('before-quit', () => { void nativeMpv.dispose(); });\napp.on('window-all-closed', () => {\n  const trayEnabled = Boolean(desktopState?.settings?.().trayEnabled);\n  if (process.platform !== 'darwin' && !trayEnabled) {\n    void nativeMpv.dispose().finally(() => app.quit());\n  }\n});\n`;

preload = replaceOnce(
  preload,
  "  mpvStatus: () => ipcRenderer.invoke('mpv:status'),",
  "  mpvStatus: () => ipcRenderer.invoke('mpv:status'),\n  nativeMpvPrepare: (url, headers = {}, hls = false) => ipcRenderer.invoke('native-mpv:prepare', url, headers, Boolean(hls)),\n  nativeMpvOpen: (url, headers = {}, hls = false, bounds = {}) => ipcRenderer.invoke('native-mpv:open', url, headers, Boolean(hls), bounds),\n  nativeMpvState: () => ipcRenderer.invoke('native-mpv:state'),\n  nativeMpvBounds: bounds => ipcRenderer.invoke('native-mpv:bounds', bounds),\n  nativeMpvCommand: command => ipcRenderer.invoke('native-mpv:command', command),\n  nativeMpvClose: () => ipcRenderer.invoke('native-mpv:close'),\n  nativeMpvDiagnostics: () => ipcRenderer.invoke('native-mpv:diagnostics'),",
  'preload native APIs'
);

updater = replaceOnce(
  updater,
  "const RELEASES = 'https://api.github.com/repos/whispelyn-byte/LilacAnime-desktop/releases';",
  "const RELEASES = 'https://api.github.com/repos/sdsssdvx2/LilacAnime-desktop/releases';",
  'prototype updater release channel'
);

index = replaceOnce(
  index,
  '<div id="videoStage" class="video-stage"><video id="video" crossorigin="anonymous" playsinline preload="auto"></video></div>',
  '<div id="videoStage" class="video-stage"><lilac-mpv-video id="video" aria-label="hosted mpv video"></lilac-mpv-video></div>',
  'player video element'
);

index = replaceOnce(
  index,
  '  <script src="app.js"></script>',
  '  <script src="mpv-native.generated.js"></script>\n  <script src="app.js"></script>',
  'native renderer script order'
);

app = replaceOnce(
  app,
  '  if(isHls&&window.Hls?.isSupported()){',
  `  if(window.LilacNativeMpv?.enabled){\n    $('#downloadStatus').textContent='mpv 호스트를 준비하는 중...';\n    video.openLilacSource(src,{headers:context.streamHeaders||{},hls:isHls}).then(()=>{\n      if(video.currentSrc===src||video.src===src)$('#downloadStatus').textContent='mpv 호스트에서 재생 중';\n    }).catch(error=>{\n      const raw=error?.message||String(error);\n      const message=String(raw).replace(/https?:\\/\\/[^\\s]+/gi,'[media-url]').replace(/127\\.0\\.0\\.1:\\d+\\/[^\\s]*/gi,'[local-media]');\n      $('#downloadStatus').textContent=\`mpv 호스트 오류: \${message}\`;\n      toast(\`mpv 호스트 재생 오류: \${message}\`);\n    });\n  }else if(isHls&&window.Hls?.isSupported()){`,
  'native playback branch'
);

app = replaceOnce(
  app,
  'video.playbackRate=Number($(\'#speed\').value);if(!isHls)video.play().catch(()=>{});loadJimakuList();',
  'video.playbackRate=Number($(\'#speed\').value);if(window.LilacNativeMpv?.enabled||!isHls)video.play().catch(error=>{if(window.LilacNativeMpv?.enabled){const message=String(error?.message||error).replace(/https?:\\/\\/[^\\s]+/gi,\'[media-url]\');$(\'#downloadStatus\').textContent=`mpv 호스트 재생 시작 오류: ${message}`}});loadJimakuList();',
  'native play start'
);

app = replaceOnce(
  app,
  'progress:savedProgress,updated:Date.now()',
  'progress:savedProgress,positionSeconds:Number(context.resumeSeconds??previous?.positionSeconds??0)||0,durationSeconds:Number(previous?.durationSeconds||0)||0,updated:Date.now()',
  'exact history fields'
);

app = replaceOnce(
  app,
  'resumeProgress:item.progress,comparisonEpisodes',
  'resumeProgress:item.progress,resumeSeconds:Number(item.progress)>0&&Number(item.progress)<95?(Number(item.positionSeconds)||null):null,comparisonEpisodes',
  'exact history resume'
);

app = replaceOnce(
  app,
  'item.progress=Math.max(0,Math.min(100,Math.round(v.currentTime/duration*100)));item.updated=Date.now();',
  'item.progress=Math.max(0,Math.min(100,Math.round(v.currentTime/duration*100)));item.positionSeconds=Math.max(0,Number(v.currentTime)||0);item.durationSeconds=Math.max(0,Number(duration)||0);item.updated=Date.now();',
  'exact timeupdate history'
);

anime4k = replaceOnce(
  anime4k,
  "  const mode = () => Object.hasOwn(modes, localStorage.getItem('playerAnime4k')) ? localStorage.getItem('playerAnime4k') : 'off';",
  "  const mode = () => document.querySelector('lilac-mpv-video') ? 'off' : (Object.hasOwn(modes, localStorage.getItem('playerAnime4k')) ? localStorage.getItem('playerAnime4k') : 'off');",
  'disable Chromium Anime4K path for hosted mpv'
);

write('electron/mpv-native-main.cjs', bridge);
write('src/mpv-native-entry.js', hosted);
write('electron/main.cjs', main);
write('electron/preload.cjs', preload);
write('electron/updater.cjs', updater);
write('src/index.html', index);
write('src/app.js', app);
write('src/anime4k.js', anime4k);

const preloadEntry = file('electron/preload-native-entry.generated.cjs');
fs.writeFileSync(preloadEntry, "require('./preload.cjs');\n");

buildSync({
  entryPoints: [preloadEntry],
  outfile: file('electron/preload-native.generated.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});

buildSync({
  entryPoints: [file('src/mpv-native-entry.js')],
  outfile: file('src/mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

for (const relative of ['electron/main.cjs','electron/mpv-native-main.cjs','electron/preload-native.generated.cjs','electron/updater.cjs','src/app.js','src/anime4k.js']) {
  execFileSync(process.execPath, ['--check', file(relative)], { stdio: 'inherit' });
}

const required = [
  ['electron/main.cjs', 'LILAC_NATIVE_MPV_SOURCE_PATCH'],
  ['electron/main.cjs', 'LILAC_NATIVE_MPV_CLEANUP'],
  ['electron/main.cjs', 'await nativeMpv.ensure()'],
  ['electron/main.cjs', 'await nativeMpv.attachWindow(win)'],
  ['electron/main.cjs', 'render-process-gone'],
  ['electron/main.cjs', 'sandbox: false'],
  ['electron/main.cjs', 'com.lilac.anime.desktop.nativeprototype'],
  ['electron/mpv-native-main.cjs', "const { BaseWindow } = require('electron');"],
  ['electron/mpv-native-main.cjs', "if (process.platform === 'win32') return String(raw.readUInt32LE(0));"],
  ['electron/preload.cjs', 'nativeMpvOpen'],
  ['electron/preload.cjs', 'nativeMpvState'],
  ['electron/preload.cjs', 'nativeMpvBounds'],
  ['electron/preload.cjs', 'nativeMpvCommand'],
  ['electron/preload.cjs', 'nativeMpvClose'],
  ['electron/updater.cjs', 'sdsssdvx2/LilacAnime-desktop/releases'],
  ['src/index.html', '<lilac-mpv-video id="video"'],
  ['src/app.js', 'video.openLilacSource'],
  ['src/app.js', 'mpv 호스트를 준비하는 중'],
  ['src/app.js', 'positionSeconds'],
  ['src/mpv-native-entry.js', 'V8 hosted-mpv'],
  ['src/mpv-native.generated.js', 'hosted-mpv']
];
for (const [relative, marker] of required) {
  if (!read(relative).includes(marker)) throw new Error(`post-patch marker missing: ${relative} :: ${marker}`);
}

console.log('Hosted mpv V8 BaseWindow patch applied and generated bundles validated.');

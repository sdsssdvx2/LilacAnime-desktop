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
let hosted = read('src/mpv-native-entry.js');
const bridge = read('electron/mpv-native-main.cjs');

if (main.includes('LILAC_NATIVE_MPV_SOURCE_PATCH')) throw new Error('native mpv source patch is already applied');
if (!bridge.includes('win32-mpv-host.exe')) throw new Error('V10 Win32 host bridge is missing');

// Keep Lilac's original player layout instead of moving the center controls into
// a separate dock. The Win32 host helper clips holes in the native mpv window so
// the existing DOM controls remain visible and clickable in their normal places.
hosted = replaceOnce(
  hosted,
  `    body.player-mode .player-center {\n      top: auto !important;\n      bottom: 78px !important;\n      transform: translateX(-50%) !important;\n      z-index: 50 !important;\n    }`,
  `    body.player-mode .player-top,\n    body.player-mode .player-center,\n    body.player-mode .player-bottom {\n      opacity: 1 !important;\n      pointer-events: auto !important;\n      z-index: 50 !important;\n    }`,
  'V10 preserve original control layout'
);

hosted = hosted.replaceAll('V7 hosted-mpv', 'V10 raw-win32-mpv');

hosted = replaceOnce(
  hosted,
  `  _hostBounds() {\n    const rect = this.getBoundingClientRect();\n    const topInset = Math.min(72, Math.max(0, rect.height * 0.10));\n    const bottomInset = Math.min(150, Math.max(84, rect.height * 0.17));\n    return {\n      x: rect.left,\n      y: rect.top + topInset,\n      width: Math.max(1, rect.width),\n      height: Math.max(90, rect.height - topInset - bottomInset),\n      visible: this._playerVisible() && this._hostOpen\n    };\n  }`,
  `  _hostBounds() {\n    const rect = this.getBoundingClientRect();\n    const holes = [];\n    const addHole = (selector, padX = 8, padY = 6) => {\n      const element = document.querySelector(selector);\n      if (!element) return;\n      const style = getComputedStyle(element);\n      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;\n      const item = element.getBoundingClientRect();\n      const left = Math.max(rect.left, item.left - padX);\n      const top = Math.max(rect.top, item.top - padY);\n      const right = Math.min(rect.right, item.right + padX);\n      const bottom = Math.min(rect.bottom, item.bottom + padY);\n      if (right <= left || bottom <= top) return;\n      holes.push({\n        x: Math.round(left - rect.left),\n        y: Math.round(top - rect.top),\n        width: Math.round(right - left),\n        height: Math.round(bottom - top)\n      });\n    };\n    addHole('#immersivePlayer .player-top', 4, 4);\n    addHole('#immersivePlayer .player-center', 10, 10);\n    addHole('#immersivePlayer .player-bottom', 4, 4);\n    addHole('#skipNow:not(.hidden)', 8, 8);\n    return {\n      x: Math.round(rect.left),\n      y: Math.round(rect.top),\n      width: Math.max(1, Math.round(rect.width)),\n      height: Math.max(1, Math.round(rect.height)),\n      visible: this._playerVisible() && this._hostOpen,\n      holes\n    };\n  }`,
  'V10 full viewport with DOM control holes'
);

hosted = replaceOnce(
  hosted,
  `      diag(\`active=\${state.active} pid=\${state.pid || '-'} route=\${state.route || '-'} t=\${t}/\${d} size=\${this._width || 0}x\${this._height || 0} codec=\${state.codec || '-'} fps=\${Number(state.fps || 0).toFixed(2)} vid=\${state.vid ?? '-'} aid=\${state.aid ?? '-'} paused=\${String(state.paused)}\`);`,
  `      diag(\`active=\${state.active} pid=\${state.pid || '-'} host=\${state.hostMode || '-'} route=\${state.route || '-'} t=\${t}/\${d} size=\${this._width || 0}x\${this._height || 0} codec=\${state.codec || '-'} fps=\${Number(state.fps || 0).toFixed(2)} vid=\${state.vid ?? '-'} aid=\${state.aid ?? '-'} paused=\${String(state.paused)}\`);`,
  'V10 host mode diagnostic'
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
  '<div id="videoStage" class="video-stage"><lilac-mpv-video id="video" aria-label="raw Win32 hosted mpv video"></lilac-mpv-video></div>',
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
  ['electron/mpv-native-main.cjs', 'win32-mpv-host.exe'],
  ['electron/mpv-native-main.cjs', 'startHostHelper'],
  ['electron/mpv-native-main.cjs', '--force-window=immediate'],
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
  ['src/mpv-native-entry.js', 'V10 raw-win32-mpv'],
  ['src/mpv-native-entry.js', 'holes'],
  ['src/mpv-native.generated.js', 'raw-win32-mpv']
];
for (const [relative, marker] of required) {
  if (!read(relative).includes(marker)) throw new Error(`post-patch marker missing: ${relative} :: ${marker}`);
}

if (!fs.existsSync(file('electron/win32-mpv-host.exe'))) throw new Error('compiled Win32 host helper missing');

console.log('V10 raw Win32 mpv reparent patch applied and generated bundles validated.');

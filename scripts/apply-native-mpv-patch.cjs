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

if (main.includes('LILAC_NATIVE_MPV_SOURCE_PATCH')) throw new Error('native mpv source patch is already applied');

main = replaceOnce(
  main,
  "const { createSubtitleSync } = require('./subtitle-sync.cjs');",
  "const { createSubtitleSync } = require('./subtitle-sync.cjs');\nconst { createNativeMpvBridge } = require('./mpv-native-main.cjs'); // LILAC_NATIVE_MPV_SOURCE_PATCH",
  'main native bridge import'
);

main = replaceOnce(
  main,
  'let playerStreamHeaders = null;',
  `let playerStreamHeaders = null;\n// Match the already verified Windows mpv path without copying full RGBA frames through JS.\nprocess.env.MPV_HWDEC = process.env.MPV_HWDEC || 'd3d11va-copy';\nconst nativeMpv = createNativeMpvBridge({\n  app,\n  ipcMain,\n  userAgent: ANDROID_WEBVIEW_UA,\n  headersFor(parsed, supplied = {}) {\n    const resolved = parsed?.host ? (resolvedStreamHeaders.get(parsed.host) || {}) : {};\n    return { ...resolved, ...(playerStreamHeaders || {}), ...(supplied || {}) };\n  }\n});`,
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

// Prototype lifecycle: a renderer crash must not leave libmpv/relay processes and
// native allocations resident. Normal tray-hide does not close the BrowserWindow,
// so this only runs when the window is actually gone or the app is quitting.
main += `\n\n// LILAC_NATIVE_MPV_CLEANUP\napp.on('before-quit', () => { void nativeMpv.dispose(); });\napp.on('window-all-closed', () => {\n  const trayEnabled = Boolean(desktopState?.settings?.().trayEnabled);\n  if (process.platform !== 'darwin' && !trayEnabled) {\n    void nativeMpv.dispose().finally(() => app.quit());\n  }\n});\n`;

preload = replaceOnce(
  preload,
  "  mpvStatus: () => ipcRenderer.invoke('mpv:status'),",
  "  mpvStatus: () => ipcRenderer.invoke('mpv:status'),\n  nativeMpvPrepare: (url, headers = {}, hls = false) => ipcRenderer.invoke('native-mpv:prepare', url, headers, Boolean(hls)),\n  nativeMpvDiagnostics: () => ipcRenderer.invoke('native-mpv:diagnostics'),",
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
  '<div id="videoStage" class="video-stage"><lilac-mpv-video id="video" aria-label="native mpv video"></lilac-mpv-video></div>',
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
  `  if(window.LilacNativeMpv?.enabled){\n    $('#downloadStatus').textContent='native mpv 스트림을 준비하는 중...';\n    video.openLilacSource(src,{headers:context.streamHeaders||{},hls:isHls}).then(()=>{\n      if(video.currentSrc===src||video.src===src)$('#downloadStatus').textContent='native mpv 영상 데이터를 여는 중...';\n    }).catch(error=>{\n      const raw=error?.message||String(error);\n      const message=String(raw).replace(/https?:\\/\\/[^\\s]+/gi,'[media-url]').replace(/127\\.0\\.0\\.1:\\d+\\/r\\/[a-f0-9]+/gi,'[local-relay]');\n      $('#downloadStatus').textContent=\`native mpv 오류: \${message}\`;\n      toast(\`native mpv 재생 오류: \${message}\`);\n    });\n  }else if(isHls&&window.Hls?.isSupported()){`,
  'native playback branch'
);

app = replaceOnce(
  app,
  'video.playbackRate=Number($(\'#speed\').value);if(!isHls)video.play().catch(()=>{});loadJimakuList();',
  'video.playbackRate=Number($(\'#speed\').value);if(window.LilacNativeMpv?.enabled||!isHls)video.play().catch(error=>{if(window.LilacNativeMpv?.enabled){const message=String(error?.message||error).replace(/https?:\\/\\/[^\\s]+/gi,\'[media-url]\');$(\'#downloadStatus\').textContent=`native mpv 재생 시작 오류: ${message}`}});loadJimakuList();',
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
  'disable Chromium Anime4K path for native mpv'
);

write('electron/main.cjs', main);
write('electron/preload.cjs', preload);
write('electron/updater.cjs', updater);
write('src/index.html', index);
write('src/app.js', app);
write('src/anime4k.js', anime4k);

const preloadEntry = file('electron/preload-native-entry.generated.cjs');
fs.writeFileSync(preloadEntry, "require('./preload.cjs');\nrequire('electron-mpv-video/preload').exposeMpvApi();\n");

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

for (const relative of ['electron/main.cjs','electron/preload-native.generated.cjs','electron/updater.cjs','src/app.js','src/anime4k.js']) {
  execFileSync(process.execPath, ['--check', file(relative)], { stdio: 'inherit' });
}

const required = [
  ['electron/main.cjs', 'LILAC_NATIVE_MPV_SOURCE_PATCH'],
  ['electron/main.cjs', 'LILAC_NATIVE_MPV_CLEANUP'],
  ['electron/main.cjs', "MPV_HWDEC = process.env.MPV_HWDEC || 'd3d11va-copy'"],
  ['electron/main.cjs', 'await nativeMpv.ensure()'],
  ['electron/main.cjs', 'await nativeMpv.attachWindow(win)'],
  ['electron/main.cjs', 'render-process-gone'],
  ['electron/main.cjs', 'sandbox: false'],
  ['electron/main.cjs', 'com.lilac.anime.desktop.nativeprototype'],
  ['electron/preload.cjs', 'nativeMpvPrepare'],
  ['electron/preload.cjs', 'nativeMpvDiagnostics'],
  ['electron/updater.cjs', 'sdsssdvx2/LilacAnime-desktop/releases'],
  ['src/index.html', '<lilac-mpv-video id="video"'],
  ['src/app.js', 'video.openLilacSource'],
  ['src/app.js', 'native mpv 스트림을 준비하는 중'],
  ['src/app.js', 'positionSeconds'],
  ['src/mpv-native.generated.js', 'LilacNativeMpv']
];
for (const [relative, marker] of required) {
  if (!read(relative).includes(marker)) throw new Error(`post-patch marker missing: ${relative} :: ${marker}`);
}

console.log('Native mpv source patch applied and generated bundles validated.');

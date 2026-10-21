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
let index = read('src/index.html');
let app = read('src/app.js');
let anime4k = read('src/anime4k.js');
const packageJson = JSON.parse(read('package.json'));

if (main.includes('LILAC_LIBMPV_SHARED_SOURCE_PATCH')) throw new Error('libmpv shared-texture transform already applied');
if (!fs.existsSync(file('electron/libmpv-shared-main.cjs'))) throw new Error('main shared-texture bridge source missing');
if (!fs.existsSync(file('electron/libmpv-shared-preload.cjs'))) throw new Error('preload shared-texture receiver source missing');
if (!fs.existsSync(file('src/libmpv-shared-entry.js'))) throw new Error('renderer shared-texture entry source missing');

main = replaceOnce(
  main,
  "const { createSubtitleSync } = require('./subtitle-sync.cjs');",
  "const { createSubtitleSync } = require('./subtitle-sync.cjs');\nconst { createLibmpvSharedBridge } = require('./libmpv-shared-main.cjs'); // LILAC_LIBMPV_SHARED_SOURCE_PATCH",
  'main shared bridge import'
);

main = replaceOnce(
  main,
  'let playerStreamHeaders = null;',
  `let playerStreamHeaders = null;\nconst libmpvShared = createLibmpvSharedBridge({\n  app,\n  ipcMain,\n  userAgent: ANDROID_WEBVIEW_UA,\n  headersFor(parsed, supplied = {}) {\n    const resolved = parsed?.host ? (resolvedStreamHeaders.get(parsed.host) || {}) : {};\n    return { ...resolved, ...(playerStreamHeaders || {}), ...(supplied || {}) };\n  }\n});`,
  'main shared bridge initialization'
);

main = replaceOnce(
  main,
  "      preload: path.join(__dirname, 'preload.cjs'),",
  "      preload: path.join(__dirname, 'preload-libmpv-shared.generated.cjs'),",
  'main generated preload'
);

main = replaceOnce(
  main,
  "app.setAppUserModelId('com.lilac.anime.desktop');",
  "app.setAppUserModelId('com.lilac.anime.desktop.libmpvsharedprototype');",
  'prototype AppUserModelId'
);

main = replaceOnce(
  main,
  '  if (!singleInstanceLock) return;',
  '  if (!singleInstanceLock) return;\n  await libmpvShared.ensure();',
  'main ready bridge init'
);

main = replaceOnce(main, 'function createWindow() {', 'async function createWindow() {', 'async createWindow');

main = replaceOnce(
  main,
  "  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));",
  `  await libmpvShared.attachWindow(win);\n  win.webContents.once('render-process-gone', () => {\n    void libmpvShared.dispose().finally(() => app.quit());\n  });\n  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));`,
  'main attach shared player window'
);

main += `\n\n// LILAC_LIBMPV_SHARED_CLEANUP\napp.on('before-quit', () => { void libmpvShared.dispose(); });\n`;

preload = replaceOnce(
  preload,
  "  mpvStatus: () => ipcRenderer.invoke('mpv:status'),",
  "  mpvStatus: () => ipcRenderer.invoke('mpv:status'),\n  libmpvSharedOpen: (url, headers = {}, hls = false, size = {}) => ipcRenderer.invoke('libmpv-shared:open', url, headers, Boolean(hls), size),\n  libmpvSharedCommand: command => ipcRenderer.invoke('libmpv-shared:command', command),\n  libmpvSharedState: () => ipcRenderer.invoke('libmpv-shared:state'),\n  libmpvSharedResize: size => ipcRenderer.invoke('libmpv-shared:resize', size),\n  libmpvSharedClose: () => ipcRenderer.invoke('libmpv-shared:close'),\n  libmpvSharedDiagnostics: () => ipcRenderer.invoke('libmpv-shared:diagnostics'),",
  'preload shared player APIs'
);

index = replaceOnce(
  index,
  '<div id="videoStage" class="video-stage"><video id="video" crossorigin="anonymous" playsinline preload="auto"></video></div>',
  '<div id="videoStage" class="video-stage"><lilac-mpv-video id="video" aria-label="libmpv D3D11 shared-texture video"></lilac-mpv-video></div>',
  'player video element'
);

index = replaceOnce(
  index,
  '  <script src="app.js"></script>',
  '  <script src="libmpv-shared.generated.js"></script>\n  <script src="app.js"></script>',
  'shared renderer script order'
);

app = replaceOnce(
  app,
  '  if(isHls&&window.Hls?.isSupported()){',
  `  if(window.LilacNativeMpv?.enabled){\n    $('#downloadStatus').textContent='libmpv GPU 재생을 준비하는 중...';\n    video.openLilacSource(src,{headers:context.streamHeaders||{},hls:isHls}).then(()=>{\n      if(video.currentSrc===src||video.src===src)$('#downloadStatus').textContent='libmpv GPU 재생 중';\n    }).catch(error=>{\n      const raw=error?.message||String(error);\n      const message=String(raw).replace(/https?:\\/\\/[^\\s]+/gi,'[media-url]').replace(/127\\.0\\.0\\.1:\\d+\\/[^\\s]*/gi,'[local-media]');\n      $('#downloadStatus').textContent=\`libmpv GPU 오류: \${message}\`;\n      toast(\`libmpv GPU 재생 오류: \${message}\`);\n    });\n  }else if(isHls&&window.Hls?.isSupported()){`,
  'shared playback branch'
);

app = replaceOnce(
  app,
  "video.playbackRate=Number($('#speed').value);if(!isHls)video.play().catch(()=>{});loadJimakuList();",
  "video.playbackRate=Number($('#speed').value);if(window.LilacNativeMpv?.enabled||!isHls)video.play().catch(error=>{if(window.LilacNativeMpv?.enabled){const message=String(error?.message||error).replace(/https?:\\/\\/[^\\s]+/gi,'[media-url]');$('#downloadStatus').textContent=`libmpv GPU 재생 시작 오류: ${message}`}});loadJimakuList();",
  'shared play start'
);

anime4k = replaceOnce(
  anime4k,
  "  const mode = () => Object.hasOwn(modes, localStorage.getItem('playerAnime4k')) ? localStorage.getItem('playerAnime4k') : 'off';",
  "  const mode = () => document.querySelector('lilac-mpv-video') ? 'off' : (Object.hasOwn(modes, localStorage.getItem('playerAnime4k')) ? localStorage.getItem('playerAnime4k') : 'off');",
  'disable Chromium Anime4K for libmpv element'
);

packageJson.version = '0.5.37-libmpvshared.1';
packageJson.devDependencies ||= {};
packageJson.devDependencies.electron = '43.8.1';
packageJson.build ||= {};
packageJson.build.appId = 'com.lilac.anime.desktop.libmpvsharedprototype';
packageJson.build.productName = 'LilacAnime Libmpv Shared Prototype';
packageJson.build.asarUnpack = Array.from(new Set([
  ...(packageJson.build.asarUnpack || []),
  'electron/lilac-libmpv-player-bridge.node',
  'electron/libmpv-2.dll'
]));
packageJson.build.win ||= {};
packageJson.build.win.executableName = 'LilacAnime-Libmpv-Shared-Prototype';
packageJson.build.win.artifactName = 'LilacAnime-Libmpv-Shared-Prototype-Setup.${ext}';

write('electron/main.cjs', main);
write('electron/preload.cjs', preload);
write('src/index.html', index);
write('src/app.js', app);
write('src/anime4k.js', anime4k);
write('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);

const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
write('electron/preload-libmpv-shared-entry.generated.cjs', "require('./preload.cjs');\nrequire('./libmpv-shared-preload.cjs');\n");

buildSync({
  entryPoints: [preloadEntry],
  outfile: file('electron/preload-libmpv-shared.generated.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info'
});

buildSync({
  entryPoints: [file('src/libmpv-shared-entry.js')],
  outfile: file('src/libmpv-shared.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome150',
  logLevel: 'info'
});

for (const relative of [
  'electron/main.cjs',
  'electron/libmpv-shared-main.cjs',
  'electron/libmpv-shared-preload.cjs',
  'electron/preload-libmpv-shared.generated.cjs',
  'src/app.js',
  'src/anime4k.js',
  'src/libmpv-shared-entry.js'
]) {
  execFileSync(process.execPath, ['--check', file(relative)], { stdio: 'inherit' });
}

const required = [
  ['electron/main.cjs', 'LILAC_LIBMPV_SHARED_SOURCE_PATCH'],
  ['electron/main.cjs', 'await libmpvShared.ensure()'],
  ['electron/main.cjs', 'await libmpvShared.attachWindow(win)'],
  ['electron/main.cjs', 'preload-libmpv-shared.generated.cjs'],
  ['electron/preload.cjs', 'libmpvSharedOpen'],
  ['electron/preload.cjs', 'libmpvSharedDiagnostics'],
  ['electron/preload-libmpv-shared.generated.cjs', 'setSharedTextureReceiver'],
  ['src/index.html', '<lilac-mpv-video id="video"'],
  ['src/index.html', 'libmpv-shared.generated.js'],
  ['src/libmpv-shared.generated.js', 'libmpv-d3d11-shared-texture'],
  ['src/app.js', 'libmpv GPU 재생 중'],
  ['package.json', '43.8.1'],
  ['package.json', 'lilac-libmpv-player-bridge.node']
];
for (const [relative, marker] of required) {
  if (!read(relative).includes(marker)) throw new Error(`shared transform verification failed: ${relative} missing ${marker}`);
}

if (read('electron/main.cjs').includes("require('./mpv-native-main.cjs')")) {
  throw new Error('legacy HWND mpv main bridge leaked into shared-texture transform');
}
if (read('src/index.html').includes('mpv-native.generated.js')) {
  throw new Error('legacy HWND renderer script leaked into shared-texture transform');
}

console.log('LIBMPV_SHARED_TEXTURE_TRANSFORM_OK');

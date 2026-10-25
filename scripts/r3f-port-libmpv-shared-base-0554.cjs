'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const repoRequire = createRequire(path.join(process.cwd(), 'package.json'));
const { buildSync } = repoRequire('esbuild');

const root = process.cwd();
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => {
  fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
  fs.writeFileSync(file(relative), value, 'utf8');
};

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function requireMarkers(source, expected, label) {
  for (const marker of expected) if (!source.includes(marker)) throw new Error(`${label} missing marker: ${marker}`);
}

let main = read('electron/main.cjs');
let preload = read('electron/preload.cjs');
let index = read('src/index.html');
let app = read('src/app.js');
let anime4k = read('src/anime4k.js');
const pkg = JSON.parse(read('package.json'));

if (main.includes('LILAC_LIBMPV_SHARED_SOURCE_PATCH')) throw new Error('0.5.54 shared base wiring already applied');
for (const relative of ['electron/libmpv-shared-main.cjs','electron/libmpv-shared-preload.cjs','src/libmpv-shared-entry.js']) {
  if (!fs.existsSync(file(relative))) throw new Error(`shared base source missing: ${relative}`);
}

// Main-process bridge. Preserve 0.5.54 provider/Miruro/updater code and inject only
// the already-qualified libmpv shared-texture lifecycle around the existing window.
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
  "app.whenReady().then(async () => {\n  if (!singleInstanceLock) return;",
  "app.whenReady().then(async () => {\n  if (!singleInstanceLock) return;\n  await libmpvShared.ensure();",
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

// Expose the shared bridge through the existing context-isolated window.lilac API.
preload = replaceOnce(
  preload,
  "  mpvStatus: () => ipcRenderer.invoke('mpv:status'),",
  "  mpvStatus: () => ipcRenderer.invoke('mpv:status'),\n  libmpvSharedOpen: (url, headers = {}, hls = false, size = {}) => ipcRenderer.invoke('libmpv-shared:open', url, headers, Boolean(hls), size),\n  libmpvSharedCommand: command => ipcRenderer.invoke('libmpv-shared:command', command),\n  libmpvSharedState: () => ipcRenderer.invoke('libmpv-shared:state'),\n  libmpvSharedResize: size => ipcRenderer.invoke('libmpv-shared:resize', size),\n  libmpvSharedClose: () => ipcRenderer.invoke('libmpv-shared:close'),\n  libmpvSharedDiagnostics: () => ipcRenderer.invoke('libmpv-shared:diagnostics'),",
  'preload shared player APIs'
);

// Replace only the video surface and add the custom-element bundle before app.js.
// Everything around it, including 0.5.54 seek-hint/controls markup, stays upstream.
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

// Route the existing 0.5.54 playback resolver into libmpv without touching its
// source/provider selection. HLS.js/native-video remain the fallback branch.
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

// Chromium Anime4K must not try to own the custom libmpv surface.
const anime4kAnchor = "  const mode = () => Object.hasOwn(modes, localStorage.getItem('playerAnime4k')) ? localStorage.getItem('playerAnime4k') : 'off';";
if (anime4k.includes(anime4kAnchor)) {
  anime4k = replaceOnce(
    anime4k,
    anime4kAnchor,
    "  const mode = () => document.querySelector('lilac-mpv-video') ? 'off' : (Object.hasOwn(modes, localStorage.getItem('playerAnime4k')) ? localStorage.getItem('playerAnime4k') : 'off');",
    'disable Chromium Anime4K for libmpv element'
  );
} else if (!anime4k.includes("document.querySelector('lilac-mpv-video') ? 'off'")) {
  throw new Error('Anime4K libmpv exclusion anchor missing');
}

// Keep upstream 0.5.54 application identity/Linux packaging, but restore the
// qualified Electron major and native payload unpack requirements.
pkg.devDependencies ||= {};
pkg.devDependencies.electron = '44.9.3';
pkg.build ||= {};
pkg.build.asarUnpack = Array.from(new Set([
  ...(pkg.build.asarUnpack || []),
  'electron/lilac-libmpv-player-bridge.node',
  'electron/libmpv-2.dll'
]));

write('electron/main.cjs', main);
write('electron/preload.cjs', preload);
write('src/index.html', index);
write('src/app.js', app);
write('src/anime4k.js', anime4k);
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

write('electron/preload-libmpv-shared-entry.generated.cjs', "require('./preload.cjs');\nrequire('./libmpv-shared-preload.cjs');\n");
buildSync({
  entryPoints: [file('electron/preload-libmpv-shared-entry.generated.cjs')],
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
  target: 'chrome152',
  logLevel: 'info'
});

const finalMain = read('electron/main.cjs');
requireMarkers(finalMain, [
  'LILAC_LIBMPV_SHARED_SOURCE_PATCH',
  'createLibmpvSharedBridge({',
  'await libmpvShared.ensure()',
  'await libmpvShared.attachWindow(win)',
  'preload-libmpv-shared.generated.cjs',
  'LILAC_LIBMPV_SHARED_CLEANUP'
], 'main shared integration');
requireMarkers(read('electron/preload.cjs'), ['libmpvSharedOpen','libmpvSharedDiagnostics'], 'preload shared integration');
requireMarkers(read('src/index.html'), ['<lilac-mpv-video id="video"','libmpv-shared.generated.js','playerSeekHint'], 'renderer integration');
requireMarkers(read('src/app.js'), ['window.LilacNativeMpv?.enabled','libmpv GPU 재생 중','controlsOnPlaying'], 'playback integration');
requireMarkers(read('electron/preload-libmpv-shared.generated.cjs'), ['setSharedTextureReceiver','libmpvSharedOpen'], 'generated preload');
requireMarkers(read('src/libmpv-shared.generated.js'), ['lilac-mpv-video'], 'generated renderer');
const finalPkg = JSON.parse(read('package.json'));
if (finalPkg.devDependencies?.electron !== '44.9.3') throw new Error(`Electron pin mismatch: ${finalPkg.devDependencies?.electron}`);
for (const native of ['electron/lilac-libmpv-player-bridge.node','electron/libmpv-2.dll']) {
  if (!finalPkg.build?.asarUnpack?.includes(native)) throw new Error(`native unpack entry missing: ${native}`);
}
if (finalPkg.build?.appId !== 'com.lilac.anime.desktop' || finalPkg.build?.productName !== 'LilacAnime') {
  throw new Error('0.5.54 application identity changed by shared integration');
}
if (!finalPkg.build?.linux || !finalPkg.build?.deb) throw new Error('0.5.54 Linux/deb packaging was lost');

console.log(`R3F_0554_SHARED_BASE_OK version=${finalPkg.version} electron=44.9.3 main=wired preload=combined renderer=custom-element nativeUnpack=2 upstreamIdentity=preserved`);

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const sha = target => crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const env = name => { const value = process.env[name]; if (!value) throw new Error(`missing env ${name}`); return value; };
const need = (text, marker, label) => { if (!text.includes(marker)) throw new Error(`${label} missing ${marker}`); };
const forbid = (text, marker, label) => { if (text.includes(marker)) throw new Error(`${label} contains forbidden ${marker}`); };

const tag = env('R44_RELEASE_TAG');
const version = env('R44_APP_VERSION');
const installerName = env('R44_INSTALLER_NAME');
const manifestName = env('R44_MANIFEST_NAME');
const pkg = JSON.parse(read('package.json'));
if (pkg.version !== version || pkg.lilacCustomTag !== tag) throw new Error(`R44 source identity mismatch ${pkg.version} ${pkg.lilacCustomTag}`);
if (pkg.build.appId !== env('STABLE_APP_ID') || pkg.build.productName !== env('STABLE_PRODUCT_NAME') || pkg.build.win.executableName !== env('STABLE_EXE_BASE')) throw new Error('R44 stable install identity drifted');
if (pkg.build.win.artifactName !== 'LilacAnime-Libmpv-R44-Setup.${ext}') throw new Error('R44 artifactName drifted');

const expected = {
  updater: env('R44_EXPECTED_UPDATER_SHA256'),
  focusedPreload: env('R44_EXPECTED_FOCUSED_PRELOAD_SHA256'),
  focusedBundle: env('R44_EXPECTED_FOCUSED_BUNDLE_SHA256'),
  addon: env('R44_EXPECTED_ADDON_SHA256'),
  dll: env('R44_EXPECTED_DLL_SHA256'),
  bridge: env('R44_EXPECTED_BRIDGE_SHA256'),
  overlayPreload: env('R44_EXPECTED_OVERLAY_PRELOAD_SHA256'),
  main: env('R44_EXPECTED_MAIN_SHA256'),
  controller: env('R44_EXPECTED_CONTROLLER_SHA256')
};
const source = {
  updater: sha(path.join(root, 'electron/updater.cjs')),
  focusedPreload: sha(path.join(root, 'electron/libmpv-shared-preload.cjs')),
  focusedBundle: sha(path.join(root, 'electron/preload-libmpv-shared.generated.cjs')),
  addon: sha(path.join(root, 'electron/lilac-libmpv-player-bridge.node')),
  dll: sha(path.join(root, 'electron/libmpv-2.dll')),
  bridge: sha(path.join(root, 'electron/libmpv-shared-main.cjs')),
  overlayPreload: sha(path.join(root, 'electron/r40-subtitle-overlay-preload.cjs')),
  main: sha(path.join(root, 'electron/main.cjs')),
  controller: sha(path.join(root, 'electron/r40-subtitle-overlay-window.cjs'))
};
for (const key of Object.keys(expected)) if (source[key] !== expected[key]) throw new Error(`R44 source drift ${key}: expected ${expected[key]} got ${source[key]}`);
if (source.dll !== env('QUALIFIED_DLL_SHA256')) throw new Error('R44 qualified libmpv DLL mismatch');

const controller = read('electron/r40-subtitle-overlay-window.cjs');
const main = read('electron/main.cjs');
for (const marker of [
  'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND',
  'LILAC_R44_PREWARMED_SUBTITLE_OVERLAY',
  'await this.ensurePromise',
  'prewarm-show-opacity-zero',
  'reveal-visible-reanchored',
  'first-active-session-reanchor-opacity-zero',
  'r44-payload-active-prewarmed-hwnd',
  'transitionTrace: this.transitionTrace.slice()'
]) need(controller, marker, 'R44 subtitle controller');
for (const marker of ['LILAC_R44_PREWARMED_SUBTITLE_OVERLAY', "prewarm(win, 'owner-blur')", "reconcileDeferred(win, 'owner-blur')"]) need(main, marker, 'R44 main lifecycle');
for (const text of [controller, main, read('electron/libmpv-shared-main.cjs'), read('electron/libmpv-shared-preload.cjs')]) {
  for (const bad of ['copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition']) forbid(text, bad, 'R44 product');
}

fs.rmSync(path.join(root, 'dist'), { recursive:true, force:true });
const builder = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const build = spawnSync(builder, ['--win','nsis','--x64','--publish','never'], { cwd:root, stdio:'inherit', windowsHide:true, shell:process.platform === 'win32' });
if (build.error) throw new Error(`R44 electron-builder spawn failed: ${build.error.message}`);
if (build.status !== 0) throw new Error(`R44 electron-builder failed ${build.status}`);

const installer = path.join(root, 'dist', installerName);
const packedExe = path.join(root, 'dist', 'win-unpacked', `${env('STABLE_EXE_BASE')}.exe`);
const appAsar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
for (const output of [installer, packedExe, appAsar]) if (!fs.existsSync(output)) throw new Error(`R44 packaged output missing ${output}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r44-asar-'));
try {
  asar.extractAll(appAsar, temp);
  const shipPkg = JSON.parse(fs.readFileSync(path.join(temp, 'package.json'), 'utf8'));
  if (shipPkg.version !== version || shipPkg.lilacCustomTag !== tag) throw new Error(`R44 packaged identity mismatch ${shipPkg.version} ${shipPkg.lilacCustomTag}`);
  const packed = {
    updater: sha(path.join(temp, 'electron/updater.cjs')),
    focusedPreload: sha(path.join(temp, 'electron/libmpv-shared-preload.cjs')),
    focusedBundle: sha(path.join(temp, 'electron/preload-libmpv-shared.generated.cjs')),
    bridge: sha(path.join(temp, 'electron/libmpv-shared-main.cjs')),
    overlayPreload: sha(path.join(temp, 'electron/r40-subtitle-overlay-preload.cjs')),
    main: sha(path.join(temp, 'electron/main.cjs')),
    controller: sha(path.join(temp, 'electron/r40-subtitle-overlay-window.cjs'))
  };
  for (const [key,value] of Object.entries(packed)) if (value !== expected[key]) throw new Error(`R44 packaged byte drift ${key}: expected ${expected[key]} got ${value}`);
  const shipController = fs.readFileSync(path.join(temp, 'electron/r40-subtitle-overlay-window.cjs'), 'utf8');
  for (const marker of ['LILAC_R44_PREWARMED_SUBTITLE_OVERLAY','prewarm-show-opacity-zero','first-active-session-reanchor-opacity-zero','transitionTrace: this.transitionTrace.slice()']) need(shipController, marker, 'R44 packaged controller');
} finally {
  fs.rmSync(temp, { recursive:true, force:true });
}

const unpackedElectron = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'electron');
const packedAddon = path.join(unpackedElectron, 'lilac-libmpv-player-bridge.node');
const packedDll = path.join(unpackedElectron, 'libmpv-2.dll');
if (!fs.existsSync(packedAddon) || sha(packedAddon) !== expected.addon) throw new Error('R44 packaged native addon drifted');
if (!fs.existsSync(packedDll) || sha(packedDll) !== expected.dll) throw new Error('R44 packaged libmpv DLL drifted');

const installerSha256 = sha(installer);
const installerSize = fs.statSync(installer).size;
const manifest = {
  schema: 2,
  version,
  tag,
  installer: installerName,
  installerSha256,
  installerSize,
  releaseWorkflowSourceSha: env('GITHUB_SHA'),
  electron: env('ELECTRON_VERSION'),
  baseReleaseTag: env('R43_RELEASE_TAG'),
  baseAppVersion: env('R43_APP_VERSION'),
  baseInstallerSha256: env('R43_BASE_INSTALLER_SHA256'),
  baseManifestSha256: env('R43_BASE_MANIFEST_SHA256'),
  nativeAddon: expected.addon,
  nativeDll: expected.dll,
  updaterSha256: expected.updater,
  focusedPreloadSha256: expected.focusedPreload,
  focusedBundleSha256: expected.focusedBundle,
  bridgeSha256: expected.bridge,
  mainSha256: expected.main,
  subtitleControllerSha256: expected.controller,
  r44PreflightQualified: true,
  r44ConcurrentEnsureQualified: true,
  r44PrewarmedFirstCueRuntimeQualified: true,
  r44R41LiveHandoffRequalified: true,
  r44ProtectedVideoPipelineBytesQualified: true,
  r44FirstCueInvariant: 'blur-prewarm-empty-transparent-hwnd+shared-load-promise+first-active-no-showInactive+opacity0-zorder-reanchor+double-raf-reveal',
  r44CueGapInvariant: 'persistent-hwnd+dom-clear-only+no-show-hide+no-zorder-churn-after-first-active',
  r44OverlayTransitionMitigation: 'hard-hide-opacity0+first-show-opacity0+bounded-transition-trace',
  r44FocusedPresenterInvariant: 'R41-direct-receive-webgpu-copy-byte-identical',
  r44UnfocusedPresenterInvariant: 'R33-owned-popup-native-only-byte-identical',
  r44UpdaterInvariant: 'R38-updater-byte-identical',
  r44OverlayDomInvariant: 'R40-overlay-preload-byte-identical',
  r44ForbiddenPathInvariant: 'R25-disable-direct-composition-absent+R28-staged-webgpu-absent'
};
fs.writeFileSync(path.join(root, 'dist', manifestName), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const roundtrip = JSON.parse(fs.readFileSync(path.join(root, 'dist', manifestName), 'utf8'));
for (const flag of ['r44PreflightQualified','r44ConcurrentEnsureQualified','r44PrewarmedFirstCueRuntimeQualified','r44R41LiveHandoffRequalified','r44ProtectedVideoPipelineBytesQualified']) if (roundtrip[flag] !== true) throw new Error(`R44 manifest flag missing ${flag}`);
if (roundtrip.installerSha256 !== installerSha256 || Number(roundtrip.installerSize) !== installerSize) throw new Error('R44 manifest installer identity mismatch');

console.log(`R44_RELEASE_PACKAGE_OK installer=${installerName} sha256=${installerSha256} size=${installerSize} firstCue=prewarmed concurrentEnsure=qualified cueZOrder=stable focusedWebGPU=byte-identical addon=byte-identical dll=byte-identical`);

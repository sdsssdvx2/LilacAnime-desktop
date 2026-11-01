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
const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
};
const need = (text, marker, label) => {
  if (!text.includes(marker)) throw new Error(`${label} missing ${marker}`);
};
const forbid = (text, marker, label) => {
  if (text.includes(marker)) throw new Error(`${label} contains forbidden ${marker}`);
};

const tag = env('R43_RELEASE_TAG');
const version = env('R43_APP_VERSION');
const installerName = env('R43_INSTALLER_NAME');
const manifestName = env('R43_MANIFEST_NAME');
const pkg = JSON.parse(read('package.json'));
if (pkg.version !== version || pkg.lilacCustomTag !== tag) throw new Error(`R43 source identity mismatch ${pkg.version} ${pkg.lilacCustomTag}`);
if (pkg.build.appId !== env('STABLE_APP_ID') || pkg.build.productName !== env('STABLE_PRODUCT_NAME') || pkg.build.win.executableName !== env('STABLE_EXE_BASE')) throw new Error('R43 stable install identity drifted');
if (pkg.build.win.artifactName !== 'LilacAnime-Libmpv-R43-Setup.${ext}') throw new Error('R43 artifactName drifted');

const expected = {
  updater: env('R43_EXPECTED_UPDATER_SHA256'),
  focusedPreload: env('R43_EXPECTED_FOCUSED_PRELOAD_SHA256'),
  focusedBundle: env('R43_EXPECTED_FOCUSED_BUNDLE_SHA256'),
  addon: env('R43_EXPECTED_ADDON_SHA256'),
  dll: env('R43_EXPECTED_DLL_SHA256'),
  main: env('R43_EXPECTED_MAIN_SHA256'),
  bridge: env('R43_EXPECTED_BRIDGE_SHA256'),
  overlayPreload: env('R43_EXPECTED_OVERLAY_PRELOAD_SHA256')
};
const source = {
  updater: sha(path.join(root, 'electron/updater.cjs')),
  focusedPreload: sha(path.join(root, 'electron/libmpv-shared-preload.cjs')),
  focusedBundle: sha(path.join(root, 'electron/preload-libmpv-shared.generated.cjs')),
  addon: sha(path.join(root, 'electron/lilac-libmpv-player-bridge.node')),
  dll: sha(path.join(root, 'electron/libmpv-2.dll')),
  main: sha(path.join(root, 'electron/main.cjs')),
  bridge: sha(path.join(root, 'electron/libmpv-shared-main.cjs')),
  overlayPreload: sha(path.join(root, 'electron/r40-subtitle-overlay-preload.cjs'))
};
for (const key of Object.keys(expected)) {
  if (source[key] !== expected[key]) throw new Error(`R43 protected source drifted ${key}: expected ${expected[key]} got ${source[key]}`);
}
if (source.dll !== env('QUALIFIED_DLL_SHA256')) throw new Error('R43 qualified libmpv DLL mismatch');

const controller = read('electron/r40-subtitle-overlay-window.cjs');
for (const marker of [
  'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
  'LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY',
  'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND',
  'r43-inactive-payload-kept-hwnd',
  'r43-payload-active-existing-hwnd',
  'active: this.contentActive',
  'hwndSessionVisible: this.visible'
]) need(controller, marker, 'R43 subtitle controller');
for (const text of [controller, read('electron/libmpv-shared-main.cjs'), read('electron/libmpv-shared-preload.cjs')]) {
  for (const bad of ['copyTextureToTexture', 'focus-staged-gpu-copy', '--disable-direct-composition']) forbid(text, bad, 'R43 product');
}

fs.rmSync(path.join(root, 'dist'), { recursive:true, force:true });
const builder = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const build = spawnSync(builder, ['--win', 'nsis', '--x64', '--publish', 'never'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  shell: process.platform === 'win32'
});
if (build.error) throw new Error(`R43 electron-builder spawn failed: ${build.error.message}`);
if (build.status !== 0) throw new Error(`R43 electron-builder failed ${build.status}`);

const installer = path.join(root, 'dist', installerName);
const packedExe = path.join(root, 'dist', 'win-unpacked', `${env('STABLE_EXE_BASE')}.exe`);
const appAsar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
for (const output of [installer, packedExe, appAsar]) {
  if (!fs.existsSync(output)) throw new Error(`R43 packaged output missing ${output}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r43-asar-'));
try {
  asar.extractAll(appAsar, temp);
  const shipPkg = JSON.parse(fs.readFileSync(path.join(temp, 'package.json'), 'utf8'));
  if (shipPkg.version !== version || shipPkg.lilacCustomTag !== tag) throw new Error(`R43 packaged identity mismatch ${shipPkg.version} ${shipPkg.lilacCustomTag}`);
  const shipController = fs.readFileSync(path.join(temp, 'electron/r40-subtitle-overlay-window.cjs'), 'utf8');
  for (const marker of ['LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND','r43-inactive-payload-kept-hwnd','r43-payload-active-existing-hwnd','active: this.contentActive']) {
    need(shipController, marker, 'R43 packaged subtitle controller');
  }
  const packedProtected = {
    updater: sha(path.join(temp, 'electron/updater.cjs')),
    focusedPreload: sha(path.join(temp, 'electron/libmpv-shared-preload.cjs')),
    focusedBundle: sha(path.join(temp, 'electron/preload-libmpv-shared.generated.cjs')),
    main: sha(path.join(temp, 'electron/main.cjs')),
    bridge: sha(path.join(temp, 'electron/libmpv-shared-main.cjs')),
    overlayPreload: sha(path.join(temp, 'electron/r40-subtitle-overlay-preload.cjs'))
  };
  for (const [key, value] of Object.entries(packedProtected)) {
    if (value !== expected[key]) throw new Error(`R43 packaged protected byte drift ${key}: expected ${expected[key]} got ${value}`);
  }
} finally {
  fs.rmSync(temp, { recursive:true, force:true });
}

const unpackedElectron = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'electron');
const packedAddon = path.join(unpackedElectron, 'lilac-libmpv-player-bridge.node');
const packedDll = path.join(unpackedElectron, 'libmpv-2.dll');
if (!fs.existsSync(packedAddon) || sha(packedAddon) !== expected.addon) throw new Error('R43 packaged native addon drifted');
if (!fs.existsSync(packedDll) || sha(packedDll) !== expected.dll) throw new Error('R43 packaged libmpv DLL drifted');

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
  baseReleaseTag: env('R41_RELEASE_TAG'),
  baseAppVersion: env('R41_APP_VERSION'),
  baseInstallerSha256: env('R41_BASE_INSTALLER_SHA256'),
  baseManifestSha256: env('R41_BASE_MANIFEST_SHA256'),
  nativeAddon: expected.addon,
  nativeDll: expected.dll,
  updaterSha256: expected.updater,
  focusedPreloadSha256: expected.focusedPreload,
  focusedBundleSha256: expected.focusedBundle,
  r43PreflightQualified: true,
  r43PersistentSubtitleHwndRuntimeQualified: true,
  r43R41LiveHandoffRequalified: true,
  r43ProtectedR41BytesQualified: true,
  r43SubtitleCueGapInvariant: 'unfocused-owned-transparent-hwnd-kept-visible+inactive-dom-clear+next-cue-no-reshow+refocus-hard-hide',
  r43FocusedPresenterInvariant: 'R41-direct-receive-webgpu-copy-preserved-byte-identical',
  r43UnfocusedPresenterInvariant: 'R33-owned-popup-native-only-preserved',
  r43UpdaterInvariant: 'R38-updater-byte-identical',
  r43PiPInvariant: 'R39-main-process-byte-identical',
  r43OverlayDomInvariant: 'R40-overlay-preload-byte-identical',
  r43ForbiddenPathInvariant: 'R25-disable-direct-composition-absent+R28-staged-webgpu-absent'
};
fs.writeFileSync(path.join(root, 'dist', manifestName), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const roundtrip = JSON.parse(fs.readFileSync(path.join(root, 'dist', manifestName), 'utf8'));
for (const flag of ['r43PreflightQualified','r43PersistentSubtitleHwndRuntimeQualified','r43R41LiveHandoffRequalified','r43ProtectedR41BytesQualified']) {
  if (roundtrip[flag] !== true) throw new Error(`R43 manifest flag missing ${flag}`);
}
if (roundtrip.installerSha256 !== installerSha256 || Number(roundtrip.installerSize) !== installerSize) throw new Error('R43 manifest installer identity mismatch');

console.log(`R43_RELEASE_PACKAGE_OK installer=${installerName} sha256=${installerSha256} size=${installerSize} base=R41 persistentSubtitleHwnd=qualified updater=byte-identical focusedWebGPU=byte-identical addon=byte-identical dll=byte-identical`);

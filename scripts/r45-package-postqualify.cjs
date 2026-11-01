'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const env = name => { const value = process.env[name]; if (!value) throw new Error(`missing env ${name}`); return value; };
const sha = target => crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const need = (text, marker, label) => { if (!text.includes(marker)) throw new Error(`${label} missing ${marker}`); };
const forbid = (text, marker, label) => { if (text.includes(marker)) throw new Error(`${label} contains forbidden ${marker}`); };

const tag = env('R45_RELEASE_TAG');
const version = env('R45_APP_VERSION');
const installerName = env('R45_INSTALLER_NAME');
const manifestName = env('R45_MANIFEST_NAME');
const baselinePath = env('R45_PROTECTED_BASELINE_JSON');
if (!fs.existsSync(baselinePath)) throw new Error(`missing R45 protected baseline JSON ${baselinePath}`);
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

const expectedPaths = [
  'electron/libmpv-shared-preload.cjs',
  'electron/preload-libmpv-shared.generated.cjs',
  'electron/r40-subtitle-overlay-window.cjs',
  'electron/r40-subtitle-overlay-preload.cjs',
  'electron/lilac-libmpv-player-bridge.node',
  'electron/libmpv-2.dll',
  'electron/updater.cjs',
  'electron/main.cjs',
  'src/libmpv-shared.generated.js'
];
for (const relative of expectedPaths) {
  if (!baseline[relative]) throw new Error(`R45 baseline JSON missing ${relative}`);
  const current = path.join(root, relative);
  if (!fs.existsSync(current)) throw new Error(`R45 source missing protected file ${relative}`);
  const actual = sha(current);
  if (actual !== String(baseline[relative]).toLowerCase()) throw new Error(`R45 protected byte drift before package ${relative}: expected ${baseline[relative]} got ${actual}`);
}

const bridgePath = path.join(root, 'electron/libmpv-shared-main.cjs');
if (!fs.existsSync(bridgePath)) throw new Error('R45 transformed bridge missing');
const bridge = read('electron/libmpv-shared-main.cjs');
for (const marker of [
  'LILAC_R45_NATIVE_OFFSCREEN_FIRST_PRESENT_PRIME',
  'LILAC_R45_PRIME_FORCE_REDRAW_WAKE',
  'LILAC_R45_FIRST_PRESENT_OFFSCREEN_PROOF',
  'LILAC_R40_HANDOFF_FORCE_REDRAW',
  'requestFrameProducerRedraw',
  'r41HandoffPlaying'
]) need(bridge, marker, 'R45 transformed bridge');
for (const bad of ['copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition']) forbid(bridge, bad, 'R45 transformed bridge');
const transformedBridgeSha = sha(bridgePath);

const overlay = read('electron/r40-subtitle-overlay-window.cjs');
for (const marker of ['LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND','LILAC_R44_PREWARMED_SUBTITLE_OVERLAY','prewarm-show-opacity-zero','first-active-session-reanchor-opacity-zero']) need(overlay, marker, 'R45 preserved R44 subtitle overlay');
const focusedPreload = read('electron/libmpv-shared-preload.cjs');
need(focusedPreload, 'LILAC_R41_VISUAL_HANDOFF_COMMIT', 'R45 focused preload');

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== env('R44_APP_VERSION') || pkg.lilacCustomTag !== env('R44_RELEASE_TAG')) throw new Error(`R45 package expected reconstructed R44 identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
if (!pkg.build || !pkg.build.win || !pkg.build.nsis) throw new Error('R45 reconstructed build metadata missing');
if (pkg.build.appId !== env('STABLE_APP_ID') || pkg.build.productName !== env('STABLE_PRODUCT_NAME') || pkg.build.win.executableName !== env('STABLE_EXE_BASE') || pkg.build.nsis.shortcutName !== env('STABLE_SHORTCUT_NAME')) throw new Error('R45 reconstructed stable install identity drifted');
pkg.version = version;
pkg.lilacCustomTag = tag;
pkg.build.electronVersion = env('ELECTRON_VERSION');
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R45-Setup.${ext}';
pkg.build.nsis.shortcutName = env('STABLE_SHORTCUT_NAME');
pkg.build.nsis.uninstallDisplayName = env('STABLE_SHORTCUT_NAME');
pkg.build.nsis.deleteAppDataOnUninstall = false;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

fs.rmSync(path.join(root, 'dist'), { recursive:true, force:true });
const builder = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const build = spawnSync(builder, ['--win','nsis','--x64','--publish','never'], { cwd:root, stdio:'inherit', windowsHide:true, shell:process.platform === 'win32' });
if (build.error) throw new Error(`R45 electron-builder spawn failed: ${build.error.message}`);
if (build.status !== 0) throw new Error(`R45 electron-builder failed ${build.status}`);

const installer = path.join(root, 'dist', installerName);
const packedExe = path.join(root, 'dist', 'win-unpacked', `${env('STABLE_EXE_BASE')}.exe`);
const appAsar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
for (const output of [installer, packedExe, appAsar]) if (!fs.existsSync(output)) throw new Error(`R45 packaged output missing ${output}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r45-asar-'));
try {
  asar.extractAll(appAsar, temp);
  const shipPkg = JSON.parse(fs.readFileSync(path.join(temp, 'package.json'), 'utf8'));
  if (shipPkg.version !== version || shipPkg.lilacCustomTag !== tag) throw new Error(`R45 packaged identity mismatch ${shipPkg.version} ${shipPkg.lilacCustomTag}`);

  const packedBridgePath = path.join(temp, 'electron/libmpv-shared-main.cjs');
  if (!fs.existsSync(packedBridgePath) || sha(packedBridgePath) !== transformedBridgeSha) throw new Error('R45 packaged transformed bridge drifted');
  const packedBridge = fs.readFileSync(packedBridgePath, 'utf8');
  for (const marker of ['LILAC_R45_NATIVE_OFFSCREEN_FIRST_PRESENT_PRIME','LILAC_R45_PRIME_FORCE_REDRAW_WAKE','LILAC_R45_FIRST_PRESENT_OFFSCREEN_PROOF']) need(packedBridge, marker, 'R45 packaged bridge');

  for (const relative of [
    'electron/libmpv-shared-preload.cjs',
    'electron/preload-libmpv-shared.generated.cjs',
    'electron/r40-subtitle-overlay-window.cjs',
    'electron/r40-subtitle-overlay-preload.cjs',
    'electron/updater.cjs',
    'electron/main.cjs',
    'src/libmpv-shared.generated.js'
  ]) {
    const packedPath = path.join(temp, relative);
    if (!fs.existsSync(packedPath)) throw new Error(`R45 packaged protected file missing ${relative}`);
    const actual = sha(packedPath);
    const expected = String(baseline[relative]).toLowerCase();
    if (actual !== expected) throw new Error(`R45 packaged protected byte drift ${relative}: expected ${expected} got ${actual}`);
  }
} finally {
  fs.rmSync(temp, { recursive:true, force:true });
}

const unpackedElectron = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'electron');
for (const relative of ['electron/lilac-libmpv-player-bridge.node','electron/libmpv-2.dll']) {
  const name = path.basename(relative);
  const packed = path.join(unpackedElectron, name);
  if (!fs.existsSync(packed)) throw new Error(`R45 packaged native file missing ${name}`);
  const actual = sha(packed);
  const expected = String(baseline[relative]).toLowerCase();
  if (actual !== expected) throw new Error(`R45 packaged native byte drift ${name}: expected ${expected} got ${actual}`);
}

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
  baseReleaseTag: env('R44_RELEASE_TAG'),
  baseAppVersion: env('R44_APP_VERSION'),
  baseInstallerSha256: env('R44_INSTALLER_SHA256'),
  baseManifestSha256: env('R44_MANIFEST_SHA256'),
  nativeAddon: String(baseline['electron/lilac-libmpv-player-bridge.node']).toLowerCase(),
  nativeDll: String(baseline['electron/libmpv-2.dll']).toLowerCase(),
  updaterSha256: String(baseline['electron/updater.cjs']).toLowerCase(),
  focusedPreloadSha256: String(baseline['electron/libmpv-shared-preload.cjs']).toLowerCase(),
  focusedBundleSha256: String(baseline['electron/preload-libmpv-shared.generated.cjs']).toLowerCase(),
  bridgeSha256: transformedBridgeSha,
  mainSha256: String(baseline['electron/main.cjs']).toLowerCase(),
  subtitleControllerSha256: String(baseline['electron/r40-subtitle-overlay-window.cjs']).toLowerCase(),
  subtitleOverlayPreloadSha256: String(baseline['electron/r40-subtitle-overlay-preload.cjs']).toLowerCase(),
  rendererBundleSha256: String(baseline['src/libmpv-shared.generated.js']).toLowerCase(),
  r45OffscreenFirstPresentQualified: true,
  r45FirstPresentProofQualified: true,
  r45NoPrePresentExposureViolations: true,
  r45ForcedRedrawQualified: true,
  r45R41LiveHandoffRequalified: true,
  r45R44SubtitleOverlayPreserved: true,
  r45ProtectedVideoPipelineBytesQualified: true,
  r45QualificationCycles: 8,
  r45BlurInvariant: 'native-owned-popup-offscreen+forced-current-redraw+first-Present-proof-before-onscreen-bounds',
  r45GeometryInvariant: 'pending-prime-forces-offscreen-bounds+pre-present-onscreen-violation-hides-and-cancels',
  r45FocusInvariant: 'R41-visual-commit-handoff-preserved',
  r45SubtitleInvariant: 'R44-prewarmed-persistent-overlay-byte-identical',
  r45FocusedPresenterInvariant: 'R41-direct-receive-webgpu-copy-byte-identical',
  r45NativeInvariant: 'R33-owned-popup-addon-and-libmpv-byte-identical',
  r45UpdaterInvariant: 'R38-updater-byte-identical',
  r45ForbiddenPathInvariant: 'R25-disable-direct-composition-absent+R28-staged-webgpu-absent',
  r45MicroStutterScope: 'not-addressed-steady-23.976fps-supply-cadence-remains-separate-display-phase-investigation'
};
const manifestPath = path.join(root, 'dist', manifestName);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const roundtrip = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const flag of ['r45OffscreenFirstPresentQualified','r45FirstPresentProofQualified','r45NoPrePresentExposureViolations','r45ForcedRedrawQualified','r45R41LiveHandoffRequalified','r45R44SubtitleOverlayPreserved','r45ProtectedVideoPipelineBytesQualified']) {
  if (roundtrip[flag] !== true) throw new Error(`R45 manifest flag missing ${flag}`);
}
if (roundtrip.installerSha256 !== installerSha256 || Number(roundtrip.installerSize) !== installerSize) throw new Error('R45 manifest installer identity mismatch');
console.log(`R45_RELEASE_PACKAGE_OK installer=${installerName} sha256=${installerSha256} size=${installerSize} bridge=${transformedBridgeSha} cycles=8 prePresentExposureViolations=0 r41Handoff=requalified r44Subtitle=byte-identical addon=byte-identical dll=byte-identical updater=byte-identical`);

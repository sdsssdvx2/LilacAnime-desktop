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

const installerName = env('R42_INSTALLER_NAME');
const manifestName = env('R42_MANIFEST_NAME');
const diagnosticTag = env('R42_DIAGNOSTIC_TAG');
const expectedVersion = env('R41_APP_VERSION');
const expectedCustomTag = env('R41_RELEASE_TAG');
const packagePath = path.join(root, 'package.json');
const originalPackageText = fs.readFileSync(packagePath, 'utf8');
const pkg = JSON.parse(originalPackageText);

if (pkg.version !== expectedVersion || pkg.lilacCustomTag !== expectedCustomTag) {
  throw new Error(`R42 must retain R41 app/update identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
if (pkg.build.appId !== env('STABLE_APP_ID') || pkg.build.productName !== env('STABLE_PRODUCT_NAME') || pkg.build.win.executableName !== env('STABLE_EXE_BASE')) {
  throw new Error('R42 stable install identity drifted');
}
if (/^libmpv-r2k-v\d+\.\d+\.\d+-r\d+$/.test(diagnosticTag)) throw new Error('R42 diagnostic release tag must never match updater channel');

const source = {
  updater: sha(path.join(root, 'electron/updater.cjs')),
  focusedPreload: sha(path.join(root, 'electron/libmpv-shared-preload.cjs')),
  focusedBundle: sha(path.join(root, 'electron/preload-libmpv-shared.generated.cjs')),
  addon: sha(path.join(root, 'electron/lilac-libmpv-player-bridge.node')),
  dll: sha(path.join(root, 'electron/libmpv-2.dll'))
};
if (source.dll !== env('QUALIFIED_DLL_SHA256')) throw new Error('R42 qualified libmpv DLL mismatch');
for (const [relative, markers] of [
  ['src/libmpv-shared.generated.js', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','_r42SubtitleStyleDiagnostic']],
  ['electron/main.cjs', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','__lilacR42SubtitleOverlayDiagnostics']],
  ['electron/libmpv-shared-main.cjs', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','r42SubtitleOverlay']],
  ['electron/r40-subtitle-overlay-window.cjs', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','diagnosticTrace']],
  ['electron/r40-subtitle-overlay-preload.cjs', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','r42SchedulePaintSnapshots']]
]) {
  const text = read(relative);
  for (const marker of markers) need(text, marker, `R42 source ${relative}`);
}

fs.rmSync(path.join(root, 'dist'), { recursive:true, force:true });
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R41-D3-Diagnostic-Setup.${ext}';
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
try {
  const builder = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  const result = spawnSync(builder, ['--win','nsis','--x64','--publish','never'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32'
  });
  if (result.error) throw new Error(`R42 electron-builder spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`R42 electron-builder failed ${result.status}`);
} finally {
  fs.writeFileSync(packagePath, originalPackageText, 'utf8');
}

const installer = path.join(root, 'dist', installerName);
const appAsar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(installer)) throw new Error(`R42 installer missing ${installer}`);
if (!fs.existsSync(appAsar)) throw new Error('R42 packaged app.asar missing');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r42-d3-asar-'));
try {
  asar.extractAll(appAsar, temp);
  const shippedPkg = JSON.parse(fs.readFileSync(path.join(temp, 'package.json'), 'utf8'));
  if (shippedPkg.version !== expectedVersion || shippedPkg.lilacCustomTag !== expectedCustomTag) throw new Error('R42 packaged R41 update identity drifted');
  if (shippedPkg.build.appId !== env('STABLE_APP_ID') || shippedPkg.build.productName !== env('STABLE_PRODUCT_NAME') || shippedPkg.build.win.executableName !== env('STABLE_EXE_BASE')) throw new Error('R42 packaged stable install identity drifted');
  for (const [relative, markers] of [
    ['src/libmpv-shared.generated.js', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','_r42SubtitleStyleDiagnostic']],
    ['electron/main.cjs', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','__lilacR42SubtitleOverlayDiagnostics']],
    ['electron/libmpv-shared-main.cjs', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','r42SubtitleOverlay']],
    ['electron/r40-subtitle-overlay-window.cjs', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','diagnosticTrace']],
    ['electron/r40-subtitle-overlay-preload.cjs', ['LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC','r42SchedulePaintSnapshots']]
  ]) {
    const text = fs.readFileSync(path.join(temp, relative), 'utf8');
    for (const marker of markers) need(text, marker, `R42 packaged ${relative}`);
  }
  if (sha(path.join(temp, 'electron/updater.cjs')) !== source.updater) throw new Error('R42 packaged updater drifted');
  if (sha(path.join(temp, 'electron/libmpv-shared-preload.cjs')) !== source.focusedPreload) throw new Error('R42 packaged focused WebGPU preload drifted');
  if (sha(path.join(temp, 'electron/preload-libmpv-shared.generated.cjs')) !== source.focusedBundle) throw new Error('R42 packaged focused WebGPU bundle drifted');
} finally {
  fs.rmSync(temp, { recursive:true, force:true });
}

const unpackedElectron = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'electron');
const packedAddon = path.join(unpackedElectron, 'lilac-libmpv-player-bridge.node');
const packedDll = path.join(unpackedElectron, 'libmpv-2.dll');
if (!fs.existsSync(packedAddon) || sha(packedAddon) !== source.addon) throw new Error('R42 packaged native addon drifted');
if (!fs.existsSync(packedDll) || sha(packedDll) !== source.dll) throw new Error('R42 packaged libmpv DLL drifted');

const installerSha256 = sha(installer);
const installerSize = fs.statSync(installer).size;
const manifest = {
  schema: 1,
  diagnostic: 'R42 subtitle handoff opacity/window-paint trace',
  diagnosticMarker: 'LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC',
  diagnosticReleaseTag: diagnosticTag,
  sourceCommit: env('GITHUB_SHA'),
  appVersion: expectedVersion,
  appCustomTag: expectedCustomTag,
  updaterVisible: false,
  installer: installerName,
  installerSha256,
  installerSize,
  protected: {
    updaterSha256: source.updater,
    focusedPreloadSha256: source.focusedPreload,
    focusedBundleSha256: source.focusedBundle,
    nativeAddonSha256: source.addon,
    libmpvDllSha256: source.dll
  },
  captures: [
    'source DOM opacity/visibility/transition/animation at blur',
    'overlay deferred/replay/show/hide lifecycle ring',
    'overlay DOM opacity at commit, rAF1, rAF2, +50/+100/+200/+300ms',
    'existing R26 frame-boundary trace and R41 focus handoff diagnostics'
  ]
};
fs.writeFileSync(path.join(root, 'dist', manifestName), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`R42_DIAGNOSTIC_PACKAGE_OK installer=${installerName} sha256=${installerSha256} size=${installerSize} appIdentity=R41 updaterVisible=0 focusedWebGPU=byte-identical nativeAddon=byte-identical dll=byte-identical`);

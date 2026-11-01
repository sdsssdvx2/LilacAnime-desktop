'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
};
const sha256 = target => crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const norm = value => String(value || '').replace(/\\/g, '/');
const run = (command, args, label) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label}: exit ${result.status}`);
};
const walkFiles = directory => {
  const out = [];
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};
const findFile = (directory, predicate) => {
  const hits = walkFiles(directory).filter(file => predicate(path.basename(file), file));
  hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return hits[0] || null;
};
const copyTree = (from, to) => {
  if (!fs.existsSync(from)) throw new Error(`missing source tree ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
};
const assertEq = (actual, expected, label) => {
  if (String(actual) !== String(expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
};

const tag = env('R41_RELEASE_TAG');
const installerName = env('R41_INSTALLER_NAME');
const manifestName = env('R41_MANIFEST_NAME');
const expectedInstallerSha = env('R41_BASE_INSTALLER_SHA256').toLowerCase();
const expectedInstallerSize = Number(env('R41_BASE_INSTALLER_SIZE'));
const expectedManifestSha = env('R41_BASE_MANIFEST_SHA256').toLowerCase();
const expectedManifestSize = Number(env('R41_BASE_MANIFEST_SIZE'));
const expectedVersion = env('R41_APP_VERSION');
const repo = env('GITHUB_REPOSITORY');
const electronVersion = env('ELECTRON_VERSION');

const checkoutPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r42-r41-release-'));
const downloadDir = path.join(work, 'download');
const outerDir = path.join(work, 'outer');
const payloadDir = path.join(work, 'payload');
const asarDir = path.join(work, 'asar');
fs.mkdirSync(downloadDir, { recursive: true });
fs.mkdirSync(outerDir, { recursive: true });
fs.mkdirSync(payloadDir, { recursive: true });
fs.mkdirSync(asarDir, { recursive: true });

run('gh', ['release', 'download', tag, '--repo', repo, '--dir', downloadDir, '--pattern', installerName, '--pattern', manifestName], 'download pinned R41 release');
const installer = path.join(downloadDir, installerName);
const manifestPath = path.join(downloadDir, manifestName);
for (const file of [installer, manifestPath]) if (!fs.existsSync(file)) throw new Error(`R41 release asset missing ${file}`);

assertEq(sha256(installer), expectedInstallerSha, 'R41 installer SHA256');
assertEq(fs.statSync(installer).size, expectedInstallerSize, 'R41 installer size');
assertEq(sha256(manifestPath), expectedManifestSha, 'R41 manifest SHA256');
assertEq(fs.statSync(manifestPath).size, expectedManifestSize, 'R41 manifest size');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assertEq(manifest.tag, tag, 'R41 manifest tag');
assertEq(manifest.version, expectedVersion, 'R41 manifest version');
assertEq(manifest.installer, installerName, 'R41 manifest installer');
assertEq(String(manifest.installerSha256 || '').toLowerCase(), expectedInstallerSha, 'R41 manifest installer SHA256');
assertEq(Number(manifest.installerSize), expectedInstallerSize, 'R41 manifest installer size');
assertEq(manifest.electron, electronVersion, 'R41 manifest Electron version');
for (const flag of ['r41PreflightQualified','r41LiveNativeHandoffRuntimeQualified','r41R37ProtectedE2EQualified','r41R40CallbackPacingRequalified','r41R40SubtitleOverlayRequalified','r41R39TopmostRequalified']) {
  if (manifest[flag] !== true) throw new Error(`R41 release manifest missing qualification flag ${flag}`);
}

const sevenZipCandidates = [
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, '7-Zip', '7z.exe') : null,
  process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe') : null,
  '7z.exe'
].filter(Boolean);
let sevenZip = sevenZipCandidates.find(candidate => candidate === '7z.exe' || fs.existsSync(candidate));
if (!sevenZip) throw new Error('7-Zip executable not found');

run(sevenZip, ['x', installer, `-o${outerDir}`, '-y', '-bb0'], 'extract R41 NSIS installer');
let appArchive = findFile(outerDir, name => /^app-(?:64|x64)\.7z$/i.test(name));
let appAsar = null;
if (appArchive) {
  run(sevenZip, ['x', appArchive, `-o${payloadDir}`, '-y', '-bb0'], 'extract R41 embedded app package');
  appAsar = findFile(payloadDir, name => name.toLowerCase() === 'app.asar');
} else {
  appAsar = findFile(outerDir, name => name.toLowerCase() === 'app.asar');
}
if (!appAsar) throw new Error('R41 installer extraction did not expose resources/app.asar');
const resourcesDir = path.dirname(appAsar);
const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
if (!fs.existsSync(unpackedDir)) throw new Error('R41 installer extraction missing app.asar.unpacked');

asar.extractAll(appAsar, asarDir);
for (const required of ['package.json', 'electron', 'src']) {
  if (!fs.existsSync(path.join(asarDir, required))) throw new Error(`R41 shipped app.asar missing ${required}`);
}
const shippedPkg = JSON.parse(fs.readFileSync(path.join(asarDir, 'package.json'), 'utf8'));
assertEq(shippedPkg.version, expectedVersion, 'R41 shipped package version');
assertEq(shippedPkg.lilacCustomTag, tag, 'R41 shipped custom tag');

fs.rmSync(path.join(root, 'electron'), { recursive: true, force: true });
fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
copyTree(path.join(asarDir, 'electron'), path.join(root, 'electron'));
copyTree(path.join(asarDir, 'src'), path.join(root, 'src'));

// Copy every shipped unpacked file over the working tree. This preserves the exact
// R41 native addon/DLL/ffmpeg bytes rather than rebuilding historical native code.
copyTree(unpackedDir, root);
const unpackedFiles = walkFiles(unpackedDir).map(file => norm(path.relative(unpackedDir, file)));

const build = JSON.parse(JSON.stringify(checkoutPkg.build || {}));
build.appId = env('STABLE_APP_ID');
build.productName = env('STABLE_PRODUCT_NAME');
build.electronVersion = electronVersion;
build.directories = { ...(build.directories || {}), output: 'dist' };
build.files = Array.isArray(build.files) && build.files.length ? build.files : ['electron/**/*','src/**/*','build/icon.png','build/icon.ico','package.json'];
build.win = {
  ...(build.win || {}),
  target: 'nsis',
  icon: (build.win && build.win.icon) || 'build/icon.ico',
  executableName: env('STABLE_EXE_BASE'),
  artifactName: 'LilacAnime-Libmpv-R41-Setup.${ext}'
};
build.nsis = {
  ...(build.nsis || {}),
  shortcutName: env('STABLE_SHORTCUT_NAME'),
  uninstallDisplayName: env('STABLE_SHORTCUT_NAME'),
  deleteAppDataOnUninstall: false
};
const unpackPatterns = new Set(Array.isArray(build.asarUnpack) ? build.asarUnpack.map(norm) : []);
for (const relative of unpackedFiles) unpackPatterns.add(relative);
build.asarUnpack = [...unpackPatterns].sort();

const reconstructedPkg = {
  ...shippedPkg,
  scripts: shippedPkg.scripts || checkoutPkg.scripts,
  devDependencies: shippedPkg.devDependencies || checkoutPkg.devDependencies,
  dependencies: shippedPkg.dependencies || checkoutPkg.dependencies,
  build
};
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(reconstructedPkg, null, 2) + '\n', 'utf8');

const updater = path.join(root, 'electron', 'updater.cjs');
const addon = path.join(root, 'electron', 'lilac-libmpv-player-bridge.node');
const dll = path.join(root, 'electron', 'libmpv-2.dll');
for (const file of [updater, addon, dll]) if (!fs.existsSync(file)) throw new Error(`R41 reconstructed protected file missing ${file}`);
if (manifest.updaterSha256) assertEq(sha256(updater), String(manifest.updaterSha256).toLowerCase(), 'R41 shipped updater hash');
if (manifest.nativeAddon) assertEq(sha256(addon), String(manifest.nativeAddon).toLowerCase(), 'R41 shipped native addon hash');
if (manifest.nativeDll) assertEq(sha256(dll), String(manifest.nativeDll).toLowerCase(), 'R41 shipped native DLL hash');
if (process.env.QUALIFIED_DLL_SHA256) assertEq(sha256(dll), process.env.QUALIFIED_DLL_SHA256.toLowerCase(), 'R41 qualified DLL pin');

const focusedPreload = fs.readFileSync(path.join(root, 'electron', 'libmpv-shared-preload.cjs'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'electron', 'libmpv-shared-main.cjs'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const overlay = fs.readFileSync(path.join(root, 'electron', 'r40-subtitle-overlay-window.cjs'), 'utf8');
for (const [text, marker, label] of [
  [focusedPreload, 'LILAC_R41_VISUAL_HANDOFF_COMMIT', 'focused preload'],
  [bridge, 'r41HandoffPlaying', 'R41 bridge'],
  [main, 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', 'R40 main'],
  [overlay, 'LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY', 'R40 overlay']
]) {
  if (!text.includes(marker)) throw new Error(`R41 reconstructed ${label} missing ${marker}`);
}
for (const bad of ['copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition']) {
  if (focusedPreload.includes(bad) || bridge.includes(bad)) throw new Error(`R41 reconstructed baseline contains forbidden path ${bad}`);
}

const finalPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assertEq(finalPkg.version, expectedVersion, 'R41 reconstructed version');
assertEq(finalPkg.lilacCustomTag, tag, 'R41 reconstructed custom tag');
assertEq(finalPkg.build.appId, env('STABLE_APP_ID'), 'R41 reconstructed appId');
assertEq(finalPkg.build.productName, env('STABLE_PRODUCT_NAME'), 'R41 reconstructed productName');
assertEq(finalPkg.build.win.executableName, env('STABLE_EXE_BASE'), 'R41 reconstructed executableName');

console.log(`R42_R41_RELEASE_BASELINE_OK tag=${tag} installerSha256=${expectedInstallerSha} installerSize=${expectedInstallerSize} manifestSha256=${expectedManifestSha} electron=${electronVersion} updater=${sha256(updater)} addon=${sha256(addon)} dll=${sha256(dll)} unpackedFiles=${unpackedFiles.length}`);

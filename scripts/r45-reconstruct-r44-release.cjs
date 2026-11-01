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
const walk = dir => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};
const find = (dir, pred) => walk(dir).filter(file => pred(path.basename(file), file)).sort((a,b)=>a.length-b.length || a.localeCompare(b))[0] || null;
const copyTree = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive:true }); fs.cpSync(from, to, { recursive:true, force:true }); };
const eq = (actual, expected, label) => { if (String(actual) !== String(expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`); };

const tag = env('R44_RELEASE_TAG');
const installerName = env('R44_INSTALLER_NAME');
const manifestName = env('R44_MANIFEST_NAME');
const installerSha = env('R44_INSTALLER_SHA256').toLowerCase();
const installerSize = Number(env('R44_INSTALLER_SIZE'));
const manifestSha = env('R44_MANIFEST_SHA256').toLowerCase();
const manifestSize = Number(env('R44_MANIFEST_SIZE'));
const version = env('R44_APP_VERSION');
const electronVersion = env('ELECTRON_VERSION');
const repo = env('GITHUB_REPOSITORY');
const checkoutPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r45-r44-release-'));
const download = path.join(work, 'download');
const outer = path.join(work, 'outer');
const payload = path.join(work, 'payload');
const extracted = path.join(work, 'asar');
for (const dir of [download, outer, payload, extracted]) fs.mkdirSync(dir, { recursive:true });

run('gh', ['release','download',tag,'--repo',repo,'--dir',download,'--pattern',installerName,'--pattern',manifestName], 'download pinned R44 release');
const installer = path.join(download, installerName);
const manifestPath = path.join(download, manifestName);
for (const file of [installer, manifestPath]) if (!fs.existsSync(file)) throw new Error(`R44 release asset missing ${file}`);
eq(sha256(installer), installerSha, 'R44 installer SHA256');
eq(fs.statSync(installer).size, installerSize, 'R44 installer size');
eq(sha256(manifestPath), manifestSha, 'R44 manifest SHA256');
eq(fs.statSync(manifestPath).size, manifestSize, 'R44 manifest size');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
eq(manifest.tag, tag, 'R44 manifest tag');
eq(manifest.version, version, 'R44 manifest version');
eq(String(manifest.installerSha256 || '').toLowerCase(), installerSha, 'R44 manifest installer SHA256');
eq(Number(manifest.installerSize), installerSize, 'R44 manifest installer size');
eq(manifest.electron, electronVersion, 'R44 manifest Electron version');
for (const flag of ['r44PreflightQualified','r44ConcurrentEnsureQualified','r44PrewarmedFirstCueRuntimeQualified','r44R41LiveHandoffRequalified','r44ProtectedVideoPipelineBytesQualified']) {
  if (manifest[flag] !== true) throw new Error(`R44 manifest missing qualification flag ${flag}`);
}

const candidates = [
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, '7-Zip', '7z.exe') : null,
  process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe') : null,
  '7z.exe'
].filter(Boolean);
const sevenZip = candidates.find(candidate => candidate === '7z.exe' || fs.existsSync(candidate));
if (!sevenZip) throw new Error('7-Zip executable not found');
run(sevenZip, ['x',installer,`-o${outer}`,'-y','-bb0'], 'extract R44 NSIS installer');
const appArchive = find(outer, name => /^app-(?:64|x64)\.7z$/i.test(name));
let appAsar = null;
if (appArchive) {
  run(sevenZip, ['x',appArchive,`-o${payload}`,'-y','-bb0'], 'extract R44 embedded app package');
  appAsar = find(payload, name => name.toLowerCase() === 'app.asar');
} else appAsar = find(outer, name => name.toLowerCase() === 'app.asar');
if (!appAsar) throw new Error('R44 installer extraction did not expose app.asar');
const resources = path.dirname(appAsar);
const unpacked = path.join(resources, 'app.asar.unpacked');
if (!fs.existsSync(unpacked)) throw new Error('R44 installer extraction missing app.asar.unpacked');
asar.extractAll(appAsar, extracted);
for (const required of ['package.json','electron','src']) if (!fs.existsSync(path.join(extracted, required))) throw new Error(`R44 app.asar missing ${required}`);
const shippedPkg = JSON.parse(fs.readFileSync(path.join(extracted,'package.json'),'utf8'));
eq(shippedPkg.version, version, 'R44 shipped package version');
eq(shippedPkg.lilacCustomTag, tag, 'R44 shipped custom tag');

fs.rmSync(path.join(root,'electron'), { recursive:true, force:true });
fs.rmSync(path.join(root,'src'), { recursive:true, force:true });
copyTree(path.join(extracted,'electron'), path.join(root,'electron'));
copyTree(path.join(extracted,'src'), path.join(root,'src'));
copyTree(unpacked, root);
const unpackedFiles = walk(unpacked).map(file => norm(path.relative(unpacked, file))).sort();

// electron-builder strips build metadata from the packaged app package.json. Rebuild
// only packaging metadata from the checked-in build template, but preserve the exact
// shipped R44 product identity/content and every app.asar.unpacked path. This makes
// the same reconstruction usable for qualification and a later R45 NSIS build.
const build = JSON.parse(JSON.stringify(checkoutPkg.build || {}));
build.appId = env('STABLE_APP_ID');
build.productName = env('STABLE_PRODUCT_NAME');
build.electronVersion = electronVersion;
build.directories = { ...(build.directories || {}), output: 'dist' };
build.files = Array.isArray(build.files) && build.files.length
  ? build.files
  : ['electron/**/*','src/**/*','build/icon.png','build/icon.ico','package.json'];
build.win = {
  ...(build.win || {}),
  target: 'nsis',
  icon: (build.win && build.win.icon) || 'build/icon.ico',
  executableName: env('STABLE_EXE_BASE'),
  artifactName: 'LilacAnime-Libmpv-R44-Setup.${ext}'
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
  scripts: checkoutPkg.scripts || shippedPkg.scripts,
  dependencies: checkoutPkg.dependencies || shippedPkg.dependencies,
  devDependencies: checkoutPkg.devDependencies || shippedPkg.devDependencies,
  build
};
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(reconstructedPkg, null, 2) + '\n', 'utf8');

for (const required of [
  'electron/libmpv-shared-main.cjs',
  'electron/libmpv-shared-preload.cjs',
  'electron/preload-libmpv-shared.generated.cjs',
  'electron/lilac-libmpv-player-bridge.node',
  'electron/libmpv-2.dll',
  'src/libmpv-shared.generated.js'
]) if (!fs.existsSync(path.join(root, required))) throw new Error(`R44 reconstructed runtime missing ${required}`);

const overlay = fs.readFileSync(path.join(root,'electron','r40-subtitle-overlay-window.cjs'),'utf8');
for (const marker of [
  'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND',
  'LILAC_R44_PREWARMED_SUBTITLE_OVERLAY',
  'reveal-visible-reanchored',
  'first-active-session-reanchor-opacity-zero'
]) {
  if (!overlay.includes(marker)) throw new Error(`R44 reconstructed overlay missing ${marker}`);
}
const preload = fs.readFileSync(path.join(root,'electron','libmpv-shared-preload.cjs'),'utf8');
const bridge = fs.readFileSync(path.join(root,'electron','libmpv-shared-main.cjs'),'utf8');
if (!preload.includes('LILAC_R41_VISUAL_HANDOFF_COMMIT') || !bridge.includes('r41HandoffPlaying')) throw new Error('R44 reconstructed protected R41 handoff markers missing');
for (const bad of ['copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition']) {
  if (preload.includes(bad) || bridge.includes(bad)) throw new Error(`R44 reconstructed baseline contains forbidden path ${bad}`);
}

const finalPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
eq(finalPkg.version, version, 'R44 reconstructed package version');
eq(finalPkg.lilacCustomTag, tag, 'R44 reconstructed package tag');
eq(finalPkg.build.appId, env('STABLE_APP_ID'), 'R44 reconstructed appId');
eq(finalPkg.build.productName, env('STABLE_PRODUCT_NAME'), 'R44 reconstructed productName');
eq(finalPkg.build.win.executableName, env('STABLE_EXE_BASE'), 'R44 reconstructed executableName');
eq(finalPkg.build.nsis.shortcutName, env('STABLE_SHORTCUT_NAME'), 'R44 reconstructed shortcutName');

console.log(`R45_R44_RELEASE_BASELINE_OK tag=${tag} version=${version} installerSha256=${installerSha} manifestSha256=${manifestSha} unpackedFiles=${unpackedFiles.length} packageIdentity=stable-reconstructed`);

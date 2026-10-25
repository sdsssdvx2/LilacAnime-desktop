const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = process.cwd();
const UPSTREAM_SHA = 'e4ac62214f5c4863eebae5052633e7f9f33dcbaa';
const LEGACY_TEST_SHA = '1d983e1d68e388bfd57abd3c6772d2e037d72dcd';
const UPSTREAM_REPO = 'https://github.com/whispelyn-byte/LilacAnime-desktop.git';

function run(command, args, options = {}) {
  console.log(`R3F_RUN=${command} ${args.join(' ')}`);
  cp.execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
}
function capture(command, args, options = {}) {
  return cp.execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options }).trim();
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'); }
function write(rel, value) { fs.writeFileSync(path.join(ROOT, rel), value, 'utf8'); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function replaceOnce(src, oldText, newText, label) {
  const count = src.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return src.replace(oldText, newText);
}
function walkFiles(base) {
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function copyTree(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function assemble0554() {
  run('git', ['checkout', '--detach', LEGACY_TEST_SHA]);
  if (capture('git', ['rev-parse', 'HEAD']) !== LEGACY_TEST_SHA) throw new Error('legacy tooling pin mismatch');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3f-'));
  const upstream = path.join(temp, 'upstream-0554');
  const custom = path.join(temp, 'custom-only');
  run('git', ['clone', '--depth', '1', '--branch', 'v0.5.54', UPSTREAM_REPO, upstream]);
  if (capture('git', ['-C', upstream, 'rev-parse', 'HEAD']) !== UPSTREAM_SHA) throw new Error('upstream 0.5.54 SHA mismatch');

  for (const area of ['electron', 'src']) {
    const legacyBase = path.join(ROOT, area);
    const upstreamBase = path.join(upstream, area);
    for (const file of walkFiles(legacyBase)) {
      const rel = path.relative(legacyBase, file);
      if (!fs.existsSync(path.join(upstreamBase, rel))) {
        const dest = path.join(custom, area, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(file, dest);
        console.log(`R3F_CUSTOM_ONLY=${area}/${rel.replace(/\\/g, '/')}`);
      }
    }
  }

  copyTree(path.join(upstream, 'electron'), path.join(ROOT, 'electron'));
  copyTree(path.join(upstream, 'src'), path.join(ROOT, 'src'));
  copyTree(path.join(upstream, 'tests'), path.join(ROOT, 'tests'));
  for (const area of ['electron', 'src']) {
    const saved = path.join(custom, area);
    if (fs.existsSync(saved)) fs.cpSync(saved, path.join(ROOT, area), { recursive: true, force: true });
  }
  for (const rel of ['package.json', 'package-lock.json', 'scripts/anime4k-entry.mjs']) {
    fs.copyFileSync(path.join(upstream, rel), path.join(ROOT, rel));
  }

  for (const rel of ['electron/main.cjs','electron/preload.cjs','electron/updater.cjs','electron/miruro-browser.cjs','src/app.js','src/player.js','src/index.html','src/player-android.css']) {
    if (sha256(path.join(ROOT, rel)) !== sha256(path.join(upstream, rel))) throw new Error(`upstream surface changed during assembly: ${rel}`);
  }
  const pkg = JSON.parse(read('package.json'));
  if (pkg.version !== '0.5.54') throw new Error(`assembled package is not upstream 0.5.54: ${pkg.version}`);
  const combined = read('src/app.js') + read('src/player.js') + read('src/index.html');
  for (const marker of ['playerSeekHint','controlsOnPlaying','showSeekHint']) if (!combined.includes(marker)) throw new Error(`0.5.54 player marker missing: ${marker}`);
  if (fs.existsSync(path.join(ROOT, 'electron/miruro-session.cjs'))) throw new Error('obsolete Miruro session file survived assembly');
  if (!fs.existsSync(path.join(ROOT, 'electron/miruro-browser.cjs'))) throw new Error('0.5.54 Miruro browser missing');
  for (const rel of ['electron/libmpv-shared-main.cjs','electron/libmpv-shared-preload.cjs','src/libmpv-shared-entry.js']) if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`custom libmpv file missing after assembly: ${rel}`);
  console.log(`R3F_0554_ASSEMBLY_OK upstream=${UPSTREAM_SHA} nativeTooling=${LEGACY_TEST_SHA}`);
}

function prepareTransforms() {
  const pkg = JSON.parse(read('package.json'));
  pkg.version = '0.5.49';
  write('package.json', JSON.stringify(pkg, null, 2) + '\n');

  let r2j = read('scripts/apply-libmpv-r2j-subtitle-overlay.cjs');
  const r2jCut = "let updater = read('electron/updater.cjs');";
  const r2jIndex = r2j.indexOf(r2jCut);
  if (r2jIndex < 0) throw new Error('R2J updater split anchor missing');
  r2j = r2j.slice(0, r2jIndex) + "console.log('LIBMPV_R2J_SUBTITLE_OVERLAY_OK vtt=shadow-overlay updater=deferred-r3f');\n";
  write('scripts/apply-libmpv-r2j-subtitle-overlay.cjs', r2j);

  let r2k = read('scripts/apply-libmpv-r2k-upstream-polish.cjs');
  const updaterStart = r2k.indexOf("let updater = read('electron/updater.cjs');");
  const packageStart = r2k.indexOf("const pkg = JSON.parse(read('package.json'));", updaterStart);
  if (updaterStart < 0 || packageStart <= updaterStart) throw new Error('R2K updater/package split anchors missing');
  r2k = r2k.slice(0, updaterStart) + r2k.slice(packageStart);
  write('scripts/apply-libmpv-r2k-upstream-polish.cjs', r2k);
  console.log('R3F_R2J_R2K_SPLIT_OK updaterPorts=2');
}

function applyUpdaterIsolation() {
  let u = read('electron/updater.cjs');
  u = replaceOnce(u,
    '    this.downloading = null;',
    "    this.downloading = null;\n    this.isolatedCandidate = /libmpv/i.test(String(app.getVersion?.() || '')) || /libmpv/i.test(String(app.getName?.() || ''));",
    'R3F updater identity');
  u = replaceOnce(u,
    '  async check() {',
    "  async check() {\n    if (this.isolatedCandidate) return this.set({ status: 'latest', latest: this.app.getVersion(), notes: '', url: '', isolatedChannel: true });",
    'R3F updater check');
  u = replaceOnce(u,
    '  async download() {',
    "  async download() {\n    if (this.isolatedCandidate) return this.state;",
    'R3F updater download');
  u = replaceOnce(u,
    '  install(relaunch = true) {',
    "  install(relaunch = true) {\n    if (this.isolatedCandidate) return false;",
    'R3F updater install');
  u = replaceOnce(u,
    '  installOnQuit() {',
    '  installOnQuit() { if (this.isolatedCandidate) return false;',
    'R3F updater quit');
  const notes = "  const version = this.app.getVersion(), same = value => parseVersion(value).join('.') === parseVersion(version).join('.');";
  u = replaceOnce(u, notes,
    "  const version = this.app.getVersion();\n  if (this.isolatedCandidate) return { version, notes: '', url: '' };\n  const same = value => parseVersion(value).join('.') === parseVersion(version).join('.');",
    'R3F updater notes');
  for (const marker of ['this.isolatedCandidate','isolatedChannel: true',"if (!MAC && !DEB && this.state.status === 'ready'"]) if (!u.includes(marker)) throw new Error(`R3F updater marker missing: ${marker}`);
  write('electron/updater.cjs', u);
  console.log('R3F_054_UPDATER_ISOLATION_OK preserveDEB=true');
}

function applyCustomUpdater() {
  let u = read('electron/updater.cjs');
  const constants = [
    'const RELEASE_API = `${RELEASES}/latest`;',
    "const CUSTOM_RELEASES_API = 'https://api.github.com/repos/sdsssdvx2/LilacAnime-desktop/releases?per_page=100';",
    'const CUSTOM_TAG_RE = /^libmpv-r2k-v(\\d+)\\.(\\d+)\\.(\\d+)-r(\\d+)$/i;',
    "const CUSTOM_CURRENT_TAG = String(require('../package.json').lilacCustomTag || '');",
    "function customParts(value = '') { const match = CUSTOM_TAG_RE.exec(String(value)); return match ? match.slice(1).map(Number) : null; }",
    'function compareCustom(a, b) { const x = customParts(a), y = customParts(b); if (!x) return -1; if (!y) return 1; for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }'
  ].join('\n');
  u = replaceOnce(u, 'const RELEASE_API = `${RELEASES}/latest`;', constants, 'R3F custom updater constants');
  const checkOld = "  async check() {\n    if (this.isolatedCandidate) return this.set({ status: 'latest', latest: this.app.getVersion(), notes: '', url: '', isolatedChannel: true });";
  const checkNew = [
    '  async checkCustom() {',
    "    this.set({ status: 'checking', error: null, customChannel: true });",
    '    try {',
    "      const response = await fetch(CUSTOM_RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LilacAnime-Libmpv/${this.app.getVersion()}` } });",
    '      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);',
    '      const releases = (await response.json()).filter(item => !item.draft && customParts(item.tag_name));',
    '      releases.sort((a, b) => compareCustom(b.tag_name, a.tag_name));',
    '      const release = releases[0];',
    "      if (!release || !CUSTOM_CURRENT_TAG || compareCustom(release.tag_name, CUSTOM_CURRENT_TAG) <= 0) return this.set({ status: 'latest', latest: this.app.getVersion(), notes: '', url: release?.html_url || '', customChannel: true, customTag: CUSTOM_CURRENT_TAG });",
    '      const asset = installerAsset(release.assets || []);',
    "      if (!asset) throw new Error('커스텀 릴리스에 이 플랫폼용 설치 파일이 없습니다.');",
    '      this.asset = asset;',
    "      this.set({ status: 'available', latest: String(release.tag_name), notes: String(release.body || '').slice(0, 20000), url: release.html_url || '', size: Number(asset.size) || 0, customChannel: true, customTag: String(release.tag_name) });",
    '      this.download();',
    '      return this.state;',
    "    } catch (error) { return this.set({ status: 'error', error: error.message || '커스텀 업데이트 확인 실패', customChannel: true }); }",
    '  }',
    '',
    '  async check() {',
    '    if (this.isolatedCandidate) return this.checkCustom();'
  ].join('\n');
  u = replaceOnce(u, checkOld, checkNew, 'R3F custom updater check');
  u = replaceOnce(u, "  async download() {\n    if (this.isolatedCandidate) return this.state;", '  async download() {', 'R3F allow custom download');
  u = replaceOnce(u, "  install(relaunch = true) {\n    if (this.isolatedCandidate) return false;", '  install(relaunch = true) {', 'R3F allow custom install');
  u = replaceOnce(u, '  installOnQuit() { if (this.isolatedCandidate) return false; if (!MAC && !DEB', '  installOnQuit() { if (!MAC && !DEB', 'R3F allow custom install on quit');
  u = replaceOnce(u,
    "  if (this.isolatedCandidate) return { version, notes: '', url: '' };\n  const same = value => parseVersion(value).join('.') === parseVersion(version).join('.');",
    "  const same = value => parseVersion(value).join('.') === parseVersion(version).join('.');",
    'R3F custom notes fallback');
  for (const marker of ['CUSTOM_RELEASES_API','checkCustom()','CUSTOM_CURRENT_TAG',"!MAC && !DEB && this.state.status === 'ready'"]) if (!u.includes(marker)) throw new Error(`R3F custom updater marker missing: ${marker}`);
  write('electron/updater.cjs', u);
  console.log('R3F_054_CUSTOM_UPDATER_OK preservePlatformInstall=true');
}

function guard0554() {
  const combined = read('src/app.js') + read('src/player.js') + read('src/index.html');
  for (const marker of ['playerSeekHint','controlsOnPlaying','showSeekHint']) if (!combined.includes(marker)) throw new Error(`compatible prefix erased upstream player feature: ${marker}`);
  if (fs.existsSync(path.join(ROOT, 'electron/miruro-session.cjs'))) throw new Error('compatible prefix resurrected obsolete Miruro verification implementation');
  if (!fs.existsSync(path.join(ROOT, 'electron/miruro-browser.cjs'))) throw new Error('compatible prefix removed Miruro browser transport');
  const updater = read('electron/updater.cjs');
  for (const marker of ["!MAC && !DEB && this.state.status === 'ready'",'CUSTOM_RELEASES_API','checkCustom()']) if (!updater.includes(marker)) throw new Error(`0.5.54 updater semantic marker missing: ${marker}`);
  console.log('R3F_0554_UPSTREAM_FEATURE_GUARD_OK');
}

function main() {
  assemble0554();
  run('npm.cmd', ['ci', '--no-audit', '--no-fund']);
  run('npm.cmd', ['install', '--no-save', '--no-audit', '--no-fund', '@electron/asar@3.2.18', 'node-gyp@12.2.0']);
  prepareTransforms();

  const scripts = [
    'scripts/apply-libmpv-d2-diagnostics.cjs',
    'scripts/apply-libmpv-r2-runtime-fixes.cjs',
    'scripts/apply-libmpv-r2b-command-import-diagnostics.cjs',
    'scripts/apply-libmpv-r2c-texture-pool.cjs',
    'scripts/apply-libmpv-r2f-immediate-frame-lifetime.cjs',
    'scripts/apply-libmpv-r2g-electron44-releasefix.cjs',
    'scripts/apply-libmpv-r2h-webgpu-copy.cjs',
    'scripts/apply-libmpv-r2i-pipeline-headroom.cjs',
    'scripts/apply-libmpv-r2h-bundle-marker-fix.cjs',
    'scripts/apply-libmpv-r2j-subtitle-overlay.cjs',
    'scripts/apply-libmpv-r2k-upstream-polish.cjs',
    'scripts/apply-libmpv-r2l-player-polish.cjs',
    'scripts/apply-libmpv-r2m-open-race-key-ui.cjs'
  ];
  const passed = [];
  for (const script of scripts) {
    console.log(`R3F_PROBE_START=${script}`);
    try {
      run(process.execPath, ['--check', script]);
      run(process.execPath, [script]);
    } catch (error) {
      console.error(`R3F_FIRST_CONFLICT=${script}`);
      console.error(`R3F_PASSED_PREFIX=${passed.join(',')}`);
      throw error;
    }
    if (script.endsWith('apply-libmpv-r2j-subtitle-overlay.cjs')) applyUpdaterIsolation();
    if (script.endsWith('apply-libmpv-r2k-upstream-polish.cjs')) applyCustomUpdater();
    passed.push(script);
    console.log(`R3F_PROBE_OK=${script}`);
  }
  console.log(`R3F_PREFIX_ALL_OK=${passed.length}`);
  guard0554();
}

main();

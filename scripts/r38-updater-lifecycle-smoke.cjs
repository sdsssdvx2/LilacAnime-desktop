'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read('package.json'));
const main = read('electron/main.cjs');
const updaterSource = read('electron/updater.cjs');
const expectedTag = String(process.env.RELEASE_TAG || pkg.lilacCustomTag || '');
const expectedVersion = String(process.env.APP_VERSION || pkg.version || '');

if (!/^libmpv-r2k-v\d+\.\d+\.\d+-r\d+$/i.test(expectedTag)) throw new Error(`R38 expected release tag invalid: ${expectedTag}`);
if (pkg.lilacCustomTag !== expectedTag) throw new Error(`R38 package custom tag mismatch: package=${pkg.lilacCustomTag} expected=${expectedTag}`);
if (pkg.version !== expectedVersion) throw new Error(`R38 package version mismatch: package=${pkg.version} expected=${expectedVersion}`);

for (const marker of [
  'LILAC_R38_UPDATE_ACTIVITY_CHECK',
  'R38_UPDATE_ACTIVITY_CHECK_COOLDOWN_MS = 2 * 60 * 1000',
  "r38InstallReadyUpdateOnReveal('second-instance')",
  "r38CheckUpdaterOnActivity('second-instance')",
  "r38CheckUpdaterOnActivity('window-focus')",
  "r38InstallReadyUpdateOnReveal('tray-show')",
  "r38CheckUpdaterOnActivity('tray-show')",
  "r38CheckUpdaterOnActivity('startup')",
  "r38CheckUpdaterOnActivity('periodic')"
]) {
  if (!main.includes(marker)) throw new Error(`R38 main lifecycle marker missing: ${marker}`);
}
if (!main.includes("updater?.installOnQuit()")) throw new Error('R38 lost normal quit-time updater installation');
if (main.includes('setTimeout(()=>updater.check(),5000)')) throw new Error('R38 retained the old startup-only check call');

for (const marker of ['CUSTOM_RELEASES_API', 'CUSTOM_CURRENT_TAG', 'CUSTOM_TAG_RE', 'compareCustom', 'async checkCustom()', 'this.download()']) {
  if (!updaterSource.includes(marker)) throw new Error(`R38 packaged custom updater marker missing: ${marker}`);
}
if (!updaterSource.includes("installOnQuit() { if (!MAC && this.state.status === 'ready'")) {
  throw new Error('R38 custom updater no longer installs a ready Windows update on clean quit');
}

function loadActualUpdater(fetchImpl) {
  const module = { exports: {} };
  const electronMock = { shell: { openPath: async () => '' } };
  const customRequire = id => {
    if (id === 'electron') return electronMock;
    if (id === '../package.json') return pkg;
    return require(id);
  };
  const context = vm.createContext({
    console,
    process,
    Buffer,
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl
  });
  const wrapper = new vm.Script(`(function(require,module,exports,__filename,__dirname){${updaterSource}\n})`, { filename: path.join(root, 'electron/updater.cjs') });
  wrapper.runInContext(context)(customRequire, module, module.exports, path.join(root, 'electron/updater.cjs'), path.join(root, 'electron'));
  return module.exports;
}

function tagParts(tag) {
  const match = /^libmpv-r2k-v(\d+)\.(\d+)\.(\d+)-r(\d+)$/i.exec(tag);
  if (!match) throw new Error(`cannot parse test tag: ${tag}`);
  return match.slice(1).map(Number);
}
const parts = tagParts(expectedTag);
const nextTag = `libmpv-r2k-v${parts[0]}.${parts[1]}.${parts[2]}-r${parts[3] + 1}`;
const oldTag = `libmpv-r2k-v${parts[0]}.${parts[1]}.${parts[2]}-r${Math.max(1, parts[3] - 1)}`;
const setupAsset = tag => ({
  name: `LilacAnime-Libmpv-${tag.split('-r').pop()}-Setup.exe`,
  browser_download_url: `https://example.invalid/${encodeURIComponent(tag)}.exe`,
  size: 123456
});

async function runAvailableCase() {
  const requested = [];
  const fetchImpl = async url => {
    requested.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => [
        { tag_name: oldTag, draft: false, prerelease: true, html_url: 'https://example.invalid/old', assets: [setupAsset(oldTag)] },
        { tag_name: nextTag, draft: false, prerelease: true, html_url: 'https://example.invalid/new', assets: [setupAsset(nextTag)] },
        { tag_name: expectedTag, draft: false, prerelease: true, html_url: 'https://example.invalid/current', assets: [setupAsset(expectedTag)] }
      ]
    };
  };
  const { Updater } = loadActualUpdater(fetchImpl);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r38-updater-'));
  const states = [];
  const app = {
    getVersion: () => pkg.version,
    getName: () => pkg.build?.productName || 'LilacAnime Libmpv',
    getPath: name => name === 'userData' ? tmp : tmp,
    relaunch() {},
    quit() {}
  };
  const updater = new Updater({ app, broadcast: (_channel, value) => states.push({ ...value }) });
  if (!updater.isolatedCandidate) throw new Error('R38 actual updater did not recognize libmpv custom channel');
  let downloadCalls = 0;
  updater.download = async function fakeDownload() {
    downloadCalls += 1;
    return this.set({ status: 'ready', percent: 100 });
  };
  const state = await updater.check();
  if (requested.length !== 1 || !requested[0].includes('/sdsssdvx2/LilacAnime-desktop/releases?per_page=100')) {
    throw new Error(`R38 actual updater used wrong release API: ${requested.join(',')}`);
  }
  if (downloadCalls !== 1) throw new Error(`R38 actual updater did not auto-start exactly one download: ${downloadCalls}`);
  if (state.status !== 'ready' || state.latest !== nextTag || state.customTag !== nextTag) {
    throw new Error(`R38 actual updater did not select newest custom release: ${JSON.stringify(state)}`);
  }
  if (!updater.asset || !/setup/i.test(updater.asset.name) || !/\.exe$/i.test(updater.asset.name)) {
    throw new Error('R38 actual updater did not select the Windows setup asset');
  }
  return states.length;
}

async function runLatestCase() {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { tag_name: expectedTag, draft: false, prerelease: true, html_url: 'https://example.invalid/current', assets: [setupAsset(expectedTag)] },
      { tag_name: oldTag, draft: false, prerelease: true, html_url: 'https://example.invalid/old', assets: [setupAsset(oldTag)] }
    ]
  });
  const { Updater } = loadActualUpdater(fetchImpl);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r38-latest-'));
  const app = {
    getVersion: () => pkg.version,
    getName: () => pkg.build?.productName || 'LilacAnime Libmpv',
    getPath: () => tmp,
    relaunch() {},
    quit() {}
  };
  const updater = new Updater({ app, broadcast() {} });
  updater.download = async () => { throw new Error('download must not run when current custom tag is latest'); };
  const state = await updater.check();
  if (state.status !== 'latest' || state.customTag !== expectedTag) {
    throw new Error(`R38 actual updater failed latest/current-tag case: ${JSON.stringify(state)}`);
  }
}

(async () => {
  const transitionCount = await runAvailableCase();
  await runLatestCase();
  console.log(`R38_UPDATER_LIFECYCLE_SMOKE_OK tag=${expectedTag} version=${expectedVersion} actualUpdater=1 newestSelection=1 autoDownload=1 latestCase=1 startup=5s activity=second-instance+tray-show+focus readyInstall=before-reveal normalQuitInstall=preserved stateTransitions=${transitionCount}`);
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});

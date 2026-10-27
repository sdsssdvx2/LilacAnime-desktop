'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const pkg = JSON.parse(read('package.json'));
const expectedTag = String(process.env.RELEASE_TAG || '');
assert(/^libmpv-r2k-v\d+\.\d+\.\d+-r\d+$/i.test(expectedTag), `invalid RELEASE_TAG ${expectedTag}`);
assert(pkg.lilacCustomTag === expectedTag, `package custom tag mismatch: ${pkg.lilacCustomTag} != ${expectedTag}`);

const updaterSource = read('electron/updater.cjs');
const mainSource = read('electron/main.cjs');
for (const marker of ['LILAC_R38_CUSTOM_UPDATE_CHANNEL', 'discoverCustomReleaseFromHtml', 'CUSTOM_RELEASES_HTML', 'void this.download();']) {
  assert(updaterSource.includes(marker), `updater source missing ${marker}`);
}
for (const marker of ['LILAC_R38_UPDATER_STARTUP_RETRY', 'updaterRetryTimer', '60*1000', 'setTimeout(()=>{void checkForUpdates()},5000)']) {
  assert(mainSource.includes(marker), `main startup updater missing ${marker}`);
}
assert(mainSource.includes("app.on('before-quit'"), 'before-quit hook missing');
assert(mainSource.includes('updater?.installOnQuit()'), 'install-on-quit wiring missing');
assert(!updaterSource.includes('if (this.isolatedCandidate) return false;\n    if (!this.installer'), 'custom install was re-isolated');
assert(!updaterSource.includes('if (this.isolatedCandidate) return this.state;\n    if (this.state.status === \'ready\')'), 'custom download was re-isolated');

const originalLoad = Module._load;
const originalFetch = global.fetch;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { shell: { openPath: async () => '' } };
  return originalLoad.call(this, request, parent, isMain);
};

function response({ status = 200, json = null, text = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => json,
    text: async () => text
  };
}

function appFixture() {
  return {
    getVersion: () => String(pkg.version || ''),
    getName: () => 'LilacAnime Libmpv',
    getPath: () => path.join(root, '.r38-updater-smoke-temp'),
    quit: () => {},
    relaunch: () => {}
  };
}

(async () => {
  try {
    delete require.cache[require.resolve(path.join(root, 'electron', 'updater.cjs'))];
    const { Updater } = require(path.join(root, 'electron', 'updater.cjs'));

    // Case 1: the API says this release is current. No download must start.
    let downloadCalls = 0;
    global.fetch = async url => {
      const value = String(url);
      if (value.includes('api.github.com')) {
        return response({ json: [{
          draft: false,
          tag_name: expectedTag,
          html_url: `https://github.com/sdsssdvx2/LilacAnime-desktop/releases/tag/${expectedTag}`,
          body: 'current',
          assets: [{ name: 'LilacAnime-Libmpv-current-Setup.exe', browser_download_url: 'https://example.invalid/current.exe', size: 123 }]
        }] });
      }
      throw new Error(`unexpected current-case URL ${value}`);
    };
    const current = new Updater({ app: appFixture(), broadcast: () => {} });
    current.download = async () => { downloadCalls += 1; return current.state; };
    const currentState = await current.check();
    assert(currentState.status === 'latest', `current release status=${currentState.status}`);
    assert(currentState.customTag === expectedTag, `current customTag=${currentState.customTag}`);
    assert(currentState.discovery === 'api', `current discovery=${currentState.discovery}`);
    assert(downloadCalls === 0, `current release unexpectedly downloaded ${downloadCalls} time(s)`);

    // Case 2: API is rate-limited, HTML fallback exposes one newer release and its
    // setup asset. It must become available and auto-start the background download.
    const parts = expectedTag.match(/^(libmpv-r2k-v\d+\.\d+\.\d+-r)(\d+)$/i);
    assert(parts, 'could not increment expected custom tag');
    const newerTag = `${parts[1]}${Number(parts[2]) + 1}`;
    downloadCalls = 0;
    global.fetch = async url => {
      const value = String(url);
      if (value.includes('api.github.com')) return response({ status: 403 });
      if (value.endsWith('/releases')) {
        return response({ text: `<a href="/sdsssdvx2/LilacAnime-desktop/releases/tag/${newerTag}">${newerTag}</a>` });
      }
      if (value.includes('/releases/expanded_assets/')) {
        return response({ text: `<a href="/sdsssdvx2/LilacAnime-desktop/releases/download/${newerTag}/LilacAnime-Libmpv-R39-Setup.exe">setup</a>` });
      }
      throw new Error(`unexpected fallback-case URL ${value}`);
    };
    const fallback = new Updater({ app: appFixture(), broadcast: () => {} });
    fallback.download = async () => { downloadCalls += 1; return fallback.state; };
    const fallbackState = await fallback.check();
    assert(fallbackState.status === 'available', `fallback release status=${fallbackState.status} error=${fallbackState.error || ''}`);
    assert(fallbackState.customTag === newerTag, `fallback customTag=${fallbackState.customTag}`);
    assert(fallbackState.discovery === 'html', `fallback discovery=${fallbackState.discovery}`);
    assert(/Setup\.exe$/i.test(String(fallback.asset?.name || '')), `fallback asset=${fallback.asset?.name || '<missing>'}`);
    assert(downloadCalls === 1, `fallback background download calls=${downloadCalls}`);

    console.log(`R38_UPDATER_CHANNEL_SMOKE_OK current=${expectedTag} newer=${newerTag} currentDiscovery=api fallbackDiscovery=html api403Recovered=1 backgroundDownload=1 startupRetry=60s installOnQuit=1`);
  } finally {
    global.fetch = originalFetch;
    Module._load = originalLoad;
    try { fs.rmSync(path.join(root, '.r38-updater-smoke-temp'), { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});

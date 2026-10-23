'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { Updater } = require('../electron/updater.cjs');
  const previousFetch = global.fetch;
  const calls = [];
  const current = {
    tag_name: 'libmpv-r2k-v0.5.49-r5', draft: false, prerelease: true,
    html_url: 'https://example.invalid/current', body: 'current', assets: []
  };
  const future = {
    tag_name: 'libmpv-r2k-v0.5.49-r6', draft: false, prerelease: true,
    html_url: 'https://example.invalid/future', body: 'future notes',
    assets: [{ name: 'LilacAnime-Libmpv-R2N-Setup.exe', browser_download_url: 'https://example.invalid/r6.exe', size: 1234 }]
  };
  let releases = [current];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), accept: options?.headers?.Accept || '' });
    return { ok: true, status: 200, json: async () => releases };
  };
  const states = [];
  const fakeApp = {
    getVersion: () => '0.5.49-libmpv-r2n.rc1',
    getName: () => 'LilacAnime Libmpv R2N',
    getPath: () => path.resolve(process.cwd(), '.tmp-r2n-updater-smoke'),
    quit: () => {}
  };
  try {
    const updater = new Updater({ app: fakeApp, broadcast: (_event, state) => states.push({ ...state }) });
    assert.equal(updater.isolatedCandidate, true);
    let checked = await updater.check();
    assert.equal(checked.status, 'latest');
    assert.equal(checked.customChannel, true);
    assert.equal(checked.customTag, current.tag_name);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /sdsssdvx2\/LilacAnime-desktop\/releases/i);
    releases = [future, current];
    updater.download = async () => updater.state;
    checked = await updater.check();
    assert.equal(checked.status, 'available');
    assert.equal(checked.customChannel, true);
    assert.equal(checked.customTag, future.tag_name);
    assert.equal(checked.size, 1234);
    assert.equal(updater.asset.name, 'LilacAnime-Libmpv-R2N-Setup.exe');
    assert.equal(calls.length, 2);
    console.log(`LIBMPV_R2N_UPDATER_PASS current=${current.tag_name} future=${future.tag_name} calls=${calls.length} states=${states.length}`);
  } finally {
    global.fetch = previousFetch;
  }
})().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

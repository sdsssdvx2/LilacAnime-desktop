'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { Updater } = require('../electron/updater.cjs');
  const previousFetch = global.fetch;
  const calls = [];
  const current = {
    tag_name: 'libmpv-r2k-v0.5.50-r1', draft: false, prerelease: true,
    html_url: 'https://example.invalid/current', body: 'current', assets: []
  };
  const older = {
    tag_name: 'libmpv-r2k-v0.5.49-r7', draft: false, prerelease: true,
    html_url: 'https://example.invalid/older', body: 'older', assets: []
  };
  const future = {
    tag_name: 'libmpv-r2k-v0.5.50-r2', draft: false, prerelease: true,
    html_url: 'https://example.invalid/future', body: 'future notes',
    assets: [{ name: 'LilacAnime-Libmpv-R2R-Setup.exe', browser_download_url: 'https://example.invalid/r2.exe', size: 4321 }]
  };
  let releases = [current, older];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), accept: options?.headers?.Accept || '' });
    return { ok: true, status: 200, json: async () => releases };
  };
  const states = [];
  const fakeApp = {
    getVersion: () => '0.5.50-libmpv-r2r.rc1',
    getName: () => 'LilacAnime Libmpv R2R',
    getPath: () => path.resolve(process.cwd(), '.tmp-r2r-updater-smoke'),
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
    releases = [older, future, current];
    updater.download = async () => updater.state;
    checked = await updater.check();
    assert.equal(checked.status, 'available');
    assert.equal(checked.customTag, future.tag_name);
    assert.equal(checked.size, 4321);
    assert.equal(updater.asset.name, 'LilacAnime-Libmpv-R2R-Setup.exe');
    assert.equal(calls.length, 2);
    console.log(`LIBMPV_R2R_UPDATER_PASS current=${current.tag_name} older=${older.tag_name} future=${future.tag_name} calls=${calls.length} states=${states.length}`);
  } finally {
    global.fetch = previousFetch;
  }
})().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

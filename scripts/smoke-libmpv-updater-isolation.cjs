'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Updater } = require('../electron/updater.cjs');

(async () => {
  let networkCalls = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => { networkCalls += 1; throw new Error('network must not be touched by isolated candidate updater'); };
  const states = [];
  const fakeApp = {
    getVersion: () => '0.5.37-libmpv-r2j.rc1',
    getName: () => 'LilacAnime Libmpv R2J Subtitle Fix',
    getPath: () => path.resolve(process.cwd(), '.tmp-r2j-updater-smoke'),
    quit: () => { throw new Error('isolated updater must not quit the app'); }
  };
  try {
    const updater = new Updater({ app: fakeApp, broadcast: (_event, state) => states.push({ ...state }) });
    assert.equal(updater.isolatedCandidate, true);
    const checked = await updater.check();
    assert.equal(checked.status, 'latest');
    assert.equal(checked.latest, fakeApp.getVersion());
    assert.equal(checked.isolatedChannel, true);
    updater.asset = { browser_download_url: 'https://example.invalid/stable.exe', size: 1 };
    const downloaded = await updater.download();
    assert.equal(downloaded.status, 'latest');
    updater.installer = __filename;
    assert.equal(updater.install(true), false);
    assert.equal(updater.installOnQuit(), false);
    const notes = await updater.notes();
    assert.deepEqual(notes, { version: fakeApp.getVersion(), notes: '', url: '' });
    assert.equal(networkCalls, 0);
    console.log(`LIBMPV_R2J_UPDATER_ISOLATION_PASS networkCalls=${networkCalls} states=${states.length}`);
  } finally {
    global.fetch = previousFetch;
  }
})().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const output = path.join(dir, 'r32-native-presenter.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=8',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=8',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','64k','-shortest','-movflags','+faststart',output
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0,240)}`);
  return output;
}

function hwndText(win) {
  const raw = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(raw) || raw.length < 4) throw new Error('invalid BrowserWindow HWND buffer');
  return (raw.length >= 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))).toString(10);
}

function drain(addon, id) {
  let count = 0;
  while (count < 64) {
    const frame = addon.popProducedFrame(id);
    if (!frame) break;
    addon.releaseProducedFrame(id, frame.slotId, frame.frameId);
    count += 1;
  }
  return count;
}

(async () => {
  await app.whenReady();
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('R32 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer','popProducedFrame','releaseProducedFrame','configureNativePresenter','setNativePresenterVisible','setNativePresenterBounds','nativePresenterStats','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r32-presenter-'));
  let win = null;
  let id = null;
  try {
    const media = buildFixture(dir);
    win = new BrowserWindow({ show:false, width:800, height:600, webPreferences:{ backgroundThrottling:false } });
    const created = addon.createPlayer();
    id = Number(created.playerId);
    if (!id) throw new Error('createPlayer failed');
    if (addon.setUpdateCallback(id, () => {}) !== true) throw new Error('setUpdateCallback failed');
    if (addon.configureNativePresenter(id, hwndText(win)) !== true) throw new Error('configureNativePresenter failed');
    if (addon.setNativePresenterBounds(id, 37, 29, 640, 360) !== true) throw new Error('setNativePresenterBounds failed');
    const configured = addon.nativePresenterStats(id);
    if (!configured?.configured || configured.marker !== 'LILAC_R32_NATIVE_HWND_FOCUS_SURFACE') throw new Error(`presenter configure state invalid ${JSON.stringify(configured)}`);
    if (Number(configured.x) !== 37 || Number(configured.y) !== 29 || Number(configured.boundsWidth) !== 640 || Number(configured.boundsHeight) !== 360) {
      throw new Error(`presenter bounds mismatch ${JSON.stringify(configured)}`);
    }

    addon.open(id, media);
    const loadedDeadline = Date.now() + 10000;
    while (Date.now() < loadedDeadline) {
      if (addon.pollPlayback(id)?.fileLoaded) break;
      await sleep(15);
    }
    if (!addon.pollPlayback(id)?.fileLoaded) throw new Error('presenter fixture load timeout');
    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');
    if (!addon.setNativePresenterVisible(id, true)) throw new Error('setNativePresenterVisible(true) failed');

    const deadline = Date.now() + 8000;
    let stats = null;
    while (Date.now() < deadline) {
      drain(addon, id);
      stats = addon.nativePresenterStats(id);
      if (Number(stats?.presentedFrames || 0) >= 4) break;
      await sleep(15);
    }
    stats = addon.nativePresenterStats(id);
    if (Number(stats?.presentedFrames || 0) < 4) throw new Error(`native presenter produced too few frames ${JSON.stringify(stats)}`);
    if (Number(stats?.failures || 0) !== 0) throw new Error(`native presenter failures ${JSON.stringify(stats)}`);
    if (Number(stats.x) !== 37 || Number(stats.y) !== 29 || Number(stats.boundsWidth) !== 640 || Number(stats.boundsHeight) !== 360) throw new Error(`presenter bounds drifted ${JSON.stringify(stats)}`);
    if (!(Number(stats?.maxPresentMs || 0) >= 0)) throw new Error('invalid native presenter timing');
    addon.setNativePresenterVisible(id, false);
    console.log(`R32_NATIVE_PRESENTER_SMOKE_OK frames=${stats.presentedFrames} failures=${stats.failures} bounds=37,29,640,360 avgPresentMs=${Number(stats.avgPresentMs || 0).toFixed(3)} maxPresentMs=${Number(stats.maxPresentMs || 0).toFixed(3)} deviceMode=${created.deviceMode}`);
  } finally {
    if (id != null) {
      try { addon.setNativePresenterVisible(id, false); } catch {}
      try { addon.stopFrameProducer(id); } catch {}
      try { addon.destroyPlayer(id); } catch {}
    }
    try { win?.destroy(); } catch {}
    try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    app.quit();
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
  try { app.quit(); } catch {}
});

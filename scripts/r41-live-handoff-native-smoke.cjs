'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => { console.error('R41 live handoff smoke exceeded 90s'); process.exit(124); }, 90000);

function hwndText(win) {
  const raw = win.getNativeWindowHandle();
  return (raw.length >= 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))).toString(10);
}
function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r41-live-handoff.mp4');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=24',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=24',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',out
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed ${String(r.stderr || '').slice(0,240)}`);
  return out;
}
async function waitUntil(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error(`${label} timeout`);
}

(async () => {
  await app.whenReady();
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !dllPath) throw new Error('R41 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer','configureNativePresenter','setNativePresenterBounds','setNativePresenterVisible','setNativePresenterMirrorChromium','nativePresenterStats','popProducedFrame','releaseProducedFrame','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing ${name}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r41-live-'));
  let win, id;
  try {
    win = new BrowserWindow({ show:true, width:800, height:600, backgroundColor:'#202020', webPreferences:{ backgroundThrottling:false } });
    await win.loadURL('data:text/html,<body style="margin:0;background:%23202020"></body>');
    const created = addon.createPlayer();
    id = Number(created.playerId);
    if (!id) throw new Error('createPlayer failed');
    addon.setUpdateCallback(id, () => {});
    addon.configureNativePresenter(id, hwndText(win));
    addon.setNativePresenterBounds(id, 60, 80, 640, 360);
    addon.open(id, fixture(dir));
    await waitUntil(() => addon.pollPlayback(id)?.fileLoaded === true, 10000, 'load');
    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');
    if (addon.setNativePresenterVisible(id, true) !== true) throw new Error('presenter show failed');
    await waitUntil(() => Number(addon.nativePresenterStats(id)?.presentedFrames || 0) >= 8, 10000, 'native baseline');

    let baselineQueued = 0;
    for (let i=0;i<8;i+=1) {
      const f = addon.popProducedFrame(id);
      if (f?.updated) { baselineQueued += 1; addon.releaseProducedFrame(id, Number(f.slotId), Number(f.frameId)); }
      await sleep(20);
    }
    if (baselineQueued !== 0) throw new Error(`R33 native-only baseline regressed queued=${baselineQueued}`);

    const before = addon.nativePresenterStats(id);
    const presentBefore = Number(before.presentedFrames || 0);
    if (addon.setNativePresenterMirrorChromium(id, true) !== true) throw new Error('mirror arm failed');
    let mirrored = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && mirrored < 10) {
      const f = addon.popProducedFrame(id);
      if (f?.updated) {
        mirrored += 1;
        addon.releaseProducedFrame(id, Number(f.slotId), Number(f.frameId));
      } else await sleep(6);
    }
    const during = addon.nativePresenterStats(id);
    const livePresentDelta = Number(during.presentedFrames || 0) - presentBefore;
    if (mirrored < 8) throw new Error(`R41 mirror did not feed Chromium enough frames mirrored=${mirrored}`);
    if (livePresentDelta < 8) throw new Error(`R41 native popup froze during mirror livePresentDelta=${livePresentDelta} mirrored=${mirrored}`);
    if (Number(during.presentOccludedFrames || 0) !== 0 || Number(during.presentOtherStatusFrames || 0) !== 0 || Number(during.failures || 0) !== 0) {
      throw new Error(`R41 native mirror presentation status failed ${JSON.stringify(during)}`);
    }
    if (during.windowVisible !== true || during.requestedVisible !== true) throw new Error(`R41 native safety surface disappeared during mirror ${JSON.stringify(during)}`);

    addon.setNativePresenterMirrorChromium(id, false);
    const resumeBase = Number(addon.nativePresenterStats(id)?.presentedFrames || 0);
    await waitUntil(() => Number(addon.nativePresenterStats(id)?.presentedFrames || 0) >= resumeBase + 5, 5000, 'native-only resume');
    let afterQueued = 0;
    for (let i=0;i<6;i+=1) {
      const f = addon.popProducedFrame(id);
      if (f?.updated) { afterQueued += 1; addon.releaseProducedFrame(id, Number(f.slotId), Number(f.frameId)); }
      await sleep(20);
    }
    if (afterQueued > 1) throw new Error(`R33 native-only did not resume after R41 mirror queued=${afterQueued}`);
    console.log(`R41_LIVE_NATIVE_HANDOFF_RUNTIME_OK baselineQueued=0 mirrored=${mirrored} livePresentDelta=${livePresentDelta} exactSOk=1 windowVisibleDuringMirror=1 afterQueued=${afterQueued} deviceMode=${created.deviceMode}`);
  } finally {
    clearTimeout(hardDeadline);
    if (id) {
      try { addon.setNativePresenterMirrorChromium(id, false); } catch {}
      try { addon.setNativePresenterVisible(id, false); } catch {}
      try { addon.stopFrameProducer(id); } catch {}
      try { addon.destroyPlayer(id); } catch {}
    }
    try { win?.destroy(); } catch {}
    try { fs.rmSync(dir,{recursive:true,force:true}); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    app.quit();
  }
})().catch(error => { clearTimeout(hardDeadline); console.error(error?.stack || error); try { app.quit(); } catch {} process.exit(1); });

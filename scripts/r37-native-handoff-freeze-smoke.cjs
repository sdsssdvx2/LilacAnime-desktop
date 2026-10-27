'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R37 native freeze smoke exceeded 90s hard deadline');
  process.exit(124);
}, 90000);

function hwndText(win) {
  const raw = win.getNativeWindowHandle();
  return (raw.length >= 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))).toString(10);
}
function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r37-freeze.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=30',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
    '-c:a','aac','-shortest',out
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed ${String(result.stderr || '').slice(0, 240)}`);
  return out;
}
async function waitUntil(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`${label} timeout`);
}

(async () => {
  await app.whenReady();
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !dllPath) throw new Error('R37 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of [
    'createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer',
    'configureNativePresenter','setNativePresenterBounds','setNativePresenterVisible',
    'setNativePresenterMirrorChromium','nativePresenterStats','popProducedFrame',
    'releaseProducedFrame','destroyPlayer'
  ]) if (typeof addon[name] !== 'function') throw new Error(`missing ${name}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r37-freeze-'));
  let win, id;
  try {
    win = new BrowserWindow({ show:true, width:800, height:600, backgroundColor:'#202020', webPreferences:{ backgroundThrottling:false } });
    await win.loadURL('data:text/html,<body style="background:%23202020"></body>');

    const created = addon.createPlayer();
    id = Number(created.playerId);
    if (!id) throw new Error('createPlayer failed');
    if (addon.setUpdateCallback(id, () => {}) !== true) throw new Error('setUpdateCallback failed');
    addon.configureNativePresenter(id, hwndText(win));
    addon.setNativePresenterBounds(id, 60, 80, 640, 360);
    addon.open(id, fixture(dir));
    await waitUntil(() => addon.pollPlayback(id)?.fileLoaded === true, 10000, 'load');
    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');
    if (addon.setNativePresenterVisible(id, true) !== true) throw new Error('presenter show failed');
    await waitUntil(() => Number(addon.nativePresenterStats(id)?.presentedFrames || 0) >= 6, 10000, 'native baseline');

    let baselineQueued = 0;
    for (let i = 0; i < 8; i += 1) {
      const frame = addon.popProducedFrame(id);
      if (frame?.updated) {
        baselineQueued += 1;
        addon.releaseProducedFrame(id, Number(frame.slotId), Number(frame.frameId));
      }
      await sleep(25);
    }
    if (baselineQueued !== 0) throw new Error(`R33 native-only baseline regressed queued=${baselineQueued}`);

    const before = addon.nativePresenterStats(id);
    const presentBefore = Number(before.presentedFrames || 0);
    if (addon.setNativePresenterMirrorChromium(id, true) !== true) throw new Error('mirror arm failed');

    let mirrored = 0;
    const mirrorDeadline = Date.now() + 4000;
    while (Date.now() < mirrorDeadline && mirrored < 8) {
      const frame = addon.popProducedFrame(id);
      if (frame?.updated) {
        mirrored += 1;
        addon.releaseProducedFrame(id, Number(frame.slotId), Number(frame.frameId));
      } else {
        await sleep(8);
      }
    }
    const during = addon.nativePresenterStats(id);
    const frozenPresentDelta = Number(during.presentedFrames || 0) - presentBefore;
    if (mirrored < 5) throw new Error(`R37 mirror did not produce Chromium frames mirrored=${mirrored}`);
    if (frozenPresentDelta > 1) throw new Error(`R37 native popup was not frozen during mirror delta=${frozenPresentDelta}`);

    addon.setNativePresenterMirrorChromium(id, false);
    const resumeBase = Number(addon.nativePresenterStats(id)?.presentedFrames || 0);
    await waitUntil(() => Number(addon.nativePresenterStats(id)?.presentedFrames || 0) >= resumeBase + 4, 5000, 'native resume');

    let afterQueued = 0;
    for (let i = 0; i < 6; i += 1) {
      const frame = addon.popProducedFrame(id);
      if (frame?.updated) {
        afterQueued += 1;
        addon.releaseProducedFrame(id, Number(frame.slotId), Number(frame.frameId));
      }
      await sleep(25);
    }
    if (afterQueued > 1) throw new Error(`R33 native-only did not resume after mirror queued=${afterQueued}`);

    console.log(`R37_NATIVE_HANDOFF_FREEZE_OK baselineQueued=0 mirrored=${mirrored} frozenPresentDelta=${frozenPresentDelta} resumePresentDelta=${Number(addon.nativePresenterStats(id)?.presentedFrames || 0)-resumeBase} afterQueued=${afterQueued} deviceMode=${created.deviceMode}`);
  } finally {
    clearTimeout(hardDeadline);
    if (id) {
      try { addon.setNativePresenterMirrorChromium(id, false); } catch {}
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
  clearTimeout(hardDeadline);
  console.error(error?.stack || error);
  process.exitCode = 1;
  try { app.quit(); } catch {}
});

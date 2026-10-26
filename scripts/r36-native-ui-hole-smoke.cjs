'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const blockMain = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const output = path.join(dir, 'r36-ui-hole-red.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','color=c=red:size=640x360:rate=24000/1001:duration=14',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=14',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','64k','-shortest','-movflags','+faststart',output
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(output)) throw new Error('fixture failed: ' + String(result.stderr || '').slice(0,240));
  return output;
}
function hwndText(win) {
  const raw = win.getNativeWindowHandle();
  return (raw.length >= 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))).toString(10);
}
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(label + ' timeout');
}
function sampleImage(image, x, y, half = 14) {
  const size = image.getSize(), bitmap = image.toBitmap();
  if (!Buffer.isBuffer(bitmap) || bitmap.length < size.width * size.height * 4) throw new Error('bitmap too small');
  const x0 = Math.max(0, Math.min(size.width - 1, Math.round(x - half)));
  const x1 = Math.max(x0 + 1, Math.min(size.width, Math.round(x + half)));
  const y0 = Math.max(0, Math.min(size.height - 1, Math.round(y - half)));
  const y1 = Math.max(y0 + 1, Math.min(size.height, Math.round(y + half)));
  let c0 = 0, c1 = 0, c2 = 0, n = 0;
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const off = (yy * size.width + xx) * 4;
    c0 += bitmap[off]; c1 += bitmap[off + 1]; c2 += bitmap[off + 2]; n++;
  }
  return { c0:c0/n, c1:c1/n, c2:c2/n };
}
function green(means) {
  return means.c1 > means.c0 + 70 && means.c1 > means.c2 + 70 && means.c1 > 120;
}
async function desktopSampleAt(screenX, screenY) {
  const display = screen.getPrimaryDisplay();
  const width = Math.max(320, Math.round(display.bounds.width));
  const height = Math.max(240, Math.round(display.bounds.height));
  const sources = await desktopCapturer.getSources({ types:['screen'], thumbnailSize:{width,height}, fetchWindowIcons:false });
  if (!sources.length) throw new Error('desktopCapturer returned no screen sources');
  const source = sources.find(item => String(item.display_id || '') === String(display.id)) || sources[0];
  const image = source.thumbnail, size = image.getSize();
  const sx = size.width / Math.max(1, display.bounds.width), sy = size.height / Math.max(1, display.bounds.height);
  return sampleImage(image, (screenX - display.bounds.x) * sx, (screenY - display.bounds.y) * sy);
}

(async () => {
  await app.whenReady();
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON, dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('R36 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer','configureNativePresenter','setNativePresenterVisible','setNativePresenterBounds','setNativePresenterUiHoles','nativePresenterStats','popProducedFrame','releaseProducedFrame','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error('missing addon export ' + name);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r36-ui-hole-'));
  let owner = null, rival = null, id = null;
  try {
    const work = screen.getPrimaryDisplay().workArea;
    const ownerX = Math.max(work.x + 20, Math.min(work.x + work.width - 840, work.x + 50));
    const ownerY = Math.max(work.y + 20, Math.min(work.y + work.height - 640, work.y + 40));
    owner = new BrowserWindow({ show:false, x:ownerX, y:ownerY, width:820, height:620, backgroundColor:'#1428b4', webPreferences:{backgroundThrottling:false} });
    await owner.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:rgb(20,40,180);overflow:hidden"><div id="ui" style="position:fixed;left:100px;top:110px;width:180px;height:70px;background:rgb(20,220,40);z-index:9"></div></body></html>`));
    owner.show(); owner.focus();
    await waitUntil(() => owner.isFocused(), 3000, 'owner focus');

    const created = addon.createPlayer(); id = Number(created.playerId); if (!id) throw new Error('createPlayer failed');
    addon.setUpdateCallback(id, () => {});
    if (addon.configureNativePresenter(id, hwndText(owner)) !== true) throw new Error('configureNativePresenter failed');
    const bounds = { x:60, y:80, width:640, height:360 };
    if (addon.setNativePresenterBounds(id, bounds.x, bounds.y, bounds.width, bounds.height) !== true) throw new Error('setNativePresenterBounds failed');
    const hole = [40,30,180,70];
    if (addon.setNativePresenterUiHoles(id, hole) !== true) throw new Error('setNativePresenterUiHoles failed');

    addon.open(id, fixture(dir));
    await waitUntil(() => addon.pollPlayback(id)?.fileLoaded === true, 10000, 'fixture load');
    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');

    const ownerCapture = await owner.webContents.capturePage();
    const ownerGreen = sampleImage(ownerCapture, 190, 145);
    if (!green(ownerGreen)) throw new Error('underlying owner UI is not green: ' + JSON.stringify(ownerGreen));

    rival = new BrowserWindow({ show:false, x:Math.min(work.x + work.width - 210, ownerX + 600), y:Math.min(work.y + work.height - 120, ownerY + 500), width:200, height:100, backgroundColor:'#202020' });
    await rival.loadURL('data:text/html,<body style="background:%23202020;color:white">rival</body>');
    rival.show(); rival.focus();
    await waitUntil(() => !owner.isFocused() && rival.isFocused(), 3000, 'owner blur');
    if (addon.setNativePresenterVisible(id, true) !== true) throw new Error('presenter show failed');
    await waitUntil(() => {
      const s = addon.nativePresenterStats(id);
      return s?.windowVisible === true && Number(s.presentSOkFrames || 0) >= 5 && s.r36FirstHoleExcluded === true;
    }, 6000, 'region hole visible');

    const before = addon.nativePresenterStats(id);
    if (Number(before.r36UiHoleCount) !== 1 || Number(before.r36UiRegionFailures) !== 0 || Number(before.r36UiRegionUpdates) < 1 || before.r36FirstHoleExcluded !== true) {
      throw new Error('native UI-hole region proof failed: ' + JSON.stringify(before));
    }

    const presentedBefore = Number(before.presentedFrames || 0), nativeOnlyBefore = Number(before.nativeOnlyFrames || 0);
    blockMain(900);
    const afterBlock = addon.nativePresenterStats(id);
    const presentedDelta = Number(afterBlock.presentedFrames || 0) - presentedBefore;
    const nativeOnlyDelta = Number(afterBlock.nativeOnlyFrames || 0) - nativeOnlyBefore;
    if (presentedDelta < 10 || nativeOnlyDelta < 10 || afterBlock.r36FirstHoleExcluded !== true || Number(afterBlock.r36UiRegionFailures) !== 0) {
      throw new Error('native autonomy/UI-hole failed through main block: ' + JSON.stringify({presentedDelta,nativeOnlyDelta,afterBlock}));
    }

    let queued = 0;
    for (let i = 0; i < 7; i++) {
      const frame = addon.popProducedFrame(id);
      if (frame?.updated) { queued++; addon.releaseProducedFrame(id, Number(frame.slotId), Number(frame.frameId)); }
      await sleep(30);
    }
    if (queued !== 0) throw new Error('UI-hole mode broke native-only delivery queued=' + queued);

    // Stress region mutation far harder than real control visibility changes. The
    // native producer must continue presenting while main performs Win32 region
    // updates, proving these rare UI operations do not enter the producer path.
    const stressBefore = addon.nativePresenterStats(id);
    const stressPresentedBefore = Number(stressBefore.presentedFrames || 0);
    const stressNativeBefore = Number(stressBefore.nativeOnlyFrames || 0);
    const stressStarted = Date.now();
    for (let i = 0; i < 30; i++) {
      const next = (i & 1) ? hole : [330,240,220,80];
      if (addon.setNativePresenterUiHoles(id, next) !== true) throw new Error('region stress update failed at ' + i);
      await sleep(15);
    }
    const stressElapsed = Date.now() - stressStarted;
    const stressAfter = addon.nativePresenterStats(id);
    const stressPresentedDelta = Number(stressAfter.presentedFrames || 0) - stressPresentedBefore;
    const stressNativeDelta = Number(stressAfter.nativeOnlyFrames || 0) - stressNativeBefore;
    if (stressPresentedDelta < 5 || stressNativeDelta < 5 || Number(stressAfter.r36UiRegionFailures) !== 0) {
      throw new Error('region stress starved native presenter ' + JSON.stringify({stressElapsed,stressPresentedDelta,stressNativeDelta,stressAfter}));
    }
    if (addon.setNativePresenterUiHoles(id, hole) !== true) throw new Error('restore UI hole after stress failed');

    if (addon.setNativePresenterUiHoles(id, [330,240,220,80]) !== true) throw new Error('second UI-hole update failed');
    let changed = addon.nativePresenterStats(id);
    if (Number(changed.r36UiHoleCount) !== 1 || changed.r36FirstHoleExcluded !== true || Number(changed.r36UiRegionFailures) !== 0) throw new Error('second UI-hole region invalid ' + JSON.stringify(changed));
    if (addon.setNativePresenterBounds(id, 88, 102, 640, 360) !== true) throw new Error('bounds move failed');
    changed = addon.nativePresenterStats(id);
    if (changed.r36FirstHoleExcluded !== true || Number(changed.r36UiRegionFailures) !== 0) throw new Error('UI-hole lost after bounds move ' + JSON.stringify(changed));
    if (addon.setNativePresenterUiHoles(id, []) !== true) throw new Error('clear UI holes failed');
    const cleared = addon.nativePresenterStats(id);
    if (Number(cleared.r36UiHoleCount) !== 0 || Number(cleared.r36UiRegionFailures) !== 0) throw new Error('clear UI holes invalid ' + JSON.stringify(cleared));
    if (addon.setNativePresenterUiHoles(id, hole) !== true) throw new Error('restore UI hole failed');

    let dwm = 'unobservable';
    try {
      const stats = addon.nativePresenterStats(id);
      const screenX = Number(stats.screenLeft) + hole[0] + hole[2] / 2;
      const screenY = Number(stats.screenTop) + hole[1] + hole[3] / 2;
      const means = await desktopSampleAt(screenX, screenY);
      if (green(means)) dwm = 'green-hole-observed';
    } catch {}

    const finalStats = addon.nativePresenterStats(id);
    if (finalStats.r36FirstHoleExcluded !== true || Number(finalStats.r36UiRegionFailures) !== 0) throw new Error('final UI-hole proof invalid ' + JSON.stringify(finalStats));
    console.log('R36_NATIVE_UI_HOLE_SMOKE_OK regionHoleExcluded=1 ownerUi=green dwm=' + dwm + ' mainBlockMs=900 autonomousPresented=' + presentedDelta + ' autonomousNativeOnly=' + nativeOnlyDelta + ' nativeOnlyQueued=0 regionStressUpdates=30 regionStressMs=' + stressElapsed + ' regionStressPresented=' + stressPresentedDelta + ' regionStressNativeOnly=' + stressNativeDelta + ' regionUpdates=' + Number(finalStats.r36UiRegionUpdates || 0) + ' regionFailures=0 deviceMode=' + created.deviceMode);
  } finally {
    if (id != null) {
      try { addon.setNativePresenterUiHoles(id, []); } catch {}
      try { addon.setNativePresenterVisible(id, false); } catch {}
      try { addon.stopFrameProducer(id); } catch {}
      try { addon.destroyPlayer(id); } catch {}
    }
    try { rival?.destroy(); } catch {}
    try { owner?.destroy(); } catch {}
    try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    app.quit();
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
  try { app.quit(); } catch {}
});

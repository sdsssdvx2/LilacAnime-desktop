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

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const output = path.join(dir, 'r33-owned-popup-red.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','color=c=red:size=640x360:rate=24000/1001:duration=12',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=12',
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

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`${label} timeout`);
}

async function capturePrimary() {
  const display = screen.getPrimaryDisplay();
  const width = Math.max(320, Math.round(display.bounds.width));
  const height = Math.max(240, Math.round(display.bounds.height));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false
  });
  if (!sources.length) throw new Error('desktopCapturer returned no screen sources');
  const exact = sources.find(source => String(source.display_id || '') === String(display.id));
  const source = exact || sources[0];
  const image = source.thumbnail;
  const size = image.getSize();
  if (size.width < 64 || size.height < 64) throw new Error(`invalid desktop capture size ${size.width}x${size.height}`);
  return { image, size, display };
}

function sampleMeans(capture, rect) {
  const { image, size, display } = capture;
  const bitmap = image.toBitmap();
  if (!Buffer.isBuffer(bitmap) || bitmap.length < size.width * size.height * 4) {
    throw new Error(`desktop bitmap buffer too small: ${bitmap?.length || 0}`);
  }
  const sx = size.width / Math.max(1, display.bounds.width);
  const sy = size.height / Math.max(1, display.bounds.height);
  const centerX = Math.round((rect.left - display.bounds.x + rect.width / 2) * sx);
  const centerY = Math.round((rect.top - display.bounds.y + rect.height / 2) * sy);
  const half = 18;
  const x0 = Math.max(0, Math.min(size.width - 1, centerX - half));
  const x1 = Math.max(x0 + 1, Math.min(size.width, centerX + half));
  const y0 = Math.max(0, Math.min(size.height - 1, centerY - half));
  const y1 = Math.max(y0 + 1, Math.min(size.height, centerY + half));
  let c0 = 0, c1 = 0, c2 = 0, samples = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * size.width + x) * 4;
      c0 += bitmap[offset];
      c1 += bitmap[offset + 1];
      c2 += bitmap[offset + 2];
      samples += 1;
    }
  }
  return { c0: c0 / samples, c1: c1 / samples, c2: c2 / samples, samples };
}

function statsRect(stats) {
  return {
    left: Number(stats?.screenLeft),
    top: Number(stats?.screenTop),
    width: Number(stats?.screenWidth),
    height: Number(stats?.screenHeight)
  };
}

(async () => {
  await app.whenReady();
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('R33 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer','configureNativePresenter','setNativePresenterVisible','setNativePresenterBounds','nativePresenterStats','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r33-owned-popup-'));
  let main = null;
  let rival = null;
  let id = null;
  let onFocus = null;
  let onBlur = null;
  let onGeometry = null;
  try {
    const media = buildFixture(dir);
    const work = screen.getPrimaryDisplay().workArea;
    const mainX = Math.max(work.x + 10, Math.min(work.x + Math.max(10, work.width - 840), work.x + 40));
    const mainY = Math.max(work.y + 10, Math.min(work.y + Math.max(10, work.height - 640), work.y + 30));
    main = new BrowserWindow({
      show: false, x: mainX, y: mainY, width: Math.min(820, work.width - 20), height: Math.min(620, work.height - 20),
      backgroundColor: '#1428b4',
      webPreferences: { backgroundThrottling: false }
    });
    await main.loadURL('data:text/html,<html><body style="margin:0;background:rgb(20,40,180);overflow:hidden"><div style="color:white;font:24px sans-serif">R33 owner</div></body></html>');
    main.show();
    main.focus();
    await waitUntil(() => main.isFocused(), 3000, 'owner focus');

    const created = addon.createPlayer();
    id = Number(created.playerId);
    if (!id) throw new Error('createPlayer failed');
    if (addon.setUpdateCallback(id, () => {}) !== true) throw new Error('setUpdateCallback failed');
    if (addon.configureNativePresenter(id, hwndText(main)) !== true) throw new Error('configureNativePresenter failed');
    const clientBounds = { x: 70, y: 90, width: 640, height: 360 };
    const syncBounds = () => addon.setNativePresenterBounds(id, clientBounds.x, clientBounds.y, clientBounds.width, clientBounds.height);
    if (syncBounds() !== true) throw new Error('setNativePresenterBounds failed');

    onFocus = () => addon.setNativePresenterVisible(id, false);
    onBlur = () => addon.setNativePresenterVisible(id, true);
    onGeometry = () => { try { syncBounds(); } catch {} };
    main.on('focus', onFocus);
    main.on('blur', onBlur);
    for (const eventName of ['move','resize','maximize','unmaximize','restore','enter-full-screen','leave-full-screen']) main.on(eventName, onGeometry);

    addon.open(id, media);
    await waitUntil(() => addon.pollPlayback(id)?.fileLoaded === true, 10000, 'fixture load');
    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');
    addon.setNativePresenterVisible(id, false);

    // Focused baseline: popup is hidden, so the known owner HTML should be blue.
    await sleep(350);
    const configured = addon.nativePresenterStats(id);
    if (configured?.surfaceMode !== 'owned-popup' || configured?.isChild !== false || configured?.ownerMatches !== true) {
      throw new Error(`R33 owned popup identity invalid ${JSON.stringify(configured)}`);
    }
    const baselineCapture = await capturePrimary();
    const baseline = sampleMeans(baselineCapture, statsRect(configured));
    const blueIndex = baseline.c0 >= baseline.c2 ? 0 : 2;
    const redIndex = blueIndex === 0 ? 2 : 0;
    const baselineChannels = [baseline.c0, baseline.c1, baseline.c2];
    if (!(baselineChannels[blueIndex] > baselineChannels[redIndex] + 60 && baselineChannels[blueIndex] > baseline.c1 + 50)) {
      throw new Error(`focused owner baseline is not blue enough ${JSON.stringify(baseline)}`);
    }

    // Put a second real BrowserWindow in front/focus without covering the video center.
    const rivalX = Math.max(work.x, Math.min(work.x + work.width - 220, mainX + 600));
    const rivalY = Math.max(work.y, Math.min(work.y + work.height - 120, mainY + 500));
    rival = new BrowserWindow({ show:false, x:rivalX, y:rivalY, width:210, height:110, alwaysOnTop:false, backgroundColor:'#202020' });
    await rival.loadURL('data:text/html,<html><body style="background:%23202020;color:white">focus rival</body></html>');
    rival.show();
    rival.focus();
    await waitUntil(() => !main.isFocused() && rival.isFocused(), 3000, 'real BrowserWindow blur');
    await waitUntil(() => {
      const s = addon.nativePresenterStats(id);
      return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;
    }, 6000, 'owned popup visible/presenting');

    const beforeBlock = addon.nativePresenterStats(id);
    const presentedBefore = Number(beforeBlock.presentedFrames || 0);
    const nativeOnlyBefore = Number(beforeBlock.nativeOnlyFrames || 0);
    blockMain(900);
    const afterBlock = addon.nativePresenterStats(id);
    const presentedDelta = Number(afterBlock.presentedFrames || 0) - presentedBefore;
    const nativeOnlyDelta = Number(afterBlock.nativeOnlyFrames || 0) - nativeOnlyBefore;
    if (presentedDelta < 10 || nativeOnlyDelta < 10) {
      throw new Error(`native popup did not stay autonomous through 900ms main stall presentedDelta=${presentedDelta} nativeOnlyDelta=${nativeOnlyDelta} stats=${JSON.stringify(afterBlock)}`);
    }

    // This is the qualification R32 lacked: inspect actual DWM desktop output while
    // the Electron owner is unfocused, not merely a successful DXGI Present return.
    const redSamples = [];
    for (let i = 0; i < 8; i += 1) {
      const stats = addon.nativePresenterStats(id);
      const capture = await capturePrimary();
      const means = sampleMeans(capture, statsRect(stats));
      redSamples.push(means);
      const channels = [means.c0, means.c1, means.c2];
      if (!(channels[redIndex] > channels[blueIndex] + 70 && channels[redIndex] > means.c1 + 55 && channels[redIndex] > 120)) {
        throw new Error(`DWM owned-popup sample ${i} not red / possible black-or-Chromium flash ${JSON.stringify(means)} stats=${JSON.stringify(stats)}`);
      }
      await sleep(110);
    }

    // Move the unfocused owner and prove the popup follows client->screen geometry.
    const beforeMove = addon.nativePresenterStats(id);
    main.setPosition(mainX + 28, mainY + 22, false);
    await sleep(350);
    const afterMove = addon.nativePresenterStats(id);
    if (Math.abs((Number(afterMove.screenLeft) - Number(beforeMove.screenLeft)) - 28) > 3 ||
        Math.abs((Number(afterMove.screenTop) - Number(beforeMove.screenTop)) - 22) > 3) {
      throw new Error(`owned popup did not track owner move before=${JSON.stringify(beforeMove)} after=${JSON.stringify(afterMove)}`);
    }
    const movedMeans = sampleMeans(await capturePrimary(), statsRect(afterMove));
    const movedChannels = [movedMeans.c0, movedMeans.c1, movedMeans.c2];
    if (!(movedChannels[redIndex] > movedChannels[blueIndex] + 70 && movedChannels[redIndex] > movedMeans.c1 + 55)) {
      throw new Error(`owned popup lost DWM output after owner move ${JSON.stringify(movedMeans)}`);
    }

    // Focus recovery must hide the native popup so the qualified WebGPU path can own
    // focused playback again. The smoke's owner page becomes blue at the same rect.
    main.focus();
    await waitUntil(() => main.isFocused(), 3000, 'owner refocus');
    await waitUntil(() => addon.nativePresenterStats(id)?.windowVisible === false, 3000, 'popup hide on refocus');
    await sleep(250);
    const focusedStats = addon.nativePresenterStats(id);
    const focusedMeans = sampleMeans(await capturePrimary(), statsRect(focusedStats));
    const focusedChannels = [focusedMeans.c0, focusedMeans.c1, focusedMeans.c2];
    if (!(focusedChannels[blueIndex] > focusedChannels[redIndex] + 60 && focusedChannels[blueIndex] > focusedMeans.c1 + 50)) {
      throw new Error(`focused recovery did not expose owner/WebGPU plane ${JSON.stringify(focusedMeans)}`);
    }

    console.log(`R33_VISIBLE_FOCUS_SMOKE_OK mode=owned-popup ownerMatches=1 child=0 dwmRedSamples=${redSamples.length + 1} mainBlockMs=900 autonomousPresented=${presentedDelta} autonomousNativeOnly=${nativeOnlyDelta} moved=28x22 focusRecovery=hidden deviceMode=${created.deviceMode}`);
  } finally {
    if (main && onFocus) main.removeListener('focus', onFocus);
    if (main && onBlur) main.removeListener('blur', onBlur);
    if (main && onGeometry) for (const eventName of ['move','resize','maximize','unmaximize','restore','enter-full-screen','leave-full-screen']) main.removeListener(eventName, onGeometry);
    if (id != null) {
      try { addon.setNativePresenterVisible(id, false); } catch {}
      try { addon.stopFrameProducer(id); } catch {}
      try { addon.destroyPlayer(id); } catch {}
    }
    try { rival?.destroy(); } catch {}
    try { main?.destroy(); } catch {}
    try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    app.quit();
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
  try { app.quit(); } catch {}
});

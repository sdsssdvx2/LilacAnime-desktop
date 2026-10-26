'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R35 paused no-subtitle handoff smoke exceeded 90s hard deadline');
  process.exit(124);
}, 90000);

function hwndText(win) {
  const raw = win.getNativeWindowHandle();
  return (raw.length >= 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))).toString(10);
}

function makeFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const video = path.join(dir, 'r35-paused-no-subtitle.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=640x360:rate=24000/1001:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', video
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.status !== 0 || !fs.existsSync(video)) throw new Error('fixture failed ' + String(result.stderr || '').slice(0, 200));
  return video;
}

async function waitUntil(fn, timeoutMs, label, intervalMs = 20) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(label + ' timeout');
}

(async () => {
  await app.whenReady();
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !dllPath) throw new Error('R35 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer','open','command','pollPlayback','startFrameProducer','stopFrameProducer','configureNativePresenter','setNativePresenterBounds','setNativePresenterVisible','setNativePresenterMirrorChromium','nativePresenterStats','popProducedFrame','releaseProducedFrame','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error('missing ' + name);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r35-paused-no-sub-'));
  let win = null;
  let id = 0;
  try {
    win = new BrowserWindow({ show: true, width: 800, height: 600, backgroundColor: '#0044cc', webPreferences: { backgroundThrottling: false } });
    await win.loadURL('data:text/html,<body style="margin:0;background:%230044cc;color:white"><div style="font:36px sans-serif;padding:40px">R35 HTML UI NO SUBTITLE</div></body>');
    const video = makeFixture(dir);
    const created = addon.createPlayer();
    id = Number(created.playerId);
    if (!id) throw new Error('createPlayer failed');
    if (addon.configureNativePresenter(id, hwndText(win)) !== true) throw new Error('configureNativePresenter failed');
    if (addon.setNativePresenterBounds(id, 0, 0, 800, 600) !== true) throw new Error('setNativePresenterBounds failed');
    addon.open(id, video);
    await waitUntil(() => addon.pollPlayback(id)?.fileLoaded === true, 10000, 'video load');
    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');
    if (addon.setNativePresenterVisible(id, true) !== true) throw new Error('presenter show failed');
    await waitUntil(() => Number(addon.nativePresenterStats(id)?.presentedFrames || 0) >= 5, 8000, 'native baseline');

    // Mimic R34 blur ownership even though there is no selected subtitle track.
    // The property is still yes while the native popup owns unfocused playback.
    addon.command(id, ['set', 'sub-visibility', 'yes']);
    addon.command(id, ['set', 'pause', 'yes']);
    await waitUntil(() => addon.pollPlayback(id)?.paused === true, 3000, 'pause state');
    await sleep(600);
    for (let i = 0; i < 32; i += 1) {
      const frame = addon.popProducedFrame(id);
      if (!frame?.updated) break;
      addon.releaseProducedFrame(id, Number(frame.slotId), Number(frame.frameId));
    }
    const stable = addon.nativePresenterStats(id);
    const stablePresented = Number(stable?.presentedFrames || 0);
    await sleep(350);
    if (Number(addon.nativePresenterStats(id)?.presentedFrames || 0) - stablePresented > 1) throw new Error('paused producer did not settle');

    if (addon.setNativePresenterMirrorChromium(id, true) !== true) throw new Error('mirror arm failed');
    // Exact production focus-start trigger. This must wake render-api even without
    // any subtitle track; otherwise a paused no-subtitle video could still leave
    // the owned popup covering the Chromium UI forever.
    addon.command(id, ['set', 'sub-visibility', 'no']);

    let redraw = null;
    const redrawDeadline = Date.now() + 3000;
    while (Date.now() < redrawDeadline) {
      const frame = addon.popProducedFrame(id);
      if (frame?.updated) { redraw = frame; break; }
      await sleep(15);
    }
    if (!redraw) throw new Error('no-subtitle sub-visibility focus trigger produced no paused mirrored redraw frame');
    const during = addon.nativePresenterStats(id);
    const nativeDelta = Number(during?.presentedFrames || 0) - stablePresented;
    if (nativeDelta < 1) throw new Error('no-subtitle paused redraw did not preserve native overlap');
    if (during?.visible !== true || during?.requestedVisible !== true) throw new Error('native popup hid before Chromium acknowledgement');

    if (addon.releaseProducedFrame(id, Number(redraw.slotId), Number(redraw.frameId)) !== true) throw new Error('redraw release failed');
    addon.setNativePresenterMirrorChromium(id, false);
    addon.setNativePresenterVisible(id, false);
    await waitUntil(() => addon.nativePresenterStats(id)?.visible === false, 1500, 'popup hide after acknowledgement');
    if (addon.pollPlayback(id)?.paused !== true) throw new Error('no-subtitle handoff unexpectedly resumed playback');
    console.log('R35_PAUSED_NO_SUBTITLE_HANDOFF_OK paused=1 noSubtitleTrack=1 redrawFrameId=' + Number(redraw.frameId) + ' nativePresentDelta=' + nativeDelta + ' popupHeldUntilRelease=1 popupHiddenAfterRelease=1');
  } finally {
    clearTimeout(hardDeadline);
    if (id) {
      try { addon.setNativePresenterMirrorChromium(id, false); } catch {}
      try { addon.setNativePresenterVisible(id, false); } catch {}
      try { addon.stopFrameProducer(id); } catch {}
      try { addon.destroyPlayer(id); } catch {}
    }
    try { win?.destroy(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    app.quit();
  }
})().catch(error => {
  clearTimeout(hardDeadline);
  console.error(error?.stack || error);
  process.exitCode = 1;
  try { app.quit(); } catch {}
});

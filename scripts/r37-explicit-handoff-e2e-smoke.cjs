'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R37 explicit renderer handoff e2e smoke exceeded 120s hard deadline');
  process.exit(124);
}, 120000);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r37-e2e.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=20',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=20',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
    '-c:a','aac','-shortest',out
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed ${String(result.stderr || '').slice(0, 240)}`);
  return out;
}
function subtitleFixture(dir) {
  const out = path.join(dir, 'r37-e2e.vtt');
  fs.writeFileSync(out, 'WEBVTT\n\n00:00:00.000 --> 00:00:19.000\nR37 subtitle ownership smoke\n', 'utf8');
  return out;
}
function receiverPreload(dir) {
  const out = path.join(dir, 'r37-receiver-preload.cjs');
  fs.writeFileSync(out, String.raw`'use strict';
const { ipcRenderer, sharedTexture } = require('electron');
let received = 0;
let acked = 0;
try {
  sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }, metadata = {}) => {
    received += 1;
    let copied = false;
    let frame = null;
    try {
      if (metadata?.kind !== 'lilac-libmpv-frame') return;
      frame = importedSharedTexture.getVideoFrame();
      copied = Boolean(frame && Number(frame.codedWidth || frame.displayWidth || 0) > 0 && Number(frame.codedHeight || frame.displayHeight || 0) > 0);
    } finally {
      try { frame?.close?.(); } catch {}
      try { importedSharedTexture?.release?.(); } catch {}
      if (copied && Number(metadata?.r37HandoffEpoch) > 0) {
        acked += 1;
        ipcRenderer.send('libmpv-shared:r37-handoff-presented', {
          epoch: Number(metadata.r37HandoffEpoch),
          playerId: Number(metadata.playerId) || 0,
          generation: Number(metadata.generation) || 0,
          frameId: Number(metadata.frameId) || 0
        });
      }
      if ((received % 8) === 0 || Number(metadata?.r37HandoffEpoch) > 0) {
        ipcRenderer.send('libmpv-shared:receiver-stats', {
          receivedFrames: received,
          presentedFrames: received,
          droppedNoSurface: 0,
          drawFailures: 0,
          lastFrameAt: Date.now(),
          lastFrameId: Number(metadata?.frameId) || 0,
          playerId: Number(metadata?.playerId) || 0,
          width: Number(metadata?.width) || 0,
          height: Number(metadata?.height) || 0,
          reason: copied ? 'presented' : 'no-frame',
          r37Acked: acked
        });
      }
    }
  });
  ipcRenderer.send('libmpv-shared:receiver-ready', { ok: true });
} catch (error) {
  ipcRenderer.send('libmpv-shared:receiver-ready', { ok: false, error: String(error?.message || error).slice(0, 180) });
}
`, 'utf8');
  return out;
}
async function waitUntil(fn, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = fn();
      if (last) return last;
    } catch {}
    await sleep(20);
  }
  throw new Error(`${label} timeout last=${JSON.stringify(last)}`);
}
function r37State(bridge) {
  const state = bridge.state();
  const focus = state?.r33FocusSurface || {};
  const handoff = focus?.r34Handoff || {};
  const r36 = handoff?.r36Ack || {};
  const r37 = handoff?.r37Handoff || {};
  return { state, focus, handoff, r36, r37 };
}
async function focusCycle(bridge, main, other, expectedAck, label) {
  other.show();
  other.focus();
  await waitUntil(() => !main.isFocused(), 3000, `${label} blur`);
  await waitUntil(() => {
    const view = r37State(bridge);
    return view.focus.active === true && view.handoff.subtitleVisible === true;
  }, 4000, `${label} native active`);
  const blurred = r37State(bridge);
  if (Number(blurred.r36.uiHoleRects || 0) !== 0) throw new Error(`${label} stale UI holes survived count=${blurred.r36.uiHoleRects}`);
  const nativeStats = blurred.state?.r32NativePresenter || {};
  if (Number(nativeStats.r36UiHoleCount || 0) !== 0) throw new Error(`${label} native region holes survived count=${nativeStats.r36UiHoleCount}`);

  const started = Date.now();
  main.show();
  main.focus();
  await waitUntil(() => main.isFocused(), 3000, `${label} refocus`);
  const completed = await waitUntil(() => {
    const view = r37State(bridge);
    return Number(view.r37.rendererAckCompletions || 0) >= expectedAck && view.handoff.pending === false && view.focus.active === false ? view : null;
  }, 1200, `${label} explicit renderer ACK`);
  const elapsed = Date.now() - started;
  if (Number(completed.r36.failOpenCount || 0) !== 0) throw new Error(`${label} used R36 fail-open count=${completed.r36.failOpenCount}`);
  if (Number(completed.r37.rejectedRendererAcks || 0) !== 0) throw new Error(`${label} rejected ACK count=${completed.r37.rejectedRendererAcks}`);
  if (elapsed >= 1200) throw new Error(`${label} ACK too slow elapsed=${elapsed}`);
  return { elapsed, lastAckLatencyMs:Number(completed.r37.lastAckLatencyMs || 0) };
}

(async () => {
  await app.whenReady();
  if (!process.env.LILAC_LIBMPV_PLAYER_ADDON || !process.env.LILAC_LIBMPV_DLL) throw new Error('R37 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r37-e2e-'));
  let main, other, bridge;
  try {
    // Register the bridge IPC listeners before the renderer preload can emit
    // receiver-ready. Otherwise a fast preload could make the test miss the
    // readiness edge even though the shared-texture receiver itself is valid.
    bridge = createLibmpvSharedBridge();
    await bridge.ensure();

    const preload = receiverPreload(dir);
    main = new BrowserWindow({
      show:true, width:800, height:600, backgroundColor:'#202020',
      webPreferences:{ preload, backgroundThrottling:false, contextIsolation:true, nodeIntegration:false }
    });
    other = new BrowserWindow({ show:false, width:320, height:240, backgroundColor:'#303030', webPreferences:{ backgroundThrottling:false } });
    await main.loadURL('data:text/html,<body style="margin:0;background:%23202020"></body>');
    await other.loadURL('data:text/html,<body style="background:%23303030"></body>');

    await bridge.attachWindow(main);
    bridge.resize({ x:0, y:0, width:640, height:360, visible:true });
    const opened = await bridge.open(pathToFileURL(fixture(dir)).href, {}, false, { x:0, y:0, width:640, height:360, visible:true });
    if (!opened?.ok) throw new Error(`bridge open failed ${JSON.stringify(opened)}`);

    await waitUntil(() => {
      const state = bridge.state();
      return state?.fileLoaded === true && Number(state?.metrics?.sentFrames || 0) >= 5;
    }, 12000, 'focused playback baseline');

    const active = await focusCycle(bridge, main, other, 1, 'active');
    const subtitle = subtitleFixture(dir);
    const add = bridge.command(['sub-add', subtitle, 'select']);
    if (!add?.ok) throw new Error(`sub-add failed ${JSON.stringify(add)}`);
    bridge.command(['set', 'pause', 'yes']);
    await waitUntil(() => bridge.state()?.paused === true, 3000, 'pause with subtitle');
    const pausedSubtitle = await focusCycle(bridge, main, other, 2, 'paused-subtitle');

    bridge.command(['sub-remove']);
    await sleep(120);
    const pausedNoSubtitle = await focusCycle(bridge, main, other, 3, 'paused-no-subtitle');

    const final = r37State(bridge);
    if (Number(final.r37.rendererAckCompletions || 0) !== 3) throw new Error(`expected 3 R37 ACK completions got ${final.r37.rendererAckCompletions}`);
    if (Number(final.r36.failOpenCount || 0) !== 0) throw new Error(`R37 fail-open count nonzero ${final.r36.failOpenCount}`);
    if (final.handoff.pending === true || Number(final.r37.pendingEpoch || 0) !== 0) throw new Error('R37 handoff left pending state');
    if (Number(final.state?.r32NativePresenter?.r36UiHoleCount || 0) !== 0) throw new Error('R37 UI holes active at end');

    console.log(`R37_EXPLICIT_HANDOFF_E2E_OK cycles=3 activeMs=${active.elapsed} pausedSubtitleMs=${pausedSubtitle.elapsed} pausedNoSubtitleMs=${pausedNoSubtitle.elapsed} rendererAckCompletions=${final.r37.rendererAckCompletions} failOpenCount=0 rejectedAcks=0 uiHoles=0 realSharedTexture=1`);
  } finally {
    clearTimeout(hardDeadline);
    try { await bridge?.close?.(); } catch {}
    try { await bridge?.dispose?.(); } catch {}
    try { main?.destroy(); } catch {}
    try { other?.destroy(); } catch {}
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

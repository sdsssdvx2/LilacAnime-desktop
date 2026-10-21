'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildAvFixture(root, dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary missing');
  const output = path.join(dir, 'fullhd-av.mp4');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=7',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=7',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ];
  let encoded = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (encoded.status !== 0 || !fs.existsSync(output)) {
    const fallback = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=7',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=7',
      '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
    ];
    encoded = spawnSync(ffmpeg, fallback, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  }
  if (encoded.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`full-HD AV fixture encode failed: ${String(encoded.stderr || '').slice(0, 400)}`);
  }
  return output;
}

async function waitForPlayback(bridge, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = bridge.state();
    if (last?.fileLoaded && Number(last?.receiver?.presentedFrames || 0) >= 8) return last;
    await sleep(100);
  }
  throw new Error(`shared runtime never reached active playback: ${JSON.stringify({
    fileLoaded: last?.fileLoaded,
    lastError: last?.lastError,
    presentedFrames: last?.receiver?.presentedFrames,
    metrics: last?.metrics
  })}`);
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const preload = path.join(root, 'electron', 'preload-libmpv-shared.generated.cjs');
  const bundle = path.join(root, 'src', 'libmpv-shared.generated.js');
  if (!fs.existsSync(preload) || !fs.existsSync(bundle)) throw new Error('transformed shared runtime is missing');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-shared-runtime-'));
  const fixture = buildAvFixture(root, dir);
  const html = path.join(dir, 'runtime.html');
  fs.writeFileSync(html, `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
#immersivePlayer,#videoStage{position:relative}
lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#probeButton{position:absolute;z-index:20;left:32px;top:32px;width:180px;height:64px;border:0;background:#fff;color:#000;font:20px sans-serif}
</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video><button id="probeButton" type="button">input probe</button></div></div></section>
<script src="${pathToFileURL(bundle).href}"></script><script>
window.__runtimeProbe={clicks:0,keys:0,lastClickAt:0,lastKeyAt:0};
document.querySelector('#probeButton').addEventListener('click',()=>{window.__runtimeProbe.clicks++;window.__runtimeProbe.lastClickAt=Date.now()});
window.addEventListener('keydown',()=>{window.__runtimeProbe.keys++;window.__runtimeProbe.lastKeyAt=Date.now()},true);
window.__startSharedSmoke=async src=>{await customElements.whenDefined('lilac-mpv-video');const video=document.querySelector('#video');await video.openLilacSource(src,{hls:false,headers:{}});await video.play();return true};
window.__runtimeSnapshot=()=>{const host=document.querySelector('#video');const canvas=host?.shadowRoot?.querySelector('canvas[data-lilac-libmpv-surface]');const rect=host?.getBoundingClientRect?.();const button=document.querySelector('#probeButton').getBoundingClientRect();return{probe:{...window.__runtimeProbe},host:rect?{width:rect.width,height:rect.height}:null,canvas:canvas?{width:canvas.width,height:canvas.height}:null,button:{x:button.left+button.width/2,y:button.top+button.height/2}}};
</script></body></html>`);

  // Hosted Windows runners do not expose a physical audio endpoint reliably.
  // ao=null still exercises demux, decode and automatic audio-track selection.
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const bridge = createLibmpvSharedBridge({ app, ipcMain, headersFor: () => ({}), userAgent: 'Lilac shared runtime CI' });
  await bridge.ensure();

  const win = new BrowserWindow({
    show: true,
    frame: false,
    useContentSize: true,
    width: 1920,
    height: 1080,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  try {
    await bridge.attachWindow(win);
    await win.loadFile(html);
    await win.webContents.executeJavaScript(`window.__startSharedSmoke(${JSON.stringify(pathToFileURL(fixture).href)})`);
    await waitForPlayback(bridge);

    // Measure sustained real BrowserWindow -> preload receiver -> canvas throughput,
    // not merely native-addon frame production.
    await sleep(5000);
    const state = bridge.state();
    const beforeInput = await win.webContents.executeJavaScript('window.__runtimeSnapshot()');
    if (!beforeInput?.host || beforeInput.host.width < 1800 || beforeInput.host.height < 1000) {
      throw new Error(`full-HD host geometry regressed: ${JSON.stringify(beforeInput?.host)}`);
    }
    if (!beforeInput?.canvas || beforeInput.canvas.width < 1800 || beforeInput.canvas.height < 1000) {
      throw new Error(`full-HD canvas geometry regressed: ${JSON.stringify(beforeInput?.canvas)}`);
    }

    const sentFps = Number(state?.metrics?.effectiveSentFps || 0);
    const backpressureRatio = Number(state?.metrics?.backpressureRatio || 0);
    const presented = Number(state?.receiver?.presentedFrames || 0);
    const avgRelease = Number(state?.metrics?.avgReleaseLatencyMs || 0);
    const maxRelease = Number(state?.metrics?.releaseLatencyMaxMs || 0);
    if (presented < 85) throw new Error(`shared presentation throughput too low: ${presented} frames`);
    if (sentFps < 18) throw new Error(`effective shared send FPS too low: ${sentFps}`);
    if (backpressureRatio > 0.20) throw new Error(`shared texture backpressure ratio too high: ${backpressureRatio}`);
    if (Number(state?.metrics?.importFailures || 0) !== 0) throw new Error('shared texture import failures observed');
    if (Number(state?.metrics?.sendFailures || 0) !== 0) throw new Error('shared texture send failures observed');
    if (Number(state?.receiver?.drawFailures || 0) !== 0) throw new Error('shared texture receiver draw failures observed');
    if (avgRelease > 100 || maxRelease > 300) throw new Error(`shared texture release latency too high: avg=${avgRelease} max=${maxRelease}`);

    // Audio must be visible to mpv and selected even though the CI output is a null AO.
    const tracks = Array.isArray(state?.tracks) ? state.tracks : [];
    const selectedAudio = tracks.find(track => track?.type === 'audio' && track?.selected === true);
    if (!tracks.some(track => track?.type === 'audio')) throw new Error(`mpv did not enumerate fixture audio track: ${JSON.stringify(tracks)}`);
    if (!selectedAudio) throw new Error(`mpv did not select fixture audio track: aid=${state?.aid} tracks=${JSON.stringify(tracks)}`);
    if (String(state?.aid || '').toLowerCase() === 'no') throw new Error(`mpv aid remained disabled with an AAC fixture: ${state?.aid}`);

    // Verify real UI input while the full-HD frame pump remains active.
    const clickStartedAt = Date.now();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(beforeInput.button.x), y: Math.round(beforeInput.button.y), movementX: 1, movementY: 1 });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(beforeInput.button.x), y: Math.round(beforeInput.button.y), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(beforeInput.button.x), y: Math.round(beforeInput.button.y), button: 'left', clickCount: 1 });
    const keyStartedAt = Date.now();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ArrowRight' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ArrowRight' });

    let afterInput = null;
    const inputDeadline = Date.now() + 1000;
    while (Date.now() < inputDeadline) {
      afterInput = await win.webContents.executeJavaScript('window.__runtimeSnapshot()');
      if (afterInput?.probe?.clicks >= 1 && afterInput?.probe?.keys >= 1) break;
      await sleep(25);
    }
    const clickLatency = afterInput?.probe?.lastClickAt ? afterInput.probe.lastClickAt - clickStartedAt : Infinity;
    const keyLatency = afterInput?.probe?.lastKeyAt ? afterInput.probe.lastKeyAt - keyStartedAt : Infinity;
    if (afterInput?.probe?.clicks < 1) throw new Error('overlay button did not receive pointer input during playback');
    if (afterInput?.probe?.keys < 1) throw new Error('renderer did not receive keyboard input during playback');
    if (clickLatency > 500 || keyLatency > 500) throw new Error(`input latency too high during playback: click=${clickLatency}ms key=${keyLatency}ms`);

    const final = bridge.state();
    const report = {
      schema: 1,
      smoke: 'full-HD libmpv sharedTexture sustained playback + AV + input',
      geometry: { host: beforeInput.host, canvas: beforeInput.canvas },
      throughput: {
        pumpTicks: final?.metrics?.pumpTicks,
        sentFrames: final?.metrics?.sentFrames,
        presentedFrames: final?.receiver?.presentedFrames,
        effectiveSentFps: final?.metrics?.effectiveSentFps,
        backpressure: final?.metrics?.backpressure,
        backpressureRatio: final?.metrics?.backpressureRatio,
        avgReleaseLatencyMs: final?.metrics?.avgReleaseLatencyMs,
        releaseLatencyMaxMs: final?.metrics?.releaseLatencyMaxMs,
        receiverAvgDrawMs: final?.receiver?.avgDrawMs,
        receiverMaxDrawMs: final?.receiver?.maxDrawMs
      },
      audio: {
        aid: final?.aid,
        audioCodec: final?.audioCodec,
        currentAo: final?.currentAo,
        tracks: (Array.isArray(final?.tracks) ? final.tracks : []).filter(track => ['audio', 'video', 'sub'].includes(track?.type))
      },
      input: { clicks: afterInput.probe.clicks, keys: afterInput.probe.keys, clickLatencyMs: clickLatency, keyLatencyMs: keyLatency },
      pass: true
    };
    console.log(`LIBMPV_SHARED_RUNTIME_REPORT=${JSON.stringify(report)}`);
    console.log('LIBMPV_SHARED_RUNTIME_THROUGHPUT_INPUT_AUDIO_OK');
  } finally {
    try { await bridge.dispose(); } catch {}
    if (!win.isDestroyed()) win.destroy();
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

app.whenReady().then(main).then(() => app.exit(0)).catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIN_PRESENT_FPS = Number.parseFloat(process.env.LIBMPV_MIN_PRESENT_FPS || '20');
const MAX_BACKPRESSURE_RATIO = Number.parseFloat(process.env.LIBMPV_MAX_BACKPRESSURE_RATIO || '0.20');
const MEASURE_MS = Number.parseInt(process.env.LIBMPV_PRESENT_MEASURE_MS || '4000', 10);
const WARMUP_MS = Number.parseInt(process.env.LIBMPV_PRESENT_WARMUP_MS || '1000', 10);

function writeEligibility(payload) {
  const report = {
    schema: 1,
    releaseEligible: payload?.releaseEligible === true,
    classification: String(payload?.classification || 'UNKNOWN'),
    ...(payload?.metrics ? { metrics: payload.metrics } : {})
  };
  const file = process.env.LILAC_RELEASE_ELIGIBILITY_FILE;
  if (file) fs.writeFileSync(file, `${JSON.stringify(report)}\n`, 'utf8');
  console.log(`LIBMPV_SHARED_RUNTIME_RELEASE_ELIGIBILITY=${JSON.stringify(report)}`);
  console.log(`LIBMPV_SHARED_RUNTIME_RELEASE_ELIGIBLE=${report.releaseEligible ? '1' : '0'}`);
  return report;
}

function buildAvFixture(root, dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary missing');
  const output = path.join(dir, 'fullhd-av.mp4');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=9',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=9',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ];
  let encoded = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (encoded.status !== 0 || !fs.existsSync(output)) {
    const fallback = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=9',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=9',
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
  const error = new Error(`shared runtime never reached active playback: ${JSON.stringify({
    fileLoaded: last?.fileLoaded,
    lastError: last?.lastError,
    presentedFrames: last?.receiver?.presentedFrames,
    metrics: last?.metrics
  })}`);
  error.lastState = last;
  throw error;
}

function hostedGpuUnavailableIsOnlyBlocker(state) {
  const metrics = state?.metrics || {};
  const expected = 'Failed to import shared texture: GPU is not available';
  const tracks = Array.isArray(state?.tracks) ? state.tracks : [];
  const audioSelected = tracks.some(track => track?.type === 'audio' && track?.selected === true);
  return Boolean(
    process.env.LILAC_ALLOW_HOSTED_GPU_UNAVAILABLE === '1' &&
    state?.fileLoaded === true &&
    String(metrics.lastImportError || '') === expected &&
    Number(metrics.importFailures || 0) >= 8 &&
    Number(metrics.nativeFrames || 0) >= 8 &&
    Number(metrics.sentFrames || 0) === 0 &&
    Number(metrics.backpressure || 0) === 0 &&
    Number(metrics.commandFailures || 0) === 0 &&
    audioSelected &&
    String(state?.aid || '').toLowerCase() !== 'no'
  );
}

function delta(end, start, key) {
  return Math.max(0, Number(end?.[key] || 0) - Number(start?.[key] || 0));
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

    try {
      await waitForPlayback(bridge);
    } catch (error) {
      const state = error?.lastState || bridge.state();
      if (!hostedGpuUnavailableIsOnlyBlocker(state)) throw error;
      const report = {
        schema: 3,
        smoke: 'full-HD shared runtime hosted-GPU classification',
        classification: 'HOSTED_GPU_UNAVAILABLE_EXPECTED',
        releaseEligible: false,
        fileLoaded: state.fileLoaded,
        nativeFrames: state?.metrics?.nativeFrames,
        importFailures: state?.metrics?.importFailures,
        lastImportError: state?.metrics?.lastImportError,
        commandFailures: state?.metrics?.commandFailures,
        backpressure: state?.metrics?.backpressure,
        aid: state?.aid,
        audioCodec: state?.audioCodec,
        tracks: (Array.isArray(state?.tracks) ? state.tracks : []).filter(track => ['audio', 'video', 'sub'].includes(track?.type)),
        pass: false
      };
      writeEligibility({ releaseEligible: false, classification: report.classification });
      console.log(`LIBMPV_SHARED_RUNTIME_HOSTED_GPU_REPORT=${JSON.stringify(report)}`);
      console.log('LIBMPV_SHARED_RUNTIME_HOSTED_GPU_UNAVAILABLE_EXPECTED');
      return;
    }

    await sleep(WARMUP_MS);
    const measureStartedAt = performance.now();
    const measureStart = bridge.state();
    await sleep(MEASURE_MS);
    const measureEnd = bridge.state();
    const measureSeconds = Math.max(0.001, (performance.now() - measureStartedAt) / 1000);

    const sentDelta = delta(measureEnd?.metrics, measureStart?.metrics, 'sentFrames');
    const presentedDelta = delta(measureEnd?.receiver, measureStart?.receiver, 'presentedFrames');
    const receivedDelta = delta(measureEnd?.receiver, measureStart?.receiver, 'receivedFrames');
    const backpressureDelta = delta(measureEnd?.metrics, measureStart?.metrics, 'backpressure');
    const pumpDelta = delta(measureEnd?.metrics, measureStart?.metrics, 'pumpTicks');
    const measuredSentFps = sentDelta / measureSeconds;
    const measuredPresentedFps = presentedDelta / measureSeconds;
    const measuredReceivedFps = receivedDelta / measureSeconds;
    const measuredBackpressureRatio = backpressureDelta / Math.max(1, pumpDelta);

    const state = measureEnd;
    const beforeInput = await win.webContents.executeJavaScript('window.__runtimeSnapshot()');
    if (!beforeInput?.host || beforeInput.host.width < 1800 || beforeInput.host.height < 1000) {
      throw new Error(`full-HD host geometry regressed: ${JSON.stringify(beforeInput?.host)}`);
    }
    if (!beforeInput?.canvas || beforeInput.canvas.width < 1800 || beforeInput.canvas.height < 1000) {
      throw new Error(`full-HD canvas geometry regressed: ${JSON.stringify(beforeInput?.canvas)}`);
    }

    const avgRelease = Number(state?.metrics?.avgReleaseLatencyMs || 0);
    const maxRelease = Number(state?.metrics?.releaseLatencyMaxMs || 0);
    const avgDraw = Number(state?.receiver?.avgDrawMs || 0);
    const maxDraw = Number(state?.receiver?.maxDrawMs || 0);
    if (presentedDelta < Math.floor(MIN_PRESENT_FPS * measureSeconds)) {
      throw new Error(`shared presentation sample too low: ${presentedDelta} frames in ${measureSeconds.toFixed(3)}s`);
    }
    if (measuredPresentedFps < MIN_PRESENT_FPS) throw new Error(`measured shared presentation FPS too low: ${measuredPresentedFps.toFixed(3)}`);
    if (measuredSentFps < MIN_PRESENT_FPS) throw new Error(`measured shared send FPS too low: ${measuredSentFps.toFixed(3)}`);
    if (measuredBackpressureRatio > MAX_BACKPRESSURE_RATIO) throw new Error(`measured shared texture backpressure ratio too high: ${measuredBackpressureRatio.toFixed(4)}`);
    if (Number(state?.metrics?.importFailures || 0) !== 0) throw new Error(`shared texture import failures observed: ${state?.metrics?.lastImportError || 'unknown'}`);
    if (Number(state?.metrics?.sendFailures || 0) !== 0) throw new Error(`shared texture send failures observed: ${state?.metrics?.lastSendError || 'unknown'}`);
    if (Number(state?.receiver?.drawFailures || 0) !== 0) throw new Error('shared texture receiver draw failures observed');
    if (avgRelease > 100 || maxRelease > 300) throw new Error(`shared texture release latency too high: avg=${avgRelease} max=${maxRelease}`);

    const tracks = Array.isArray(state?.tracks) ? state.tracks : [];
    const selectedAudio = tracks.find(track => track?.type === 'audio' && track?.selected === true);
    if (!tracks.some(track => track?.type === 'audio')) throw new Error(`mpv did not enumerate fixture audio track: ${JSON.stringify(tracks)}`);
    if (!selectedAudio) throw new Error(`mpv did not select fixture audio track: aid=${state?.aid} tracks=${JSON.stringify(tracks)}`);
    if (String(state?.aid || '').toLowerCase() === 'no') throw new Error(`mpv aid remained disabled with an AAC fixture: ${state?.aid}`);

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
    const releaseMetrics = {
      measuredWindowMs: Math.round(measureSeconds * 1000),
      measuredSentFrames: sentDelta,
      measuredReceivedFrames: receivedDelta,
      measuredPresentedFrames: presentedDelta,
      measuredPumpTicks: pumpDelta,
      measuredBackpressure: backpressureDelta,
      measuredSentFps: Math.round(measuredSentFps * 1000) / 1000,
      measuredReceivedFps: Math.round(measuredReceivedFps * 1000) / 1000,
      measuredPresentedFps: Math.round(measuredPresentedFps * 1000) / 1000,
      measuredBackpressureRatio: Math.round(measuredBackpressureRatio * 1000000) / 1000000,
      avgReleaseLatencyMs: final?.metrics?.avgReleaseLatencyMs,
      releaseLatencyMaxMs: final?.metrics?.releaseLatencyMaxMs,
      receiverAvgDrawMs: final?.receiver?.avgDrawMs,
      receiverMaxDrawMs: final?.receiver?.maxDrawMs
    };
    const report = {
      schema: 3,
      smoke: 'full-HD libmpv sharedTexture sustained presentation + AV + input',
      classification: 'SHARED_TEXTURE_PRESENTATION_VERIFIED',
      releaseEligible: true,
      acceptance: { minPresentedFps: MIN_PRESENT_FPS, maxBackpressureRatio: MAX_BACKPRESSURE_RATIO },
      geometry: { host: beforeInput.host, canvas: beforeInput.canvas },
      throughput: releaseMetrics,
      audio: {
        aid: final?.aid,
        audioCodec: final?.audioCodec,
        currentAo: final?.currentAo,
        tracks: (Array.isArray(final?.tracks) ? final.tracks : []).filter(track => ['audio', 'video', 'sub'].includes(track?.type))
      },
      input: { clicks: afterInput.probe.clicks, keys: afterInput.probe.keys, clickLatencyMs: clickLatency, keyLatencyMs: keyLatency },
      pass: true
    };
    writeEligibility({ releaseEligible: true, classification: report.classification, metrics: releaseMetrics });
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
  try { writeEligibility({ releaseEligible: false, classification: 'SHARED_RUNTIME_FAILED' }); } catch {}
  console.error(error?.stack || error);
  app.exit(1);
});

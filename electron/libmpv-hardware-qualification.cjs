'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const { createLibmpvSharedBridge } = require('./libmpv-shared-main.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const VERIFY_ONLY = process.argv.includes('--verify-only');
const MIN_PRESENT_FPS = 20;
const MAX_BACKPRESSURE_RATIO = 0.20;
const WARMUP_MS = 1000;
const MEASURE_MS = 4000;
const EXPECTED_ELECTRON = '43.8.1';
const RESULT_NAME = 'LilacLibmpvHardwareQualification-result.json';

function safeError(error) {
  return String(error?.message || error || 'unknown')
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
    .replace(/\\\\\.\\pipe\\[^\s"']+/gi, '[pipe]')
    .slice(0, 360);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function appFile(relative) {
  return path.join(app.getAppPath(), ...String(relative).split('/'));
}

function unpackedElectronFile(name) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', name);
  }
  return path.join(__dirname, name);
}

function resourceFile(relative) {
  return path.join(process.resourcesPath, ...String(relative).split('/'));
}

function readText(relative) {
  return fs.readFileSync(appFile(relative), 'utf8');
}

function readManifest() {
  const file = resourceFile('release-probe/qualification-manifest.json');
  if (!fs.existsSync(file)) throw new Error('qualification manifest is missing');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schema !== 1 || value?.qualificationId !== 'LILAC-LIBMPV-HWQ-R1') {
    throw new Error('qualification manifest schema mismatch');
  }
  return value;
}

function verifyPayload(manifest) {
  if (process.versions.electron !== EXPECTED_ELECTRON) {
    throw new Error(`Electron version mismatch: ${process.versions.electron}`);
  }
  if (manifest?.electronVersion !== EXPECTED_ELECTRON) {
    throw new Error('manifest Electron version mismatch');
  }
  if (manifest?.ciAttestation?.appWorkflowConclusion !== 'success' || manifest?.ciAttestation?.bridgeWorkflowConclusion !== 'success') {
    throw new Error('upstream CI attestation is not successful');
  }

  const locations = {
    'electron/lilac-libmpv-player-bridge.node': unpackedElectronFile('lilac-libmpv-player-bridge.node'),
    'electron/libmpv-2.dll': unpackedElectronFile('libmpv-2.dll'),
    'electron/libmpv-shared-main.cjs': appFile('electron/libmpv-shared-main.cjs'),
    'electron/preload-libmpv-shared.generated.cjs': appFile('electron/preload-libmpv-shared.generated.cjs'),
    'src/libmpv-shared-entry.js': appFile('src/libmpv-shared-entry.js'),
    'src/libmpv-shared.generated.js': appFile('src/libmpv-shared.generated.js'),
    'electron/libmpv-hardware-qualification.cjs': appFile('electron/libmpv-hardware-qualification.cjs'),
    'release-probe/fullhd-av.mp4': resourceFile('release-probe/fullhd-av.mp4')
  };

  const verified = {};
  for (const [key, expected] of Object.entries(manifest.payloadSha256 || {})) {
    const file = locations[key];
    if (!file || !fs.existsSync(file)) throw new Error(`qualified payload file missing: ${key}`);
    const actual = sha256(file);
    if (actual !== String(expected).toLowerCase()) throw new Error(`qualified payload hash mismatch: ${key}`);
    verified[key] = actual;
  }

  const bridge = readText('electron/libmpv-shared-main.cjs');
  const preload = readText('electron/preload-libmpv-shared.generated.cjs');
  const entry = readText('src/libmpv-shared-entry.js');
  const bundle = readText('src/libmpv-shared.generated.js');
  const architecture = {
    runtimeRevisionR2: bridge.includes("runtimeRevision: 'FRAME-INPUT-SUBTITLE-R2'") && entry.includes("runtimeRevision: 'FRAME-INPUT-SUBTITLE-R2'"),
    pacedPump: bridge.includes('effectiveSentFps') && bridge.includes('backpressureRatio') && !bridge.includes('schedulePump(5)'),
    commandNormalization: bridge.includes("originalName === 'set_property'") && bridge.includes("commandArray = ['set', safeProperty, encodedValue]"),
    safeDiagnostics: bridge.includes('lastImportError') && bridge.includes('lastCommandError'),
    immediateFrameRelease: !preload.includes('await nextFrame()') && !preload.includes('const nextFrame'),
    drawDiagnostics: preload.includes('avgDrawMs'),
    lilacOnlySubtitles: !entry.includes("['sub-add'") && !bundle.includes("['sub-add'"),
    nonInterceptingVideoSurface: entry.includes('pointer-events:none')
  };
  if (Object.values(architecture).some(value => value !== true)) {
    throw new Error(`qualified runtime architecture mismatch: ${JSON.stringify(architecture)}`);
  }
  return { verified, architecture };
}

function delta(end, start, key) {
  return Math.max(0, Number(end?.[key] || 0) - Number(start?.[key] || 0));
}

async function waitForState(bridge, label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = bridge.state();
    if (predicate(last)) return last;
    await sleep(50);
  }
  throw new Error(`${label} timed out: ${safeError(last?.lastError || last?.bridgeLastError || 'state did not converge')}`);
}

function safeTrackSummary(state) {
  return (Array.isArray(state?.tracks) ? state.tracks : [])
    .filter(track => ['audio', 'video', 'sub'].includes(track?.type))
    .slice(0, 16)
    .map(track => ({
      type: track?.type || null,
      codec: track?.codec || null,
      lang: track?.lang || null,
      selected: track?.selected === true,
      default: track?.default === true
    }));
}

function buildHtml(dir) {
  const bundleSource = appFile('src/libmpv-shared.generated.js');
  const runtimeCopy = path.join(dir, 'libmpv-shared.generated.js');
  fs.copyFileSync(bundleSource, runtimeCopy);
  const html = path.join(dir, 'qualification.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
#immersivePlayer,#videoStage{position:relative}
lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#probeButton{position:absolute;z-index:20;left:32px;top:32px;width:220px;height:72px;border:0;border-radius:12px;background:#fff;color:#111;font:600 18px sans-serif}
#status{position:absolute;z-index:20;left:32px;bottom:28px;padding:12px 16px;border-radius:10px;background:rgba(0,0,0,.72);color:#fff;font:16px sans-serif}
</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video><button id="probeButton" type="button">Lilac input probe</button><div id="status">GPU qualification running…</div></div></div></section>
<script src="./libmpv-shared.generated.js"></script><script>
window.__runtimeProbe={clicks:0,keys:0,lastClickAt:0,lastKeyAt:0};
document.querySelector('#probeButton').addEventListener('click',()=>{window.__runtimeProbe.clicks++;window.__runtimeProbe.lastClickAt=Date.now()});
window.addEventListener('keydown',()=>{window.__runtimeProbe.keys++;window.__runtimeProbe.lastKeyAt=Date.now()},true);
window.__startSharedQualification=async src=>{await customElements.whenDefined('lilac-mpv-video');const video=document.querySelector('#video');await video.openLilacSource(src,{hls:false,headers:{}});await video.play();return true};
window.__runtimeSnapshot=()=>{const host=document.querySelector('#video');const canvas=host?.shadowRoot?.querySelector('canvas[data-lilac-libmpv-surface]');const rect=host?.getBoundingClientRect?.();const button=document.querySelector('#probeButton').getBoundingClientRect();return{probe:{...window.__runtimeProbe},host:rect?{width:rect.width,height:rect.height}:null,canvas:canvas?{width:canvas.width,height:canvas.height}:null,button:{x:button.left+button.width/2,y:button.top+button.height/2}}};
</script></body></html>`, 'utf8');
  return html;
}

async function runQualification() {
  let stage = 'payload-verification';
  let bridge = null;
  let win = null;
  let workDir = null;
  const manifest = readManifest();
  const payload = verifyPayload(manifest);
  const baseReport = {
    schema: 1,
    qualificationId: manifest.qualificationId,
    commitSha: manifest.commitSha,
    upstream: {
      appRunId: manifest?.ciAttestation?.appWorkflowRunId || null,
      bridgeRunId: manifest?.ciAttestation?.bridgeWorkflowRunId || null
    },
    electronVersion: process.versions.electron,
    libmpvArchiveSha256: manifest.libmpvArchiveSha256,
    acceptance: { minPresentedFps: MIN_PRESENT_FPS, maxBackpressureRatio: MAX_BACKPRESSURE_RATIO },
    payloadVerified: true,
    architecture: payload.architecture
  };

  if (VERIFY_ONLY) {
    const report = { ...baseReport, status: 'pass', classification: 'PACKAGED_PAYLOAD_VERIFIED', pass: true };
    console.log(`LILAC_LIBMPV_HWQ_VERIFY_REPORT=${JSON.stringify(report)}`);
    return report;
  }

  try {
    stage = 'runtime-start';
    process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-hwq-'));
    const html = buildHtml(workDir);
    const fixture = resourceFile('release-probe/fullhd-av.mp4');
    if (!fs.existsSync(fixture)) throw new Error('qualified full-HD fixture is missing');

    bridge = createLibmpvSharedBridge({ app, ipcMain, headersFor: () => ({}), userAgent: 'Lilac hardware qualification' });
    await bridge.ensure();

    win = new BrowserWindow({
      show: true,
      frame: false,
      useContentSize: true,
      width: 1920,
      height: 1080,
      backgroundColor: '#000000',
      webPreferences: {
        preload: appFile('electron/preload-libmpv-shared.generated.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    await bridge.attachWindow(win);
    await win.loadFile(html);
    win.focus();
    await win.webContents.executeJavaScript(`window.__startSharedQualification(${JSON.stringify(pathToFileURL(fixture).href)})`);

    stage = 'active-playback';
    await waitForState(bridge, 'active playback', state => state?.fileLoaded === true && Number(state?.receiver?.presentedFrames || 0) >= 8, 15000);

    stage = 'sustained-throughput';
    await sleep(WARMUP_MS);
    const startedAt = Date.now();
    const start = bridge.state();
    await sleep(MEASURE_MS);
    const end = bridge.state();
    const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const sent = delta(end?.metrics, start?.metrics, 'sentFrames');
    const received = delta(end?.receiver, start?.receiver, 'receivedFrames');
    const presented = delta(end?.receiver, start?.receiver, 'presentedFrames');
    const pumpTicks = delta(end?.metrics, start?.metrics, 'pumpTicks');
    const backpressure = delta(end?.metrics, start?.metrics, 'backpressure');
    const sentFps = sent / seconds;
    const receivedFps = received / seconds;
    const presentedFps = presented / seconds;
    const backpressureRatio = backpressure / Math.max(1, pumpTicks);
    const throughput = {
      measuredWindowMs: Math.round(seconds * 1000),
      measuredSentFrames: sent,
      measuredReceivedFrames: received,
      measuredPresentedFrames: presented,
      measuredPumpTicks: pumpTicks,
      measuredBackpressure: backpressure,
      measuredSentFps: Math.round(sentFps * 1000) / 1000,
      measuredReceivedFps: Math.round(receivedFps * 1000) / 1000,
      measuredPresentedFps: Math.round(presentedFps * 1000) / 1000,
      measuredBackpressureRatio: Math.round(backpressureRatio * 1000000) / 1000000,
      avgReleaseLatencyMs: Number(end?.metrics?.avgReleaseLatencyMs || 0),
      releaseLatencyMaxMs: Number(end?.metrics?.releaseLatencyMaxMs || 0),
      receiverAvgDrawMs: Number(end?.receiver?.avgDrawMs || 0),
      receiverMaxDrawMs: Number(end?.receiver?.maxDrawMs || 0),
      importFailures: Number(end?.metrics?.importFailures || 0),
      sendFailures: Number(end?.metrics?.sendFailures || 0),
      drawFailures: Number(end?.receiver?.drawFailures || 0)
    };
    if (presentedFps < MIN_PRESENT_FPS) throw new Error(`presented FPS below release threshold: ${throughput.measuredPresentedFps}`);
    if (sentFps < MIN_PRESENT_FPS) throw new Error(`sent FPS below release threshold: ${throughput.measuredSentFps}`);
    if (backpressureRatio > MAX_BACKPRESSURE_RATIO) throw new Error(`backpressure ratio above release threshold: ${throughput.measuredBackpressureRatio}`);
    if (throughput.importFailures !== 0) throw new Error(`shared texture import failures: ${safeError(end?.metrics?.lastImportError)}`);
    if (throughput.sendFailures !== 0) throw new Error(`shared texture send failures: ${safeError(end?.metrics?.lastSendError)}`);
    if (throughput.drawFailures !== 0) throw new Error('shared texture renderer draw failure observed');
    if (throughput.avgReleaseLatencyMs > 100 || throughput.releaseLatencyMaxMs > 300) {
      throw new Error(`shared texture release latency too high: avg=${throughput.avgReleaseLatencyMs} max=${throughput.releaseLatencyMaxMs}`);
    }

    stage = 'geometry-audio-codec';
    const beforeInput = await win.webContents.executeJavaScript('window.__runtimeSnapshot()');
    if (!beforeInput?.host || beforeInput.host.width < 1800 || beforeInput.host.height < 1000) throw new Error('full-HD host geometry not reached');
    if (!beforeInput?.canvas || beforeInput.canvas.width < 1800 || beforeInput.canvas.height < 1000) throw new Error('full-HD canvas geometry not reached');
    const tracks = safeTrackSummary(end);
    const selectedAudio = tracks.find(track => track.type === 'audio' && track.selected === true);
    const selectedVideo = tracks.find(track => track.type === 'video' && track.selected === true) || tracks.find(track => track.type === 'video');
    if (!selectedAudio || String(end?.aid || '').toLowerCase() === 'no') throw new Error('AAC fixture audio was not selected');
    const audioCodecText = `${end?.audioCodec || ''} ${selectedAudio?.codec || ''}`;
    if (!/aac/i.test(audioCodecText)) throw new Error(`fixture audio codec is not AAC: ${audioCodecText.trim() || 'unknown'}`);
    const videoCodecText = `${end?.videoCodec || ''} ${selectedVideo?.codec || ''}`;
    if (!/h264|avc/i.test(videoCodecText)) throw new Error(`fixture video codec is not H.264: ${videoCodecText.trim() || 'unknown'}`);
    const media = {
      aid: end?.aid ?? null,
      audioCodec: end?.audioCodec ?? selectedAudio?.codec ?? null,
      currentAo: end?.currentAo ?? null,
      videoCodec: end?.videoCodec ?? selectedVideo?.codec ?? null,
      hwdecCurrent: end?.hwdecCurrent ?? null,
      tracks
    };

    stage = 'renderer-input';
    const clickStartedAt = Date.now();
    const x = Math.round(beforeInput.button.x);
    const y = Math.round(beforeInput.button.y);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 1, movementY: 1 });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
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
    if (afterInput?.probe?.clicks < 1 || clickLatency > 500) throw new Error(`pointer input failed or stalled: ${Number.isFinite(clickLatency) ? clickLatency : 'none'}ms`);
    if (afterInput?.probe?.keys < 1 || keyLatency > 500) throw new Error(`keyboard input failed or stalled: ${Number.isFinite(keyLatency) ? keyLatency : 'none'}ms`);
    const input = { clicks: afterInput.probe.clicks, keys: afterInput.probe.keys, clickLatencyMs: clickLatency, keyLatencyMs: keyLatency };

    stage = 'command-roundtrip';
    let result = bridge.command(['set_property', 'pause', true]);
    if (!result?.ok) throw new Error(`pause command rejected: ${safeError(result?.error)}`);
    const paused = await waitForState(bridge, 'pause readback', state => state?.paused === true);
    const pausedAt = Number(paused.time);
    await sleep(350);
    const pausedStable = bridge.state();
    const pausedDrift = Math.abs(Number(pausedStable.time) - pausedAt);
    if (!Number.isFinite(pausedDrift) || pausedDrift > 0.25) throw new Error(`paused clock drift too high: ${pausedDrift}`);

    result = bridge.command(['set_property', 'volume', 37]);
    if (!result?.ok) throw new Error('volume command rejected');
    const volumeState = await waitForState(bridge, 'volume readback', state => Math.abs(Number(state?.volume) - 37) <= 0.5);

    result = bridge.command(['set_property', 'speed', 1.5]);
    if (!result?.ok) throw new Error('speed command rejected');
    const speedState = await waitForState(bridge, 'speed readback', state => Math.abs(Number(state?.speed) - 1.5) <= 0.02);

    result = bridge.command(['set_property', 'time-pos', 4]);
    if (!result?.ok) throw new Error('seek command rejected');
    const seekState = await waitForState(bridge, 'seek readback', state => Number(state?.time) >= 3.7 && Number(state?.time) <= 4.3);

    result = bridge.command(['set_property', 'pause', false]);
    if (!result?.ok) throw new Error('play command rejected');
    const playing = await waitForState(bridge, 'play readback', state => state?.paused === false);
    const playStart = Number(playing.time);
    await sleep(700);
    const finalState = bridge.state();
    const playAdvance = Number(finalState.time) - playStart;
    if (!Number.isFinite(playAdvance) || playAdvance < 0.45) throw new Error(`playback clock did not advance: ${playAdvance}`);
    if (Number(finalState?.metrics?.commandFailures || 0) !== 0) {
      throw new Error(`native command failure recorded: ${safeError(JSON.stringify(finalState?.metrics?.lastCommandError || null))}`);
    }
    const commands = {
      paused: paused.paused === true,
      pausedClockDriftSec: Math.round(pausedDrift * 1000) / 1000,
      volume: volumeState.volume,
      speed: speedState.speed,
      seekTime: seekState.time,
      playAdvanceSec: Math.round(playAdvance * 1000) / 1000,
      commandFailures: Number(finalState?.metrics?.commandFailures || 0)
    };

    stage = 'complete';
    return {
      ...baseReport,
      status: 'pass',
      classification: 'HARDWARE_SHARED_TEXTURE_RELEASE_GATE_PASS',
      pass: true,
      stage,
      geometry: { host: beforeInput.host, canvas: beforeInput.canvas },
      throughput,
      media,
      input,
      commands,
      subtitleArchitecture: {
        lilacOnlyRenderer: payload.architecture.lilacOnlySubtitles,
        nativeSubtitleRendererLockedOutByCiGate: manifest?.ciAttestation?.nativeSubtitleRendererLockedOut === true
      }
    };
  } catch (error) {
    let state = null;
    try { state = bridge?.state?.(); } catch {}
    return {
      ...baseReport,
      status: 'fail',
      classification: 'HARDWARE_SHARED_TEXTURE_RELEASE_GATE_FAIL',
      pass: false,
      stage,
      error: safeError(error),
      diagnostics: state ? {
        fileLoaded: state?.fileLoaded === true,
        paused: state?.paused === true,
        time: Number.isFinite(Number(state?.time)) ? Number(state.time) : null,
        aid: state?.aid ?? null,
        audioCodec: state?.audioCodec ?? null,
        currentAo: state?.currentAo ?? null,
        videoCodec: state?.videoCodec ?? null,
        hwdecCurrent: state?.hwdecCurrent ?? null,
        pendingFrames: Number(state?.pendingFrames || 0),
        metrics: {
          sentFrames: Number(state?.metrics?.sentFrames || 0),
          backpressure: Number(state?.metrics?.backpressure || 0),
          backpressureRatio: Number(state?.metrics?.backpressureRatio || 0),
          importFailures: Number(state?.metrics?.importFailures || 0),
          sendFailures: Number(state?.metrics?.sendFailures || 0),
          commandFailures: Number(state?.metrics?.commandFailures || 0),
          lastImportError: state?.metrics?.lastImportError ? safeError(state.metrics.lastImportError) : null,
          lastSendError: state?.metrics?.lastSendError ? safeError(state.metrics.lastSendError) : null,
          lastCommandError: state?.metrics?.lastCommandError || null,
          avgReleaseLatencyMs: Number(state?.metrics?.avgReleaseLatencyMs || 0),
          releaseLatencyMaxMs: Number(state?.metrics?.releaseLatencyMaxMs || 0)
        },
        receiver: {
          receivedFrames: Number(state?.receiver?.receivedFrames || 0),
          presentedFrames: Number(state?.receiver?.presentedFrames || 0),
          drawFailures: Number(state?.receiver?.drawFailures || 0),
          avgDrawMs: Number(state?.receiver?.avgDrawMs || 0),
          maxDrawMs: Number(state?.receiver?.maxDrawMs || 0)
        },
        tracks: safeTrackSummary(state)
      } : null
    };
  } finally {
    try { await bridge?.dispose?.(); } catch {}
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function persistAndShow(report) {
  const text = JSON.stringify(report, null, 2);
  console.log(`LILAC_LIBMPV_HARDWARE_QUALIFICATION=${JSON.stringify(report)}`);
  try { clipboard.writeText(text); } catch {}
  let resultPath = null;
  try {
    resultPath = path.join(app.getPath('downloads'), RESULT_NAME);
    fs.writeFileSync(resultPath, `${text}\n`, 'utf8');
  } catch {}
  if (VERIFY_ONLY) return;

  const throughput = report?.throughput || report?.diagnostics?.metrics || {};
  const detail = report.pass
    ? `PASS\nPresented ${report.throughput.measuredPresentedFps} fps / Sent ${report.throughput.measuredSentFps} fps\nBackpressure ${(report.throughput.measuredBackpressureRatio * 100).toFixed(1)}%\nRelease latency avg ${report.throughput.avgReleaseLatencyMs} ms, max ${report.throughput.releaseLatencyMaxMs} ms\n\nResult JSON was copied to the clipboard${resultPath ? ' and saved to Downloads.' : '.'}`
    : `FAIL at ${report.stage}\n${report.error || 'Unknown qualification failure'}\n\nSent frames: ${throughput.sentFrames ?? 'n/a'}\nBackpressure: ${throughput.backpressureRatio != null ? `${(Number(throughput.backpressureRatio) * 100).toFixed(1)}%` : 'n/a'}\n\nThe safe result JSON was copied to the clipboard${resultPath ? ' and saved to Downloads.' : '.'}`;
  try {
    await dialog.showMessageBox({
      type: report.pass ? 'info' : 'error',
      title: report.pass ? 'Lilac hardware qualification PASS' : 'Lilac hardware qualification FAIL',
      message: report.pass ? 'Lilac libmpv sharedTexture hardware release gate passed.' : 'Lilac libmpv sharedTexture hardware release gate did not pass.',
      detail,
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    });
  } catch {}
}

app.whenReady().then(async () => {
  const report = await runQualification();
  await persistAndShow(report);
  app.exit(report.pass ? 0 : 1);
}).catch(async error => {
  const report = {
    schema: 1,
    qualificationId: 'LILAC-LIBMPV-HWQ-R1',
    status: 'fail',
    classification: 'HARDWARE_SHARED_TEXTURE_RELEASE_GATE_FAIL',
    pass: false,
    stage: 'boot',
    error: safeError(error)
  };
  try { await persistAndShow(report); } catch {}
  app.exit(1);
});

app.on('window-all-closed', () => {});

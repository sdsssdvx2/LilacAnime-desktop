'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');

// Test-only hosted-runner compatibility. GitHub's Windows VM can create the
// native D3D11 texture while Chromium's sandboxed GPU child still reports that
// no GPU is available. Keep ANGLE/D3D11 and the real product renderer intact;
// only remove the GPU-process sandbox for this qualification process.
app.commandLine.appendSwitch('disable-gpu-sandbox');

let r37NodeApiCallbackWarnings = 0;
const r37RawAckEvents = [];
process.on('warning', warning => {
  if (warning?.code === 'DEP0168' || String(warning?.message || '').includes('Uncaught Node-API callback exception')) {
    r37NodeApiCallbackWarnings += 1;
    console.error(`R37_NODE_API_CALLBACK_WARNING count=${r37NodeApiCallbackWarnings} ${String(warning?.stack || warning?.message || warning)}`);
  }
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R37 explicit renderer handoff e2e smoke exceeded 150s hard deadline');
  process.exit(124);
}, 150000);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r37-e2e.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=40',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=40',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
    '-c:a','aac','-shortest',out
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed ${String(result.stderr || '').slice(0, 240)}`);
  return out;
}
function subtitleFixture(dir) {
  const out = path.join(dir, 'r37-e2e.vtt');
  fs.writeFileSync(out, 'WEBVTT\n\n00:00:00.000 --> 00:00:39.000\nR37 subtitle ownership smoke\n', 'utf8');
  return out;
}
function productHtml(dir) {
  const sourceBundle = path.resolve(__dirname, '..', 'src', 'libmpv-shared.generated.js');
  if (!fs.existsSync(sourceBundle)) throw new Error(`generated product renderer bundle missing: ${sourceBundle}`);
  fs.copyFileSync(sourceBundle, path.join(dir, 'libmpv-shared.generated.js'));
  const html = path.join(dir, 'r37-e2e.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#202020}
#immersivePlayer,#videoStage{position:relative}
lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#warmGpu{position:absolute;left:0;top:0;width:16px;height:16px;opacity:.01;pointer-events:none}
</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video><canvas id="warmGpu" width="16" height="16"></canvas></div></div></section>
<script src="./libmpv-shared.generated.js"></script><script>
window.__r37GpuWarmup=async()=>{
  if(!navigator.gpu)return{ok:false,error:'navigator.gpu unavailable'};
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)return{ok:false,error:'WebGPU adapter unavailable'};
  const device=await adapter.requestDevice();
  const canvas=document.querySelector('#warmGpu');
  const context=canvas.getContext('webgpu');
  if(!context)return{ok:false,error:'WebGPU context unavailable'};
  const format=navigator.gpu.getPreferredCanvasFormat();
  context.configure({device,format,alphaMode:'opaque'});
  const encoder=device.createCommandEncoder();
  const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0.04,g:0.08,b:0.12,a:1},loadOp:'clear',storeOp:'store'}]});
  pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  window.__r37WarmDevice=device;
  return{ok:true,format};
};
window.__startR37E2E=async src=>{
  await customElements.whenDefined('lilac-mpv-video');
  const video=document.querySelector('#video');
  await video.openLilacSource(src,{hls:false,headers:{}});
  await video.play();
  return true;
};
window.__r37SurfaceSnapshot=()=>{const host=document.querySelector('#video');const canvas=host?.shadowRoot?.querySelector('canvas[data-lilac-libmpv-surface]');const rect=host?.getBoundingClientRect?.();return{host:rect?{width:rect.width,height:rect.height}:null,canvas:canvas?{width:canvas.width,height:canvas.height}:null,focused:document.hasFocus(),visibility:String(document.visibilityState||'unknown')};};
</script></body></html>`, 'utf8');
  return html;
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
function compactAckDiagnostic(view) {
  return {
    focusActive: view?.focus?.active,
    handoffPending: view?.handoff?.pending,
    handoffMinFrameId: view?.handoff?.minFrameId,
    subtitleVisible: view?.handoff?.subtitleVisible,
    r36: {
      sentFrames: view?.r36?.sentFrames,
      releasedFrames: view?.r36?.releasedFrames,
      ackCompletions: view?.r36?.ackCompletions,
      failOpenCount: view?.r36?.failOpenCount
    },
    r37: view?.r37,
    metrics: {
      nativeFrames: view?.state?.metrics?.nativeFrames,
      sentFrames: view?.state?.metrics?.sentFrames,
      sendFailures: view?.state?.metrics?.sendFailures,
      importFailures: view?.state?.metrics?.importFailures,
      lastFrameId: view?.state?.metrics?.lastFrameId
    },
    receiver: view?.state?.receiver,
    producer: view?.state?.frameProducer
  };
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
  const ackStartIndex = r37RawAckEvents.length;
  main.show();
  main.focus();
  await waitUntil(() => main.isFocused(), 3000, `${label} refocus`);
  let completed;
  try {
    completed = await waitUntil(() => {
      const view = r37State(bridge);
      return Number(view.r37.rendererAckCompletions || 0) >= expectedAck && view.handoff.pending === false && view.focus.active === false ? view : null;
    }, 1200, `${label} explicit renderer ACK`);
  } catch (error) {
    const view = r37State(bridge);
    const surface = await main.webContents.executeJavaScript('window.__r37SurfaceSnapshot()').catch(() => null);
    const rawAcks = r37RawAckEvents.slice(ackStartIndex).slice(-8);
    console.error(`R37_ACK_TIMEOUT_DIAGNOSTIC label=${label} rawAckCount=${rawAcks.length} rawAcks=${JSON.stringify(rawAcks)} surface=${JSON.stringify(surface)} state=${JSON.stringify(compactAckDiagnostic(view))}`);
    throw error;
  }
  const elapsed = Date.now() - started;
  if (Number(completed.r36.failOpenCount || 0) !== 0) throw new Error(`${label} used R36 fail-open count=${completed.r36.failOpenCount}`);
  if (Number(completed.r37.rejectedRendererAcks || 0) !== 0) throw new Error(`${label} rejected ACK count=${completed.r37.rejectedRendererAcks}`);
  if (elapsed >= 1200) throw new Error(`${label} ACK too slow elapsed=${elapsed}`);
  return { elapsed, lastAckLatencyMs:Number(completed.r37.lastAckLatencyMs || 0) };
}

(async () => {
  await app.whenReady();
  if (!process.env.LILAC_LIBMPV_PLAYER_ADDON || !process.env.LILAC_LIBMPV_DLL) throw new Error('R37 addon/dll env missing');
  if (app.isHardwareAccelerationEnabled?.() === false) throw new Error('Electron hardware acceleration is disabled');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r37-e2e-'));
  let main, other, bridge;
  const rawAckListener = (event, payload = {}) => {
    r37RawAckEvents.push({
      wallMs: Date.now(),
      senderId: Number(event?.sender?.id) || 0,
      epoch: Number(payload?.epoch) || 0,
      playerId: Number(payload?.playerId) || 0,
      generation: Number(payload?.generation) || 0,
      frameId: Number(payload?.frameId) || 0,
      marker: String(payload?.marker || '')
    });
    while (r37RawAckEvents.length > 32) r37RawAckEvents.shift();
  };
  ipcMain.on('libmpv-shared:r37-handoff-presented', rawAckListener);
  try {
    bridge = createLibmpvSharedBridge({ app, ipcMain });
    await bridge.ensure();

    const preload = path.resolve(__dirname, '..', 'electron', 'preload-libmpv-shared.generated.cjs');
    if (!fs.existsSync(preload)) throw new Error(`generated product preload missing: ${preload}`);
    const html = productHtml(dir);
    main = new BrowserWindow({
      show:true, width:800, height:600, backgroundColor:'#202020',
      webPreferences:{ preload, backgroundThrottling:false, contextIsolation:true, nodeIntegration:false, sandbox:true }
    });
    await bridge.attachWindow(main);
    other = new BrowserWindow({ show:false, width:320, height:240, backgroundColor:'#303030', webPreferences:{ backgroundThrottling:false } });
    await main.loadFile(html);
    await other.loadURL('data:text/html,<body style="background:%23303030"></body>');
    main.focus();
    await waitUntil(() => main.isFocused(), 3000, 'initial focus');

    let gpuInfo = null;
    try { gpuInfo = await app.getGPUInfo('complete'); } catch (error) { throw new Error(`GPU info unavailable: ${String(error?.message || error)}`); }
    const warm = await main.webContents.executeJavaScript('window.__r37GpuWarmup()');
    if (!warm?.ok) throw new Error(`renderer WebGPU warmup failed ${JSON.stringify(warm)}`);

    const media = pathToFileURL(fixture(dir)).href;
    const started = await main.webContents.executeJavaScript(`window.__startR37E2E(${JSON.stringify(media)})`);
    if (started !== true) throw new Error('product lilac-mpv-video start returned false');

    try {
      await waitUntil(() => {
        const state = bridge.state();
        return state?.fileLoaded === true && Number(state?.metrics?.sentFrames || 0) >= 5 && Number(state?.receiver?.presentedFrames || 0) >= 5;
      }, 15000, 'focused playback baseline');
    } catch (error) {
      const surface = await main.webContents.executeJavaScript('window.__r37SurfaceSnapshot()').catch(() => null);
      throw new Error(`focused playback baseline failed gpuFeature=${JSON.stringify(app.getGPUFeatureStatus?.() || null)} gpuDeviceCount=${Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice.length : 0} surface=${JSON.stringify(surface)} state=${JSON.stringify(bridge.state())} cause=${String(error?.message || error)}`);
    }

    const baseline = bridge.state();
    if (Number(baseline?.metrics?.importFailures || 0) !== 0) throw new Error(`baseline shared texture import failures=${baseline.metrics.importFailures} last=${baseline.metrics.lastImportError}`);
    if (Number(baseline?.metrics?.sendFailures || 0) !== 0) throw new Error(`baseline shared texture send failures=${baseline.metrics.sendFailures} last=${baseline.metrics.lastSendError}`);
    if (baseline?.receiver?.rendererMode && baseline.receiver.rendererMode !== 'direct-receive-webgpu-copy' && baseline.receiver.rendererMode !== 'webgpu-copy') {
      throw new Error(`unexpected product receiver mode ${baseline.receiver.rendererMode}`);
    }

    const regionBefore = r37State(bridge);
    const nativeRegionBefore = Number(regionBefore.state?.r32NativePresenter?.r36UiRegionUpdates || 0);
    const clearBefore = Number(regionBefore.r37.regionNativeClears || 0);
    for (let i = 0; i < 12; i += 1) {
      await main.webContents.executeJavaScript(`window.lilac.libmpvSharedResize({r36UiHolesOnly:true,uiHoles:[${20+i},${30+i},120,60]})`);
    }
    await sleep(120);
    const regionAfter = r37State(bridge);
    const nativeRegionAfter = Number(regionAfter.state?.r32NativePresenter?.r36UiRegionUpdates || 0);
    if (nativeRegionAfter !== nativeRegionBefore) throw new Error(`R37 repeated UI-hole payload mutated HWND region delta=${nativeRegionAfter-nativeRegionBefore}`);
    if (Number(regionAfter.r37.regionNativeClears || 0) > Math.max(1, clearBefore)) throw new Error(`R37 repeated UI-hole payload performed extra native clears count=${regionAfter.r37.regionNativeClears}`);
    if (Number(regionAfter.r37.regionSyncCalls || 0) < Number(regionBefore.r37.regionSyncCalls || 0) + 12) throw new Error('R37 UI-hole compatibility payloads did not exercise region sync gate');

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
    if (Number(final.state?.metrics?.importFailures || 0) !== 0 || Number(final.state?.metrics?.sendFailures || 0) !== 0) throw new Error('R37 E2E transport recorded import/send failure');
    if (Number(final.r37.regionNativeClears || 0) > 1) throw new Error(`R37 native region clear count exceeded one: ${final.r37.regionNativeClears}`);
    if (r37NodeApiCallbackWarnings !== 0) throw new Error(`R37 Node-API callback warnings observed count=${r37NodeApiCallbackWarnings}`);

    console.log(`R37_EXPLICIT_HANDOFF_E2E_OK cycles=3 activeMs=${active.elapsed} pausedSubtitleMs=${pausedSubtitle.elapsed} pausedNoSubtitleMs=${pausedNoSubtitle.elapsed} rendererAckCompletions=${final.r37.rendererAckCompletions} failOpenCount=0 rejectedAcks=0 uiHoles=0 regionNativeClears=${final.r37.regionNativeClears} nodeApiCallbackWarnings=0 realProductPreload=1 realProductRenderer=1 realSharedTexture=1`);
  } finally {
    clearTimeout(hardDeadline);
    try { ipcMain.removeListener('libmpv-shared:r37-handoff-presented', rawAckListener); } catch {}
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
  try { app.quit(); } catch {}
  process.exit(1);
});

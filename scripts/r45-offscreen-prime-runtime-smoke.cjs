'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');

app.commandLine.appendSwitch('disable-gpu-sandbox');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => { console.error('R45 tiny-prime smoke exceeded 180s'); process.exit(124); }, 180000);

function makeFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r45-prime-red.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','color=c=0xd02020:size=640x360:rate=24000/1001:duration=40',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=40',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','24',
    '-c:a','aac','-shortest',out
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture creation failed ${String(result.stderr || '').slice(0,240)}`);
  return out;
}

function writeHarness(dir) {
  const bundle = path.resolve(__dirname, '..', 'src', 'libmpv-shared.generated.js');
  if (!fs.existsSync(bundle)) throw new Error(`generated renderer missing ${bundle}`);
  fs.copyFileSync(bundle, path.join(dir, 'libmpv-shared.generated.js'));
  const html = path.join(dir, 'r45-prime.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#202020}
#immersivePlayer,#videoStage{position:relative} lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#warmGpu{position:absolute;width:16px;height:16px;opacity:.01;pointer-events:none}
</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video><canvas id="warmGpu" width="16" height="16"></canvas></div></div></section>
<script src="./libmpv-shared.generated.js"></script><script>
window.__r45Warm=async()=>{if(!navigator.gpu)return{ok:false,error:'navigator.gpu unavailable'};const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!a)return{ok:false,error:'adapter unavailable'};const d=await a.requestDevice();const c=document.querySelector('#warmGpu'),x=c.getContext('webgpu');if(!x)return{ok:false,error:'context unavailable'};const f=navigator.gpu.getPreferredCanvasFormat();x.configure({device:d,format:f,alphaMode:'opaque'});const e=d.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view:x.getCurrentTexture().createView(),clearValue:{r:.02,g:.04,b:.08,a:1},loadOp:'clear',storeOp:'store'}]});p.end();d.queue.submit([e.finish()]);await d.queue.onSubmittedWorkDone();window.__r45WarmDevice=d;return{ok:true,format:f};};
window.__r45Start=async src=>{await customElements.whenDefined('lilac-mpv-video');const v=document.querySelector('#video');await v.openLilacSource(src,{hls:false,headers:{}});await v.play();return true;};
</script></body></html>`, 'utf8');
  return html;
}

async function waitUntil(fn, timeoutMs, label, intervalMs = 10) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`${label} timeout last=${JSON.stringify(last)}`);
}

const presenter = s => s?.r32NativePresenter || {};
const focus = s => s?.r33FocusSurface || {};
const prime = s => focus(s)?.r45BlurPrime || {};
const recv = s => Number(s?.receiver?.presentedFrames || 0);
const sent = s => Number(s?.metrics?.sentFrames || 0);
const windowWidth = s => Number(presenter(s).screenWidth || 0);
const windowHeight = s => Number(presenter(s).screenHeight || 0);
const isTinyPrime = s => {
  const p = presenter(s), q = prime(s);
  return Boolean(p.windowVisible) && Number(p.x) === Number(q.primeX) && Number(p.y) === Number(q.primeY) &&
    windowWidth(s) > 0 && windowHeight(s) > 0 && windowWidth(s) <= 2 && windowHeight(s) <= 2;
};
const isFullVisible = s => Boolean(presenter(s).windowVisible) && (windowWidth(s) > 2 || windowHeight(s) > 2);

async function sampleUntil(bridge, predicate, timeoutMs, label) {
  const samples = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = bridge.state();
    const p = presenter(state);
    const q = prime(state);
    const row = {
      t: Date.now(),
      x: Number(p.x), y: Number(p.y), screenWidth: Number(p.screenWidth || 0), screenHeight: Number(p.screenHeight || 0),
      visible: Boolean(p.windowVisible), presented: Number(p.presentedFrames || 0), nativeOnly: Number(p.nativeOnlyFrames || 0),
      active: Boolean(focus(state).active), recv: recv(state), sent: sent(state), pending: Boolean(q.pending),
      primeX: Number(q.primeX || 0), primeY: Number(q.primeY || 0), primeWidth: Number(q.primeWidth || 0), primeHeight: Number(q.primeHeight || 0),
      successes: Number(q.successes || 0), timeouts: Number(q.timeouts || 0), failures: Number(q.failures || 0), cancels: Number(q.cancels || 0),
      proofs: Number(q.firstPresentTinyProofs || 0), violations: Number(q.prePresentFullExposureViolations || 0),
      proofPresented: Number(q.lastProofPresented || 0), proofX: Number(q.lastProofX || 0), proofY: Number(q.lastProofY || 0),
      proofWidth: Number(q.lastProofWidth || 0), proofHeight: Number(q.lastProofHeight || 0),
      proofWallMs: Number(q.lastProofWallMs || 0), exposeWallMs: Number(q.lastExposeWallMs || 0),
      redrawRequests: Number(q.redrawRequests || 0), redrawAccepted: Number(q.redrawAccepted || 0), redrawErrors: Number(q.redrawErrors || 0)
    };
    samples.push(row);
    if (predicate(state, row, samples)) return { state, row, samples };
    await sleep(2);
  }
  throw new Error(`${label} timeout tail=${JSON.stringify(samples.slice(-12))}`);
}

(async () => {
  await app.whenReady();
  if (!process.env.LILAC_LIBMPV_PLAYER_ADDON || !process.env.LILAC_LIBMPV_DLL) throw new Error('R45 addon/dll env missing');
  if (app.isHardwareAccelerationEnabled?.() === false) throw new Error('hardware acceleration disabled');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r45-prime-smoke-'));
  let main = null;
  let rival = null;
  let bridge = null;
  try {
    bridge = createLibmpvSharedBridge({ app, ipcMain });
    await bridge.ensure();
    const preload = path.resolve(__dirname, '..', 'electron', 'preload-libmpv-shared.generated.cjs');
    main = new BrowserWindow({ show:true, frame:false, x:80, y:80, width:800, height:600, backgroundColor:'#202020', webPreferences:{ preload, backgroundThrottling:false, contextIsolation:true, nodeIntegration:false, sandbox:true } });
    rival = new BrowserWindow({ show:false, frame:false, x:1120, y:80, width:300, height:220, backgroundColor:'#383838', webPreferences:{ backgroundThrottling:false } });
    await bridge.attachWindow(main);
    await main.loadFile(writeHarness(dir));
    await rival.loadURL('data:text/html,<body style="background:%23383838">r45 rival</body>');
    main.focus();
    await waitUntil(() => main.isFocused(), 3000, 'initial main focus');
    const warm = await main.webContents.executeJavaScript('window.__r45Warm()');
    if (!warm?.ok) throw new Error(`WebGPU warmup failed ${JSON.stringify(warm)}`);
    if (await main.webContents.executeJavaScript(`window.__r45Start(${JSON.stringify(pathToFileURL(makeFixture(dir)).href)})`) !== true) throw new Error('product player start failed');
    await waitUntil(() => { const s=bridge.state(); return s?.fileLoaded===true && sent(s)>=15 && recv(s)>=15; }, 15000, 'focused playback baseline');

    const initial = bridge.state();
    if (String(prime(initial).marker || '') !== 'LILAC_R45_NATIVE_TINY_FIRST_PRESENT_PRIME') throw new Error(`R45 tiny marker missing ${JSON.stringify(prime(initial))}`);

    const cycles = [];
    for (let i = 1; i <= 8; i += 1) {
      const before = bridge.state();
      const baselinePresented = Number(presenter(before).presentedFrames || 0);
      const baselineSuccesses = Number(prime(before).successes || 0);
      const baselineProofs = Number(prime(before).firstPresentTinyProofs || 0);
      const baselineViolations = Number(prime(before).prePresentFullExposureViolations || 0);
      const baselineTimeouts = Number(prime(before).timeouts || 0);
      const baselineFailures = Number(prime(before).failures || 0);
      const baselineRedrawRequests = Number(prime(before).redrawRequests || 0);
      const baselineRedrawAccepted = Number(prime(before).redrawAccepted || 0);
      const blurAt = Date.now();
      rival.show(); rival.moveTop(); rival.focus();
      await waitUntil(() => !main.isFocused() && rival.isFocused(), 4000, `cycle ${i} rival focus`);

      const tiny = await sampleUntil(bridge, (s,row) => row.visible && row.active && row.pending && isTinyPrime(s), 5000, `cycle ${i} 2x2 visible prime`);
      if (tiny.row.primeWidth !== 2 || tiny.row.primeHeight !== 2) throw new Error(`cycle ${i} configured prime is not 2x2 ${JSON.stringify(tiny.row)}`);
      const proof = await sampleUntil(bridge, (s,row) => Number(prime(s).firstPresentTinyProofs||0) > baselineProofs, 5000, `cycle ${i} first-Present tiny proof`);
      const qProof = prime(proof.state);
      if (Number(qProof.prePresentFullExposureViolations||0) !== baselineViolations) throw new Error(`cycle ${i} pre-Present full exposure violation ${JSON.stringify(qProof)}`);
      if (Number(qProof.lastProofPresented||0) <= baselinePresented) throw new Error(`cycle ${i} proof did not advance presentedFrames ${JSON.stringify(qProof)}`);
      if (Number(qProof.lastProofX) !== Number(qProof.primeX) || Number(qProof.lastProofY) !== Number(qProof.primeY) || Number(qProof.lastProofWidth) > 2 || Number(qProof.lastProofHeight) > 2 || Number(qProof.lastProofWidth) < 1 || Number(qProof.lastProofHeight) < 1) {
        throw new Error(`cycle ${i} first Present proof was not on 2x2 prime ${JSON.stringify(qProof)}`);
      }
      if (Number(qProof.lastProofWallMs||0) < blurAt) throw new Error(`cycle ${i} stale proof timestamp ${JSON.stringify(qProof)}`);

      const exposed = await sampleUntil(bridge, (s,row) => isFullVisible(s) && row.presented > baselinePresented && Number(prime(s).successes||0) > baselineSuccesses, 5000, `cycle ${i} full expose after Present proof`);
      const qExposed = prime(exposed.state);
      if (Number(qExposed.lastExposeWallMs||0) < Number(qExposed.lastProofWallMs||0)) throw new Error(`cycle ${i} full exposure timestamp preceded proof ${JSON.stringify(qExposed)}`);
      if (Number(qExposed.timeouts||0) !== baselineTimeouts || Number(qExposed.failures||0) !== baselineFailures) throw new Error(`cycle ${i} prime used timeout/failure path ${JSON.stringify(qExposed)}`);
      if (Number(qExposed.redrawRequests||0) <= baselineRedrawRequests || Number(qExposed.redrawAccepted||0) <= baselineRedrawAccepted || Number(qExposed.redrawErrors||0) !== 0) throw new Error(`cycle ${i} forced redraw not accepted ${JSON.stringify(qExposed)}`);
      const sampledPremature = [...tiny.samples, ...proof.samples, ...exposed.samples].find(row => row.pending && row.visible && (row.screenWidth > 2 || row.screenHeight > 2));
      if (sampledPremature) throw new Error(`cycle ${i} pending prime was sampled full-size ${JSON.stringify(sampledPremature)}`);

      await sleep(220);
      const beforeFocus = bridge.state();
      const baseRecv = recv(beforeFocus);
      const baseNativePresented = Number(presenter(beforeFocus).presentedFrames || 0);
      const focusAt = Date.now();
      rival.hide(); main.show(); main.moveTop(); main.focus();
      await waitUntil(() => main.isFocused(), 4000, `cycle ${i} main refocus`);
      const rendererFresh = await sampleUntil(bridge, (s,row) => row.recv > baseRecv, 5000, `cycle ${i} renderer fresh frame`);
      const nativeHidden = await sampleUntil(bridge, (s,row) => !row.visible && !row.active, 5000, `cycle ${i} native handoff hide`);
      if (nativeHidden.row.t < rendererFresh.row.t) throw new Error(`cycle ${i} native hidden before renderer fresh frame`);
      if (Boolean(prime(nativeHidden.state).pending)) throw new Error(`cycle ${i} prime remained pending after refocus`);

      cycles.push({
        i,
        blurToTinyMs: tiny.row.t - blurAt,
        blurToProofMs: Number(qExposed.lastProofWallMs||0) - blurAt,
        proofToFullExposeMs: Number(qExposed.lastExposeWallMs||0) - Number(qExposed.lastProofWallMs||0),
        focusToRendererMs: rendererFresh.row.t - focusAt,
        rendererToNativeHideMs: nativeHidden.row.t - rendererFresh.row.t,
        nativeFramesDuringFocusHandoff: Number(presenter(nativeHidden.state).presentedFrames||0) - baseNativePresented
      });
      await sleep(180);
    }

    let cancellationObserved = false;
    for (let attempt = 0; attempt < 4 && !cancellationObserved; attempt += 1) {
      const beforeCancel = bridge.state();
      const baseCancels = Number(prime(beforeCancel).cancels || 0);
      rival.show(); rival.focus();
      await waitUntil(() => !main.isFocused() && rival.isFocused(), 4000, `cancel attempt ${attempt+1} rival focus`);
      const pendingAtFocus = Boolean(prime(bridge.state()).pending);
      rival.hide(); main.show(); main.moveTop(); main.focus();
      await waitUntil(() => main.isFocused(), 4000, `cancel attempt ${attempt+1} refocus`);
      if (pendingAtFocus) {
        const cancelled = await sampleUntil(bridge, (s,row) => !row.visible && !row.active && Number(prime(s).cancels||0) > baseCancels, 5000, `cancel attempt ${attempt+1} hidden`);
        if (Boolean(prime(cancelled.state).pending)) throw new Error('rapid-refocus cancellation left prime pending');
        cancellationObserved = true;
      } else {
        await waitUntil(() => !Boolean(prime(bridge.state()).pending), 3000, `cancel attempt ${attempt+1} settled`);
      }
      await sleep(80);
    }

    const final = bridge.state();
    const q = prime(final);
    if (Number(q.successes||0) < 8 || Number(q.firstPresentTinyProofs||0) < 8 || Number(q.prePresentFullExposureViolations||0) !== 0 || Number(q.timeouts||0) !== 0 || Number(q.failures||0) !== 0 || Number(q.redrawErrors||0) !== 0) throw new Error(`R45 final counters unexpected ${JSON.stringify(q)}`);
    const maxBlurToProof = Math.max(...cycles.map(c=>c.blurToProofMs));
    const maxProofToExpose = Math.max(...cycles.map(c=>c.proofToFullExposeMs));
    const minRendererToHide = Math.min(...cycles.map(c=>c.rendererToNativeHideMs));
    console.log(`R45_TINY_FIRST_PRESENT_RUNTIME_OK cycles=8 successes=${q.successes} tinyProofs=${q.firstPresentTinyProofs} fullExposureViolations=${q.prePresentFullExposureViolations} redrawAccepted=${q.redrawAccepted}/${q.redrawRequests} timeouts=${q.timeouts} failures=${q.failures} cancellationObserved=${cancellationObserved?1:0} maxBlurToProofMs=${maxBlurToProof} maxProofToFullExposeMs=${maxProofToExpose} minRendererToNativeHideMs=${minRendererToHide} ordering=${JSON.stringify(cycles)}`);
  } finally {
    clearTimeout(hardDeadline);
    try { await bridge?.close?.(); } catch {}
    try { await bridge?.dispose?.(); } catch {}
    try { rival?.destroy(); } catch {}
    try { main?.destroy(); } catch {}
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

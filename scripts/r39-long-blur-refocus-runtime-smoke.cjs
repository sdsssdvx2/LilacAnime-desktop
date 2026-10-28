'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');

// Hosted Windows runners can expose D3D11 to the native addon while Chromium's
// sandboxed GPU child reports no adapter. This mirrors the existing R37 raw E2E
// qualification and does not alter the product's renderer or presentation path.
app.commandLine.appendSwitch('disable-gpu-sandbox');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R39 long-blur refocus runtime smoke exceeded 120s hard deadline');
  process.exit(124);
}, 120000);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r39-refocus.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=35',
    '-f','lavfi','-i','sine=frequency=523:sample_rate=48000:duration=35',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
    '-c:a','aac','-shortest',out
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed ${String(result.stderr || '').slice(0,240)}`);
  return out;
}

function productHtml(dir) {
  const bundle = path.resolve(__dirname, '..', 'src', 'libmpv-shared.generated.js');
  if (!fs.existsSync(bundle)) throw new Error(`generated product renderer missing: ${bundle}`);
  fs.copyFileSync(bundle, path.join(dir, 'libmpv-shared.generated.js'));
  const html = path.join(dir, 'r39-refocus.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#202020}
#immersivePlayer,#videoStage{position:relative}
lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#warmGpu{position:absolute;width:16px;height:16px;opacity:.01;pointer-events:none}
</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video><canvas id="warmGpu" width="16" height="16"></canvas></div></div></section>
<script src="./libmpv-shared.generated.js"></script><script>
window.__r39Warm=async()=>{if(!navigator.gpu)return{ok:false,error:'navigator.gpu unavailable'};const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!a)return{ok:false,error:'adapter unavailable'};const d=await a.requestDevice();const c=document.querySelector('#warmGpu');const x=c.getContext('webgpu');if(!x)return{ok:false,error:'context unavailable'};const f=navigator.gpu.getPreferredCanvasFormat();x.configure({device:d,format:f,alphaMode:'opaque'});const e=d.createCommandEncoder();const p=e.beginRenderPass({colorAttachments:[{view:x.getCurrentTexture().createView(),clearValue:{r:.02,g:.04,b:.08,a:1},loadOp:'clear',storeOp:'store'}]});p.end();d.queue.submit([e.finish()]);await d.queue.onSubmittedWorkDone();window.__r39WarmDevice=d;return{ok:true,format:f};};
window.__r39Start=async src=>{await customElements.whenDefined('lilac-mpv-video');const v=document.querySelector('#video');await v.openLilacSource(src,{hls:false,headers:{}});await v.play();return true;};
</script></body></html>`, 'utf8');
  return html;
}

async function waitUntil(fn, timeoutMs, label, intervalMs = 20) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`${label} timeout last=${JSON.stringify(last)}`);
}

function sent(state) { return Number(state?.metrics?.sentFrames || 0); }
function presented(state) { return Number(state?.receiver?.presentedFrames || 0); }
function focusState(state) { return state?.r33FocusSurface || {}; }
function phaseState(state) { return focusState(state)?.r39PumpPhase || {}; }

function postFocusGaps(state, sinceWallMs) {
  const anomalies = state?.r27FocusStallRetention?.mainAnomalies || [];
  return anomalies.filter(item => item?.kind === 'dispatch-gap' && Number(item.wallMs || 0) >= sinceWallMs && item.focused === true)
    .map(item => Number(item.gapMs || 0));
}

async function cycle(bridge, main, rival, index) {
  rival.show();
  rival.focus();
  await waitUntil(() => !main.isFocused() && rival.isFocused(), 3000, `cycle${index} blur`);
  await waitUntil(() => focusState(bridge.state()).active === true, 4000, `cycle${index} native-only active`);

  // Hold native-only long enough to invalidate any absolute Chromium frame phase.
  // R38 user's real log showed the bad state only after long blur/refocus epochs.
  const blurStart = bridge.state();
  const blurSent0 = sent(blurStart);
  await sleep(4000);
  const blurEnd = bridge.state();
  const blurSentDelta = sent(blurEnd) - blurSent0;
  if (blurSentDelta > 1) throw new Error(`cycle${index} Chromium delivery continued during native-only blur delta=${blurSentDelta}`);

  const phaseBefore = phaseState(blurEnd);
  const wakeBefore = Number(phaseBefore.wakeups || 0);
  const reanchorBefore = Number(phaseBefore.reanchors || 0);
  const sentBefore = sent(blurEnd);
  const presentedBefore = presented(blurEnd);
  const focusRequestWallMs = Date.now();

  main.show();
  main.focus();
  await waitUntil(() => main.isFocused(), 3000, `cycle${index} BrowserWindow refocus`);
  const first = await waitUntil(() => {
    const state = bridge.state();
    return sent(state) > sentBefore && presented(state) > presentedBefore ? state : null;
  }, 500, `cycle${index} first Chromium frame after refocus`, 5);
  const firstFrameMs = Date.now() - focusRequestWallMs;
  if (firstFrameMs > 300) throw new Error(`cycle${index} first focused frame too slow ${firstFrameMs}ms`);

  const phaseAfter = phaseState(first);
  if (Number(phaseAfter.wakeups || 0) <= wakeBefore) throw new Error(`cycle${index} R39 focused wake counter did not advance`);
  if (Number(phaseAfter.reanchors || 0) <= reanchorBefore) throw new Error(`cycle${index} R39 phase reanchor counter did not advance`);
  if (String(phaseAfter.lastReason || '') !== 'focus') throw new Error(`cycle${index} last phase reason is not focus: ${phaseAfter.lastReason}`);

  // Prove recovery is sustained, not just one forced frame. Twelve new frames at
  // 23.976 fps nominally need ~500 ms; 900 ms leaves ample hosted-runner margin while
  // still rejecting the 1.1–1.3 s post-refocus stalls observed on R38 hardware.
  const sentAtFirst = sent(first);
  const sustained = await waitUntil(() => {
    const state = bridge.state();
    return sent(state) >= sentAtFirst + 12 ? state : null;
  }, 900, `cycle${index} sustained focused cadence`, 10);

  const gaps = postFocusGaps(sustained, focusRequestWallMs);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  if (maxGap >= 300) throw new Error(`cycle${index} focused dispatch gap survived refocus maxGap=${maxGap} gaps=${JSON.stringify(gaps)}`);
  if (Number(sustained?.metrics?.importFailures || 0) !== 0 || Number(sustained?.metrics?.sendFailures || 0) !== 0) {
    throw new Error(`cycle${index} shared texture transport failure import=${sustained?.metrics?.importFailures} send=${sustained?.metrics?.sendFailures}`);
  }
  if (Number(focusState(sustained)?.r34Handoff?.r37Handoff?.rejectedRendererAcks || 0) !== 0) {
    throw new Error(`cycle${index} rejected R37 renderer ACK`);
  }
  return { firstFrameMs, maxGap, blurSentDelta, wakeups:Number(phaseAfter.wakeups || 0), reanchors:Number(phaseAfter.reanchors || 0) };
}

(async () => {
  await app.whenReady();
  if (!process.env.LILAC_LIBMPV_PLAYER_ADDON || !process.env.LILAC_LIBMPV_DLL) throw new Error('R39 addon/dll env missing');
  if (app.isHardwareAccelerationEnabled?.() === false) throw new Error('Electron hardware acceleration disabled');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r39-refocus-'));
  let main, rival, bridge;
  try {
    bridge = createLibmpvSharedBridge({ app, ipcMain });
    await bridge.ensure();
    const preload = path.resolve(__dirname, '..', 'electron', 'preload-libmpv-shared.generated.cjs');
    if (!fs.existsSync(preload)) throw new Error(`generated shared preload missing: ${preload}`);
    main = new BrowserWindow({ show:true, width:800, height:600, backgroundColor:'#202020', webPreferences:{ preload, backgroundThrottling:false, contextIsolation:true, nodeIntegration:false, sandbox:true } });
    rival = new BrowserWindow({ show:false, width:320, height:240, backgroundColor:'#303030', webPreferences:{ backgroundThrottling:false } });
    await bridge.attachWindow(main);
    await main.loadFile(productHtml(dir));
    await rival.loadURL('data:text/html,<body style="background:%23303030;color:white">R39 rival</body>');
    main.focus();
    await waitUntil(() => main.isFocused(), 3000, 'initial focus');

    const warm = await main.webContents.executeJavaScript('window.__r39Warm()');
    if (!warm?.ok) throw new Error(`renderer WebGPU warmup failed ${JSON.stringify(warm)}`);
    const media = pathToFileURL(fixture(dir)).href;
    if (await main.webContents.executeJavaScript(`window.__r39Start(${JSON.stringify(media)})`) !== true) throw new Error('R39 product start failed');
    await waitUntil(() => {
      const state = bridge.state();
      return state?.fileLoaded === true && sent(state) >= 8 && presented(state) >= 8;
    }, 15000, 'focused baseline');

    const baseline = bridge.state();
    if (baseline?.receiver?.rendererMode && !['direct-receive-webgpu-copy','webgpu-copy'].includes(baseline.receiver.rendererMode)) {
      throw new Error(`unexpected renderer mode ${baseline.receiver.rendererMode}`);
    }
    if (String(phaseState(baseline)?.marker || '') !== 'LILAC_R39_REFOCUS_PHASE_REANCHOR') throw new Error('R39 phase diagnostics missing from real bridge');

    const results = [];
    for (let i = 1; i <= 3; i += 1) results.push(await cycle(bridge, main, rival, i));
    const maxFirst = Math.max(...results.map(x => x.firstFrameMs));
    const maxGap = Math.max(...results.map(x => x.maxGap));
    console.log(`R39_LONG_BLUR_REFOCUS_RUNTIME_OK cycles=3 blurMs=4000 maxFirstFocusedFrameMs=${maxFirst} maxPostFocusDispatchGapMs=${maxGap} directWebgpu=1 nativeOnlyChromiumSuppressed=1 phaseReanchor=1 forceWake=1 r37Ack=preserved`);
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

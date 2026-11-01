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
const hardDeadline = setTimeout(() => { console.error('R45 offscreen-prime smoke exceeded 180s'); process.exit(124); }, 180000);

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
const isOffscreen = s => Number(presenter(s).x) <= -30000 || Number(presenter(s).y) <= -30000;
const isOnscreen = s => Boolean(presenter(s).windowVisible) && !isOffscreen(s);

async function sampleUntil(bridge, predicate, timeoutMs, label) {
  const samples = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = bridge.state();
    const p = presenter(state);
    const q = prime(state);
    const row = {
      t: Date.now(),
      x: Number(p.x), y: Number(p.y), visible: Boolean(p.windowVisible),
      presented: Number(p.presentedFrames || 0), nativeOnly: Number(p.nativeOnlyFrames || 0),
      active: Boolean(focus(state).active), recv: recv(state), sent: sent(state),
      pending: Boolean(q.pending), successes: Number(q.successes || 0), timeouts: Number(q.timeouts || 0), failures: Number(q.failures || 0), cancels: Number(q.cancels || 0)
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
    if (String(prime(initial).marker || '') !== 'LILAC_R45_NATIVE_OFFSCREEN_FIRST_PRESENT_PRIME') throw new Error(`R45 marker missing ${JSON.stringify(prime(initial))}`);

    const cycles = [];
    for (let i = 1; i <= 8; i += 1) {
      const before = bridge.state();
      const baselinePresented = Number(presenter(before).presentedFrames || 0);
      const baselineSuccesses = Number(prime(before).successes || 0);
      const baselineTimeouts = Number(prime(before).timeouts || 0);
      const baselineFailures = Number(prime(before).failures || 0);
      const blurAt = Date.now();
      rival.show(); rival.moveTop(); rival.focus();
      await waitUntil(() => !main.isFocused() && rival.isFocused(), 4000, `cycle ${i} rival focus`);

      const offscreen = await sampleUntil(bridge, (s,row) => row.visible && row.active && isOffscreen(s), 5000, `cycle ${i} offscreen visible prime`);
      if (offscreen.row.presented > baselinePresented) throw new Error(`cycle ${i} first sample already presented before offscreen observation ${JSON.stringify(offscreen.row)}`);

      const firstPresent = await sampleUntil(bridge, (s,row) => row.presented > baselinePresented, 5000, `cycle ${i} first native Present`);
      if (!isOffscreen(firstPresent.state)) throw new Error(`cycle ${i} native reached screen before first Present ${JSON.stringify(firstPresent.row)}`);

      const exposed = await sampleUntil(bridge, (s,row) => isOnscreen(s) && row.presented > baselinePresented && Number(prime(s).successes||0) > baselineSuccesses, 5000, `cycle ${i} expose after Present`);
      const badExposure = [...offscreen.samples, ...firstPresent.samples, ...exposed.samples].find(row => row.visible && row.x > -30000 && row.y > -30000 && row.presented <= baselinePresented);
      if (badExposure) throw new Error(`cycle ${i} on-screen native exposure preceded first Present ${JSON.stringify(badExposure)}`);
      if (Number(prime(exposed.state).timeouts||0) !== baselineTimeouts || Number(prime(exposed.state).failures||0) !== baselineFailures) throw new Error(`cycle ${i} prime used timeout/failure path ${JSON.stringify(prime(exposed.state))}`);

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
      if (Number(prime(nativeHidden.state).pending||0)) throw new Error(`cycle ${i} prime remained pending after refocus`);

      cycles.push({
        i,
        blurToOffscreenMs: offscreen.row.t - blurAt,
        offscreenToPresentMs: firstPresent.row.t - offscreen.row.t,
        presentToExposeMs: exposed.row.t - firstPresent.row.t,
        focusToRendererMs: rendererFresh.row.t - focusAt,
        rendererToNativeHideMs: nativeHidden.row.t - rendererFresh.row.t,
        nativeFramesDuringFocusHandoff: Number(presenter(nativeHidden.state).presentedFrames||0) - baseNativePresented
      });
      await sleep(180);
    }

    // Explicit rapid refocus cancellation: the offscreen popup must never be exposed.
    const beforeCancel = bridge.state();
    const baseCancels = Number(prime(beforeCancel).cancels || 0);
    rival.show(); rival.focus();
    await waitUntil(() => !main.isFocused() && rival.isFocused(), 4000, 'cancel-cycle rival focus');
    await sampleUntil(bridge, (s,row) => row.visible && row.active && isOffscreen(s), 5000, 'cancel-cycle offscreen prime');
    rival.hide(); main.show(); main.moveTop(); main.focus();
    await waitUntil(() => main.isFocused(), 4000, 'cancel-cycle refocus');
    const cancelled = await sampleUntil(bridge, (s,row) => !row.visible && !row.active && Number(prime(s).cancels||0) > baseCancels, 5000, 'cancel-cycle hidden');
    if (Boolean(prime(cancelled.state).pending)) throw new Error('cancel-cycle pending flag remained set');

    const final = bridge.state();
    const q = prime(final);
    if (Number(q.successes||0) < 8 || Number(q.timeouts||0) !== 0 || Number(q.failures||0) !== 0 || Number(q.cancels||0) < 1) throw new Error(`R45 final counters unexpected ${JSON.stringify(q)}`);
    const maxOffscreenToPresent = Math.max(...cycles.map(c=>c.offscreenToPresentMs));
    const maxPresentToExpose = Math.max(...cycles.map(c=>c.presentToExposeMs));
    const minRendererToHide = Math.min(...cycles.map(c=>c.rendererToNativeHideMs));
    console.log(`R45_OFFSCREEN_FIRST_PRESENT_RUNTIME_OK cycles=8 successes=${q.successes} timeouts=${q.timeouts} failures=${q.failures} cancels=${q.cancels} maxOffscreenToPresentMs=${maxOffscreenToPresent} maxPresentToExposeMs=${maxPresentToExpose} minRendererToNativeHideMs=${minRendererToHide} ordering=${JSON.stringify(cycles)}`);
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

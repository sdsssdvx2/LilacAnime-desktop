'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');
const evidencePath = path.join(root, 'renderer-input-stress-report.json');

function writeEvidence(report) {
  try { fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2)); } catch {}
}

async function main() {
  const bundle = path.join(root, 'src', 'libmpv-shared.generated.js');
  if (!fs.existsSync(bundle)) throw new Error('transformed renderer bundle missing');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-renderer-stress-'));
  const html = path.join(dir, 'stress.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
#immersivePlayer,#videoStage{position:relative}
lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%}
#probeButton{position:absolute;z-index:50;left:28px;top:28px;width:220px;height:70px;border:0;background:white;color:black;font:20px sans-serif}
#hud{position:absolute;z-index:50;right:28px;bottom:28px;width:240px;height:70px;background:rgba(255,255,255,.9)}
</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video><button id="probeButton">input probe</button><div id="hud"></div></div></div></section>
<script src="${pathToFileURL(bundle).href}"></script><script>
window.__stress={draws:0,clicks:0,keys:0,lastClickAt:0,lastKeyAt:0,startAt:0,rafs:0,timerSamples:0,timerDriftTotal:0,timerDriftMax:0,focusEvents:0};
const button=document.querySelector('#probeButton');
button.addEventListener('click',()=>{window.__stress.clicks++;window.__stress.lastClickAt=performance.now()});
window.addEventListener('keydown',()=>{window.__stress.keys++;window.__stress.lastKeyAt=performance.now()},true);
window.addEventListener('focus',()=>window.__stress.focusEvents++,true);
window.__startStress=async()=>{
  await customElements.whenDefined('lilac-mpv-video');
  const host=document.querySelector('#video');
  const canvas=host.shadowRoot.querySelector('canvas[data-lilac-libmpv-surface]');
  const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
  canvas.width=1920;canvas.height=1080;
  let flip=false;window.__stress.startAt=performance.now();
  let expected=performance.now()+42;
  window.__stressTimer=setInterval(()=>{
    const now=performance.now();const drift=Math.max(0,now-expected);expected=now+42;
    window.__stress.timerSamples++;window.__stress.timerDriftTotal+=drift;window.__stress.timerDriftMax=Math.max(window.__stress.timerDriftMax,drift);
    flip=!flip;ctx.fillStyle=flip?'rgb(12,64,192)':'rgb(192,72,16)';ctx.fillRect(0,0,1920,1080);window.__stress.draws++;
  },42);
  const raf=()=>{window.__stress.rafs++;window.__stressRaf=requestAnimationFrame(raf)};window.__stressRaf=requestAnimationFrame(raf);
  return true;
};
window.__snapshot=()=>{
  const host=document.querySelector('#video');const canvas=host.shadowRoot.querySelector('canvas[data-lilac-libmpv-surface]');
  const hr=host.getBoundingClientRect();const br=button.getBoundingClientRect();
  return{stress:{...window.__stress},focus:{document:document.hasFocus(),activeTag:document.activeElement?.tagName||null,activeId:document.activeElement?.id||null},viewport:{width:innerWidth,height:innerHeight},host:{width:hr.width,height:hr.height,pointerEvents:getComputedStyle(host).pointerEvents},canvas:{width:canvas.width,height:canvas.height},button:{x:br.left+br.width/2,y:br.top+br.height/2}};
};
</script></body></html>`);

  const report = {
    schema: 3,
    smoke: 'transformed 1080p renderer draw + pointer + keyboard responsiveness',
    status: 'running',
    focusBefore: null,
    focusAfter: null,
    geometry: null,
    inputs: [],
    final: null,
    error: null
  };

  const win = new BrowserWindow({
    show: true,
    frame: false,
    width: 1920,
    height: 1080,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });

  try {
    await win.loadFile(html);
    win.show();
    win.focus();
    win.webContents.focus();
    await win.webContents.executeJavaScript('window.focus();document.querySelector("#probeButton").focus()');
    await sleep(250);

    report.focusBefore = {
      browserWindowFocused: win.isFocused(),
      webContentsFocused: win.webContents.isFocused(),
      renderer: await win.webContents.executeJavaScript('window.__snapshot().focus')
    };

    await win.webContents.executeJavaScript('window.__startStress()');
    await sleep(700);
    let snap = await win.webContents.executeJavaScript('window.__snapshot()');
    report.geometry = { viewport: snap.viewport, host: snap.host, canvas: snap.canvas, button: snap.button };
    const widthRatio = snap.viewport.width > 0 ? snap.host.width / snap.viewport.width : 0;
    const heightRatio = snap.viewport.height > 0 ? snap.host.height / snap.viewport.height : 0;
    if (widthRatio < 0.98 || heightRatio < 0.98) {
      throw new Error(`renderer host no longer fills viewport: ${JSON.stringify({ viewport: snap.viewport, host: snap.host, widthRatio, heightRatio })}`);
    }
    if (snap.host.pointerEvents !== 'none') throw new Error(`video custom element still intercepts pointer input: ${snap.host.pointerEvents}`);
    if (snap.canvas.width !== 1920 || snap.canvas.height !== 1080) throw new Error(`renderer stress canvas size wrong: ${JSON.stringify(snap.canvas)}`);

    const latencies = [];
    for (let i = 0; i < 10; i += 1) {
      win.focus();
      win.webContents.focus();
      snap = await win.webContents.executeJavaScript('window.__snapshot()');
      const beforeClickCount = snap.stress.clicks;
      const beforeKeyCount = snap.stress.keys;

      const clickSent = await win.webContents.executeJavaScript('performance.now()');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(snap.button.x), y: Math.round(snap.button.y), movementX: 1, movementY: 1 });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(snap.button.x), y: Math.round(snap.button.y), button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(snap.button.x), y: Math.round(snap.button.y), button: 'left', clickCount: 1 });

      // The stress gate verifies keyboard delivery, not app shortcut semantics.
      // Use an ordinary key to avoid platform-specific special-key naming. The
      // real ArrowRight behavior remains covered by player-interactions.test.cjs.
      const keySent = await win.webContents.executeJavaScript('performance.now()');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });

      const deadline = Date.now() + 700;
      let after = null;
      while (Date.now() < deadline) {
        after = await win.webContents.executeJavaScript('window.__snapshot()');
        if (after.stress.clicks > beforeClickCount && after.stress.keys > beforeKeyCount) break;
        await sleep(10);
      }
      const record = {
        iteration: i,
        pointerDelivered: Boolean(after && after.stress.clicks > beforeClickCount),
        keyboardDelivered: Boolean(after && after.stress.keys > beforeKeyCount),
        clickLatencyMs: after?.stress?.lastClickAt ? after.stress.lastClickAt - clickSent : null,
        keyLatencyMs: after?.stress?.lastKeyAt ? after.stress.lastKeyAt - keySent : null,
        focus: after?.focus || null
      };
      report.inputs.push(record);
      if (!record.pointerDelivered) throw new Error(`pointer input missed during 1080p draw stress at iteration ${i}`);
      if (!record.keyboardDelivered) throw new Error(`keyboard input missed during 1080p draw stress at iteration ${i}`);
      latencies.push({ click: record.clickLatencyMs, key: record.keyLatencyMs });
      await sleep(250);
    }

    await sleep(500);
    const final = await win.webContents.executeJavaScript('window.__snapshot()');
    const pageNow = await win.webContents.executeJavaScript('performance.now()');
    const pageElapsed = Math.max(1, pageNow - final.stress.startAt);
    const drawFps = final.stress.draws * 1000 / pageElapsed;
    const rafFps = final.stress.rafs * 1000 / pageElapsed;
    const maxClick = Math.max(...latencies.map(item => item.click));
    const maxKey = Math.max(...latencies.map(item => item.key));
    const avgClick = latencies.reduce((sum, item) => sum + item.click, 0) / latencies.length;
    const avgKey = latencies.reduce((sum, item) => sum + item.key, 0) / latencies.length;
    const avgTimerDrift = final.stress.timerSamples ? final.stress.timerDriftTotal / final.stress.timerSamples : 0;

    report.focusAfter = {
      browserWindowFocused: win.isFocused(),
      webContentsFocused: win.webContents.isFocused(),
      renderer: final.focus
    };
    report.final = {
      draws: final.stress.draws,
      drawFps,
      rafs: final.stress.rafs,
      rafFps,
      clicks: final.stress.clicks,
      keys: final.stress.keys,
      avgClickMs: avgClick,
      maxClickMs: maxClick,
      avgKeyMs: avgKey,
      maxKeyMs: maxKey,
      timerSamples: final.stress.timerSamples,
      avgTimerDriftMs: avgTimerDrift,
      maxTimerDriftMs: final.stress.timerDriftMax,
      viewport: final.viewport,
      host: final.host,
      canvas: final.canvas
    };

    if (drawFps < 20) throw new Error(`1080p renderer stress draw cadence too low: ${drawFps.toFixed(2)}fps`);
    if (maxClick > 250 || maxKey > 250) throw new Error(`renderer input latency too high: click=${maxClick.toFixed(1)} key=${maxKey.toFixed(1)}`);
    if (avgTimerDrift > 40 || final.stress.timerDriftMax > 250) throw new Error(`renderer event-loop drift too high: avg=${avgTimerDrift.toFixed(1)} max=${final.stress.timerDriftMax.toFixed(1)}`);

    report.status = 'pass';
    writeEvidence(report);
    console.log(`LIBMPV_RENDERER_INPUT_STRESS_REPORT=${JSON.stringify({
      drawFps: Math.round(drawFps * 1000) / 1000,
      rafFps: Math.round(rafFps * 1000) / 1000,
      clicks: final.stress.clicks,
      keys: final.stress.keys,
      avgClickMs: Math.round(avgClick * 1000) / 1000,
      maxClickMs: Math.round(maxClick * 1000) / 1000,
      avgKeyMs: Math.round(avgKey * 1000) / 1000,
      maxKeyMs: Math.round(maxKey * 1000) / 1000,
      avgTimerDriftMs: Math.round(avgTimerDrift * 1000) / 1000,
      maxTimerDriftMs: Math.round(final.stress.timerDriftMax * 1000) / 1000,
      focus: report.focusAfter,
      viewport: final.viewport,
      host: final.host,
      canvas: final.canvas
    })}`);
    console.log('LIBMPV_RENDERER_INPUT_STRESS_OK');
  } catch (error) {
    report.status = 'fail';
    report.error = String(error?.message || error).slice(0, 500);
    try {
      const final = await win.webContents.executeJavaScript('window.__snapshot()');
      report.focusAfter = { browserWindowFocused: win.isFocused(), webContentsFocused: win.webContents.isFocused(), renderer: final.focus };
      report.final = final;
    } catch {}
    writeEvidence(report);
    console.error(`LIBMPV_RENDERER_INPUT_STRESS_FAIL=${JSON.stringify(report)}`);
    throw error;
  } finally {
    try { await win.webContents.executeJavaScript('clearInterval(window.__stressTimer);cancelAnimationFrame(window.__stressRaf)'); } catch {}
    if (!win.isDestroyed()) win.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

app.whenReady().then(main).then(() => app.exit(0)).catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});

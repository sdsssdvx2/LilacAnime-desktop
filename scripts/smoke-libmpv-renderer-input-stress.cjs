'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '..');
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
window.__stress={draws:0,clicks:0,keys:0,lastClickAt:0,lastKeyAt:0,startAt:0};
const button=document.querySelector('#probeButton');
button.addEventListener('click',()=>{window.__stress.clicks++;window.__stress.lastClickAt=performance.now()});
window.addEventListener('keydown',()=>{window.__stress.keys++;window.__stress.lastKeyAt=performance.now()},true);
window.__startStress=async()=>{
  await customElements.whenDefined('lilac-mpv-video');
  const host=document.querySelector('#video');
  const canvas=host.shadowRoot.querySelector('canvas[data-lilac-libmpv-surface]');
  const ctx=canvas.getContext('2d',{alpha:false});
  canvas.width=1920;canvas.height=1080;
  let flip=false;window.__stress.startAt=performance.now();
  window.__stressTimer=setInterval(()=>{flip=!flip;ctx.fillStyle=flip?'rgb(12,64,192)':'rgb(192,72,16)';ctx.fillRect(0,0,1920,1080);window.__stress.draws++;},42);
  return true;
};
window.__snapshot=()=>{
  const host=document.querySelector('#video');const canvas=host.shadowRoot.querySelector('canvas[data-lilac-libmpv-surface]');
  const hr=host.getBoundingClientRect();const br=button.getBoundingClientRect();
  return{stress:{...window.__stress},host:{width:hr.width,height:hr.height,pointerEvents:getComputedStyle(host).pointerEvents},canvas:{width:canvas.width,height:canvas.height},button:{x:br.left+br.width/2,y:br.top+br.height/2}};
};
</script></body></html>`);

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
    await win.webContents.executeJavaScript('window.__startStress()');
    await sleep(500);
    let snap = await win.webContents.executeJavaScript('window.__snapshot()');
    if (snap.host.width < 1800 || snap.host.height < 1000) throw new Error(`renderer host geometry regressed: ${JSON.stringify(snap.host)}`);
    if (snap.host.pointerEvents !== 'none') throw new Error(`video custom element still intercepts pointer input: ${snap.host.pointerEvents}`);
    if (snap.canvas.width !== 1920 || snap.canvas.height !== 1080) throw new Error(`renderer stress canvas size wrong: ${JSON.stringify(snap.canvas)}`);

    const latencies = [];
    for (let i = 0; i < 10; i += 1) {
      snap = await win.webContents.executeJavaScript('window.__snapshot()');
      const beforeClickCount = snap.stress.clicks;
      const beforeKeyCount = snap.stress.keys;
      const clickSent = await win.webContents.executeJavaScript('performance.now()');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(snap.button.x), y: Math.round(snap.button.y), movementX: 1, movementY: 1 });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(snap.button.x), y: Math.round(snap.button.y), button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(snap.button.x), y: Math.round(snap.button.y), button: 'left', clickCount: 1 });
      const keySent = await win.webContents.executeJavaScript('performance.now()');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ArrowRight' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ArrowRight' });

      const deadline = Date.now() + 600;
      let after = null;
      while (Date.now() < deadline) {
        after = await win.webContents.executeJavaScript('window.__snapshot()');
        if (after.stress.clicks > beforeClickCount && after.stress.keys > beforeKeyCount) break;
        await sleep(10);
      }
      if (!after || after.stress.clicks <= beforeClickCount) throw new Error(`pointer input missed during 1080p draw stress at iteration ${i}`);
      if (after.stress.keys <= beforeKeyCount) throw new Error(`keyboard input missed during 1080p draw stress at iteration ${i}`);
      latencies.push({ click: after.stress.lastClickAt - clickSent, key: after.stress.lastKeyAt - keySent });
      await sleep(350);
    }

    await sleep(500);
    const final = await win.webContents.executeJavaScript('window.__snapshot()');
    const elapsed = Math.max(1, performance.now() - performance.now() + 1); // no-op; page timing used below
    const pageElapsed = Math.max(1, (await win.webContents.executeJavaScript('performance.now()')) - final.stress.startAt);
    const drawFps = final.stress.draws * 1000 / pageElapsed;
    const maxClick = Math.max(...latencies.map(item => item.click));
    const maxKey = Math.max(...latencies.map(item => item.key));
    const avgClick = latencies.reduce((sum, item) => sum + item.click, 0) / latencies.length;
    const avgKey = latencies.reduce((sum, item) => sum + item.key, 0) / latencies.length;

    if (drawFps < 20) throw new Error(`1080p renderer stress draw cadence too low: ${drawFps.toFixed(2)}fps`);
    if (maxClick > 250 || maxKey > 250) throw new Error(`renderer input latency too high: click=${maxClick.toFixed(1)} key=${maxKey.toFixed(1)}`);

    console.log(`LIBMPV_RENDERER_INPUT_STRESS_REPORT=${JSON.stringify({
      draws: final.stress.draws,
      drawFps: Math.round(drawFps * 1000) / 1000,
      clicks: final.stress.clicks,
      keys: final.stress.keys,
      avgClickMs: Math.round(avgClick * 1000) / 1000,
      maxClickMs: Math.round(maxClick * 1000) / 1000,
      avgKeyMs: Math.round(avgKey * 1000) / 1000,
      maxKeyMs: Math.round(maxKey * 1000) / 1000,
      host: final.host,
      canvas: final.canvas
    })}`);
    console.log('LIBMPV_RENDERER_INPUT_STRESS_OK');
  } finally {
    try { await win.webContents.executeJavaScript('clearInterval(window.__stressTimer)'); } catch {}
    if (!win.isDestroyed()) win.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

app.whenReady().then(main).then(() => app.exit(0)).catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});

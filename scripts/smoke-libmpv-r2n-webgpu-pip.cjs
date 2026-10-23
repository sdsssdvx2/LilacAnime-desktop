'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Match Chromium's current webgpu-swiftshader web-test configuration. These switches
// are CI-only and are never added to the production application.
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader');
app.commandLine.appendSwitch('enable-dawn-features', 'allow_unsafe_apis');
app.commandLine.appendSwitch('disable-dawn-features', 'use_dxc');
app.commandLine.appendSwitch('enable-webgpu-developer-features');
app.commandLine.appendSwitch('use-gpu-in-tests');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await win.webContents.executeJavaScript(expression).catch(error => ({ __evalError: String(error?.message || error) }));
    if (last?.__evalError) throw new Error(`${label} renderer eval failed: ${last.__evalError}`);
    if (last) return last;
    await sleep(50);
  }
  const bootstrap = await win.webContents.executeJavaScript(`({
    readyState: document.readyState,
    href: location.href,
    snapshotType: typeof window.__pipSnapshot,
    probe: window.__pipProbe || null,
    bootError: window.__pipBootError || null,
    gpu: Boolean(navigator.gpu),
    pipEnabled: document.pictureInPictureEnabled === true,
    canvasCapture: typeof HTMLCanvasElement.prototype.captureStream,
    videoPip: typeof HTMLVideoElement.prototype.requestPictureInPicture
  })`).catch(error => ({ evalError: String(error?.message || error) }));
  throw new Error(`${label} timed out; last=${JSON.stringify(last)} bootstrap=${JSON.stringify(bootstrap)}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r2n-pip-'));
  const html = path.join(dir, 'pip.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:#111;color:#fff;font:16px sans-serif;overflow:hidden}
canvas{position:absolute;inset:0;width:640px;height:360px;background:#000}
video{position:absolute;left:-9999px;top:-9999px;width:320px;height:180px}
button{position:absolute;z-index:10;left:40px;top:400px;width:220px;height:70px;font:18px sans-serif}
#status{position:absolute;z-index:10;left:300px;top:410px}
</style></head><body>
<canvas id="surface" width="640" height="360"></canvas>
<video id="pipVideo" muted playsinline></video>
<button id="enterPip" type="button">Enter PiP</button><div id="status">starting</div>
<script>
window.__pipBootError=null;
window.addEventListener('error',event=>{window.__pipBootError='error: '+String(event.message||event.error||'unknown');console.error('R2N_PIP_PAGE_ERROR',window.__pipBootError)});
window.addEventListener('unhandledrejection',event=>{window.__pipBootError='rejection: '+String(event.reason?.stack||event.reason||'unknown');console.error('R2N_PIP_PAGE_REJECTION',window.__pipBootError)});
console.log('R2N_PIP_BOOT_HANDLER_READY');
</script>
<script>
window.__pipProbe={ready:false,error:null,stage:'bootstrap',gpu:false,captureStream:false,videoTracks:0,capturedFrames:0,renderedFrames:0,clicks:0,entered:false,left:false,pipEnabled:document.pictureInPictureEnabled===true};
const probe=window.__pipProbe,canvas=document.querySelector('#surface'),video=document.querySelector('#pipVideo'),button=document.querySelector('#enterPip'),status=document.querySelector('#status');
window.__pipSnapshot=()=>({...probe,pipElement:document.pictureInPictureElement===video,videoReadyState:video.readyState,paused:video.paused,button:(()=>{const r=button.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()});
window.__pipCleanup=async()=>{clearInterval(window.__renderTimer);if(document.pictureInPictureElement)await document.exitPictureInPicture().catch(()=>{});video.srcObject?.getTracks().forEach(track=>track.stop());video.srcObject=null;return window.__pipSnapshot()};
function fail(error){probe.error=String(error?.stack||error?.message||error);probe.stage='failed';status.textContent='FAIL '+probe.error;console.error('R2N_PIP_FAIL',probe.error)}
video.addEventListener('enterpictureinpicture',()=>{probe.entered=true;probe.stage='pip-entered';status.textContent='entered'});
video.addEventListener('leavepictureinpicture',()=>{probe.left=true;status.textContent='left'});
function countFrame(){probe.capturedFrames++;if(probe.capturedFrames<120)video.requestVideoFrameCallback(countFrame)}
button.addEventListener('click',async()=>{probe.clicks++;try{probe.stage='requesting-pip';await video.requestPictureInPicture();probe.entered=probe.entered||document.pictureInPictureElement===video}catch(error){fail(error)}});
console.log('R2N_PIP_MAIN_SCRIPT_READY',JSON.stringify({gpu:Boolean(navigator.gpu),pip:document.pictureInPictureEnabled,capture:typeof canvas.captureStream}));
(async()=>{
  try{
    probe.stage='api-check';
    if(document.pictureInPictureEnabled!==true)throw new Error('document.pictureInPictureEnabled is false');
    if(typeof HTMLVideoElement.prototype.requestPictureInPicture!=='function')throw new Error('requestPictureInPicture unavailable');
    if(typeof canvas.captureStream!=='function')throw new Error('canvas.captureStream unavailable');
    probe.captureStream=true;
    if(!navigator.gpu)throw new Error('WebGPU unavailable');
    probe.stage='request-adapter';
    console.log('R2N_PIP_REQUEST_ADAPTER');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter)throw new Error('WebGPU SwiftShader adapter unavailable');
    probe.stage='request-device';
    console.log('R2N_PIP_ADAPTER_OK');
    const device=await adapter.requestDevice();
    probe.stage='configure-canvas';
    const context=canvas.getContext('webgpu');if(!context)throw new Error('WebGPU canvas context unavailable');
    const format=navigator.gpu.getPreferredCanvasFormat();
    context.configure({device,format,alphaMode:'opaque',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST});
    probe.gpu=true;
    let flip=false;
    const renderFrame=()=>{
      flip=!flip;
      const encoder=device.createCommandEncoder();
      const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:flip?{r:.05,g:.25,b:.85,a:1}:{r:.85,g:.18,b:.05,a:1}}]});
      pass.end();device.queue.submit([encoder.finish()]);probe.renderedFrames++;
    };
    // The real Lilac surface is already rendering before PiP is requested. Mirror that
    // order here so captureStream has live frames before the hidden video calls play().
    renderFrame();
    window.__renderTimer=setInterval(renderFrame,33);
    probe.stage='capture-stream';
    const stream=canvas.captureStream(30);probe.videoTracks=stream.getVideoTracks().length;if(!probe.videoTracks)throw new Error('captureStream returned no video track');
    video.srcObject=stream;
    probe.stage='play-capture-video';
    await video.play();
    if(typeof video.requestVideoFrameCallback==='function')video.requestVideoFrameCallback(countFrame);
    probe.stage='ready';probe.ready=true;status.textContent='ready';console.log('R2N_PIP_WEBGPU_CAPTURE_READY');
  }catch(error){fail(error)}
})();
</script></body></html>`);

  const win = new BrowserWindow({
    show: true,
    width: 760,
    height: 560,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`R2N_PIP_RENDERER_CONSOLE level=${level} line=${line} source=${sourceId} message=${message}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`R2N_PIP_RENDER_PROCESS_GONE=${JSON.stringify(details)}`);
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`R2N_PIP_DID_FAIL_LOAD=${JSON.stringify({errorCode,errorDescription,validatedURL,isMainFrame})}`);
  });

  try {
    await win.loadFile(html);
    win.show(); win.focus(); win.webContents.focus();
    const bootstrap = await win.webContents.executeJavaScript(`({
      readyState:document.readyState,
      snapshotType:typeof window.__pipSnapshot,
      probe:window.__pipProbe||null,
      bootError:window.__pipBootError||null,
      gpu:Boolean(navigator.gpu),
      pipEnabled:document.pictureInPictureEnabled===true
    })`);
    console.log(`LIBMPV_R2N_WEBGPU_PIP_BOOTSTRAP=${JSON.stringify(bootstrap)}`);
    if (bootstrap.snapshotType !== 'function') throw new Error(`PiP page main script did not initialize: ${JSON.stringify(bootstrap)}`);

    const ready = await waitFor(win, `(()=>{const s=window.__pipSnapshot();return s.error?{failed:s}:s.ready?s:null})()`, 20000, 'WebGPU PiP initialization');
    if (ready.failed) throw new Error(`probe initialization failed: ${ready.failed.error}`);

    const frames = await waitFor(win, `(()=>{const s=window.__pipSnapshot();return s.error?{failed:s}:s.capturedFrames>=2&&s.renderedFrames>=3?s:null})()`, 10000, 'canvas capture frames');
    if (frames.failed) throw new Error(`frame capture failed: ${frames.failed.error}`);
    if (!frames.gpu || !frames.captureStream || frames.videoTracks < 1) throw new Error(`invalid capture prerequisites: ${JSON.stringify(frames)}`);

    const point = frames.button;
    win.focus(); win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y), movementX: 1, movementY: 1 });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });

    const entered = await waitFor(win, `(()=>{const s=window.__pipSnapshot();return s.error?{failed:s}:s.entered&&s.pipElement?s:null})()`, 10000, 'trusted-click PiP entry');
    if (entered.failed) throw new Error(`PiP entry failed: ${entered.failed.error}`);
    if (entered.clicks !== 1) throw new Error(`trusted button click count mismatch: ${entered.clicks}`);

    const cleaned = await win.webContents.executeJavaScript('window.__pipCleanup()');
    console.log(`LIBMPV_R2N_WEBGPU_PIP_REPORT=${JSON.stringify({gpu:entered.gpu,captureStream:entered.captureStream,videoTracks:entered.videoTracks,capturedFrames:entered.capturedFrames,renderedFrames:entered.renderedFrames,pipEntered:entered.entered,pipElement:entered.pipElement,clicks:entered.clicks,left:cleaned.left,adapter:'swiftshader-ci'})}`);
    console.log('LIBMPV_R2N_WEBGPU_PIP_PASS gpu=1 captureStream=1 frames=nonzero trustedPip=1 cpuReadback=0 adapter=swiftshader-ci');
  } finally {
    try { await win.webContents.executeJavaScript('window.__pipCleanup?.()'); } catch {}
    if (!win.isDestroyed()) win.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

app.whenReady().then(main).then(() => app.quit()).catch(error => {
  console.error(`LIBMPV_R2N_WEBGPU_PIP_FAIL=${error?.stack || error}`);
  app.exit(1);
});

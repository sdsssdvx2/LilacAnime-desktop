'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader');
app.commandLine.appendSwitch('enable-dawn-features', 'allow_unsafe_apis');
app.commandLine.appendSwitch('disable-dawn-features', 'use_dxc');
app.commandLine.appendSwitch('enable-webgpu-developer-features');
app.commandLine.appendSwitch('use-gpu-in-tests');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(win, expr, timeout=10000) { const end=Date.now()+timeout; while(Date.now()<end){const v=await win.webContents.executeJavaScript(expr);if(v)return v;await sleep(50)} throw new Error('timeout: '+expr); }

(async()=>{
  await app.whenReady();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r2s-pip-')), html=path.join(dir,'pip.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>body{background:#111}canvas{width:640px;height:360px}video{position:fixed;left:-9999px;width:320px;height:180px}button{width:220px;height:80px}</style><canvas id="c" width="640" height="360"></canvas><video id="v" muted playsinline></video><button id="b">PiP</button><script>
  window.probe={ready:false,clicks:0,entered:false,error:null,retries:0,frames:0};
  const c=document.querySelector('#c'),v=document.querySelector('#v'),b=document.querySelector('#b');
  async function playPipSource(video){for(let attempt=0;attempt<2;attempt++){try{if(video.paused)await video.play();return}catch(error){const loadRace=error?.name==='AbortError'||/interrupted by a new load request/i.test(String(error?.message||''));if(!loadRace||attempt)throw error;probe.retries++;await new Promise(resolve=>{if(video.readyState>=2)return resolve();let done=false;const finish=()=>{if(done)return;done=true;video.removeEventListener('loadedmetadata',finish);video.removeEventListener('canplay',finish);clearTimeout(timer);resolve()};const timer=setTimeout(finish,600);video.addEventListener('loadedmetadata',finish,{once:true});video.addEventListener('canplay',finish,{once:true})})}}}
  b.onclick=async()=>{probe.clicks++;try{if(v.srcObject){v.pause();v.srcObject.getTracks().forEach(t=>t.stop());v.srcObject=null}const stream=c.captureStream(30);v.srcObject=stream;await playPipSource(v);await v.requestPictureInPicture();probe.entered=document.pictureInPictureElement===v}catch(e){probe.error=String(e?.stack||e)}};
  (async()=>{try{if(!navigator.gpu)throw new Error('no gpu');const a=await navigator.gpu.requestAdapter();if(!a)throw new Error('no adapter');const d=await a.requestDevice(),ctx=c.getContext('webgpu'),format=navigator.gpu.getPreferredCanvasFormat();ctx.configure({device:d,format,alphaMode:'opaque'});let f=false;setInterval(()=>{f=!f;const e=d.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view:ctx.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:f?{r:.1,g:.4,b:.8,a:1}:{r:.8,g:.2,b:.1,a:1}}]});p.end();d.queue.submit([e.finish()]);probe.frames++},33);probe.ready=true}catch(e){probe.error=String(e?.stack||e)}})();
</script>`);
  const win=new BrowserWindow({show:true,width:760,height:520,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  try{
    await win.loadFile(html); await waitFor(win,'window.probe.ready||window.probe.error');
    const pt=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#b').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    win.focus();win.webContents.focus();
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(pt.x),y:Math.round(pt.y)});
    win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(pt.x),y:Math.round(pt.y),button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(pt.x),y:Math.round(pt.y),button:'left',clickCount:1});
    const result=await waitFor(win,'window.probe.error?window.probe:(window.probe.entered?window.probe:null)',12000);
    if(result.error)throw new Error(result.error);
    if(result.clicks!==1||!result.entered||result.frames<2)throw new Error('bad result '+JSON.stringify(result));
    console.log('LIBMPV_R2S_PIP_RUNTIME_PASS '+JSON.stringify(result));
    await win.webContents.executeJavaScript(`document.pictureInPictureElement?document.exitPictureInPicture():Promise.resolve()`);
  }finally{if(!win.isDestroyed())win.destroy();fs.rmSync(dir,{recursive:true,force:true})}
})().then(()=>app.quit()).catch(e=>{console.error('LIBMPV_R2S_PIP_RUNTIME_FAIL '+(e?.stack||e));app.exit(1)});

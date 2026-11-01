'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');

// Diagnostic-only hosted qualification. This does not alter the shipped product.
app.commandLine.appendSwitch('disable-gpu-sandbox');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('R45 focus-transition probe exceeded 150s'); process.exit(124); }, 150000);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r45-red.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','color=c=0xd02020:size=640x360:rate=24000/1001:duration=32',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=32',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','24',
    '-c:a','aac','-shortest',out
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed ${String(result.stderr || '').slice(0,240)}`);
  return out;
}

function productHtml(dir) {
  const bundle = path.resolve(__dirname, '..', 'src', 'libmpv-shared.generated.js');
  if (!fs.existsSync(bundle)) throw new Error(`generated renderer missing ${bundle}`);
  fs.copyFileSync(bundle, path.join(dir, 'libmpv-shared.generated.js'));
  const html = path.join(dir, 'r45-player.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#202020}
#immersivePlayer,#videoStage{position:relative} lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#warmGpu{position:absolute;width:16px;height:16px;opacity:.01;pointer-events:none}
</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video><canvas id="warmGpu" width="16" height="16"></canvas></div></div></section>
<script src="./libmpv-shared.generated.js"></script><script>
window.__r45Warm=async()=>{if(!navigator.gpu)return{ok:false,error:'navigator.gpu unavailable'};const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!a)return{ok:false,error:'adapter unavailable'};const d=await a.requestDevice();const c=document.querySelector('#warmGpu');const x=c.getContext('webgpu');if(!x)return{ok:false,error:'context unavailable'};const f=navigator.gpu.getPreferredCanvasFormat();x.configure({device:d,format:f,alphaMode:'opaque'});const e=d.createCommandEncoder();const p=e.beginRenderPass({colorAttachments:[{view:x.getCurrentTexture().createView(),clearValue:{r:.02,g:.04,b:.08,a:1},loadOp:'clear',storeOp:'store'}]});p.end();d.queue.submit([e.finish()]);await d.queue.onSubmittedWorkDone();window.__r45WarmDevice=d;return{ok:true,format:f};};
window.__r45Start=async src=>{await customElements.whenDefined('lilac-mpv-video');const v=document.querySelector('#video');await v.openLilacSource(src,{hls:false,headers:{}});await v.play();return true;};
</script></body></html>`, 'utf8');
  return html;
}

function captureHtml(dir) {
  const html = path.join(dir, 'r45-capture.html');
  fs.writeFileSync(html, `<!doctype html><html><body><video id="v" autoplay muted playsinline style="display:none"></video><canvas id="c" width="64" height="36" style="display:none"></canvas><script>
let samples=[],running=false,stream=null,rect=null,display=null;
function sample(){
  if(!running)return;const v=document.querySelector('#v'),c=document.querySelector('#c'),x=c.getContext('2d',{willReadFrequently:true});
  if(v.readyState>=2&&v.videoWidth>0&&v.videoHeight>0){
    const sx=v.videoWidth/Math.max(1,display.width),sy=v.videoHeight/Math.max(1,display.height);
    const rx=Math.max(0,Math.floor((rect.x+rect.width*.25)*sx)),ry=Math.max(0,Math.floor((rect.y+rect.height*.25)*sy));
    const rw=Math.max(2,Math.floor(rect.width*.5*sx)),rh=Math.max(2,Math.floor(rect.height*.5*sy));
    try{x.drawImage(v,rx,ry,Math.min(rw,v.videoWidth-rx),Math.min(rh,v.videoHeight-ry),0,0,64,36);const d=x.getImageData(0,0,64,36).data;let r=0,g=0,b=0,n=0;for(let i=0;i<d.length;i+=16){r+=d[i];g+=d[i+1];b+=d[i+2];n++;}samples.push({wallMs:Date.now(),r:r/n,g:g/n,b:b/n});if(samples.length>4000)samples.splice(0,samples.length-4000);}catch{}
  }
  if(typeof v.requestVideoFrameCallback==='function')v.requestVideoFrameCallback(sample);else setTimeout(sample,8);
}
window.__r45CaptureStart=async cfg=>{rect=cfg.rect;display=cfg.display;const v=document.querySelector('#v');stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:cfg.sourceId,maxFrameRate:120}}});v.srcObject=stream;await v.play();running=true;sample();return{ok:true,width:v.videoWidth,height:v.videoHeight};};
window.__r45CaptureSamples=()=>samples.slice();window.__r45CaptureStop=()=>{running=false;for(const t of stream?.getTracks?.()||[])t.stop();return true;};
</script></body></html>`, 'utf8');
  return html;
}

async function waitUntil(fn, timeoutMs, label, intervalMs=10) {
  const end = Date.now()+timeoutMs; let last;
  while(Date.now()<end){try{last=await fn();if(last)return last;}catch{} await sleep(intervalMs);} throw new Error(`${label} timeout last=${JSON.stringify(last)}`);
}
const sent = s => Number(s?.metrics?.sentFrames || 0);
const recv = s => Number(s?.receiver?.presentedFrames || 0);
const native = s => s?.r32NativePresenter || {};
const focus = s => s?.r33FocusSurface || {};

async function monitor(bridge, durationMs=650, intervalMs=2) {
  const out=[]; const end=Date.now()+durationMs;
  while(Date.now()<end){
    const s=bridge.state(), n=native(s), f=focus(s);
    out.push({t:Date.now(),focused:!f.active,nativeActive:Boolean(f.active),requested:Boolean(n.requestedVisible),visible:Boolean(n.windowVisible),present:Number(n.presentedFrames||0),sok:Number(n.presentSOkFrames||0),nativeOnly:Number(n.nativeOnlyFrames||0),sent:sent(s),recv:recv(s),handoff:Boolean(f?.r34Handoff?.pending)});
    await sleep(intervalMs);
  }
  return out;
}
function firstAfter(samples, wallMs, pred){return samples.find(x=>x.t>=wallMs&&pred(x))||null;}
function maxGap(samples){let m=0;for(let i=1;i<samples.length;i++)m=Math.max(m,samples[i].t-samples[i-1].t);return m;}
function redEnough(x){return x && x.r>105 && x.r>x.g+45 && x.r>x.b+45;}
function nearBlack(x){return x && Math.max(x.r,x.g,x.b)<50;}
function visualWindow(samples, at, before=25, after=280){return samples.filter(x=>x.wallMs>=at-before&&x.wallMs<=at+after);}

(async()=>{
  await app.whenReady();
  if(!process.env.LILAC_LIBMPV_PLAYER_ADDON||!process.env.LILAC_LIBMPV_DLL)throw new Error('R45 addon/dll env missing');
  if(app.isHardwareAccelerationEnabled?.()===false)throw new Error('hardware acceleration disabled');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r45-transition-'));
  let main,rival,capture,bridge; let captureStarted=false;
  try{
    bridge=createLibmpvSharedBridge({app,ipcMain}); await bridge.ensure();
    const preload=path.resolve(__dirname,'..','electron','preload-libmpv-shared.generated.cjs');
    main=new BrowserWindow({show:true,frame:false,x:80,y:80,width:800,height:600,backgroundColor:'#202020',webPreferences:{preload,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    rival=new BrowserWindow({show:false,frame:false,x:1100,y:80,width:300,height:220,backgroundColor:'#383838',webPreferences:{backgroundThrottling:false}});
    capture=new BrowserWindow({show:false,width:200,height:120,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:false}});
    await bridge.attachWindow(main);
    await main.loadFile(productHtml(dir));
    await rival.loadURL('data:text/html,<body style="background:%23383838">r45 rival</body>');
    await capture.loadFile(captureHtml(dir));
    main.focus(); await waitUntil(()=>main.isFocused(),3000,'initial focus');
    const warm=await main.webContents.executeJavaScript('window.__r45Warm()'); if(!warm?.ok)throw new Error(`WebGPU warmup failed ${JSON.stringify(warm)}`);
    const media=pathToFileURL(fixture(dir)).href;
    if(await main.webContents.executeJavaScript(`window.__r45Start(${JSON.stringify(media)})`)!==true)throw new Error('product start failed');
    await waitUntil(()=>{const s=bridge.state();return s?.fileLoaded===true&&sent(s)>=12&&recv(s)>=12;},15000,'focused red baseline');

    // Continuous DWM capture is optional because some hosted runners expose a neutral
    // virtual desktop. When observable it becomes an actual black-frame gate; when not,
    // the transition-order timeline remains useful evidence instead of false-failing.
    let captureError='';
    try{
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:64,height:36}});
      if(!sources.length)throw new Error('no screen sources');
      const d=screen.getPrimaryDisplay();
      const result=await capture.webContents.executeJavaScript(`window.__r45CaptureStart(${JSON.stringify({sourceId:sources[0].id,rect:{x:80,y:80,width:800,height:600},display:{width:d.bounds.width,height:d.bounds.height}})})`);
      captureStarted=Boolean(result?.ok); await sleep(700);
    }catch(error){captureError=String(error?.message||error).slice(0,180);}
    let initialVisual=[];
    if(captureStarted)initialVisual=await capture.webContents.executeJavaScript('window.__r45CaptureSamples()');
    const visualObservable=initialVisual.slice(-12).some(redEnough);

    const cycles=[];
    for(let i=1;i<=8;i++){
      const beforeBlur=bridge.state(); const basePresent=Number(native(beforeBlur).presentedFrames||0),baseNativeOnly=Number(native(beforeBlur).nativeOnlyFrames||0);
      const blurAt=Date.now(); const blurMonitor=monitor(bridge,700,2); rival.show(); rival.focus();
      await waitUntil(()=>!main.isFocused()&&rival.isFocused(),3000,`cycle${i} blur focus`);
      await waitUntil(()=>focus(bridge.state()).active===true,4000,`cycle${i} native active`);
      const bt=await blurMonitor;
      const visible=firstAfter(bt,blurAt,x=>x.visible),presented=firstAfter(bt,blurAt,x=>x.present>basePresent),nativeOnly=firstAfter(bt,blurAt,x=>x.nativeOnly>baseNativeOnly);
      if(!visible||!presented||!nativeOnly)throw new Error(`cycle${i} blur transition incomplete visible=${!!visible} presented=${!!presented} nativeOnly=${!!nativeOnly}`);
      const visibleToPresentMs=presented.t-visible.t;
      await sleep(350);

      const beforeFocus=bridge.state(); const baseRecv=recv(beforeFocus); const focusAt=Date.now(); const focusMonitor=monitor(bridge,850,2);
      main.show();main.moveTop();main.focus();await waitUntil(()=>main.isFocused(),3000,`cycle${i} refocus`);
      const ft=await focusMonitor;
      const rendererFrame=firstAfter(ft,focusAt,x=>x.recv>baseRecv),hidden=firstAfter(ft,focusAt,x=>!x.visible&&!x.nativeActive);
      if(!rendererFrame||!hidden)throw new Error(`cycle${i} refocus transition incomplete renderer=${!!rendererFrame} hidden=${!!hidden}`);
      const hideMinusRendererMs=hidden.t-rendererFrame.t;
      cycles.push({i,blurAt,focusAt,visibleToPresentMs,hideMinusRendererMs,blurMaxPollGap:maxGap(bt),focusMaxPollGap:maxGap(ft)});
      await sleep(350);
    }

    let visual=[]; if(captureStarted)visual=await capture.webContents.executeJavaScript('window.__r45CaptureSamples()');
    const visualResults=[]; let blackFrames=0,transitionFrames=0;
    if(visualObservable){
      for(const c of cycles){
        for(const [kind,at] of [['blur',c.blurAt],['focus',c.focusAt]]){
          const w=visualWindow(visual,at); const black=w.filter(nearBlack).length; const red=w.filter(redEnough).length;
          blackFrames+=black;transitionFrames+=w.length;visualResults.push({cycle:c.i,kind,samples:w.length,black,red});
        }
      }
      if(blackFrames>0)throw new Error(`R45_DWM_BLACK_FRAME_DETECTED black=${blackFrames}/${transitionFrames} details=${JSON.stringify(visualResults)}`);
    }

    const maxVisibleLead=Math.max(...cycles.map(c=>c.visibleToPresentMs));
    const minHideAfterRenderer=Math.min(...cycles.map(c=>c.hideMinusRendererMs));
    const maxPollGap=Math.max(...cycles.flatMap(c=>[c.blurMaxPollGap,c.focusMaxPollGap]));
    console.log(`R45_FOCUS_TRANSITION_VISUAL_PROBE_OK cycles=${cycles.length} dmwObservable=${visualObservable?1:0} dwmBlackFrames=${blackFrames} dwmTransitionSamples=${transitionFrames} maxNativeVisibleToPresentMs=${maxVisibleLead} minNativeHideMinusRendererFrameMs=${minHideAfterRenderer} maxStatePollGapMs=${maxPollGap} captureError=${JSON.stringify(captureError)} ordering=${JSON.stringify(cycles)}`);
  } finally {
    clearTimeout(deadline);
    try{if(captureStarted)await capture?.webContents?.executeJavaScript('window.__r45CaptureStop()');}catch{}
    try{await bridge?.close?.();}catch{} try{await bridge?.dispose?.();}catch{}
    try{capture?.destroy();}catch{} try{rival?.destroy();}catch{} try{main?.destroy();}catch{}
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{} delete process.env.LILAC_LIBMPV_TEST_AO_NULL; app.quit();
  }
})().catch(error=>{clearTimeout(deadline);console.error(error?.stack||error);process.exitCode=1;try{app.quit();}catch{}});

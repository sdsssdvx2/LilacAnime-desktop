'use strict';

const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawnSync}=require('node:child_process');
const {app,BrowserWindow,ipcMain}=require('electron');
const {createLibmpvSharedBridge}=require('../electron/libmpv-shared-main.cjs');
app.commandLine.appendSwitch('disable-gpu-sandbox');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const deadline=setTimeout(()=>{console.error('R40 callback pacing smoke exceeded 120s');process.exit(124)},120000);

function fixture(dir){
  const ffmpeg=require('ffmpeg-static'),out=path.join(dir,'r40-pacing.mp4');
  const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=25','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',out],{encoding:'utf8',windowsHide:true,timeout:120000});
  if(r.status!==0||!fs.existsSync(out))throw new Error(`fixture failed ${String(r.stderr||'').slice(0,240)}`);
  return out;
}
function html(dir){
  const bundle=path.resolve(__dirname,'..','src','libmpv-shared.generated.js');
  fs.copyFileSync(bundle,path.join(dir,'libmpv-shared.generated.js'));
  const out=path.join(dir,'r40-pacing.html');
  fs.writeFileSync(out,`<!doctype html><html><head><meta charset="utf-8"><style>html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#202020}#immersivePlayer,#videoStage{position:relative}lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%}</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video></div></div></section><script src="./libmpv-shared.generated.js"></script><script>window.__start=async src=>{await customElements.whenDefined('lilac-mpv-video');const v=document.querySelector('#video');await v.openLilacSource(src,{hls:false,headers:{}});await v.play();return true}</script></body></html>`,'utf8');
  return out;
}
async function waitUntil(fn,ms,label){const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last}catch{}await sleep(20)}throw new Error(`${label} timeout last=${JSON.stringify(last)}`)}
const n=(x,k)=>Number(x?.[k]||0);
const delta=(a,b,k)=>n(b,k)-n(a,k);

(async()=>{
  await app.whenReady();
  if(!process.env.LILAC_LIBMPV_PLAYER_ADDON||!process.env.LILAC_LIBMPV_DLL)throw new Error('R40 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r40-pacing-'));
  let win,bridge;
  try{
    bridge=createLibmpvSharedBridge({app,ipcMain});await bridge.ensure();
    const preload=path.resolve(__dirname,'..','electron','preload-libmpv-shared.generated.cjs');
    win=new BrowserWindow({show:true,width:800,height:600,backgroundColor:'#202020',webPreferences:{preload,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    await bridge.attachWindow(win);await win.loadFile(html(dir));win.focus();
    await waitUntil(()=>win.isFocused(),3000,'focus');

    // Do not use a synthetic navigator.gpu.requestAdapter() warm-up as a gate.
    // R37 proved the real product shared-texture/direct-WebGPU path can work on
    // the hosted Windows runner even when an isolated adapter probe returns null.
    // The actual product renderer below is the authority: if it cannot initialize
    // direct WebGPU, import/present real frames, and sustain cadence, this test fails.
    const media=pathToFileURL(fixture(dir)).href;
    if(await win.webContents.executeJavaScript(`window.__start(${JSON.stringify(media)})`)!==true)throw new Error('product start failed');
    await waitUntil(()=>{
      const s=bridge.state();
      const direct=String(s?.receiver?.presentationMode||'')==='direct-receive-webgpu-copy';
      const frames=n(s?.metrics,'sentFrames')>=24&&n(s?.receiver,'presentedFrames')>=20;
      return s?.fileLoaded===true&&direct&&frames?s:null;
    },20000,'actual product direct-WebGPU frames');
    await sleep(1000);
    const before=bridge.state(),p0=before.frameProducer||{},m0=before.metrics||{};
    if(String(before?.receiver?.presentationMode)!=='direct-receive-webgpu-copy')throw new Error(`actual product direct WebGPU not active at baseline: ${before?.receiver?.presentationMode}`);
    if(n(m0,'importFailures')!==0||n(m0,'sendFailures')!==0)throw new Error(`actual product WebGPU transport failed at baseline import=${m0.importFailures} send=${m0.sendFailures}`);
    if(String(p0.enabled)!=='true'&&p0.enabled!==true)throw new Error('native producer not enabled');
    if(!Object.hasOwn(p0,'signalWakeups')||!Object.hasOwn(p0,'watchdogWakeups')||!Object.hasOwn(p0,'releaseWakeups'))throw new Error('R40 producer diagnostics missing');
    if(!Object.hasOwn(m0,'r40PumpNativeSignalTicks')||!Object.hasOwn(m0,'r40NoFrameTimerTicks'))throw new Error('R40 JS pacing diagnostics missing');

    await sleep(8000);
    const after=bridge.state(),p1=after.frameProducer||{},m1=after.metrics||{};
    const raw=delta(p0,p1,'rawWakeSignals'),worker=delta(p0,p1,'workerWakeups'),signals=delta(p0,p1,'signalWakeups'),watchdogs=delta(p0,p1,'watchdogWakeups'),releaseWakes=delta(p0,p1,'releaseWakeups'),produced=delta(p0,p1,'producedFrames');
    const sent=delta(m0,m1,'sentFrames'),timerTicks=delta(m0,m1,'r40PumpTimerTicks'),nativeTicks=delta(m0,m1,'r40PumpNativeSignalTicks'),pendingTicks=delta(m0,m1,'r40PumpPendingSignalTicks');
    const noTimer=delta(m0,m1,'r40NoFrameTimerTicks'),noNative=delta(m0,m1,'r40NoFrameNativeSignalTicks'),noPending=delta(m0,m1,'r40NoFramePendingSignalTicks');
    const fresh=delta(m0,m1,'r40FreshFrameSignals'),stale=delta(m0,m1,'r40StaleFrameSignals');

    if(produced<140||sent<130)throw new Error(`insufficient sustained playback produced=${produced} sent=${sent}`);
    if(n(p1,'backpressure')!==0)throw new Error(`unexpected producer backpressure=${p1.backpressure}`);
    if(releaseWakes!==0)throw new Error(`slot release woke producer without backpressure releaseWakes=${releaseWakes}`);
    if(p1.waitingForSlot===true)throw new Error('producer left waitingForSlot asserted');
    if(watchdogs>3)throw new Error(`callback stream fell back to watchdog too often watchdogs=${watchdogs}`);
    if(worker>raw+watchdogs+6)throw new Error(`worker wake amplification survived raw=${raw} worker=${worker} watchdog=${watchdogs}`);
    if(signals+watchdogs+3<worker)throw new Error(`worker wake accounting incomplete worker=${worker} signal=${signals} watchdog=${watchdogs}`);
    if(noTimer>3)throw new Error(`JS watchdog produced too many empty drains noTimer=${noTimer} timerTicks=${timerTicks}`);
    if(noNative>3)throw new Error(`fresh native signals produced too many empty drains noNative=${noNative} nativeTicks=${nativeTicks}`);
    if(noPending>3)throw new Error(`latched fresh signals produced too many empty drains noPending=${noPending} pendingTicks=${pendingTicks}`);
    if(fresh<Math.max(100,Math.floor(sent*.7)))throw new Error(`too few fresh frame-id signals fresh=${fresh} sent=${sent}`);
    if(n(m1,'importFailures')!==0||n(m1,'sendFailures')!==0||n(m1,'backpressure')!==0)throw new Error(`transport failure import=${m1.importFailures} send=${m1.sendFailures} backpressure=${m1.backpressure}`);
    if(String(after?.receiver?.presentationMode)!=='direct-receive-webgpu-copy')throw new Error(`focused direct WebGPU lost: ${after?.receiver?.presentationMode}`);
    const cadence=after?.receiver?.cadence||{};
    if(Number(cadence.sampleCount||0)<10)throw new Error('renderer cadence sample too small');
    if(Number(cadence.intervalP95Ms||999)>65||Number(cadence.intervalMaxMs||999)>160)throw new Error(`focused cadence regressed p95=${cadence.intervalP95Ms} max=${cadence.intervalMaxMs}`);

    console.log(`R40_CALLBACK_PACING_RUNTIME_OK seconds=8 productDirectWebgpu=1 raw=${raw} worker=${worker} signalWake=${signals} watchdogWake=${watchdogs} releaseWake=${releaseWakes} produced=${produced} sent=${sent} freshSignals=${fresh} staleSignals=${stale} timerTicks=${timerTicks} nativeTicks=${nativeTicks} pendingTicks=${pendingTicks} noFrameTimer=${noTimer} noFrameNative=${noNative} noFramePending=${noPending} p95=${cadence.intervalP95Ms} max=${cadence.intervalMaxMs} directWebgpu=1 backpressure=0`);
  }finally{
    clearTimeout(deadline);try{await bridge?.close?.()}catch{}try{await bridge?.dispose?.()}catch{}try{win?.destroy()}catch{}try{fs.rmSync(dir,{recursive:true,force:true})}catch{}delete process.env.LILAC_LIBMPV_TEST_AO_NULL;app.quit();
  }
})().catch(e=>{clearTimeout(deadline);console.error(e?.stack||e);process.exitCode=1;try{app.quit()}catch{}});

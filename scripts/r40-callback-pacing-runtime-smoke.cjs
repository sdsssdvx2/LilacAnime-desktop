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
const deadline=setTimeout(()=>{console.error('R40 callback pacing smoke exceeded 150s');process.exit(124)},150000);

function fixture(dir){
  const ffmpeg=require('ffmpeg-static'),out=path.join(dir,'r40-pacing.mp4');
  const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=50','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=50','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',out],{encoding:'utf8',windowsHide:true,timeout:120000});
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
async function waitUntil(fn,ms,label,interval=20){const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last}catch{}await sleep(interval)}throw new Error(`${label} timeout last=${JSON.stringify(last)}`)}
const n=(x,k)=>Number(x?.[k]||0);
const delta=(a,b,k)=>n(b,k)-n(a,k);
const sent=s=>n(s?.metrics,'sentFrames');
const presented=s=>n(s?.receiver,'presentedFrames');
const focusState=s=>s?.r33FocusSurface||{};
function postFocusGaps(state,sinceWallMs){
  const anomalies=state?.r27FocusStallRetention?.mainAnomalies||[];
  return anomalies.filter(item=>item?.kind==='dispatch-gap'&&Number(item.wallMs||0)>=sinceWallMs&&item.focused===true).map(item=>Number(item.gapMs||0));
}

async function blurRefocusCycle(bridge,main,rival,index){
  rival.show();rival.focus();
  await waitUntil(()=>!main.isFocused()&&rival.isFocused(),3000,`cycle${index} owner blur`);
  await waitUntil(()=>focusState(bridge.state()).active===true,4000,`cycle${index} native-only active`);
  const blurStart=bridge.state(),blurSent0=sent(blurStart);
  await sleep(4000);
  const blurEnd=bridge.state(),blurSentDelta=sent(blurEnd)-blurSent0;
  if(blurSentDelta>1)throw new Error(`cycle${index} Chromium delivery continued during native-only blur delta=${blurSentDelta}`);

  const sentBefore=sent(blurEnd),presentedBefore=presented(blurEnd),focusRequestWallMs=Date.now();
  main.show();main.focus();
  await waitUntil(()=>main.isFocused(),3000,`cycle${index} BrowserWindow refocus`);
  const first=await waitUntil(()=>{
    const state=bridge.state();
    const direct=String(state?.receiver?.presentationMode||'')==='direct-receive-webgpu-copy';
    return direct&&sent(state)>sentBefore&&presented(state)>presentedBefore?state:null;
  },700,`cycle${index} first real direct-WebGPU frame after refocus`,5);
  const firstFrameMs=Date.now()-focusRequestWallMs;
  if(firstFrameMs>500)throw new Error(`cycle${index} first focused direct-WebGPU frame too slow ${firstFrameMs}ms`);

  const sentAtFirst=sent(first);
  const sustained=await waitUntil(()=>{
    const state=bridge.state();
    return String(state?.receiver?.presentationMode||'')==='direct-receive-webgpu-copy'&&sent(state)>=sentAtFirst+12?state:null;
  },1000,`cycle${index} sustained focused direct-WebGPU cadence`,10);
  const gaps=postFocusGaps(sustained,focusRequestWallMs),maxGap=gaps.length?Math.max(...gaps):0;
  if(maxGap>=300)throw new Error(`cycle${index} focused dispatch gap survived refocus maxGap=${maxGap} gaps=${JSON.stringify(gaps)}`);
  if(n(sustained?.metrics,'importFailures')!==0||n(sustained?.metrics,'sendFailures')!==0)throw new Error(`cycle${index} transport failure import=${sustained?.metrics?.importFailures} send=${sustained?.metrics?.sendFailures}`);
  if(n(focusState(sustained)?.r34Handoff?.r37Handoff,'rejectedRendererAcks')!==0)throw new Error(`cycle${index} rejected R37 renderer ACK`);
  return {firstFrameMs,maxGap,blurSentDelta};
}

(async()=>{
  await app.whenReady();
  if(!process.env.LILAC_LIBMPV_PLAYER_ADDON||!process.env.LILAC_LIBMPV_DLL)throw new Error('R40 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r40-pacing-'));
  let win,rival,bridge;
  try{
    bridge=createLibmpvSharedBridge({app,ipcMain});await bridge.ensure();
    const preload=path.resolve(__dirname,'..','electron','preload-libmpv-shared.generated.cjs');
    win=new BrowserWindow({show:true,width:800,height:600,backgroundColor:'#202020',webPreferences:{preload,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    rival=new BrowserWindow({show:false,width:320,height:240,backgroundColor:'#303030',webPreferences:{backgroundThrottling:false}});
    await bridge.attachWindow(win);await win.loadFile(html(dir));await rival.loadURL('data:text/html,<body style="background:%23303030;color:white">R40 pacing rival</body>');win.focus();
    await waitUntil(()=>win.isFocused(),3000,'focus');

    // Do not use a synthetic navigator.gpu.requestAdapter() warm-up as a gate.
    // The actual product renderer is the authority: it must initialize direct
    // WebGPU, import/present real frames, sustain cadence, then do so again after
    // real native-only blur/refocus epochs.
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
    const sentDelta=delta(m0,m1,'sentFrames'),timerTicks=delta(m0,m1,'r40PumpTimerTicks'),nativeTicks=delta(m0,m1,'r40PumpNativeSignalTicks'),pendingTicks=delta(m0,m1,'r40PumpPendingSignalTicks');
    const noTimer=delta(m0,m1,'r40NoFrameTimerTicks'),noNative=delta(m0,m1,'r40NoFrameNativeSignalTicks'),noPending=delta(m0,m1,'r40NoFramePendingSignalTicks');
    const fresh=delta(m0,m1,'r40FreshFrameSignals'),stale=delta(m0,m1,'r40StaleFrameSignals');

    if(produced<140||sentDelta<130)throw new Error(`insufficient sustained playback produced=${produced} sent=${sentDelta}`);
    if(n(p1,'backpressure')!==0)throw new Error(`unexpected producer backpressure=${p1.backpressure}`);
    if(releaseWakes!==0)throw new Error(`slot release woke producer without backpressure releaseWakes=${releaseWakes}`);
    if(p1.waitingForSlot===true)throw new Error('producer left waitingForSlot asserted');
    if(watchdogs>3)throw new Error(`callback stream fell back to watchdog too often watchdogs=${watchdogs}`);
    if(worker>raw+watchdogs+6)throw new Error(`worker wake amplification survived raw=${raw} worker=${worker} watchdog=${watchdogs}`);
    if(signals+watchdogs+3<worker)throw new Error(`worker wake accounting incomplete worker=${worker} signal=${signals} watchdog=${watchdogs}`);
    if(noTimer>3)throw new Error(`JS watchdog produced too many empty drains noTimer=${noTimer} timerTicks=${timerTicks}`);
    if(noNative>3)throw new Error(`fresh native signals produced too many empty drains noNative=${noNative} nativeTicks=${nativeTicks}`);
    if(noPending>3)throw new Error(`latched fresh signals produced too many empty drains noPending=${noPending} pendingTicks=${pendingTicks}`);
    if(fresh<Math.max(100,Math.floor(sentDelta*.7)))throw new Error(`too few fresh frame-id signals fresh=${fresh} sent=${sentDelta}`);
    if(n(m1,'importFailures')!==0||n(m1,'sendFailures')!==0||n(m1,'backpressure')!==0)throw new Error(`transport failure import=${m1.importFailures} send=${m1.sendFailures} backpressure=${m1.backpressure}`);
    if(String(after?.receiver?.presentationMode)!=='direct-receive-webgpu-copy')throw new Error(`focused direct WebGPU lost: ${after?.receiver?.presentationMode}`);
    const cadence=after?.receiver?.cadence||{};
    if(Number(cadence.sampleCount||0)<10)throw new Error('renderer cadence sample too small');
    if(Number(cadence.intervalP95Ms||999)>65||Number(cadence.intervalMaxMs||999)>160)throw new Error(`focused cadence regressed p95=${cadence.intervalP95Ms} max=${cadence.intervalMaxMs}`);

    // Replace R39's synthetic adapter warm-up evidence with the real R40 product
    // renderer itself. Three long native-only epochs must return to actual direct
    // WebGPU promptly and sustain frames without the 1s+ gaps seen in the user's
    // R38/R39 diagnostics.
    const cycles=[];
    for(let i=1;i<=3;i+=1)cycles.push(await blurRefocusCycle(bridge,win,rival,i));
    const maxFirst=Math.max(...cycles.map(x=>x.firstFrameMs)),maxGap=Math.max(...cycles.map(x=>x.maxGap));
    if(String(bridge.state()?.receiver?.presentationMode||'')!=='direct-receive-webgpu-copy')throw new Error('direct WebGPU not active after final refocus cycle');

    console.log(`R40_CALLBACK_PACING_RUNTIME_OK seconds=8 productDirectWebgpu=1 raw=${raw} worker=${worker} signalWake=${signals} watchdogWake=${watchdogs} releaseWake=${releaseWakes} produced=${produced} sent=${sentDelta} freshSignals=${fresh} staleSignals=${stale} timerTicks=${timerTicks} nativeTicks=${nativeTicks} pendingTicks=${pendingTicks} noFrameTimer=${noTimer} noFrameNative=${noNative} noFramePending=${noPending} p95=${cadence.intervalP95Ms} max=${cadence.intervalMaxMs} directWebgpu=1 backpressure=0 refocusCycles=3 blurMs=4000 maxFirstFocusedFrameMs=${maxFirst} maxPostFocusDispatchGapMs=${maxGap} nativeOnlyChromiumSuppressed=1`);
  }finally{
    clearTimeout(deadline);try{await bridge?.close?.()}catch{}try{await bridge?.dispose?.()}catch{}try{rival?.destroy()}catch{}try{win?.destroy()}catch{}try{fs.rmSync(dir,{recursive:true,force:true})}catch{}delete process.env.LILAC_LIBMPV_TEST_AO_NULL;app.quit();
  }
})().catch(e=>{clearTimeout(deadline);console.error(e?.stack||e);process.exitCode=1;try{app.quit()}catch{}});
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');

app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('R41 first-present runtime smoke exceeded 120s'); process.exit(124); }, 120000);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r41-first-present-red.mp4');
  const result = spawnSync(ffmpeg, ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:size=640x360:rate=24000/1001:duration=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=24','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-c:a','aac','-b:a','64k','-shortest','-movflags','+faststart',out], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`R41 fixture encode failed: ${String(result.stderr || '').slice(0,240)}`);
  return out;
}
function html(dir) {
  const bundle = path.resolve(__dirname, '..', 'src', 'libmpv-shared.generated.js');
  fs.copyFileSync(bundle, path.join(dir, 'libmpv-shared.generated.js'));
  const out = path.join(dir, 'r41-first-present.html');
  fs.writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(15,35,180)}#immersivePlayer,#videoStage{position:relative}lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%}</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video></div></div></section><script src="./libmpv-shared.generated.js"></script><script>window.__start=async src=>{await customElements.whenDefined('lilac-mpv-video');const v=document.querySelector('#video');await v.openLilacSource(src,{hls:false,headers:{}});await v.play();return true}</script></body></html>`, 'utf8');
  return out;
}
async function waitUntil(fn, timeoutMs, label, interval=5) { const end=Date.now()+timeoutMs; let last; while(Date.now()<end){ try{last=await fn();if(last)return last}catch{} await sleep(interval) } throw new Error(`${label} timeout last=${JSON.stringify(last)}`); }
async function capturePrimary(){ const display=screen.getPrimaryDisplay(); const width=Math.max(320,Math.round(display.bounds.width)),height=Math.max(240,Math.round(display.bounds.height)); const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width,height},fetchWindowIcons:false}); const source=sources.find(x=>String(x.display_id||'')===String(display.id))||sources[0]; if(!source)throw new Error('R41 desktop capture source missing'); return {image:source.thumbnail,display}; }
function sampleCenter(capture,stats){ const size=capture.image.getSize(),bitmap=capture.image.toBitmap(),display=capture.display; const left=Number(stats?.screenLeft||0),top=Number(stats?.screenTop||0),width=Number(stats?.screenWidth||0),height=Number(stats?.screenHeight||0); const sx=size.width/Math.max(1,display.bounds.width),sy=size.height/Math.max(1,display.bounds.height),cx=Math.round((left-display.bounds.x+width/2)*sx),cy=Math.round((top-display.bounds.y+height/2)*sy); let b=0,g=0,r=0,n=0; for(let y=Math.max(0,cy-12);y<Math.min(size.height,cy+12);y++)for(let x=Math.max(0,cx-12);x<Math.min(size.width,cx+12);x++){const o=(y*size.width+x)*4;b+=bitmap[o];g+=bitmap[o+1];r+=bitmap[o+2];n++} return {b:b/n,g:g/n,r:r/n}; }
const nativeStats=s=>s?.r32NativePresenter||{}; const focusStats=s=>s?.r33FocusSurface||{}; const commitStats=s=>focusStats(s)?.r41FirstPresentCommit||{};

(async()=>{
  await app.whenReady();
  if(!process.env.LILAC_LIBMPV_PLAYER_ADDON||!process.env.LILAC_LIBMPV_DLL)throw new Error('R41 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r41-first-present-')); let main,rival,bridge;
  try{
    bridge=createLibmpvSharedBridge({app,ipcMain}); await bridge.ensure();
    const preload=path.resolve(__dirname,'..','electron','preload-libmpv-shared.generated.cjs');
    main=new BrowserWindow({show:true,width:800,height:600,backgroundColor:'#0f23b4',webPreferences:{preload,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    rival=new BrowserWindow({show:false,width:280,height:180,x:20,y:20,backgroundColor:'#303030',webPreferences:{backgroundThrottling:false}});
    await bridge.attachWindow(main); await main.loadFile(html(dir)); await rival.loadURL('data:text/html,<body style="background:%23303030;color:white">R41 rival</body>'); main.focus();
    await waitUntil(()=>main.isFocused(),3000,'R41 initial focus');
    const media=pathToFileURL(fixture(dir)).href;
    if(await main.webContents.executeJavaScript(`window.__start(${JSON.stringify(media)})`)!==true)throw new Error('R41 product start failed');
    await waitUntil(()=>{const s=bridge.state();return s?.fileLoaded===true&&String(s?.receiver?.presentationMode||'')==='direct-receive-webgpu-copy'&&Number(s?.receiver?.presentedFrames||0)>=20?s:null},20000,'R41 direct WebGPU baseline');
    const baseline=bridge.state();
    if(nativeStats(baseline)?.r41FirstPresentMarker!=='LILAC_R41_FIRST_PRESENT_BEFORE_SHOW')throw new Error('R41 native first-present diagnostics missing');
    if(commitStats(baseline)?.marker!=='LILAC_R41_BLUR_FIRST_PRESENT_COMMIT')throw new Error('R41 bridge first-present diagnostics missing');

    const cycles=[];
    for(let i=1;i<=5;i++){
      const before=bridge.state(),ns0=nativeStats(before),cs0=commitStats(before); const arm0=Number(ns0.r41VisibilityArmCount||0),defer0=Number(ns0.r41VisibilityDeferredCount||0),commit0=Number(ns0.r41VisibilityCommitCount||0),forced0=Number(cs0.forcedRedrawAccepted||0),bridgeCommit0=Number(cs0.commits||0),start=Date.now();
      rival.show();rival.focus(); await waitUntil(()=>!main.isFocused()&&rival.isFocused(),3000,`R41 cycle${i} real blur`); await waitUntil(()=>focusStats(bridge.state()).active===true,1000,`R41 cycle${i} native ownership arm`);
      const armed=await waitUntil(()=>{const s=bridge.state(),ns=nativeStats(s);return Number(ns.r41VisibilityArmCount||0)>arm0?s:null},1000,`R41 cycle${i} visibility arm`,2),armedNs=nativeStats(armed);
      if(armedNs.windowVisible===true&&armedNs.r41FirstPresentReady!==true)throw new Error(`R41 cycle${i} popup visible before first Present ${JSON.stringify(armedNs)}`);
      const committed=await waitUntil(()=>{const s=bridge.state(),ns=nativeStats(s),cs=commitStats(s);return ns.r41FirstPresentReady===true&&ns.windowVisible===true&&Number(ns.r41VisibilityCommitCount||0)>commit0&&Number(cs.commits||0)>bridgeCommit0?s:null},500,`R41 cycle${i} first-present commit`,2);
      const elapsed=Date.now()-start,ns1=nativeStats(committed),cs1=commitStats(committed);
      if(Number(ns1.r41VisibilityDeferredCount||0)<=defer0)throw new Error(`R41 cycle${i} first show was not deferred`);
      if(Number(cs1.forcedRedrawAccepted||0)<=forced0)throw new Error(`R41 cycle${i} blur forced redraw not accepted`);
      if(Number(ns1.r41VisibilityPrematureShowCount||0)!==0)throw new Error(`R41 cycle${i} premature popup show detected`);
      if(Number(cs1.timeouts||0)!==0)throw new Error(`R41 cycle${i} first-present commit timeout`);
      if(elapsed>250)throw new Error(`R41 cycle${i} first-present commit too slow ${elapsed}ms`);
      const means=sampleCenter(await capturePrimary(),ns1); if(!(means.r>110&&means.r>means.g+45&&means.r>means.b+45))throw new Error(`R41 cycle${i} committed native DWM sample not red / possible black frame ${JSON.stringify(means)}`);
      await sleep(250); main.show();main.focus(); await waitUntil(()=>main.isFocused(),3000,`R41 cycle${i} refocus`); await waitUntil(()=>nativeStats(bridge.state()).windowVisible===false,1000,`R41 cycle${i} popup hide`); await waitUntil(()=>String(bridge.state()?.receiver?.presentationMode||'')==='direct-receive-webgpu-copy',1000,`R41 cycle${i} focused direct WebGPU`); cycles.push(elapsed); await sleep(150);
    }
    const final=bridge.state(),ns=nativeStats(final),cs=commitStats(final); if(Number(ns.r41VisibilityPrematureShowCount||0)!==0)throw new Error('R41 final premature show count nonzero'); if(Number(cs.timeouts||0)!==0)throw new Error('R41 final commit timeout count nonzero'); if(Number(cs.forcedRedrawAccepted||0)<5)throw new Error(`R41 forced redraw accepts too small ${cs.forcedRedrawAccepted}`); if(Number(cs.commits||0)<5)throw new Error(`R41 bridge commits too small ${cs.commits}`); if(String(final?.receiver?.presentationMode||'')!=='direct-receive-webgpu-copy')throw new Error('R41 final focused direct WebGPU lost');
    console.log(`R41_FIRST_PRESENT_RUNTIME_OK cycles=5 maxCommitMs=${Math.max(...cycles)} nativeArms=${ns.r41VisibilityArmCount} nativeDeferred=${ns.r41VisibilityDeferredCount} nativeCommits=${ns.r41VisibilityCommitCount} prematureShows=${ns.r41VisibilityPrematureShowCount} blurRedrawAccepted=${cs.forcedRedrawAccepted} bridgeCommits=${cs.commits} timeouts=${cs.timeouts} dwmCommittedRed=5 focusRecovery=direct-webgpu`);
  }finally{clearTimeout(deadline);try{await bridge?.close?.()}catch{}try{await bridge?.dispose?.()}catch{}try{rival?.destroy()}catch{}try{main?.destroy()}catch{}try{fs.rmSync(dir,{recursive:true,force:true})}catch{}delete process.env.LILAC_LIBMPV_TEST_AO_NULL;app.quit()}
})().catch(error=>{clearTimeout(deadline);console.error(error?.stack||error);process.exitCode=1;try{app.quit()}catch{}});

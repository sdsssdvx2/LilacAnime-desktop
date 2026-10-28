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
const hardDeadline = setTimeout(() => { console.error('R39 refocus E2E exceeded 150s'); process.exit(124); }, 150000);
function fail(error) { console.error(error?.stack || error); try { app.exit(1); } catch { process.exit(1); } }
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'r39-refocus.mp4');
  const result = spawnSync(ffmpeg, ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=30','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',out], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed ${String(result.stderr || '').slice(0,240)}`);
  return out;
}
function productHtml(dir) {
  const bundle = path.resolve(__dirname, '..', 'src', 'libmpv-shared.generated.js');
  if (!fs.existsSync(bundle)) throw new Error(`generated renderer missing: ${bundle}`);
  fs.copyFileSync(bundle, path.join(dir, 'libmpv-shared.generated.js'));
  const html = path.join(dir, 'r39.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#playerView,#immersivePlayer,#videoStage{margin:0;width:100%;height:100%;overflow:hidden;background:#181818}#immersivePlayer,#videoStage{position:relative}lilac-mpv-video{position:absolute;inset:0;width:100%;height:100%}#warm{position:absolute;width:16px;height:16px;opacity:.01}</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer"><div id="videoStage"><lilac-mpv-video id="video"></lilac-mpv-video><canvas id="warm" width="16" height="16"></canvas></div></div></section><script src="./libmpv-shared.generated.js"></script><script>
window.__warm=async()=>{if(!navigator.gpu)return{ok:false,error:'navigator.gpu unavailable'};const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!a)return{ok:false,error:'adapter unavailable'};const d=await a.requestDevice();const c=document.querySelector('#warm'),x=c.getContext('webgpu');if(!x)return{ok:false,error:'context unavailable'};const f=navigator.gpu.getPreferredCanvasFormat();x.configure({device:d,format:f,alphaMode:'opaque'});const e=d.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view:x.getCurrentTexture().createView(),clearValue:{r:.1,g:.1,b:.1,a:1},loadOp:'clear',storeOp:'store'}]});p.end();d.queue.submit([e.finish()]);await d.queue.onSubmittedWorkDone();window.__d=d;return{ok:true}};
window.__start=async src=>{await customElements.whenDefined('lilac-mpv-video');const v=document.querySelector('#video');await v.openLilacSource(src,{hls:false,headers:{}});await v.play();return true};
</script></body></html>`, 'utf8');
  return html;
}
async function waitUntil(fn, ms, label) {
  const end = Date.now()+ms; let last;
  while (Date.now()<end) { try { last=await fn(); if(last) return last; } catch {} await sleep(20); }
  throw new Error(`${label} timeout last=${JSON.stringify(last)}`);
}
function view(bridge) {
  const state=bridge.state(), focus=state?.r33FocusSurface||{}, handoff=focus?.r34Handoff||{}, r36=handoff?.r36Ack||{}, r37=handoff?.r37Handoff||{}, r39=handoff?.r39RuntimeRecovery||{};
  return {state,focus,handoff,r36,r37,r39};
}

(async()=>{
  await app.whenReady();
  if (!process.env.LILAC_LIBMPV_PLAYER_ADDON || !process.env.LILAC_LIBMPV_DLL) throw new Error('R39 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r39-refocus-'));
  let main,other,bridge;
  try {
    bridge=createLibmpvSharedBridge({app,ipcMain}); await bridge.ensure();
    const preload=path.resolve(__dirname,'..','electron','preload-libmpv-shared.generated.cjs'), html=productHtml(dir);
    main=new BrowserWindow({show:true,width:800,height:600,backgroundColor:'#181818',webPreferences:{preload,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    other=new BrowserWindow({show:false,width:360,height:260,backgroundColor:'#303030',webPreferences:{backgroundThrottling:false}});
    await bridge.attachWindow(main); await main.loadFile(html); await other.loadURL('data:text/html,<body style="background:%23303030"></body>');
    main.focus(); await waitUntil(()=>main.isFocused(),3000,'initial focus');
    const warm=await main.webContents.executeJavaScript('window.__warm()'); if(!warm?.ok)throw new Error(`WebGPU warmup failed ${JSON.stringify(warm)}`);
    const started=await main.webContents.executeJavaScript(`window.__start(${JSON.stringify(pathToFileURL(fixture(dir)).href)})`); if(started!==true)throw new Error('start failed');
    await waitUntil(()=>{const s=bridge.state();return s?.fileLoaded===true&&Number(s?.receiver?.presentedFrames||0)>=8;},15000,'focused baseline');
    const before=view(bridge);
    if(Number(before.state?.metrics?.importFailures||0)!==0||Number(before.state?.metrics?.sendFailures||0)!==0)throw new Error(`baseline transport failure ${JSON.stringify(before.state?.metrics)}`);

    const samples=[];
    for(let i=1;i<=4;i++){
      const startReanchors=Number(view(bridge).r39.focusReanchors||0);
      other.show(); other.focus();
      await waitUntil(()=>!main.isFocused(),3000,`cycle${i} blur`);
      await waitUntil(()=>{const v=view(bridge);return v.focus.active===true&&v.state?.r32NativePresenter?.visible===true?v:null;},5000,`cycle${i} native-only presenter active`);
      await sleep(1250);
      const nativeBeforeFocus=view(bridge), nativeFramesBefore=Number(nativeBeforeFocus.state?.r32NativePresenter?.nativeOnlyFrames||0);
      main.show(); main.focus();
      await waitUntil(()=>main.isFocused(),3000,`cycle${i} refocus`);
      const completed=await waitUntil(()=>{const v=view(bridge);return Number(v.r39.focusReanchors||0)>=startReanchors+1&&v.r39.awaitingFirstFrame===false&&v.handoff.pending===false&&v.focus.active===false?v:null;},1800,`cycle${i} first focused frame + R37 ACK`);
      const first=Number(completed.r39.lastFocusFirstFrameMs||0);
      if(!(first>0&&first<500))throw new Error(`cycle${i} focused first-frame latency ${first}ms state=${JSON.stringify(completed.r39)}`);
      if(Number(completed.r36.failOpenCount||0)!==0)throw new Error(`cycle${i} R36 fail-open used count=${completed.r36.failOpenCount}`);
      if(Number(completed.r37.rejectedRendererAcks||0)!==0)throw new Error(`cycle${i} rejected R37 ACK count=${completed.r37.rejectedRendererAcks}`);
      const nativeFramesAfter=Number(completed.state?.r32NativePresenter?.nativeOnlyFrames||0);
      samples.push({cycle:i,firstFrameMs:first,reanchors:Number(completed.r39.focusReanchors||0),nativeFramesDelta:nativeFramesAfter-nativeFramesBefore,activeGapCount:Number(completed.r39.activePlaybackGapCount||0),activeGapMaxMs:Number(completed.r39.activePlaybackGapMaxMs||0)});
      await sleep(350);
    }
    const final=view(bridge);
    if(Number(final.r39.focusReanchors||0)<4)throw new Error(`expected >=4 focus reanchors, got ${final.r39.focusReanchors}`);
    if(Number(final.r39.maxFocusFirstFrameMs||0)>=500)throw new Error(`max refocus first-frame latency too high ${final.r39.maxFocusFirstFrameMs}`);
    if(Number(final.r36.failOpenCount||0)!==0)throw new Error(`final R36 fail-open count=${final.r36.failOpenCount}`);
    if(Number(final.r37.rejectedRendererAcks||0)!==0)throw new Error(`final rejected R37 ACK count=${final.r37.rejectedRendererAcks}`);
    if(Number(final.state?.metrics?.importFailures||0)!==0||Number(final.state?.metrics?.sendFailures||0)!==0)throw new Error(`post-cycle transport failure import=${final.state?.metrics?.importFailures} send=${final.state?.metrics?.sendFailures}`);
    console.log(`R39_REFOCUS_PHASE_E2E_OK cycles=4 reanchors=${final.r39.focusReanchors} maxFirstFrameMs=${final.r39.maxFocusFirstFrameMs} activeGapCount=${final.r39.activePlaybackGapCount} activeGapMaxMs=${final.r39.activePlaybackGapMaxMs} failOpen=0 rejectedAck=0 samples=${JSON.stringify(samples)}`);
  } finally {
    try{bridge?.dispose?.()}catch{}; try{other?.destroy?.()}catch{}; try{main?.destroy?.()}catch{}; clearTimeout(hardDeadline); app.quit();
  }
})().catch(fail);

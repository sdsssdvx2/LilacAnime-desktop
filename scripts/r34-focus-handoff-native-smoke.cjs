'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R34 native handoff smoke exceeded 90s hard deadline');
  process.exit(124);
}, 90000);
function hwndText(win){const raw=win.getNativeWindowHandle();return(raw.length>=8?raw.readBigUInt64LE(0):BigInt(raw.readUInt32LE(0))).toString(10)}
function fixture(dir){
  const ffmpeg=require('ffmpeg-static'),out=path.join(dir,'r34-handoff.mp4');
  const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:size=640x360:rate=24000/1001:duration=8','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',out],{encoding:'utf8',windowsHide:true,timeout:120000});
  if(r.status!==0||!fs.existsSync(out))throw new Error(`fixture failed ${String(r.stderr||'').slice(0,200)}`);return out;
}
async function waitUntil(fn,ms,label){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await sleep(20)}throw new Error(`${label} timeout`)}
(async()=>{
  await app.whenReady();
  const addonPath=process.env.LILAC_LIBMPV_PLAYER_ADDON,dllPath=process.env.LILAC_LIBMPV_DLL;
  if(!addonPath||!dllPath)throw new Error('R34 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const addon=require(addonPath);
  for(const name of ['createPlayer','open','pollPlayback','startFrameProducer','stopFrameProducer','configureNativePresenter','setNativePresenterVisible','setNativePresenterMirrorChromium','nativePresenterStats','popProducedFrame','releaseProducedFrame','destroyPlayer'])if(typeof addon[name]!=='function')throw new Error(`missing ${name}`);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r34-handoff-'));let win,id;
  try{
    win=new BrowserWindow({show:true,width:800,height:600,backgroundColor:'#202020',webPreferences:{backgroundThrottling:false}});
    await win.loadURL('data:text/html,<body style="background:%23202020"></body>');
    const created=addon.createPlayer();id=Number(created.playerId);if(!id)throw new Error('createPlayer failed');
    addon.configureNativePresenter(id,hwndText(win));addon.setNativePresenterBounds(id,60,80,640,360);addon.open(id,fixture(dir));
    await waitUntil(()=>addon.pollPlayback(id)?.fileLoaded===true,10000,'load');
    if(!addon.startFrameProducer(id,640,360))throw new Error('startFrameProducer failed');
    if(addon.setNativePresenterVisible(id,true)!==true)throw new Error('presenter show failed');
    await waitUntil(()=>Number(addon.nativePresenterStats(id)?.presentedFrames||0)>=5,5000,'native baseline');
    // Native-only baseline must not queue Chromium frames.
    let baselineQueued=0;for(let i=0;i<6;i++){const f=addon.popProducedFrame(id);if(f?.updated){baselineQueued++;addon.releaseProducedFrame(id,Number(f.slotId),Number(f.frameId))}await sleep(35)}
    if(baselineQueued!==0)throw new Error(`native-only unexpectedly queued ${baselineQueued} frames`);
    const before=addon.nativePresenterStats(id),presentBefore=Number(before.presentedFrames||0);
    if(addon.setNativePresenterMirrorChromium(id,true)!==true)throw new Error('mirror arm failed');
    let mirrored=0;const deadline=Date.now()+2500;
    while(Date.now()<deadline&&mirrored<8){const f=addon.popProducedFrame(id);if(f?.updated){mirrored++;addon.releaseProducedFrame(id,Number(f.slotId),Number(f.frameId))}else await sleep(10)}
    const during=addon.nativePresenterStats(id),presentDelta=Number(during.presentedFrames||0)-presentBefore;
    if(mirrored<5||presentDelta<5)throw new Error(`handoff did not dual-deliver mirrored=${mirrored} nativePresentDelta=${presentDelta}`);
    addon.setNativePresenterMirrorChromium(id,false);
    await sleep(150);
    let afterQueued=0;for(let i=0;i<5;i++){const f=addon.popProducedFrame(id);if(f?.updated){afterQueued++;addon.releaseProducedFrame(id,Number(f.slotId),Number(f.frameId))}await sleep(30)}
    if(afterQueued>1)throw new Error(`mirror disable left Chromium queue active afterQueued=${afterQueued}`);
    console.log(`R34_NATIVE_HANDOFF_SMOKE_OK baselineQueued=0 mirrored=${mirrored} nativePresentDelta=${presentDelta} mirrorDisableQueued=${afterQueued} deviceMode=${created.deviceMode}`);
  }finally{
    clearTimeout(hardDeadline);
    if(id){try{addon.setNativePresenterMirrorChromium(id,false)}catch{};try{addon.setNativePresenterVisible(id,false)}catch{};try{addon.stopFrameProducer(id)}catch{};try{addon.destroyPlayer(id)}catch{}}
    try{win?.destroy()}catch{};try{fs.rmSync(dir,{recursive:true,force:true})}catch{};delete process.env.LILAC_LIBMPV_TEST_AO_NULL;app.quit();
  }
})().catch(error=>{clearTimeout(hardDeadline);console.error(error?.stack||error);process.exitCode=1;try{app.quit()}catch{}});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = v => Math.round(Number(v || 0) * 1000) / 1000;

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static missing');
  const output = path.join(dir, 'r32-native-producer-watchdog.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1280x720:rate=24000/1001:duration=20',
    '-f','lavfi','-i','sine=frequency=523:sample_rate=48000:duration=20',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',output
  ], { encoding:'utf8', windowsHide:true, timeout:180000 });
  if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0,300)}`);
  return output;
}

async function waitLoaded(addon,id) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){const s=addon.pollPlayback(id);if(s?.fileLoaded)return s;await sleep(15);}
  throw new Error('fileLoaded timeout');
}

function blockJs(ms) {
  const view=new Int32Array(new SharedArrayBuffer(4));
  const start=performance.now();
  Atomics.wait(view,0,0,ms);
  return performance.now()-start;
}

function drain(addon,id,limit=1000) {
  let count=0,maxRenderMs=0;
  while(count<limit){
    const f=addon.popProducedFrame(id); if(!f) break;
    if(f.updated!==true||!Buffer.isBuffer(f.ntHandle)||f.ntHandle.length!==8) throw new Error(`invalid produced frame ${JSON.stringify({updated:f.updated,handle:Buffer.isBuffer(f.ntHandle)?f.ntHandle.length:null})}`);
    maxRenderMs=Math.max(maxRenderMs,Number(f.nativeRenderMs)||0);
    if(!addon.releaseProducedFrame(id,f.slotId,f.frameId)) throw new Error(`releaseProducedFrame failed ${f.frameId}`);
    count+=1;
  }
  return {count,maxRenderMs:round(maxRenderMs)};
}

async function main() {
  const addonPath=process.env.LILAC_LIBMPV_PLAYER_ADDON,dllPath=process.env.LILAC_LIBMPV_DLL;
  if(!addonPath||!fs.existsSync(addonPath)||!dllPath||!fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const addon=require(addonPath);
  for(const name of ['createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer','popProducedFrame','releaseProducedFrame','frameProducerStats','destroyPlayer']){
    if(typeof addon[name]!=='function')throw new Error(`missing addon export ${name}`);
  }

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r32-producer-watchdog-'));
  let id=null,jsSignals=0;
  try {
    const media=buildFixture(dir);
    const created=addon.createPlayer(); id=Number(created.playerId);
    if(!id)throw new Error('createPlayer failed');
    if(addon.setUpdateCallback(id,()=>{jsSignals+=1;})!==true)throw new Error('setUpdateCallback failed');
    addon.open(id,media); await waitLoaded(addon,id);
    if(!addon.startFrameProducer(id,1280,720))throw new Error('startFrameProducer failed');

    const warmDeadline=Date.now()+10000;
    while(Date.now()<warmDeadline){const s=addon.frameProducerStats(id);if(Number(s?.producedFrames||0)>=8)break;drain(addon,id);await sleep(20);}
    const warm=addon.frameProducerStats(id);
    if(Number(warm?.producedFrames||0)<6)throw new Error(`producer warmup failed ${JSON.stringify(warm)}`);
    drain(addon,id);

    const trials=[];
    for(let trial=1;trial<=2;trial+=1){
      await sleep(120);
      drain(addon,id);
      const before=addon.frameProducerStats(id);
      const callbacksBefore=jsSignals;
      const blockedMs=blockJs(750);
      const after=addon.frameProducerStats(id);
      const callbacksImmediatelyAfter=jsSignals;
      const produced=Number(after.producedFrames||0)-Number(before.producedFrames||0);
      const rawWake=Number(after.rawWakeSignals||0)-Number(before.rawWakeSignals||0);
      const jsInside=callbacksImmediatelyAfter-callbacksBefore;
      const ready=Number(after.readyFrames||0)-Number(before.readyFrames||0);
      if(blockedMs<700)throw new Error(`trial ${trial} JS block too short ${blockedMs}`);
      if(jsInside!==0)throw new Error(`trial ${trial} JS callback ran inside synchronous block ${jsInside}`);
      // A 250ms fallback alone could only account for a few frames in this 750ms
      // interval. Requiring >=10 frames and >=8 raw wakes proves mpv's native update
      // callback remains the normal ~24fps authority rather than the watchdog becoming
      // the cadence source under a blocked Electron JS thread.
      if(produced<10)throw new Error(`trial ${trial} callback-rate producer progress too low during 750ms JS block ${produced}`);
      if(rawWake<8)throw new Error(`trial ${trial} raw mpv callback cadence too low during JS block ${rawWake}`);
      if(ready<produced)throw new Error(`trial ${trial} ready queue lost block frames ${ready}/${produced}`);
      if(Number(after.readyFrames||0)>24)throw new Error(`trial ${trial} ready queue exceeded slot pool ${after.readyFrames}`);
      const drained=drain(addon,id);
      if(drained.count<Math.min(produced,24))throw new Error(`trial ${trial} retained frames did not drain ${drained.count}/${produced}`);
      trials.push({trial,blockedMs:round(blockedMs),produced,rawWake,ready,jsInside,drained});
    }

    const finalStats=addon.frameProducerStats(id);
    if(!addon.stopFrameProducer(id))throw new Error('stopFrameProducer failed');
    const stopped=addon.frameProducerStats(id);
    if(stopped?.enabled!==false)throw new Error(`producer remained enabled after stop ${JSON.stringify(stopped)}`);
    const totalProduced=trials.reduce((sum,t)=>sum+t.produced,0);
    const totalRawWake=trials.reduce((sum,t)=>sum+t.rawWake,0);
    console.log(`R32_NATIVE_PRODUCER_WATCHDOG_REPORT=${JSON.stringify({deviceMode:created.deviceMode,trials,finalStats,stopped})}`);
    console.log(`R32_NATIVE_PRODUCER_WATCHDOG_OK watchdogMs=250 callbackAuthority=proved minFramesPer750ms=10 minRawWakePer750ms=8 trials=${trials.length} blockMs=750 totalProduced=${totalProduced} totalRawWake=${totalRawWake} jsCallbacksDuringBlocks=0 queueMax=${finalStats.queueMax}`);
  } finally {
    if(id!=null){try{addon.stopFrameProducer(id);}catch{}try{addon.destroyPlayer(id);}catch{}}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
  }
}

main().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});

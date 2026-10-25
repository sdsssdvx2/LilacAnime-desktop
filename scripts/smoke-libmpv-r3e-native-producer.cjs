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
  const output = path.join(dir, 'r3e-native-producer-1080p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1920x1080:rate=24000/1001:duration=28',
    '-f','lavfi','-i','sine=frequency=523:sample_rate=48000:duration=28',
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

function blockJs(ms){const view=new Int32Array(new SharedArrayBuffer(4));const start=performance.now();Atomics.wait(view,0,0,ms);return performance.now()-start;}

function drain(addon,id,limit=1000){
  let count=0,maxRenderMs=0;
  while(count<limit){
    const f=addon.popProducedFrame(id); if(!f) break;
    if(f.updated!==true||!Buffer.isBuffer(f.ntHandle)||f.ntHandle.length!==8) throw new Error(`invalid produced frame ${JSON.stringify({updated:f.updated,handle:Buffer.isBuffer(f.ntHandle)?f.ntHandle.length:null})}`);
    maxRenderMs=Math.max(maxRenderMs,Number(f.nativeRenderMs)||0);
    if(!addon.releaseProducedFrame(id,f.slotId,f.frameId)) throw new Error(`releaseProducedFrame failed ${f.frameId}`);
    count += 1;
  }
  return {count,maxRenderMs:round(maxRenderMs)};
}

async function main(){
  const addonPath=process.env.LILAC_LIBMPV_PLAYER_ADDON,dllPath=process.env.LILAC_LIBMPV_DLL;
  if(!addonPath||!fs.existsSync(addonPath)||!dllPath||!fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const addon=require(addonPath);
  for(const name of ['createPlayer','open','command','poll','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer','resizeFrameProducer','popProducedFrame','releaseProducedFrame','frameProducerStats','renderFrame','releaseFrame','destroyPlayer']){
    if(typeof addon[name]!=='function')throw new Error(`missing addon export ${name}`);
  }

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r3e-producer-'));
  let id=null,jsSignals=0;
  try{
    const media=buildFixture(dir);
    const created=addon.createPlayer(); id=Number(created.playerId);
    addon.setUpdateCallback(id,()=>{jsSignals+=1;});
    addon.open(id,media); await waitLoaded(addon,id);
    if(!addon.startFrameProducer(id,1920,1080))throw new Error('startFrameProducer failed');

    const warmDeadline=Date.now()+12000;
    while(Date.now()<warmDeadline){const s=addon.frameProducerStats(id);if(Number(s?.producedFrames||0)>=6)break;drain(addon,id);await sleep(20);}
    const warm=addon.frameProducerStats(id);
    if(Number(warm?.producedFrames||0)<4)throw new Error(`producer warmup failed ${JSON.stringify(warm)}`);
    drain(addon,id);

    const before=addon.frameProducerStats(id);
    const callbacksBefore=jsSignals;
    const blockMs=blockJs(260);
    const after=addon.frameProducerStats(id);
    const callbacksImmediatelyAfter=jsSignals;
    const producedDuringBlock=Number(after.producedFrames||0)-Number(before.producedFrames||0);
    const rawWakeDuringBlock=Number(after.rawWakeSignals||0)-Number(before.rawWakeSignals||0);
    const jsCallbacksDuringBlock=callbacksImmediatelyAfter-callbacksBefore;
    const readyDuringBlock=Number(after.readyFrames||0)-Number(before.readyFrames||0);

    if(blockMs<230)throw new Error(`JS block too short ${blockMs}`);
    if(jsCallbacksDuringBlock!==0)throw new Error(`JS callback ran inside synchronous block ${jsCallbacksDuringBlock}`);
    if(producedDuringBlock<2)throw new Error(`producer did not progress during JS block ${producedDuringBlock}`);
    if(rawWakeDuringBlock<1)throw new Error(`raw mpv wake did not reach producer ${rawWakeDuringBlock}`);
    if(readyDuringBlock<producedDuringBlock)throw new Error(`ready queue lost block frames ${readyDuringBlock}/${producedDuringBlock}`);
    if(Number(after.readyFrames||0)>24)throw new Error(`ready queue exceeded slot pool ${after.readyFrames}`);

    const drainedAfterBlock=drain(addon,id);
    if(drainedAfterBlock.count<Math.min(producedDuringBlock,24))throw new Error(`did not drain retained block frames ${drainedAfterBlock.count}/${producedDuringBlock}`);

    if(!addon.resizeFrameProducer(id,1280,720))throw new Error('resizeFrameProducer failed');
    const resizeDeadline=Date.now()+5000;
    let resized=null;
    while(Date.now()<resizeDeadline){
      resized=addon.popProducedFrame(id);
      if(resized){
        if(Number(resized.width)===1280&&Number(resized.height)===720)break;
        addon.releaseProducedFrame(id,resized.slotId,resized.frameId);resized=null;
      }
      await sleep(10);
    }
    if(!resized)throw new Error('producer resize did not yield 1280x720 frame');
    if(!addon.releaseProducedFrame(id,resized.slotId,resized.frameId))throw new Error('resized frame release failed');

    const statsBeforeStop=addon.frameProducerStats(id);
    if(!addon.stopFrameProducer(id))throw new Error('stopFrameProducer failed');
    const stopped=addon.frameProducerStats(id);
    if(stopped?.enabled!==false)throw new Error(`producer remained enabled after stop ${JSON.stringify(stopped)}`);

    // Legacy render API remains available as an explicit fallback path after the
    // producer is stopped. It must not have been removed by R3E.
    let legacyFrame=null;
    const legacyDeadline=Date.now()+2500;
    while(Date.now()<legacyDeadline){legacyFrame=addon.renderFrame(id,1280,720);if(legacyFrame?.updated)break;await sleep(4);}
    if(legacyFrame?.updated&&!addon.releaseFrame(id,legacyFrame.slotId,legacyFrame.frameId))throw new Error('legacy fallback release failed');

    const report={deviceMode:created.deviceMode,blockMs:round(blockMs),callbacksBefore,callbacksImmediatelyAfter,jsCallbacksDuringBlock,producedDuringBlock,rawWakeDuringBlock,readyDuringBlock,drainedAfterBlock,statsBeforeStop,stopped,legacyFallbackUpdated:Boolean(legacyFrame?.updated)};
    console.log(`LIBMPV_R3E_NATIVE_PRODUCER_REPORT=${JSON.stringify(report)}`);
    console.log(`LIBMPV_R3E_NATIVE_PRODUCER_OK producedDuringJsBlock=${producedDuringBlock} rawWakeDuringJsBlock=${rawWakeDuringBlock} jsCallbacksDuringBlock=${jsCallbacksDuringBlock} queueMax=${statsBeforeStop.queueMax} stopEnabled=${stopped.enabled}`);
  }finally{
    if(id!=null){try{addon.stopFrameProducer(id);}catch{}try{addon.destroyPlayer(id);}catch{}}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
  }
}

main().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});

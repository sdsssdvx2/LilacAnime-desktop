'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static missing');
  const output = path.join(dir, 'autonomous-js-block-v2-720p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1280x720:rate=24000/1001:duration=24',
    '-f','lavfi','-i','sine=frequency=523:sample_rate=48000:duration=24',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart', output
  ], { encoding:'utf8', windowsHide:true, timeout:180000 });
  if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0,300)}`);
  return output;
}

async function waitLoaded(addon,id) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){ if(addon.pollPlayback(id)?.fileLoaded) return; await sleep(15); }
  throw new Error('fileLoaded timeout');
}

function blockJs(ms) {
  const view=new Int32Array(new SharedArrayBuffer(4));
  const started=performance.now();
  Atomics.wait(view,0,0,ms);
  return performance.now()-started;
}

function drain(addon,id) {
  let count=0, renderMaxMs=0;
  for(;;){
    const frame=addon.popAutonomousProbeFrame(id);
    if(!frame) break;
    count += 1;
    renderMaxMs=Math.max(renderMaxMs,Number(frame.nativeRenderMs)||0);
    if(!Buffer.isBuffer(frame.ntHandle) || frame.ntHandle.length !== 8) throw new Error(`invalid NT handle frame=${frame.frameId}`);
    if(!addon.releaseAutonomousProbeFrame(id,frame.slotId,frame.frameId)) throw new Error(`release rejected frame=${frame.frameId}`);
  }
  return {count,renderMaxMs};
}

async function main(){
  const addonPath=process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath=process.env.LILAC_LIBMPV_DLL;
  if(!addonPath||!fs.existsSync(addonPath)||!dllPath||!fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const addon=require(addonPath);
  for(const name of ['createPlayer','open','pollPlayback','setUpdateCallback','startAutonomousProbe','stopAutonomousProbe','popAutonomousProbeFrame','releaseAutonomousProbeFrame','autonomousProbeStats','destroyPlayer']){
    if(typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-autonomous-v2-'));
  let id=null, jsCallbacks=0;
  try{
    const media=buildFixture(dir);
    const created=addon.createPlayer(); id=Number(created.playerId);
    addon.setUpdateCallback(id,()=>{jsCallbacks += 1;});
    addon.open(id,media); await waitLoaded(addon,id);
    if(!addon.startAutonomousProbe(id,1280,720)) throw new Error('startAutonomousProbe failed');

    const warmDeadline=Date.now()+12000;
    while(Date.now()<warmDeadline){
      const s=addon.autonomousProbeStats(id);
      if(Number(s?.producedFrames||0)>=6) break;
      await sleep(25);
    }
    const warm=addon.autonomousProbeStats(id);
    if(Number(warm?.producedFrames||0)<4) throw new Error(`warmup failed: ${JSON.stringify(warm)}`);
    const preDrain=drain(addon,id);
    const before=addon.autonomousProbeStats(id);
    const callbacksBefore=jsCallbacks;
    const actualBlockMs=blockJs(350);
    const after=addon.autonomousProbeStats(id);
    const callbacksAfter=jsCallbacks;

    const producedDelta=Number(after.producedFrames||0)-Number(before.producedFrames||0);
    const rawWakeDelta=Number(after.rawWakeSignals||0)-Number(before.rawWakeSignals||0);
    const renderCallDelta=Number(after.renderCalls||0)-Number(before.renderCalls||0);
    const readyDelta=Number(after.readyFrames||0)-Number(before.readyFrames||0);
    const backpressureDelta=Number(after.backpressure||0)-Number(before.backpressure||0);
    const callbacksDuringBlock=callbacksAfter-callbacksBefore;

    if(!addon.stopAutonomousProbe(id)) throw new Error('stopAutonomousProbe failed');
    const stopped=addon.autonomousProbeStats(id);
    const postDrain=drain(addon,id);
    const stopOvershoot=Number(stopped.producedFrames||0)-Number(after.producedFrames||0);

    const report={deviceMode:created.deviceMode,actualBlockMs:Math.round(actualBlockMs*1000)/1000,callbacksBefore,callbacksAfter,callbacksDuringBlock,before,after,stopped,producedDelta,rawWakeDelta,renderCallDelta,readyDelta,backpressureDelta,stopOvershoot,preDrain,postDrain};
    console.log(`LIBMPV_R3D_AUTONOMOUS_JS_BLOCK_V2_REPORT=${JSON.stringify(report)}`);

    if(actualBlockMs<320) throw new Error(`JS block too short: ${actualBlockMs}`);
    if(callbacksDuringBlock!==0) throw new Error(`JS callback executed during synchronous block: ${callbacksDuringBlock}`);
    if(rawWakeDelta<1) throw new Error(`raw native wake did not advance: ${rawWakeDelta}`);
    if(producedDelta<2) throw new Error(`native producer did not advance during JS block: ${producedDelta}`);
    if(renderCallDelta<producedDelta) throw new Error(`render-call delta smaller than produced delta: ${renderCallDelta}/${producedDelta}`);
    if(readyDelta<producedDelta) throw new Error(`ready queue did not retain produced frames: ${readyDelta}/${producedDelta}`);
    // One bounded backpressure observation is expected if a hostile hosted runner
    // produces quickly enough to fill all 24 retained slots during the 350ms JS
    // freeze. It is only acceptable when the queue is actually saturated.
    if(backpressureDelta>1) throw new Error(`excessive backpressure during JS block: ${backpressureDelta}`);
    if(backpressureDelta===1 && Number(after.readyFrames||0)<24) throw new Error(`backpressure occurred before all 24 slots were full: ready=${after.readyFrames}`);
    // One already-entered render may finish while stop is being requested, but the
    // old behavior of draining an entire additional burst is not allowed.
    if(stopOvershoot>1) throw new Error(`autonomous stop overshot by ${stopOvershoot} frames`);
    if(postDrain.count < producedDelta) throw new Error(`post-stop drain smaller than block production: ${postDrain.count}/${producedDelta}`);

    console.log(`LIBMPV_R3D_AUTONOMOUS_JS_BLOCK_V2_OK producedDuringBlock=${producedDelta} rawWakeDuringBlock=${rawWakeDelta} jsCallbacksDuringBlock=${callbacksDuringBlock} stopOvershoot=${stopOvershoot} backpressureDelta=${backpressureDelta}`);
  }finally{
    if(id!=null){try{addon.stopAutonomousProbe(id);}catch{} try{addon.destroyPlayer(id);}catch{}}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
  }
}

main().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});

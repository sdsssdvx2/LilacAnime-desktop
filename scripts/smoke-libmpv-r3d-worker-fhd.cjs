'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(Number(value || 0) * 1000) / 1000;
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}
function ensureFixture() {
  const output = process.env.LILAC_R3D_FIXTURE || path.join(os.tmpdir(), 'lilac-r3d-worker-fhd.mp4');
  if (fs.existsSync(output) && fs.statSync(output).size > 100000) return output;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const ffmpeg = require('ffmpeg-static');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1920x1080:rate=24000/1001:duration=12',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=12',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',output
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (r.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture failed: ${String(r.stderr||'').slice(0,240)}`);
  return output;
}

async function main() {
  const addon = require(process.env.LILAC_LIBMPV_PLAYER_ADDON);
  for (const n of ['createPlayer','open','command','pollPlayback','startRenderWorker','takeFrame','releaseFrame','destroyPlayer']) {
    if (typeof addon[n] !== 'function') throw new Error(`missing addon export ${n}`);
  }
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const media=ensureFixture();
  const mode=process.env.LILAC_R3D_MODE||'worker';
  let id=null, readySignals=0, frames=0;
  const takeMs=[], pollMs=[], commandMs=[], frameAt=[];
  try {
    const created=addon.createPlayer();
    id=Number(created.playerId);
    addon.startRenderWorker(id,1920,1080,()=>{readySignals+=1;});
    addon.open(id,media);

    const loadedUntil=Date.now()+8000;
    let loaded=false;
    while(Date.now()<loadedUntil){const s=addon.pollPlayback(id);if(s.fileLoaded){loaded=true;break;}await sleep(15);}
    if(!loaded) throw new Error('fileLoaded timeout');

    await sleep(1400);
    const sampleStart=performance.now();
    let nextPoll=sampleStart;
    let nextCommand=sampleStart+700;
    const sampleUntil=sampleStart+5200;
    while(performance.now()<sampleUntil){
      const started=performance.now();
      const f=addon.takeFrame(id,1920,1080);
      takeMs.push(performance.now()-started);
      if(f?.updated){
        frames+=1;frameAt.push(performance.now());
        if(!addon.releaseFrame(id,f.slotId,f.frameId)) throw new Error(`release rejected ${f.frameId}`);
      }
      const now=performance.now();
      if(now>=nextPoll){const t=performance.now();addon.pollPlayback(id);pollMs.push(performance.now()-t);nextPoll=now+250;}
      if(now>=nextCommand){const t=performance.now();addon.command(id,['set','volume','100']);commandMs.push(performance.now()-t);nextCommand=now+900;}
      await sleep(2);
    }
    const finalState=addon.pollPlayback(id);
    const intervals=[];for(let i=1;i<frameAt.length;i++)intervals.push(frameAt[i]-frameAt[i-1]);
    const span=frameAt.length>1?frameAt[frameAt.length-1]-frameAt[0]:0;
    const fps=span>0?(frameAt.length-1)*1000/span:0;
    const report={
      mode,
      advancedControl:process.env.LILAC_LIBMPV_ADVANCED_CONTROL==='1',
      forceDr:process.env.LILAC_LIBMPV_FORCE_DR==='1',
      deviceMode:created.deviceMode,
      readySignals,frames,effectiveFps:round(fps),
      takeFrameMs:{p50:round(percentile(takeMs,.5)),p95:round(percentile(takeMs,.95)),p99:round(percentile(takeMs,.99)),max:round(Math.max(0,...takeMs))},
      pollPlaybackMs:{p50:round(percentile(pollMs,.5)),p95:round(percentile(pollMs,.95)),max:round(Math.max(0,...pollMs))},
      commandMs:{p50:round(percentile(commandMs,.5)),p95:round(percentile(commandMs,.95)),max:round(Math.max(0,...commandMs))},
      frameIntervalMs:{p50:round(percentile(intervals,.5)),p95:round(percentile(intervals,.95)),max:round(Math.max(0,...intervals))},
      worker:{
        wakeSignals:Number(finalState.renderWorkerWakeSignals||0),
        updateCalls:Number(finalState.renderWorkerUpdateCalls||0),
        renderCalls:Number(finalState.renderWorkerRenderCalls||0),
        renderedFrames:Number(finalState.renderWorkerFrames||0),
        avgRenderMs:round(finalState.renderWorkerAvgRenderMs),
        maxRenderMs:round(finalState.renderWorkerMaxRenderMs),
        droppedReady:Number(finalState.renderWorkerDroppedReady||0),
        backpressure:Number(finalState.renderWorkerBackpressure||0),
        readyFrames:Number(finalState.renderWorkerReadyFrames||0),
        error:finalState.renderWorkerLastError||null
      }
    };
    console.log(`LIBMPV_R3D_WORKER_FHD_REPORT=${JSON.stringify(report)}`);
    if(report.takeFrameMs.p95>3) throw new Error(`takeFrame p95 blocks main thread: ${report.takeFrameMs.p95}`);
    if(report.takeFrameMs.max>25) throw new Error(`takeFrame max blocks main thread: ${report.takeFrameMs.max}`);
    if(report.pollPlaybackMs.p95>12) throw new Error(`pollPlayback p95 too high: ${report.pollPlaybackMs.p95}`);
    if(report.commandMs.p95>25) throw new Error(`command p95 too high: ${report.commandMs.p95}`);
    if(report.worker.error) throw new Error(`render worker error: ${report.worker.error}`);
    if(report.worker.renderedFrames<20||frames<15) throw new Error(`insufficient worker frames worker=${report.worker.renderedFrames} js=${frames}`);
    console.log('LIBMPV_R3D_WORKER_FHD_OK jsAcquisition=nonblocking render=dedicated-thread');
  } finally {
    if(id!=null){try{addon.destroyPlayer(id);}catch{}}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
  }
}
main().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});

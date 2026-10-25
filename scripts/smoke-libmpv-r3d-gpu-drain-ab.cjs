'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = v => Math.round(Number(v || 0) * 1000) / 1000;
const percentile = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a,b) => a-b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const summarize = values => ({
  count: values.length,
  p50: round(percentile(values,.5)),
  p95: round(percentile(values,.95)),
  p99: round(percentile(values,.99)),
  max: round(Math.max(0,...values))
});

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'gpu-drain.mp4');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1920x1080:rate=24000/1001:duration=32',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=32',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',out
  ], {encoding:'utf8',windowsHide:true,timeout:180000});
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed: ${String(r.stderr||'').slice(0,400)}`);
  return out;
}

function isPlainPresent(f) {
  return Number(f?.nextFrameInfoRc) >= 0 && f?.nextFramePresent === true &&
    f?.nextFrameRedraw !== true && f?.nextFrameRepeat !== true && f?.nextFrameBlockVsync !== true;
}

async function waitLoaded(addon,id) {
  const end=Date.now()+12000;
  while(Date.now()<end){ if(addon.pollPlayback(id).fileLoaded) return; await sleep(15); }
  throw new Error('fileLoaded timeout');
}

async function childMain() {
  const addonPath=process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath=process.env.LILAC_LIBMPV_DLL;
  const media=process.env.LILAC_GPU_DRAIN_MEDIA;
  const label=process.env.LILAC_GPU_DRAIN_LABEL || 'child';
  const drain=process.env.LILAC_LIBMPV_TEST_GPU_DRAIN === '1';
  if(!addonPath||!fs.existsSync(addonPath)||!dllPath||!fs.existsSync(dllPath)||!media||!fs.existsSync(media)) throw new Error('child inputs missing');
  const addon=require(addonPath);
  const created=addon.createPlayer();
  const id=Number(created.playerId);
  const render=[]; const drainWait=[]; const combined=[]; const wall=[]; const polls=[];
  let callbacks=0, nonPlain=0, noFrame=0, modeMismatch=0;
  try {
    addon.setUpdateCallback(id,()=>{callbacks+=1;});
    addon.open(id,media);
    await waitLoaded(addon,id);
    const warmEnd=performance.now()+1400;
    while(performance.now()<warmEnd){
      const f=addon.renderFrame(id,1920,1080);
      if(f?.updated){ if(!addon.releaseFrame(id,f.slotId,f.frameId)) throw new Error('warm release failed'); }
      await sleep(2);
    }
    const end=performance.now()+6500;
    while(performance.now()<end && render.length<42){
      const started=performance.now();
      const f=addon.renderFrame(id,1920,1080);
      const elapsed=performance.now()-started;
      if(!f?.updated){noFrame+=1;await sleep(2);continue;}
      if(Boolean(f.gpuDrainProbe)!==drain) modeMismatch+=1;
      if(isPlainPresent(f)){
        const r=Number(f.nativeRenderMs); const d=Number(f.gpuDrainWaitMs); const p=Number(f.gpuDrainPolls);
        if(![r,d,p].every(Number.isFinite)) throw new Error('invalid native timing');
        render.push(r); drainWait.push(d); combined.push(r+d); wall.push(elapsed); polls.push(p);
      } else nonPlain+=1;
      if(!addon.releaseFrame(id,f.slotId,f.frameId)) throw new Error('release failed');
      await sleep(2);
    }
    if(render.length<28) throw new Error(`${label}: insufficient plain PRESENT samples ${render.length}`);
    const result={
      label, drain, deviceMode:created.deviceMode, callbacks, nonPlain, noFrame, modeMismatch,
      renderMs:summarize(render), drainWaitMs:summarize(drainWait), renderPlusDrainMs:summarize(combined),
      callWallMs:summarize(wall), drainPolls:summarize(polls), sampleFlags:[1]
    };
    console.log(`LIBMPV_R3D_GPU_DRAIN_CHILD=${JSON.stringify(result)}`);
  } finally { try{addon.destroyPlayer(id);}catch{} }
}

function runChild(media,label,drain){
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1',LILAC_LIBMPV_TEST_AO_NULL:'1',LILAC_LIBMPV_TEST_GPU_DRAIN:drain?'1':'0',LILAC_GPU_DRAIN_MEDIA:media,LILAC_GPU_DRAIN_LABEL:label};
  const r=spawnSync(process.execPath,[__filename,'--child'],{env,encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:4*1024*1024});
  if(r.error) throw r.error;
  if(r.status!==0) throw new Error(`${label} failed status=${r.status} stdout=${String(r.stdout||'').slice(-1600)} stderr=${String(r.stderr||'').slice(-1600)}`);
  const prefix='LIBMPV_R3D_GPU_DRAIN_CHILD=';
  const line=String(r.stdout||'').split(/\r?\n/).find(x=>x.startsWith(prefix));
  if(!line) throw new Error(`${label}: report missing`);
  return JSON.parse(line.slice(prefix.length));
}

async function parentMain(){
  const addonPath=process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath=process.env.LILAC_LIBMPV_DLL;
  if(!addonPath||!fs.existsSync(addonPath)||!dllPath||!fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-gpu-drain-'));
  try{
    const media=buildFixture(dir);
    const baselineA=runChild(media,'baselineA',false);
    const drainA=runChild(media,'drainA',true);
    const drainB=runChild(media,'drainB',true);
    const baselineB=runChild(media,'baselineB',false);
    for(const x of [baselineA,drainA,drainB,baselineB]) if(x.modeMismatch!==0) throw new Error(`${x.label}: drain mode mismatch`);
    const baselineRenderP50=round((baselineA.renderMs.p50+baselineB.renderMs.p50)/2);
    const drainRenderP50=round((drainA.renderMs.p50+drainB.renderMs.p50)/2);
    const drainWaitP50=round((drainA.drainWaitMs.p50+drainB.drainWaitMs.p50)/2);
    const drainCombinedP50=round((drainA.renderPlusDrainMs.p50+drainB.renderPlusDrainMs.p50)/2);
    const report={baselineA,drainA,drainB,baselineB,summary:{
      baselineRenderP50,drainRenderP50,drainWaitP50,drainCombinedP50,
      renderP50ReductionPct:baselineRenderP50>0?round((1-drainRenderP50/baselineRenderP50)*100):null,
      drainRenderToBaselineRatio:baselineRenderP50>0?round(drainRenderP50/baselineRenderP50):null,
      drainCombinedToBaselineRatio:baselineRenderP50>0?round(drainCombinedP50/baselineRenderP50):null
    }};
    console.log(`LIBMPV_R3D_GPU_DRAIN_REPORT=${JSON.stringify(report)}`);
    console.log('LIBMPV_R3D_GPU_DRAIN_OK');
  } finally { try{fs.rmSync(dir,{recursive:true,force:true});}catch{} }
}

const entry=process.argv.includes('--child')?childMain:parentMain;
entry().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});

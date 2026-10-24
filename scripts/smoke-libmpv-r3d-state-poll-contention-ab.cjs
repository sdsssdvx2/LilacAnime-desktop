'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = v => Math.round(Number(v || 0) * 1000) / 1000;
const percentile = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a,b)=>a-b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const summary = v => ({p50:round(percentile(v,.5)),p95:round(percentile(v,.95)),p99:round(percentile(v,.99)),max:round(Math.max(0,...v))});

function fixture(dir) {
  const ffmpeg=require('ffmpeg-static');
  const out=path.join(dir,'poll-ab-720p.mp4');
  const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=1280x720:rate=24000/1001:duration=26','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=26','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',out],{encoding:'utf8',windowsHide:true,timeout:180000});
  if(r.status!==0||!fs.existsSync(out)) throw new Error(`fixture failed: ${String(r.stderr||'').slice(0,200)}`);
  return out;
}

async function waitLoaded(addon,id){const d=Date.now()+10000;while(Date.now()<d){if(addon.pollPlayback(id).fileLoaded)return;await sleep(15);}throw new Error('load timeout');}

async function sample(addon,media,withPoll){
  const created=addon.createPlayer(); const id=Number(created.playerId);
  const renderMs=[], updateMs=[], wallMs=[], intervals=[], pollMs=[]; const updatedAt=[];
  let frames=0,calls=0,signals=0,nextPoll=0;
  function render(record){
    const a=performance.now(); const f=addon.renderFrame(id,1280,720); const wall=performance.now()-a;
    if(record){calls++;wallMs.push(wall);updateMs.push(Number(f.nativeUpdateMs)||0);}
    if(f.updated){if(record){frames++;updatedAt.push(performance.now());renderMs.push(Number(f.nativeRenderMs)||0);} if(!addon.releaseFrame(id,f.slotId,f.frameId))throw new Error('release failed');}
  }
  try{
    addon.setUpdateCallback(id,()=>{signals++;}); addon.open(id,media); await waitLoaded(addon,id);
    let until=performance.now()+1500; while(performance.now()<until){render(false);await sleep(2);}
    nextPoll=performance.now()+250; until=performance.now()+6000;
    while(performance.now()<until){
      if(withPoll&&performance.now()>=nextPoll){const p=performance.now();addon.pollPlayback(id);pollMs.push(performance.now()-p);nextPoll+=250;}
      render(true); await sleep(2);
    }
    for(let i=1;i<updatedAt.length;i++)intervals.push(updatedAt[i]-updatedAt[i-1]);
    const span=updatedAt.length>1?updatedAt.at(-1)-updatedAt[0]:0;
    return {withPoll,deviceMode:created.deviceMode,signals,calls,frames,effectiveFps:span>0?round((updatedAt.length-1)*1000/span):0,pollCount:pollMs.length,pollMs:summary(pollMs),wallMs:summary(wallMs),nativeUpdateMs:summary(updateMs),nativeRenderMs:summary(renderMs),frameIntervalMs:summary(intervals)};
  }finally{try{addon.destroyPlayer(id);}catch{}}
}

async function main(){
  const ap=process.env.LILAC_LIBMPV_PLAYER_ADDON,dp=process.env.LILAC_LIBMPV_DLL;if(!ap||!fs.existsSync(ap)||!dp||!fs.existsSync(dp))throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1'; const addon=require(ap); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-poll-ab-'));
  try{const media=fixture(dir);const cleanA=await sample(addon,media,false);const polledA=await sample(addon,media,true);const polledB=await sample(addon,media,true);const cleanB=await sample(addon,media,false);const report={cleanA,polledA,polledB,cleanB};console.log(`LIBMPV_R3D_STATE_POLL_AB_REPORT=${JSON.stringify(report)}`);for(const x of [cleanA,polledA,polledB,cleanB]){if(x.calls<20||x.frames<20)throw new Error('insufficient sample');if(x.nativeUpdateMs.p95>10)throw new Error('update p95 high');}console.log('LIBMPV_R3D_STATE_POLL_AB_OK');}
  finally{delete process.env.LILAC_LIBMPV_TEST_AO_NULL;try{fs.rmSync(dir,{recursive:true,force:true});}catch{}}
}
main().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});

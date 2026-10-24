'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(Number(value || 0) * 1000) / 1000;
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const summarize = values => ({
  p50: round(percentile(values, 0.50)),
  p95: round(percentile(values, 0.95)),
  p99: round(percentile(values, 0.99)),
  max: round(Math.max(0, ...values))
});

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static missing');
  const output = path.join(dir, 'r3d-advanced-control-v2-720p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24000/1001:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0, 300)}`);
  return output;
}

async function waitLoaded(addon, playerId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (addon.pollPlayback(playerId).fileLoaded) return;
    await sleep(15);
  }
  throw new Error('fileLoaded timeout');
}

async function childSample(advancedControl, media) {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  process.env.LILAC_LIBMPV_TEST_ADVANCED_CONTROL = advancedControl ? '1' : '0';
  const addon = require(addonPath);
  for (const name of ['createPlayer','open','pollPlayback','setUpdateCallback','renderPersistentThreadProbe','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }
  const created = addon.createPlayer();
  if (Boolean(created.advancedControl) !== advancedControl) throw new Error(`advanced creation mismatch ${created.advancedControl}`);
  const playerId = Number(created.playerId);
  const wallMs=[], updateMs=[], textureMs=[], renderMs=[], updatedAt=[];
  let callbackSignals=0, renderCalls=0, updatedFrames=0;
  try {
    addon.setUpdateCallback(playerId, () => { callbackSignals += 1; });
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);
    const warm=performance.now()+1200;
    while(performance.now()<warm){addon.renderPersistentThreadProbe(playerId,1280,720);await sleep(2);}
    const until=performance.now()+4000;
    while(performance.now()<until){
      const started=performance.now();
      const f=addon.renderPersistentThreadProbe(playerId,1280,720);
      wallMs.push(performance.now()-started); renderCalls += 1; updateMs.push(Number(f.nativeUpdateMs)||0);
      if(f.updated){
        if(Number(f.renderRc)<0) throw new Error(`render rc=${f.renderRc} ${f.error||''}`);
        updatedFrames += 1; updatedAt.push(performance.now()); textureMs.push(Number(f.nativeEnsureTextureMs)||0); renderMs.push(Number(f.nativeRenderMs)||0);
      }
      await sleep(2);
    }
    const intervals=[]; for(let i=1;i<updatedAt.length;i++) intervals.push(updatedAt[i]-updatedAt[i-1]);
    const span=updatedAt.length>1?updatedAt.at(-1)-updatedAt[0]:0;
    const result={advancedControl,deviceMode:created.deviceMode,callbackSignals,renderCalls,updatedFrames,effectiveFps:span>0?round((updatedAt.length-1)*1000/span):0,wallMs:summarize(wallMs),nativeUpdateMs:summarize(updateMs),nativeEnsureTextureMs:summarize(textureMs),nativeRenderMs:summarize(renderMs),frameIntervalMs:summarize(intervals)};
    console.log(`LIBMPV_R3D_ADV_CHILD_RESULT=${JSON.stringify(result)}`);
  } finally {
    try { addon.destroyPlayer(playerId); } catch {}
  }
}

function runChild(media, advancedControl, label) {
  const env={...process.env,LILAC_ADV_CHILD:'1',LILAC_ADV_MODE:advancedControl?'1':'0',LILAC_ADV_MEDIA:media,ELECTRON_RUN_AS_NODE:'1'};
  const started=Date.now();
  const result=spawnSync(process.execPath,[__filename],{env,encoding:'utf8',windowsHide:true,timeout:35000,maxBuffer:4*1024*1024});
  const elapsedMs=Date.now()-started;
  const combined=`${result.stdout||''}\n${result.stderr||''}`;
  const match=combined.match(/LIBMPV_R3D_ADV_CHILD_RESULT=(\{.*\})/);
  let sample=null;
  if(match){try{sample=JSON.parse(match[1]);}catch{}}
  return {label,advancedControl,elapsedMs,status:result.status,signal:result.signal||null,timedOut:Boolean(result.error&&result.error.code==='ETIMEDOUT'),error:result.error?String(result.error.message||result.error):null,sample,tail:combined.slice(-1200)};
}

async function main(){
  if(process.env.LILAC_ADV_CHILD==='1'){
    await childSample(process.env.LILAC_ADV_MODE==='1',process.env.LILAC_ADV_MEDIA);
    return;
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r3d-advanced-v2-'));
  try{
    const media=buildFixture(dir);
    const legacyA=runChild(media,false,'legacyA');
    const advancedA=runChild(media,true,'advancedA');
    const advancedB=runChild(media,true,'advancedB');
    const legacyB=runChild(media,false,'legacyB');
    const report={legacyA,advancedA,advancedB,legacyB};
    console.log(`LIBMPV_R3D_ADVANCED_CONTROL_V2_REPORT=${JSON.stringify(report)}`);
    for(const x of [legacyA,legacyB]){
      if(x.timedOut||x.status!==0||!x.sample) throw new Error(`legacy child failed ${x.label}: ${x.tail}`);
      if(x.sample.renderCalls<20||x.sample.updatedFrames<20) throw new Error(`legacy sample too small ${x.label}`);
    }
    const adv=[advancedA,advancedB];
    const advCompleted=adv.filter(x=>!x.timedOut&&x.status===0&&x.sample).length;
    const advTimedOut=adv.filter(x=>x.timedOut).length;
    console.log(`LIBMPV_R3D_ADVANCED_CONTROL_V2_OK completed=${advCompleted} timedOut=${advTimedOut}`);
  }finally{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}}
}

main().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});

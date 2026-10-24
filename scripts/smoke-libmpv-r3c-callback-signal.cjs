'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const output = path.join(dir, 'r3c-callback.mp4');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=640x360:rate=24000/1001:duration=6',
    '-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=6',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',output
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (r.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture failed: ${String(r.stderr||'').slice(0,200)}`);
  return output;
}

async function main() {
  const addon = require(process.env.LILAC_LIBMPV_PLAYER_ADDON);
  for (const n of ['createPlayer','open','pollPlayback','setUpdateCallback','renderFrame','releaseFrame','destroyPlayer']) {
    if (typeof addon[n] !== 'function') throw new Error(`missing ${n}`);
  }
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r3c-callback-'));
  const media=makeFixture(dir);
  let id=null, signals=0, frames=0, errors=0, maxRenderMs=0;
  let pending=false, draining=false, active=true;
  const drain=()=>{
    pending=true;
    if (draining || !active) return;
    draining=true;
    setImmediate(function run(){
      if (!active) { draining=false; return; }
      if (!pending) { draining=false; return; }
      pending=false;
      try {
        const t=performance.now();
        const f=addon.renderFrame(id,320,180);
        maxRenderMs=Math.max(maxRenderMs,performance.now()-t);
        if (f?.updated) { frames++; addon.releaseFrame(id,f.slotId,f.frameId); }
      } catch { errors++; }
      if (pending) setImmediate(run); else draining=false;
    });
  };
  try {
    id=Number(addon.createPlayer().playerId);
    addon.setUpdateCallback(id,()=>{signals++;drain();});
    addon.open(id,media);
    const until=Date.now()+8000;
    let loaded=false;
    while(Date.now()<until){const s=addon.pollPlayback(id);if(s.fileLoaded){loaded=true;break;}await sleep(20);}
    if(!loaded) throw new Error('fileLoaded timeout');
    await sleep(4200);
    active=false;
    await sleep(80);
    const report={signals,frames,errors,maxRenderMs:Math.round(maxRenderMs*1000)/1000};
    console.log(`LIBMPV_R3C_CALLBACK_SIGNAL_REPORT=${JSON.stringify(report)}`);
    if(signals<30) throw new Error(`too few render update signals: ${signals}`);
    if(frames<25) throw new Error(`too few callback-consumed frames: ${frames}`);
    if(errors) throw new Error(`callback render errors: ${errors}`);
    console.log('LIBMPV_R3C_CALLBACK_SIGNAL_OK role=wake-hint phaseTimer=authoritative-fallback');
  } finally {
    active=false;
    if(id!=null){try{addon.destroyPlayer(id);}catch{}}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
  }
}
main().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});

'use strict';

const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
const AdmZip=require('adm-zip');

(async()=>{
  const workerPath=path.resolve(__dirname,'../electron/community-archive-worker.cjs');
  if(!fs.existsSync(workerPath))throw new Error('R33 community archive worker missing');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r33-archive-smoke-')),out=path.join(root,'out');fs.mkdirSync(out);
  let worker;
  try{
    const zip=new AdmZip();
    // Build the fixture before timing. Random data prevents the decompressor from
    // completing trivially and gives the main-loop heartbeat a meaningful stress.
    zip.addFile('episode01.ass',crypto.randomBytes(8*1024*1024));
    zip.addFile('font01.ttf',crypto.randomBytes(8*1024*1024));
    zip.addFile('episode01.srt',crypto.randomBytes(8*1024*1024));
    zip.addFile('ignore-video.mp4',crypto.randomBytes(2*1024*1024));
    const archive=zip.toBuffer();
    worker=new Worker(workerPath);
    const started=performance.now();let last=started,maxLag=0,ticks=0;
    const timer=setInterval(()=>{const now=performance.now(),gap=now-last;last=now;ticks++;maxLag=Math.max(maxLag,Math.max(0,gap-10))},10);
    const result=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('archive worker smoke timeout')),20000);
      worker.once('error',reject);
      worker.on('message',message=>{if(message?.id!==1)return;clearTimeout(timeout);message.ok?resolve(message):reject(new Error(message.error||'worker extraction failed'))});
      const exact=archive.byteOffset===0&&archive.byteLength===archive.buffer.byteLength;
      const payload=exact?archive.buffer:archive.buffer.slice(archive.byteOffset,archive.byteOffset+archive.byteLength);
      worker.postMessage({id:1,kind:'zip',dir:out,buffer:payload},[payload]);
    });
    clearInterval(timer);
    const elapsed=performance.now()-started;
    const names=result.files.map(file=>path.basename(file)).sort();
    if(names.length!==3||!names.some(x=>x.endsWith('.ass'))||!names.some(x=>x.endsWith('.srt'))||!names.some(x=>x.endsWith('.ttf'))||names.some(x=>x.endsWith('.mp4')))throw new Error(`archive worker filtering mismatch: ${names.join(',')}`);
    if(ticks<2)throw new Error(`main heartbeat did not run during archive extraction: ticks=${ticks} elapsed=${elapsed.toFixed(1)}`);
    if(maxLag>250)throw new Error(`main heartbeat stalled during worker extraction: maxLag=${maxLag.toFixed(1)}ms`);
    console.log(`R33_COMMUNITY_ARCHIVE_WORKER_SMOKE_OK archiveBytes=${archive.byteLength} extracted=${names.length} elapsedMs=${elapsed.toFixed(1)} heartbeatTicks=${ticks} maxHeartbeatLagMs=${maxLag.toFixed(1)} mainThreadAdmZip=0`);
  }finally{
    if(worker)await worker.terminate().catch(()=>{});
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error?.stack||error);process.exitCode=1});

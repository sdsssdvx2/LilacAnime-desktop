'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {app,BrowserWindow}=require('electron');
const root=path.resolve(__dirname,'..');
const bundlePath=path.join(root,'src','libmpv-shared.generated.js');
const fixture=path.join(os.tmpdir(),`lilac-r2m-race-${process.pid}.html`);
let failed=false;
function fail(message,details){failed=true;console.error('LIBMPV_R2M_OPEN_RACE_FAIL '+message);if(details)console.error(JSON.stringify(details));}
(async()=>{
 await app.whenReady();
 const bundle=fs.readFileSync(bundlePath,'utf8');
 fs.writeFileSync(fixture,'<!doctype html><div id="playerView" class="active"></div><style>lilac-mpv-video{display:block;width:1280px;height:720px}</style>');
 const win=new BrowserWindow({show:false,width:1280,height:720,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 try{
  await win.loadFile(fixture);
  await win.webContents.executeJavaScript(`
   window.__gen=2;
   window.__state={active:true,generation:2,fileLoaded:false,time:1469.9,duration:1470,paused:true,eof:true,metrics:{sentFrames:1}};
   window.lilac={
    libmpvSharedOpen:async()=>({ok:true,playerId:1,generation:window.__gen}),
    libmpvSharedCommand:async()=>({ok:true}),
    libmpvSharedState:async()=>({...window.__state}),
    libmpvSharedResize:async()=>({ok:true}),
    libmpvSharedClose:async()=>({ok:true})
   }; true;`);
  await win.webContents.executeJavaScript(`${bundle}\n;true;`);
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const video=document.createElement('lilac-mpv-video');document.querySelector('#playerView').append(video);
   let ended=0;video.addEventListener('ended',()=>ended++);
   await video.openLilacSource('https://example.invalid/11.m3u8',{hls:true});clearInterval(video._pollTimer);video._pollTimer=null;
   await video._pollState();
   const staleOldEndIgnored=ended===0&&video.currentTime===0&&video.duration===0&&video.readyState===0;
   window.__state={...window.__state,fileLoaded:false,eof:false,time:1469.9,duration:1470,paused:true};await video._pollState();
   const staleTimingIgnored=ended===0&&video.currentTime===0&&video.duration===0;
   window.__state={...window.__state,fileLoaded:true,eof:false,time:296,duration:1470,paused:false};await video._pollState();
   const loadedAccepted=ended===0&&Math.abs(video.currentTime-296)<.01&&Math.abs(video.duration-1470)<.01&&video.readyState===4;
   window.__state={...window.__state,fileLoaded:true,eof:true,time:1470,paused:true};await video._pollState();await video._pollState();await video._pollState();
   const oneRealEnd=ended===1;
   window.__gen=3;window.__state={active:true,generation:3,fileLoaded:false,time:1470,duration:1470,paused:true,eof:true,metrics:{sentFrames:2}};
   await video.openLilacSource('https://example.invalid/11-again.m3u8',{hls:true});
   await video._pollState();
   const reopenRaceIgnored=ended===1&&video.currentTime===0&&video.duration===0&&video.readyState===0;
   window.__state={...window.__state,fileLoaded:true,eof:false,time:296,duration:1470,paused:false};await video._pollState();
   const reopenLoaded=ended===1&&Math.abs(video.currentTime-296)<.01&&video._generation===3;
   return{staleOldEndIgnored,staleTimingIgnored,loadedAccepted,oneRealEnd,reopenRaceIgnored,reopenLoaded,ended,time:video.currentTime,duration:video.duration,generation:video._generation};
  })()`);
  if(!result.staleOldEndIgnored||!result.staleTimingIgnored||!result.loadedAccepted||!result.oneRealEnd||!result.reopenRaceIgnored||!result.reopenLoaded)fail('behavior mismatch',result);
  else console.log(`LIBMPV_R2M_OPEN_RACE_PASS ended=${result.ended} generation=${result.generation}`);
 }catch(error){fail(String(error?.stack||error));}
 finally{win.destroy();try{fs.rmSync(fixture,{force:true});}catch{}app.exit(failed?1:0);}
})().catch(error=>{fail(String(error?.stack||error));app.exit(1);});

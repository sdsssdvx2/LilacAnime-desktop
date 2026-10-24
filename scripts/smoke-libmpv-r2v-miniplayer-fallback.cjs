'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {app,BrowserWindow,ipcMain}=require('electron');
const root=path.resolve(__dirname,'..'),sourcePreload=path.join(root,'electron','preload.cjs'),index=path.join(root,'src','index.html');
const tempPreload=path.join(os.tmpdir(),`lilac-r2v-fallback-preload-${process.pid}.cjs`),errors=[],calls=[];let miniActive=false;
const fail=m=>{errors.push(String(m));console.error('LIBMPV_R2V_MINI_FALLBACK_ERROR',m)};
function valueFor(channel,args){
  if(channel==='window:buttons'){
    const mode=String(args?.[0]||'');
    if(mode==='__lilac_miniplayer_on__'||mode==='__lilac_miniplayer_off__'){miniActive=mode==='__lilac_miniplayer_on__';calls.push(mode);return {active:miniActive}}
    return true;
  }
  if(channel==='downloads:list')return[];if(channel==='downloads:root')return'';if(channel==='desktop:settings')return{};if(channel==='update:state')return{status:'idle'};if(channel==='device-sync:status')return{connected:false};if(channel==='gemini:get')return{};if(channel==='subtitle-cache:usage')return{files:0,bytes:0};if(channel==='catalog-index:state')return{source:'reanime',status:'ready',count:0};if(channel==='titles:resolve')return[];if(channel==='anime:season'||channel==='anime:top')return{data:[]};if(channel==='provider:catalog')return{data:[],total:0,nextOffset:null,done:true};if(channel==='provider:season')return{data:[],label:'이번 시즌 신작'};if(channel==='provider:airing')return{data:[]};if(channel==='linkkf:home')return{data:[]};if(channel==='mpv:status')return{available:false};if(channel==='font:default')return{choice:'system',customPath:''};if(channel==='desktop:tray'||channel==='window:theme'||channel==='catalog:activate')return true;return null;
}
(async()=>{
  await app.whenReady();
  let preloadSource=fs.readFileSync(sourcePreload,'utf8');
  if(!preloadSource.includes("setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled)),"))throw new Error('source miniplayer bridge missing before fallback simulation');
  preloadSource=preloadSource.replace(/\n\s*setMiniPlayer: enabled => ipcRenderer\.invoke\('player:miniplayer', Boolean\(enabled\)\),/,'').replace(/\n\s*runtimeBridgeVersion: 'r2v',/,'');
  fs.writeFileSync(tempPreload,preloadSource);
  const channels=new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m=>m[1]));
  if(channels.has('player:miniplayer'))throw new Error('fallback preload unexpectedly kept player:miniplayer');
  for(const channel of channels)ipcMain.handle(channel,(_event,...args)=>valueFor(channel,args));
  const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{preload:tempPreload,contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
  win.webContents.on('preload-error',(_e,p,e)=>fail(`preload ${p}: ${e?.stack||e}`));
  win.webContents.on('render-process-gone',(_e,d)=>fail(`render gone ${JSON.stringify(d)}`));
  try{
    await win.loadFile(index);await new Promise(r=>setTimeout(r,1600));
    const result=await win.webContents.executeJavaScript(`(async()=>{const real=document.querySelector('#video'),button=document.querySelector('#miniPlayer'),playerView=document.querySelector('#playerView');if(!real||!button||!playerView)return{missing:true};playerView.classList.add('active');document.body.classList.add('player-mode');try{Object.defineProperty(real,'readyState',{configurable:true,get:()=>4})}catch{}const sleep=ms=>new Promise(r=>setTimeout(r,ms));const diag=window.LilacMiniPlayerDiagnostics?.();const states=[];const snap=label=>({label,active:button.classList.contains('active'),body:document.body.classList.contains('libmpv-mini-player'),disabled:button.disabled});states.push(snap('before'));button.click();await sleep(80);states.push(snap('button-open'));button.click();await sleep(80);states.push(snap('button-close'));window.dispatchEvent(new KeyboardEvent('keydown',{key:'P',code:'KeyP',shiftKey:true,bubbles:true,cancelable:true}));await sleep(80);states.push(snap('key-open'));window.dispatchEvent(new KeyboardEvent('keydown',{key:'P',code:'KeyP',shiftKey:true,bubbles:true,cancelable:true}));await sleep(80);states.push(snap('key-close'));return{tag:real.tagName,diag,states}})()`);
    console.log('LIBMPV_R2V_MINI_FALLBACK_REPORT='+JSON.stringify({result,calls}));
    const expected=[false,true,false,true,false],states=result?.states||[];
    if(result?.missing||result?.tag!=='LILAC-MPV-VIDEO')fail('player missing '+JSON.stringify(result));
    if(result?.diag?.direct!==false||result?.diag?.fallback!==true)fail('did not reproduce missing-direct/fallback-present state '+JSON.stringify(result?.diag));
    if(states.length!==5||states.some((s,i)=>s.active!==expected[i]||s.body!==expected[i]||s.disabled))fail('visual states mismatch '+JSON.stringify(states));
    const wanted=['__lilac_miniplayer_on__','__lilac_miniplayer_off__','__lilac_miniplayer_on__','__lilac_miniplayer_off__'];if(JSON.stringify(calls)!==JSON.stringify(wanted))fail('fallback IPC order mismatch '+JSON.stringify(calls));
  }catch(e){fail(e?.stack||e)}finally{
    for(const channel of channels)ipcMain.removeHandler(channel);if(!win.isDestroyed())win.destroy();try{fs.rmSync(tempPreload,{force:true})}catch{}
    if(errors.length){console.error('LIBMPV_R2V_MINI_FALLBACK_FAIL count='+errors.length);app.exit(1)}else{console.log('LIBMPV_R2V_MINI_FALLBACK_PASS direct=missing stableFallback=window-buttons button=2 ShiftP=2');app.exit(0)}
  }
})().catch(e=>{console.error(e?.stack||e);app.exit(1)});

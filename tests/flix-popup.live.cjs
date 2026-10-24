const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
require('../electron/popup-policy.cjs').installPopupBlocker(app);
let popups=0;
app.on('web-contents-created',(_,contents)=>contents.on('did-create-window',()=>popups++));
const ua='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
app.whenReady().then(async()=>{
 let win;const deadline=setTimeout(()=>{console.error('FlixCloud test timeout');app.exit(1)},60000);
 try{
  const root=await (await fetch('https://reanime.to/api/flix/16498/1',{signal:AbortSignal.timeout(12000),headers:{Referer:'https://reanime.to/','User-Agent':ua}})).json();
  const target=root.servers.find(x=>x.serverName==='HD-1')?.dataLink;assert.ok(target);
  win=new BrowserWindow({show:false,webPreferences:{partition:'persist:lilac-flix-popup-check',sandbox:true,contextIsolation:true,nodeIntegration:false,autoplayPolicy:'no-user-gesture-required',backgroundThrottling:false}});
  win.webContents.setUserAgent(ua);
  let manifests=0;
  win.webContents.session.webRequest.onCompleted(d=>{if(d.statusCode===200&&/\.m3u8(?:\?|$)/i.test(d.url))manifests++});
  win.loadURL(target,{httpReferrer:'https://reanime.to/',userAgent:ua}).catch(()=>{});
  let state;
  for(let i=0;i<15;i++){
   await new Promise(resolve=>setTimeout(resolve,2000));
   state=await win.webContents.mainFrame.executeJavaScript(`({keyLength:typeof window.__pk==='string'?window.__pk.length:0,videos:Array.from(document.querySelectorAll('video')).map(v=>({time:v.currentTime,ready:v.readyState}))})`,true).catch(()=>null);
   if(state?.keyLength&&manifests>0&&i>=4)break;
  }
  assert.ok(state?.keyLength,'playlist key was not found');assert.ok(manifests>0,'no successful playlist request');
  await win.webContents.mainFrame.executeJavaScript(`(async()=>{const v=document.querySelector('video');if(!v)throw new Error('no video');v.muted=true;await v.play()})()`,true);
  await new Promise(resolve=>setTimeout(resolve,3000));
  const playback=await win.webContents.mainFrame.executeJavaScript(`({time:document.querySelector('video').currentTime,ready:document.querySelector('video').readyState})`,true);
  assert.ok(playback.time>0,'FlixCloud playback did not advance');
  assert.equal(await win.webContents.mainFrame.executeJavaScript(`window.open('about:blank')===null`,true),true);
  assert.equal(popups,0);assert.equal(BrowserWindow.getAllWindows().length,1);
  console.log('PASS FlixCloud HD-1:',JSON.stringify({manifests,keyFound:true,popupWindows:popups,playback}));
  clearTimeout(deadline);win.destroy();app.quit();
 }catch(error){console.error(error);clearTimeout(deadline);win?.destroy();app.exit(1)}
});

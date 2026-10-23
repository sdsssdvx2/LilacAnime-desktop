'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await win.webContents.executeJavaScript(expression).catch(error => ({ __evalError: String(error?.message || error) }));
    if (last?.__evalError) throw new Error(`${label} renderer eval failed: ${last.__evalError}`);
    if (last) return last;
    await sleep(50);
  }
  const diag = await win.webContents.executeJavaScript(`({
    href: location.href,
    secure: isSecureContext,
    docPipType: typeof window.documentPictureInPicture,
    requestType: typeof window.documentPictureInPicture?.requestWindow,
    state: window.__docPipState || null
  })`).catch(error => ({ evalError: String(error?.message || error) }));
  throw new Error(`${label} timed out; last=${JSON.stringify(last)} diag=${JSON.stringify(diag)}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r2o-docpip-'));
  const html = path.join(dir, 'probe.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#111;color:#fff;font:16px sans-serif}
canvas{width:640px;height:360px;background:#000;display:block}
video{width:320px;height:180px;background:#000}
button{margin:18px;width:240px;height:64px;font-size:18px}
</style></head><body>
<canvas id="source" width="640" height="360"></canvas>
<button id="open" type="button">Open Document PiP</button>
<script>
window.__docPipState={
  secure:isSecureContext,
  api:typeof window.documentPictureInPicture?.requestWindow==='function',
  clicked:0, opened:false, videoTrack:false, videoPlaying:false,
  subtitleInitial:false, subtitleUpdated:false, pipClosed:false,
  error:null
};
const state=window.__docPipState,canvas=document.querySelector('#source'),button=document.querySelector('#open');
const ctx=canvas.getContext('2d');
let tick=0;
window.__drawTimer=setInterval(()=>{
  tick++;
  ctx.fillStyle=tick%2?'#173b7a':'#7a2a17';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#fff';ctx.font='36px sans-serif';ctx.fillText('frame '+tick,36,64);
},33);
const stream=canvas.captureStream(30);
state.videoTrack=stream.getVideoTracks().length>0;
window.__pipWindow=null;
window.__pipVideo=null;
window.__pipSubtitle=null;
button.addEventListener('click',async()=>{
  state.clicked++;
  try{
    if(!window.documentPictureInPicture?.requestWindow)throw new Error('Document Picture-in-Picture API unavailable');
    const pipWindow=await window.documentPictureInPicture.requestWindow({width:640,height:360});
    window.__pipWindow=pipWindow;
    const doc=pipWindow.document;
    doc.documentElement.style.cssText='margin:0;width:100%;height:100%;background:#000;overflow:hidden';
    doc.body.style.cssText='margin:0;width:100%;height:100%;background:#000;overflow:hidden;position:relative';
    const video=doc.createElement('video');
    video.muted=true;video.playsInline=true;video.autoplay=true;video.srcObject=stream;
    video.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000';
    const sub=doc.createElement('div');
    sub.id='subtitle';sub.textContent='첫 번째 자막';
    sub.style.cssText='position:absolute;left:5%;right:5%;bottom:10%;text-align:center;color:white;font:700 30px sans-serif;line-height:1.2;text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000;pointer-events:none';
    doc.body.append(video,sub);
    window.__pipVideo=video;window.__pipSubtitle=sub;
    await video.play();
    state.videoPlaying=!video.paused;
    state.subtitleInitial=sub.textContent==='첫 번째 자막';
    state.opened=true;
    setTimeout(()=>{if(window.__pipSubtitle){window.__pipSubtitle.textContent='두 번째 자막';state.subtitleUpdated=window.__pipSubtitle.textContent==='두 번째 자막';}},150);
    pipWindow.addEventListener('pagehide',()=>{state.pipClosed=true;},{once:true});
  }catch(error){state.error=String(error?.stack||error?.message||error)}
});
window.__snapshot=()=>({...state,pipWindowAlive:Boolean(window.__pipWindow&&!window.__pipWindow.closed),pipSubtitle:window.__pipSubtitle?.textContent||'',videoPaused:window.__pipVideo?.paused??null});
window.__cleanup=()=>{clearInterval(window.__drawTimer);stream.getTracks().forEach(t=>t.stop());try{window.__pipWindow?.close()}catch{};return window.__snapshot()};
</script></body></html>`);

  const win = new BrowserWindow({
    show: true,
    width: 760,
    height: 560,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  win.webContents.on('console-message', (_event, level, message) => console.log(`R2O_DOCPIP_CONSOLE level=${level} message=${message}`));
  try {
    await win.loadFile(html);
    win.show(); win.focus(); win.webContents.focus();
    const pre = await win.webContents.executeJavaScript('window.__snapshot()');
    console.log(`LIBMPV_R2O_DOCPIP_PRE=${JSON.stringify(pre)}`);
    if (!pre.secure) throw new Error('file:// renderer is not a secure context');
    if (!pre.api) throw new Error('Document Picture-in-Picture API unavailable in Electron renderer');
    if (!pre.videoTrack) throw new Error('canvas stream has no video track');
    const point = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#open').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y),movementX:1,movementY:1});
    win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    const opened = await waitFor(win, `(()=>{const s=window.__snapshot();return s.error?{failed:s}:s.opened&&s.subtitleInitial&&s.videoPlaying?s:null})()`, 10000, 'Document PiP open');
    if (opened.failed) throw new Error(`Document PiP open failed: ${opened.failed.error}`);
    const updated = await waitFor(win, `(()=>{const s=window.__snapshot();return s.error?{failed:s}:s.subtitleUpdated&&s.pipSubtitle==='두 번째 자막'?s:null})()`, 5000, 'Document PiP subtitle update');
    if (updated.failed) throw new Error(`Document PiP subtitle update failed: ${updated.failed.error}`);
    const cleaned = await win.webContents.executeJavaScript('window.__cleanup()');
    console.log(`LIBMPV_R2O_DOCPIP_REPORT=${JSON.stringify({secure:updated.secure,api:updated.api,videoTrack:updated.videoTrack,opened:updated.opened,videoPlaying:updated.videoPlaying,subtitleInitial:updated.subtitleInitial,subtitleUpdated:updated.subtitleUpdated,pipClosed:cleaned.pipClosed})}`);
    console.log('LIBMPV_R2O_DOCPIP_PASS stream=direct overlay=dom subtitleUpdates=event-driven frameComposite=0');
  } finally {
    try { await win.webContents.executeJavaScript('window.__cleanup?.()'); } catch {}
    if (!win.isDestroyed()) win.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

app.whenReady().then(main).then(()=>app.quit()).catch(error=>{console.error(`LIBMPV_R2O_DOCPIP_FAIL=${error?.stack||error}`);app.exit(1)});

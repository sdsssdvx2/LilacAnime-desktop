'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { R40SubtitleOverlayWindowController } = require('../electron/r40-subtitle-overlay-window.cjs');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R40 native subtitle overlay runtime smoke exceeded 120s hard deadline');
  process.exit(124);
}, 120000);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const output = path.join(dir, 'r40-subtitle-red.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','color=c=red:size=640x360:rate=24000/1001:duration=12',
    '-f','lavfi','-i','sine=frequency=550:sample_rate=48000:duration=12',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','64k','-shortest','-movflags','+faststart',output
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture encode failed ${String(result.stderr || '').slice(0,240)}`);
  return output;
}

function hwndText(win) {
  const raw = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(raw) || raw.length < 4) throw new Error('invalid BrowserWindow HWND buffer');
  return (raw.length >= 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))).toString(10);
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch {}
    await sleep(25);
  }
  throw new Error(`${label} timeout last=${JSON.stringify(last)}`);
}

async function capturePrimary() {
  const display = screen.getPrimaryDisplay();
  const width = Math.max(320, Math.round(display.bounds.width));
  const height = Math.max(240, Math.round(display.bounds.height));
  const sources = await desktopCapturer.getSources({ types:['screen'], thumbnailSize:{ width, height }, fetchWindowIcons:false });
  if (!sources.length) throw new Error('desktopCapturer returned no screen sources');
  const source = sources.find(x => String(x.display_id || '') === String(display.id)) || sources[0];
  const image = source.thumbnail;
  const size = image.getSize();
  if (size.width < 64 || size.height < 64) throw new Error(`invalid desktop capture ${size.width}x${size.height}`);
  return { image, size, display };
}

function scanMagenta(capture, rect) {
  const { image, size, display } = capture;
  const bitmap = image.toBitmap();
  const sx = size.width / Math.max(1, display.bounds.width);
  const sy = size.height / Math.max(1, display.bounds.height);
  const x0 = Math.max(0, Math.floor((rect.x - display.bounds.x) * sx));
  const y0 = Math.max(0, Math.floor((rect.y - display.bounds.y) * sy));
  const x1 = Math.min(size.width, Math.ceil((rect.x + rect.width - display.bounds.x) * sx));
  const y1 = Math.min(size.height, Math.ceil((rect.y + rect.height - display.bounds.y) * sy));
  let minX=Infinity,minY=Infinity,maxX=-1,maxY=-1,count=0;
  for(let y=y0;y<y1;y+=1){
    for(let x=x0;x<x1;x+=1){
      const o=(y*size.width+x)*4;
      const c0=bitmap[o],c1=bitmap[o+1],c2=bitmap[o+2];
      // Bright magenta is invariant under R/B channel ordering: channels 0 and 2
      // are both high while green is low.
      if(c0>175&&c2>175&&c1<145){
        minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);count+=1;
      }
    }
  }
  if(!count)return null;
  return {
    x:(minX/sx)+display.bounds.x,
    y:(minY/sy)+display.bounds.y,
    width:(maxX-minX+1)/sx,
    height:(maxY-minY+1)/sy,
    count,
    cx:((minX+maxX+1)/2/sx)+display.bounds.x,
    cy:((minY+maxY+1)/2/sy)+display.bounds.y
  };
}

function sampleMeans(capture, x, y, radius=16) {
  const { image, size, display } = capture;
  const bitmap=image.toBitmap();
  const sx=size.width/Math.max(1,display.bounds.width), sy=size.height/Math.max(1,display.bounds.height);
  const cx=Math.round((x-display.bounds.x)*sx),cy=Math.round((y-display.bounds.y)*sy);
  let c0=0,c1=0,c2=0,n=0;
  for(let py=Math.max(0,cy-radius);py<Math.min(size.height,cy+radius);py+=1){
    for(let px=Math.max(0,cx-radius);px<Math.min(size.width,cx+radius);px+=1){
      const o=(py*size.width+px)*4;c0+=bitmap[o];c1+=bitmap[o+1];c2+=bitmap[o+2];n+=1;
    }
  }
  return {c0:c0/n,c1:c1/n,c2:c2/n};
}
function dominantRed(m) {
  return Math.max(m.c0,m.c2)>115 && m.c1<90 && Math.abs(m.c0-m.c2)>65;
}
function closeEnough(a,b,tolerance,label){
  if(Math.abs(a-b)>tolerance)throw new Error(`${label} mismatch focused=${a} unfocused=${b} tolerance=${tolerance}`);
}

(async()=>{
  await app.whenReady();
  const addonPath=process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath=process.env.LILAC_LIBMPV_DLL;
  if(!addonPath||!fs.existsSync(addonPath)||!dllPath||!fs.existsSync(dllPath))throw new Error('R40 subtitle addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL='1';
  const addon=require(addonPath);
  for(const name of ['createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer','configureNativePresenter','setNativePresenterVisible','setNativePresenterBounds','nativePresenterStats','destroyPlayer']){
    if(typeof addon[name]!=='function')throw new Error(`missing addon export ${name}`);
  }

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r40-subtitle-'));
  let owner=null,rival=null,id=null,controller=null;
  try{
    const media=fixture(dir),work=screen.getPrimaryDisplay().workArea;
    owner=new BrowserWindow({show:false,frame:false,x:work.x+70,y:work.y+60,width:900,height:560,backgroundColor:'#1428b4',webPreferences:{backgroundThrottling:false}});
    const html=`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(20,40,180)}
      #stack{position:absolute;left:120px;top:405px;width:660px;height:86px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:0}
      #cue{display:block;color:rgb(255,0,255);font-family:Arial,sans-serif;font-size:42px;font-weight:700;font-style:normal;line-height:50px;letter-spacing:0.5px;text-align:center;white-space:nowrap;text-shadow:2px 2px 0 rgb(0,0,0);-webkit-text-stroke:1px rgb(255,0,255);max-width:660px}
    </style></head><body><div id="stack"><div id="cue">R40 SAME DOM SUBTITLE</div></div><script>
      const keys=['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','color','textShadow','webkitTextStroke','webkitTextStrokeWidth','webkitTextStrokeColor','filter','whiteSpace','overflowWrap','wordBreak','textAlign','textDecoration','maxWidth','opacity','visibility','direction','writingMode'];
      const pick=node=>{const s=getComputedStyle(node),o={};for(const k of keys){if(s[k]!=null&&s[k]!=='')o[k]=String(s[k])}return o};
      window.__r40Payload=()=>{const stack=document.getElementById('stack'),cue=document.getElementById('cue'),r=stack.getBoundingClientRect(),ss=getComputedStyle(stack);return {marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',revision:1,active:true,stackRect:{x:r.x,y:r.y,width:r.width,height:r.height},stackStyle:pick(stack),stackGap:String(ss.gap||'0px'),stackAlignItems:String(ss.alignItems||'center'),stackJustifyContent:String(ss.justifyContent||'normal'),fontPath:'',cues:[{html:cue.innerHTML,style:pick(cue)}]}};
    </script></body></html>`;
    await owner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    owner.show();owner.focus();
    await waitUntil(()=>owner.isFocused(),3000,'owner focus');
    await sleep(300);
    const ownerRect=owner.getContentBounds();
    const focusedBox=scanMagenta(await capturePrimary(),ownerRect);
    if(!focusedBox||focusedBox.count<80)throw new Error(`focused DOM subtitle pixels missing ${JSON.stringify(focusedBox)}`);
    const payload=await owner.webContents.executeJavaScript('window.__r40Payload()');
    if(!payload?.active||payload?.cues?.length!==1)throw new Error(`focused DOM payload invalid ${JSON.stringify(payload)}`);

    const created=addon.createPlayer();id=Number(created.playerId);if(!id)throw new Error('createPlayer failed');
    if(addon.setUpdateCallback(id,()=>{})!==true)throw new Error('setUpdateCallback failed');
    if(addon.configureNativePresenter(id,hwndText(owner))!==true)throw new Error('configureNativePresenter failed');
    const syncBounds=()=>{const b=owner.getContentBounds();return addon.setNativePresenterBounds(id,0,0,Math.max(2,b.width),Math.max(2,b.height));};
    if(syncBounds()!==true)throw new Error('initial native bounds failed');
    addon.open(id,media);
    await waitUntil(()=>addon.pollPlayback(id)?.fileLoaded===true,10000,'fixture load');
    if(!addon.startFrameProducer(id,640,360))throw new Error('startFrameProducer failed');
    addon.setNativePresenterVisible(id,false);

    controller=new R40SubtitleOverlayWindowController({BrowserWindow,baseDir:path.resolve(__dirname,'..','electron')});
    const rivalX=Math.min(work.x+work.width-260,ownerRect.x+ownerRect.width+30);
    rival=new BrowserWindow({show:false,frame:false,x:rivalX,y:work.y+80,width:240,height:180,backgroundColor:'#20b440',webPreferences:{backgroundThrottling:false}});
    await rival.loadURL('data:text/html,<html><body style="margin:0;background:rgb(32,180,64)"></body></html>');
    rival.show();rival.focus();
    await waitUntil(()=>!owner.isFocused()&&rival.isFocused(),3000,'owner blur');
    syncBounds();addon.setNativePresenterVisible(id,true);
    await waitUntil(()=>{const s=addon.nativePresenterStats(id);return s?.windowVisible===true&&Number(s?.presentedFrames||0)>=4?s:null},6000,'R33 native popup visible');

    const overlayState=await controller.update(owner,payload);
    if(overlayState?.visible!==true)throw new Error(`R40 overlay did not activate ${JSON.stringify(overlayState)}`);
    await waitUntil(()=>{const s=controller.snapshot();return s.ready&&s.windowVisible&&s.failures===0?s:null},5000,'R40 overlay visible');
    await sleep(250);

    const unfocusedCapture=await capturePrimary();
    const unfocusedBox=scanMagenta(unfocusedCapture,owner.getContentBounds());
    if(!unfocusedBox||unfocusedBox.count<80)throw new Error(`unfocused DOM overlay subtitle pixels missing above native popup ${JSON.stringify(unfocusedBox)} state=${JSON.stringify(controller.snapshot())}`);
    const videoRect=owner.getContentBounds();
    const redProbe=sampleMeans(unfocusedCapture,videoRect.x+videoRect.width/2,videoRect.y+videoRect.height*0.28,18);
    if(!dominantRed(redProbe))throw new Error(`R33 native popup red video not visible behind subtitle overlay ${JSON.stringify(redProbe)}`);

    closeEnough(focusedBox.cx,unfocusedBox.cx,3.5,'subtitle center-x');
    closeEnough(focusedBox.cy,unfocusedBox.cy,3.5,'subtitle center-y');
    closeEnough(focusedBox.width,unfocusedBox.width,5,'subtitle width');
    closeEnough(focusedBox.height,unfocusedBox.height,5,'subtitle height');

    owner.focus();
    await waitUntil(()=>owner.isFocused(),3000,'owner refocus');
    const hidden=await controller.update(owner,payload);
    if(hidden?.visible!==false||controller.snapshot().windowVisible)throw new Error(`overlay survived refocus ${JSON.stringify(controller.snapshot())}`);

    console.log(`R40_NATIVE_SUBTITLE_OVERLAY_RUNTIME_OK focusedPixels=${focusedBox.count} unfocusedPixels=${unfocusedBox.count} dx=${Math.abs(focusedBox.cx-unfocusedBox.cx).toFixed(2)} dy=${Math.abs(focusedBox.cy-unfocusedBox.cy).toFixed(2)} dw=${Math.abs(focusedBox.width-unfocusedBox.width).toFixed(2)} dh=${Math.abs(focusedBox.height-unfocusedBox.height).toFixed(2)} nativeRedBehind=1 overlayAboveRawHwnd=1 refocusHide=1 failures=0`);
  }finally{
    clearTimeout(hardDeadline);
    try{controller?.destroy('test-cleanup')}catch{}
    if(id!=null){try{addon.setNativePresenterVisible(id,false)}catch{}try{addon.stopFrameProducer(id)}catch{}try{addon.destroyPlayer(id)}catch{}}
    try{rival?.destroy()}catch{}try{owner?.destroy()}catch{}try{fs.rmSync(dir,{recursive:true,force:true})}catch{}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    app.quit();
  }
})().catch(error=>{
  clearTimeout(hardDeadline);
  console.error(error?.stack||error);
  process.exitCode=1;
  try{app.quit()}catch{}
});

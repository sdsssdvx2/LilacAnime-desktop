'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { MiniPlayerWindowController } = require('../electron/miniplayer-window.cjs');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R39 miniplayer native-topmost runtime smoke exceeded 120s hard deadline');
  process.exit(124);
}, 120000);

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const output = path.join(dir, 'r39-miniplayer-red.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','color=c=red:size=640x360:rate=24000/1001:duration=15',
    '-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=15',
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

function sampleMeans(capture, rect) {
  const { image, size, display } = capture;
  const bitmap = image.toBitmap();
  const sx = size.width / Math.max(1, display.bounds.width);
  const sy = size.height / Math.max(1, display.bounds.height);
  const cx = Math.round((rect.left - display.bounds.x + rect.width / 2) * sx);
  const cy = Math.round((rect.top - display.bounds.y + rect.height / 2) * sy);
  const half = 20;
  const x0 = Math.max(0, Math.min(size.width - 1, cx - half));
  const x1 = Math.max(x0 + 1, Math.min(size.width, cx + half));
  const y0 = Math.max(0, Math.min(size.height - 1, cy - half));
  const y1 = Math.max(y0 + 1, Math.min(size.height, cy + half));
  let c0=0,c1=0,c2=0,n=0;
  for(let y=y0;y<y1;y+=1){for(let x=x0;x<x1;x+=1){const o=(y*size.width+x)*4;c0+=bitmap[o];c1+=bitmap[o+1];c2+=bitmap[o+2];n+=1;}}
  return { c0:c0/n, c1:c1/n, c2:c2/n, samples:n };
}

function rectFromStats(stats) {
  return { left:Number(stats.screenLeft), top:Number(stats.screenTop), width:Number(stats.screenWidth), height:Number(stats.screenHeight) };
}

function dominantRed(means) {
  const channels=[means.c0,means.c1,means.c2];
  const hi=Math.max(...channels), lo=Math.min(...channels);
  return hi > 120 && hi - lo > 70 && hi > means.c1 + 50;
}

(async () => {
  await app.whenReady();
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('R39 addon/dll env missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer','stopFrameProducer','configureNativePresenter','setNativePresenterVisible','setNativePresenterBounds','nativePresenterStats','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r39-topmost-'));
  let owner=null, rival=null, id=null, onFocus=null, onBlur=null;
  try {
    const media = fixture(dir);
    const work = screen.getPrimaryDisplay().workArea;
    owner = new BrowserWindow({
      show:false, frame:false, x:work.x+60, y:work.y+60, width:900, height:560,
      backgroundColor:'#1428b4', webPreferences:{ backgroundThrottling:false }
    });
    await owner.loadURL('data:text/html,<html><body style="margin:0;background:rgb(20,40,180);overflow:hidden"><div style="color:white">R39 owner</div></body></html>');
    owner.show(); owner.focus();
    await waitUntil(() => owner.isFocused(), 3000, 'owner focus');

    const created=addon.createPlayer();
    id=Number(created.playerId);
    if(!id) throw new Error('createPlayer failed');
    if(addon.setUpdateCallback(id,()=>{})!==true) throw new Error('setUpdateCallback failed');
    if(addon.configureNativePresenter(id,hwndText(owner))!==true) throw new Error('configureNativePresenter failed');
    const syncBounds=()=>{const b=owner.getContentBounds();return addon.setNativePresenterBounds(id,0,0,Math.max(2,b.width),Math.max(2,b.height));};
    if(syncBounds()!==true) throw new Error('initial native bounds failed');
    onFocus=()=>addon.setNativePresenterVisible(id,false);
    onBlur=()=>{syncBounds();addon.setNativePresenterVisible(id,true);};
    owner.on('focus',onFocus); owner.on('blur',onBlur);

    addon.open(id,media);
    await waitUntil(()=>addon.pollPlayback(id)?.fileLoaded===true,10000,'fixture load');
    if(!addon.startFrameProducer(id,640,360)) throw new Error('startFrameProducer failed');
    addon.setNativePresenterVisible(id,false);

    const controller=new MiniPlayerWindowController({screen});
    const entered=await controller.set(owner,true);
    if(entered?.active!==true || owner.isAlwaysOnTop()!==true) throw new Error(`mini-player did not enter topmost ${JSON.stringify(entered)}`);
    syncBounds();

    const popupBefore=addon.nativePresenterStats(id);
    const miniBounds=owner.getBounds();
    rival=new BrowserWindow({
      show:false, frame:false,
      x:miniBounds.x+Math.floor(miniBounds.width*.2), y:miniBounds.y+Math.floor(miniBounds.height*.2),
      width:Math.max(220,Math.floor(miniBounds.width*.6)), height:Math.max(140,Math.floor(miniBounds.height*.6)),
      alwaysOnTop:false, backgroundColor:'#20b440', webPreferences:{backgroundThrottling:false}
    });
    await rival.loadURL('data:text/html,<html><body style="margin:0;background:rgb(32,180,64);overflow:hidden"></body></html>');
    rival.show(); rival.focus();
    await waitUntil(()=>!owner.isFocused()&&rival.isFocused(),3000,'rival focus over mini-player');
    await waitUntil(()=>{
      const s=addon.nativePresenterStats(id);
      return s?.requestedVisible===true&&s?.windowVisible===true&&s?.ownerTopmost===true&&s?.windowTopmost===true&&Number(s?.presentedFrames||0)>=4;
    },6000,'native popup promoted with topmost owner');

    const promoted=addon.nativePresenterStats(id);
    const visibleMeans=sampleMeans(await capturePrimary(),rectFromStats(promoted));
    if(!dominantRed(visibleMeans)) throw new Error(`topmost native video not visible above rival ${JSON.stringify(visibleMeans)} stats=${JSON.stringify(promoted)}`);

    // Realistic exit sequence: click/focus the mini-player, which hides native popup;
    // then leave mini-player mode; a later blur must explicitly re-show it NOTOPMOST.
    owner.focus();
    await waitUntil(()=>owner.isFocused(),3000,'owner focus before miniplayer exit');
    await waitUntil(()=>addon.nativePresenterStats(id)?.windowVisible===false,3000,'native popup hidden before miniplayer exit');
    const left=await controller.set(owner,false);
    if(left?.active!==false || owner.isAlwaysOnTop()!==false) throw new Error(`mini-player did not restore non-topmost state ${JSON.stringify(left)}`);
    syncBounds();

    // Move rival to the restored video center and focus it. R39's next visibility
    // sync must demote the native popup via HWND_NOTOPMOST before showing it.
    const restored=owner.getBounds();
    rival.setBounds({
      x:restored.x+Math.floor(restored.width*.2), y:restored.y+Math.floor(restored.height*.2),
      width:Math.max(260,Math.floor(restored.width*.6)), height:Math.max(180,Math.floor(restored.height*.6))
    },false);
    rival.show(); rival.focus();
    await waitUntil(()=>!owner.isFocused()&&rival.isFocused(),3000,'rival focus after miniplayer exit');
    const demoted=await waitUntil(()=>{
      const s=addon.nativePresenterStats(id);
      return s?.windowVisible===true&&s?.ownerTopmost===false&&s?.windowTopmost===false?s:null;
    },5000,'native popup demoted after miniplayer exit');

    console.log(`R39_MINIPLAYER_NATIVE_TOPMOST_RUNTIME_OK ownerTopmost=${promoted.ownerTopmost?1:0} popupTopmost=${promoted.windowTopmost?1:0} visibleAboveRival=1 exitOwnerTopmost=${demoted.ownerTopmost?1:0} exitPopupTopmost=${demoted.windowTopmost?1:0} bidirectional=1 r33OwnedPopup=1`);
  } finally {
    clearTimeout(hardDeadline);
    if(owner&&onFocus) owner.removeListener('focus',onFocus);
    if(owner&&onBlur) owner.removeListener('blur',onBlur);
    if(id!=null){try{addon.setNativePresenterVisible(id,false);}catch{}try{addon.stopFrameProducer(id);}catch{}try{addon.destroyPlayer(id);}catch{}}
    try{rival?.destroy();}catch{} try{owner?.destroy();}catch{}
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    app.quit();
  }
})().catch(error=>{
  clearTimeout(hardDeadline);
  console.error(error?.stack||error);
  process.exitCode=1;
  try{app.quit();}catch{}
});

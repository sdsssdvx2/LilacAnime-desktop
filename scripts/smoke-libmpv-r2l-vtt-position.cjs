'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const bundlePath = path.join(root, 'src', 'libmpv-shared.generated.js');
const fixture = path.join(os.tmpdir(), `lilac-r2l-vtt-pos-${process.pid}.html`);
let failed = false;
function fail(message, detail) { failed = true; console.error(`LIBMPV_R2L_VTT_POSITION_FAIL ${message}`); if (detail) console.error(JSON.stringify(detail)); }
(async()=>{
  await app.whenReady();
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><style>html,body,#playerView{margin:0;width:100%;height:100%;background:#000}lilac-mpv-video{display:block;width:1280px;height:720px}</style><div id="playerView" class="active"></div>');
  const win = new BrowserWindow({show:false,width:1280,height:720,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
  try {
    await win.loadFile(fixture);
    await win.webContents.executeJavaScript(`
      window.__time=1.5;
      window.lilac={
        libmpvSharedOpen:async()=>({ok:true,playerId:1,generation:1}),
        libmpvSharedCommand:async()=>({ok:true}),
        libmpvSharedState:async()=>({active:true,generation:1,time:window.__time,duration:10,width:1920,height:1080,paused:false,eof:false,metrics:{sentFrames:1}}),
        libmpvSharedResize:async()=>({ok:true}),libmpvSharedClose:async()=>({ok:true})
      }; true;
    `);
    await win.webContents.executeJavaScript(`${bundle}\n;true;`);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      localStorage.clear(); localStorage.setItem('subtitleSize','100'); localStorage.setItem('vttOutline','2'); localStorage.setItem('vttBold','true'); localStorage.setItem('subtitlePosition','12');
      const video=document.createElement('lilac-mpv-video'); document.querySelector('#playerView').append(video); await video.openLilacSource('https://example.invalid/test.m3u8',{hls:true});
      const track=document.createElement('track'); track.kind='subtitles';track.default=true;track.src='data:text/vtt;charset=utf-8,'+encodeURIComponent('WEBVTT\\n\\n00:00:01.000 --> 00:00:03.000\\n테스트 자막');
      const loaded=new Promise((resolve,reject)=>{track.addEventListener('load',resolve,{once:true});track.addEventListener('error',()=>reject(new Error('track error')),{once:true});}); video.append(track); await loaded; await video._pollState(); video.refreshSubtitleOverlay();
      const stack=video.shadowRoot.querySelector('.lilac-vtt-stack'); const cue=video.shadowRoot.querySelector('.lilac-vtt-cue');
      const defaultStyle=getComputedStyle(stack); const defaultBottom=parseFloat(defaultStyle.bottom); const defaultFont=parseFloat(defaultStyle.fontSize); const defaultLine=parseFloat(defaultStyle.lineHeight);
      localStorage.setItem('subtitlePosition','0'); video.refreshSubtitleOverlay(); const lowBottom=parseFloat(getComputedStyle(stack).bottom);
      localStorage.setItem('subtitlePosition','45'); video.refreshSubtitleOverlay(); const highBottom=parseFloat(getComputedStyle(stack).bottom);
      return {defaultBottom,defaultFont,defaultLine,lowBottom,highBottom,text:String(cue?.textContent||'').trim(),weight:getComputedStyle(stack).fontWeight,shadow:getComputedStyle(stack).textShadow};
    })()`);
    const ok = Math.abs(result.defaultBottom - 86.4) < 1.5 && Math.abs(result.defaultFont - 36) < 1 && result.lowBottom < 1 && Math.abs(result.highBottom - 324) < 2 && result.text.includes('테스트') && Number(result.weight) >= 700 && result.shadow !== 'none';
    if (!ok) fail('visual metrics mismatch', result); else console.log(`LIBMPV_R2L_VTT_POSITION_PASS bottom12=${result.defaultBottom} bottom0=${result.lowBottom} bottom45=${result.highBottom} font=${result.defaultFont}`);
  } catch (error) { fail(String(error?.stack||error)); }
  finally { win.destroy(); try{fs.rmSync(fixture,{force:true});}catch{} app.exit(failed?1:0); }
})().catch(error=>{fail(String(error?.stack||error));app.exit(1);});

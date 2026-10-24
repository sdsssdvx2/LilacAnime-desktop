'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const bundlePath = path.join(root, 'src/libmpv-shared.generated.js');
const playerSource = fs.readFileSync(path.join(root, 'src/player.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const fixturePath = path.join(os.tmpdir(), `lilac-r2s-subtitle-${process.pid}.html`);
let failed = false;
function fail(message, details) { failed = true; console.error('LIBMPV_R2S_SUBTITLE_FAIL ' + message); if (details) console.error(JSON.stringify(details, null, 2)); }

(async () => {
  await app.whenReady();
  for (const marker of ['psSubtitleOriginalPreset','psSubtitleBestPreset','max="100" step="1" value="100"','max="700" step="300" value="700"']) {
    if (!indexSource.includes(marker)) fail('index marker missing: ' + marker);
  }
  for (const marker of [
    'subtitleSize: 100, subtitlePosition: 12, vttWeight: 700, vttOutline: 2, vttMaxWidth: 100, vttShadow: 0',
    'subtitleSize: 95, subtitlePosition: 10, subtitleLineHeight: 120, vttWeight: 700, vttOutline: 1.75, vttMaxWidth: 84, vttShadow: 35',
    "localStorage.removeItem('subtitleLineHeight')"
  ]) if (!playerSource.includes(marker)) fail('preset marker missing: ' + marker);
  if (failed) return app.exit(1);

  const bundle = fs.readFileSync(bundlePath, 'utf8');
  fs.writeFileSync(fixturePath, '<!doctype html><meta charset="utf-8"><style>html,body,#playerView{margin:0;width:100%;height:100%;background:#333}lilac-mpv-video{display:block;width:1280px;height:720px}</style><div id="playerView" class="active"></div>');
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  try {
    await win.loadFile(fixturePath);
    await win.webContents.executeJavaScript(`window.lilac={libmpvSharedOpen:async()=>({ok:true,playerId:1,generation:1}),libmpvSharedCommand:async()=>({ok:true}),libmpvSharedState:async()=>({active:true,generation:1,fileLoaded:true,time:1.5,duration:10,width:1920,height:1080,paused:true,eof:false,metrics:{sentFrames:1}}),libmpvSharedResize:async()=>({ok:true}),libmpvSharedClose:async()=>({ok:true})};true;`);
    await win.webContents.executeJavaScript(`${bundle}\n;true;`);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      localStorage.clear();
      const video=document.createElement('lilac-mpv-video');document.querySelector('#playerView').append(video);await video.openLilacSource('https://example.invalid/video.m3u8',{hls:true});
      const track=document.createElement('track');track.kind='subtitles';track.default=true;track.src='data:text/vtt;charset=utf-8,'+encodeURIComponent('WEBVTT\\n\\n00:00:01.000 --> 00:00:03.000\\n이 문장은 최대 폭 변화를 확인할 수 있도록 충분히 길게 작성한 자막 테스트 문장입니다 아주 긴 문장을 계속 이어서 표시합니다\\n둘째 줄\\n');
      const loaded=new Promise((resolve,reject)=>{track.addEventListener('load',resolve,{once:true});track.addEventListener('error',()=>reject(new Error('track error')),{once:true})});video.append(track);await loaded;await new Promise(r=>setTimeout(r,250));
      const stack=()=>video.shadowRoot.querySelector('.lilac-vtt-stack');
      const snap=()=>{const s=getComputedStyle(stack()),r=stack().getBoundingClientRect();return{weight:s.fontWeight,fontSize:parseFloat(s.fontSize),lineHeight:parseFloat(s.lineHeight),width:r.width,left:r.left,right:1280-r.right,shadow:s.textShadow}};
      const fresh=snap();
      localStorage.setItem('subtitleLineHeight','120');video.refreshSubtitleOverlay();await new Promise(r=>setTimeout(r,40));const line120=snap();
      localStorage.setItem('vttMaxWidth','84');video.refreshSubtitleOverlay();await new Promise(r=>setTimeout(r,40));const width84=snap();
      localStorage.setItem('vttWeight','400');video.refreshSubtitleOverlay();await new Promise(r=>setTimeout(r,40));const weight400=snap();
      localStorage.setItem('vttWeight','700');localStorage.setItem('vttShadow','100');video.refreshSubtitleOverlay();await new Promise(r=>setTimeout(r,40));const shadow100=snap();
      return{fresh,line120,width84,weight400,shadow100};
    })()`);
    const approx=(a,b,t)=>Math.abs(Number(a)-b)<=t;
    const ok=result.fresh.weight==='700' && approx(result.fresh.lineHeight,57.6,2) && approx(result.fresh.width,1280,5) && !/rgba\(/i.test(result.fresh.shadow) &&
      approx(result.line120.lineHeight,43.2,2) && approx(result.width84.width,1075.2,8) && result.weight400.weight==='400' && /rgba\(/i.test(result.shadow100.shadow);
    if (!ok) fail('rendered semantics mismatch', result);
    else console.log('LIBMPV_R2S_SUBTITLE_PASS original=100/160/700/shadow0 presetWidth=84 line120=1 weight400=1 shadow100=1 ' + JSON.stringify(result));
  } catch (error) { fail(String(error?.stack || error)); }
  finally { if (!win.isDestroyed()) win.destroy(); try { fs.rmSync(fixturePath,{force:true}); } catch {} app.exit(failed?1:0); }
})().catch(error=>{console.error(error?.stack||error);app.exit(1)});

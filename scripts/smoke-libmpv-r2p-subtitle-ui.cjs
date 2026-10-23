'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const bundlePath = path.join(root, 'src/libmpv-shared.generated.js');
const fixturePath = path.join(os.tmpdir(), `lilac-r2p-subtitle-ui-${process.pid}.html`);
let failed = false;
function fail(message, details = null) { failed = true; console.error(`LIBMPV_R2P_SUBTITLE_UI_FAIL ${message}`); if (details) console.error(JSON.stringify(details, null, 2)); }

(async () => {
  await app.whenReady();
  const index = read('src/index.html'), player = read('src/player.js'), appJs = read('src/app.js'), entry = read('src/libmpv-shared-entry.js');
  for (const marker of ['psSubtitleBestPreset','psVttWeight','psVttMaxWidth','psVttLineHeight','psVttShadow']) if (!index.includes(marker)) fail(`index marker missing: ${marker}`);
  for (const marker of ['subtitleSize: 95','subtitlePosition: 10','vttWeight: 650','vttOutline: 2.25','vttMaxWidth: 82','vttLineHeight: 120','vttShadow: 55']) if (!player.includes(marker)) fail(`preset marker missing: ${marker}`);
  for (const marker of ["subtitleStyleNumber('vttWeight',650","subtitleStyleNumber('vttLineHeight',120","subtitleStyleNumber('vttShadow',55"]) if (!appJs.includes(marker)) fail(`cue renderer marker missing: ${marker}`);
  for (const marker of ["localStorage.getItem('vttWeight') || 650","localStorage.getItem('vttMaxWidth') || 82","localStorage.getItem('vttLineHeight') || 120","localStorage.getItem('vttShadow') || 55"]) if (!entry.includes(marker)) fail(`libmpv overlay marker missing: ${marker}`);
  if (index.includes('id="psVttBold"') || player.includes("$('#psVttBold')")) fail('legacy boolean bold UI survived');
  if (!fs.existsSync(bundlePath)) fail('generated shared renderer bundle missing');
  if (failed) return app.exit(1);

  const bundle = fs.readFileSync(bundlePath, 'utf8');
  fs.writeFileSync(fixturePath, '<!doctype html><meta charset="utf-8"><style>html,body,#playerView{margin:0;width:100%;height:100%;background:#000} lilac-mpv-video{display:block;width:1280px;height:720px}</style><div id="playerView" class="active"></div>');
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  try {
    await win.loadFile(fixturePath);
    await win.webContents.executeJavaScript(`
      window.__testTime = 1.5;
      window.lilac = {
        libmpvSharedOpen: async () => ({ ok: true, playerId: 1, generation: 1 }),
        libmpvSharedCommand: async () => ({ ok: true }),
        libmpvSharedState: async () => ({ active: true, generation: 1, fileLoaded: true, time: window.__testTime, duration: 10, width: 1920, height: 1080, paused: false, eof: false, metrics: { sentFrames: 12 } }),
        libmpvSharedResize: async () => ({ ok: true }),
        libmpvSharedClose: async () => ({ ok: true })
      };
      true;
    `);
    await win.webContents.executeJavaScript(`${bundle}\n;true;`);
    const result = await win.webContents.executeJavaScript(`(async () => {
      localStorage.clear();
      localStorage.setItem('subtitleSize', '95');
      localStorage.setItem('subtitlePosition', '10');
      localStorage.setItem('vttWeight', '650');
      localStorage.setItem('vttOutline', '2.25');
      localStorage.setItem('vttMaxWidth', '82');
      localStorage.setItem('vttLineHeight', '120');
      localStorage.setItem('vttShadow', '55');
      localStorage.setItem('vttStyle', 'false');
      const video = document.createElement('lilac-mpv-video');
      document.querySelector('#playerView').append(video);
      await video.openLilacSource('https://example.invalid/video.m3u8', { hls: true });
      const track = document.createElement('track');
      track.kind = 'subtitles'; track.label = 'R2P smoke'; track.srclang = 'ko'; track.default = true;
      track.src = 'data:text/vtt;charset=utf-8,' + encodeURIComponent('WEBVTT\\n\\n00:00:01.000 --> 00:00:03.000\\n긴 자막 문장을 위한 가독성 프리셋 테스트입니다\\n두 번째 줄입니다\\n');
      const loaded = new Promise((resolve, reject) => { track.addEventListener('load', resolve, { once: true }); track.addEventListener('error', () => reject(new Error('track error')), { once: true }); });
      video.append(track); await loaded; await new Promise(resolve => setTimeout(resolve, 350));
      const layer = video.shadowRoot.querySelector('[data-lilac-vtt-overlay]');
      const stack = video.shadowRoot.querySelector('.lilac-vtt-stack');
      const style = getComputedStyle(stack);
      const rect = stack.getBoundingClientRect();
      return {
        display: String(layer.style.display || ''), text: String(stack.textContent || '').trim(),
        fontWeight: String(style.fontWeight || ''), fontSize: parseFloat(style.fontSize || '0'), lineHeight: parseFloat(style.lineHeight || '0'),
        left: parseFloat(style.left || '0'), right: parseFloat(style.right || '0'), width: rect.width,
        textShadow: String(style.textShadow || ''), bottom: String(style.bottom || '')
      };
    })()`);
    const approx = (value, target, tolerance) => Math.abs(Number(value) - target) <= tolerance;
    const ok = result.display === 'block' && result.text.includes('가독성 프리셋') && result.fontWeight === '650' &&
      approx(result.fontSize, 34.2, 0.7) && approx(result.lineHeight, 41.04, 1.2) &&
      approx(result.left, 115.2, 3) && approx(result.right, 115.2, 3) && approx(result.width, 1049.6, 7) &&
      result.textShadow && result.textShadow !== 'none';
    if (!ok) fail('rendered preset style mismatch', result);
    else console.log(`LIBMPV_R2P_SUBTITLE_UI_PASS weight=${result.fontWeight} size=${result.fontSize.toFixed(2)} line=${result.lineHeight.toFixed(2)} width=${result.width.toFixed(2)} shadow=1 bottom=${result.bottom}`);
  } catch (error) { fail(String(error?.stack || error)); }
  finally { if (!win.isDestroyed()) win.destroy(); try { fs.rmSync(fixturePath, { force: true }); } catch {} app.exit(failed ? 1 : 0); }
})().catch(error => { fail(String(error?.stack || error)); try { fs.rmSync(fixturePath, { force: true }); } catch {} app.exit(1); });

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const bundlePath = path.join(root, 'src', 'libmpv-shared.generated.js');

function fail(message, details = null) {
  console.error(`LIBMPV_R2J_VTT_OVERLAY_FAIL ${message}`);
  if (details) console.error(JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

(async () => {
  await app.whenReady();
  if (!fs.existsSync(bundlePath)) throw new Error('generated shared renderer bundle missing');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>html,body,#playerView{margin:0;width:100%;height:100%;background:#000} lilac-mpv-video{display:block;width:1280px;height:720px}</style><div id="playerView" class="active"></div>`));
    await win.webContents.executeJavaScript(`
      window.__testTime = 1.5;
      window.__commands = [];
      window.lilac = {
        libmpvSharedOpen: async () => ({ ok: true, playerId: 1 }),
        libmpvSharedCommand: async command => { window.__commands.push(command); return { ok: true }; },
        libmpvSharedState: async () => ({ active: true, time: window.__testTime, duration: 10, width: 1920, height: 1080, paused: false, eof: false, metrics: { sentFrames: 12 } }),
        libmpvSharedResize: async () => ({ ok: true }),
        libmpvSharedClose: async () => ({ ok: true })
      };
    `);
    await win.webContents.executeJavaScript(bundle);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const video = document.createElement('lilac-mpv-video');
      document.querySelector('#playerView').append(video);
      await video.openLilacSource('https://example.invalid/video.m3u8', { hls: true });
      const track = document.createElement('track');
      track.kind = 'subtitles'; track.label = 'R2J smoke'; track.srclang = 'ko'; track.default = true;
      track.src = 'data:text/vtt;charset=utf-8,' + encodeURIComponent('WEBVTT\\n\\n00:00:01.000 --> 00:00:03.000\\n안녕하세요 <b>R2J</b>\\n');
      const loaded = new Promise((resolve, reject) => { track.addEventListener('load', resolve, { once: true }); track.addEventListener('error', () => reject(new Error('track error')), { once: true }); });
      video.append(track);
      await loaded;
      await new Promise(resolve => setTimeout(resolve, 350));
      const layer = video.shadowRoot.querySelector('[data-lilac-vtt-overlay]');
      const stack = video.shadowRoot.querySelector('.lilac-vtt-stack');
      const showing = { display: layer.style.display, text: stack.textContent.trim(), cueCount: video.textTracks[0]?.cues?.length || 0, mode: video.textTracks[0]?.mode || null };
      video.textTracks[0].mode = 'hidden';
      video.refreshSubtitleOverlay();
      const hiddenDisplay = layer.style.display;
      video.textTracks[0].mode = 'showing';
      window.__testTime = 4.5;
      await new Promise(resolve => setTimeout(resolve, 350));
      const afterCueDisplay = layer.style.display;
      window.__testTime = 1.5;
      await new Promise(resolve => setTimeout(resolve, 350));
      const restored = { display: layer.style.display, text: stack.textContent.trim() };
      return { showing, hiddenDisplay, afterCueDisplay, restored, commands: window.__commands };
    })()`);

    const badNativeSub = result.commands.some(command => Array.isArray(command) && command[0] === 'sub-add');
    const ok = result.showing.display === 'block'
      && result.showing.mode === 'showing'
      && result.showing.cueCount === 1
      && result.showing.text.includes('안녕하세요')
      && result.showing.text.includes('R2J')
      && result.hiddenDisplay === 'none'
      && result.afterCueDisplay === 'none'
      && result.restored.display === 'block'
      && result.restored.text.includes('안녕하세요')
      && !badNativeSub;
    if (!ok) return fail('overlay behavior mismatch', result);
    console.log('LIBMPV_R2J_VTT_OVERLAY_PASS visible=1 hidden=1 expired=1 restored=1 nativeSubAdd=0');
    console.log(JSON.stringify(result));
  } catch (error) {
    fail(String(error?.stack || error));
  } finally {
    win.destroy();
    app.quit();
  }
})().catch(error => { fail(String(error?.stack || error)); app.quit(); });

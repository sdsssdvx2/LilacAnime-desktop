'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const bundlePath = path.join(root, 'src', 'libmpv-shared.generated.js');
const fixturePath = path.join(os.tmpdir(), `lilac-r2l-ended-${process.pid}.html`);
let failed = false;

function fail(message, details) {
  failed = true;
  console.error(`LIBMPV_R2L_ENDED_EDGE_FAIL ${message}`);
  if (details) console.error(JSON.stringify(details));
}

(async () => {
  await app.whenReady();
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  fs.writeFileSync(fixturePath, '<!doctype html><meta charset="utf-8"><style>html,body,#playerView{margin:0;width:100%;height:100%}lilac-mpv-video{display:block;width:1280px;height:720px}</style><div id="playerView" class="active"></div>');
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  try {
    await win.loadFile(fixturePath);
    await win.webContents.executeJavaScript(`
      window.__state = { active:true, generation:1, time:9.9, duration:10, width:1920, height:1080, paused:true, eof:true, metrics:{sentFrames:1} };
      window.lilac = {
        libmpvSharedOpen: async () => ({ ok:true, playerId:1, generation:2 }),
        libmpvSharedCommand: async () => ({ ok:true }),
        libmpvSharedState: async () => ({ ...window.__state }),
        libmpvSharedResize: async () => ({ ok:true }),
        libmpvSharedClose: async () => ({ ok:true })
      };
      true;
    `);
    await win.webContents.executeJavaScript(`${bundle}\n;true;`);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const video = document.createElement('lilac-mpv-video');
      document.querySelector('#playerView').append(video);
      let ended = 0;
      video.addEventListener('ended', () => ended++);
      await video.openLilacSource('https://example.invalid/test.m3u8', { hls:true });
      clearInterval(video._pollTimer); video._pollTimer = null;

      // stale EOF from generation 1 must not end generation 2.
      await video._pollState();
      const staleIgnored = ended === 0 && video.currentTime === 0;

      window.__state = { ...window.__state, generation:2, time:1, paused:false, eof:false };
      await video._pollState();
      const started = ended === 0 && video.currentTime === 1;

      window.__state = { ...window.__state, time:10, paused:true, eof:true };
      await video._pollState(); await video._pollState(); await video._pollState();
      const oneEdge = ended === 1;

      window.__state = { ...window.__state, time:2, paused:false, eof:false };
      await video._pollState();
      window.__state = { ...window.__state, time:10, paused:true, eof:true };
      await video._pollState();
      const secondEdge = ended === 2;

      return { staleIgnored, started, oneEdge, secondEdge, ended, generation: video._generation, time: video.currentTime };
    })()`);
    if (!result.staleIgnored || !result.started || !result.oneEdge || !result.secondEdge || result.generation !== 2) fail('behavior mismatch', result);
    else console.log(`LIBMPV_R2L_ENDED_EDGE_PASS ended=${result.ended} generation=${result.generation}`);
  } catch (error) {
    fail(String(error?.stack || error));
  } finally {
    win.destroy();
    try { fs.rmSync(fixturePath, { force: true }); } catch {}
    app.exit(failed ? 1 : 0);
  }
})().catch(error => { fail(String(error?.stack || error)); app.exit(1); });

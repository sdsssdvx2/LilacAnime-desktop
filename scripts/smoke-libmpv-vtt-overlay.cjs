'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const bundlePath = path.join(root, 'src', 'libmpv-shared.generated.js');
const fixturePath = path.join(os.tmpdir(), `lilac-r2j-vtt-smoke-${process.pid}.html`);
let failed = false;

function fail(message, details = null) {
  failed = true;
  console.error(`LIBMPV_R2J_VTT_OVERLAY_FAIL ${message}`);
  if (details) console.error(JSON.stringify(details, null, 2));
}

(async () => {
  await app.whenReady();
  if (!fs.existsSync(bundlePath)) throw new Error('generated shared renderer bundle missing');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  fs.writeFileSync(fixturePath, '<!doctype html><meta charset="utf-8"><style>html,body,#playerView{margin:0;width:100%;height:100%;background:#000} lilac-mpv-video{display:block;width:1280px;height:720px}</style><div id="playerView" class="active"></div>');
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  try {
    await win.loadFile(fixturePath);
    await win.webContents.executeJavaScript(`
      window.__testTime = 1.5;
      window.__commands = [];
      window.lilac = {
        libmpvSharedOpen: async () => ({ ok: true, playerId: 1, generation: 1 }),
        libmpvSharedCommand: async command => {
          const safe = Array.isArray(command) ? command.map(value => ['string','number','boolean'].includes(typeof value) || value == null ? value : String(value)) : [String(command)];
          window.__commands.push(safe);
          return { ok: true };
        },
        libmpvSharedState: async () => ({ active: true, generation: 1, fileLoaded: true, time: window.__testTime, duration: 10, width: 1920, height: 1080, paused: false, eof: false, metrics: { sentFrames: 12 } }),
        libmpvSharedResize: async () => ({ ok: true }),
        libmpvSharedClose: async () => ({ ok: true })
      };
      true;
    `);
    await win.webContents.executeJavaScript(`${bundle}\n;true;`);
    const result = await win.webContents.executeJavaScript(`(async () => {
      localStorage.clear();
      localStorage.setItem('subtitleSize', '100');
      localStorage.setItem('vttOutline', '2');
      localStorage.setItem('vttBold', 'true');
      localStorage.setItem('subtitlePosition', '12');
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
      const showing = { display: String(layer.style.display || ''), text: String(stack.textContent || '').trim(), cueCount: Number(video.textTracks[0]?.cues?.length || 0), mode: String(video.textTracks[0]?.mode || '') };
      const computedBottom = String(getComputedStyle(stack).bottom || '');
      video.textTracks[0].mode = 'hidden'; video.refreshSubtitleOverlay(); const hiddenDisplay = String(layer.style.display || '');
      video.textTracks[0].mode = 'showing'; window.__testTime = 4.5; await new Promise(resolve => setTimeout(resolve, 350)); const afterCueDisplay = String(layer.style.display || '');
      window.__testTime = 1.5; await new Promise(resolve => setTimeout(resolve, 350)); const restored = { display: String(layer.style.display || ''), text: String(stack.textContent || '').trim() };
      const badNativeSub = Boolean(window.__commands.some(command => Array.isArray(command) && command[0] === 'sub-add'));
      return { showing, hiddenDisplay, afterCueDisplay, restored, badNativeSub, commandCount: Number(window.__commands.length), computedBottom };
    })()`);
    const ok = result.showing.display === 'block' && result.showing.mode === 'showing' && result.showing.cueCount === 1 && result.showing.text.includes('안녕하세요') && result.showing.text.includes('R2J') && result.hiddenDisplay === 'none' && result.afterCueDisplay === 'none' && result.restored.display === 'block' && result.restored.text.includes('안녕하세요') && result.badNativeSub === false;
    if (!ok) fail('overlay behavior mismatch', result); else console.log(`LIBMPV_R2J_VTT_OVERLAY_PASS visible=1 hidden=1 expired=1 restored=1 nativeSubAdd=0 commands=${result.commandCount} bottom=${result.computedBottom}`);
  } catch (error) { fail(String(error?.stack || error)); }
  finally { win.destroy(); try { fs.rmSync(fixturePath, { force: true }); } catch {} app.exit(failed ? 1 : 0); }
})().catch(error => { fail(String(error?.stack || error)); try { fs.rmSync(fixturePath, { force: true }); } catch {} app.exit(1); });

'use strict';

const { ipcRenderer, sharedTexture } = require('electron');

const canvas = document.querySelector('#videoCanvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const clickTarget = document.querySelector('#clickTarget');
const resultBox = document.querySelector('#resultBox');
const status = document.querySelector('#status');
let receivedCount = 0;

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function sampleCenter() {
  const p = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
  return { r: p[0], g: p[1], b: p[2], a: p[3] };
}

clickTarget.addEventListener('click', () => {
  clickTarget.textContent = 'OS CLICK OK';
  ipcRenderer.send('probe-os-click', { clicked: true, at: Date.now() });
});

ipcRenderer.on('probe-result', (_event, result) => {
  status.textContent = result?.verdict || 'DONE';
  resultBox.textContent = JSON.stringify(result, null, 2);
});

try {
  if (!sharedTexture || typeof sharedTexture.setSharedTextureReceiver !== 'function') {
    throw new Error('renderer sharedTexture receiver API missing');
  }

  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, meta = {}) => {
    const label = String(meta?.label || 'unknown');
    const started = performance.now();
    let frame;
    try {
      frame = importedSharedTexture.getVideoFrame();
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);

      // Canvas2D GPU work is asynchronous. Keep both VideoFrame and imported texture
      // alive until Chromium has crossed several compositor turns and a forced readback.
      await nextFrame();
      await nextFrame();
      await nextFrame();
      await sleep(24);
      const sample = sampleCenter();
      receivedCount += 1;

      status.textContent = `GPU frame ${receivedCount}: ${label}`;
      ipcRenderer.send('probe-frame-drawn', {
        label,
        ok: true,
        sample,
        receivedCount,
        renderMs: Math.round((performance.now() - started) * 10) / 10
      });
    } catch (error) {
      ipcRenderer.send('probe-frame-drawn', {
        label,
        ok: false,
        receivedCount,
        error: String(error?.message || error)
      });
    } finally {
      try { frame?.close?.(); } catch {}
      try { importedSharedTexture?.release?.(); } catch {}
    }
  });

  const ready = { ready: true };
  ipcRenderer.send('probe-ready', ready);
  setTimeout(() => ipcRenderer.send('probe-ready', ready), 350);
  setTimeout(() => ipcRenderer.send('probe-ready', ready), 900);
} catch (error) {
  status.textContent = String(error?.message || error);
  const failed = { ready: false, error: String(error?.message || error) };
  ipcRenderer.send('probe-ready', failed);
  setTimeout(() => ipcRenderer.send('probe-ready', failed), 350);
}

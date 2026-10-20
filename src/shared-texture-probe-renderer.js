'use strict';

const { ipcRenderer, sharedTexture } = require('electron');

const canvas = document.querySelector('#videoCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const clickTarget = document.querySelector('#clickTarget');
const resultBox = document.querySelector('#resultBox');
const status = document.querySelector('#status');

clickTarget.addEventListener('click', () => {
  clickTarget.textContent = 'OS CLICK OK';
  ipcRenderer.send('probe-os-click', { clicked: true });
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
    try {
      const frame = importedSharedTexture.getVideoFrame();
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      importedSharedTexture.release();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      status.textContent = `GPU frame: ${label}`;
      ipcRenderer.send('probe-frame-drawn', { label, ok: true });
    } catch (error) {
      try { importedSharedTexture?.release?.(); } catch {}
      status.textContent = `frame error: ${String(error?.message || error)}`;
      ipcRenderer.send('probe-frame-drawn', { label, ok: false, error: String(error?.message || error) });
    }
  });
  ipcRenderer.send('probe-ready', { ready: true });
} catch (error) {
  status.textContent = String(error?.message || error);
  ipcRenderer.send('probe-ready', { ready: false, error: String(error?.message || error) });
}

'use strict';

const { ipcRenderer, sharedTexture } = require('electron');

const contextCache = new WeakMap();
let receivedFrames = 0;
let presentedFrames = 0;
let droppedNoSurface = 0;
let drawFailures = 0;
let lastFrameAt = 0;

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

function findSurface() {
  const host = document.querySelector('lilac-mpv-video');
  if (!host) return { host: null, canvas: null };
  const canvas = host.shadowRoot?.querySelector('canvas[data-lilac-libmpv-surface]') || null;
  return { host, canvas };
}

function contextFor(canvas) {
  let context = contextCache.get(canvas);
  if (!context) {
    context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (context) contextCache.set(canvas, context);
  }
  return context;
}

function sendStats(extra = {}) {
  try {
    ipcRenderer.send('libmpv-shared:receiver-stats', {
      receivedFrames,
      presentedFrames,
      droppedNoSurface,
      drawFailures,
      lastFrameAt,
      ...extra
    });
  } catch {}
}

try {
  if (!sharedTexture || typeof sharedTexture.setSharedTextureReceiver !== 'function') {
    throw new Error('Electron sharedTexture receiver API is unavailable');
  }

  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata = {}) => {
    receivedFrames += 1;
    lastFrameAt = Date.now();
    let frame = null;
    try {
      if (metadata?.kind !== 'lilac-libmpv-frame') return;
      const { host, canvas } = findSurface();
      const expectedPlayerId = Number(host?.dataset?.libmpvPlayerId || 0);
      if (!host || !canvas || (expectedPlayerId && expectedPlayerId !== Number(metadata.playerId))) {
        droppedNoSurface += 1;
        sendStats({ lastFrameId: Number(metadata.frameId) || 0, reason: 'surface-unavailable' });
        return;
      }

      const width = Math.max(2, Math.min(3840, Math.round(Number(metadata.width) || 0)));
      const height = Math.max(2, Math.min(2160, Math.round(Number(metadata.height) || 0)));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      const context = contextFor(canvas);
      if (!context) throw new Error('2D canvas context unavailable');
      frame = importedSharedTexture.getVideoFrame();
      context.drawImage(frame, 0, 0, width, height);

      // Keep the VideoFrame and imported shared texture alive across compositor
      // turns. The local v3 probe proved that releasing immediately can leave a
      // stale first frame on Windows; two turns keeps the normal 24/30/60fps
      // path below the three-slot producer lifetime budget without a CPU readback.
      await nextFrame();
      await nextFrame();
      presentedFrames += 1;
      sendStats({
        lastFrameId: Number(metadata.frameId) || 0,
        playerId: Number(metadata.playerId) || 0,
        width,
        height,
        reason: 'presented'
      });
    } catch (error) {
      drawFailures += 1;
      sendStats({
        lastFrameId: Number(metadata?.frameId) || 0,
        reason: 'draw-failed',
        error: String(error?.message || error).slice(0, 160)
      });
    } finally {
      try { frame?.close?.(); } catch {}
      try { importedSharedTexture?.release?.(); } catch {}
    }
  });

  ipcRenderer.send('libmpv-shared:receiver-ready', { ok: true });
} catch (error) {
  ipcRenderer.send('libmpv-shared:receiver-ready', {
    ok: false,
    error: String(error?.message || error).slice(0, 180)
  });
}

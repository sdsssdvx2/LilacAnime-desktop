'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sharedTexture } = require('electron');
const { createMpvRelay } = require('./mpv-relay.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createLibmpvSharedBridge({ app, ipcMain, headersFor = () => ({}), userAgent = '' }) {
  const relay = createMpvRelay();
  let attachedWindow = null;
  let addon = null;
  let playerId = null;
  let active = false;
  let disposed = false;
  let pumpTimer = null;
  let pumpRunning = false;
  let route = 'idle';
  let targetWidth = 1280;
  let targetHeight = 720;
  let generation = 0;
  let pendingFrames = new Map();
  let listenersInstalled = false;
  let lastState = null;
  let lastError = null;
  let receiverReady = { ok: false, at: 0, error: null };
  let receiverStats = {
    receivedFrames: 0,
    presentedFrames: 0,
    droppedNoSurface: 0,
    drawFailures: 0,
    lastFrameAt: 0,
    lastFrameId: 0,
    playerId: 0,
    width: 0,
    height: 0,
    reason: null,
    error: null,
    updatedAt: 0
  };

  const metrics = {
    pumpTicks: 0,
    nativeFrames: 0,
    sentFrames: 0,
    importFailures: 0,
    sendFailures: 0,
    receiverReleases: 0,
    backpressure: 0,
    lastFrameAt: 0,
    lastReleaseAt: 0,
    lastFrameId: 0,
    maxPending: 0
  };

  function unpackedPath(name) {
    if (app.isPackaged) return path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', name);
    return path.join(__dirname, name);
  }

  function ensureAddon() {
    if (addon) return addon;
    const addonFile = unpackedPath('lilac-libmpv-player-bridge.node');
    const dllFile = unpackedPath('libmpv-2.dll');
    if (!fs.existsSync(addonFile)) throw new Error('libmpv player bridge addon is unavailable');
    if (!fs.existsSync(dllFile)) throw new Error('libmpv runtime is unavailable');
    process.env.LILAC_LIBMPV_DLL = dllFile;
    addon = require(addonFile);
    for (const name of ['createPlayer', 'open', 'command', 'poll', 'renderFrame', 'releaseFrame', 'destroyPlayer']) {
      if (typeof addon?.[name] !== 'function') throw new Error(`libmpv player bridge export missing: ${name}`);
    }
    if (!sharedTexture || typeof sharedTexture.importSharedTexture !== 'function' || typeof sharedTexture.sendSharedTexture !== 'function') {
      throw new Error('Electron sharedTexture API is unavailable');
    }
    return addon;
  }

  function clampSize(value, fallback, max) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(2, Math.min(max, n)) : fallback;
  }

  function setTargetSize(value = {}) {
    targetWidth = clampSize(value.width, targetWidth, 3840);
    targetHeight = clampSize(value.height, targetHeight, 2160);
    return { width: targetWidth, height: targetHeight };
  }

  function isLoopback(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  function isFile(value) {
    try { return new URL(value).protocol === 'file:'; } catch { return false; }
  }

  function safeRouteSource(value) {
    try {
      const url = new URL(value);
      if (isLoopback(value)) return '[local-media]';
      return `${url.protocol}//${url.hostname}/[redacted]`;
    } catch {
      return '[media]';
    }
  }

  function pendingKey(ownerPlayerId, slotId, frameId) {
    return `${ownerPlayerId}:${slotId}:${frameId}`;
  }

  function releaseNativeFrame(ownerPlayerId, slotId, frameId) {
    const key = pendingKey(ownerPlayerId, slotId, frameId);
    if (!pendingFrames.has(key)) return;
    pendingFrames.delete(key);
    metrics.receiverReleases += 1;
    metrics.lastReleaseAt = Date.now();
    try { addon?.releaseFrame(ownerPlayerId, slotId, frameId); } catch {}
  }

  function schedulePump(delay = 0) {
    if (!active || disposed || pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      void pump();
    }, Math.max(0, delay));
  }

  async function pump() {
    if (pumpRunning || !active || disposed || !addon || playerId == null) return;
    if (!attachedWindow || attachedWindow.isDestroyed() || attachedWindow.webContents.isDestroyed()) return;
    pumpRunning = true;
    const ownerPlayerId = playerId;
    const ownerGeneration = generation;
    try {
      metrics.pumpTicks += 1;
      const nativeFrame = addon.renderFrame(ownerPlayerId, targetWidth, targetHeight);
      if (nativeFrame?.backpressure) metrics.backpressure += 1;
      if (!nativeFrame?.updated) return;
      metrics.nativeFrames += 1;
      metrics.lastFrameAt = Date.now();
      metrics.lastFrameId = Number(nativeFrame.frameId) || metrics.lastFrameId;

      const slotId = Number(nativeFrame.slotId);
      const frameId = Number(nativeFrame.frameId);
      const key = pendingKey(ownerPlayerId, slotId, frameId);
      pendingFrames.set(key, { playerId: ownerPlayerId, slotId, frameId, at: Date.now() });
      metrics.maxPending = Math.max(metrics.maxPending, pendingFrames.size);

      let imported = null;
      try {
        imported = sharedTexture.importSharedTexture({
          textureInfo: {
            id: key,
            pixelFormat: 'bgra',
            codedSize: { width: Number(nativeFrame.width), height: Number(nativeFrame.height) },
            visibleRect: { x: 0, y: 0, width: Number(nativeFrame.width), height: Number(nativeFrame.height) },
            contentRect: { x: 0, y: 0, width: Number(nativeFrame.width), height: Number(nativeFrame.height) },
            timestamp: Number(nativeFrame.timestampUs) || Date.now() * 1000,
            colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
            handle: { ntHandle: nativeFrame.ntHandle }
          },
          allReferencesReleased() {
            releaseNativeFrame(ownerPlayerId, slotId, frameId);
          }
        });
      } catch (error) {
        metrics.importFailures += 1;
        lastError = `shared texture import failed: ${String(error?.message || error).slice(0, 180)}`;
        releaseNativeFrame(ownerPlayerId, slotId, frameId);
        return;
      }

      try {
        if (!active || ownerGeneration !== generation || ownerPlayerId !== playerId || !attachedWindow || attachedWindow.isDestroyed()) return;
        await sharedTexture.sendSharedTexture({
          frame: attachedWindow.webContents.mainFrame,
          importedSharedTexture: imported
        }, {
          kind: 'lilac-libmpv-frame',
          playerId: ownerPlayerId,
          generation: ownerGeneration,
          slotId,
          frameId,
          width: Number(nativeFrame.width),
          height: Number(nativeFrame.height),
          timestampUs: Number(nativeFrame.timestampUs) || 0
        });
        metrics.sentFrames += 1;
      } catch (error) {
        metrics.sendFailures += 1;
        lastError = `shared texture send failed: ${String(error?.message || error).slice(0, 180)}`;
      } finally {
        try { imported?.release?.(); } catch {}
      }
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 220);
    } finally {
      pumpRunning = false;
      if (active && !disposed) schedulePump(5);
    }
  }

  async function prepareSource(url, suppliedHeaders = {}, hls = false) {
    const raw = String(url || '');
    if (!raw) throw new Error('media source is empty');
    if (isLoopback(raw)) {
      route = 'local-bypass';
      return raw;
    }
    if (isFile(raw)) {
      route = 'file';
      return raw;
    }
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') throw new Error(`unsupported media protocol: ${parsed.protocol}`);
    const merged = headersFor(parsed, suppliedHeaders || {});
    const prepared = await relay.prepare(raw, merged, { hls: Boolean(hls), userAgent });
    route = prepared?.relayed ? 'relay' : 'direct';
    return prepared.url;
  }

  function ensurePlayer() {
    ensureAddon();
    if (playerId != null) return playerId;
    const created = addon.createPlayer();
    playerId = Number(created.playerId);
    if (!Number.isInteger(playerId) || playerId <= 0) throw new Error('libmpv player creation failed');
    return playerId;
  }

  async function open(url, suppliedHeaders = {}, hls = false, size = {}) {
    if (disposed) throw new Error('libmpv bridge disposed');
    ensureAddon();
    setTargetSize(size);
    const currentPlayerId = ensurePlayer();
    const preparedUrl = await prepareSource(url, suppliedHeaders, hls);
    generation += 1;
    lastError = null;
    lastState = null;
    addon.open(currentPlayerId, preparedUrl);
    active = true;
    schedulePump(0);
    return {
      ok: true,
      active: true,
      playerId: currentPlayerId,
      generation,
      route,
      source: safeRouteSource(preparedUrl),
      width: targetWidth,
      height: targetHeight
    };
  }

  function command(value) {
    if (!active || playerId == null || !addon) return { ok: false, error: 'inactive' };
    if (!Array.isArray(value) || !value.length) return { ok: false, error: 'invalid-command' };
    const commandArray = value.slice(0, 32).map(item => String(item));
    addon.command(playerId, commandArray);
    return { ok: true };
  }

  function state() {
    if (!active || playerId == null || !addon) {
      return {
        active: false,
        route,
        metrics: { ...metrics },
        receiverReady: { ...receiverReady },
        receiver: { ...receiverStats },
        lastError
      };
    }
    try {
      lastState = addon.poll(playerId);
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 220);
    }
    return {
      active: true,
      playerId,
      generation,
      route,
      target: { width: targetWidth, height: targetHeight },
      pendingFrames: pendingFrames.size,
      metrics: { ...metrics },
      receiverReady: { ...receiverReady },
      receiver: { ...receiverStats },
      lastError,
      ...(lastState || {})
    };
  }

  function resize(value = {}) {
    const size = setTargetSize(value);
    return { ok: true, ...size };
  }

  async function stopPlayer({ destroy = false } = {}) {
    active = false;
    generation += 1;
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimer = null;
    if (playerId != null && addon) {
      try { addon.command(playerId, ['stop']); } catch {}
    }
    const closingPlayerId = playerId;
    if (destroy && closingPlayerId != null && addon) {
      const deadline = Date.now() + 1200;
      while ([...pendingFrames.values()].some(item => item.playerId === closingPlayerId) && Date.now() < deadline) await sleep(20);
      if (![...pendingFrames.values()].some(item => item.playerId === closingPlayerId)) {
        try { addon.destroyPlayer(closingPlayerId); } catch {}
        if (playerId === closingPlayerId) playerId = null;
      }
    }
    route = 'idle';
    return { ok: true };
  }

  async function close() {
    return stopPlayer({ destroy: false });
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    await stopPlayer({ destroy: true });
    try { await relay.close(); } catch {}
    pendingFrames.clear();
    attachedWindow = null;
  }

  function senderIsAttached(event) {
    return Boolean(attachedWindow && !attachedWindow.isDestroyed() && event?.sender?.id === attachedWindow.webContents.id);
  }

  function installListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;
    ipcMain.handle('libmpv-shared:open', (_event, url, headers = {}, hls = false, size = {}) => open(url, headers, hls, size));
    ipcMain.handle('libmpv-shared:command', (_event, value) => command(value));
    ipcMain.handle('libmpv-shared:state', () => state());
    ipcMain.handle('libmpv-shared:resize', (_event, value) => resize(value));
    ipcMain.handle('libmpv-shared:close', () => close());
    ipcMain.handle('libmpv-shared:diagnostics', () => ({
      diagnosticVersion: 'LIBMPV-SHARED-D1',
      ...state(),
      receiverReady: { ...receiverReady },
      receiver: { ...receiverStats },
      relay: relay.stats()
    }));

    ipcMain.on('libmpv-shared:receiver-ready', (event, payload = {}) => {
      if (!senderIsAttached(event)) return;
      receiverReady = {
        ok: payload?.ok === true,
        at: Date.now(),
        error: payload?.error ? String(payload.error).slice(0, 180) : null
      };
    });

    ipcMain.on('libmpv-shared:receiver-stats', (event, payload = {}) => {
      if (!senderIsAttached(event)) return;
      const numeric = key => {
        const value = Number(payload?.[key]);
        return Number.isFinite(value) ? value : 0;
      };
      receiverStats = {
        receivedFrames: numeric('receivedFrames'),
        presentedFrames: numeric('presentedFrames'),
        droppedNoSurface: numeric('droppedNoSurface'),
        drawFailures: numeric('drawFailures'),
        lastFrameAt: numeric('lastFrameAt'),
        lastFrameId: numeric('lastFrameId'),
        playerId: numeric('playerId'),
        width: numeric('width'),
        height: numeric('height'),
        reason: payload?.reason ? String(payload.reason).slice(0, 80) : null,
        error: payload?.error ? String(payload.error).slice(0, 180) : null,
        updatedAt: Date.now()
      };
    });
  }

  async function ensure() {
    ensureAddon();
    installListeners();
    return { ok: true };
  }

  async function attachWindow(win) {
    attachedWindow = win;
    receiverReady = { ok: false, at: 0, error: null };
    receiverStats = {
      receivedFrames: 0,
      presentedFrames: 0,
      droppedNoSurface: 0,
      drawFailures: 0,
      lastFrameAt: 0,
      lastFrameId: 0,
      playerId: 0,
      width: 0,
      height: 0,
      reason: null,
      error: null,
      updatedAt: 0
    };
    installListeners();
    win.once('closed', () => {
      if (attachedWindow === win) attachedWindow = null;
      active = false;
      if (pumpTimer) clearTimeout(pumpTimer);
      pumpTimer = null;
    });
    return { ok: true };
  }

  return { ensure, attachWindow, open, command, state, resize, close, dispose };
}

module.exports = { createLibmpvSharedBridge };

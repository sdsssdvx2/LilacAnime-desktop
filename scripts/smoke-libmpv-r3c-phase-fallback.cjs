'use strict';

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const realSetTimeout = global.setTimeout;
const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));
const SOURCE_FPS = 23.976024;
const SOURCE_PERIOD_MS = 1000 / SOURCE_FPS;

async function main() {
  const originalLoad = Module._load;
  const originalExistsSync = fs.existsSync;
  const originalSetTimeout = global.setTimeout;
  let sourceEpochMs = Date.now();
  let lastDeliveredSourceIndex = -1;
  let nextFrameId = 1;
  let callbackInstalled = false;
  const inFlight = new Map();
  const scheduledDelays = [];
  let releases = 0;

  const playbackState = () => ({
    fileLoaded: true, eof: false, lastError: null,
    renderedFrames: nextFrameId - 1, backpressureDrops: 0,
    textureSlotCount: 24, textureSlotsInFlight: inFlight.size,
    time: Math.max(0, (Date.now() - sourceEpochMs) / 1000), duration: 30,
    fps: SOURCE_FPS, estimatedVfFps: SOURCE_FPS,
    width: 1920, height: 1080, paused: false, pausedForCache: false,
    aid: '1', vid: '1'
  });

  const fakeAddon = {
    createPlayer() { return { playerId: 1, deviceMode: 'simulated', featureLevel: 'simulated' }; },
    setUpdateCallback(_playerId, callback) {
      if (typeof callback !== 'function') throw new Error('callback required');
      callbackInstalled = true;
      // Intentionally silent: the phase-aware timer must independently retain cadence.
      return true;
    },
    open() {}, command() { return { ok: true }; }, poll: playbackState, pollPlayback: playbackState,
    renderFrame() {
      const now = Date.now();
      if (inFlight.size >= 24) return { updated: false, backpressure: true };
      const sourceIndex = Math.floor((now - sourceEpochMs) / SOURCE_PERIOD_MS);
      if (sourceIndex < 0 || sourceIndex <= lastDeliveredSourceIndex) return { updated: false, backpressure: false };
      lastDeliveredSourceIndex = sourceIndex;
      const frameId = nextFrameId++;
      const slotId = frameId % 24;
      inFlight.set(`${slotId}:${frameId}`, true);
      return { updated: true, backpressure: false, slotId, frameId, width: 1920, height: 1080,
        timestampUs: Math.round((sourceEpochMs + sourceIndex * SOURCE_PERIOD_MS) * 1000), ntHandle: Buffer.alloc(8) };
    },
    releaseFrame(_playerId, slotId, frameId) {
      inFlight.delete(`${slotId}:${frameId}`); releases += 1; return true;
    },
    destroyPlayer() {}
  };

  const fakeSharedTexture = {
    importSharedTexture({ allReferencesReleased }) {
      let released = false;
      return { release() { if (released) return; released = true; realSetTimeout(() => allReferencesReleased?.(), 1); } };
    },
    sendSharedTexture() { return Promise.resolve(); }
  };

  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { sharedTexture: fakeSharedTexture };
    if (String(request).endsWith(`${path.sep}lilac-libmpv-player-bridge.node`)) return fakeAddon;
    return originalLoad.call(this, request, parent, isMain);
  };
  fs.existsSync = function(candidate) {
    const value = String(candidate || '');
    if (value.endsWith(`${path.sep}lilac-libmpv-player-bridge.node`) || value.endsWith(`${path.sep}libmpv-2.dll`)) return true;
    return originalExistsSync.call(fs, candidate);
  };
  global.setTimeout = function(fn, delay, ...args) {
    scheduledDelays.push(Number(delay) || 0);
    return originalSetTimeout(fn, delay, ...args);
  };

  const ipcMain = { handle() {}, on() {} };
  const app = { isPackaged: false };
  const fakeWindow = { isDestroyed: () => false, once() {}, getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    webContents: { id: 7, isDestroyed: () => false, mainFrame: { routingId: 1 } } };

  let bridge;
  try {
    const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');
    bridge = createLibmpvSharedBridge({ app, ipcMain, headersFor: () => ({}), userAgent: 'R3C silent callback fallback' });
    await bridge.ensure(); await bridge.attachWindow(fakeWindow);
    sourceEpochMs = Date.now() + 20; lastDeliveredSourceIndex = -1;
    await bridge.open('file:///simulated.mp4', {}, false, { width: 1920, height: 1080 });
    await sleep(4400);

    const m = bridge.state().metrics || {};
    const nativeFrames = Number(m.nativeFrames || 0);
    const sentFrames = Number(m.sentFrames || 0);
    const nativeFps = Number(m.nativeCadence?.actualPresentedFps || 0);
    const delay250 = scheduledDelays.filter(v => v >= 240 && v <= 260).length;
    const near2 = scheduledDelays.filter(v => v === 2).length;
    const coarse = scheduledDelays.filter(v => v >= 3 && v <= 36).length;
    const report = { callbackInstalled, callbackSignals: Number(m.nativeUpdateSignals || 0), nativeFrames, sentFrames,
      nativeFps, delay250, near2, coarse, pumpTicks: Number(m.pumpTicks || 0), maxPending: Number(m.maxPending || 0),
      backpressureRatio: Number(m.backpressureRatio || 0), releases };
    console.log(`LIBMPV_R3C_PHASE_FALLBACK_REPORT=${JSON.stringify(report)}`);

    if (!callbackInstalled) throw new Error('callback not installed');
    if (Number(m.nativeUpdateSignals || 0) !== 0) throw new Error('silent callback unexpectedly signalled');
    if (nativeFrames < 101) throw new Error(`phase timer lost cadence: ${nativeFrames}`);
    if (sentFrames < nativeFrames - 3) throw new Error(`delivery lagged: native=${nativeFrames} sent=${sentFrames}`);
    if (nativeFps && nativeFps < 22.8) throw new Error(`fallback cadence too low: ${nativeFps}`);
    if (delay250 !== 0) throw new Error(`250ms callback watchdog survived: ${delay250}`);
    if (near2 < 5 || coarse < 50) throw new Error(`phase paths not exercised: near2=${near2} coarse=${coarse}`);
    if (Number(m.backpressureRatio || 0) > 0.01 || Number(m.maxPending || 0) > 4) throw new Error('fallback pipeline pressure exceeded');
    if (releases < sentFrames - 3) throw new Error(`releases lagged: ${releases}/${sentFrames}`);
    console.log('LIBMPV_R3C_PHASE_FALLBACK_OK callback=silent timer=absolute-source-deadline cadence=retained');
  } finally {
    try { await bridge?.dispose?.(); } catch {}
    global.setTimeout = originalSetTimeout; fs.existsSync = originalExistsSync; Module._load = originalLoad;
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

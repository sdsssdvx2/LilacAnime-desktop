'use strict';

const Module = require('node:module');
const path = require('node:path');

const realSetTimeout = global.setTimeout;
const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));

async function main() {
  const originalLoad = Module._load;
  const originalSetTimeout = global.setTimeout;
  let nextFrameId = 1;
  let lastProducedAt = 0;
  const inFlight = new Map();
  const scheduledDelays = [];
  let receiverReleases = 0;
  let startedAt = Date.now();

  const fakeAddon = {
    createPlayer() { return { playerId: 1, deviceMode: 'simulated', featureLevel: 'simulated' }; },
    open() {},
    command() { return { ok: true }; },
    poll() {
      return {
        fileLoaded: true,
        eof: false,
        lastError: null,
        renderedFrames: nextFrameId - 1,
        backpressureDrops: 0,
        textureSlotCount: 24,
        textureSlotsInFlight: inFlight.size,
        time: (Date.now() - startedAt) / 1000,
        duration: 30,
        fps: 24,
        width: 1920,
        height: 1080,
        paused: false,
        aid: '1',
        vid: '1',
        tracks: [{ type: 'video', codec: 'h264', selected: true }, { type: 'audio', codec: 'aac', selected: true }]
      };
    },
    renderFrame() {
      const now = Date.now();
      if (inFlight.size >= 24) return { updated: false, backpressure: true };
      if (now - lastProducedAt < 40) return { updated: false, backpressure: false };
      lastProducedAt = now;
      const frameId = nextFrameId++;
      const slotId = frameId % 24;
      inFlight.set(`${slotId}:${frameId}`, true);
      return { updated: true, backpressure: false, slotId, frameId, width: 1920, height: 1080, timestampUs: now * 1000, ntHandle: Buffer.alloc(8) };
    },
    releaseFrame(_playerId, slotId, frameId) {
      inFlight.delete(`${slotId}:${frameId}`);
      receiverReleases += 1;
      return true;
    },
    destroyPlayer() {}
  };

  const fakeSharedTexture = {
    importSharedTexture({ allReferencesReleased }) {
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          realSetTimeout(() => allReferencesReleased?.(), 1);
        }
      };
    },
    async sendSharedTexture() {}
  };

  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { sharedTexture: fakeSharedTexture };
    if (String(request).endsWith(`${path.sep}lilac-libmpv-player-bridge.node`)) return fakeAddon;
    return originalLoad.call(this, request, parent, isMain);
  };

  const ipcMain = { handle() {}, on() {} };
  const app = { isPackaged: false };
  const fakeWindow = {
    isDestroyed: () => false,
    once() {},
    webContents: { id: 7, isDestroyed: () => false, mainFrame: { routingId: 1 } }
  };

  let bridge;
  try {
    const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');
    global.setTimeout = function(fn, delay, ...args) {
      scheduledDelays.push(Number(delay) || 0);
      return originalSetTimeout(fn, delay, ...args);
    };
    startedAt = Date.now();
    bridge = createLibmpvSharedBridge({ app, ipcMain, headersFor: () => ({}), userAgent: 'R2Y pump simulation' });
    await bridge.ensure();
    await bridge.attachWindow(fakeWindow);
    await bridge.open('file:///simulated.mp4', {}, false, { width: 1920, height: 1080 });
    await sleep(3200);

    const state = bridge.state();
    const metrics = state.metrics || {};
    const sent = Number(metrics.sentFrames || 0);
    const pumps = Number(metrics.pumpTicks || 0);
    const fps = Number(metrics.effectiveSentFps || 0);
    const delay2 = scheduledDelays.filter(v => v === 2).length;
    const coarse = scheduledDelays.filter(v => v >= 24 && v <= 36).length;
    const delay16 = scheduledDelays.filter(v => v === 16).length;
    const delay100 = scheduledDelays.filter(v => v === 100).length;
    const immediate = scheduledDelays.filter(v => v === 0).length;

    if (sent < 65) throw new Error(`adaptive pump undersent frames: ${sent}`);
    if (fps < 21.5 || fps > 27) throw new Error(`adaptive pump effective FPS outside expected band: ${fps}`);
    if (pumps < sent || pumps > sent * 8) throw new Error(`adaptive pump tick count unreasonable: pumps=${pumps} sent=${sent}`);
    if (delay2 < 20) throw new Error(`near-boundary 2ms polling was not exercised: ${delay2}`);
    if (coarse < 20) throw new Error(`phase-aware coarse sleep was not exercised: ${coarse}`);
    if (delay16 !== 0) throw new Error(`legacy fixed 16ms pump survived: ${delay16}`);
    if (delay100 !== 0) throw new Error(`unexpected backpressure path exercised: ${delay100}`);
    if (immediate < 1) throw new Error('release-driven immediate wakeup missing');
    if (Number(metrics.backpressureRatio || 0) > 0.03) throw new Error(`backpressure too high: ${metrics.backpressureRatio}`);
    if (Number(metrics.maxPending || 0) > 3) throw new Error(`too many pending frames: ${metrics.maxPending}`);
    if (receiverReleases < sent - 2) throw new Error(`release count lagged sent frames: releases=${receiverReleases} sent=${sent}`);

    console.log(`LIBMPV_R2Y_PUMP_SIM_REPORT=${JSON.stringify({sentFrames:sent,pumpTicks:pumps,effectiveSentFps:fps,scheduler:{delay2,coarse,delay16,delay100,immediate,total:scheduledDelays.length},receiverReleases})}`);
    console.log('LIBMPV_R2Y_PUMP_SIM_OK');
  } finally {
    try { await bridge?.dispose?.(); } catch {}
    global.setTimeout = originalSetTimeout;
    Module._load = originalLoad;
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

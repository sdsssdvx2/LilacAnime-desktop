'use strict';

const Module = require('node:module');
const path = require('node:path');

const realSetTimeout = global.setTimeout;
const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));

async function main() {
  const originalLoad = Module._load;
  let nextFrameId = 1;
  let lastProducedAt = 0;
  let startedAt = Date.now();
  const inFlight = new Map();
  const sendOrder = [];
  let activeSends = 0;
  let maxActiveSends = 0;
  let releases = 0;

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
        fps: 23.976024,
        estimatedVfFps: 23.976024,
        width: 1920,
        height: 1080,
        paused: false,
        pausedForCache: false,
        aid: '1',
        vid: '1'
      };
    },
    renderFrame() {
      const now = Date.now();
      if (inFlight.size >= 24) return { updated: false, backpressure: true };
      if (now - lastProducedAt < 41) return { updated: false, backpressure: false };
      lastProducedAt = now;
      const frameId = nextFrameId++;
      const slotId = frameId % 24;
      inFlight.set(`${slotId}:${frameId}`, true);
      return {
        updated: true,
        backpressure: false,
        slotId,
        frameId,
        width: 1920,
        height: 1080,
        timestampUs: now * 1000,
        ntHandle: Buffer.alloc(8)
      };
    },
    releaseFrame(_playerId, slotId, frameId) {
      inFlight.delete(`${slotId}:${frameId}`);
      releases += 1;
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
          realSetTimeout(() => allReferencesReleased?.(), 45);
        }
      };
    },
    sendSharedTexture(_frame, metadata = {}) {
      const frameId = Number(metadata.frameId) || 0;
      sendOrder.push(frameId);
      activeSends += 1;
      maxActiveSends = Math.max(maxActiveSends, activeSends);
      // Model the real user's occasional 60-100ms Electron transport waits.
      // A producer that awaits these waits will undersample a 23.976fps source.
      const delay = frameId % 24 === 0 ? 105 : (frameId % 6 === 0 ? 72 : 2);
      return new Promise(resolve => realSetTimeout(() => {
        activeSends -= 1;
        resolve();
      }, delay));
    }
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
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    webContents: { id: 7, isDestroyed: () => false, mainFrame: { routingId: 1 } }
  };

  let bridge;
  try {
    const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');
    bridge = createLibmpvSharedBridge({ app, ipcMain, headersFor: () => ({}), userAgent: 'R3A delayed-send stress' });
    await bridge.ensure();
    await bridge.attachWindow(fakeWindow);
    startedAt = Date.now();
    await bridge.open('file:///simulated.mp4', {}, false, { width: 1920, height: 1080 });
    await sleep(4300);
    await sleep(250);

    const state = bridge.state();
    const m = state.metrics || {};
    const nativeFrames = Number(m.nativeFrames || 0);
    const sentFrames = Number(m.sentFrames || 0);
    const nativeFps = Number(m.nativeCadence?.actualPresentedFps || 0);
    const ordered = sendOrder.every((id, i) => i === 0 || id > sendOrder[i - 1]);
    const report = {
      nativeFrames,
      sentFrames,
      nativeFps,
      sendSharedTextureMaxMs: Number(m.sendSharedTextureMaxMs || 0),
      avgSendSharedTextureMs: Number(m.avgSendSharedTextureMs || 0),
      sendInvokeMaxMs: Number(m.sendInvokeMaxMs || 0),
      deliveryMaxInFlight: Number(m.deliveryMaxInFlight || 0),
      deliveryInFlight: Number(m.deliveryInFlight || 0),
      maxPending: Number(m.maxPending || 0),
      backpressureRatio: Number(m.backpressureRatio || 0),
      pumpTimerLagMaxMs: Number(m.pumpTimerLagMaxMs || 0),
      pumpStatePollMaxMs: Number(m.pumpStatePollMaxMs || 0),
      pumpRenderMaxMs: Number(m.pumpRenderMaxMs || 0),
      maxActiveSends,
      releases,
      ordered
    };
    console.log(`LIBMPV_R3A_DECOUPLED_DELIVERY_REPORT=${JSON.stringify(report)}`);

    if (nativeFrames < 88) throw new Error(`producer stalled behind async delivery: nativeFrames=${nativeFrames}`);
    if (sentFrames < nativeFrames - 5) throw new Error(`delivery fell too far behind producer: native=${nativeFrames} sent=${sentFrames}`);
    if (nativeFps && nativeFps < 21.5) throw new Error(`native cadence too low under delayed sends: ${nativeFps}`);
    if (Number(m.sendSharedTextureMaxMs || 0) < 60) throw new Error('stress did not exercise delayed send promise');
    if (Number(m.deliveryMaxInFlight || 0) < 2 || maxActiveSends < 2) throw new Error('delivery did not overlap as designed');
    if (!ordered) throw new Error('shared texture send invocation order changed');
    if (Number(m.maxPending || 0) > 12) throw new Error(`pending safety bound exceeded: ${m.maxPending}`);
    if (Number(m.backpressureRatio || 0) > 0.01) throw new Error(`unexpected backpressure: ${m.backpressureRatio}`);
    if (releases < sentFrames - 5) throw new Error(`native releases lagged deliveries: releases=${releases} sent=${sentFrames}`);

    console.log('LIBMPV_R3A_DECOUPLED_DELIVERY_OK');
  } finally {
    try { await bridge?.dispose?.(); } catch {}
    Module._load = originalLoad;
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

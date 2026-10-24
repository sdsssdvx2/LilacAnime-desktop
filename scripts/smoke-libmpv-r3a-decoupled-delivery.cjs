'use strict';

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));
const SOURCE_FPS = 23.976024;
const SOURCE_PERIOD_MS = 1000 / SOURCE_FPS;

function busyWait(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}

async function main() {
  const originalLoad = Module._load;
  const originalExistsSync = fs.existsSync;
  let nextFrameId = 1;
  let sourceEpochMs = Date.now();
  let lastDeliveredSourceIndex = -1;
  let updateCallback = null;
  let sourceSignalTimer = null;
  let nextSourceSignalIndex = 1;
  const inFlight = new Map();
  const sendOrder = [];
  let activeSends = 0;
  let maxActiveSends = 0;
  let releases = 0;

  function armSourceSignal() {
    if (!updateCallback) return;
    const dueAt = sourceEpochMs + nextSourceSignalIndex * SOURCE_PERIOD_MS;
    const wait = Math.max(0, dueAt - Date.now());
    sourceSignalTimer = realSetTimeout(() => {
      sourceSignalTimer = null;
      nextSourceSignalIndex += 1;
      try { updateCallback?.(); } catch {}
      armSourceSignal();
    }, wait);
  }

  const playbackState = () => ({
    fileLoaded: true,
    eof: false,
    lastError: null,
    renderedFrames: nextFrameId - 1,
    backpressureDrops: 0,
    textureSlotCount: 24,
    textureSlotsInFlight: inFlight.size,
    time: Math.max(0, (Date.now() - sourceEpochMs) / 1000),
    duration: 30,
    fps: SOURCE_FPS,
    estimatedVfFps: SOURCE_FPS,
    width: 1920,
    height: 1080,
    paused: false,
    pausedForCache: false,
    aid: '1',
    vid: '1'
  });

  const fakeAddon = {
    createPlayer() { return { playerId: 1, deviceMode: 'simulated', featureLevel: 'simulated' }; },
    setUpdateCallback(_playerId, callback) {
      updateCallback = callback;
      nextSourceSignalIndex = Math.max(1, Math.floor((Date.now() - sourceEpochMs) / SOURCE_PERIOD_MS) + 1);
      realSetTimeout(() => { try { updateCallback?.(); } catch {} }, 0);
      armSourceSignal();
      return true;
    },
    open() {},
    command() { return { ok: true }; },
    poll: playbackState,
    pollPlayback: playbackState,
    renderFrame() {
      const now = Date.now();
      if (inFlight.size >= 24) return { updated: false, backpressure: true };
      const availableSourceIndex = Math.floor((now - sourceEpochMs) / SOURCE_PERIOD_MS);
      if (availableSourceIndex < 0 || availableSourceIndex <= lastDeliveredSourceIndex) {
        return { updated: false, backpressure: false };
      }
      lastDeliveredSourceIndex = availableSourceIndex;
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
        timestampUs: Math.round((sourceEpochMs + availableSourceIndex * SOURCE_PERIOD_MS) * 1000),
        ntHandle: Buffer.alloc(8)
      };
    },
    releaseFrame(_playerId, slotId, frameId) {
      inFlight.delete(`${slotId}:${frameId}`);
      releases += 1;
      return true;
    },
    destroyPlayer() {
      updateCallback = null;
      if (sourceSignalTimer) realClearTimeout(sourceSignalTimer);
      sourceSignalTimer = null;
    }
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

  fs.existsSync = function(candidate) {
    const value = String(candidate || '');
    if (value.endsWith(`${path.sep}lilac-libmpv-player-bridge.node`) || value.endsWith(`${path.sep}libmpv-2.dll`)) return true;
    return originalExistsSync.call(fs, candidate);
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
    bridge = createLibmpvSharedBridge({ app, ipcMain, headersFor: () => ({}), userAgent: 'R3C hybrid delayed-send stress' });
    await bridge.ensure();
    await bridge.attachWindow(fakeWindow);
    sourceEpochMs = Date.now() + 20;
    lastDeliveredSourceIndex = -1;
    nextSourceSignalIndex = 1;
    await bridge.open('file:///simulated.mp4', {}, false, { width: 1920, height: 1080 });

    realSetTimeout(() => busyWait(18), 900);
    realSetTimeout(() => busyWait(68), 2050);
    realSetTimeout(() => busyWait(20), 3300);

    await sleep(4400);

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
      nativeUpdateSignals: Number(m.nativeUpdateSignals || 0),
      nativeUpdateWakeups: Number(m.nativeUpdateWakeups || 0),
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
      pumpPhaseCatchupPeriods: Number(m.pumpPhaseCatchupPeriods || 0),
      pumpPhaseLateMaxMs: Number(m.pumpPhaseLateMaxMs || 0),
      maxActiveSends,
      releases,
      ordered
    };
    console.log(`LIBMPV_R3C_HYBRID_DELIVERY_REPORT=${JSON.stringify(report)}`);

    if (nativeFrames < 100) throw new Error(`hybrid producer lost too many source frames: ${nativeFrames}`);
    if (sentFrames < nativeFrames - 5) throw new Error(`delivery fell too far behind producer: native=${nativeFrames} sent=${sentFrames}`);
    if (nativeFps && nativeFps < 22.7) throw new Error(`native cadence too low under delayed sends/stalls: ${nativeFps}`);
    if (Number(m.nativeUpdateSignals || 0) < 80 || Number(m.nativeUpdateWakeups || 0) < 60) throw new Error(`native callback hint was not exercised: signals=${m.nativeUpdateSignals} wakes=${m.nativeUpdateWakeups}`);
    if (Number(m.sendSharedTextureMaxMs || 0) < 60) throw new Error('stress did not exercise delayed send promise');
    if (Number(m.deliveryMaxInFlight || 0) < 2 || maxActiveSends < 2) throw new Error('delivery did not overlap as designed');
    if (!ordered) throw new Error('shared texture send invocation order changed');
    if (Number(m.maxPending || 0) > 12) throw new Error(`pending safety bound exceeded: ${m.maxPending}`);
    if (Number(m.backpressureRatio || 0) > 0.01) throw new Error(`unexpected backpressure: ${m.backpressureRatio}`);
    if (releases < sentFrames - 5) throw new Error(`native releases lagged deliveries: releases=${releases} sent=${sentFrames}`);

    console.log('LIBMPV_R3C_HYBRID_DELIVERY_OK clock=phase-timer callback=wake-hint transport=async');
  } finally {
    try { await bridge?.dispose?.(); } catch {}
    if (sourceSignalTimer) realClearTimeout(sourceSignalTimer);
    fs.existsSync = originalExistsSync;
    Module._load = originalLoad;
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

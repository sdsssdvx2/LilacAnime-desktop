'use strict';

const Module = require('node:module');
const path = require('node:path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const originalLoad = Module._load;
  let nextFrameId = 1;
  let lastProducedAt = 0;
  const inFlight = new Map();
  const commandLog = [];
  let receiverReleases = 0;

  const fakeAddon = {
    createPlayer() { return { playerId: 1, deviceMode: 'simulated', featureLevel: 'simulated' }; },
    open() {},
    command(_playerId, args) {
      commandLog.push([...args]);
      return { ok: true };
    },
    poll() {
      return {
        fileLoaded: true,
        eof: false,
        lastError: null,
        renderedFrames: nextFrameId - 1,
        backpressureDrops: 0,
        time: (Date.now() - startedAt) / 1000,
        duration: 30,
        fps: 24,
        width: 1920,
        height: 1080,
        paused: false,
        aid: '1',
        vid: '1',
        tracks: [
          { type: 'video', codec: 'h264', selected: true, default: true },
          { type: 'audio', codec: 'aac', selected: true, default: true }
        ]
      };
    },
    renderFrame() {
      const now = Date.now();
      if (inFlight.size >= 3) return { updated: false, backpressure: true };
      if (now - lastProducedAt < 40) return { updated: false, backpressure: false };
      lastProducedAt = now;
      const frameId = nextFrameId++;
      const slotId = frameId % 3;
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
          setTimeout(() => allReferencesReleased?.(), 1);
        }
      };
    },
    async sendSharedTexture() {}
  };

  const fakeElectron = { sharedTexture: fakeSharedTexture };
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (String(request).endsWith(`${path.sep}lilac-libmpv-player-bridge.node`)) return fakeAddon;
    return originalLoad.call(this, request, parent, isMain);
  };

  const fakeHandlers = new Map();
  const fakeListeners = new Map();
  const ipcMain = {
    handle(name, fn) { fakeHandlers.set(name, fn); },
    on(name, fn) { fakeListeners.set(name, fn); }
  };
  const app = { isPackaged: false };
  const fakeWindow = {
    isDestroyed: () => false,
    once() {},
    webContents: {
      id: 7,
      isDestroyed: () => false,
      mainFrame: { routingId: 1 }
    }
  };

  let bridge;
  const startedAt = Date.now();
  try {
    const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');
    bridge = createLibmpvSharedBridge({ app, ipcMain, headersFor: () => ({}), userAgent: 'R2 pump simulation' });
    await bridge.ensure();
    await bridge.attachWindow(fakeWindow);
    await bridge.open('file:///simulated.mp4', {}, false, { width: 1920, height: 1080 });

    const propertyCases = [
      [['set_property', 'pause', false], ['set', 'pause', 'no']],
      [['set_property', 'mute', true], ['set', 'mute', 'yes']],
      [['set_property', 'volume', 73.5], ['set', 'volume', '73.5']],
      [['set_property', 'speed', 1.25], ['set', 'speed', '1.25']],
      [['set_property', 'aid', 'auto'], ['set', 'aid', 'auto']]
    ];
    for (const [input, expected] of propertyCases) {
      const result = bridge.command(input);
      if (!result?.ok) throw new Error(`normalized command failed: ${JSON.stringify(input)}`);
      const actual = commandLog.at(-1);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`command normalization mismatch: got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
      }
    }

    await sleep(5200);
    const state = bridge.state();
    const metrics = state.metrics || {};
    const fps = Number(metrics.effectiveSentFps || 0);
    const sent = Number(metrics.sentFrames || 0);
    const backpressureRatio = Number(metrics.backpressureRatio || 0);
    const avgRelease = Number(metrics.avgReleaseLatencyMs || 0);

    if (sent < 105) throw new Error(`simulated shared pump sent too few frames: ${sent}`);
    if (fps < 20 || fps > 28) throw new Error(`simulated shared pump cadence outside expected 24fps band: ${fps}`);
    if (backpressureRatio > 0.03) throw new Error(`simulated shared pump backpressure too high: ${backpressureRatio}`);
    if (Number(metrics.maxPending || 0) > 2) throw new Error(`simulated shared pump retained too many frames: ${metrics.maxPending}`);
    if (avgRelease > 20) throw new Error(`simulated shared release latency too high: ${avgRelease}`);
    if (Number(metrics.commandFailures || 0) !== 0) throw new Error(`property command failures observed: ${JSON.stringify(metrics.lastCommandError)}`);
    if (receiverReleases < sent - 2) throw new Error(`native release count lagged sent frames: releases=${receiverReleases} sent=${sent}`);

    console.log(`LIBMPV_R2_PUMP_SIM_REPORT=${JSON.stringify({
      sentFrames: sent,
      effectiveSentFps: fps,
      backpressureRatio,
      maxPending: metrics.maxPending,
      avgReleaseLatencyMs: avgRelease,
      releaseLatencyMaxMs: metrics.releaseLatencyMaxMs,
      receiverReleases,
      commandCases: propertyCases.length
    })}`);
    console.log('LIBMPV_R2_PUMP_SIM_OK');
  } finally {
    try { await bridge?.dispose?.(); } catch {}
    Module._load = originalLoad;
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

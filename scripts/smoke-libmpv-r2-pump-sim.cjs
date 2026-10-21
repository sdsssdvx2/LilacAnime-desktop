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
  const commandLog = [];
  const scheduledDelays = [];
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
        tracks: [
          { type: 'video', codec: 'h264', selected: true, default: true },
          { type: 'audio', codec: 'aac', selected: true, default: true }
        ]
      };
    },
    renderFrame() {
      const now = Date.now();
      if (inFlight.size >= 24) return { updated: false, backpressure: true };
      // Deliberately 40ms (25fps-ish). A 16ms polling scheduler observes this
      // producer on ~48ms boundaries, so raw frame count is not a valid exact
      // scheduler assertion. The test records requested timer delays directly.
      if (now - lastProducedAt < 40) return { updated: false, backpressure: false };
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
          // Keep the fake callback short and deterministic. This timer is not
          // part of the bridge scheduler and therefore uses the unpatched API.
          realSetTimeout(() => allReferencesReleased?.(), 1);
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

    // Record the delays requested by the bridge itself. sleep() and the fake
    // shared-texture release callback deliberately retain realSetTimeout, so
    // this list directly describes the production pump scheduler semantics.
    global.setTimeout = function(fn, delay, ...args) {
      scheduledDelays.push(Number(delay) || 0);
      return originalSetTimeout(fn, delay, ...args);
    };

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

    await sleep(3200);
    const state = bridge.state();
    const metrics = state.metrics || {};
    const fps = Number(metrics.effectiveSentFps || 0);
    const sent = Number(metrics.sentFrames || 0);
    const pumps = Number(metrics.pumpTicks || 0);
    const backpressureRatio = Number(metrics.backpressureRatio || 0);
    const avgRelease = Number(metrics.avgReleaseLatencyMs || 0);
    const delay16 = scheduledDelays.filter(value => value === 16).length;
    const delay5 = scheduledDelays.filter(value => value === 5).length;
    const delay100 = scheduledDelays.filter(value => value === 100).length;
    const immediate = scheduledDelays.filter(value => value === 0).length;

    // Throughput itself is validated by the real 1080p A/B gate. This fake
    // producer only needs enough activity to prove liveness while the exact
    // timer requests below prove the scheduler policy without Windows timer
    // quantization making the test flaky.
    if (sent < 45) throw new Error(`simulated shared pump did not remain live: ${sent} frames`);
    if (pumps < sent || pumps > 320) throw new Error(`simulated pump tick count outside non-spin bounds: pumps=${pumps} sent=${sent}`);
    if (delay16 < 40) throw new Error(`16ms paced scheduling was not exercised enough: ${delay16}`);
    if (delay5 !== 0) throw new Error(`legacy 5ms spin scheduling returned: ${delay5}`);
    if (delay100 !== 0) throw new Error(`unexpected backpressure scheduling in no-pressure simulation: ${delay100}`);
    if (immediate < 1 || immediate > receiverReleases + 4) {
      throw new Error(`release-driven immediate scheduling outside expected bounds: immediate=${immediate} releases=${receiverReleases}`);
    }
    if (fps < 12 || fps > 28) throw new Error(`simulated effective FPS outside liveness band: ${fps}`);
    if (backpressureRatio > 0.03) throw new Error(`simulated shared pump backpressure too high: ${backpressureRatio}`);
    if (Number(metrics.maxPending || 0) > 3) throw new Error(`simulated shared pump retained too many frames: ${metrics.maxPending}`);
    if (avgRelease > 20) throw new Error(`simulated shared release latency too high: ${avgRelease}`);
    if (Number(metrics.commandFailures || 0) !== 0) throw new Error(`property command failures observed: ${JSON.stringify(metrics.lastCommandError)}`);
    if (receiverReleases < sent - 2) throw new Error(`native release count lagged sent frames: releases=${receiverReleases} sent=${sent}`);

    console.log(`LIBMPV_R2_PUMP_SIM_REPORT=${JSON.stringify({
      sentFrames: sent,
      pumpTicks: pumps,
      effectiveSentFps: fps,
      backpressureRatio,
      maxPending: metrics.maxPending,
      avgReleaseLatencyMs: avgRelease,
      releaseLatencyMaxMs: metrics.releaseLatencyMaxMs,
      receiverReleases,
      scheduler: { delay16, delay5, delay100, immediate, totalRecorded: scheduledDelays.length },
      commandCases: propertyCases.length
    })}`);
    console.log('LIBMPV_R2_PUMP_SIM_OK');
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

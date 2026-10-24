'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary missing');
  const output = path.join(dir, 'command-roundtrip.mp4');
  const common = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=12',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest'
  ];
  let encoded = spawnSync(ffmpeg, [...common, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', output], {
    encoding: 'utf8', windowsHide: true, timeout: 120000
  });
  if (encoded.status !== 0 || !fs.existsSync(output)) {
    encoded = spawnSync(ffmpeg, [...common, '-c:v', 'mpeg4', '-q:v', '5', output], {
      encoding: 'utf8', windowsHide: true, timeout: 120000
    });
  }
  if (encoded.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`command fixture encode failed: ${String(encoded.stderr || '').slice(0, 300)}`);
  }
  return output;
}

function headerValue(headers, wanted) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(wanted) || '';
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted.toLowerCase()) return String(value);
  }
  return '';
}

function installFixtureFetch(media) {
  const original = global.fetch;
  const all = fs.readFileSync(media);
  global.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'fixture.invalid' || url.pathname !== '/command-roundtrip.mp4') {
      throw new Error('native command smoke attempted an unexpected upstream');
    }
    const method = String(init?.method || 'GET').toUpperCase();
    const baseHeaders = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes'
    };
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { ...baseHeaders, 'content-length': String(all.length) } });
    }
    const range = headerValue(init?.headers, 'range');
    const match = range.match(/^bytes=(\d+)-(\d*)$/i);
    if (match) {
      const start = Math.min(all.length, Number(match[1]));
      const requestedEnd = match[2] ? Number(match[2]) : all.length - 1;
      const end = Math.min(all.length - 1, Math.max(start, requestedEnd));
      const body = all.subarray(start, end + 1);
      return new Response(body, { status: 206, headers: {
        ...baseHeaders,
        'content-length': String(body.length),
        'content-range': `bytes ${start}-${end}/${all.length}`
      } });
    }
    return new Response(all, { status: 200, headers: { ...baseHeaders, 'content-length': String(all.length) } });
  };
  return () => { global.fetch = original; };
}

async function waitForState(bridge, label, predicate, timeoutMs = 5000, fullDiagnostics = false) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = fullDiagnostics ? bridge.state({ fullDiagnostics: true }) : bridge.state();
    if (predicate(last)) return last;
    await sleep(25);
  }
  const safe = last ? {
    fileLoaded: last.fileLoaded,
    paused: last.paused,
    time: last.time,
    volume: last.volume,
    speed: last.speed,
    commandFailures: last.metrics?.commandFailures,
    lastCommandError: last.metrics?.lastCommandError
  } : null;
  throw new Error(`${label} timed out: ${JSON.stringify(safe)}`);
}

async function main() {
  const addonPath = path.resolve(__dirname, '..', 'electron', 'lilac-libmpv-player-bridge.node');
  const dllPath = path.resolve(__dirname, '..', 'electron', 'libmpv-2.dll');
  if (!fs.existsSync(addonPath)) throw new Error('compiled libmpv player addon missing');
  if (!fs.existsSync(dllPath)) throw new Error('libmpv runtime missing');
  process.env.LILAC_LIBMPV_DLL = dllPath;
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const originalLoad = Module._load;
  let releaseCallbacks = 0;
  const fakeSharedTexture = {
    importSharedTexture({ allReferencesReleased }) {
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          releaseCallbacks += 1;
          allReferencesReleased?.();
        }
      };
    },
    async sendSharedTexture() {}
  };
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { sharedTexture: fakeSharedTexture };
    return originalLoad.call(this, request, parent, isMain);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-libmpv-command-'));
  const media = buildFixture(dir);
  const restoreFetch = installFixtureFetch(media);
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle(name, fn) { handlers.set(name, fn); },
    on(name, fn) { listeners.set(name, fn); }
  };
  const app = { isPackaged: false };
  const fakeWindow = {
    isDestroyed: () => false,
    once() {},
    webContents: {
      id: 71,
      isDestroyed: () => false,
      mainFrame: { routingId: 1 }
    }
  };

  let bridge = null;
  try {
    const { createLibmpvSharedBridge } = require('../electron/libmpv-shared-main.cjs');
    bridge = createLibmpvSharedBridge({ app, ipcMain, headersFor: () => ({}), userAgent: 'Lilac native command CI' });
    await bridge.ensure();
    await bridge.attachWindow(fakeWindow);
    await bridge.open('https://fixture.invalid/command-roundtrip.mp4', {}, false, { width: 640, height: 360 });

    const loaded = await waitForState(bridge, 'file load', state => state.fileLoaded === true && Number(state.time) >= 0);
    if (Number(loaded.metrics?.commandFailures || 0) !== 0) throw new Error('command failures existed before roundtrip');

    let result = bridge.command(['set_property', 'pause', true]);
    if (!result?.ok) throw new Error(`pause command rejected: ${JSON.stringify(result)}`);
    const paused = await waitForState(bridge, 'pause readback', state => state.paused === true);
    const pausedAt = Number(paused.time);
    await sleep(350);
    const pausedStable = bridge.state();
    if (Math.abs(Number(pausedStable.time) - pausedAt) > 0.25) {
      throw new Error(`paused clock advanced unexpectedly: before=${pausedAt} after=${pausedStable.time}`);
    }

    result = bridge.command(['set_property', 'volume', 37]);
    if (!result?.ok) throw new Error(`volume command rejected: ${JSON.stringify(result)}`);
    const volumeState = await waitForState(bridge, 'volume readback', state => Math.abs(Number(state.volume) - 37) <= 0.5, 5000, true);

    result = bridge.command(['set_property', 'speed', 1.5]);
    if (!result?.ok) throw new Error(`speed command rejected: ${JSON.stringify(result)}`);
    const speedState = await waitForState(bridge, 'speed readback', state => Math.abs(Number(state.speed) - 1.5) <= 0.02, 5000, true);

    result = bridge.command(['set_property', 'time-pos', 4]);
    if (!result?.ok) throw new Error(`seek command rejected: ${JSON.stringify(result)}`);
    const seekState = await waitForState(bridge, 'seek readback', state => Number(state.time) >= 3.7 && Number(state.time) <= 4.3);

    result = bridge.command(['set_property', 'pause', false]);
    if (!result?.ok) throw new Error(`play command rejected: ${JSON.stringify(result)}`);
    const playing = await waitForState(bridge, 'play readback', state => state.paused === false);
    const playStart = Number(playing.time);
    await sleep(700);
    const advanced = bridge.state();
    const playAdvance = Number(advanced.time) - playStart;
    if (!Number.isFinite(playAdvance) || playAdvance < 0.45) {
      throw new Error(`playback clock did not advance after play: delta=${playAdvance}`);
    }

    const finalState = bridge.state({ fullDiagnostics: true });
    if (Number(finalState.metrics?.commandFailures || 0) !== 0) {
      throw new Error(`native command failure recorded: ${JSON.stringify(finalState.metrics?.lastCommandError || null)}`);
    }
    if (Math.abs(Number(finalState.volume) - 37) > 0.5) throw new Error(`volume did not persist: ${finalState.volume}`);
    if (Math.abs(Number(finalState.speed) - 1.5) > 0.02) throw new Error(`speed did not persist: ${finalState.speed}`);
    if (releaseCallbacks < 1) throw new Error('actual libmpv render pump never released a native frame');

    console.log(`LIBMPV_NATIVE_COMMAND_ROUNDTRIP_REPORT=${JSON.stringify({
      pause: paused.paused,
      pausedClockDrift: Math.round(Math.abs(Number(pausedStable.time) - pausedAt) * 1000) / 1000,
      volume: volumeState.volume,
      speed: speedState.speed,
      seekTime: seekState.time,
      playAdvance: Math.round(playAdvance * 1000) / 1000,
      commandFailures: finalState.metrics?.commandFailures || 0,
      releaseCallbacks,
      fileLoaded: finalState.fileLoaded === true
    })}`);
    console.log('LIBMPV_NATIVE_COMMAND_ROUNDTRIP_OK');
  } finally {
    try { await bridge?.dispose?.(); } catch {}
    restoreFetch();
    Module._load = originalLoad;
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

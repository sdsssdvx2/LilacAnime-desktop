'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(Number(value || 0) * 1000) / 1000;
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static missing');
  const output = path.join(dir, 'r3c-fhd-latency.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0, 240)}`);
  }
  return output;
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath)) throw new Error('LILAC_LIBMPV_PLAYER_ADDON missing');
  if (!dllPath || !fs.existsSync(dllPath)) throw new Error('LILAC_LIBMPV_DLL missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const addon = require(addonPath);
  for (const name of ['createPlayer','open','pollPlayback','setUpdateCallback','renderFrame','releaseFrame','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3c-fhd-render-'));
  const media = buildFixture(dir);
  let playerId = null;
  let active = true;
  let callbackSignals = 0;
  let callbackPending = false;
  const allDurations = [];
  const updatedDurations = [];
  const emptyDurations = [];
  const updatedAt = [];
  let sampleStartedAt = 0;
  let warmupCalls = 0;
  let warmupMaxMs = 0;

  function renderOnce(record) {
    const started = performance.now();
    const frame = addon.renderFrame(playerId, 1920, 1080);
    const elapsed = performance.now() - started;
    if (!record) {
      warmupCalls += 1;
      warmupMaxMs = Math.max(warmupMaxMs, elapsed);
    } else {
      allDurations.push(elapsed);
      if (frame?.updated) updatedDurations.push(elapsed);
      else emptyDurations.push(elapsed);
    }
    if (frame?.updated) {
      const now = performance.now();
      if (record) updatedAt.push(now);
      if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
        throw new Error(`releaseFrame rejected ${frame.frameId}`);
      }
    }
    return frame;
  }

  try {
    const created = addon.createPlayer();
    playerId = Number(created.playerId);
    addon.setUpdateCallback(playerId, () => {
      callbackSignals += 1;
      callbackPending = true;
    });
    addon.open(playerId, media);

    const loadDeadline = Date.now() + 8000;
    let loaded = false;
    while (Date.now() < loadDeadline) {
      const state = addon.pollPlayback(playerId);
      if (state.fileLoaded) { loaded = true; break; }
      await sleep(15);
    }
    if (!loaded) throw new Error('fileLoaded timeout');

    const warmupUntil = performance.now() + 1800;
    while (performance.now() < warmupUntil) {
      if (callbackPending) callbackPending = false;
      renderOnce(false);
      await sleep(2);
    }

    sampleStartedAt = performance.now();
    const sampleUntil = sampleStartedAt + 5200;
    while (active && performance.now() < sampleUntil) {
      if (callbackPending) callbackPending = false;
      renderOnce(true);
      await sleep(2);
    }
    active = false;

    const intervals = [];
    for (let i = 1; i < updatedAt.length; i += 1) intervals.push(updatedAt[i] - updatedAt[i - 1]);
    const spanMs = updatedAt.length > 1 ? updatedAt[updatedAt.length - 1] - updatedAt[0] : 0;
    const effectiveFps = spanMs > 0 ? ((updatedAt.length - 1) * 1000) / spanMs : 0;
    const state = addon.pollPlayback(playerId);
    const report = {
      sourceFps: Number(state.fps) || 0,
      deviceMode: created.deviceMode,
      callbackSignals,
      warmupCalls,
      warmupMaxMs: round(warmupMaxMs),
      sampleMs: round(performance.now() - sampleStartedAt),
      renderCalls: allDurations.length,
      updatedFrames: updatedDurations.length,
      effectiveFps: round(effectiveFps),
      allRenderMs: {
        p50: round(percentile(allDurations, 0.50)),
        p95: round(percentile(allDurations, 0.95)),
        p99: round(percentile(allDurations, 0.99)),
        max: round(Math.max(0, ...allDurations))
      },
      updatedRenderMs: {
        p50: round(percentile(updatedDurations, 0.50)),
        p95: round(percentile(updatedDurations, 0.95)),
        p99: round(percentile(updatedDurations, 0.99)),
        max: round(Math.max(0, ...updatedDurations))
      },
      emptyRenderMs: {
        p50: round(percentile(emptyDurations, 0.50)),
        p95: round(percentile(emptyDurations, 0.95)),
        p99: round(percentile(emptyDurations, 0.99)),
        max: round(Math.max(0, ...emptyDurations))
      },
      frameIntervalMs: {
        p50: round(percentile(intervals, 0.50)),
        p95: round(percentile(intervals, 0.95)),
        p99: round(percentile(intervals, 0.99)),
        max: round(Math.max(0, ...intervals))
      }
    };
    console.log(`LIBMPV_R3C_FHD_RENDER_LATENCY_REPORT=${JSON.stringify(report)}`);

    if (updatedDurations.length < 80) throw new Error(`too few FHD frames: ${updatedDurations.length}`);
    if (effectiveFps < 18) throw new Error(`hosted FHD cadence too low for meaningful timing sample: ${effectiveFps}`);
    if (report.allRenderMs.p95 > 20) throw new Error(`renderFrame p95 unexpectedly high: ${report.allRenderMs.p95}`);
    if (report.updatedRenderMs.p95 > 25) throw new Error(`updated renderFrame p95 unexpectedly high: ${report.updatedRenderMs.p95}`);
    console.log('LIBMPV_R3C_FHD_RENDER_LATENCY_OK');
  } finally {
    active = false;
    if (playerId != null) {
      try { addon.destroyPlayer(playerId); } catch {}
    }
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

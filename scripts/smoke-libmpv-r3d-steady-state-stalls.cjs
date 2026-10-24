'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(Number(value || 0) * 1000) / 1000;
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static missing');
  const output = path.join(dir, 'r3d-steady-fhd.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=15',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0, 300)}`);
  }
  return output;
}

function summarize(values) {
  return {
    p50: round(percentile(values, 0.50)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(0, ...values))
  };
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-steady-'));
  const media = buildFixture(dir);
  let playerId = null;
  let callbackPending = false;
  let callbackSignals = 0;
  const wallMs = [];
  const updateMs = [];
  const textureMs = [];
  const renderMs = [];
  const intervals = [];
  const stalls = [];
  let lastUpdatedAt = 0;
  let sampleFrame = 0;
  let renderCalls = 0;
  let updatedFrames = 0;

  function renderOnce(record) {
    const callStarted = performance.now();
    const frame = addon.renderFrame(playerId, 1920, 1080);
    const wall = performance.now() - callStarted;
    if (!record) {
      if (frame?.updated && !addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
        throw new Error(`warmup release failed ${frame.frameId}`);
      }
      return;
    }

    renderCalls += 1;
    wallMs.push(wall);
    const u = Number(frame?.nativeUpdateMs);
    if (!Number.isFinite(u) || u < 0) throw new Error(`invalid nativeUpdateMs on call ${renderCalls}`);
    updateMs.push(u);

    if (!frame?.updated) return;
    updatedFrames += 1;
    sampleFrame += 1;
    const t = Number(frame.nativeEnsureTextureMs);
    const r = Number(frame.nativeRenderMs);
    if (!Number.isFinite(t) || t < 0) throw new Error(`invalid nativeEnsureTextureMs on frame ${sampleFrame}`);
    if (!Number.isFinite(r) || r < 0) throw new Error(`invalid nativeRenderMs on frame ${sampleFrame}`);
    textureMs.push(t);
    renderMs.push(r);

    const now = performance.now();
    if (lastUpdatedAt > 0) intervals.push(now - lastUpdatedAt);
    lastUpdatedAt = now;
    if (r > 20 || wall > 20) {
      stalls.push({
        frame: sampleFrame,
        frameId: Number(frame.frameId),
        wallMs: round(wall),
        updateMs: round(u),
        textureMs: round(t),
        renderMs: round(r)
      });
    }
    if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
      throw new Error(`release failed ${frame.frameId}`);
    }
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
      if (addon.pollPlayback(playerId).fileLoaded) { loaded = true; break; }
      await sleep(15);
    }
    if (!loaded) throw new Error('fileLoaded timeout');

    const warmupUntil = performance.now() + 2200;
    while (performance.now() < warmupUntil) {
      if (callbackPending) callbackPending = false;
      renderOnce(false);
      await sleep(2);
    }

    const sampleStart = performance.now();
    const sampleUntil = sampleStart + 8000;
    while (performance.now() < sampleUntil) {
      if (callbackPending) callbackPending = false;
      renderOnce(true);
      await sleep(2);
    }
    const sampleElapsed = performance.now() - sampleStart;
    const state = addon.pollPlayback(playerId);
    const frameSpan = intervals.reduce((a, b) => a + b, 0);
    const effectiveFps = frameSpan > 0 ? (intervals.length * 1000) / frameSpan : 0;
    const countOver = threshold => stalls.filter(item => item.renderMs > threshold || item.wallMs > threshold).length;

    const report = {
      sourceFps: Number(state.fps) || 0,
      deviceMode: created.deviceMode,
      callbackSignals,
      sampleMs: round(sampleElapsed),
      renderCalls,
      updatedFrames,
      effectiveFps: round(effectiveFps),
      wallMs: summarize(wallMs),
      nativeUpdateMs: summarize(updateMs),
      nativeEnsureTextureMs: summarize(textureMs),
      nativeRenderMs: summarize(renderMs),
      frameIntervalMs: summarize(intervals),
      stallsOver20Ms: countOver(20),
      stallsOver50Ms: countOver(50),
      stallsOver100Ms: countOver(100),
      stallSamples: stalls.slice(0, 20)
    };
    console.log(`LIBMPV_R3D_STEADY_STATE_REPORT=${JSON.stringify(report)}`);

    if (updatedFrames < 100) throw new Error(`too few steady-state frames: ${updatedFrames}`);
    if (effectiveFps < 18) throw new Error(`steady-state cadence too low for useful sample: ${effectiveFps}`);
    if (report.nativeUpdateMs.p95 > 5) throw new Error(`render_context_update p95 unexpectedly high: ${report.nativeUpdateMs.p95}`);
    if (report.nativeEnsureTextureMs.p95 > 5) throw new Error(`EnsureTexture p95 unexpectedly high: ${report.nativeEnsureTextureMs.p95}`);
    console.log('LIBMPV_R3D_STEADY_STATE_OK');
  } finally {
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

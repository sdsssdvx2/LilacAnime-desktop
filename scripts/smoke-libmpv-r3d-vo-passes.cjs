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
const summarize = values => ({
  count: values.length,
  p50: round(percentile(values, 0.50)),
  p95: round(percentile(values, 0.95)),
  p99: round(percentile(values, 0.99)),
  max: round(Math.max(0, ...values))
});

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static missing');
  const output = path.join(dir, 'r3d-vo-passes-1080p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0, 300)}`);
  }
  return output;
}

async function waitLoaded(addon, playerId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (addon.pollPlayback(playerId).fileLoaded) return;
    await sleep(15);
  }
  throw new Error('fileLoaded timeout');
}

function snapshotGpuPasses(state) {
  const passes = Array.isArray(state?.voFreshPasses) ? state.voFreshPasses : [];
  const normalized = passes.map((pass, index) => {
    const lastNs = Number(pass?.lastNs);
    const avgNs = Number(pass?.avgNs);
    const peakNs = Number(pass?.peakNs);
    return {
      index,
      desc: typeof pass?.desc === 'string' ? pass.desc : `pass-${index}`,
      lastMs: Number.isFinite(lastNs) && lastNs >= 0 ? lastNs / 1e6 : null,
      avgMs: Number.isFinite(avgNs) && avgNs >= 0 ? avgNs / 1e6 : null,
      peakMs: Number.isFinite(peakNs) && peakNs >= 0 ? peakNs / 1e6 : null
    };
  });
  const lastValues = normalized.map(p => p.lastMs).filter(Number.isFinite);
  return {
    reportedCount: Number(state?.voFreshCount),
    passCount: normalized.length,
    gpuLastSumMs: lastValues.reduce((sum, value) => sum + value, 0),
    gpuLastMaxMs: lastValues.length ? Math.max(...lastValues) : 0,
    passes: normalized
  };
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) {
    throw new Error('addon/dll missing');
  }
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer', 'open', 'poll', 'pollPlayback', 'setUpdateCallback', 'renderFrame', 'releaseFrame', 'destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`addon missing ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-vo-passes-'));
  const created = addon.createPlayer();
  const playerId = Number(created.playerId);
  const renderMs = [];
  const frameIntervals = [];
  const gpuSums = [];
  const gpuMaxes = [];
  const pollWallMs = [];
  const passSeries = new Map();
  let updatedFrames = 0;
  let callbackSignals = 0;
  let previousUpdatedAt = 0;
  let gpuSnapshots = 0;

  function recordPasses(snapshot) {
    gpuSnapshots += 1;
    gpuSums.push(snapshot.gpuLastSumMs);
    gpuMaxes.push(snapshot.gpuLastMaxMs);
    for (const pass of snapshot.passes) {
      if (!passSeries.has(pass.desc)) passSeries.set(pass.desc, { last: [], avg: [], peak: [] });
      const series = passSeries.get(pass.desc);
      if (Number.isFinite(pass.lastMs)) series.last.push(pass.lastMs);
      if (Number.isFinite(pass.avgMs)) series.avg.push(pass.avgMs);
      if (Number.isFinite(pass.peakMs)) series.peak.push(pass.peakMs);
    }
  }

  async function pump(record, sampleGpu) {
    const frame = addon.renderFrame(playerId, 1920, 1080);
    if (!frame?.updated) return false;
    if (record) {
      updatedFrames += 1;
      const now = performance.now();
      if (previousUpdatedAt > 0) frameIntervals.push(now - previousUpdatedAt);
      previousUpdatedAt = now;
      const value = Number(frame.nativeRenderMs);
      if (Number.isFinite(value) && value >= 0) renderMs.push(value);
    }
    if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) throw new Error('release failed');

    if (record && sampleGpu) {
      const pollStarted = performance.now();
      const state = addon.poll(playerId);
      pollWallMs.push(performance.now() - pollStarted);
      const snapshot = snapshotGpuPasses(state);
      if (snapshot.passCount > 0) recordPasses(snapshot);
    }
    return true;
  }

  try {
    const media = buildFixture(dir);
    addon.setUpdateCallback(playerId, () => { callbackSignals += 1; });
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);

    const warmUntil = performance.now() + 1600;
    while (performance.now() < warmUntil) {
      await pump(false, false);
      await sleep(2);
    }

    const until = performance.now() + 7000;
    let renderedSinceGpuSample = 0;
    while (performance.now() < until) {
      const updated = await pump(true, false);
      if (updated) {
        renderedSinceGpuSample += 1;
        if (renderedSinceGpuSample >= 3) {
          renderedSinceGpuSample = 0;
          const pollStarted = performance.now();
          const state = addon.poll(playerId);
          pollWallMs.push(performance.now() - pollStarted);
          const snapshot = snapshotGpuPasses(state);
          if (snapshot.passCount > 0) recordPasses(snapshot);
        }
      }
      await sleep(2);
    }

    const finalPollStarted = performance.now();
    const finalState = addon.poll(playerId);
    pollWallMs.push(performance.now() - finalPollStarted);
    const finalSnapshot = snapshotGpuPasses(finalState);
    if (finalSnapshot.passCount > 0) recordPasses(finalSnapshot);

    const perPass = [...passSeries.entries()].map(([desc, series]) => ({
      desc,
      lastMs: summarize(series.last),
      avgMs: summarize(series.avg),
      peakMs: summarize(series.peak)
    })).sort((a, b) => b.lastMs.p50 - a.lastMs.p50);

    const renderSummary = summarize(renderMs);
    const gpuSumSummary = summarize(gpuSums);
    const report = {
      deviceMode: created.deviceMode,
      callbackSignals,
      updatedFrames,
      gpuSnapshots,
      nativeRenderMs: renderSummary,
      frameIntervalMs: summarize(frameIntervals),
      gpuFreshPassSumMs: gpuSumSummary,
      gpuFreshPassMaxMs: summarize(gpuMaxes),
      diagnosticPollWallMs: summarize(pollWallMs),
      finalReportedFreshPassCount: finalSnapshot.reportedCount,
      finalPassCount: finalSnapshot.passCount,
      wallToGpuP50Ratio: gpuSumSummary.p50 > 0 ? round(renderSummary.p50 / gpuSumSummary.p50) : null,
      gpuShareOfWallP50Pct: renderSummary.p50 > 0 ? round((gpuSumSummary.p50 / renderSummary.p50) * 100) : null,
      passes: perPass
    };
    console.log(`LIBMPV_R3D_VO_PASSES_REPORT=${JSON.stringify(report)}`);

    if (updatedFrames < 30 || renderMs.length < 30) throw new Error('insufficient render samples');
    if (gpuSnapshots < 5 || gpuSums.length < 5) throw new Error('insufficient GPU pass snapshots');
    if (!perPass.length) throw new Error('no GPU pass timing descriptions');
    console.log('LIBMPV_R3D_VO_PASSES_OK');
  } finally {
    try { addon.destroyPlayer(playerId); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

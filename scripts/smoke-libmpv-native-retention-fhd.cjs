'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary missing');
  const output = path.join(dir, 'retention-1080p.mp4');
  let result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=14',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=14',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.status !== 0 || !fs.existsSync(output)) {
    result = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=14',
      '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=14',
      '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
    ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  }
  if (result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`1080p fixture encode failed: ${String(result.stderr || '').slice(0, 300)}`);
  }
  return output;
}

async function runPhase(addon, fixture, holdMs, durationMs = 4500) {
  const held = [];
  const result = {
    holdMs,
    create: null,
    textureSlotCount: null,
    frames: 0,
    backpressure: 0,
    maxInFlight: 0,
    firstFrameAt: 0,
    lastFrameAt: 0,
    effectiveFps: 0,
    selectedAudio: false,
    commandChecks: [],
    finalState: null
  };
  let playerId = null;

  const releaseDue = now => {
    for (let i = held.length - 1; i >= 0; i -= 1) {
      const item = held[i];
      if (item.releaseAt > now) continue;
      if (!addon.releaseFrame(playerId, item.slotId, item.frameId)) {
        throw new Error(`releaseFrame rejected frame ${item.frameId}`);
      }
      held.splice(i, 1);
    }
  };

  try {
    result.create = addon.createPlayer();
    playerId = result.create.playerId;
    addon.open(playerId, fixture);

    for (const args of [
      ['set', 'volume', '73'],
      ['set', 'mute', 'no'],
      ['set', 'speed', '1'],
      ['set', 'aid', 'auto'],
      ['set', 'sid', 'no']
    ]) {
      const started = performance.now();
      addon.command(playerId, args);
      result.commandChecks.push({ property: args[1], latencyMs: Math.round((performance.now() - started) * 1000) / 1000 });
    }

    const loadDeadline = Date.now() + 8000;
    while (Date.now() < loadDeadline) {
      const state = addon.poll(playerId);
      if (Number.isFinite(Number(state.textureSlotCount))) result.textureSlotCount = Number(state.textureSlotCount);
      const tracks = Array.isArray(state.tracks) ? state.tracks : [];
      if (tracks.some(track => track?.type === 'audio' && track?.selected === true)) result.selectedAudio = true;
      if (state.fileLoaded) break;
      await sleep(20);
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < durationMs) {
      const now = Date.now();
      releaseDue(now);
      const state = addon.poll(playerId);
      const tracks = Array.isArray(state.tracks) ? state.tracks : [];
      if (tracks.some(track => track?.type === 'audio' && track?.selected === true)) result.selectedAudio = true;
      const frame = addon.renderFrame(playerId, 1920, 1080);
      if (frame.backpressure) result.backpressure += 1;
      if (frame.updated) {
        const at = Date.now();
        if (!result.firstFrameAt) result.firstFrameAt = at;
        result.lastFrameAt = at;
        result.frames += 1;
        if (holdMs > 0) {
          held.push({ slotId: frame.slotId, frameId: frame.frameId, releaseAt: at + holdMs });
          result.maxInFlight = Math.max(result.maxInFlight, held.length);
        } else if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
          throw new Error(`immediate release rejected frame ${frame.frameId}`);
        }
      }
      await sleep(8);
    }

    const drainDeadline = Date.now() + holdMs + 1200;
    while (held.length && Date.now() < drainDeadline) {
      releaseDue(Date.now());
      await sleep(10);
    }
    if (held.length) throw new Error(`retained-frame drain timed out: ${held.length}`);

    result.finalState = addon.poll(playerId);
    const span = Math.max(1, result.lastFrameAt - result.firstFrameAt);
    result.effectiveFps = result.frames > 1 ? Math.round(((result.frames - 1) * 1000000 / span)) / 1000 : 0;
    return result;
  } finally {
    if (playerId != null) {
      try { addon.command(playerId, ['stop']); } catch {}
      try { addon.destroyPlayer(playerId); } catch {}
    }
  }
}

async function runSampledAB(addon, fixture, maxAttempts = 3) {
  let baseline = null;
  let retained = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    baseline = await runPhase(addon, fixture, 0);
    retained = await runPhase(addon, fixture, 800);
    if (baseline.frames >= 20 && retained.frames >= 20) {
      if (attempt > 1) console.log(`LIBMPV_NATIVE_RETENTION_SAMPLE_RETRY_OK attempt=${attempt} baseline=${baseline.frames} retained=${retained.frames}`);
      return { baseline, retained, sampleAttempt: attempt };
    }
    console.log(`LIBMPV_NATIVE_RETENTION_SAMPLE_RETRY attempt=${attempt} baseline=${baseline.frames} retained=${retained.frames}`);
    if (attempt < maxAttempts) await sleep(250);
  }
  throw new Error(`insufficient A/B sample size after ${maxAttempts} attempts: baseline=${baseline?.frames ?? 0} retained=${retained?.frames ?? 0}`);
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath)) throw new Error('LILAC_LIBMPV_PLAYER_ADDON missing');
  if (!dllPath || !fs.existsSync(dllPath)) throw new Error('LILAC_LIBMPV_DLL missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-retention-fhd-'));
  const fixture = buildFixture(dir);
  const addon = require(addonPath);
  for (const name of ['createPlayer', 'open', 'command', 'poll', 'renderFrame', 'releaseFrame', 'destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing player bridge export: ${name}`);
  }

  const report = {
    schema: 3,
    smoke: '1080p same-runner immediate-release vs 800ms-retention A/B',
    baseline: null,
    retained: null,
    sampleAttempt: 0,
    retentionToBaselineRatio: 0,
    hostedRunnerBaselineLimited: false,
    pass: false
  };

  try {
    const sampled = await runSampledAB(addon, fixture);
    report.baseline = sampled.baseline;
    report.retained = sampled.retained;
    report.sampleAttempt = sampled.sampleAttempt;

    const base = report.baseline;
    const held = report.retained;
    report.retentionToBaselineRatio = base.effectiveFps > 0
      ? Math.round((held.effectiveFps / base.effectiveFps) * 10000) / 10000
      : 0;
    report.hostedRunnerBaselineLimited = base.effectiveFps < 18;

    const retainedPressureRatio = held.backpressure / Math.max(1, held.frames + held.backpressure);
    const maxCommandLatency = Math.max(
      ...base.commandChecks.map(item => item.latencyMs),
      ...held.commandChecks.map(item => item.latencyMs)
    );
    const expectedInFlight = Math.max(2, Math.floor(base.effectiveFps * 0.8 * 0.55));

    if (base.textureSlotCount !== 24 || held.textureSlotCount !== 24) {
      throw new Error(`expected 24 slots in both phases: baseline=${base.textureSlotCount} retained=${held.textureSlotCount}`);
    }
    if (base.frames < 20 || held.frames < 20) throw new Error(`insufficient A/B sample size: baseline=${base.frames} retained=${held.frames}`);
    if (base.effectiveFps < 4) throw new Error(`hosted runner baseline too slow for a meaningful A/B test: ${base.effectiveFps}fps`);
    if (report.retentionToBaselineRatio < 0.78) {
      throw new Error(`800ms retention regressed throughput too much: baseline=${base.effectiveFps} retained=${held.effectiveFps} ratio=${report.retentionToBaselineRatio}`);
    }
    if (retainedPressureRatio > 0.05) throw new Error(`retained backpressure ratio too high: ${retainedPressureRatio.toFixed(4)}`);
    if (held.maxInFlight < expectedInFlight) {
      throw new Error(`retention phase did not exercise enough simultaneous slots: got=${held.maxInFlight} expected>=${expectedInFlight}`);
    }
    if (held.maxInFlight > 24) throw new Error(`in-flight texture count exceeded pool: ${held.maxInFlight}`);
    if (maxCommandLatency > 100) throw new Error(`native command latency too high: ${maxCommandLatency}ms`);
    if (!base.selectedAudio || !held.selectedAudio) throw new Error('AAC audio was not selected in both A/B phases');
    if (Number(base.finalState?.textureSlotsInFlight || 0) !== 0 || Number(held.finalState?.textureSlotsInFlight || 0) !== 0) {
      throw new Error(`texture slots remained in flight after drain: baseline=${base.finalState?.textureSlotsInFlight} retained=${held.finalState?.textureSlotsInFlight}`);
    }

    report.pass = true;
    console.log(`LIBMPV_NATIVE_RETENTION_FHD_REPORT=${JSON.stringify({
      baselineFps: base.effectiveFps,
      retainedFps: held.effectiveFps,
      retentionToBaselineRatio: report.retentionToBaselineRatio,
      hostedRunnerBaselineLimited: report.hostedRunnerBaselineLimited,
      sampleAttempt: report.sampleAttempt,
      baselineFrames: base.frames,
      retainedFrames: held.frames,
      retainedBackpressure: held.backpressure,
      retainedBackpressureRatio: Math.round(retainedPressureRatio * 1000000) / 1000000,
      maxInFlight: held.maxInFlight,
      selectedAudio: base.selectedAudio && held.selectedAudio,
      maxCommandLatencyMs: maxCommandLatency,
      deviceMode: base.create?.deviceMode
    })}`);
    console.log('LIBMPV_NATIVE_RETENTION_FHD_AB_OK');
  } finally {
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

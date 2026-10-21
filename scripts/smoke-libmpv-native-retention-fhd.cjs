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
  const common = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=10',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart'
  ];
  let result = spawnSync(ffmpeg, [
    ...common.slice(0, 8),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    ...common.slice(8), output
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.status !== 0 || !fs.existsSync(output)) {
    result = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=10',
      '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
    ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  }
  if (result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`1080p retention fixture encode failed: ${String(result.stderr || '').slice(0, 300)}`);
  }
  return output;
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

  const HOLD_MS = 800;
  let playerId = null;
  const held = [];
  const report = {
    schema: 1,
    smoke: '1080p 23.976fps native libmpv retained-frame pool stress',
    holdMs: HOLD_MS,
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
    finalState: null,
    pass: false
  };

  const releaseDue = now => {
    for (let i = held.length - 1; i >= 0; i -= 1) {
      const item = held[i];
      if (item.releaseAt > now) continue;
      if (!addon.releaseFrame(playerId, item.slotId, item.frameId)) {
        throw new Error(`releaseFrame rejected retained frame ${item.frameId}`);
      }
      held.splice(i, 1);
    }
  };

  try {
    const created = addon.createPlayer();
    report.create = created;
    playerId = created.playerId;
    addon.open(playerId, fixture);

    // Validate the native C API command vocabulary independently from the JS
    // normalization layer. These are the exact forms R2B emits.
    for (const args of [
      ['set', 'volume', '73'],
      ['set', 'mute', 'no'],
      ['set', 'speed', '1'],
      ['set', 'aid', 'auto'],
      ['set', 'sid', 'no']
    ]) {
      const started = performance.now();
      addon.command(playerId, args);
      report.commandChecks.push({ command: args[0], property: args[1], latencyMs: Math.round((performance.now() - started) * 1000) / 1000 });
    }

    const deadline = Date.now() + 9000;
    let loadedAt = 0;
    while (Date.now() < deadline) {
      const now = Date.now();
      releaseDue(now);
      const state = addon.poll(playerId);
      if (state.fileLoaded && !loadedAt) loadedAt = now;
      if (Number.isFinite(Number(state.textureSlotCount))) report.textureSlotCount = Number(state.textureSlotCount);
      const tracks = Array.isArray(state.tracks) ? state.tracks : [];
      if (tracks.some(track => track?.type === 'audio' && track?.selected === true)) report.selectedAudio = true;

      const frame = addon.renderFrame(playerId, 1920, 1080);
      if (frame.backpressure) report.backpressure += 1;
      if (frame.updated) {
        const at = Date.now();
        if (!report.firstFrameAt) report.firstFrameAt = at;
        report.lastFrameAt = at;
        report.frames += 1;
        held.push({ slotId: frame.slotId, frameId: frame.frameId, releaseAt: at + HOLD_MS });
        report.maxInFlight = Math.max(report.maxInFlight, held.length);
      }
      if (loadedAt && now - loadedAt > 7000) break;
      await sleep(8);
    }

    // Drain retained references and verify every slot becomes reusable.
    const drainDeadline = Date.now() + HOLD_MS + 1200;
    while (held.length && Date.now() < drainDeadline) {
      releaseDue(Date.now());
      await sleep(10);
    }
    if (held.length) throw new Error(`retained frame drain timed out: ${held.length}`);

    report.finalState = addon.poll(playerId);
    const span = Math.max(1, report.lastFrameAt - report.firstFrameAt);
    report.effectiveFps = report.frames > 1 ? Math.round(((report.frames - 1) * 1000000 / span)) / 1000 : 0;
    const pressureRatio = report.backpressure / Math.max(1, report.frames + report.backpressure);
    const maxCommandLatency = Math.max(...report.commandChecks.map(item => item.latencyMs));

    if (report.textureSlotCount !== 24) throw new Error(`expected 24 shared texture slots, got ${report.textureSlotCount}`);
    if (report.frames < 120) throw new Error(`too few retained 1080p frames: ${report.frames}`);
    if (report.effectiveFps < 18) throw new Error(`retained 1080p effective FPS too low: ${report.effectiveFps}`);
    if (pressureRatio > 0.08) throw new Error(`retained 1080p backpressure ratio too high: ${pressureRatio.toFixed(4)}`);
    if (report.maxInFlight < 12) throw new Error(`retention simulation did not stress enough slots: ${report.maxInFlight}`);
    if (report.maxInFlight > 24) throw new Error(`in-flight texture count exceeded pool: ${report.maxInFlight}`);
    if (maxCommandLatency > 100) throw new Error(`native playback command latency too high: ${maxCommandLatency}ms`);
    if (!report.selectedAudio) throw new Error(`AAC fixture audio was not selected: ${JSON.stringify(report.finalState?.tracks || [])}`);
    if (Number(report.finalState?.textureSlotsInFlight || 0) !== 0) throw new Error(`native slots still in flight after drain: ${report.finalState?.textureSlotsInFlight}`);

    report.pass = true;
    console.log(`LIBMPV_NATIVE_RETENTION_FHD_REPORT=${JSON.stringify({
      holdMs: report.holdMs,
      textureSlotCount: report.textureSlotCount,
      frames: report.frames,
      effectiveFps: report.effectiveFps,
      backpressure: report.backpressure,
      backpressureRatio: Math.round(pressureRatio * 1000000) / 1000000,
      maxInFlight: report.maxInFlight,
      selectedAudio: report.selectedAudio,
      maxCommandLatencyMs: maxCommandLatency,
      deviceMode: report.create?.deviceMode
    })}`);
    console.log('LIBMPV_NATIVE_RETENTION_FHD_OK');
  } finally {
    if (playerId != null) {
      try { addon.command(playerId, ['stop']); } catch {}
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

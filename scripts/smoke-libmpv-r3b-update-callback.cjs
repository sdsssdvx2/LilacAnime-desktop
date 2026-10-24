'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary missing');
  const output = path.join(dir, 'r3b-update-callback.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24000/1001:duration=9',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=9',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0, 300)}`);
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
  for (const name of ['createPlayer', 'open', 'command', 'poll', 'setUpdateCallback', 'renderFrame', 'releaseFrame', 'destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export: ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3b-callback-'));
  const fixture = buildFixture(dir);
  let playerId = null;
  let active = true;
  let drainScheduled = false;
  let wakeSignals = 0;
  let callbackErrors = 0;
  let frames = 0;
  let firstFrameAt = 0;
  let lastFrameAt = 0;
  let lastFrameId = 0;
  let maxGapMs = 0;

  function drainFromWake() {
    if (!active || drainScheduled || playerId == null) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (!active || playerId == null) return;
      try {
        const frame = addon.renderFrame(playerId, 1280, 720);
        if (!frame?.updated) return;
        const now = performance.now();
        if (!firstFrameAt) firstFrameAt = now;
        if (lastFrameAt) maxGapMs = Math.max(maxGapMs, now - lastFrameAt);
        lastFrameAt = now;
        frames += 1;
        lastFrameId = Number(frame.frameId) || lastFrameId;
        if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
          throw new Error(`releaseFrame rejected ${frame.frameId}`);
        }
      } catch (error) {
        callbackErrors += 1;
        console.error(`R3B_CALLBACK_DRAIN_ERROR=${String(error?.message || error).slice(0, 180)}`);
      }
    });
  }

  try {
    const created = addon.createPlayer();
    playerId = Number(created.playerId);
    addon.setUpdateCallback(playerId, () => {
      wakeSignals += 1;
      drainFromWake();
    });
    addon.open(playerId, fixture);

    const loadedDeadline = Date.now() + 8000;
    let loaded = false;
    while (Date.now() < loadedDeadline) {
      const state = addon.poll(playerId);
      if (state.fileLoaded) { loaded = true; break; }
      await sleep(20);
    }
    if (!loaded) throw new Error('fixture did not reach fileLoaded');

    const sampleStart = performance.now();
    await sleep(5200);
    const sampleEnd = performance.now();
    active = false;
    await sleep(80);

    const spanMs = firstFrameAt && lastFrameAt > firstFrameAt ? lastFrameAt - firstFrameAt : 0;
    const effectiveFps = spanMs > 0 && frames > 1 ? ((frames - 1) * 1000) / spanMs : 0;
    const report = {
      wakeSignals,
      frames,
      lastFrameId,
      callbackErrors,
      effectiveFps: Math.round(effectiveFps * 1000) / 1000,
      maxGapMs: Math.round(maxGapMs * 1000) / 1000,
      sampleMs: Math.round((sampleEnd - sampleStart) * 1000) / 1000,
      deviceMode: created.deviceMode
    };
    console.log(`LIBMPV_R3B_UPDATE_CALLBACK_REPORT=${JSON.stringify(report)}`);

    if (wakeSignals < 60) throw new Error(`too few native update wakeups: ${wakeSignals}`);
    if (frames < 60) throw new Error(`too few callback-driven frames: ${frames}`);
    if (effectiveFps < 15) throw new Error(`callback-driven frame rate too low: ${effectiveFps}`);
    if (callbackErrors !== 0) throw new Error(`callback drain errors: ${callbackErrors}`);
    if (wakeSignals < frames) throw new Error(`wake signal count below frame count: wake=${wakeSignals} frames=${frames}`);

    console.log('LIBMPV_R3B_UPDATE_CALLBACK_OK transport=none polling=none wake=mpv-render-update-tsfn');
  } finally {
    active = false;
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

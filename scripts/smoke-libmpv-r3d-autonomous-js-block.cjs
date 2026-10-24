'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static missing');
  const output = path.join(dir, 'autonomous-js-block-720p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24000/1001:duration=24',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=24',
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
    const state = addon.pollPlayback(playerId);
    if (state?.fileLoaded) return state;
    await sleep(15);
  }
  throw new Error('fileLoaded timeout');
}

function blockJs(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  const started = performance.now();
  Atomics.wait(view, 0, 0, ms);
  return performance.now() - started;
}

function drain(addon, playerId) {
  let count = 0;
  let renderMaxMs = 0;
  for (;;) {
    const frame = addon.popAutonomousProbeFrame(playerId);
    if (!frame) break;
    count += 1;
    renderMaxMs = Math.max(renderMaxMs, Number(frame.nativeRenderMs) || 0);
    if (!Buffer.isBuffer(frame.ntHandle) || frame.ntHandle.length !== 8) {
      throw new Error(`invalid autonomous NT handle for frame ${frame.frameId}`);
    }
    if (!addon.releaseAutonomousProbeFrame(playerId, frame.slotId, frame.frameId)) {
      throw new Error(`autonomous release rejected frame ${frame.frameId}`);
    }
  }
  return { count, renderMaxMs };
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath)) throw new Error('LILAC_LIBMPV_PLAYER_ADDON missing');
  if (!dllPath || !fs.existsSync(dllPath)) throw new Error('LILAC_LIBMPV_DLL missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const addon = require(addonPath);
  for (const name of [
    'createPlayer','open','pollPlayback','setUpdateCallback','startAutonomousProbe',
    'stopAutonomousProbe','popAutonomousProbeFrame','releaseAutonomousProbeFrame',
    'autonomousProbeStats','destroyPlayer'
  ]) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-autonomous-js-block-'));
  let playerId = null;
  let jsCallbackCount = 0;
  try {
    const media = buildFixture(dir);
    const created = addon.createPlayer();
    playerId = Number(created.playerId);
    addon.setUpdateCallback(playerId, () => { jsCallbackCount += 1; });
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);

    if (!addon.startAutonomousProbe(playerId, 1280, 720)) throw new Error('startAutonomousProbe failed');

    const warmDeadline = Date.now() + 12000;
    while (Date.now() < warmDeadline) {
      const stats = addon.autonomousProbeStats(playerId);
      if (Number(stats?.producedFrames || 0) >= 6) break;
      await sleep(25);
    }
    const warmStats = addon.autonomousProbeStats(playerId);
    if (Number(warmStats?.producedFrames || 0) < 4) {
      throw new Error(`autonomous producer failed to warm: ${JSON.stringify(warmStats)}`);
    }

    // Free all slots immediately before the intentional JS freeze so the native
    // producer has the full 24-slot runway while JS/N-API cannot execute.
    const preDrain = drain(addon, playerId);
    const before = addon.autonomousProbeStats(playerId);
    const callbacksBefore = jsCallbackCount;
    const requestedBlockMs = 350;
    const actualBlockMs = blockJs(requestedBlockMs);
    const after = addon.autonomousProbeStats(playerId);
    const callbacksImmediatelyAfter = jsCallbackCount;

    const producedDelta = Number(after.producedFrames || 0) - Number(before.producedFrames || 0);
    const rawWakeDelta = Number(after.rawWakeSignals || 0) - Number(before.rawWakeSignals || 0);
    const workerWakeDelta = Number(after.workerWakeups || 0) - Number(before.workerWakeups || 0);
    const readyDelta = Number(after.readyFrames || 0) - Number(before.readyFrames || 0);
    const callbacksDuringBlock = callbacksImmediatelyAfter - callbacksBefore;

    // Stop first so queue draining cannot race newly produced frames.
    if (!addon.stopAutonomousProbe(playerId)) throw new Error('stopAutonomousProbe failed');
    const finalStats = addon.autonomousProbeStats(playerId);
    const postDrain = drain(addon, playerId);

    const report = {
      deviceMode: created.deviceMode,
      requestedBlockMs,
      actualBlockMs: Math.round(actualBlockMs * 1000) / 1000,
      callbacksBefore,
      callbacksImmediatelyAfter,
      callbacksDuringBlock,
      before,
      after,
      finalStats,
      producedDelta,
      rawWakeDelta,
      workerWakeDelta,
      readyDelta,
      preDrain,
      postDrain
    };
    console.log(`LIBMPV_R3D_AUTONOMOUS_JS_BLOCK_REPORT=${JSON.stringify(report)}`);

    if (actualBlockMs < 320) throw new Error(`JS block too short: ${actualBlockMs}`);
    if (producedDelta < 2) throw new Error(`native producer did not advance enough during JS block: delta=${producedDelta}`);
    if (workerWakeDelta < 2) throw new Error(`native worker did not wake during JS block: delta=${workerWakeDelta}`);
    if (rawWakeDelta < 1) throw new Error(`raw mpv callback did not reach native worker during JS block: delta=${rawWakeDelta}`);
    if (callbacksDuringBlock !== 0) throw new Error(`JS callback unexpectedly executed inside synchronous block: ${callbacksDuringBlock}`);
    if (Number(after.backpressure || 0) !== Number(before.backpressure || 0)) {
      throw new Error(`unexpected slot backpressure during 350ms JS block: before=${before.backpressure} after=${after.backpressure}`);
    }
    if (postDrain.count < producedDelta) {
      throw new Error(`ready queue did not retain native-produced frames: drained=${postDrain.count} producedDelta=${producedDelta}`);
    }
    if (Number(finalStats.producedFrames || 0) < Number(after.producedFrames || 0)) {
      throw new Error('produced frame count regressed after stop');
    }

    console.log(`LIBMPV_R3D_AUTONOMOUS_JS_BLOCK_OK producedDuringBlock=${producedDelta} rawWakeDuringBlock=${rawWakeDelta} workerWakeDuringBlock=${workerWakeDelta} jsCallbacksDuringBlock=${callbacksDuringBlock} slots=24`);
  } finally {
    if (playerId != null) {
      try { addon.stopAutonomousProbe(playerId); } catch {}
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

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary missing');
  const output = path.join(dir, 'r3d-timing.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24000/1001:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-timing-'));
  const fixture = buildFixture(dir);
  const addon = require(addonPath);
  for (const name of ['createPlayer', 'open', 'pollPlayback', 'renderFrame', 'releaseFrame', 'destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export: ${name}`);
  }

  let playerId = null;
  let calls = 0;
  let frames = 0;
  let updateTimingSamples = 0;
  let textureTimingSamples = 0;
  let renderTimingSamples = 0;
  let updateMaxMs = 0;
  let textureMaxMs = 0;
  let renderMaxMs = 0;

  try {
    playerId = addon.createPlayer().playerId;
    addon.open(playerId, fixture);
    const loadDeadline = Date.now() + 8000;
    while (Date.now() < loadDeadline) {
      const state = addon.pollPlayback(playerId);
      if (state.fileLoaded) break;
      await sleep(20);
    }

    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      const frame = addon.renderFrame(playerId, 1280, 720);
      calls += 1;
      const updateMs = Number(frame?.nativeUpdateMs);
      if (!Number.isFinite(updateMs) || updateMs < 0) throw new Error(`invalid nativeUpdateMs on call ${calls}: ${frame?.nativeUpdateMs}`);
      updateTimingSamples += 1;
      updateMaxMs = Math.max(updateMaxMs, updateMs);

      if (frame?.updated) {
        frames += 1;
        const textureMs = Number(frame.nativeEnsureTextureMs);
        const renderMs = Number(frame.nativeRenderMs);
        if (!Number.isFinite(textureMs) || textureMs < 0) throw new Error(`invalid nativeEnsureTextureMs on frame ${frames}`);
        if (!Number.isFinite(renderMs) || renderMs < 0) throw new Error(`invalid nativeRenderMs on frame ${frames}`);
        textureTimingSamples += 1;
        renderTimingSamples += 1;
        textureMaxMs = Math.max(textureMaxMs, textureMs);
        renderMaxMs = Math.max(renderMaxMs, renderMs);
        if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) throw new Error(`release failed for frame ${frame.frameId}`);
      }
      await sleep(4);
    }

    if (calls < 100) throw new Error(`insufficient renderFrame calls: ${calls}`);
    if (frames < 20) throw new Error(`insufficient rendered frames: ${frames}`);
    if (updateTimingSamples !== calls) throw new Error(`update timing coverage mismatch: ${updateTimingSamples}/${calls}`);
    if (textureTimingSamples !== frames || renderTimingSamples !== frames) {
      throw new Error(`frame timing coverage mismatch: texture=${textureTimingSamples} render=${renderTimingSamples} frames=${frames}`);
    }

    console.log(`LIBMPV_R3D_NATIVE_TIMING_REPORT=${JSON.stringify({ calls, frames, updateMaxMs, textureMaxMs, renderMaxMs })}`);
    console.log('LIBMPV_R3D_NATIVE_TIMING_OK');
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

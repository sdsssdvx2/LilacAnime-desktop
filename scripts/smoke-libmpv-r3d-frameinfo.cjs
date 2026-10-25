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
  const output = path.join(dir, 'r3d-frameinfo-1080p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0, 400)}`);
  return output;
}

async function waitLoaded(addon, playerId) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (addon.pollPlayback(playerId).fileLoaded) return;
    await sleep(15);
  }
  throw new Error('fileLoaded timeout');
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-frameinfo-'));
  const created = addon.createPlayer();
  const playerId = Number(created.playerId);

  const all = [];
  const fresh = [];
  const redraw = [];
  const repeat = [];
  const blockVsync = [];
  const plainPresent = [];
  const unknown = [];
  let callbackSignals = 0;
  let infoErrors = 0;
  let updateNoFrame = 0;

  function record(frame) {
    const ms = Number(frame.nativeRenderMs);
    if (!Number.isFinite(ms) || ms < 0) throw new Error('invalid nativeRenderMs');
    const sample = {
      ms,
      present: frame.nextFramePresent === true,
      redraw: frame.nextFrameRedraw === true,
      repeat: frame.nextFrameRepeat === true,
      blockVsync: frame.nextFrameBlockVsync === true,
      flags: Number(frame.nextFrameInfoFlags) || 0,
      targetTimeNs: Number(frame.nextFrameTargetTimeNs) || 0
    };
    all.push(ms);
    if (sample.present && !sample.redraw) fresh.push(ms);
    if (sample.redraw) redraw.push(ms);
    if (sample.repeat) repeat.push(ms);
    if (sample.blockVsync) blockVsync.push(ms);
    if (sample.present && !sample.redraw && !sample.repeat && !sample.blockVsync) plainPresent.push(ms);
    if (!sample.present && !sample.redraw && !sample.repeat && !sample.blockVsync) unknown.push(ms);
    return sample;
  }

  try {
    const media = buildFixture(dir);
    addon.setUpdateCallback(playerId, () => { callbackSignals += 1; });
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);

    const warmUntil = performance.now() + 1600;
    while (performance.now() < warmUntil) {
      const frame = addon.renderFrame(playerId, 1920, 1080);
      if (frame?.updated) {
        if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) throw new Error('warm release failed');
      }
      await sleep(2);
    }

    const detailed = [];
    const until = performance.now() + 8500;
    while (performance.now() < until) {
      const frame = addon.renderFrame(playerId, 1920, 1080);
      if (!frame?.updated) {
        updateNoFrame += 1;
        await sleep(2);
        continue;
      }
      if (Number(frame.nextFrameInfoRc) < 0) infoErrors += 1;
      const sample = record(frame);
      if (detailed.length < 80) detailed.push({
        renderMs: round(sample.ms),
        present: sample.present,
        redraw: sample.redraw,
        repeat: sample.repeat,
        blockVsync: sample.blockVsync,
        flags: sample.flags
      });
      if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) throw new Error('release failed');
      await sleep(2);
    }

    const report = {
      deviceMode: created.deviceMode,
      callbackSignals,
      infoErrors,
      updateNoFrame,
      totalUpdatedFrames: all.length,
      allRenderMs: summarize(all),
      freshPresentRenderMs: summarize(fresh),
      redrawRenderMs: summarize(redraw),
      repeatRenderMs: summarize(repeat),
      blockVsyncRenderMs: summarize(blockVsync),
      plainPresentRenderMs: summarize(plainPresent),
      unclassifiedRenderMs: summarize(unknown),
      counts: {
        fresh: fresh.length,
        redraw: redraw.length,
        repeat: repeat.length,
        blockVsync: blockVsync.length,
        plainPresent: plainPresent.length,
        unclassified: unknown.length
      },
      samples: detailed
    };
    console.log(`LIBMPV_R3D_FRAMEINFO_REPORT=${JSON.stringify(report)}`);
    if (all.length < 30) throw new Error('insufficient updated-frame samples');
    if (infoErrors !== 0) throw new Error(`frame-info API errors: ${infoErrors}`);
    if (fresh.length < 20) throw new Error(`insufficient fresh-present samples: ${fresh.length}`);
    console.log('LIBMPV_R3D_FRAMEINFO_OK');
  } finally {
    try { addon.destroyPlayer(playerId); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

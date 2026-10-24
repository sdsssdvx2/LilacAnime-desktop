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
  p50: round(percentile(values, 0.50)),
  p95: round(percentile(values, 0.95)),
  p99: round(percentile(values, 0.99)),
  max: round(Math.max(0, ...values))
});

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static missing');
  const output = path.join(dir, 'r3d-target-size-1080p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=32',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=32',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0, 300)}`);
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

async function sampleSize(addon, media, width, height) {
  const created = addon.createPlayer();
  const playerId = Number(created.playerId);
  const renderMs = [];
  const updateMs = [];
  const textureMs = [];
  const wallMs = [];
  const updatedAt = [];
  let renderCalls = 0;
  let updatedFrames = 0;
  let callbackSignals = 0;

  function call(record) {
    const started = performance.now();
    const frame = addon.renderFrame(playerId, width, height);
    const wall = performance.now() - started;
    if (!frame || frame.playerFound === false) throw new Error(`${width}x${height}: no player`);
    if (record) {
      renderCalls += 1;
      wallMs.push(wall);
      updateMs.push(Number(frame.nativeUpdateMs) || 0);
    }
    if (!frame.updated) return;
    if (record) {
      updatedFrames += 1;
      updatedAt.push(performance.now());
      textureMs.push(Number(frame.nativeEnsureTextureMs) || 0);
      renderMs.push(Number(frame.nativeRenderMs) || 0);
    }
    if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) throw new Error(`${width}x${height}: release failed`);
  }

  try {
    addon.setUpdateCallback(playerId, () => { callbackSignals += 1; });
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);
    const warm = performance.now() + 1500;
    while (performance.now() < warm) { call(false); await sleep(2); }
    const start = performance.now();
    const until = start + 5000;
    while (performance.now() < until) { call(true); await sleep(2); }
    const intervals = [];
    for (let i = 1; i < updatedAt.length; i += 1) intervals.push(updatedAt[i] - updatedAt[i - 1]);
    const span = updatedAt.length > 1 ? updatedAt.at(-1) - updatedAt[0] : 0;
    return {
      width, height, pixels: width * height, deviceMode: created.deviceMode, callbackSignals,
      renderCalls, updatedFrames,
      effectiveFps: span > 0 ? round(((updatedAt.length - 1) * 1000) / span) : 0,
      wallMs: summarize(wallMs), nativeUpdateMs: summarize(updateMs),
      nativeEnsureTextureMs: summarize(textureMs), nativeRenderMs: summarize(renderMs),
      frameIntervalMs: summarize(intervals)
    };
  } finally {
    try { addon.destroyPlayer(playerId); } catch {}
  }
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-target-size-'));
  try {
    const media = buildFixture(dir);
    const small = await sampleSize(addon, media, 640, 360);
    const medium = await sampleSize(addon, media, 1280, 720);
    const large = await sampleSize(addon, media, 1920, 1080);
    const smallB = await sampleSize(addon, media, 640, 360);
    const report = { small, medium, large, smallB };
    console.log(`LIBMPV_R3D_TARGET_SIZE_REPORT=${JSON.stringify(report)}`);
    for (const item of [small, medium, large, smallB]) {
      if (item.renderCalls < 20 || item.updatedFrames < 20) throw new Error(`insufficient sample ${item.width}x${item.height}`);
      if (item.nativeUpdateMs.p95 > 10) throw new Error(`update p95 unexpectedly high ${item.width}x${item.height}`);
    }
    console.log('LIBMPV_R3D_TARGET_SIZE_OK');
  } finally {
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

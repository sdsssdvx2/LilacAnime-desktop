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
  const output = path.join(dir, 'r3d-private-target-1080p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=28',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=28',
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

async function sampleMode(addon, media, label, privateTarget) {
  const created = addon.createPlayer();
  const playerId = Number(created.playerId);
  const renderMs = [];
  const copyMs = [];
  const updateMs = [];
  const textureMs = [];
  const wallMs = [];
  const updatedAt = [];
  let renderCalls = 0;
  let updatedFrames = 0;
  let callbackSignals = 0;
  let modeMismatch = 0;

  function call(record) {
    const started = performance.now();
    const frame = addon.renderFrame(playerId, 1920, 1080);
    const wall = performance.now() - started;
    if (!frame || frame.playerFound === false) throw new Error(`${label}: no player`);
    if (record) {
      renderCalls += 1;
      wallMs.push(wall);
      updateMs.push(Number(frame.nativeUpdateMs) || 0);
    }
    if (!frame.updated) return;
    if (Boolean(frame.privateTargetProbe) !== privateTarget) modeMismatch += 1;
    if (record) {
      updatedFrames += 1;
      updatedAt.push(performance.now());
      textureMs.push(Number(frame.nativeEnsureTextureMs) || 0);
      renderMs.push(Number(frame.nativeRenderMs) || 0);
      copyMs.push(Number(frame.nativeExportCopySubmitMs) || 0);
    }
    if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) throw new Error(`${label}: release failed`);
  }

  try {
    addon.setUpdateCallback(playerId, () => { callbackSignals += 1; });
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);
    const warmUntil = performance.now() + 1400;
    while (performance.now() < warmUntil) { call(false); await sleep(2); }
    const until = performance.now() + 5000;
    while (performance.now() < until) { call(true); await sleep(2); }
    const intervals = [];
    for (let i = 1; i < updatedAt.length; i += 1) intervals.push(updatedAt[i] - updatedAt[i - 1]);
    const span = updatedAt.length > 1 ? updatedAt.at(-1) - updatedAt[0] : 0;
    return {
      label,
      mode: privateTarget ? 'private-then-copy' : 'direct-shared',
      privateTarget,
      deviceMode: created.deviceMode,
      callbackSignals,
      renderCalls,
      updatedFrames,
      modeMismatch,
      effectiveFps: span > 0 ? round(((updatedAt.length - 1) * 1000) / span) : 0,
      wallMs: summarize(wallMs),
      nativeUpdateMs: summarize(updateMs),
      nativeEnsureTextureMs: summarize(textureMs),
      nativeRenderMs: summarize(renderMs),
      nativeExportCopySubmitMs: summarize(copyMs),
      frameIntervalMs: summarize(intervals)
    };
  } finally {
    try { addon.destroyPlayer(playerId); } catch {}
  }
}

async function childMain() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  const media = process.env.LILAC_PRIVATE_MEDIA;
  const label = process.env.LILAC_PRIVATE_LABEL || 'child';
  const privateTarget = process.env.LILAC_LIBMPV_TEST_PRIVATE_TARGET === '1';
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('child addon/dll missing');
  if (!media || !fs.existsSync(media)) throw new Error('child media missing');
  // Important: native getenv() must see the probe mode at process startup. The
  // parent supplies all native test env vars before this process is launched.
  const addon = require(addonPath);
  const result = await sampleMode(addon, media, label, privateTarget);
  console.log(`LIBMPV_R3D_PRIVATE_TARGET_CHILD=${JSON.stringify(result)}`);
}

function runChild(media, label, privateTarget) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LILAC_LIBMPV_TEST_AO_NULL: '1',
    LILAC_LIBMPV_TEST_PRIVATE_TARGET: privateTarget ? '1' : '0',
    LILAC_PRIVATE_MEDIA: media,
    LILAC_PRIVATE_LABEL: label
  };
  const result = spawnSync(process.execPath, [__filename, '--child'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} child failed status=${result.status} stdout=${String(result.stdout || '').slice(-1200)} stderr=${String(result.stderr || '').slice(-1200)}`);
  }
  const prefix = 'LIBMPV_R3D_PRIVATE_TARGET_CHILD=';
  const line = String(result.stdout || '').split(/\r?\n/).find(item => item.startsWith(prefix));
  if (!line) throw new Error(`${label} child report missing: ${String(result.stdout || '').slice(-1200)}`);
  return JSON.parse(line.slice(prefix.length));
}

async function parentMain() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-private-target-'));
  try {
    const media = buildFixture(dir);
    const directA = runChild(media, 'directA', false);
    const privateA = runChild(media, 'privateA', true);
    const privateB = runChild(media, 'privateB', true);
    const directB = runChild(media, 'directB', false);
    const directRenderP50 = round((directA.nativeRenderMs.p50 + directB.nativeRenderMs.p50) / 2);
    const privateRenderP50 = round((privateA.nativeRenderMs.p50 + privateB.nativeRenderMs.p50) / 2);
    const directRenderP95 = round((directA.nativeRenderMs.p95 + directB.nativeRenderMs.p95) / 2);
    const privateRenderP95 = round((privateA.nativeRenderMs.p95 + privateB.nativeRenderMs.p95) / 2);
    const report = {
      directA, privateA, privateB, directB,
      summary: {
        directRenderP50,
        privateRenderP50,
        directRenderP95,
        privateRenderP95,
        privateToDirectP50Ratio: directRenderP50 > 0 ? round(privateRenderP50 / directRenderP50) : 0,
        p50ImprovementPct: directRenderP50 > 0 ? round((1 - privateRenderP50 / directRenderP50) * 100) : 0,
        p95ImprovementPct: directRenderP95 > 0 ? round((1 - privateRenderP95 / directRenderP95) * 100) : 0
      }
    };
    console.log(`LIBMPV_R3D_PRIVATE_TARGET_AB_REPORT=${JSON.stringify(report)}`);
    for (const item of [directA, privateA, privateB, directB]) {
      if (item.renderCalls < 20 || item.updatedFrames < 20) throw new Error(`insufficient sample ${item.label}`);
      if (item.modeMismatch !== 0) throw new Error(`probe mode mismatch ${item.label}`);
      if (item.nativeUpdateMs.p95 > 10) throw new Error(`update p95 unexpectedly high ${item.label}`);
    }
    console.log('LIBMPV_R3D_PRIVATE_TARGET_AB_OK');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const entry = process.argv.includes('--child') ? childMain : parentMain;
entry().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

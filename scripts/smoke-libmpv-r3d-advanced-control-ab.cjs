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
  const output = path.join(dir, 'r3d-advanced-control-ab-720p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24000/1001:duration=28',
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
  throw new Error(`fileLoaded timeout player=${playerId}`);
}

async function sample(addon, media, advancedControl) {
  process.env.LILAC_LIBMPV_TEST_ADVANCED_CONTROL = advancedControl ? '1' : '0';
  const created = addon.createPlayer();
  if (Boolean(created.advancedControl) !== advancedControl) {
    throw new Error(`advanced-control creation mismatch requested=${advancedControl} actual=${created.advancedControl}`);
  }
  const playerId = Number(created.playerId);
  const wallMs = [];
  const updateMs = [];
  const textureMs = [];
  const renderMs = [];
  const updatedAt = [];
  let callbackSignals = 0;
  let renderCalls = 0;
  let updatedFrames = 0;

  function renderOnce(record) {
    const started = performance.now();
    const frame = addon.renderPersistentThreadProbe(playerId, 1280, 720);
    const wall = performance.now() - started;
    if (!frame || frame.playerFound === false) throw new Error(`advanced=${advancedControl}: render returned no player`);
    if (record) {
      renderCalls += 1;
      wallMs.push(wall);
      const u = Number(frame.nativeUpdateMs);
      if (!Number.isFinite(u) || u < 0) throw new Error('invalid nativeUpdateMs');
      updateMs.push(u);
    }
    if (!frame.updated) return;
    if (Number(frame.renderRc) < 0) throw new Error(`render rc=${frame.renderRc} error=${frame.error || ''}`);
    if (record) {
      updatedFrames += 1;
      updatedAt.push(performance.now());
      const t = Number(frame.nativeEnsureTextureMs);
      const r = Number(frame.nativeRenderMs);
      if (!Number.isFinite(t) || t < 0 || !Number.isFinite(r) || r < 0) throw new Error('invalid native timing');
      textureMs.push(t);
      renderMs.push(r);
    }
  }

  try {
    addon.setUpdateCallback(playerId, () => { callbackSignals += 1; });
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);

    const warmupUntil = performance.now() + 1700;
    while (performance.now() < warmupUntil) {
      renderOnce(false);
      await sleep(2);
    }
    const sampleStarted = performance.now();
    const sampleUntil = sampleStarted + 5000;
    while (performance.now() < sampleUntil) {
      renderOnce(true);
      await sleep(2);
    }
    const intervals = [];
    for (let i = 1; i < updatedAt.length; i += 1) intervals.push(updatedAt[i] - updatedAt[i - 1]);
    const span = updatedAt.length > 1 ? updatedAt[updatedAt.length - 1] - updatedAt[0] : 0;
    const effectiveFps = span > 0 ? ((updatedAt.length - 1) * 1000) / span : 0;
    return {
      advancedControl,
      deviceMode: created.deviceMode,
      callbackSignals,
      renderCalls,
      updatedFrames,
      effectiveFps: round(effectiveFps),
      wallMs: summarize(wallMs),
      nativeUpdateMs: summarize(updateMs),
      nativeEnsureTextureMs: summarize(textureMs),
      nativeRenderMs: summarize(renderMs),
      frameIntervalMs: summarize(intervals),
      stallsOver20Ms: renderMs.filter(v => v > 20).length,
      stallsOver50Ms: renderMs.filter(v => v > 50).length,
      stallsOver100Ms: renderMs.filter(v => v > 100).length
    };
  } finally {
    try { addon.destroyPlayer(playerId); } catch {}
  }
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath)) throw new Error('LILAC_LIBMPV_PLAYER_ADDON missing');
  if (!dllPath || !fs.existsSync(dllPath)) throw new Error('LILAC_LIBMPV_DLL missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer','open','pollPlayback','setUpdateCallback','renderPersistentThreadProbe','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-advanced-control-ab-'));
  try {
    const media = buildFixture(dir);
    const legacyA = await sample(addon, media, false);
    const advancedA = await sample(addon, media, true);
    const advancedB = await sample(addon, media, true);
    const legacyB = await sample(addon, media, false);
    const report = { legacyA, advancedA, advancedB, legacyB };
    console.log(`LIBMPV_R3D_ADVANCED_CONTROL_AB_REPORT=${JSON.stringify(report)}`);
    for (const item of [legacyA, advancedA, advancedB, legacyB]) {
      if (item.renderCalls < 20 || item.updatedFrames < 20) throw new Error(`insufficient sample advanced=${item.advancedControl}`);
      if (item.nativeUpdateMs.p95 > 10) throw new Error(`update p95 high advanced=${item.advancedControl}: ${item.nativeUpdateMs.p95}`);
      if (item.nativeEnsureTextureMs.p95 > 10) throw new Error(`texture p95 high advanced=${item.advancedControl}: ${item.nativeEnsureTextureMs.p95}`);
    }
    console.log('LIBMPV_R3D_ADVANCED_CONTROL_AB_OK');
  } finally {
    delete process.env.LILAC_LIBMPV_TEST_ADVANCED_CONTROL;
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

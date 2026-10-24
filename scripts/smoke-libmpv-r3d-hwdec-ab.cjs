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
  const output = path.join(dir, 'r3d-hwdec-ab-1080p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=36',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=36',
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
    const state = addon.poll(playerId);
    if (state.fileLoaded) return state;
    await sleep(15);
  }
  throw new Error(`fileLoaded timeout player=${playerId}`);
}

async function sampleMode(addon, media, requestedHwdec) {
  const created = addon.createPlayer();
  const playerId = Number(created.playerId);
  const wallMs = [];
  const updateMs = [];
  const textureMs = [];
  const renderMs = [];
  const updatedAt = [];
  let callbackSignals = 0;
  let renderCalls = 0;
  let updatedFrames = 0;
  let backpressure = 0;

  function renderOnce(record) {
    const started = performance.now();
    const frame = addon.renderFrame(playerId, 1920, 1080);
    const wall = performance.now() - started;
    if (!frame || frame.playerFound === false) throw new Error(`${requestedHwdec}: render returned no player`);
    if (record) {
      renderCalls += 1;
      wallMs.push(wall);
      const u = Number(frame.nativeUpdateMs);
      if (!Number.isFinite(u) || u < 0) throw new Error(`${requestedHwdec}: invalid nativeUpdateMs`);
      updateMs.push(u);
    }
    if (frame.backpressure) backpressure += 1;
    if (!frame.updated) return;
    if (record) {
      updatedFrames += 1;
      updatedAt.push(performance.now());
      const t = Number(frame.nativeEnsureTextureMs);
      const r = Number(frame.nativeRenderMs);
      if (!Number.isFinite(t) || t < 0) throw new Error(`${requestedHwdec}: invalid nativeEnsureTextureMs`);
      if (!Number.isFinite(r) || r < 0) throw new Error(`${requestedHwdec}: invalid nativeRenderMs`);
      textureMs.push(t);
      renderMs.push(r);
    }
    if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
      throw new Error(`${requestedHwdec}: releaseFrame rejected frame ${frame.frameId}`);
    }
  }

  try {
    addon.setUpdateCallback(playerId, () => { callbackSignals += 1; });
    const setResult = addon.command(playerId, ['set', 'hwdec', requestedHwdec]);
    if (setResult === false) throw new Error(`${requestedHwdec}: hwdec command returned false`);
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);

    const activationDeadline = Date.now() + 5000;
    let observedHwdec = null;
    while (Date.now() < activationDeadline) {
      renderOnce(false);
      const state = addon.poll(playerId);
      observedHwdec = state.hwdecCurrent || observedHwdec;
      if (requestedHwdec === 'no') {
        if (!observedHwdec || observedHwdec === 'no') break;
      } else if (observedHwdec) {
        break;
      }
      await sleep(4);
    }

    const warmupUntil = performance.now() + 1600;
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
    const sampleMs = performance.now() - sampleStarted;
    const finalState = addon.poll(playerId);
    observedHwdec = finalState.hwdecCurrent || observedHwdec || null;
    const intervals = [];
    for (let i = 1; i < updatedAt.length; i += 1) intervals.push(updatedAt[i] - updatedAt[i - 1]);
    const span = updatedAt.length > 1 ? updatedAt[updatedAt.length - 1] - updatedAt[0] : 0;
    const effectiveFps = span > 0 ? ((updatedAt.length - 1) * 1000) / span : 0;
    const countOver = threshold => renderMs.filter(value => value > threshold).length;

    return {
      requestedHwdec,
      observedHwdec,
      hwdecActive: Boolean(observedHwdec && observedHwdec !== 'no'),
      deviceMode: created.deviceMode,
      callbackSignals,
      sampleMs: round(sampleMs),
      renderCalls,
      updatedFrames,
      backpressure,
      effectiveFps: round(effectiveFps),
      wallMs: summarize(wallMs),
      nativeUpdateMs: summarize(updateMs),
      nativeEnsureTextureMs: summarize(textureMs),
      nativeRenderMs: summarize(renderMs),
      frameIntervalMs: summarize(intervals),
      stallsOver20Ms: countOver(20),
      stallsOver50Ms: countOver(50),
      stallsOver100Ms: countOver(100),
      decoderFrameDropCount: finalState.decoderFrameDropCount ?? null
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
  for (const name of ['createPlayer','open','command','poll','setUpdateCallback','renderFrame','releaseFrame','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing addon export ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-hwdec-ab-'));
  try {
    const media = buildFixture(dir);
    // Balanced order reduces runner warm-up bias. Repeat auto-safe to establish drift.
    const autoA = await sampleMode(addon, media, 'auto-safe');
    const copy = await sampleMode(addon, media, 'd3d11va-copy');
    const software = await sampleMode(addon, media, 'no');
    const autoB = await sampleMode(addon, media, 'auto-safe');
    const report = { autoA, copy, software, autoB };
    console.log(`LIBMPV_R3D_HWDEC_AB_REPORT=${JSON.stringify(report)}`);

    for (const sample of [autoA, copy, software, autoB]) {
      if (sample.renderCalls < 20) throw new Error(`${sample.requestedHwdec}: insufficient render calls ${sample.renderCalls}`);
      if (sample.updatedFrames < 20) throw new Error(`${sample.requestedHwdec}: insufficient updated frames ${sample.updatedFrames}`);
      if (sample.backpressure !== 0) throw new Error(`${sample.requestedHwdec}: unexpected backpressure ${sample.backpressure}`);
      if (sample.nativeUpdateMs.p95 > 10) throw new Error(`${sample.requestedHwdec}: update p95 unexpectedly high ${sample.nativeUpdateMs.p95}`);
      if (sample.nativeEnsureTextureMs.p95 > 10) throw new Error(`${sample.requestedHwdec}: texture p95 unexpectedly high ${sample.nativeEnsureTextureMs.p95}`);
    }

    // Do not fail solely because the hosted VM cannot expose D3D11VA. The report
    // must state the actually selected decoder so unsupported comparisons are
    // never mistaken for hardware evidence.
    const hardwareComparable = autoA.hwdecActive && copy.hwdecActive;
    console.log(`LIBMPV_R3D_HWDEC_AB_OK hardwareComparable=${hardwareComparable ? 1 : 0} auto=${autoA.observedHwdec || 'none'} copy=${copy.observedHwdec || 'none'} software=${software.observedHwdec || 'none'}`);
  } finally {
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

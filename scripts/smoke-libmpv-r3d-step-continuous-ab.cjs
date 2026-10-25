'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = v => Math.round(Number(v || 0) * 1000) / 1000;
const percentile = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a,b) => a-b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const summarize = values => ({
  count: values.length,
  p50: round(percentile(values, .5)),
  p95: round(percentile(values, .95)),
  p99: round(percentile(values, .99)),
  max: round(Math.max(0, ...values))
});

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'step-continuous.mp4');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1920x1080:rate=24000/1001:duration=35',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=35',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-g','24','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',out
  ], {encoding:'utf8', windowsHide:true, timeout:180000});
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed: ${String(r.stderr||'').slice(0,400)}`);
  return out;
}

function isPlainPresent(frame) {
  return Number(frame?.nextFrameInfoRc) >= 0 && frame?.nextFramePresent === true &&
    frame?.nextFrameRedraw !== true && frame?.nextFrameRepeat !== true && frame?.nextFrameBlockVsync !== true;
}

async function waitLoaded(addon, id) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (addon.pollPlayback(id).fileLoaded) return;
    await sleep(15);
  }
  throw new Error('fileLoaded timeout');
}

function release(addon, id, frame) {
  if (!addon.releaseFrame(id, frame.slotId, frame.frameId)) throw new Error('release failed');
}

async function drainPaused(addon, id) {
  const end = performance.now() + 2500;
  let quiet = 0;
  let drained = 0;
  while (performance.now() < end) {
    const f = addon.renderFrame(id, 1920, 1080);
    if (f?.updated) {
      release(addon, id, f);
      drained += 1;
      quiet = 0;
    } else {
      quiet += 1;
      if (quiet >= 4) return drained;
    }
    await sleep(3);
  }
  throw new Error('paused pipeline did not settle');
}

async function collectContinuous(addon, id, label, target, timeoutMs) {
  const values = [];
  let nonPlain = 0;
  let noFrame = 0;
  const sampleFlags = [];
  const end = performance.now() + timeoutMs;
  while (performance.now() < end && values.length < target) {
    const f = addon.renderFrame(id, 1920, 1080);
    if (!f?.updated) {
      noFrame += 1;
      await sleep(2);
      continue;
    }
    if (isPlainPresent(f)) {
      values.push(Number(f.nativeRenderMs));
      if (sampleFlags.length < 8) sampleFlags.push(Number(f.nextFrameInfoFlags));
    } else {
      nonPlain += 1;
    }
    release(addon, id, f);
    await sleep(2);
  }
  if (values.length < Math.min(24, target)) throw new Error(`${label}: insufficient plain PRESENT frames ${values.length}`);
  return { label, values, nonPlain, noFrame, sampleFlags };
}

async function stepOnce(addon, id, label) {
  addon.command(id, ['frame-step']);
  const end = performance.now() + 5000;
  let nonPlain = 0;
  let noFrame = 0;
  while (performance.now() < end) {
    const f = addon.renderFrame(id, 1920, 1080);
    if (!f?.updated) {
      noFrame += 1;
      await sleep(2);
      continue;
    }
    const plain = isPlainPresent(f);
    const ms = Number(f.nativeRenderMs);
    const flags = Number(f.nextFrameInfoFlags) || 0;
    release(addon, id, f);
    if (plain) return { ms, flags, nonPlain, noFrame };
    nonPlain += 1;
    await sleep(1);
  }
  throw new Error(`${label}: frame-step plain PRESENT timeout`);
}

async function collectSteps(addon, id, label, count, gapMs) {
  const values = [];
  let nonPlain = 0;
  let noFrame = 0;
  const flags = [];
  for (let i = 0; i < count; i += 1) {
    const s = await stepOnce(addon, id, label);
    if (!Number.isFinite(s.ms) || s.ms < 0) throw new Error(`${label}: invalid render ms`);
    values.push(s.ms);
    nonPlain += s.nonPlain;
    noFrame += s.noFrame;
    if (flags.length < 8) flags.push(s.flags);
    if (gapMs) await sleep(gapMs);
  }
  return { label, values, nonPlain, noFrame, sampleFlags: flags };
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const n of ['createPlayer','open','command','pollPlayback','renderFrame','releaseFrame','destroyPlayer']) {
    if (typeof addon[n] !== 'function') throw new Error(`addon missing ${n}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-step-continuous-'));
  const created = addon.createPlayer();
  const id = Number(created.playerId);
  let callbackSignals = 0;
  try {
    const media = buildFixture(dir);
    addon.setUpdateCallback(id, () => { callbackSignals += 1; });
    addon.open(id, media);
    await waitLoaded(addon, id);

    // Warm the continuous pipeline without recording.
    const warmEnd = performance.now() + 1500;
    while (performance.now() < warmEnd) {
      const f = addon.renderFrame(id, 1920, 1080);
      if (f?.updated) release(addon, id, f);
      await sleep(2);
    }

    const continuousA = await collectContinuous(addon, id, 'continuousA', 32, 6500);

    addon.command(id, ['set','pause','yes']);
    await sleep(80);
    const drainedBeforeSteps = await drainPaused(addon, id);

    // Idle gaps test queue pressure after each proven PRESENT frame.
    const stepIdle = await collectSteps(addon, id, 'stepIdle', 18, 120);
    const stepBurst = await collectSteps(addon, id, 'stepBurst', 24, 2);

    const drainedAfterSteps = await drainPaused(addon, id);
    addon.command(id, ['set','pause','no']);
    await sleep(300);
    const continuousB = await collectContinuous(addon, id, 'continuousB', 32, 6500);

    const continuousValues = [...continuousA.values, ...continuousB.values];
    const continuous = summarize(continuousValues);
    const idle = summarize(stepIdle.values);
    const burst = summarize(stepBurst.values);
    const report = {
      deviceMode: created.deviceMode,
      callbackSignals,
      drainedBeforeSteps,
      drainedAfterSteps,
      continuousA: {...continuousA, values: undefined, renderMs: summarize(continuousA.values)},
      stepIdle: {...stepIdle, values: undefined, gapMs:120, renderMs:idle},
      stepBurst: {...stepBurst, values: undefined, gapMs:2, renderMs:burst},
      continuousB: {...continuousB, values: undefined, renderMs: summarize(continuousB.values)},
      combined: {
        continuousRenderMs: continuous,
        stepIdleRenderMs: idle,
        stepBurstRenderMs: burst,
        idleToContinuousP50Ratio: continuous.p50 > 0 ? round(idle.p50 / continuous.p50) : null,
        burstToContinuousP50Ratio: continuous.p50 > 0 ? round(burst.p50 / continuous.p50) : null,
        continuousToIdleP50Ratio: idle.p50 > 0 ? round(continuous.p50 / idle.p50) : null,
        continuousToBurstP50Ratio: burst.p50 > 0 ? round(continuous.p50 / burst.p50) : null
      }
    };
    console.log(`LIBMPV_R3D_STEP_CONTINUOUS_REPORT=${JSON.stringify(report)}`);

    if (continuous.count < 48) throw new Error('insufficient combined continuous samples');
    if (idle.count !== 18 || burst.count !== 24) throw new Error('step sample count mismatch');
    for (const group of [continuousA, stepIdle, stepBurst, continuousB]) {
      if (group.sampleFlags.some(f => f !== 1)) throw new Error(`${group.label}: non-plain frame-info flags in accepted samples`);
    }
    console.log('LIBMPV_R3D_STEP_CONTINUOUS_OK allAcceptedFlags=1');
  } finally {
    try { addon.destroyPlayer(id); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, {recursive:true, force:true}); } catch {}
  }
}

main().catch(e => { console.error(e?.stack || e); process.exitCode = 1; });

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
  const output = path.join(dir, 'r3d-fresh-redraw-1080p.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001:duration=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=24',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`fixture encode failed: ${String(result.stderr || '').slice(0, 400)}`);
  }
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

async function waitFresh(addon, playerId, deadlineMs = 8000) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    const frame = addon.renderFrame(playerId, 1920, 1080);
    if (frame?.updated) return frame;
    await sleep(2);
  }
  throw new Error('fresh frame timeout');
}

function release(addon, playerId, frame) {
  if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) throw new Error('release failed');
}

async function settleAndRedraw(addon, playerId, freshFrame, maxExtraFresh = 8) {
  let latestFresh = freshFrame;
  release(addon, playerId, latestFresh);

  for (let i = 0; i <= maxExtraFresh; i += 1) {
    const probe = addon.renderRedrawProbe(playerId, 1920, 1080);
    if (probe?.ready) {
      const second = addon.renderRedrawProbe(playerId, 1920, 1080);
      if (!second?.ready || second?.pendingFreshFrame) {
        throw new Error('second redraw was not stable');
      }
      return { latestFresh, redrawA: probe, redrawB: second, extraFresh: i };
    }
    if (!probe?.pendingFreshFrame) throw new Error(`redraw probe not ready without pending frame: ${JSON.stringify(probe)}`);
    latestFresh = await waitFresh(addon, playerId, 3000);
    release(addon, playerId, latestFresh);
  }
  throw new Error('too many pending fresh frames while paused');
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  for (const name of ['createPlayer', 'open', 'command', 'pollPlayback', 'renderFrame', 'renderRedrawProbe', 'releaseFrame', 'destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`addon missing ${name}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3d-fresh-redraw-'));
  const created = addon.createPlayer();
  const playerId = Number(created.playerId);
  const pairs = [];
  const freshMs = [];
  const redrawMs = [];
  const redrawFirstMs = [];
  const redrawSecondMs = [];
  const updateMs = [];
  const extraFreshCounts = [];

  try {
    const media = buildFixture(dir);
    addon.open(playerId, media);
    await waitLoaded(addon, playerId);
    addon.command(playerId, ['set', 'pause', 'yes']);
    await sleep(120);

    // Consume any frame already queued when pause took effect, then verify a stable redraw state.
    for (let i = 0; i < 8; i += 1) {
      const probe = addon.renderRedrawProbe(playerId, 1920, 1080);
      if (probe?.ready) break;
      if (!probe?.pendingFreshFrame) throw new Error('initial redraw stabilization failed');
      const frame = await waitFresh(addon, playerId, 3000);
      release(addon, playerId, frame);
    }

    const positions = [0.75, 1.65, 2.55, 3.45, 4.35, 5.25, 6.15, 7.05, 7.95, 8.85, 9.75, 10.65, 11.55, 12.45, 13.35, 14.25, 15.15, 16.05];
    for (const position of positions) {
      addon.command(playerId, ['seek', String(position), 'absolute+exact']);
      const firstFresh = await waitFresh(addon, playerId, 8000);
      const settled = await settleAndRedraw(addon, playerId, firstFresh);
      const f = Number(settled.latestFresh.nativeRenderMs);
      const r1 = Number(settled.redrawA.nativeRedrawRenderMs);
      const r2 = Number(settled.redrawB.nativeRedrawRenderMs);
      const u = Number(settled.redrawA.nativeUpdateMs);
      if (![f, r1, r2, u].every(Number.isFinite)) throw new Error('non-finite timing sample');
      freshMs.push(f);
      redrawFirstMs.push(r1);
      redrawSecondMs.push(r2);
      redrawMs.push(r1, r2);
      updateMs.push(u);
      extraFreshCounts.push(settled.extraFresh);
      pairs.push({
        position,
        freshRenderMs: round(f),
        redrawFirstMs: round(r1),
        redrawSecondMs: round(r2),
        redrawUpdateMs: round(u),
        extraFresh: settled.extraFresh,
        firstRedrawToFreshRatio: f > 0 ? round(r1 / f) : null
      });
      await sleep(35);
    }

    const freshSummary = summarize(freshMs);
    const redrawSummary = summarize(redrawMs);
    const report = {
      deviceMode: created.deviceMode,
      samples: pairs.length,
      freshRenderMs: freshSummary,
      redrawRenderMs: redrawSummary,
      redrawFirstMs: summarize(redrawFirstMs),
      redrawSecondMs: summarize(redrawSecondMs),
      redrawUpdateMs: summarize(updateMs),
      extraFreshCounts: summarize(extraFreshCounts),
      redrawToFreshP50Ratio: freshSummary.p50 > 0 ? round(redrawSummary.p50 / freshSummary.p50) : null,
      redrawImprovementPct: freshSummary.p50 > 0 ? round((1 - redrawSummary.p50 / freshSummary.p50) * 100) : null,
      pairs
    };
    console.log(`LIBMPV_R3D_FRESH_REDRAW_REPORT=${JSON.stringify(report)}`);
    if (pairs.length < 12) throw new Error('insufficient paired samples');
    if (freshSummary.p50 <= 0 || redrawSummary.p50 <= 0) throw new Error('invalid render timings');
    if (updateMs.some(v => v > 10)) throw new Error('redraw update guard unexpectedly slow');
    console.log('LIBMPV_R3D_FRESH_REDRAW_OK');
  } finally {
    try { addon.destroyPlayer(playerId); } catch {}
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

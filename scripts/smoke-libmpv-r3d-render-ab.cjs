'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(Number(value || 0) * 1000) / 1000;
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function ensureFixture() {
  const requested = process.env.LILAC_R3D_FIXTURE;
  const output = requested || path.join(os.tmpdir(), 'lilac-r3d-fhd-ab.mp4');
  if (fs.existsSync(output) && fs.statSync(output).size > 100000) return output;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const ffmpeg = require('ffmpeg-static');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1920x1080:rate=24000/1001:duration=10',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=10',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',output
  ], { encoding:'utf8', windowsHide:true, timeout:120000 });
  if (r.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture encode failed: ${String(r.stderr||'').slice(0,240)}`);
  return output;
}

async function main() {
  const addon = require(process.env.LILAC_LIBMPV_PLAYER_ADDON);
  const mode = process.env.LILAC_R3D_MODE || 'legacy';
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const media = ensureFixture();
  let id = null;
  let wake = true;
  let signals = 0;
  const all = [], updated = [], intervals = [];
  let lastUpdatedAt = 0;
  try {
    const created = addon.createPlayer();
    id = Number(created.playerId);
    addon.setUpdateCallback(id, () => { signals += 1; wake = true; });
    addon.open(id, media);
    const deadline = Date.now() + 8000;
    let loaded = false;
    while (Date.now() < deadline) {
      const s = addon.pollPlayback(id);
      if (s.fileLoaded) { loaded = true; break; }
      await sleep(15);
    }
    if (!loaded) throw new Error('fileLoaded timeout');

    // Warm up without recording; react to update callbacks, with a short fallback.
    const warmUntil = performance.now() + 1500;
    while (performance.now() < warmUntil) {
      if (!wake) { await sleep(2); continue; }
      wake = false;
      const f = addon.renderFrame(id, 1920, 1080);
      if (f?.updated) addon.releaseFrame(id, f.slotId, f.frameId);
    }

    wake = true;
    const sampleStart = performance.now();
    const sampleUntil = sampleStart + 4200;
    while (performance.now() < sampleUntil) {
      if (!wake) { await sleep(2); wake = true; continue; }
      wake = false;
      const started = performance.now();
      const f = addon.renderFrame(id, 1920, 1080);
      const elapsed = performance.now() - started;
      all.push(elapsed);
      if (f?.updated) {
        const now = performance.now();
        if (lastUpdatedAt) intervals.push(now - lastUpdatedAt);
        lastUpdatedAt = now;
        updated.push(elapsed);
        addon.releaseFrame(id, f.slotId, f.frameId);
      }
    }
    const span = intervals.reduce((sum, v) => sum + v, 0);
    const effectiveFps = span > 0 ? intervals.length * 1000 / span : 0;
    const report = {
      mode,
      advancedControl: process.env.LILAC_LIBMPV_ADVANCED_CONTROL === '1',
      forceDr: process.env.LILAC_LIBMPV_FORCE_DR === '1',
      deviceMode: created.deviceMode,
      signals,
      calls: all.length,
      updatedFrames: updated.length,
      effectiveFps: round(effectiveFps),
      renderMs: {
        p50: round(percentile(updated, .50)),
        p95: round(percentile(updated, .95)),
        p99: round(percentile(updated, .99)),
        max: round(Math.max(0, ...updated))
      },
      intervalMs: {
        p50: round(percentile(intervals, .50)),
        p95: round(percentile(intervals, .95)),
        max: round(Math.max(0, ...intervals))
      }
    };
    console.log(`LIBMPV_R3D_RENDER_AB_REPORT=${JSON.stringify(report)}`);
    if (updated.length < 20) throw new Error(`insufficient FHD sample: ${updated.length}`);
  } finally {
    if (id != null) { try { addon.destroyPlayer(id); } catch {} }
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
  }
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

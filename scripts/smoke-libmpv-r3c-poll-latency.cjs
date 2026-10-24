'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const round = value => Math.round(value * 1000) / 1000;

function fixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const output = path.join(dir, 'r3c-poll.mp4');
  const r = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24000/1001:duration=7',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=7',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', output
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r.status !== 0 || !fs.existsSync(output)) throw new Error(`fixture failed: ${String(r.stderr || '').slice(0, 200)}`);
  return output;
}

async function main() {
  const addon = require(process.env.LILAC_LIBMPV_PLAYER_ADDON);
  for (const name of ['createPlayer','open','poll','pollPlayback','renderFrame','releaseFrame','destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing ${name}`);
  }
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r3c-poll-'));
  const media = fixture(dir);
  let id = null;
  let run = true;
  let wake = false;
  let loop = null;
  try {
    id = Number(addon.createPlayer().playerId);
    if (typeof addon.setUpdateCallback === 'function') addon.setUpdateCallback(id, () => { wake = true; });
    addon.open(id, media);

    const loadedUntil = Date.now() + 8000;
    while (Date.now() < loadedUntil) {
      const s = addon.pollPlayback(id);
      if (s.fileLoaded) break;
      await sleep(15);
    }

    loop = setInterval(() => {
      if (!run || !wake) return;
      wake = false;
      try {
        const f = addon.renderFrame(id, 640, 360);
        if (f?.updated) addon.releaseFrame(id, f.slotId, f.frameId);
      } catch {}
    }, 2);

    await sleep(500);
    const fast = [];
    const full = [];
    for (let i = 0; i < 80; i += 1) {
      let t = performance.now();
      const state = addon.pollPlayback(id);
      if (!Number.isFinite(Number(state.volume)) || !Number.isFinite(Number(state.speed)) || typeof state.mute !== 'boolean') {
        throw new Error(`lightweight command state missing: ${JSON.stringify({volume:state.volume,speed:state.speed,mute:state.mute})}`);
      }
      fast.push(performance.now() - t);
      if (i % 4 === 0) {
        t = performance.now();
        addon.poll(id);
        full.push(performance.now() - t);
      }
      await sleep(8);
    }

    const report = {
      fast: { samples: fast.length, p50Ms: round(percentile(fast,.5)), p95Ms: round(percentile(fast,.95)), maxMs: round(Math.max(...fast)) },
      full: { samples: full.length, p50Ms: round(percentile(full,.5)), p95Ms: round(percentile(full,.95)), maxMs: round(Math.max(...full)) }
    };
    console.log(`LIBMPV_R3C_POLL_LATENCY_REPORT=${JSON.stringify(report)}`);
    if (report.fast.p95Ms > 12) throw new Error(`lightweight state poll p95 too high: ${report.fast.p95Ms}`);
    if (report.fast.maxMs > 40) throw new Error(`lightweight state poll max too high: ${report.fast.maxMs}`);
    console.log('LIBMPV_R3C_POLL_LATENCY_OK commandState=volume+speed+mute');
  } finally {
    run = false;
    if (loop) clearInterval(loop);
    if (id != null) { try { addon.destroyPlayer(id); } catch {} }
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

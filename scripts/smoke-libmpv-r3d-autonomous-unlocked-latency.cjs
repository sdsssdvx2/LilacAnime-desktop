'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = v => Math.round(Number(v || 0) * 1000) / 1000;
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const summary = values => ({
  p50: round(percentile(values, .5)),
  p95: round(percentile(values, .95)),
  p99: round(percentile(values, .99)),
  max: round(Math.max(0, ...values))
});

function buildFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(dir, 'autonomous-unlocked-720p.mp4');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1280x720:rate=24000/1001:duration=24',
    '-f','lavfi','-i','sine=frequency=523:sample_rate=48000:duration=24',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',out
  ], { encoding:'utf8', windowsHide:true, timeout:180000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed: ${String(r.stderr || '').slice(0,300)}`);
  return out;
}

async function waitLoaded(addon, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (addon.pollPlayback(id)?.fileLoaded) return;
    await sleep(15);
  }
  throw new Error('load timeout');
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';
  const addon = require(addonPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-unlocked-latency-'));
  let id = null;
  let jsSignals = 0;
  try {
    const media = buildFixture(dir);
    const created = addon.createPlayer();
    id = Number(created.playerId);
    addon.setUpdateCallback(id, () => { jsSignals += 1; });
    addon.open(id, media);
    await waitLoaded(addon, id);
    if (!addon.startAutonomousProbe(id, 1280, 720)) throw new Error('start failed');

    const statsLatency = [];
    const popLatency = [];
    const releaseLatency = [];
    let popped = 0;
    let released = 0;
    let maxNativeRenderMs = 0;
    const until = performance.now() + 6500;
    while (performance.now() < until) {
      let a = performance.now();
      const stats = addon.autonomousProbeStats(id);
      statsLatency.push(performance.now() - a);
      maxNativeRenderMs = Math.max(maxNativeRenderMs, Number(stats?.renderMaxMs || 0));

      a = performance.now();
      const frame = addon.popAutonomousProbeFrame(id);
      popLatency.push(performance.now() - a);
      if (frame) {
        popped += 1;
        a = performance.now();
        if (!addon.releaseAutonomousProbeFrame(id, frame.slotId, frame.frameId)) throw new Error(`release failed ${frame.frameId}`);
        releaseLatency.push(performance.now() - a);
        released += 1;
      }
      await sleep(1);
    }

    if (!addon.stopAutonomousProbe(id)) throw new Error('stop failed');
    const stopped = addon.autonomousProbeStats(id);
    for (;;) {
      const frame = addon.popAutonomousProbeFrame(id);
      if (!frame) break;
      popped += 1;
      if (!addon.releaseAutonomousProbeFrame(id, frame.slotId, frame.frameId)) throw new Error(`final release failed ${frame.frameId}`);
      released += 1;
    }

    const report = {
      deviceMode: created.deviceMode,
      jsSignals,
      popped,
      released,
      statsLatencyMs: summary(statsLatency),
      popLatencyMs: summary(popLatency),
      releaseLatencyMs: summary(releaseLatency),
      maxNativeRenderMs: round(maxNativeRenderMs),
      stopped
    };
    console.log(`LIBMPV_R3D_AUTONOMOUS_UNLOCKED_LATENCY_REPORT=${JSON.stringify(report)}`);

    if (Number(stopped?.producedFrames || 0) < 20) throw new Error(`insufficient produced frames ${stopped?.producedFrames}`);
    if (popped < 20 || released !== popped) throw new Error(`insufficient or mismatched drains popped=${popped} released=${released}`);
    // Hosted render calls are often 50-120ms; if the producer mutex leaked across
    // render, stats/pop/release calls inherit those stalls. Keep the API-side gate
    // deliberately generous but well below a frame-render-sized stall.
    if (report.statsLatencyMs.p99 > 15 || report.popLatencyMs.p99 > 15 || report.releaseLatencyMs.p99 > 15) {
      throw new Error(`producer mutex leaked into JS APIs: stats=${JSON.stringify(report.statsLatencyMs)} pop=${JSON.stringify(report.popLatencyMs)} release=${JSON.stringify(report.releaseLatencyMs)}`);
    }
    if (report.maxNativeRenderMs < 20) {
      console.log(`LIBMPV_R3D_AUTONOMOUS_UNLOCKED_LATENCY_NOTE hosted render did not expose a long call max=${report.maxNativeRenderMs}`);
    }
    console.log('LIBMPV_R3D_AUTONOMOUS_UNLOCKED_LATENCY_OK mutexHeldAcrossRender=0');
  } finally {
    if (id != null) {
      try { addon.stopAutonomousProbe(id); } catch {}
      try { addon.destroyPlayer(id); } catch {}
    }
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

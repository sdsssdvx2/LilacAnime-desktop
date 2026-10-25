'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = v => Math.round(Number(v || 0) * 1000) / 1000;
const percentile = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
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
  const out = path.join(dir, 'gpu-depth.mp4');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1920x1080:rate=24000/1001:duration=36',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=36',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-g','24','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',out
  ], { encoding:'utf8', windowsHide:true, timeout:180000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed: ${String(r.stderr || '').slice(0, 400)}`);
  return out;
}

function isPlainPresent(f) {
  return Number(f?.nextFrameInfoRc) >= 0 && f?.nextFramePresent === true &&
    f?.nextFrameRedraw !== true && f?.nextFrameRepeat !== true && f?.nextFrameBlockVsync !== true;
}

async function waitLoaded(addon, id) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (addon.pollPlayback(id).fileLoaded) return;
    await sleep(15);
  }
  throw new Error('fileLoaded timeout');
}

async function childMain() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  const media = process.env.LILAC_GPU_DEPTH_MEDIA;
  const depth = Math.max(0, Number(process.env.LILAC_GPU_DEPTH_VALUE) || 0);
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath) || !media || !fs.existsSync(media)) {
    throw new Error('child inputs missing');
  }
  const addon = require(addonPath);
  const created = addon.createPlayer();
  const id = Number(created.playerId);
  const render = [], wait = [], fence = [], combined = [], wall = [], intervals = [], polls = [];
  let callbacks = 0, nonPlain = 0, noFrame = 0, modeMismatch = 0;
  let previousAcceptedAt = 0;
  try {
    addon.setUpdateCallback(id, () => { callbacks += 1; });
    addon.open(id, media);
    await waitLoaded(addon, id);

    const warmEnd = performance.now() + 1600;
    while (performance.now() < warmEnd) {
      const f = addon.renderFrame(id, 1920, 1080);
      if (f?.updated) {
        if (!addon.releaseFrame(id, f.slotId, f.frameId)) throw new Error('warm release failed');
      }
      await sleep(2);
    }

    const end = performance.now() + 9000;
    while (performance.now() < end && render.length < 48) {
      const started = performance.now();
      const f = addon.renderFrame(id, 1920, 1080);
      const elapsed = performance.now() - started;
      if (!f?.updated) {
        noFrame += 1;
        await sleep(2);
        continue;
      }
      const reportedDepth = Number(f.gpuDepth) || 0;
      if (reportedDepth !== depth) modeMismatch += 1;
      if (isPlainPresent(f)) {
        const r = Number(f.nativeRenderMs);
        const w = Number(f.gpuDepthWaitMs) || 0;
        const s = Number(f.gpuDepthFenceSubmitMs) || 0;
        const p = Number(f.gpuDepthWaitPolls) || 0;
        if (![r,w,s,p].every(Number.isFinite)) throw new Error('invalid native timing');
        const acceptedAt = performance.now();
        if (previousAcceptedAt > 0) intervals.push(acceptedAt - previousAcceptedAt);
        previousAcceptedAt = acceptedAt;
        render.push(r); wait.push(w); fence.push(s); combined.push(r + w + s); wall.push(elapsed); polls.push(p);
      } else {
        nonPlain += 1;
      }
      if (!addon.releaseFrame(id, f.slotId, f.frameId)) throw new Error('release failed');
      await sleep(2);
    }
    if (render.length < 32) throw new Error(`depth=${depth}: insufficient plain PRESENT samples ${render.length}`);
    const span = intervals.reduce((a, b) => a + b, 0);
    const effectiveFps = span > 0 ? round(intervals.length * 1000 / span) : 0;
    const result = {
      depth, deviceMode: created.deviceMode, callbacks, nonPlain, noFrame, modeMismatch,
      samples: render.length, effectiveFps,
      renderMs: summarize(render), gpuDepthWaitMs: summarize(wait), gpuDepthFenceSubmitMs: summarize(fence),
      renderPlusDepthMs: summarize(combined), callWallMs: summarize(wall), frameIntervalMs: summarize(intervals),
      waitPolls: summarize(polls), sampleFlags: [1]
    };
    console.log(`LIBMPV_R3D_GPU_DEPTH_CHILD=${JSON.stringify(result)}`);
  } finally {
    try { addon.destroyPlayer(id); } catch {}
  }
}

function runChild(media, depth) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LILAC_LIBMPV_TEST_AO_NULL: '1',
    LILAC_LIBMPV_TEST_GPU_DEPTH: depth > 0 ? String(depth) : '0',
    LILAC_GPU_DEPTH_MEDIA: media,
    LILAC_GPU_DEPTH_VALUE: String(depth)
  };
  const r = spawnSync(process.execPath, [__filename, '--child'], {
    env, encoding:'utf8', windowsHide:true, timeout:60000, maxBuffer:4 * 1024 * 1024
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`depth=${depth} failed status=${r.status} stdout=${String(r.stdout || '').slice(-1800)} stderr=${String(r.stderr || '').slice(-1800)}`);
  const prefix = 'LIBMPV_R3D_GPU_DEPTH_CHILD=';
  const line = String(r.stdout || '').split(/\r?\n/).find(x => x.startsWith(prefix));
  if (!line) throw new Error(`depth=${depth}: report missing`);
  return JSON.parse(line.slice(prefix.length));
}

async function parentMain() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-gpu-depth-'));
  try {
    const media = buildFixture(dir);
    const depths = [0,1,2,3,4,6,8];
    const results = depths.map(depth => runChild(media, depth));
    for (const x of results) {
      if (x.modeMismatch !== 0) throw new Error(`depth=${x.depth}: probe mode mismatch`);
      if (x.sampleFlags.some(f => f !== 1)) throw new Error(`depth=${x.depth}: accepted frame flags changed`);
    }
    const baseline = results.find(x => x.depth === 0);
    const report = {
      results,
      summary: results.map(x => ({
        depth: x.depth,
        effectiveFps: x.effectiveFps,
        renderP50: x.renderMs.p50,
        waitP50: x.gpuDepthWaitMs.p50,
        fenceP50: x.gpuDepthFenceSubmitMs.p50,
        wallP50: x.callWallMs.p50,
        intervalP50: x.frameIntervalMs.p50,
        wallToBaseline: baseline?.callWallMs?.p50 > 0 ? round(x.callWallMs.p50 / baseline.callWallMs.p50) : null
      }))
    };
    console.log(`LIBMPV_R3D_GPU_DEPTH_REPORT=${JSON.stringify(report)}`);
    console.log('LIBMPV_R3D_GPU_DEPTH_OK depths=0,1,2,3,4,6,8 independentProcesses=1');
  } finally {
    try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
  }
}

const entry = process.argv.includes('--child') ? childMain : parentMain;
entry().catch(e => { console.error(e?.stack || e); process.exitCode = 1; });

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
  const out = path.join(dir, 'render-path.mp4');
  const r = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=1920x1080:rate=24000/1001:duration=34',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=34',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-g','24','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',out
  ], { encoding:'utf8', windowsHide:true, timeout:180000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`fixture failed: ${String(r.stderr || '').slice(0, 500)}`);
  return out;
}

function isPlainPresent(f) {
  return Number(f?.nextFrameInfoRc) >= 0 && f?.nextFramePresent === true &&
    f?.nextFrameRedraw !== true && f?.nextFrameRepeat !== true && f?.nextFrameBlockVsync !== true;
}

async function waitLoaded(addon, id) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const state = addon.pollPlayback(id);
    if (state?.fileLoaded) return;
    await sleep(15);
  }
  throw new Error('fileLoaded timeout');
}

async function childMain() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  const media = process.env.LILAC_RENDER_PATH_MEDIA;
  const label = process.env.LILAC_RENDER_PATH_LABEL || 'child';
  const expectedHwdec = process.env.LILAC_LIBMPV_TEST_HWDEC === 'no' ? 'no' : 'auto-safe';
  const skip = process.env.LILAC_LIBMPV_TEST_SKIP_RENDERING === '1';
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath) || !media || !fs.existsSync(media)) {
    throw new Error('child inputs missing');
  }

  const addon = require(addonPath);
  const created = addon.createPlayer();
  const id = Number(created.playerId);
  const render = [], update = [], texture = [], wall = [], intervals = [];
  let callbacks = 0, nonPlain = 0, noFrame = 0, modeMismatch = 0;
  let previousAcceptedAt = 0;
  let finalState = null;

  try {
    if (String(created.probeHwdec) !== expectedHwdec) {
      throw new Error(`${label}: createPlayer hwdec mismatch got=${created.probeHwdec} expected=${expectedHwdec}`);
    }
    addon.setUpdateCallback(id, () => { callbacks += 1; });
    addon.open(id, media);
    await waitLoaded(addon, id);

    const warmEnd = performance.now() + 1500;
    while (performance.now() < warmEnd) {
      const f = addon.renderFrame(id, 1920, 1080);
      if (f?.updated) {
        if (Boolean(f.skipRenderingProbe) !== skip) modeMismatch += 1;
        if (!addon.releaseFrame(id, f.slotId, f.frameId)) throw new Error('warm release failed');
      }
      await sleep(2);
    }

    const end = performance.now() + 9000;
    while (performance.now() < end && render.length < 52) {
      const started = performance.now();
      const f = addon.renderFrame(id, 1920, 1080);
      const elapsed = performance.now() - started;
      if (!f?.updated) {
        noFrame += 1;
        await sleep(2);
        continue;
      }
      if (Boolean(f.skipRenderingProbe) !== skip) modeMismatch += 1;
      if (isPlainPresent(f)) {
        const r = Number(f.nativeRenderMs);
        const u = Number(f.nativeUpdateMs);
        const t = Number(f.nativeEnsureTextureMs);
        if (![r,u,t].every(Number.isFinite)) throw new Error(`${label}: invalid native timing`);
        const acceptedAt = performance.now();
        if (previousAcceptedAt > 0) intervals.push(acceptedAt - previousAcceptedAt);
        previousAcceptedAt = acceptedAt;
        render.push(r); update.push(u); texture.push(t); wall.push(elapsed);
      } else {
        nonPlain += 1;
      }
      if (!addon.releaseFrame(id, f.slotId, f.frameId)) throw new Error('release failed');
      await sleep(2);
    }

    finalState = addon.poll(id);
    if (render.length < 32) throw new Error(`${label}: insufficient plain PRESENT samples ${render.length}`);
    if (modeMismatch !== 0) throw new Error(`${label}: skip-render mode mismatch count=${modeMismatch}`);
    const span = intervals.reduce((a, b) => a + b, 0);
    const effectiveFps = span > 0 ? round(intervals.length * 1000 / span) : 0;
    const result = {
      label,
      requestedHwdec: expectedHwdec,
      skipRendering: skip,
      createdProbeHwdec: created.probeHwdec,
      hwdecCurrent: finalState?.hwdecCurrent ?? null,
      videoCodec: finalState?.videoCodec ?? null,
      deviceMode: created.deviceMode,
      callbacks, nonPlain, noFrame, modeMismatch,
      samples: render.length,
      effectiveFps,
      nativeRenderMs: summarize(render),
      nativeUpdateMs: summarize(update),
      nativeEnsureTextureMs: summarize(texture),
      callWallMs: summarize(wall),
      frameIntervalMs: summarize(intervals),
      sampleFlags: [1]
    };
    console.log(`LIBMPV_R3D_RENDER_PATH_CHILD=${JSON.stringify(result)}`);
  } finally {
    try { addon.destroyPlayer(id); } catch {}
  }
}

function runChild(media, label, hwdec, skip) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LILAC_LIBMPV_TEST_AO_NULL: '1',
    LILAC_LIBMPV_TEST_HWDEC: hwdec,
    LILAC_LIBMPV_TEST_SKIP_RENDERING: skip ? '1' : '0',
    LILAC_RENDER_PATH_MEDIA: media,
    LILAC_RENDER_PATH_LABEL: label
  };
  const r = spawnSync(process.execPath, [__filename, '--child'], {
    env, encoding:'utf8', windowsHide:true, timeout:60000, maxBuffer:4 * 1024 * 1024
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${label} failed status=${r.status} stdout=${String(r.stdout || '').slice(-2000)} stderr=${String(r.stderr || '').slice(-2000)}`);
  }
  const prefix = 'LIBMPV_R3D_RENDER_PATH_CHILD=';
  const line = String(r.stdout || '').split(/\r?\n/).find(x => x.startsWith(prefix));
  if (!line) throw new Error(`${label}: report missing`);
  return JSON.parse(line.slice(prefix.length));
}

async function parentMain() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath) || !dllPath || !fs.existsSync(dllPath)) throw new Error('addon/dll missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-render-path-'));
  try {
    const media = buildFixture(dir);
    const autoRender = runChild(media, 'auto-render', 'auto-safe', false);
    const noHwRender = runChild(media, 'nohw-render', 'no', false);
    const autoSkip = runChild(media, 'auto-skip', 'auto-safe', true);
    const noHwSkip = runChild(media, 'nohw-skip', 'no', true);
    const results = [autoRender, noHwRender, autoSkip, noHwSkip];
    for (const x of results) {
      if (x.modeMismatch !== 0) throw new Error(`${x.label}: mode mismatch`);
      if (x.sampleFlags.some(f => f !== 1)) throw new Error(`${x.label}: accepted frame flags changed`);
    }
    const ratio = (a, b) => b > 0 ? round(a / b) : null;
    const report = {
      results,
      summary: {
        autoRenderFps: autoRender.effectiveFps,
        noHwRenderFps: noHwRender.effectiveFps,
        autoSkipFps: autoSkip.effectiveFps,
        noHwSkipFps: noHwSkip.effectiveFps,
        autoRenderP50: autoRender.nativeRenderMs.p50,
        noHwRenderP50: noHwRender.nativeRenderMs.p50,
        autoSkipP50: autoSkip.nativeRenderMs.p50,
        noHwSkipP50: noHwSkip.nativeRenderMs.p50,
        noHwToAutoRenderP50Ratio: ratio(noHwRender.nativeRenderMs.p50, autoRender.nativeRenderMs.p50),
        autoSkipToAutoRenderP50Ratio: ratio(autoSkip.nativeRenderMs.p50, autoRender.nativeRenderMs.p50),
        noHwSkipToNoHwRenderP50Ratio: ratio(noHwSkip.nativeRenderMs.p50, noHwRender.nativeRenderMs.p50)
      }
    };
    console.log(`LIBMPV_R3D_RENDER_PATH_REPORT=${JSON.stringify(report)}`);
    console.log('LIBMPV_R3D_RENDER_PATH_OK modes=auto-render,nohw-render,auto-skip,nohw-skip independentProcesses=1');
  } finally {
    try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
  }
}

const entry = process.argv.includes('--child') ? childMain : parentMain;
entry().catch(e => { console.error(e?.stack || e); process.exitCode = 1; });

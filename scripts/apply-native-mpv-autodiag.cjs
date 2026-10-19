'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'mpv-native-entry.js');
let source = fs.readFileSync(entry, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

const diagnosticRuntime = String.raw`
const LILAC_AUTODIAG_VERSION = 'V11D1';
let lilacAutoDiagRunId = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = (value, digits = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
};
const rectSummary = element => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x), y: Math.round(rect.y),
    w: Math.round(rect.width), h: Math.round(rect.height),
    display: getComputedStyle(element).display,
    visibility: getComputedStyle(element).visibility
  };
};
const safeError = error => String(error?.message || error || 'unknown')
  .replace(/https?:\/\/[^\s]+/gi, '[media-url]')
  .replace(/127\.0\.0\.1:\d+\/[^\s]*/gi, '[local-media]')
  .slice(0, 240);

function showAutoDiagReport(report) {
  window.__lilacLastAutoDiag = report;
  document.querySelector('#lilacAutoDiagModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'lilacAutoDiagModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif';
  const card = document.createElement('div');
  card.style.cssText = 'width:min(900px,94vw);max-height:88vh;background:#17171b;color:#fff;border:1px solid #45454d;border-radius:14px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:10px';
  const title = document.createElement('div');
  title.textContent = 'Lilac mpv 자동 진단 완료 · ' + LILAC_AUTODIAG_VERSION;
  title.style.cssText = 'font-weight:800;font-size:17px';
  const note = document.createElement('div');
  note.textContent = '아래 내용은 URL·Referer·Origin·토큰·쿠키를 포함하지 않는 진단 요약입니다. 전체 복사해서 ChatGPT에 보내주세요.';
  note.style.cssText = 'font-size:12px;color:#c9c9d1';
  const text = document.createElement('textarea');
  text.readOnly = true;
  text.value = JSON.stringify(report, null, 2);
  text.style.cssText = 'width:100%;height:56vh;resize:vertical;background:#0d0d10;color:#e8e8ed;border:1px solid #393941;border-radius:9px;padding:10px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;box-sizing:border-box';
  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
  const copy = document.createElement('button');
  copy.textContent = '진단결과 복사';
  const close = document.createElement('button');
  close.textContent = '닫기';
  for (const button of [copy, close]) button.style.cssText = 'border:1px solid #555563;background:#292931;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(text.value); copy.textContent = '복사됨'; }
    catch { text.focus(); text.select(); document.execCommand('copy'); copy.textContent = '복사됨'; }
  };
  close.onclick = () => modal.remove();
  buttons.append(copy, close);
  card.append(title, note, text, buttons);
  modal.append(card);
  document.body.append(modal);
}

async function runNativeMpvAutoDiagnostic(video, openResult = {}) {
  const runId = ++lilacAutoDiagRunId;
  const started = performance.now();
  const report = {
    diagnosticVersion: LILAC_AUTODIAG_VERSION,
    buildKind: 'raw-hwnd-hosted-mpv',
    startedAt: new Date().toISOString(),
    open: {
      ok: Boolean(openResult?.ok),
      route: openResult?.route || null,
      hostMode: openResult?.hostMode || null,
      pidPresent: Boolean(openResult?.pid)
    },
    renderer: {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      videoRect: rectSummary(video),
      topRect: rectSummary(document.querySelector('#immersivePlayer .player-top')),
      centerRect: rectSummary(document.querySelector('#immersivePlayer .player-center')),
      bottomRect: rectSummary(document.querySelector('#immersivePlayer .player-bottom')),
      playerActive: Boolean(document.querySelector('#playerView')?.classList.contains('active')),
      jsHeapMiB: performance.memory ? round(performance.memory.usedJSHeapSize / 1048576, 1) : null
    },
    samples: [],
    controlTest: {},
    bridge: null,
    conclusionHints: []
  };

  const snapshot = async label => {
    const t0 = performance.now();
    const state = await window.lilac.nativeMpvState().catch(error => ({ error: safeError(error) }));
    const latencyMs = Math.round(performance.now() - t0);
    const sample = {
      label,
      latencyMs,
      active: Boolean(state?.active),
      route: state?.route || null,
      hostMode: state?.hostMode || null,
      time: round(state?.time), duration: round(state?.duration), paused: state?.paused ?? null,
      volume: round(state?.volume), width: state?.width ?? null, height: state?.height ?? null,
      codec: state?.codec || null, fps: round(state?.fps), vid: state?.vid ?? null, aid: state?.aid ?? null,
      error: state?.error || null
    };
    report.samples.push(sample);
    return sample;
  };

  try {
    diag('자동 진단 시작 · 재생 상태를 15초간 관찰합니다');
    let ready = null;
    for (let i = 0; i < 15; i++) {
      if (runId !== lilacAutoDiagRunId || !video.isConnected) return;
      ready = await snapshot('observe-' + (i + 1));
      if (Number(ready?.duration) > 0 && Number(ready?.time) >= 0 && (Number(ready?.width) > 0 || Number(ready?.aid) > 0)) break;
      await sleep(1000);
    }

    const before = await snapshot('before-control-test');
    const originalTime = Number(before?.time);
    const originalPaused = Boolean(before?.paused);

    if (before?.active) {
      let t0 = performance.now();
      const pauseReply = await window.lilac.nativeMpvCommand(['set_property', 'pause', true]).catch(error => ({ ok: false, error: safeError(error) }));
      await sleep(220);
      const pausedState = await snapshot('pause-check');
      report.controlTest.pause = {
        commandOk: Boolean(pauseReply?.ok),
        roundTripMs: Math.round(performance.now() - t0),
        observedPaused: pausedState?.paused === true
      };

      if (Number.isFinite(originalTime)) {
        t0 = performance.now();
        const target = originalTime + 1;
        const seekReply = await window.lilac.nativeMpvCommand(['set_property', 'time-pos', target]).catch(error => ({ ok: false, error: safeError(error) }));
        await sleep(260);
        const seekState = await snapshot('seek-check');
        report.controlTest.seek = {
          commandOk: Boolean(seekReply?.ok),
          roundTripMs: Math.round(performance.now() - t0),
          requestedDelta: 1,
          observedDelta: round(Number(seekState?.time) - originalTime)
        };
        await window.lilac.nativeMpvCommand(['set_property', 'time-pos', originalTime]).catch(() => null);
      }

      await window.lilac.nativeMpvCommand(['set_property', 'pause', originalPaused]).catch(() => null);
      await sleep(250);
      await snapshot('restored');
    }

    const bridgeStart = performance.now();
    report.bridge = await window.lilac.nativeMpvDiagnostics().catch(error => ({ error: safeError(error) }));
    report.bridgeLatencyMs = Math.round(performance.now() - bridgeStart);
    if (report.bridge?.relay) {
      report.bridge.relay = Object.fromEntries(Object.entries(report.bridge.relay).filter(([, value]) => ['number','boolean','string'].includes(typeof value)));
    }

    const last = report.samples.at(-1) || {};
    if (last.active && Number(last.time) > 0 && Number(last.duration) > 0) report.conclusionHints.push('mpv-media-clock-running');
    if (Number(last.width) > 0 && Number(last.height) > 0 && last.vid != null) report.conclusionHints.push('video-track-decoded');
    if (last.aid != null) report.conclusionHints.push('audio-track-present');
    if (report.bridge?.hostReady) report.conclusionHints.push('native-host-reported-ready');
    if (report.controlTest.pause?.observedPaused) report.conclusionHints.push('ipc-pause-roundtrip-ok');
    if (Math.abs(Number(report.controlTest.seek?.observedDelta || 0)) > 0.4) report.conclusionHints.push('ipc-seek-roundtrip-ok');
    if (last.active && Number(last.width) > 0 && report.bridge?.hostReady) report.conclusionHints.push('if-screen-black-focus-on-hwnd-composition-not-network');
  } catch (error) {
    report.fatal = safeError(error);
  }

  report.elapsedMs = Math.round(performance.now() - started);
  diag('자동 진단 완료 · 결과 창에서 복사해 주세요');
  showAutoDiagReport(report);
}
`;

replaceOnce(
  "const clamp = (value, min, max) => Math.max(min, Math.min(max, value));\n",
  "const clamp = (value, min, max) => Math.max(min, Math.min(max, value));\n" + diagnosticRuntime + "\n",
  'diagnostic runtime insertion'
);

replaceOnce(
  "      diag(`host opened · pid=${result?.pid || '-'} · route=${result?.route || '-'} · waiting media state`);\n      return this._hostOpen;",
  "      diag(`host opened · pid=${result?.pid || '-'} · route=${result?.route || '-'} · waiting media state`);\n      if (this._hostOpen) setTimeout(() => void runNativeMpvAutoDiagnostic(this, result), 700);\n      return this._hostOpen;",
  'automatic diagnostic trigger'
);

source = source.replaceAll('V11 raw-hwnd-mpv', 'V11D1 autodiag-mpv');
fs.writeFileSync(entry, source);

buildSync({
  entryPoints: [entry],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

const generated = fs.readFileSync(path.join(root, 'src', 'mpv-native.generated.js'), 'utf8');
for (const marker of ['LILAC_AUTODIAG_VERSION', 'runNativeMpvAutoDiagnostic', 'V11D1']) {
  if (!generated.includes(marker)) throw new Error(`autodiag marker missing: ${marker}`);
}

console.log('V11D1 automatic diagnostic overlay applied.');

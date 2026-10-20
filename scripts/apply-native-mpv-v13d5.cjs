'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src', 'mpv-native-entry.js');
let entry = fs.readFileSync(entryPath, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D4';")) {
  throw new Error('V13D5 expects the V13D4 renderer transform first');
}

// V13D1/V13D4 reserved 68px + 132px outside the raw HWND. That made the
// actual mpv client 1920x880 on a 1920x1080 display, so a 16:9 source was
// letterboxed left/right. Keep the mpv client at the full stage size and use
// the Win32 host's region holes only for the fixed top/bottom Lilac docks.
const oldBounds = `  _hostBounds() {
    const stage = document.querySelector('#videoStage');
    const rect = (stage || this).getBoundingClientRect();
    const top = document.querySelector('#immersivePlayer .player-top')?.getBoundingClientRect();
    const bottom = document.querySelector('#immersivePlayer .player-bottom')?.getBoundingClientRect();
    const topEdge = Math.max(rect.top, Number(top?.bottom) || rect.top + 68);
    const bottomEdge = Math.min(rect.bottom, Number(bottom?.top) || rect.bottom - 132);
    return {
      x: Math.round(rect.left),
      y: Math.round(topEdge),
      width: Math.max(1, Math.round(rect.width || innerWidth)),
      height: Math.max(1, Math.round(bottomEdge - topEdge)),
      visible: this._playerVisible() && this._hostOpen,
      holes: []
    };
  }`;

const newBounds = `  _hostBounds() {
    const stage = document.querySelector('#videoStage');
    const rect = (stage || this).getBoundingClientRect();
    const holes = [];
    const addHole = element => {
      if (!element) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const hole = element.getBoundingClientRect();
      const left = Math.max(rect.left, hole.left);
      const top = Math.max(rect.top, hole.top);
      const right = Math.min(rect.right, hole.right);
      const bottom = Math.min(rect.bottom, hole.bottom);
      if (right <= left || bottom <= top) return;
      holes.push({
        x: Math.max(0, Math.round(left - rect.left)),
        y: Math.max(0, Math.round(top - rect.top)),
        w: Math.max(1, Math.round(right - left)),
        h: Math.max(1, Math.round(bottom - top))
      });
    };
    addHole(document.querySelector('#immersivePlayer .player-top'));
    addHole(document.querySelector('#immersivePlayer .player-bottom'));
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width || innerWidth)),
      height: Math.max(1, Math.round(rect.height || innerHeight)),
      visible: this._playerVisible() && this._hostOpen,
      holes
    };
  }`;
entry = replaceOnce(entry, oldBounds, newBounds, 'V13D5 full-stage HWND bounds');

// The old automatic report was itself creating the exact black veil / dead UI
// the acceptance test was trying to diagnose: a full-screen DOM modal appeared
// after the 10s self-test, while the 250ms bounds timer brought the raw HWND
// back over the modal card. The backdrop remained on top of Lilac controls and
// intercepted all pointer input. Keep the report in memory and expose one small
// non-blocking button in the top dock instead; only hide the HWND after the user
// explicitly asks to open the report.
entry = replaceOnce(
  entry,
  "  _playerVisible() {\n    const view = document.querySelector('#playerView');\n    const settings = document.querySelector('#playerSettings');\n    return Boolean(view?.classList.contains('active') && !settings?.classList.contains('open'));\n  }",
  "  _playerVisible() {\n    const view = document.querySelector('#playerView');\n    const settings = document.querySelector('#playerSettings');\n    return Boolean(view?.classList.contains('active') && !settings?.classList.contains('open') && !this._diagModalActive && !document.querySelector('#lilacAutoDiagModal'));\n  }",
  'V13D5 keep raw HWND hidden while report is explicitly open'
);

const queueRuntime = String.raw`
let lilacPendingAutoDiag = null;

function queueAutoDiagReport(report, video) {
  window.__lilacLastAutoDiag = report;
  lilacPendingAutoDiag = { report, video };
  let button = document.querySelector('#lilacAutoDiagReady');
  if (!button) {
    button = document.createElement('button');
    button.id = 'lilacAutoDiagReady';
    button.type = 'button';
    button.textContent = '진단 결과';
    button.style.cssText = 'position:fixed;top:17px;right:76px;z-index:2147483647;border:1px solid #555563;background:#292931;color:#fff;border-radius:8px;padding:7px 10px;font:700 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;pointer-events:auto';
    document.body.append(button);
  }
  button.hidden = false;
  button.onclick = async () => {
    const pending = lilacPendingAutoDiag;
    if (!pending) return;
    lilacPendingAutoDiag = null;
    button.remove();
    const targetVideo = pending.video;
    const restoreBounds = targetVideo?._hostBounds?.();
    const wasPaused = Boolean(targetVideo?.paused);
    if (targetVideo) targetVideo._diagModalActive = true;
    if (restoreBounds && window.lilac?.nativeMpvBounds) {
      await window.lilac.nativeMpvBounds({ ...restoreBounds, visible: false }).catch(() => {});
    }
    if (!wasPaused) await window.lilac?.nativeMpvCommand?.(['set_property', 'pause', true]).catch(() => {});
    showAutoDiagReport(pending.report, () => {
      if (targetVideo) targetVideo._diagModalActive = false;
      void targetVideo?._syncBounds?.();
      if (!wasPaused) void window.lilac?.nativeMpvCommand?.(['set_property', 'pause', false]).catch(() => {});
    });
  };
  diag('자동 진단 완료 · 우측 상단 진단 결과 버튼으로 확인');
}
`;
entry = replaceOnce(
  entry,
  'async function runNativeMpvAutoDiagnostic(video, openResult = {}) {',
  queueRuntime + '\nasync function runNativeMpvAutoDiagnostic(video, openResult = {}) {',
  'V13D5 deferred report runtime'
);

const oldAutoShow = `  const restoreBounds = video?._hostBounds?.();
  const wasPaused = Boolean(video?.paused);
  if (restoreBounds && window.lilac?.nativeMpvBounds) await window.lilac.nativeMpvBounds({ ...restoreBounds, visible: false }).catch(() => {});
  if (!wasPaused) await window.lilac?.nativeMpvCommand?.(['set_property', 'pause', true]).catch(() => {});
  showAutoDiagReport(report, () => {
    void video?._syncBounds?.();
    if (!wasPaused) void window.lilac?.nativeMpvCommand?.(['set_property', 'pause', false]).catch(() => {});
  });`;
entry = replaceOnce(
  entry,
  oldAutoShow,
  '  queueAutoDiagReport(report, video);',
  'V13D5 remove blocking automatic report modal'
);

entry = entry.replaceAll('V13D4', 'V13D5');

fs.writeFileSync(entryPath, entry);

buildSync({
  entryPoints: [entryPath],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

for (const relative of ['src/mpv-native-entry.js', 'src/mpv-native.generated.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'inherit' });
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const marker of ['V13D5', 'queueAutoDiagReport', 'lilacAutoDiagReady', 'holes']) {
    if (!text.includes(marker)) throw new Error(`V13D5 marker missing: ${relative} -> ${marker}`);
  }
}

const finalEntry = fs.readFileSync(entryPath, 'utf8');
if (finalEntry.includes(oldAutoShow)) throw new Error('V13D5 blocking autodiag path remains');
if (!finalEntry.includes('height: Math.max(1, Math.round(rect.height || innerHeight))')) {
  throw new Error('V13D5 full-stage geometry missing');
}

console.log('V13D5 deferred diagnostics and full-stage HWND region-hole layout applied.');

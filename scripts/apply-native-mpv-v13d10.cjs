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

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D9';")) {
  throw new Error('V13D10 expects the V13D9 renderer transform first');
}

// V13D9 proved compact Win32 region holes work. The diagnostic report still
// hid the complete HWND before opening its DOM modal, and the user's recording
// proved that the D3D11/mpv surface can remain black after that hide/show cycle.
// Keep the native video alive at all times and expose only the diagnostic card
// through another compact HWND hole instead.
entry = replaceOnce(
  entry,
  "  _playerVisible() {\n    const view = document.querySelector('#playerView');\n    return Boolean(view?.classList.contains('active') && !this._diagModalActive && !document.querySelector('#lilacAutoDiagModal'));\n  }",
  "  _playerVisible() {\n    const view = document.querySelector('#playerView');\n    return Boolean(view?.classList.contains('active'));\n  }",
  'V13D10 keep HWND visible while diagnostic card is open'
);

entry = replaceOnce(
  entry,
  "  modal.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif';",
  "  modal.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:none';",
  'V13D10 transparent nonblocking diagnostic backdrop'
);

entry = replaceOnce(
  entry,
  "  const card = document.createElement('div');\n  card.style.cssText = 'width:min(900px,94vw);max-height:88vh;background:#17171b;color:#fff;border:1px solid #45454d;border-radius:14px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:10px';",
  "  const card = document.createElement('div');\n  card.id = 'lilacAutoDiagCard';\n  card.style.cssText = 'width:min(900px,94vw);max-height:88vh;background:#17171b;color:#fff;border:1px solid #45454d;border-radius:14px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:10px;pointer-events:auto';",
  'V13D10 diagnostic card identity and input'
);

const oldClick = `  button.onclick = async () => {
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
  };`;
const newClick = `  button.onclick = () => {
    const pending = lilacPendingAutoDiag;
    if (!pending) return;
    lilacPendingAutoDiag = null;
    button.remove();
    const targetVideo = pending.video;
    showAutoDiagReport(pending.report, () => {
      void targetVideo?._syncBounds?.();
    });
    // The card is in the DOM synchronously now; update the Win32 region
    // immediately instead of waiting for the 250ms periodic bounds sync.
    void targetVideo?._syncBounds?.();
  };`;
entry = replaceOnce(entry, oldClick, newClick, 'V13D10 no-hide diagnostic open/close');

entry = replaceOnce(
  entry,
  "    addHole(document.querySelector('#lilacAutoDiagReady'));",
  "    addHole(document.querySelector('#lilacAutoDiagReady'));\n    addHole(document.querySelector('#lilacAutoDiagCard'));",
  'V13D10 diagnostic card HWND hole'
);

entry = entry.replaceAll('V13D9', 'V13D10');

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
}

const finalEntry = fs.readFileSync(entryPath, 'utf8');
if (!finalEntry.includes("const LILAC_AUTODIAG_VERSION = 'V13D10';")) {
  throw new Error('V13D10 diagnostic version missing');
}
for (const marker of [
  "card.id = 'lilacAutoDiagCard'",
  "addHole(document.querySelector('#lilacAutoDiagCard'))",
  'background:transparent',
  'pointer-events:none',
  'pointer-events:auto'
]) {
  if (!finalEntry.includes(marker)) throw new Error(`V13D10 marker missing: ${marker}`);
}
if (finalEntry.includes('targetVideo._diagModalActive = true')) {
  throw new Error('V13D10 still activates whole-HWND diagnostic hide state');
}
if (finalEntry.includes("nativeMpvBounds({ ...restoreBounds, visible: false })")) {
  throw new Error('V13D10 still hides the complete HWND for diagnostics');
}

console.log('V13D10 keeps native video alive and exposes only the diagnostic card through a compact HWND hole.');

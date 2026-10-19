'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'src', 'mpv-native-entry.js');
const indexFile = path.join(root, 'src', 'index.html');
let source = fs.readFileSync(file, 'utf8');
let index = fs.readFileSync(indexFile, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

function replaceRegexOnce(regex, replacement, label) {
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const matches = [...source.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) throw new Error(`${label}: expected 1 anchor, found ${matches.length}`);
  source = source.replace(regex, replacement);
}

const bodyMatches = index.match(/<body>\r?\n/g) || [];
if (bodyMatches.length !== 1) throw new Error(`diagnostic badge: expected 1 body anchor, found ${bodyMatches.length}`);
const badge = `  <div id="nativeMpvDiag" style="position:fixed;top:38px;left:16px;z-index:2147483647;max-width:calc(100vw - 32px);padding:7px 10px;border-radius:8px;background:rgba(20,20,24,.94);color:#fff;font:600 12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.45)">V5 HTML loaded · waiting renderer script</div>\n`;
index = index.replace(/<body>\r?\n/, match => match + badge);

// V4 proved the media opens but copying RGBA frames through JS explodes memory.
// V5 therefore returns to the low-copy shared-texture path and keeps diagnostics
// outside the auto-hidden player controls.
replaceOnce(
  "    this._surface.setAttribute('render-mode', 'shared-texture');",
  "    this._surface.setAttribute('render-mode', 'shared-texture');",
  'native renderer mode'
);

replaceOnce(
  "const clamp = (value, min, max) => Math.max(min, Math.min(max, value));",
  `const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const nativeSafeText = value => String(value ?? '')
  .replace(/https?:\\/\\/[^\\s]+/gi, '[media-url]')
  .replace(/127\\.0\\.0\\.1:\\d+\\/r\\/[a-f0-9]+/gi, '[local-relay]')
  .slice(0, 260);
let nativeStage = 'renderer loaded';
let nativeLastMpvState = null;
let nativeLastRelay = null;
const nativeRenderStatus = () => {
  const badge = document.querySelector('#nativeMpvDiag');
  if (!badge) return;
  const s = nativeLastMpvState || {};
  const r = nativeLastRelay || {};
  const time = Number.isFinite(Number(s.time)) ? Number(s.time).toFixed(1) : '-';
  const duration = Number.isFinite(Number(s.duration)) ? Number(s.duration).toFixed(1) : '-';
  const width = Number(s.width) || 0;
  const height = Number(s.height) || 0;
  badge.textContent = nativeSafeText(
    'V5 ' + nativeStage +
    ' · mpv=' + (s.status || '-') +
    ' · mode=' + (s.renderMode || '-') +
    ' · t=' + time + '/' + duration +
    ' · size=' + width + 'x' + height +
    ' · relay req=' + (r.requests ?? '-') +
    ' pl=' + (r.playlists ?? '-') +
    ' seg=' + (r.segments ?? '-') +
    ' strip=' + (r.strippedSegments ?? '-') +
    ' err=' + (r.upstreamErrors ?? '-') +
    ' MiB=' + (r.upstreamMiB ?? '-')
  );
};
const nativeStatus = text => {
  nativeStage = nativeSafeText(text);
  nativeRenderStatus();
  const status = document.querySelector('#downloadStatus');
  if (status) status.textContent = nativeStage;
};
const nativePollDiagnostics = async () => {
  try {
    const value = await window.lilac?.nativeMpvDiagnostics?.();
    nativeLastRelay = value?.relay || null;
  } catch {}
  nativeRenderStatus();
};
setInterval(nativePollDiagnostics, 1000);
window.addEventListener('error', event => nativeStatus('renderer JS error · ' + nativeSafeText(event?.message || 'unknown')));
window.addEventListener('unhandledrejection', event => nativeStatus('renderer promise error · ' + nativeSafeText(event?.reason?.message || event?.reason || 'unknown')));
nativeStatus('renderer loaded · api=' + Boolean(window._electronMpvVideo) + ' · bridge=' + Boolean(window.lilac?.nativeMpvPrepare));`,
  'diagnostic helper'
);

replaceRegexOnce(
  /\s*console\.warn\('Lilac native mpv:', detail\);\s*this\.dispatchEvent\(new Event\('error'\)\);/,
  "\n      console.warn('Lilac native mpv renderer error');\n      nativeStatus('mpv error · ' + nativeSafeText(detail));\n      this.dispatchEvent(new Event('error'));",
  'safe renderer error status'
);

replaceOnce(
  "    this._surface.addEventListener('mpv-state', event => this._onMpvState(event.detail || {}));",
  "    this._surface.addEventListener('mpv-state', event => { nativeLastMpvState = event.detail || {}; nativeRenderStatus(); this._onMpvState(event.detail || {}); });",
  'mpv state diagnostics'
);

replaceOnce(
  "      const prepared = await window.lilac.nativeMpvPrepare(this._rawSource, headers || {}, Boolean(hls));",
  "      nativeStatus('stage 1/5 · preparing relay');\n      const prepared = await window.lilac.nativeMpvPrepare(this._rawSource, headers || {}, Boolean(hls));\n      nativeStatus('stage 2/5 · relay ready · relayed=' + Boolean(prepared?.relayed));\n      void nativePollDiagnostics();",
  'prepare status'
);

replaceOnce(
  "      await this._surface.open(prepared?.url || this._rawSource);",
  "      nativeStatus('stage 3/5 · opening libmpv');\n      await this._surface.open(prepared?.url || this._rawSource);\n      nativeStatus('stage 4/5 · libmpv open returned');",
  'open status'
);

replaceRegexOnce(
  /await this\._surface\.setVolume\(this\._muted \? 0 : this\._volume \* 100\);\s*return true;/,
  "await this._surface.setVolume(this._muted ? 0 : this._volume * 100);\n      nativeStatus('stage 5/5 · source ready · waiting frames');\n      return true;",
  'opened status'
);

replaceOnce(
  "    if (this._duration > 0 && !this._metadataSent) {",
  "    if (this._duration > 0 && !this._metadataSent) {\n      nativeStatus('metadata received');",
  'metadata status'
);

fs.writeFileSync(file, source);
fs.writeFileSync(indexFile, index);
console.log('Native mpv V5 diagnostic mode applied: shared-texture + relay telemetry + persistent status.');

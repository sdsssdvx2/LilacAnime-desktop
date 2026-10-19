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

// Static, always-visible diagnostic badge. It is not part of Lilac's auto-hide
// player controls, so a totally black player still reports how far startup got.
const bodyMatches = index.match(/<body>\r?\n/g) || [];
if (bodyMatches.length !== 1) throw new Error(`diagnostic badge: expected 1 body anchor, found ${bodyMatches.length}`);
const badge = `  <div id="nativeMpvDiag" style="position:fixed;top:38px;left:16px;z-index:2147483647;max-width:calc(100vw - 32px);padding:7px 10px;border-radius:8px;background:rgba(20,20,24,.94);color:#fff;font:600 12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.45)">V4 HTML loaded · waiting renderer script</div>\n`;
index = index.replace(/<body>\r?\n/, match => match + badge);

// Use the least complicated embedded pipeline for one diagnostic A/B.
replaceOnce(
  "    this._surface.setAttribute('render-mode', 'shared-texture');",
  "    this._surface.setAttribute('render-mode', 'canvas2d');",
  'native renderer mode'
);

replaceOnce(
  "const clamp = (value, min, max) => Math.max(min, Math.min(max, value));",
  `const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const nativeSafeText = value => String(value ?? '')
  .replace(/https?:\\/\\/[^\\s]+/gi, '[media-url]')
  .replace(/127\\.0\\.0\\.1:\\d+\\/r\\/[a-f0-9]+/gi, '[local-relay]')
  .slice(0, 180);
const nativeStatus = text => {
  const safe = nativeSafeText(text);
  const badge = document.querySelector('#nativeMpvDiag');
  if (badge) badge.textContent = safe;
  const status = document.querySelector('#downloadStatus');
  if (status) status.textContent = safe;
};
window.addEventListener('error', event => nativeStatus('V4 renderer JS error · ' + nativeSafeText(event?.message || 'unknown')));
window.addEventListener('unhandledrejection', event => nativeStatus('V4 renderer promise error · ' + nativeSafeText(event?.reason?.message || event?.reason || 'unknown')));
nativeStatus('V4 renderer loaded · api=' + Boolean(window._electronMpvVideo) + ' · bridge=' + Boolean(window.lilac?.nativeMpvPrepare));`,
  'diagnostic helper'
);

replaceRegexOnce(
  /\s*console\.warn\('Lilac native mpv:', detail\);\s*this\.dispatchEvent\(new Event\('error'\)\);/,
  "\n      console.warn('Lilac native mpv renderer error');\n      nativeStatus('V4 mpv error · ' + nativeSafeText(detail));\n      this.dispatchEvent(new Event('error'));",
  'safe renderer error status'
);

replaceOnce(
  "      const prepared = await window.lilac.nativeMpvPrepare(this._rawSource, headers || {}, Boolean(hls));",
  "      nativeStatus('V4 stage 1/5 · preparing relay');\n      const prepared = await window.lilac.nativeMpvPrepare(this._rawSource, headers || {}, Boolean(hls));\n      nativeStatus('V4 stage 2/5 · relay ready · relayed=' + Boolean(prepared?.relayed));",
  'prepare status'
);

replaceOnce(
  "      await this._surface.open(prepared?.url || this._rawSource);",
  "      nativeStatus('V4 stage 3/5 · opening libmpv');\n      await this._surface.open(prepared?.url || this._rawSource);\n      nativeStatus('V4 stage 4/5 · libmpv open returned');",
  'open status'
);

replaceRegexOnce(
  /await this\._surface\.setVolume\(this\._muted \? 0 : this\._volume \* 100\);\s*return true;/,
  "await this._surface.setVolume(this._muted ? 0 : this._volume * 100);\n      nativeStatus('V4 stage 5/5 · source ready · waiting metadata');\n      return true;",
  'opened status'
);

replaceOnce(
  "    if (this._duration > 0 && !this._metadataSent) {",
  "    if (this._duration > 0 && !this._metadataSent) {\n      nativeStatus('V4 metadata received · duration=' + this._duration.toFixed(1) + ' · size=' + this._width + 'x' + this._height);",
  'metadata status'
);

fs.writeFileSync(file, source);
fs.writeFileSync(indexFile, index);
console.log('Native mpv V4 diagnostic mode applied: canvas2d + persistent startup stages.');

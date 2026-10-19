'use strict';

const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'src', 'mpv-native-entry.js');
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

function replaceRegexOnce(regex, replacement, label) {
  const match = source.match(regex);
  if (!match) throw new Error(`${label}: expected 1 anchor, found 0`);
  source = source.replace(regex, replacement);
}

// V4 is deliberately diagnostic, not the final renderer choice.  Use the
// simplest software/canvas path so a black frame can no longer be attributed
// to shared-texture/WebGPU or WebGL upload.  Once media open is proven we can
// move back to the fastest embedded renderer.
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
window.addEventListener('error', event => {
  nativeStatus('V4 renderer JS error · ' + nativeSafeText(event?.message || 'unknown'));
});
window.addEventListener('unhandledrejection', event => {
  nativeStatus('V4 renderer promise error · ' + nativeSafeText(event?.reason?.message || event?.reason || 'unknown'));
});
nativeStatus('V4 renderer script loaded · api=' + Boolean(window._electronMpvVideo) + ' · bridge=' + Boolean(window.lilac?.nativeMpvPrepare));`,
  'diagnostic helper'
);

replaceOnce(
  "    super();\n    this._root = this.attachShadow({ mode: 'open' });",
  "    super();\n    nativeStatus('V4 native element constructed · canvas2d');\n    this._root = this.attachShadow({ mode: 'open' });",
  'constructor stage'
);

replaceOnce(
  "  connectedCallback() {\n    this._trackObserver.observe(this, { childList: true });",
  "  connectedCallback() {\n    nativeStatus('V4 native element connected · canvas2d');\n    this._trackObserver.observe(this, { childList: true });",
  'connected stage'
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
  "  async play() {\n    if (this._openPromise) await this._openPromise;",
  "  async play() {\n    nativeStatus('V4 play requested');\n    if (this._openPromise) await this._openPromise;",
  'play requested status'
);

replaceOnce(
  "    await this._surface.play();\n  }",
  "    await this._surface.play();\n    nativeStatus('V4 play command returned · waiting mpv state');\n  }",
  'play returned status'
);

replaceOnce(
  "  _onMpvState(state) {\n    const previousDuration = this._duration;",
  "  _onMpvState(state) {\n    const diagStatus = String(state?.status || 'state');\n    const diagDuration = Number(state?.duration);\n    const diagWidth = Number(state?.width);\n    const diagHeight = Number(state?.height);\n    nativeStatus('V4 mpv state · ' + diagStatus + ' · dur=' + (Number.isFinite(diagDuration) ? diagDuration.toFixed(1) : '-') + ' · size=' + (Number.isFinite(diagWidth) ? diagWidth : 0) + 'x' + (Number.isFinite(diagHeight) ? diagHeight : 0));\n    const previousDuration = this._duration;",
  'mpv state status'
);

fs.writeFileSync(file, source);
console.log('Native mpv V4 diagnostic mode applied: canvas2d + persistent stage reporting.');

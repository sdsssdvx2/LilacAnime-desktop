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
  const matches = source.match(regex);
  const count = matches ? 1 : 0;
  if (count !== 1) throw new Error(`${label}: expected 1 anchor, found ${count}`);
  source = source.replace(regex, replacement);
}

// V3 diagnostic: move away from shared-texture/WebGPU for one controlled A/B.
// WebGL keeps libmpv video embedded in the Lilac DOM, so HTML controls can
// still render over it, but avoids the shared-texture path that can be black
// on a machine even when media loading itself succeeds.
replaceOnce(
  "    this._surface.setAttribute('render-mode', 'shared-texture');",
  "    this._surface.setAttribute('render-mode', 'webgl');",
  'native renderer mode'
);

replaceOnce(
  "const clamp = (value, min, max) => Math.max(min, Math.min(max, value));",
  "const clamp = (value, min, max) => Math.max(min, Math.min(max, value));\nconst nativeStatus = text => { const el = document.querySelector('#downloadStatus'); if (el) el.textContent = text; };",
  'status helper'
);

replaceRegexOnce(
  /\s*console\.warn\('Lilac native mpv:', detail\);\s*this\.dispatchEvent\(new Event\('error'\)\);/,
  "\n      console.warn('Lilac native mpv renderer error');\n      nativeStatus('native mpv 렌더링 오류 · WebGL 경로를 확인합니다.');\n      this.dispatchEvent(new Event('error'));",
  'safe renderer error status'
);

replaceOnce(
  "      const prepared = await window.lilac.nativeMpvPrepare(this._rawSource, headers || {}, Boolean(hls));",
  "      nativeStatus('native mpv 스트림을 준비하는 중...');\n      const prepared = await window.lilac.nativeMpvPrepare(this._rawSource, headers || {}, Boolean(hls));",
  'prepare status'
);

replaceOnce(
  "      await this._surface.open(prepared?.url || this._rawSource);",
  "      nativeStatus('native mpv 영상 데이터를 여는 중...');\n      await this._surface.open(prepared?.url || this._rawSource);",
  'open status'
);

replaceRegexOnce(
  /await this\._surface\.setVolume\(this\._muted \? 0 : this\._volume \* 100\);\s*return true;/,
  "await this._surface.setVolume(this._muted ? 0 : this._volume * 100);\n      nativeStatus('native mpv 영상 준비 완료 · 재생 시작 중...');\n      return true;",
  'opened status'
);

replaceOnce(
  "    if (this._duration > 0 && !this._metadataSent) {",
  "    if (this._duration > 0 && !this._metadataSent) {\n      nativeStatus('native mpv 메타데이터 수신 완료 · 인라인 재생 중');",
  'metadata status'
);

fs.writeFileSync(file, source);
console.log('Native mpv V3 diagnostic mode applied: WebGL render path + safe on-screen stages.');

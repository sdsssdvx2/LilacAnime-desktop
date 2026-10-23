'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

// R2I deliberately disabled mpv's native subtitle renderer so Lilac remained the
// single subtitle owner. That exposed a compatibility hole: the replacement
// <lilac-mpv-video> element emulates textTracks, but unlike a real <video> Chromium
// does not draw WebVTT cues for it. R2J adds the missing Lilac-owned VTT overlay.
let entry = read('src/libmpv-shared-entry.js');

entry = replaceOnce(
  entry,
  `  set mode(value) { this._mode = ['disabled', 'hidden', 'showing'].includes(value) ? value : 'hidden'; }`,
  `  set mode(value) {\n    this._mode = ['disabled', 'hidden', 'showing'].includes(value) ? value : 'hidden';\n    this.owner?.refreshSubtitleOverlay?.();\n  }`,
  'text track mode refresh'
);
entry = replaceOnce(
  entry,
  `  addCue(cue) {\n    if (!this.cues.includes(cue)) this.cues.push(cue);\n    this.cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);\n  }\n  removeCue(cue) {\n    const index = this.cues.indexOf(cue);\n    if (index >= 0) this.cues.splice(index, 1);\n  }`,
  `  addCue(cue) {\n    if (!this.cues.includes(cue)) this.cues.push(cue);\n    this.cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);\n    this.owner?.refreshSubtitleOverlay?.();\n  }\n  removeCue(cue) {\n    const index = this.cues.indexOf(cue);\n    if (index >= 0) this.cues.splice(index, 1);\n    this.owner?.refreshSubtitleOverlay?.();\n  }`,
  'text track cue refresh'
);
entry = replaceOnce(
  entry,
  `        canvas{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;pointer-events:none}\n      </style>\n      <canvas data-lilac-libmpv-surface width="1280" height="720"></canvas>`,
  `        canvas{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;pointer-events:none}\n        .lilac-vtt-layer{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden;box-sizing:border-box;display:none}\n        .lilac-vtt-stack{position:absolute;left:2%;right:2%;bottom:12%;display:flex;flex-direction:column;align-items:center;gap:.08em;text-align:center;white-space:pre-line;line-height:1.22;color:#fff;overflow-wrap:anywhere}\n        .lilac-vtt-cue{display:block;max-width:96%;background:transparent;color:inherit;font:inherit;text-shadow:inherit;white-space:pre-line}\n        .lilac-vtt-cue b{font-weight:700}.lilac-vtt-cue i{font-style:italic}.lilac-vtt-cue u{text-decoration:underline}\n      </style>\n      <canvas data-lilac-libmpv-surface width="1280" height="720"></canvas>\n      <div class="lilac-vtt-layer" data-lilac-vtt-overlay aria-hidden="true"><div class="lilac-vtt-stack"></div></div>`,
  'shadow VTT overlay'
);
entry = replaceOnce(
  entry,
  `    this._canvas = this._root.querySelector('canvas');`,
  `    this._canvas = this._root.querySelector('canvas');\n    this._subtitleLayer = this._root.querySelector('[data-lilac-vtt-overlay]');\n    this._subtitleStack = this._root.querySelector('.lilac-vtt-stack');\n    this._subtitleOverlayText = '';`,
  'VTT overlay handles'
);
entry = replaceOnce(
  entry,
  `  refreshSubtitleOverlay() {}`,
  `  refreshSubtitleOverlay() {\n    const layer = this._subtitleLayer;\n    const stack = this._subtitleStack;\n    if (!layer || !stack) return;\n    const cues = [];\n    for (const track of this._tracks) {\n      if (track.mode !== 'showing') continue;\n      for (const cue of track.activeCues || []) cues.push(cue);\n    }\n    if (!cues.length) {\n      if (this._subtitleOverlayText) stack.replaceChildren();\n      this._subtitleOverlayText = '';\n      layer.style.display = 'none';\n      return;\n    }\n\n    const rect = this.getBoundingClientRect();\n    const renderedHeight = this._height > 0 && this._width > 0 && rect.width > 0 && rect.height > 0\n      ? Math.min(rect.height, rect.width * this._height / this._width)\n      : Math.max(1, rect.height || this.clientHeight || 720);\n    const size = clamp(Number(localStorage.getItem('subtitleSize') || 100), 25, 300);\n    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 2), 0, 12) * renderedHeight / 720;\n    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 12), 0, 45);\n    const bold = localStorage.getItem('vttBold') !== 'false';\n    const fontSize = Math.max(12, renderedHeight * 0.05 * size / 100);\n    const ring = outline\n      ? [...Array(16)].map((_, index) => {\n          const angle = index * Math.PI / 8;\n          return `${(Math.cos(angle) * outline).toFixed(2)}px ${(Math.sin(angle) * outline).toFixed(2)}px 0 #000`;\n        }).join(',')\n      : 'none';\n\n    const signature = cues.map(cue => `${cue.startTime}|${cue.endTime}|${cue.text}`).join('\\u241e');\n    if (signature !== this._subtitleOverlayText) {\n      const fragment = document.createDocumentFragment();\n      for (const cue of cues) {\n        const line = document.createElement('div');\n        line.className = 'lilac-vtt-cue';\n        line.dataset.start = String(cue.startTime);\n        line.dataset.end = String(cue.endTime);\n        try {\n          const rich = cue.getCueAsHTML?.();\n          if (rich) line.append(rich.cloneNode(true));\n          else line.textContent = cue.text;\n        } catch {\n          line.textContent = cue.text;\n        }\n        const align = String(cue.align || 'center');\n        line.style.textAlign = align === 'start' || align === 'left' ? 'left' : align === 'end' || align === 'right' ? 'right' : 'center';\n        fragment.append(line);\n      }\n      stack.replaceChildren(fragment);\n      this._subtitleOverlayText = signature;\n    }\n    stack.style.bottom = `${position}%`;\n    stack.style.fontFamily = `LilacSubtitle,'Malgun Gothic',sans-serif`;\n    stack.style.fontSize = `${fontSize.toFixed(2)}px`;\n    stack.style.fontWeight = bold ? '700' : '400';\n    stack.style.textShadow = ring;\n    layer.style.display = 'block';\n  }`,
  'implement VTT overlay renderer'
);
entry = replaceOnce(
  entry,
  `    if (index >= 0) this._tracks.splice(index, 1);\n  }\n\n  async _pollState()`,
  `    if (index >= 0) this._tracks.splice(index, 1);\n    this.refreshSubtitleOverlay();\n  }\n\n  async _pollState()`,
  'drop-track overlay refresh'
);
entry = replaceOnce(
  entry,
  `      if (typeof state.paused === 'boolean') this._paused = state.paused;\n      this._ended = Boolean(state.eof) || (this._duration > 0 && this._time >= this._duration - 0.15 && this._paused);\n      this._lastState = state;`,
  `      if (typeof state.paused === 'boolean') this._paused = state.paused;\n      this._ended = Boolean(state.eof) || (this._duration > 0 && this._time >= this._duration - 0.15 && this._paused);\n      this._lastState = state;\n      this.refreshSubtitleOverlay();`,
  'poll-time overlay refresh'
);

if (entry.includes("['sub-add'")) throw new Error('R2J requires Lilac-only subtitles; mpv sub-add survived');
for (const marker of ['data-lilac-vtt-overlay', 'refreshSubtitleOverlay() {', 'getCueAsHTML', "track.mode !== 'showing'", 'LilacSubtitle']) {
  if (!entry.includes(marker)) throw new Error(`R2J subtitle overlay marker missing: ${marker}`);
}
write('src/libmpv-shared-entry.js', entry);

// The isolated libmpv candidate must never consume the stable Lilac /releases/latest
// channel. The previous R2I installer could silently download and force-run the stable
// installer, which exactly explains the user's unexpected second normal-Lilac window.
let updater = read('electron/updater.cjs');
updater = replaceOnce(
  updater,
  `    this.state = { status: 'idle', current: app.getVersion() };\n    this.downloading = null;`,
  `    this.state = { status: 'idle', current: app.getVersion() };\n    this.downloading = null;\n    this.isolatedCandidate = /libmpv/i.test(String(app.getVersion?.() || '')) || /libmpv/i.test(String(app.getName?.() || ''));`,
  'candidate updater identity'
);
updater = replaceOnce(
  updater,
  `  async check() {\n    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;`,
  `  async check() {\n    if (this.isolatedCandidate) return this.set({ status: 'latest', latest: this.app.getVersion(), notes: '', url: '', isolatedChannel: true });\n    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;`,
  'candidate updater check isolation'
);
updater = replaceOnce(
  updater,
  `  async download() {\n    if (this.state.status === 'ready') return this.state;`,
  `  async download() {\n    if (this.isolatedCandidate) return this.state;\n    if (this.state.status === 'ready') return this.state;`,
  'candidate updater download isolation'
);
updater = replaceOnce(
  updater,
  `  install(relaunch = true) {\n    if (!this.installer || !fs.existsSync(this.installer)) throw new Error('다운로드된 설치 파일이 없습니다.');`,
  `  install(relaunch = true) {\n    if (this.isolatedCandidate) return false;\n    if (!this.installer || !fs.existsSync(this.installer)) throw new Error('다운로드된 설치 파일이 없습니다.');`,
  'candidate updater install isolation'
);
updater = replaceOnce(
  updater,
  `  installOnQuit() { if (!MAC && this.state.status === 'ready' && !this.installing) try { this.install(false); } catch { /* next start */ } }`,
  `  installOnQuit() { if (this.isolatedCandidate) return false; if (!MAC && this.state.status === 'ready' && !this.installing) try { this.install(false); } catch { /* next start */ } return true; }`,
  'candidate updater quit isolation'
);
updater = replaceOnce(
  updater,
  `Updater.prototype.notes = async function notes() {\n  const version = this.app.getVersion(), same = value => parseVersion(value).join('.') === parseVersion(version).join('.');`,
  `Updater.prototype.notes = async function notes() {\n  const version = this.app.getVersion();\n  if (this.isolatedCandidate) return { version, notes: '', url: '' };\n  const same = value => parseVersion(value).join('.') === parseVersion(version).join('.');`,
  'candidate release notes isolation'
);
for (const marker of ['this.isolatedCandidate', 'isolatedChannel: true', 'if (this.isolatedCandidate) return false']) {
  if (!updater.includes(marker)) throw new Error(`R2J updater isolation marker missing: ${marker}`);
}
write('electron/updater.cjs', updater);

console.log('LIBMPV_R2J_SUBTITLE_OVERLAY_OK vtt=shadow-overlay updater=isolated stableUpdaterInstall=blocked');

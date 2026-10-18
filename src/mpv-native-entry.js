import { defineMpvVideoElement } from 'electron-mpv-video/renderer';

defineMpvVideoElement();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const decodeCueText = text => {
  const div = document.createElement('div');
  div.innerHTML = String(text || '').replace(/\n/g, '<br>');
  return div.textContent || '';
};

function parseTime(value) {
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

function parseVtt(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const blocks = source.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line, index) => !(index === 0 && /^WEBVTT\b/i.test(line.trim())));
    if (!lines.length || /^NOTE(?:\s|$)/.test(lines[0].trim())) continue;
    let timing = lines.findIndex(line => line.includes('-->'));
    if (timing < 0) continue;
    const match = lines[timing].match(/^\s*([^\s]+)\s*-->\s*([^\s]+)(?:\s+.*)?$/);
    if (!match) continue;
    const start = parseTime(match[1].replace(',', '.'));
    const end = parseTime(match[2].replace(',', '.'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const cue = new VTTCue(start, end, lines.slice(timing + 1).join('\n'));
    cues.push(cue);
  }
  return cues;
}

class LilacTextTrack {
  constructor(owner, element) {
    this.owner = owner;
    this.element = element;
    this.kind = element.kind || 'subtitles';
    this.label = element.label || '';
    this.language = element.srclang || '';
    this.cues = [];
    this._mode = element.default ? 'showing' : 'hidden';
  }
  get mode() { return this._mode; }
  set mode(value) {
    this._mode = ['disabled', 'hidden', 'showing'].includes(value) ? value : 'hidden';
    this.owner.refreshSubtitleOverlay();
  }
  get activeCues() {
    if (this._mode !== 'showing') return null;
    const now = this.owner.currentTime;
    return this.cues.filter(cue => cue.startTime <= now && now < cue.endTime);
  }
  addCue(cue) {
    if (!this.cues.includes(cue)) this.cues.push(cue);
    this.cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    this.owner.refreshSubtitleOverlay();
  }
  removeCue(cue) {
    const at = this.cues.indexOf(cue);
    if (at >= 0) this.cues.splice(at, 1);
    this.owner.refreshSubtitleOverlay();
  }
}

class LilacNativeVideoElement extends HTMLElement {
  static observedAttributes = ['src'];

  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'open' });
    this._surface = document.createElement('mpv-video');
    this._surface.setAttribute('render-mode', 'shared-texture');
    this._subtitleLayer = document.createElement('div');
    this._subtitleLayer.className = 'subtitle-layer';
    this._root.innerHTML = `<style>
      :host{display:block;position:relative;overflow:hidden;background:#000;contain:layout paint size}
      mpv-video{position:absolute;inset:0;width:100%;height:100%;background:#000;z-index:0}
      .subtitle-layer{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden}
      .cue{position:absolute;left:4%;right:4%;white-space:pre-wrap;text-align:center;color:#fff;line-height:1.25;word-break:keep-all;overflow-wrap:anywhere}
    </style>`;
    this._root.append(this._surface, this._subtitleLayer);

    this._time = 0;
    this._duration = 0;
    this._width = 0;
    this._height = 0;
    this._paused = true;
    this._ended = false;
    this._volume = 1;
    this._muted = false;
    this._playbackRate = 1;
    this._readyState = 0;
    this._rawSource = '';
    this._openPromise = null;
    this._openToken = 0;
    this._tracks = [];
    this._trackByElement = new Map();
    this._vfc = new Map();
    this._vfcId = 0;
    this._frameLoop = null;
    this._metadataSent = false;

    this._surface.addEventListener('mpv-state', event => this._onMpvState(event.detail || {}));
    this._surface.addEventListener('mpv-error', event => {
      const detail = event.detail || 'native mpv error';
      console.warn('Lilac native mpv:', detail);
      this.dispatchEvent(new Event('error'));
    });

    this._trackObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof HTMLTrackElement) void this._loadTrack(node);
        for (const node of record.removedNodes) if (node instanceof HTMLTrackElement) this._dropTrack(node);
      }
    });
  }

  connectedCallback() {
    this._trackObserver.observe(this, { childList: true });
    for (const track of this.querySelectorAll('track')) void this._loadTrack(track);
  }

  disconnectedCallback() {
    this._trackObserver.disconnect();
    this._stopFrameLoop();
    this._surface.stop?.().catch?.(() => {});
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name !== 'src' || oldValue === newValue || this._settingSourceAttribute) return;
    if (!newValue) {
      this._openToken++;
      this._rawSource = '';
      this._time = 0;
      this._duration = 0;
      this._readyState = 0;
      this._metadataSent = false;
      this._surface.stop?.().catch?.(() => {});
      this.dispatchEvent(new Event('emptied'));
      return;
    }
    void this.openLilacSource(newValue, { headers: {}, hls: /\.m3u8(?:$|\?)/i.test(newValue) });
  }

  get src() { return this.getAttribute('src') || ''; }
  set src(value) { if (value) this.setAttribute('src', String(value)); else this.removeAttribute('src'); }
  get currentSrc() { return this._rawSource || this.src; }
  get currentTime() { return this._time; }
  set currentTime(value) {
    const next = Math.max(0, Number(value) || 0);
    this._time = next;
    this._ended = false;
    this.dispatchEvent(new Event('seeking'));
    this._surface.seek(next).then(() => {
      this.dispatchEvent(new Event('seeked'));
      this.dispatchEvent(new Event('timeupdate'));
      this.refreshSubtitleOverlay();
    }).catch(() => {});
  }
  get duration() { return this._duration; }
  get videoWidth() { return this._width; }
  get videoHeight() { return this._height; }
  get paused() { return this._paused; }
  get ended() { return this._ended; }
  get readyState() { return this._readyState; }
  get networkState() { return this._rawSource ? 1 : 0; }
  get error() { return null; }
  get volume() { return this._volume; }
  set volume(value) {
    this._volume = clamp(Number(value) || 0, 0, 1);
    void this._surface.setVolume(this._muted ? 0 : this._volume * 100).catch(() => {});
  }
  get muted() { return this._muted; }
  set muted(value) {
    this._muted = Boolean(value);
    void this._surface.setVolume(this._muted ? 0 : this._volume * 100).catch(() => {});
  }
  get playbackRate() { return this._playbackRate; }
  set playbackRate(value) {
    const next = Number(value);
    this._playbackRate = Number.isFinite(next) && next > 0 ? next : 1;
  }
  get textTracks() { return this._tracks; }
  get buffered() {
    const duration = this._duration;
    return {
      length: duration > 0 ? 1 : 0,
      start: index => { if (index !== 0 || duration <= 0) throw new DOMException('IndexSizeError'); return 0; },
      end: index => { if (index !== 0 || duration <= 0) throw new DOMException('IndexSizeError'); return duration; }
    };
  }

  async openLilacSource(rawUrl, { headers = {}, hls = false } = {}) {
    const token = ++this._openToken;
    this._rawSource = String(rawUrl || '');
    this._settingSourceAttribute = true;
    try { if (this._rawSource) this.setAttribute('src', this._rawSource); else this.removeAttribute('src'); }
    finally { this._settingSourceAttribute = false; }
    this._readyState = 0;
    this._metadataSent = false;
    this._ended = false;
    this.dispatchEvent(new Event('waiting'));

    this._openPromise = (async () => {
      const prepared = await window.lilac.nativeMpvPrepare(this._rawSource, headers || {}, Boolean(hls));
      if (token !== this._openToken) return false;
      await this._surface.open(prepared?.url || this._rawSource);
      if (token !== this._openToken) return false;
      await this._surface.setVolume(this._muted ? 0 : this._volume * 100);
      return true;
    })();
    return this._openPromise;
  }

  async play() {
    if (this._openPromise) await this._openPromise;
    this._ended = false;
    await this._surface.play();
  }

  pause() { return this._surface.pause(); }

  load() {
    if (!this.src) {
      this._surface.stop?.().catch?.(() => {});
      return;
    }
    if (!this._openPromise) void this.openLilacSource(this.src, { hls: /\.m3u8(?:$|\?)/i.test(this.src) });
  }

  requestVideoFrameCallback(callback) {
    const id = ++this._vfcId;
    this._vfc.set(id, callback);
    this._ensureFrameLoop();
    return id;
  }

  cancelVideoFrameCallback(id) { this._vfc.delete(id); }

  requestPictureInPicture() {
    return Promise.reject(new Error('Picture-in-Picture is not implemented by the native mpv prototype yet.'));
  }

  refreshSubtitleOverlay() {
    const active = this._tracks.flatMap(track => track.mode === 'showing' ? (track.activeCues || []) : []);
    this._subtitleLayer.replaceChildren(...active.map(cue => this._cueNode(cue)));
  }

  _cueNode(cue) {
    const node = document.createElement('div');
    node.className = 'cue';
    node.textContent = decodeCueText(cue.text);
    const size = clamp(Number(localStorage.getItem('subtitleSize') || 100), 40, 250) / 100;
    const outline = clamp(Number(localStorage.getItem('vttOutline') || 2), 0, 8);
    const bold = localStorage.getItem('vttBold') !== 'false';
    const px = clamp(this.clientHeight * 0.045 * size, 16, 76);
    const top = cue.lilacTop || (typeof cue.line === 'number' && cue.line <= 20);
    const line = typeof cue.line === 'number' ? clamp(cue.line, 0, 100) : (top ? 5 : 85);
    Object.assign(node.style, {
      top: `${line}%`,
      transform: top ? 'none' : 'translateY(-100%)',
      fontSize: `${px}px`,
      fontWeight: bold ? '700' : '400',
      fontFamily: '"Malgun Gothic","Noto Sans CJK KR",sans-serif',
      textShadow: outline > 0 ? [
        `${outline}px 0 0 #000`, `-${outline}px 0 0 #000`,
        `0 ${outline}px 0 #000`, `0 -${outline}px 0 #000`,
        `${outline}px ${outline}px 0 #000`, `-${outline}px ${outline}px 0 #000`,
        `${outline}px -${outline}px 0 #000`, `-${outline}px -${outline}px 0 #000`
      ].join(',') : 'none'
    });
    return node;
  }

  async _loadTrack(element) {
    if (this._trackByElement.has(element)) return;
    const track = new LilacTextTrack(this, element);
    this._trackByElement.set(element, track);
    this._tracks.push(track);
    try {
      const response = await fetch(element.src);
      if (!response.ok && response.status !== 0) throw new Error(`subtitle HTTP ${response.status}`);
      const cues = parseVtt(await response.text());
      if (!this._trackByElement.has(element)) return;
      for (const cue of cues) track.addCue(cue);
      element.dispatchEvent(new Event('load'));
      this.refreshSubtitleOverlay();
    } catch {
      if (this._trackByElement.has(element)) element.dispatchEvent(new Event('error'));
    }
  }

  _dropTrack(element) {
    const track = this._trackByElement.get(element);
    if (!track) return;
    this._trackByElement.delete(element);
    const at = this._tracks.indexOf(track);
    if (at >= 0) this._tracks.splice(at, 1);
    this.refreshSubtitleOverlay();
  }

  _onMpvState(state) {
    const previousDuration = this._duration;
    const previousWidth = this._width;
    const previousHeight = this._height;
    const previousPaused = this._paused;
    const previousTime = this._time;

    if (Number.isFinite(Number(state.time))) this._time = Math.max(0, Number(state.time));
    if (Number.isFinite(Number(state.duration))) this._duration = Math.max(0, Number(state.duration));
    if (Number.isFinite(Number(state.width))) this._width = Math.max(0, Number(state.width));
    if (Number.isFinite(Number(state.height))) this._height = Math.max(0, Number(state.height));

    const status = String(state.status || '');
    if (status === 'Playing') this._paused = false;
    else if (status === 'Paused' || status === 'Ended') this._paused = true;
    this._ended = status === 'Ended';

    if (this._duration > 0 && !this._metadataSent) {
      this._metadataSent = true;
      this._readyState = 4;
      this.dispatchEvent(new Event('loadedmetadata'));
      this.dispatchEvent(new Event('durationchange'));
      this.dispatchEvent(new Event('loadeddata'));
      this.dispatchEvent(new Event('canplay'));
    } else if (this._duration !== previousDuration) {
      this.dispatchEvent(new Event('durationchange'));
    }
    if (this._width !== previousWidth || this._height !== previousHeight) this.dispatchEvent(new Event('resize'));
    if (Math.abs(this._time - previousTime) > 0.001) {
      this.dispatchEvent(new Event('timeupdate'));
      this.refreshSubtitleOverlay();
    }
    if (!this._paused && previousPaused) {
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      this._ensureFrameLoop();
    } else if (this._paused && !previousPaused && !this._ended) {
      this.dispatchEvent(new Event('pause'));
    }
    if (this._ended) {
      this.dispatchEvent(new Event('timeupdate'));
      this.dispatchEvent(new Event('ended'));
      this._stopFrameLoop();
    }
  }

  _ensureFrameLoop() {
    if (this._frameLoop || this._paused) return;
    const tick = now => {
      this._frameLoop = null;
      if (this._paused || !this.isConnected) return;
      const callbacks = [...this._vfc.entries()];
      this._vfc.clear();
      const metadata = {
        mediaTime: this._time,
        presentedFrames: 0,
        expectedDisplayTime: now,
        width: this._width,
        height: this._height
      };
      for (const [, callback] of callbacks) {
        try { callback(now, metadata); } catch {}
      }
      this._frameLoop = requestAnimationFrame(tick);
    };
    this._frameLoop = requestAnimationFrame(tick);
  }

  _stopFrameLoop() {
    if (this._frameLoop) cancelAnimationFrame(this._frameLoop);
    this._frameLoop = null;
  }
}

customElements.define('lilac-mpv-video', LilacNativeVideoElement);
window.LilacNativeMpv = { enabled: true, elementClass: LilacNativeVideoElement };

const refresh = event => {
  if (!['subtitleSize','subtitlePosition','vttOutline','vttBold','subtitleSync','psSubtitleSize','psSubtitlePosition','psVttOutline','psVttBold','psSubtitleSync'].includes(event.target?.id)) return;
  document.querySelector('lilac-mpv-video')?.refreshSubtitleOverlay();
};
document.addEventListener('input', refresh, true);
document.addEventListener('change', refresh, true);

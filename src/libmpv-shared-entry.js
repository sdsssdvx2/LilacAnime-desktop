'use strict';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing < 0) continue;
    const match = lines[timing].match(/^\s*([^\s]+)\s*-->\s*([^\s]+)(?:\s+.*)?$/);
    if (!match) continue;
    const start = parseTime(match[1].replace(',', '.'));
    const end = parseTime(match[2].replace(',', '.'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    cues.push(new VTTCue(start, end, lines.slice(timing + 1).join('\n')));
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
  set mode(value) { this._mode = ['disabled', 'hidden', 'showing'].includes(value) ? value : 'hidden'; }
  get activeCues() {
    if (this._mode !== 'showing') return null;
    const now = this.owner.currentTime;
    return this.cues.filter(cue => cue.startTime <= now && now < cue.endTime);
  }
  addCue(cue) {
    if (!this.cues.includes(cue)) this.cues.push(cue);
    this.cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  }
  removeCue(cue) {
    const index = this.cues.indexOf(cue);
    if (index >= 0) this.cues.splice(index, 1);
  }
}

class LilacSharedMpvElement extends HTMLElement {
  static observedAttributes = ['src'];

  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'open' });
    this._root.innerHTML = `
      <style>
        :host{display:block;position:relative;background:#000;overflow:hidden;contain:layout paint size}
        canvas{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;pointer-events:none}
      </style>
      <canvas data-lilac-libmpv-surface width="1280" height="720"></canvas>`;
    this._canvas = this._root.querySelector('canvas');
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
    this._metadataSent = false;
    this._playerOpen = false;
    this._lastState = null;
    this._polling = false;
    this._tracks = [];
    this._trackByElement = new Map();
    this._vfc = new Map();
    this._vfcId = 0;
    this._presentedFrames = 0;
    this._pollTimer = null;
    this._resizeTimer = null;
    this._resizeObserver = new ResizeObserver(() => this._queueSurfaceResize());
    this._trackObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof HTMLTrackElement) void this._loadTrack(node);
        for (const node of record.removedNodes) if (node instanceof HTMLTrackElement) this._dropTrack(node);
      }
    });
  }

  connectedCallback() {
    this._resizeObserver.observe(this);
    this._trackObserver.observe(this, { childList: true });
    for (const track of this.querySelectorAll('track')) void this._loadTrack(track);
    this._pollTimer ||= setInterval(() => void this._pollState(), 250);
    this._queueSurfaceResize();
  }

  disconnectedCallback() {
    this._resizeObserver.disconnect();
    this._trackObserver.disconnect();
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._pollTimer = this._resizeTimer = null;
    this._playerOpen = false;
    delete this.dataset.libmpvPlayerId;
    void window.lilac?.libmpvSharedClose?.().catch(() => {});
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name !== 'src' || oldValue === newValue || this._settingSourceAttribute) return;
    if (!newValue) {
      this._resetMediaState();
      void window.lilac?.libmpvSharedClose?.().catch(() => {});
      this.dispatchEvent(new Event('emptied'));
      return;
    }
    void this.openLilacSource(newValue, { headers: {}, hls: /\.m3u8(?:$|\?)/i.test(newValue) });
  }

  _resetMediaState() {
    this._openToken += 1;
    this._rawSource = '';
    this._time = 0;
    this._duration = 0;
    this._width = 0;
    this._height = 0;
    this._readyState = 0;
    this._metadataSent = false;
    this._ended = false;
    this._playerOpen = false;
    this._openPromise = null;
    delete this.dataset.libmpvPlayerId;
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
    void this._command(['set_property', 'time-pos', next]).then(ok => {
      if (!ok) return;
      this.dispatchEvent(new Event('seeked'));
      this.dispatchEvent(new Event('timeupdate'));
    });
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
    void this._command(['set_property', 'volume', (this._muted ? 0 : this._volume) * 100]);
    this.dispatchEvent(new Event('volumechange'));
  }
  get muted() { return this._muted; }
  set muted(value) {
    this._muted = Boolean(value);
    void this._command(['set_property', 'mute', this._muted]);
    if (!this._muted) void this._command(['set_property', 'volume', this._volume * 100]);
    this.dispatchEvent(new Event('volumechange'));
  }
  get playbackRate() { return this._playbackRate; }
  set playbackRate(value) {
    const next = Number(value);
    this._playbackRate = Number.isFinite(next) && next > 0 ? next : 1;
    void this._command(['set_property', 'speed', this._playbackRate]);
    this.dispatchEvent(new Event('ratechange'));
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
  get seeking() { return false; }

  _playerVisible() {
    return Boolean(document.querySelector('#playerView')?.classList.contains('active'));
  }

  _surfaceSize() {
    const rect = this.getBoundingClientRect();
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    return {
      width: clamp(Math.round(Math.max(2, rect.width) * dpr), 2, 3840),
      height: clamp(Math.round(Math.max(2, rect.height) * dpr), 2, 2160)
    };
  }

  _queueSurfaceResize() {
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._resizeTimer = null;
      if (!this.isConnected || !window.lilac?.libmpvSharedResize) return;
      void window.lilac.libmpvSharedResize(this._surfaceSize()).catch(() => {});
    }, 40);
  }

  async _command(command) {
    if (!this._playerOpen || !window.lilac?.libmpvSharedCommand) return false;
    const result = await window.lilac.libmpvSharedCommand(command).catch(() => null);
    return Boolean(result?.ok);
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
      const result = await window.lilac.libmpvSharedOpen(this._rawSource, headers || {}, Boolean(hls), this._surfaceSize());
      if (token !== this._openToken) return false;
      this._playerOpen = Boolean(result?.ok);
      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);
      await this._command(['set_property', 'volume', (this._muted ? 0 : this._volume) * 100]);
      await this._command(['set_property', 'speed', this._playbackRate]);
      return this._playerOpen;
    })();
    return this._openPromise;
  }

  async play() {
    if (this._openPromise) await this._openPromise;
    this._ended = false;
    await this._command(['set_property', 'pause', false]);
  }

  async pause() {
    await this._command(['set_property', 'pause', true]);
  }

  load() {
    if (!this.src) {
      this._playerOpen = false;
      delete this.dataset.libmpvPlayerId;
      void window.lilac?.libmpvSharedClose?.().catch(() => {});
      return;
    }
    if (!this._openPromise) void this.openLilacSource(this.src, { hls: /\.m3u8(?:$|\?)/i.test(this.src) });
  }

  requestVideoFrameCallback(callback) {
    const id = ++this._vfcId;
    this._vfc.set(id, callback);
    requestAnimationFrame(() => {
      const fn = this._vfc.get(id);
      if (!fn) return;
      this._vfc.delete(id);
      const sentFrames = Number(this._lastState?.metrics?.sentFrames);
      if (Number.isFinite(sentFrames)) this._presentedFrames = Math.max(this._presentedFrames, sentFrames);
      else this._presentedFrames += 1;
      fn(performance.now(), {
        mediaTime: this._time,
        presentedFrames: this._presentedFrames,
        width: this._width || this.clientWidth,
        height: this._height || this.clientHeight
      });
    });
    return id;
  }

  cancelVideoFrameCallback(id) { this._vfc.delete(id); }
  requestPictureInPicture() { return Promise.reject(new Error('PIP is not implemented by libmpv shared-texture playback yet.')); }
  refreshSubtitleOverlay() {}

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
      if (this._playerOpen && element.src && !element.src.startsWith('blob:')) {
        void this._command(['sub-add', element.src, 'select']);
      }
    } catch {
      if (this._trackByElement.has(element)) element.dispatchEvent(new Event('error'));
    }
  }

  _dropTrack(element) {
    const track = this._trackByElement.get(element);
    if (!track) return;
    this._trackByElement.delete(element);
    const index = this._tracks.indexOf(track);
    if (index >= 0) this._tracks.splice(index, 1);
  }

  async _pollState() {
    if (this._polling || !this._playerOpen || !window.lilac?.libmpvSharedState) return;
    this._polling = true;
    try {
      if (!this._playerVisible()) {
        this._playerOpen = false;
        delete this.dataset.libmpvPlayerId;
        await window.lilac.libmpvSharedClose().catch(() => {});
        return;
      }

      const state = await window.lilac.libmpvSharedState().catch(() => null);
      if (!state?.active) return;
      const previousTime = this._time;
      const previousDuration = this._duration;
      const previousWidth = this._width;
      const previousHeight = this._height;
      const previousPaused = this._paused;

      if (Number.isFinite(Number(state.time))) this._time = Math.max(0, Number(state.time));
      if (Number.isFinite(Number(state.duration))) this._duration = Math.max(0, Number(state.duration));
      if (Number.isFinite(Number(state.width))) this._width = Math.max(0, Number(state.width));
      if (Number.isFinite(Number(state.height))) this._height = Math.max(0, Number(state.height));
      if (typeof state.paused === 'boolean') this._paused = state.paused;
      this._ended = Boolean(state.eof) || (this._duration > 0 && this._time >= this._duration - 0.15 && this._paused);
      this._lastState = state;

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
      if (Math.abs(this._time - previousTime) > 0.001) this.dispatchEvent(new Event('timeupdate'));
      if (!this._paused && previousPaused) {
        this.dispatchEvent(new Event('play'));
        this.dispatchEvent(new Event('playing'));
      } else if (this._paused && !previousPaused && !this._ended) {
        this.dispatchEvent(new Event('pause'));
      }
      if (this._ended) this.dispatchEvent(new Event('ended'));
    } finally {
      this._polling = false;
    }
  }
}

customElements.define('lilac-mpv-video', LilacSharedMpvElement);
window.LilacNativeMpv = { enabled: true, kind: 'libmpv-d3d11-shared-texture', zeroCopy: true };

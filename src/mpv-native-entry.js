const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function ensureHostStyle() {
  if (document.querySelector('#lilacMpvHostStyle')) return;
  const style = document.createElement('style');
  style.id = 'lilacMpvHostStyle';
  style.textContent = `
    body.player-mode .player-center {
      top: auto !important;
      bottom: 78px !important;
      transform: translateX(-50%) !important;
      z-index: 50 !important;
    }
    #nativeMpvDiag {
      position: fixed;
      top: 38px;
      left: 16px;
      z-index: 2147483647;
      max-width: calc(100vw - 32px);
      padding: 6px 9px;
      border-radius: 8px;
      background: rgba(20,20,24,.94);
      color: #fff;
      font: 600 11px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;
      pointer-events: none;
      box-shadow: 0 2px 12px rgba(0,0,0,.45);
    }
  `;
  document.head.append(style);
}

function diag(text) {
  ensureHostStyle();
  let badge = document.querySelector('#nativeMpvDiag');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'nativeMpvDiag';
    document.body.append(badge);
  }
  badge.textContent = `V7 hosted-mpv · ${String(text || '').slice(0, 420)}`;
}

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
  }
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
    const at = this.cues.indexOf(cue);
    if (at >= 0) this.cues.splice(at, 1);
  }
}

class LilacHostedMpvElement extends HTMLElement {
  static observedAttributes = ['src'];

  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'open' });
    this._root.innerHTML = `<style>:host{display:block;position:relative;background:#000;overflow:hidden;contain:layout paint size}.placeholder{position:absolute;inset:0;background:#000}</style><div class="placeholder"></div>`;
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
    this._hostOpen = false;
    this._lastState = null;
    this._polling = false;
    this._tracks = [];
    this._trackByElement = new Map();
    this._vfc = new Map();
    this._vfcId = 0;
    this._presentedFrames = 0;
    this._visibilityTimer = null;
    this._pollTimer = null;
    this._resizeObserver = new ResizeObserver(() => this._syncBounds());
    this._trackObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof HTMLTrackElement) void this._loadTrack(node);
        for (const node of record.removedNodes) if (node instanceof HTMLTrackElement) this._dropTrack(node);
      }
    });
  }

  connectedCallback() {
    ensureHostStyle();
    diag('renderer ready · external mpv host idle');
    this._resizeObserver.observe(this);
    this._trackObserver.observe(this, { childList: true });
    for (const track of this.querySelectorAll('track')) void this._loadTrack(track);
    this._pollTimer ||= setInterval(() => void this._pollState(), 350);
    this._visibilityTimer ||= setInterval(() => void this._syncBounds(), 250);
    window.addEventListener('resize', this._boundSync ||= (() => this._syncBounds()));
    window.addEventListener('scroll', this._boundSync, true);
  }

  disconnectedCallback() {
    this._resizeObserver.disconnect();
    this._trackObserver.disconnect();
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._visibilityTimer) clearInterval(this._visibilityTimer);
    this._pollTimer = this._visibilityTimer = null;
    if (this._boundSync) {
      window.removeEventListener('resize', this._boundSync);
      window.removeEventListener('scroll', this._boundSync, true);
    }
    void window.lilac?.nativeMpvClose?.().catch(() => {});
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name !== 'src' || oldValue === newValue || this._settingSourceAttribute) return;
    if (!newValue) {
      this._openToken++;
      this._rawSource = '';
      this._time = 0;
      this._duration = 0;
      this._width = 0;
      this._height = 0;
      this._readyState = 0;
      this._metadataSent = false;
      this._hostOpen = false;
      void window.lilac?.nativeMpvClose?.().catch(() => {});
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
    const view = document.querySelector('#playerView');
    const settings = document.querySelector('#playerSettings');
    return Boolean(view?.classList.contains('active') && !settings?.classList.contains('open'));
  }

  _hostBounds() {
    const rect = this.getBoundingClientRect();
    const topInset = Math.min(72, Math.max(0, rect.height * 0.10));
    const bottomInset = Math.min(150, Math.max(84, rect.height * 0.17));
    return {
      x: rect.left,
      y: rect.top + topInset,
      width: Math.max(1, rect.width),
      height: Math.max(90, rect.height - topInset - bottomInset),
      visible: this._playerVisible() && this._hostOpen
    };
  }

  async _syncBounds() {
    if (!window.lilac?.nativeMpvBounds) return;
    const visible = this._playerVisible();
    if (!visible && this._hostOpen && !document.querySelector('#playerView')?.classList.contains('active')) {
      this._hostOpen = false;
      await window.lilac.nativeMpvClose().catch(() => {});
      return;
    }
    await window.lilac.nativeMpvBounds(this._hostBounds()).catch(() => {});
  }

  async _command(command) {
    if (!this._hostOpen || !window.lilac?.nativeMpvCommand) return false;
    const result = await window.lilac.nativeMpvCommand(command).catch(() => null);
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
    diag('opening hosted mpv · waiting process');

    this._openPromise = (async () => {
      const result = await window.lilac.nativeMpvOpen(this._rawSource, headers || {}, Boolean(hls), this._hostBounds());
      if (token !== this._openToken) return false;
      this._hostOpen = Boolean(result?.ok);
      await this._syncBounds();
      await this._command(['set_property', 'volume', (this._muted ? 0 : this._volume) * 100]);
      await this._command(['set_property', 'speed', this._playbackRate]);
      diag(`host opened · pid=${result?.pid || '-'} · route=${result?.route || '-'} · waiting media state`);
      return this._hostOpen;
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
      this._hostOpen = false;
      void window.lilac?.nativeMpvClose?.().catch(() => {});
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
      fn(performance.now(), {
        mediaTime: this._time,
        presentedFrames: ++this._presentedFrames,
        width: this._width || this.clientWidth,
        height: this._height || this.clientHeight
      });
    });
    return id;
  }

  cancelVideoFrameCallback(id) { this._vfc.delete(id); }
  requestPictureInPicture() { return Promise.reject(new Error('PIP is not implemented by hosted mpv yet.')); }
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
      if (this._hostOpen && element.src && !element.src.startsWith('blob:')) {
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
    const at = this._tracks.indexOf(track);
    if (at >= 0) this._tracks.splice(at, 1);
  }

  async _pollState() {
    if (this._polling || !this._hostOpen || !window.lilac?.nativeMpvState) return;
    this._polling = true;
    try {
      const state = await window.lilac.nativeMpvState().catch(() => null);
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
      if (Number.isFinite(Number(state.volume))) this._volume = clamp(Number(state.volume) / 100, 0, 1);
      this._ended = this._duration > 0 && this._time >= this._duration - 0.15 && this._paused;
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

      const t = Number.isFinite(this._time) ? this._time.toFixed(1) : '-';
      const d = Number.isFinite(this._duration) ? this._duration.toFixed(1) : '-';
      diag(`active=${state.active} pid=${state.pid || '-'} route=${state.route || '-'} t=${t}/${d} size=${this._width || 0}x${this._height || 0} codec=${state.codec || '-'} fps=${Number(state.fps || 0).toFixed(2)} vid=${state.vid ?? '-'} aid=${state.aid ?? '-'} paused=${String(state.paused)}`);
    } finally {
      this._polling = false;
    }
  }
}

customElements.define('lilac-mpv-video', LilacHostedMpvElement);
window.LilacNativeMpv = { enabled: true, kind: 'hosted-mpv' };

diag('renderer loaded · hosted mpv bridge ready');

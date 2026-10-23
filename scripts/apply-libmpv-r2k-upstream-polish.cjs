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

// R2K keeps the R2J renderer but matches Lilac's own VTT positioning more closely,
// hides the diagnostic affordance with the normal controls, and moves experimental
// builds to a dedicated custom-update channel instead of the stable Lilac installer.
let entry = read('src/libmpv-shared-entry.js');
if (!entry.includes('data-lilac-vtt-overlay')) throw new Error('R2K requires the R2J VTT overlay first');

entry = replaceOnce(
  entry,
  '<div class="lilac-vtt-layer" data-lilac-vtt-overlay aria-hidden="true"><div class="lilac-vtt-stack"></div></div>',
  '<div class="lilac-vtt-layer" data-lilac-vtt-overlay aria-hidden="true"><div class="lilac-vtt-top"></div><div class="lilac-vtt-stack"></div></div>',
  'subtitle top/bottom stacks'
);
entry = replaceOnce(
  entry,
  '        .lilac-vtt-stack{position:absolute;left:2%;right:2%;bottom:12%;display:flex;flex-direction:column;align-items:center;gap:.08em;text-align:center;white-space:pre-line;line-height:1.22;color:#fff;overflow-wrap:anywhere}',
  '        .lilac-vtt-stack,.lilac-vtt-top{position:absolute;left:2%;right:2%;display:flex;flex-direction:column;align-items:center;gap:.08em;text-align:center;white-space:pre-line;line-height:1.22;color:#fff;overflow-wrap:anywhere}\\n        .lilac-vtt-stack{bottom:15.06%}.lilac-vtt-top{top:5%}',
  'subtitle stack CSS'
);
entry = replaceOnce(
  entry,
  "    this._subtitleStack = this._root.querySelector('.lilac-vtt-stack');\n    this._subtitleOverlayText = '';",
  "    this._subtitleStack = this._root.querySelector('.lilac-vtt-stack');\n    this._subtitleTop = this._root.querySelector('.lilac-vtt-top');\n    this._subtitleOverlayText = '';",
  'subtitle stack handles'
);

const refreshPattern = /  refreshSubtitleOverlay\(\) \{[\s\S]*?\n  \}\n\n  async _loadTrack/;
if (!refreshPattern.test(entry)) throw new Error('R2J refreshSubtitleOverlay function not found');
entry = entry.replace(refreshPattern, `  refreshSubtitleOverlay() {
    const layer = this._subtitleLayer;
    const bottomStack = this._subtitleStack;
    const topStack = this._subtitleTop;
    if (!layer || !bottomStack || !topStack) return;
    const bottom = [], top = [];
    for (const track of this._tracks) {
      if (track.mode !== 'showing') continue;
      for (const cue of track.activeCues || []) (cue.lilacTop || Number(cue.line) <= 10 ? top : bottom).push(cue);
    }
    if (!bottom.length && !top.length) {
      if (this._subtitleOverlayText) { bottomStack.replaceChildren(); topStack.replaceChildren(); }
      this._subtitleOverlayText = '';
      layer.style.display = 'none';
      return;
    }

    const rect = this.getBoundingClientRect();
    const renderedHeight = this._height > 0 && this._width > 0 && rect.width > 0 && rect.height > 0
      ? Math.min(rect.height, rect.width * this._height / this._width)
      : Math.max(1, rect.height || this.clientHeight || 720);
    const size = clamp(Number(localStorage.getItem('subtitleSize') || 100), 25, 300);
    const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 2), 0, 12) * renderedHeight / 720;
    const position = clamp(Number(localStorage.getItem('subtitlePosition') || 12), 0, 45);
    const bold = localStorage.getItem('vttBold') !== 'false';
    const keepStyle = localStorage.getItem('vttStyle') !== 'false';
    const fontSize = Math.max(12, renderedHeight * 0.05 * size / 100);
    const ring = outline
      ? [...Array(16)].map((_, index) => {
          const angle = index * Math.PI / 8;
          return \`${'${'}(Math.cos(angle) * outline).toFixed(2)}px ${'${'}(Math.sin(angle) * outline).toFixed(2)}px 0 #000\`;
        }).join(',')
      : 'none';
    // Match official Lilac/Android placement: sub-pos = 100-position, clamped 55..97,
    // then the 22px/720 bottom margin used by mpv. Convert the cue baseline to CSS bottom inset.
    const baseline = Math.min(97, Math.max(55, Math.round(100 - position))) - 22 / 720 * 100;
    const bottomInset = 100 - baseline;

    const signature = [...top.map(cue => \`T|${'${'}cue.startTime}|${'${'}cue.endTime}|${'${'}cue.text}\`), ...bottom.map(cue => \`B|${'${'}cue.startTime}|${'${'}cue.endTime}|${'${'}cue.text}\`)].join('\\u241e');
    const render = (container, cues) => {
      const fragment = document.createDocumentFragment();
      for (const cue of cues) {
        const line = document.createElement('div');
        line.className = 'lilac-vtt-cue';
        line.dataset.start = String(cue.startTime);
        line.dataset.end = String(cue.endTime);
        try {
          const rich = keepStyle ? cue.getCueAsHTML?.() : null;
          if (rich) line.append(rich.cloneNode(true));
          else line.textContent = cue.text;
        } catch { line.textContent = cue.text; }
        const align = String(cue.align || 'center');
        line.style.textAlign = align === 'start' || align === 'left' ? 'left' : align === 'end' || align === 'right' ? 'right' : 'center';
        fragment.append(line);
      }
      container.replaceChildren(fragment);
    };
    if (signature !== this._subtitleOverlayText) {
      render(topStack, top);
      render(bottomStack, bottom);
      this._subtitleOverlayText = signature;
    }
    for (const stack of [topStack, bottomStack]) {
      stack.style.fontFamily = \`LilacSubtitle,'Malgun Gothic',sans-serif\`;
      stack.style.fontSize = \`${'${'}fontSize.toFixed(2)}px\`;
      stack.style.fontWeight = bold ? '700' : '400';
      stack.style.textShadow = ring;
    }
    topStack.style.display = top.length ? 'flex' : 'none';
    bottomStack.style.display = bottom.length ? 'flex' : 'none';
    bottomStack.style.bottom = \`${'${'}bottomInset.toFixed(3)}%\`;
    layer.style.display = 'block';
  }

  async _loadTrack`);

entry = replaceOnce(
  entry,
  "    button.style.display = playerActive() ? 'block' : 'none';",
  "    const controlsVisible = Boolean(document.querySelector('#immersivePlayer')?.classList.contains('controls-visible') || document.querySelector('#playerSettings')?.classList.contains('open'));\n    button.style.display = playerActive() && controlsVisible ? 'block' : 'none';",
  'diagnostic button follows controls'
);

// The actual GPU copy runs in the isolated shared-texture preload receiver. Expose
// the selected copy API as renderer architecture metadata so source/package gates can
// bind the renderer shell to the same proven R2H WebGPU path without duplicating it.
entry = replaceOnce(
  entry,
  "window.LilacNativeMpv = { enabled: true, kind: 'libmpv-d3d11-shared-texture', zeroCopy: true };",
  "window.LilacNativeMpv = { enabled: true, kind: 'libmpv-d3d11-shared-texture', zeroCopy: true, gpuCopyApi: 'copyExternalImageToTexture' };",
  'renderer WebGPU architecture metadata'
);

for (const marker of ['lilac-vtt-top', 'bottomInset.toFixed(3)', 'controlsVisible', "localStorage.getItem('vttStyle')", 'copyExternalImageToTexture']) {
  if (!entry.includes(marker)) throw new Error(`R2K renderer marker missing: ${marker}`);
}
write('src/libmpv-shared-entry.js', entry);

let updater = read('electron/updater.cjs');
if (!updater.includes('this.isolatedCandidate')) throw new Error('R2K requires R2J updater isolation first');
updater = replaceOnce(
  updater,
  "const RELEASE_API = `${RELEASES}/latest`;",
  "const RELEASE_API = `${RELEASES}/latest`;\nconst CUSTOM_RELEASES_API = 'https://api.github.com/repos/sdsssdvx2/LilacAnime-desktop/releases?per_page=100';\nconst CUSTOM_TAG_RE = /^libmpv-r2k-v(\\d+)\\.(\\d+)\\.(\\d+)-r(\\d+)$/i;\nconst CUSTOM_CURRENT_TAG = String(require('../package.json').lilacCustomTag || '');\nfunction customParts(value = '') { const match = CUSTOM_TAG_RE.exec(String(value)); return match ? match.slice(1).map(Number) : null; }\nfunction compareCustom(a, b) { const x = customParts(a), y = customParts(b); if (!x) return -1; if (!y) return 1; for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }",
  'custom update channel constants'
);
updater = replaceOnce(
  updater,
  "  async check() {\n    if (this.isolatedCandidate) return this.set({ status: 'latest', latest: this.app.getVersion(), notes: '', url: '', isolatedChannel: true });",
  "  async checkCustom() {\n    this.set({ status: 'checking', error: null, customChannel: true });\n    try {\n      const response = await fetch(CUSTOM_RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LilacAnime-Libmpv/${this.app.getVersion()}` } });\n      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);\n      const releases = (await response.json()).filter(item => !item.draft && customParts(item.tag_name));\n      releases.sort((a, b) => compareCustom(b.tag_name, a.tag_name));\n      const release = releases[0];\n      if (!release || !CUSTOM_CURRENT_TAG || compareCustom(release.tag_name, CUSTOM_CURRENT_TAG) <= 0) {\n        return this.set({ status: 'latest', latest: this.app.getVersion(), notes: '', url: release?.html_url || '', customChannel: true, customTag: CUSTOM_CURRENT_TAG });\n      }\n      const asset = installerAsset(release.assets || []);\n      if (!asset) throw new Error('커스텀 릴리스에 Windows 설치 파일(.exe)이 없습니다.');\n      this.asset = asset;\n      this.set({ status: 'available', latest: String(release.tag_name), notes: String(release.body || '').slice(0, 20000), url: release.html_url || '', size: Number(asset.size) || 0, customChannel: true, customTag: String(release.tag_name) });\n      this.download();\n      return this.state;\n    } catch (error) {\n      return this.set({ status: 'error', error: error.message || '커스텀 업데이트 확인 실패', customChannel: true });\n    }\n  }\n\n  async check() {\n    if (this.isolatedCandidate) return this.checkCustom();",
  'custom updater check'
);
updater = replaceOnce(updater, "    if (this.isolatedCandidate) return this.state;\n    if (this.state.status === 'ready') return this.state;", "    if (this.state.status === 'ready') return this.state;", 'allow custom download');
updater = replaceOnce(updater, "    if (this.isolatedCandidate) return false;\n    if (!this.installer || !fs.existsSync(this.installer)) throw new Error('다운로드된 설치 파일이 없습니다.');", "    if (!this.installer || !fs.existsSync(this.installer)) throw new Error('다운로드된 설치 파일이 없습니다.');", 'allow custom install');
updater = replaceOnce(updater, "  installOnQuit() { if (this.isolatedCandidate) return false; if (!MAC && this.state.status === 'ready' && !this.installing) try { this.install(false); } catch { /* next start */ } return true; }", "  installOnQuit() { if (!MAC && this.state.status === 'ready' && !this.installing) try { this.install(false); } catch { /* next start */ } return true; }", 'allow custom install on quit');
updater = replaceOnce(updater, "  if (this.isolatedCandidate) return { version, notes: '', url: '' };\n  const same = value => parseVersion(value).join('.') === parseVersion(version).join('.');", "  const same = value => parseVersion(value).join('.') === parseVersion(version).join('.');", 'custom notes fallback');
for (const marker of ['CUSTOM_RELEASES_API', 'checkCustom()', 'CUSTOM_CURRENT_TAG', 'compareCustom']) if (!updater.includes(marker)) throw new Error(`R2K updater marker missing: ${marker}`);
write('electron/updater.cjs', updater);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.49') throw new Error(`R2K expected upstream 0.5.49 package, got ${pkg.version}`);
pkg.version = '0.5.49-libmpv-r2k.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.49-r1';
pkg.build.appId = 'com.lilac.anime.desktop.libmpvr2kcandidate';
pkg.build.productName = 'LilacAnime Libmpv R2K 0.5.49';
pkg.build.win.executableName = 'LilacAnime-Libmpv-R2K';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2K-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2K_UPSTREAM_POLISH_OK base=0.5.49 arrows=upstream subtitles=official-baseline diagnostics=controls customUpdater=r2k');

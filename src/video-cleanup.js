// 워터마크 지우기 · 영상에 박힌 자막 지우기 (Android MpvPlayerEngine's watermark shader and subtitle erase): the picture is
// drawn through WebGL2 passes onto a canvas over the video, as Anime4K's is; with Anime4K on, this canvas is what
// Anime4K enlarges (the removal first, as on Android).
// - Watermark, mask: a learned (or imported) alpha map of a fixed translucent white logo is taken back out by inverse
//   alpha compositing: picture = (screen - a) / (1 - a).
// - Watermark, regions: no mask, rectangles picked on the frame are filled from their borders (like FFmpeg's delogo).
// - Burned-in subtitles: in the picked rectangles, text strokes (bright with a dark outline, or the other way) are
//   found at half size, widened, and filled with the colours around them.
(() => {
  const MAX_REGIONS = 4;
  let video, stage, getAspect, notify, canvas = null, gl = null, gpu = null, frameId = null, frameKind = null, size = '';
  let mask = null, maskUploaded = null, preview = false, learning = null, blocked = false;
  const flag = key => localStorage.getItem(key) === 'true';
  const regions = key => String(localStorage.getItem(key) || '').split(';').map(part => part.split(',').map(Number)).filter(v => v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0).slice(0, MAX_REGIONS);
  const serialize = list => list.map(r => r.map(v => v.toFixed(5)).join(',')).join(';');
  const watermarkOn = () => flag('watermarkEnabled') && Boolean(mask || regions('watermarkRegions').length);
  const eraseOn = () => flag('subtitleEraseEnabled') && regions('subtitleEraseRegions').length > 0;
  const visible = () => document.body.classList.contains('player-mode');
  const active = () => visible() && !blocked && (watermarkOn() || eraseOn());
  const anime4kOn = () => Boolean(window.LilacAnime4K?.mode?.() !== 'off' && window.LilacAnime4K?.running?.());

  // --- Saved mask (IndexedDB: a mask can be a few MB, more than localStorage holds) ---
  const db = () => new Promise((resolve, reject) => { const open = indexedDB.open('lilac-cleanup', 1); open.onupgradeneeded = () => open.result.createObjectStore('masks'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  async function store(value) { const base = await db(); await new Promise((resolve, reject) => { const tx = base.transaction('masks', 'readwrite'); value ? tx.objectStore('masks').put(value, 'watermark') : tx.objectStore('masks').delete('watermark'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); base.close(); }
  async function load() { try { const base = await db(); const value = await new Promise(resolve => { const request = base.transaction('masks').objectStore('masks').get('watermark'); request.onsuccess = () => resolve(request.result || null); request.onerror = () => resolve(null); }); base.close(); return value; } catch { return null; } }
  async function setMask(value) { mask = value; maskUploaded = null; await store(value); syncUI(); refresh(); }

  // --- WebGL2 ---
  const VS = `#version 300 es
in vec2 aPos; uniform float uFlip; out vec2 vUv;
void main() { vec2 uv = aPos * 0.5 + 0.5; vUv = vec2(uv.x, uFlip > 0.5 ? 1.0 - uv.y : uv.y); gl_Position = vec4(aPos, 0.0, 1.0); }`;
  // p (= vUv) is in picture coordinates, y down: the video texture is uploaded as it is (its first row at v = 0) and
  // only the pass onto the screen flips.
  const COMMON = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uSrc; uniform vec2 uSize; uniform vec4 uRects[4]; uniform int uRectCount;
bool inRect(vec2 p, vec4 r) { return p.x >= r.x && p.x <= r.x + r.z && p.y >= r.y && p.y <= r.y + r.w; }
bool inBand(vec2 p) { for (int i = 0; i < 4; i++) { if (i >= uRectCount) break; if (inRect(p, uRects[i])) return true; } return false; }
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;
  const FS_WATERMARK = `${COMMON}
uniform sampler2D uMask; uniform int uMode; uniform vec4 uMaskBox; uniform int uPreview;
// FFmpeg delogo's idea: each pixel of the rectangle from the four borders, the nearer ones weighing more.
vec3 delogo(vec2 p, vec4 r) {
  vec2 px = 2.0 / uSize; float x0 = r.x - px.x, x1 = r.x + r.z + px.x, y0 = r.y - px.y, y1 = r.y + r.w + px.y;
  vec3 L = texture(uSrc, vec2(x0, p.y)).rgb, R = texture(uSrc, vec2(x1, p.y)).rgb, T = texture(uSrc, vec2(p.x, y0)).rgb, B = texture(uSrc, vec2(p.x, y1)).rgb;
  vec4 w = 1.0 / max(vec4(p.x - x0, x1 - p.x, p.y - y0, y1 - p.y), vec4(1e-4));
  return (L * w.x + R * w.y + T * w.z + B * w.w) / (w.x + w.y + w.z + w.w);
}
void main() {
  vec2 p = vUv; vec4 c = texture(uSrc, p);
  if (uMode == 1) {
    vec2 uv = (p - uMaskBox.xy) / uMaskBox.zw;
    if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
      vec4 m = texture(uMask, uv);
      c.rgb = uPreview == 1 ? mix(c.rgb, vec3(1.0, 0.0, 0.0), clamp(m.a * 8.0, 0.0, 1.0)) : clamp((c.rgb - m.rgb) / max(1.0 - m.a, 0.05), 0.0, 1.0);
    }
  } else if (uMode == 2) {
    for (int i = 0; i < 4; i++) { if (i >= uRectCount) break; if (inRect(p, uRects[i])) c.rgb = uPreview == 1 ? mix(c.rgb, vec3(1.0, 0.0, 0.0), 0.5) : delogo(p, uRects[i]); }
  }
  outColor = vec4(c.rgb, 1.0);
}`;
  const FS_TEXT = `${COMMON}
void main() {
  vec2 p = vUv; if (!inBand(p)) { outColor = vec4(0.0); return; }
  float s = max(uSize.y / 1080.0, 0.5); vec2 pt = 1.0 / uSize;
  float l = lum(texture(uSrc, p).rgb); bool bright = l > 0.72, dark = l < 0.24;
  if (!bright && !dark) { outColor = vec4(0.0); return; }
  bool nearBright = false, nearDark = false;
  for (int i = 0; i < 8; i++) {
    float a = 0.7853982 * float(i); vec2 d = vec2(cos(a), sin(a)) * pt;
    float l1 = lum(texture(uSrc, p + d * (3.0 * s)).rgb), l2 = lum(texture(uSrc, p + d * (6.0 * s)).rgb);
    if (bright) nearDark = nearDark || l1 < 0.24 || l2 < 0.24;
    if (dark) nearBright = nearBright || l1 > 0.72 || l2 > 0.72;
  }
  float m = ((bright && nearDark) || (dark && nearBright)) ? 1.0 : 0.0;
  outColor = vec4(m, m, m, 1.0);
}`;
  const FS_DILATE = `${COMMON}
uniform sampler2D uText;
void main() {
  vec2 p = vUv; if (!inBand(p)) { outColor = vec4(0.0); return; }
  float s = max(uSize.y / 1080.0, 0.5); vec2 pt = 1.0 / uSize; float m = texture(uText, p).r;
  for (int i = 0; i < 8; i++) { float a = 0.7853982 * float(i); vec2 d = vec2(cos(a), sin(a)) * pt; m = max(m, texture(uText, p + d * (2.0 * s)).r); m = max(m, texture(uText, p + d * (4.0 * s)).r); }
  outColor = vec4(m, m, m, 1.0);
}`;
  const FS_FILL = `${COMMON}
uniform sampler2D uText; uniform int uPreview;
void main() {
  vec2 p = vUv; vec4 c = texture(uSrc, p);
  if (!inBand(p) || texture(uText, p).r < 0.5) { outColor = vec4(c.rgb, 1.0); return; }
  if (uPreview == 1) { outColor = vec4(mix(c.rgb, vec3(0.0, 0.6, 1.0), 0.7), 1.0); return; }
  float s = max(uSize.y / 1080.0, 0.5); vec2 pt = 1.0 / uSize; vec3 acc = vec3(0.0); float cnt = 0.0;
  for (int ring = 0; ring < 7; ring++) {
    float r = (5.0 + 5.0 * float(ring)) * s;
    for (int k = 0; k < 12; k++) {
      float a = 0.5235988 * float(k) + 0.45 * float(ring);
      vec2 q = clamp(p + vec2(cos(a), sin(a)) * r * pt, vec2(0.0), vec2(1.0));
      if (texture(uText, q).r < 0.5) { acc += texture(uSrc, q).rgb; cnt += 1.0; }
    }
    if (cnt >= 8.0) break;
  }
  outColor = vec4(cnt < 1.0 ? c.rgb : acc / cnt, 1.0);
}`;
  function program(fs) {
    const make = (type, source) => { const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)); return shader; };
    const p = gl.createProgram(); gl.attachShader(p, make(gl.VERTEX_SHADER, VS)); gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const uniforms = {}; for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) { const info = gl.getActiveUniform(p, i); uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
    return { p, u: uniforms };
  }
  function texture(w, h, data = null, filter = gl.LINEAR) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return t;
  }
  function target(w, h) { const t = texture(w, h), fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { t, fb, w, h }; }
  function create() {
    canvas = document.createElement('canvas'); canvas.className = 'anime4k-canvas cleanup-canvas'; canvas.setAttribute('aria-hidden', 'true'); canvas.style.visibility = 'hidden'; stage.append(canvas);
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('WebGL context lost')); });
    gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('이 PC의 그래픽에서 WebGL2를 쓸 수 없습니다.');
    const w = video.videoWidth, h = video.videoHeight, hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    canvas.width = w; canvas.height = h;
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gpu = { w, h, src: texture(0, 0), maskTex: texture(0, 0), a: target(w, h), text: target(hw, hh), wide: target(hw, hh),
      watermark: program(FS_WATERMARK), textPass: program(FS_TEXT), dilate: program(FS_DILATE), fill: program(FS_FILL) };
    size = `${w}:${h}`; maskUploaded = null; layout();
  }
  function release() {
    cancelFrame(); stage?.classList.remove('cleanup-active');
    const old = canvas, oldGl = gl; canvas = null; gl = null; gpu = null; size = ''; maskUploaded = null;
    old?.remove(); oldGl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  function fail(error) {
    console.warn('Video cleanup:', error); blocked = true; release();
    notify(`워터마크·자막 지우기를 적용하지 못해 원본으로 돌아왔어요: ${error.message || error}`); syncUI();
    window.LilacAnime4K?.reset?.();
  }
  function layout() {
    if (!canvas || !video.videoWidth) return;
    const width = stage.clientWidth, height = stage.clientHeight, scale = Math.min(width / video.videoWidth, height / video.videoHeight), original = getAspect() === 'original';
    const w = original ? video.videoWidth * scale : width, h = original ? video.videoHeight * scale : height;
    Object.assign(canvas.style, { width: `${w}px`, height: `${h}px`, left: `${(width - w) / 2}px`, top: `${(height - h) / 2}px` });
  }
  function pass(prog, out, flip, set) {
    gl.useProgram(prog.p); gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null); gl.viewport(0, 0, out ? out.w : gpu.w, out ? out.h : gpu.h);
    gl.uniform1f(prog.u.uFlip, flip ? 1 : 0); gl.uniform2f(prog.u.uSize, gpu.w, gpu.h); set(prog.u); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function bind(unit, tex, location) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(location, unit); }
  function rects(u, list) { const flat = new Float32Array(16); list.forEach((r, i) => flat.set(r, i * 4)); gl.uniform4fv(u.uRects, flat); gl.uniform1i(u.uRectCount, list.length); }
  // One frame through the passes onto the canvas. False when nothing is drawn.
  function draw() {
    if (!active() || video.readyState < 2 || !video.videoWidth) return false;
    if (gpu && size !== `${video.videoWidth}:${video.videoHeight}`) release();
    if (!gpu) create();
    gl.bindTexture(gl.TEXTURE_2D, gpu.src); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    if (mask && maskUploaded !== mask) { gl.bindTexture(gl.TEXTURE_2D, gpu.maskTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, mask.width, mask.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(mask.rgba)); maskUploaded = mask; }
    const erase = eraseOn(), wmMode = !flag('watermarkEnabled') ? 0 : mask ? 1 : regions('watermarkRegions').length ? 2 : 0;
    pass(gpu.watermark, erase ? gpu.a : null, !erase, u => {
      bind(0, gpu.src, u.uSrc); bind(1, gpu.maskTex, u.uMask); gl.uniform1i(u.uMode, wmMode); gl.uniform1i(u.uPreview, preview && wmMode ? 1 : 0);
      if (mask) gl.uniform4f(u.uMaskBox, mask.origin[0], mask.origin[1], mask.extent[0], mask.extent[1]);
      rects(u, wmMode === 2 ? regions('watermarkRegions') : []);
    });
    if (erase) {
      const band = regions('subtitleEraseRegions');
      pass(gpu.textPass, gpu.text, false, u => { bind(0, gpu.a.t, u.uSrc); rects(u, band); });
      pass(gpu.dilate, gpu.wide, false, u => { bind(0, gpu.a.t, u.uSrc); bind(1, gpu.text.t, u.uText); rects(u, band); });
      pass(gpu.fill, null, true, u => { bind(0, gpu.a.t, u.uSrc); bind(1, gpu.wide.t, u.uText); gl.uniform1i(u.uPreview, preview ? 1 : 0); rects(u, band); });
    }
    if (gl.isContextLost()) throw new Error('WebGL context lost');
    return true;
  }
  function cancelFrame() { if (frameId !== null) { if (frameKind === 'video') video.cancelVideoFrameCallback(frameId); else cancelAnimationFrame(frameId); } frameId = null; }
  function schedule() {
    if (frameId !== null || video.paused || video.ended || !active()) return;
    const next = () => { frameId = null; refresh(); };
    if (video.requestVideoFrameCallback) { frameKind = 'video'; frameId = video.requestVideoFrameCallback(next); } else { frameKind = 'animation'; frameId = requestAnimationFrame(next); }
  }
  // With Anime4K on, it draws this canvas (render() from its own frame loop) and this one stays hidden.
  function refresh() {
    if (!active()) { if (canvas) { release(); window.LilacAnime4K?.reset?.(); } return; }
    try {
      const shown = !anime4kOn();
      if (shown && draw()) { canvas.style.visibility = 'visible'; stage.classList.add('cleanup-active'); }
      else if (canvas) { canvas.style.visibility = 'hidden'; stage.classList.remove('cleanup-active'); }
      schedule();
    } catch (error) { fail(error); }
  }
  // For Anime4K: the canvas to enlarge (null when there is nothing to remove), drawn for the frame it is about to take.
  function source() { if (!active()) return null; try { if (!gpu) draw(); return canvas; } catch (error) { fail(error); return null; } }
  // Anime4K draws the frame from here, so this canvas itself is not shown.
  function render() { try { const drawn = draw(); if (canvas) { canvas.style.visibility = 'hidden'; stage.classList.remove('cleanup-active'); } return drawn; } catch (error) { fail(error); return false; } }
  // The frame on screen for a screenshot, when this canvas shows it.
  function frame() { try { return canvas && canvas.style.visibility === 'visible' && draw() ? canvas : null; } catch (error) { fail(error); return null; } }
  function changed() { blocked = false; syncUI(); window.LilacAnime4K?.reset?.(); refresh(); }

  // --- The player settings section ---
  function syncUI() {
    const regionsWm = regions('watermarkRegions'), regionsSub = regions('subtitleEraseRegions');
    $('#psWatermark').checked = flag('watermarkEnabled'); $('#psSubtitleErase').checked = flag('subtitleEraseEnabled');
    $('#psWatermarkState').textContent = learning ? '학습하는 중…' : mask ? `학습한 마스크로 지웁니다 (장면 ${mask.frames || '?'}개${mask.expectedError != null ? ` · ${mask.expectedError <= 0.015 ? '정확도 좋음' : mask.expectedError <= 0.04 ? '정확도 보통' : '잔상이 남을 수 있음'}` : ''})` : regionsWm.length ? `지정한 영역 ${regionsWm.length}곳을 주변 화면으로 메웁니다` : '켜면 영상을 분석해 워터마크 마스크를 만듭니다';
    $('#psWatermarkLearn').textContent = mask ? '마스크 다시 학습' : '마스크 자동 학습';
    $('#psWatermarkClear').classList.toggle('hidden', !mask);
    $('#psWatermarkPreview').classList.toggle('hidden', !(flag('watermarkEnabled') && (mask || regionsWm.length)) && !(flag('subtitleEraseEnabled') && regionsSub.length));
    $('#psWatermarkPreview').textContent = preview ? '미리보기 끄기' : '지우는 곳 미리보기';
    $('#psSubtitleEraseState').textContent = regionsSub.length ? `지정한 영역 ${regionsSub.length}곳에서 글자를 찾아 주변 화면으로 메웁니다 (실험적)` : '켜면 박힌 자막이 나오는 영역을 먼저 지정합니다';
    $('#psSubtitleErasePick').textContent = regionsSub.length ? '자막 영역 다시 지정' : '자막 영역 지정';
    if (blocked) $('#psWatermarkState').textContent = '이 PC에서 적용하지 못했어요. 다시 켜면 다시 시도합니다.';
  }

  // --- Picking rectangles on the paused frame (Android WatermarkRegionPicker) ---
  function pickRegions(title, initial) {
    return new Promise(resolve => {
      const wasPlaying = !video.paused; video.pause();
      const overlay = document.createElement('div'); overlay.className = 'region-picker';
      overlay.innerHTML = `<div class="region-picker-head"><b>${title}</b><span>끌어서 영역을 그리세요 (최대 ${MAX_REGIONS}곳). 영역을 누르면 지웁니다.</span></div><div class="region-picker-frame"><canvas></canvas></div><div class="region-picker-actions"><button type="button" data-act="clear">모두 지우기</button><button type="button" data-act="cancel">취소</button><button type="button" data-act="ok" class="primary">완료</button></div>`;
      $('#immersivePlayer').append(overlay);
      const box = overlay.querySelector('.region-picker-frame'), shot = overlay.querySelector('canvas');
      shot.width = video.videoWidth; shot.height = video.videoHeight; shot.getContext('2d').drawImage(video, 0, 0);
      let list = initial.map(r => r.slice()), drag = null;
      const paint = () => {
        box.querySelectorAll('.region').forEach(el => el.remove());
        for (const [i, r] of list.entries()) { const el = document.createElement('button'); el.type = 'button'; el.className = 'region'; el.title = '이 영역 지우기'; Object.assign(el.style, { left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }); el.onclick = event => { event.stopPropagation(); list.splice(i, 1); paint(); }; box.append(el); }
      };
      const at = event => { const rect = shot.getBoundingClientRect(); return [Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))]; };
      shot.addEventListener('pointerdown', event => { if (list.length >= MAX_REGIONS) { notify(`영역은 ${MAX_REGIONS}곳까지 지정할 수 있어요.`); return; } shot.setPointerCapture(event.pointerId); drag = { from: at(event), el: document.createElement('div') }; drag.el.className = 'region drawing'; box.append(drag.el); });
      shot.addEventListener('pointermove', event => { if (!drag) return; const [x, y] = at(event), [fx, fy] = drag.from; Object.assign(drag.el.style, { left: `${Math.min(x, fx) * 100}%`, top: `${Math.min(y, fy) * 100}%`, width: `${Math.abs(x - fx) * 100}%`, height: `${Math.abs(y - fy) * 100}%` }); });
      shot.addEventListener('pointerup', event => { if (!drag) return; const [x, y] = at(event), [fx, fy] = drag.from; drag.el.remove(); drag = null; const r = [Math.min(x, fx), Math.min(y, fy), Math.abs(x - fx), Math.abs(y - fy)]; if (r[2] > 0.005 && r[3] > 0.005) list.push(r); paint(); });
      const done = value => { overlay.remove(); window.removeEventListener('keydown', keys, true); if (wasPlaying) video.play().catch(() => {}); resolve(value); };
      const keys = event => { event.stopImmediatePropagation(); if (event.key === 'Escape') { event.preventDefault(); done(null); } };
      window.addEventListener('keydown', keys, true);
      overlay.querySelector('[data-act="clear"]').onclick = () => { list = []; paint(); };
      overlay.querySelector('[data-act="cancel"]').onclick = () => done(null);
      overlay.querySelector('[data-act="ok"]').onclick = () => done(list);
      paint();
    });
  }

  // --- Learning the mask (Android learnWatermarkMask): the episode is visited at up to 72 places, spread out by the
  // golden ratio, then around its darkest scenes; a frame is taken at each. Playback goes back where it was. ---
  async function grab(learner, capture) {
    const w = capture.width, h = capture.height, ctx = capture.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    let data; try { data = ctx.getImageData(0, 0, w, h).data; } catch { throw new Error('이 영상은 화면을 읽을 수 없어 학습할 수 없습니다 (다른 사이트의 영상).'); }
    learner.addFrame(data, w, h);
  }
  const seekTo = time => new Promise(resolve => {
    let settled = false; const finish = () => { if (settled) return; settled = true; clearTimeout(timer); video.removeEventListener('seeked', seeked); resolve(); };
    const seeked = () => { const ready = () => video.readyState >= 2 ? (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => setTimeout(finish, 120)) : setTimeout(finish, 250)) : setTimeout(ready, 100); ready(); };
    const timer = setTimeout(finish, 6000); video.addEventListener('seeked', seeked); video.currentTime = time;
  });
  async function learn() {
    if (learning) { learning.cancel = true; return; }
    const duration = video.duration;
    if (!(duration > 120)) { notify('영상 길이를 알 수 없거나 너무 짧아 학습할 수 없습니다.'); return; }
    const start = video.currentTime, wasPlaying = !video.paused, learner = new LilacWatermark.WatermarkLearner();
    const scale = Math.min(1, 1280 / video.videoWidth), capture = document.createElement('canvas'); capture.width = Math.round(video.videoWidth * scale); capture.height = Math.round(video.videoHeight * scale);
    const panel = document.createElement('div'); panel.className = 'cleanup-learning';
    panel.innerHTML = '<b>워터마크 마스크 학습 중</b><span>영상의 여러 장면을 옮겨 다니며 분석하고 있어요. 어두운 장면이 많을수록 정확해집니다.</span><span class="cleanup-learning-count"></span><button type="button">취소</button>';
    $('#immersivePlayer').append(panel);
    const run = learning = { cancel: false }; panel.querySelector('button').onclick = () => { run.cancel = true; };
    const count = panel.querySelector('.cleanup-learning-count'), darkness = []; let captures = 0, enough = false;
    syncUI(); video.pause();
    const sample = async time => {
      if (run.cancel) throw Object.assign(new Error('취소'), { canceled: true });
      await seekTo(Math.max(0, Math.min(duration - 1, time))); await grab(learner, capture); captures++;
      darkness.push([time, learner.lastRingLuma]); count.textContent = `분석한 장면 ${learner.acceptedFrames}개 · 어두운 장면 ${learner.darkFrames}개`;
      return learner.acceptedFrames >= 16 && captures % 4 === 0 && learner.quickExpectedError() <= 0.012;
    };
    try {
      for (const time of [0.4, 1.2, 2.6]) { if (enough) break; enough = await sample(time); }
      for (let i = 0; !enough && captures < 44; i++) enough = await sample(duration * (0.03 + 0.94 * (((i + 1) * 0.6180339887498949) % 1)));
      if (!enough) {
        const darkest = darkness.filter(([, luma]) => luma < 70).sort((a, b) => a[1] - b[1]).slice(0, 6);
        outer: for (const [time] of darkest) for (const off of [-4, -1.5, 1.5, 4]) { if (captures >= 72) break outer; if ((enough = await sample(Math.min(duration * 0.97, Math.max(duration * 0.03, time + off))))) break outer; }
      }
      const result = learner.finish();
      if (!result) throw new Error(learner.failureReason || '워터마크를 찾지 못했습니다.');
      localStorage.setItem('watermarkEnabled', 'true');
      await setMask({ ...result, rgba: result.rgba.buffer, at: Date.now() });
      notify(`워터마크 마스크를 만들었어요 (${result.expectedError <= 0.015 ? '정확도 좋음' : result.expectedError <= 0.04 ? '정확도 보통' : '어두운 장면이 부족해 잔상이 남을 수 있어요'} · 장면 ${result.frames}개, 어두운 장면 ${result.darkFrames}개)`);
    } catch (error) { if (!error.canceled) notify(error.message || '마스크를 만들지 못했습니다.'); }
    finally { learning = null; panel.remove(); await seekTo(start); if (wasPlaying) video.play().catch(() => {}); changed(); }
  }

  function init(options) {
    video = document.querySelector('#video'); stage = document.querySelector('#videoStage'); getAspect = options.getAspect; notify = options.notify;
    load().then(value => { if (value?.rgba) { mask = value; syncUI(); refresh(); } });
    $('#psWatermark').onchange = async event => {
      if (event.target.checked && !mask && !regions('watermarkRegions').length) { event.target.checked = false; learn(); return; }
      localStorage.setItem('watermarkEnabled', String(event.target.checked)); changed();
    };
    $('#psWatermarkLearn').onclick = () => learn();
    $('#psWatermarkPick').onclick = async () => { const list = await pickRegions('워터마크 영역 지정', regions('watermarkRegions')); if (!list) return; localStorage.setItem('watermarkRegions', serialize(list)); if (list.length) localStorage.setItem('watermarkEnabled', 'true'); if (mask && list.length) notify('학습한 마스크가 있으면 마스크로 지워요. 영역으로 지우려면 마스크를 삭제하세요.'); changed(); };
    $('#psWatermarkImport').onclick = () => $('#psWatermarkFile').click();
    $('#psWatermarkFile').onchange = async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      try { const parsed = LilacWatermark.parseMaskShader(await file.text()); localStorage.setItem('watermarkEnabled', 'true'); await setMask({ ...parsed, rgba: parsed.rgba.buffer, at: Date.now() }); notify('워터마크 마스크를 적용했어요.'); changed(); }
      catch (error) { notify(error.message || '마스크를 불러오지 못했습니다.'); }
    };
    $('#psWatermarkClear').onclick = async () => { if (!await askConfirm('학습한 워터마크 마스크를 삭제할까요?', { ok: '삭제', danger: true })) return; preview = false; await setMask(null); changed(); };
    $('#psWatermarkPreview').onclick = () => { preview = !preview; syncUI(); window.LilacAnime4K?.reset?.(); refresh(); };
    $('#psSubtitleErase').onchange = async event => {
      if (event.target.checked && !regions('subtitleEraseRegions').length) { event.target.checked = false; $('#psSubtitleErasePick').click(); return; }
      localStorage.setItem('subtitleEraseEnabled', String(event.target.checked)); changed();
    };
    $('#psSubtitleErasePick').onclick = async () => { const list = await pickRegions('박힌 자막 영역 지정', regions('subtitleEraseRegions')); if (!list) return; localStorage.setItem('subtitleEraseRegions', serialize(list)); localStorage.setItem('subtitleEraseEnabled', String(list.length > 0)); changed(); };
    for (const event of ['loadeddata', 'playing', 'seeked', 'resize']) video.addEventListener(event, refresh);
    for (const event of ['pause', 'ended']) video.addEventListener(event, cancelFrame);
    video.addEventListener('emptied', () => { release(); blocked = false; });
    new ResizeObserver(layout).observe(stage);
    new MutationObserver(() => { if (visible()) refresh(); else release(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    syncUI(); refresh();
  }
  window.LilacCleanup = { init, source, render, frame, layout, active, syncUI };
})();

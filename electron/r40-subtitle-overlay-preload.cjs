'use strict';

const { ipcRenderer } = require('electron');

const STYLE_KEYS = [
  'fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing',
  'color','textShadow','webkitTextStroke','webkitTextStrokeWidth','webkitTextStrokeColor',
  'filter','whiteSpace','overflowWrap','wordBreak','textAlign','textDecoration',
  'maxWidth','opacity','visibility','direction','writingMode'
];

function applyStyle(node, style = {}) {
  for (const key of STYLE_KEYS) {
    const value = style[key];
    if (value == null || value === '') continue;
    try { node.style[key] = String(value); } catch {}
  }
}
function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function px(value) { return `${Math.round(finite(value) * 1000) / 1000}px`; }

let ready = false;
let lastPayload = null;
let renderGeneration = 0;
let loadedCustomFontPath = '';
let loadedCustomFontPromise = null;

async function prepareCustomFont(fontStyle, fontPath, generation) {
  fontStyle.textContent = '';
  if (!fontPath) {
    return { current: generation === renderGeneration, ready: true, custom: false };
  }

  // LILAC_R40_CUSTOM_FONT_FORMAT_AGNOSTIC
  // Match the focused DOM's proven font path exactly: main process reads the selected
  // file through the existing font:default IPC, then Chromium receives the bytes via
  // FontFace instead of trying to fetch a local file:// URL from this sandboxed overlay.
  // The promise is cached per selected path so cue mutations never reread/reparse a
  // multi-megabyte font; a newer path supersedes an older async completion.
  if (fontPath !== loadedCustomFontPath || !loadedCustomFontPromise) {
    const requestedPath = fontPath;
    loadedCustomFontPath = requestedPath;
    loadedCustomFontPromise = (async () => {
      const font = await ipcRenderer.invoke('font:default', '기본체', requestedPath);
      if (loadedCustomFontPath !== requestedPath || !font?.data) return false;
      const bytes = new Uint8Array(font.data);
      if (!bytes.byteLength) return false;
      const face = new FontFace('LilacSubtitle', bytes);
      await face.load();
      if (loadedCustomFontPath !== requestedPath) return false;
      [...document.fonts].filter(item => item.family === 'LilacSubtitle').forEach(item => document.fonts.delete(item));
      document.fonts.add(face);
      // Keep an explicit FontFaceSet verification in addition to face.load(); this is
      // the runtime proof consumed by the hard gate, not a timing delay or fallback.
      const verified = await document.fonts.load('16px "LilacSubtitle"', 'R40');
      return !Array.isArray(verified) || verified.length > 0;
    })().catch(() => false);
  }

  const fontReady = await loadedCustomFontPromise;
  if (generation !== renderGeneration) return { current: false, ready: false, custom: true };
  return { current: true, ready: fontReady === true, custom: true };
}

async function render(payload = {}) {
  lastPayload = payload;
  if (!ready) return;
  const generation = ++renderGeneration;
  const root = document.getElementById('root');
  const stack = document.getElementById('stack');
  const fontStyle = document.getElementById('customFont');
  if (!root || !stack || !fontStyle) return;

  const active = payload.active === true && Array.isArray(payload.cues) && payload.cues.length > 0;
  // Hide while rebuilding and while a custom font is loading. A stale async font
  // completion is ignored by renderGeneration, so an older cue can never flash.
  root.style.display = 'none';
  document.body.dataset.active = '0';
  document.body.dataset.fontReady = '0';
  if (!active) {
    stack.replaceChildren();
    fontStyle.textContent = '';
    document.body.dataset.fontReady = '1';
    document.body.dataset.revision = String(payload.revision || 0);
    return;
  }

  const rect = payload.stackRect || {};
  stack.style.left = px(rect.x);
  stack.style.top = px(rect.y);
  stack.style.width = px(Math.max(0, finite(rect.width)));
  stack.style.height = px(Math.max(0, finite(rect.height)));
  stack.style.right = 'auto';
  stack.style.bottom = 'auto';
  stack.style.gap = String(payload.stackGap || '0px');
  stack.style.alignItems = String(payload.stackAlignItems || 'center');
  stack.style.justifyContent = String(payload.stackJustifyContent || 'normal');
  applyStyle(stack, payload.stackStyle);

  const fragment = document.createDocumentFragment();
  for (const cue of payload.cues) {
    const line = document.createElement('div');
    line.className = 'lilac-vtt-cue';
    line.innerHTML = String(cue?.html || '');
    applyStyle(line, cue?.style || {});
    fragment.append(line);
  }
  stack.replaceChildren(fragment);

  const fontPath = String(payload.fontPath || '');
  const font = await prepareCustomFont(fontStyle, fontPath, generation);
  if (!font.current || generation !== renderGeneration) return;

  // If a selected custom font is unreadable, remain usable with the exact
  // computed fallback family already serialized by the focused DOM, but expose
  // the failure to runtime diagnostics instead of silently claiming font parity.
  document.body.dataset.fontReady = font.ready ? '1' : '0';
  document.body.dataset.fontCustom = font.custom ? '1' : '0';
  root.style.display = 'block';
  document.body.dataset.active = '1';
  document.body.dataset.revision = String(payload.revision || 0);
  document.body.dataset.marker = 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY';
}

window.addEventListener('DOMContentLoaded', () => {
  ready = true;
  void render(lastPayload || { active:false, cues:[] });
  ipcRenderer.send('r40-subtitle-overlay:ready');
});
ipcRenderer.on('r40-subtitle-overlay:render', (_event, payload) => { void render(payload); });

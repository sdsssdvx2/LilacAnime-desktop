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
function cssUrl(value = '') { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

let ready = false;
let lastPayload = null;
let renderGeneration = 0;

async function prepareCustomFont(fontStyle, fontUrl, generation) {
  if (!/^file:\/\//i.test(fontUrl)) {
    fontStyle.textContent = '';
    return { current: generation === renderGeneration, ready: true, custom: false };
  }

  // Do not force format("truetype"): the app accepts TTF/OTF/TTC/WOFF/WOFF2.
  // Chromium should infer the actual container from the file URL, matching the
  // focused DOM path that loads the same bytes through FontFace('LilacSubtitle').
  fontStyle.textContent = `@font-face{font-family:LilacSubtitle;src:url("${cssUrl(fontUrl)}");font-display:block}`; // LILAC_R40_CUSTOM_FONT_FORMAT_AGNOSTIC
  try {
    const loaded = await document.fonts.load('16px "LilacSubtitle"', 'R40');
    if (generation !== renderGeneration) return { current: false, ready: false, custom: true };
    const fontReady = Array.isArray(loaded) ? loaded.length > 0 : true;
    return { current: true, ready: fontReady, custom: true };
  } catch {
    return { current: generation === renderGeneration, ready: false, custom: true };
  }
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

  const fontUrl = String(payload.fontUrl || '');
  const font = await prepareCustomFont(fontStyle, fontUrl, generation);
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

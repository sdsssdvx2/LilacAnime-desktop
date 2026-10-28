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

function render(payload = {}) {
  lastPayload = payload;
  if (!ready) return;
  const root = document.getElementById('root');
  const stack = document.getElementById('stack');
  const fontStyle = document.getElementById('customFont');
  if (!root || !stack || !fontStyle) return;

  const active = payload.active === true && Array.isArray(payload.cues) && payload.cues.length > 0;
  root.style.display = active ? 'block' : 'none';
  if (!active) {
    stack.replaceChildren();
    document.body.dataset.active = '0';
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

  const fontUrl = String(payload.fontUrl || '');
  fontStyle.textContent = /^file:\/\//i.test(fontUrl)
    ? `@font-face{font-family:LilacSubtitle;src:url("${cssUrl(fontUrl)}") format("truetype");font-display:block}`
    : '';

  const fragment = document.createDocumentFragment();
  for (const cue of payload.cues) {
    const line = document.createElement('div');
    line.className = 'lilac-vtt-cue';
    line.innerHTML = String(cue?.html || '');
    applyStyle(line, cue?.style || {});
    fragment.append(line);
  }
  stack.replaceChildren(fragment);
  document.body.dataset.active = '1';
  document.body.dataset.revision = String(payload.revision || 0);
  document.body.dataset.marker = 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY';
}

window.addEventListener('DOMContentLoaded', () => {
  ready = true;
  render(lastPayload || { active:false, cues:[] });
  ipcRenderer.send('r40-subtitle-overlay:ready');
});
ipcRenderer.on('r40-subtitle-overlay:render', (_event, payload) => render(payload));

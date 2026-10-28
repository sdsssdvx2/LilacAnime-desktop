'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');
const assert = (value, message) => { if (!value) throw new Error(message); };

function once(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function section(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start || source.indexOf(startMarker, start + startMarker.length) >= 0) {
    throw new Error(`${label}: structural boundary invalid`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

let main = read('electron/main.cjs');
let preload = read('electron/preload.cjs');
let entry = read('src/libmpv-shared-entry.js');
let bridge = read('electron/libmpv-shared-main.cjs');

for (const marker of ['MiniPlayerWindowController', "ipcMain.handle('player:miniplayer'", 'createWindow()']) {
  assert(main.includes(marker), `R40 requires R39 main/miniplayer baseline: ${marker}`);
}
for (const marker of ['setMiniPlayer:', 'setPlayerFullscreen:']) assert(preload.includes(marker), `R40 requires R39 preload baseline: ${marker}`);
for (const marker of ['data-lilac-vtt-overlay', 'refreshSubtitleOverlay() {', '_subtitleStack', 'getCueAsHTML']) {
  assert(entry.includes(marker), `R40 requires DOM subtitle overlay baseline: ${marker}`);
}
for (const marker of ['LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK', 'function r34SetNativeSubtitleVisible(', 'r34SubtitleTransitions']) {
  assert(bridge.includes(marker), `R40 requires R39 subtitle/handoff bridge baseline: ${marker}`);
}
for (const support of ['electron/r40-subtitle-overlay.html','electron/r40-subtitle-overlay-preload.cjs','electron/r40-subtitle-overlay-window.cjs']) {
  assert(fs.existsSync(file(support)), `R40 subtitle support missing: ${support}`);
}
assert(!main.includes('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY'), 'R40 subtitle main already applied');
assert(!entry.includes('LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY'), 'R40 subtitle renderer already applied');

// ---------------------------------------------------------------------------
// Main-process overlay window. It is an owned, transparent, click-through window
// that carries text only. The R33 native video popup remains a full rectangle, so
// no Chromium-video hole or black/stale rectangle can reappear.
// ---------------------------------------------------------------------------
main = once(main,
  "const { DesktopState } = require('./desktop-state.cjs');",
  "const { DesktopState } = require('./desktop-state.cjs');\nconst { R40SubtitleOverlayWindowController } = require('./r40-subtitle-overlay-window.cjs'); // LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY",
  'R40 subtitle overlay controller require');
main = once(main,
  'let mainWindow = null;\nlet startupComplete = false;',
  `let mainWindow = null;\nlet r40SubtitleOverlay = null;\nlet startupComplete = false;`,
  'R40 subtitle overlay global');

main = once(main,
  `  mainWindow = win;\n  desktopState.attach(win);`,
  `  mainWindow = win;\n  desktopState.attach(win);\n  const r40SyncSubtitleOverlay = reason => { try { r40SubtitleOverlay?.sync(win, reason); } catch {} };\n  win.on('move', () => r40SyncSubtitleOverlay('owner-move'));\n  win.on('resize', () => r40SyncSubtitleOverlay('owner-resize'));\n  win.on('restore', () => r40SyncSubtitleOverlay('owner-restore'));\n  win.on('show', () => r40SyncSubtitleOverlay('owner-show'));\n  win.on('always-on-top-changed', () => r40SyncSubtitleOverlay('owner-topmost'));\n  win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'));\n  win.on('hide', () => r40SubtitleOverlay?.hide('owner-hidden'));\n  win.on('minimize', () => r40SubtitleOverlay?.hide('owner-minimized'));`,
  'R40 subtitle overlay owner lifecycle');
main = once(main,
  `  win.on('closed', () => { if (mainWindow === win) { mainWindow = null; miruroRequest.close(); } });`,
  `  win.on('closed', () => { if (mainWindow === win) { r40SubtitleOverlay?.destroy('owner-closed'); mainWindow = null; miruroRequest.close(); } });`,
  'R40 subtitle overlay owner close');

main = once(main,
  `  ipcMain.handle('desktop:settings',()=>desktopState.settings());`,
  `  r40SubtitleOverlay = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir: __dirname });\n  ipcMain.handle('player:native-subtitle-overlay', async (event, payload = {}) => {\n    const win = BrowserWindow.fromWebContents(event.sender);\n    if (!win || win !== mainWindow || win.isDestroyed()) return { ok:false, reason:'not-main-window', marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY' };\n    return r40SubtitleOverlay.update(win, payload);\n  });\n  ipcMain.handle('player:native-subtitle-overlay-state', event => {\n    const win = BrowserWindow.fromWebContents(event.sender);\n    if (!win || win !== mainWindow) return { marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', active:false, reason:'not-main-window' };\n    return r40SubtitleOverlay.snapshot();\n  });\n  ipcMain.handle('desktop:settings',()=>desktopState.settings());`,
  'R40 subtitle overlay IPC');

// ---------------------------------------------------------------------------
// Stable preload bridge. Keep the shared-texture preload byte-invariant: this is
// only the normal application preload and does not touch direct WebGPU delivery.
// ---------------------------------------------------------------------------
preload = once(preload,
  `  setPlayerFullscreen: enabled => ipcRenderer.invoke('player:fullscreen', Boolean(enabled)),`,
  `  setPlayerFullscreen: enabled => ipcRenderer.invoke('player:fullscreen', Boolean(enabled)),\n  setNativeSubtitleOverlay: payload => ipcRenderer.invoke('player:native-subtitle-overlay', payload),\n  nativeSubtitleOverlayState: () => ipcRenderer.invoke('player:native-subtitle-overlay-state'),`,
  'R40 subtitle overlay preload API');

// ---------------------------------------------------------------------------
// Renderer: the existing DOM VTT overlay remains the single style/layout engine.
// Observe what it actually rendered and serialize exact viewport geometry +
// computed styles. No second set of subtitle-size/weight/outline formulas exists.
// ---------------------------------------------------------------------------
entry = once(entry,
  `    this._subtitleOverlayText = '';`,
  `    this._subtitleOverlayText = '';\n    this._r40SubtitleOverlayRevision = 0; // LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY\n    this._r40SubtitleOverlaySignature = '';\n    this._r40SubtitleOverlayQueued = false;\n    this._r40SubtitleOverlayState = null;\n    this._r40SubtitleFocusHandler = () => this._r40QueueSubtitleOverlaySync(true);\n    this._r40SubtitleMutationObserver = new MutationObserver(() => this._r40QueueSubtitleOverlaySync());`,
  'R40 renderer overlay state');

entry = once(entry,
  `  connectedCallback() {\n    this._resizeObserver.observe(this);`,
  `  connectedCallback() {\n    this._resizeObserver.observe(this);\n    if (this._subtitleLayer) this._r40SubtitleMutationObserver.observe(this._subtitleLayer, { subtree:true, childList:true, attributes:true, characterData:true });\n    window.addEventListener('focus', this._r40SubtitleFocusHandler, true);\n    window.addEventListener('blur', this._r40SubtitleFocusHandler, true);`,
  'R40 renderer overlay connect');

entry = once(entry,
  `  disconnectedCallback() {\n    this._resizeObserver.disconnect();`,
  `  disconnectedCallback() {\n    this._resizeObserver.disconnect();\n    this._r40SubtitleMutationObserver.disconnect();\n    window.removeEventListener('focus', this._r40SubtitleFocusHandler, true);\n    window.removeEventListener('blur', this._r40SubtitleFocusHandler, true);\n    this._r40SendSubtitleOverlayInactive('element-disconnected');`,
  'R40 renderer overlay disconnect');

const r40Methods = String.raw`  _r40SubtitleComputedStyle(node) {
    if (!node) return {};
    const style = getComputedStyle(node);
    const keys = [
      'fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing',
      'color','textShadow','webkitTextStroke','webkitTextStrokeWidth','webkitTextStrokeColor',
      'filter','whiteSpace','overflowWrap','wordBreak','textAlign','textDecoration',
      'maxWidth','opacity','visibility','direction','writingMode'
    ];
    const out = {};
    for (const key of keys) {
      const value = style[key];
      if (value != null && value !== '') out[key] = String(value);
    }
    return out;
  }

  _r40SubtitlePayload(forceInactive = false) {
    const layer = this._subtitleLayer;
    const stack = this._subtitleStack;
    const cueNodes = stack ? [...stack.querySelectorAll('.lilac-vtt-cue')] : [];
    const active = !forceInactive && !document.hasFocus() && this.isConnected && this._playerVisible() &&
      Boolean(layer && stack && layer.style.display !== 'none' && getComputedStyle(layer).display !== 'none') && cueNodes.length > 0;
    if (!active) {
      return { marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', revision:++this._r40SubtitleOverlayRevision, active:false, cues:[] };
    }
    const rect = stack.getBoundingClientRect();
    const stackStyle = getComputedStyle(stack);
    return {
      marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
      revision:++this._r40SubtitleOverlayRevision,
      active:true,
      stackRect:{ x:rect.x, y:rect.y, width:rect.width, height:rect.height },
      stackStyle:this._r40SubtitleComputedStyle(stack),
      stackGap:String(stackStyle.gap || '0px'),
      stackAlignItems:String(stackStyle.alignItems || 'center'),
      stackJustifyContent:String(stackStyle.justifyContent || 'normal'),
      fontPath:String(localStorage.getItem('subtitleFontPath') || ''),
      cues:cueNodes.map(node => ({ html:node.innerHTML, style:this._r40SubtitleComputedStyle(node) }))
    };
  }

  _r40QueueSubtitleOverlaySync(force = false) {
    if (!window.lilac?.setNativeSubtitleOverlay) return;
    if (force) this._r40SubtitleOverlaySignature = '';
    if (this._r40SubtitleOverlayQueued) return;
    this._r40SubtitleOverlayQueued = true;
    queueMicrotask(() => {
      this._r40SubtitleOverlayQueued = false;
      const payload = this._r40SubtitlePayload(false);
      const comparable = { ...payload, revision:0 };
      const signature = JSON.stringify(comparable);
      if (signature === this._r40SubtitleOverlaySignature) return;
      this._r40SubtitleOverlaySignature = signature;
      Promise.resolve(window.lilac.setNativeSubtitleOverlay(payload)).then(state => { this._r40SubtitleOverlayState = state || null; }).catch(() => { this._r40SubtitleOverlaySignature = ''; });
    });
  }

  _r40SendSubtitleOverlayInactive(reason = 'inactive') {
    if (!window.lilac?.setNativeSubtitleOverlay) return;
    const payload = { marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', revision:++this._r40SubtitleOverlayRevision, active:false, reason, cues:[] };
    this._r40SubtitleOverlaySignature = JSON.stringify({ ...payload, revision:0 });
    Promise.resolve(window.lilac.setNativeSubtitleOverlay(payload)).then(state => { this._r40SubtitleOverlayState = state || null; }).catch(() => {});
  }

`;
entry = once(entry,
  '  refreshSubtitleOverlay() {',
  r40Methods + '  refreshSubtitleOverlay() {',
  'R40 computed subtitle serializer methods');

// R2J/R2T refreshes the DOM subtitle at every cue/time/style change. The mutation
// observer above catches its actual final output; call once here as a fail-safe for
// pure style assignments that an engine might coalesce.
const refreshStart = entry.indexOf('  refreshSubtitleOverlay() {');
const refreshEnd = entry.indexOf('\n\n  async _syncR32NativeSubtitleFallbackStyle()', refreshStart);
if (refreshStart < 0 || refreshEnd <= refreshStart) throw new Error('R40 refreshSubtitleOverlay boundary missing');
let refreshBlock = entry.slice(refreshStart, refreshEnd);
const refreshClose = refreshBlock.lastIndexOf('\n  }');
if (refreshClose < 0) throw new Error('R40 refreshSubtitleOverlay closing brace missing');
refreshBlock = refreshBlock.slice(0, refreshClose) + '\n    this._r40QueueSubtitleOverlaySync();' + refreshBlock.slice(refreshClose);
entry = entry.slice(0, refreshStart) + refreshBlock + entry.slice(refreshEnd);

// ---------------------------------------------------------------------------
// Native subtitle is no longer a visible renderer. Keep its loaded track for
// compatibility/recovery, but all focus transitions force sub-visibility=no.
// This removes the visual renderer switch shown in the real R39 recording.
// ---------------------------------------------------------------------------
bridge = once(bridge,
  '  let r34SubtitleTransitions = 0;',
  `  let r34SubtitleTransitions = 0;\n  let r40NativeSubtitleSuppressedRequests = 0; // LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY`,
  'R40 native subtitle suppression counter');

const nativeSubtitleFunction = String.raw`  function r34SetNativeSubtitleVisible(visible, reason = 'focus') {
    if (!addon || playerId == null) return false;
    const requested = Boolean(visible);
    if (requested) r40NativeSubtitleSuppressedRequests += 1;
    try {
      addon.command(playerId, ['set', 'sub-visibility', 'no']);
      if (r34SubtitleVisible !== false) r34SubtitleTransitions += 1;
      r34SubtitleVisible = false;
      return true;
    } catch (error) {
      metrics.commandFailures += 1;
      metrics.lastCommandError = { command: 'set', property: 'sub-visibility', error: safeBridgeError(error), reason };
      return false;
    }
  }

`;
bridge = section(bridge,
  '  function r34SetNativeSubtitleVisible(',
  '  function r34CancelFocusHandoff(',
  nativeSubtitleFunction,
  'R40 native subtitle single-authority function');

bridge = once(bridge,
  `          subtitleTransitions: r34SubtitleTransitions,`,
  `          subtitleTransitions: r34SubtitleTransitions,\n          r40NativeSubtitleSuppressedRequests,`,
  'R40 subtitle authority diagnostics');

for (const marker of [
  'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', 'R40SubtitleOverlayWindowController',
  "player:native-subtitle-overlay", "player:native-subtitle-overlay-state",
  "win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'))"
]) assert(main.includes(marker), `R40 main marker missing: ${marker}`);
for (const marker of ['setNativeSubtitleOverlay:', 'nativeSubtitleOverlayState:']) assert(preload.includes(marker), `R40 preload marker missing: ${marker}`);
for (const marker of [
  'LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY', '_r40SubtitleComputedStyle', '_r40SubtitlePayload',
  '_r40QueueSubtitleOverlaySync', 'getBoundingClientRect()', 'getComputedStyle(node)',
  "fontPath:String(localStorage.getItem('subtitleFontPath') || '')"
]) assert(entry.includes(marker), `R40 entry marker missing: ${marker}`);
for (const marker of [
  'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', 'r40NativeSubtitleSuppressedRequests',
  "addon.command(playerId, ['set', 'sub-visibility', 'no'])"
]) assert(bridge.includes(marker), `R40 bridge subtitle marker missing: ${marker}`);
assert(!bridge.slice(bridge.indexOf('  function r34SetNativeSubtitleVisible('), bridge.indexOf('  function r34CancelFocusHandoff(')).includes("next ? 'yes' : 'no'"), 'R40 native subtitle visible path survived');
assert(bridge.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK'), 'R40 lost R37 handoff');
assert(!entry.includes('focus-staged-gpu-copy') && !entry.includes('copyTextureToTexture'), 'R40 renderer resurrected staged WebGPU path');

write('electron/main.cjs', main);
write('electron/preload.cjs', preload);
write('src/libmpv-shared-entry.js', entry);
write('electron/libmpv-shared-main.cjs', bridge);
console.log('R40_SINGLE_DOM_SUBTITLE_OK authority=focused-DOM-computed-style+unfocused-transparent-owned-overlay nativeSubtitle=always-hidden nativeVideo=R33-full-popup-preserved pip=R39-preserved');

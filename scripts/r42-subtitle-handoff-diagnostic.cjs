'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');

function once(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function requireMarker(source, marker, label) {
  if (!source.includes(marker)) throw new Error(`${label}: missing ${marker}`);
}

let entry = read('src/libmpv-shared-entry.js');
let controller = read('electron/r40-subtitle-overlay-window.cjs');
let overlayPreload = read('electron/r40-subtitle-overlay-preload.cjs');
let main = read('electron/main.cjs');
let bridge = read('electron/libmpv-shared-main.cjs');
const sharedPreload = read('electron/libmpv-shared-preload.cjs');

for (const marker of ['LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY', '_r40SubtitlePayload', '_r40QueueSubtitleOverlaySync']) requireMarker(entry, marker, 'R42 renderer baseline');
for (const marker of ['LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY', 'reconcileDeferred(', 'snapshot()']) requireMarker(controller, marker, 'R42 controller baseline');
for (const marker of ['LILAC_R40_CUSTOM_FONT_FORMAT_AGNOSTIC', "r40-subtitle-overlay:render"]) requireMarker(overlayPreload, marker, 'R42 overlay preload baseline');
for (const marker of ['LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', "player:native-subtitle-overlay-state"]) requireMarker(main, marker, 'R42 main baseline');
for (const marker of ['r41HandoffPlaying', 'r26BoundaryTrace']) requireMarker(bridge, marker, 'R42 bridge baseline');
requireMarker(sharedPreload, 'LILAC_R41_VISUAL_HANDOFF_COMMIT', 'R42 focused preload R41 baseline');
for (const text of [entry, controller, overlayPreload, main, bridge, sharedPreload]) {
  if (text.includes('LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC')) throw new Error('R42 diagnostic already applied');
}

// Source renderer: observe the exact computed cue state at the same instant R40
// serializes an unfocused subtitle. Diagnostic fields are intentionally separate
// from the style object applied by the overlay, so they cannot change rendering.
const sourceDiagHelper = String.raw`  _r42SubtitleStyleDiagnostic(node) {
    if (!node) return {};
    const style = getComputedStyle(node);
    const value = key => String(style[key] ?? '');
    return {
      display:value('display'),
      opacity:value('opacity'),
      visibility:value('visibility'),
      transitionProperty:value('transitionProperty'),
      transitionDuration:value('transitionDuration'),
      transitionDelay:value('transitionDelay'),
      animationName:value('animationName'),
      animationDuration:value('animationDuration'),
      animationDelay:value('animationDelay'),
      transform:value('transform'),
      filter:value('filter')
    };
  }

`;
entry = once(
  entry,
  '  _r40SubtitlePayload(forceInactive = false) {',
  sourceDiagHelper + '  _r40SubtitlePayload(forceInactive = false) {',
  'R42 source computed-style diagnostic helper'
);
entry = once(
  entry,
  `      fontPath:String(localStorage.getItem('subtitleFontPath') || ''),
      cues:cueNodes.map(node => ({ html:node.innerHTML, style:this._r40SubtitleComputedStyle(node) }))`,
  `      fontPath:String(localStorage.getItem('subtitleFontPath') || ''),
      diagnostic:{
        marker:'LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC',
        documentHasFocus:document.hasFocus(),
        stack:this._r42SubtitleStyleDiagnostic(stack),
        cues:cueNodes.map((node, index) => ({ index, ...this._r42SubtitleStyleDiagnostic(node) }))
      },
      cues:cueNodes.map(node => ({ html:node.innerHTML, style:this._r40SubtitleComputedStyle(node) }))`,
  'R42 attach source style diagnostic to active subtitle payload'
);

// Main-process overlay controller: keep a bounded lifecycle ring. The normal
// update() return remains small; the full ring is emitted only when diagnostics
// explicitly asks for snapshot({includeTrace:true}).
const cleanDiagnostic = String.raw`function cleanDiagnosticNode(node = {}) {
  const out = {};
  for (const key of ['display','opacity','visibility','transitionProperty','transitionDuration','transitionDelay','animationName','animationDuration','animationDelay','transform','filter']) {
    if (node?.[key] == null) continue;
    out[key] = String(node[key]).slice(0, 256);
  }
  if (Number.isFinite(Number(node?.index))) out.index = Math.max(0, Math.floor(Number(node.index)));
  return out;
}
function cleanDiagnostic(diag = {}) {
  const cues = Array.isArray(diag?.cues) ? diag.cues.slice(0, MAX_CUES).map(cleanDiagnosticNode) : [];
  return {
    marker: 'LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC',
    documentHasFocus: diag?.documentHasFocus === true,
    stack: cleanDiagnosticNode(diag?.stack),
    cues
  };
}
`;
controller = once(
  controller,
  'function sanitizePayload(payload = {}) {',
  cleanDiagnostic + '\nfunction sanitizePayload(payload = {}) {',
  'R42 controller diagnostic sanitizer'
);
controller = once(
  controller,
  `    fontPath: fontUrl ? fontPath : '',
    fontUrl,
    cues`,
  `    fontPath: fontUrl ? fontPath : '',
    fontUrl,
    diagnostic: cleanDiagnostic(payload.diagnostic),
    cues`,
  'R42 preserve source diagnostic through sanitizer'
);
controller = once(
  controller,
  `    this.ownerLifecycleReason = '';
  }`,
  `    this.ownerLifecycleReason = '';
    this.r42Trace = new Array(256); // LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC
    this.r42TraceNext = 0;
    this.r42TraceCount = 0;
    this.r42LastPaint = null;
  }`,
  'R42 controller trace state'
);
const traceMethods = String.raw`  _r42PushTrace(kind, details = {}) {
    const event = { wallMs: Date.now(), kind: String(kind || 'event'), ...details };
    this.r42Trace[this.r42TraceNext] = event;
    this.r42TraceNext = (this.r42TraceNext + 1) % this.r42Trace.length;
    this.r42TraceCount = Math.min(this.r42Trace.length, this.r42TraceCount + 1);
    return event;
  }

  _r42TraceSnapshot() {
    const out = [];
    const start = (this.r42TraceNext - this.r42TraceCount + this.r42Trace.length) % this.r42Trace.length;
    for (let i = 0; i < this.r42TraceCount; i += 1) out.push({ ...this.r42Trace[(start + i) % this.r42Trace.length] });
    return out;
  }

`;
controller = once(controller, '  async ensure(parent) {', traceMethods + '  async ensure(parent) {', 'R42 controller trace helpers');
controller = once(
  controller,
  `    win.webContents.on('render-process-gone', (_event, details) => {`,
  `    win.webContents.on('ipc-message', (_event, channel, ...args) => {
      if (channel !== 'r42-subtitle-overlay:paint') return;
      const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
      const paint = {
        marker:'LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC',
        stage:String(payload.stage || '').slice(0,64),
        revision:Math.max(0, Math.floor(finite(payload.revision))),
        generation:Math.max(0, Math.floor(finite(payload.generation))),
        rootDisplay:String(payload.rootDisplay || '').slice(0,64),
        rootOpacity:String(payload.rootOpacity || '').slice(0,64),
        rootVisibility:String(payload.rootVisibility || '').slice(0,64),
        stackOpacity:String(payload.stackOpacity || '').slice(0,64),
        cueOpacities:Array.isArray(payload.cueOpacities) ? payload.cueOpacities.slice(0,MAX_CUES).map(value => String(value).slice(0,64)) : [],
        cueTransitions:Array.isArray(payload.cueTransitions) ? payload.cueTransitions.slice(0,MAX_CUES).map(value => String(value).slice(0,128)) : []
      };
      this.r42LastPaint = paint;
      this._r42PushTrace('paint', paint);
    });
    win.webContents.on('render-process-gone', (_event, details) => {`,
  'R42 overlay paint IPC listener'
);
controller = once(
  controller,
  `    const state = this._recordParent(parent, safe);

    let blockedReason = '';`,
  `    const state = this._recordParent(parent, safe);
    this._r42PushTrace('update', {
      revision:safe.revision, active:safe.active, cueCount:safe.cues.length,
      parentFocused:state.parentFocused, parentMinimized:state.parentMinimized,
      windowVisible:Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible()),
      source:safe.diagnostic
    });

    let blockedReason = '';`,
  'R42 controller update trace'
);
controller = once(
  controller,
  `      this.hide('deferred-owner-focused', { preserveDeferred:true });
      return { ok: true, visible: false, deferred: true, ...this.snapshot() };`,
  `      this.hide('deferred-owner-focused', { preserveDeferred:true });
      this._r42PushTrace('defer-owner-focused', { revision:safe.revision, cueCount:safe.cues.length });
      return { ok: true, visible: false, deferred: true, ...this.snapshot() };`,
  'R42 deferred focus-race trace'
);
controller = once(
  controller,
  `    win.showInactive();
    win.moveTop?.();
    this.lastReason = 'payload-active';`,
  `    win.showInactive();
    win.moveTop?.();
    this._r42PushTrace('show-inactive', { revision:safe.revision, cueCount:safe.cues.length, windowVisible:Boolean(win.isVisible()) });
    this.lastReason = 'payload-active';`,
  'R42 showInactive trace'
);
controller = once(
  controller,
  `    this.deferredActivePayload = null;
    this.deferredReplayCount += 1;
    const result = await this.update(parent, deferred);`,
  `    this.deferredActivePayload = null;
    this.deferredReplayCount += 1;
    this._r42PushTrace('replay-deferred', { reason, revision:deferred.revision, cueCount:Array.isArray(deferred.cues) ? deferred.cues.length : 0 });
    const result = await this.update(parent, deferred);`,
  'R42 deferred replay trace'
);
controller = once(
  controller,
  `    this.visible = false;
    this.lastReason = reason;
  }

  destroy(reason = 'destroy') {`,
  `    this.visible = false;
    this.lastReason = reason;
    this._r42PushTrace('hide', { reason:String(reason || ''), windowVisible:Boolean(win && !win.isDestroyed() && win.isVisible()) });
  }

  destroy(reason = 'destroy') {`,
  'R42 hide trace'
);
controller = once(controller, '  snapshot() {', '  snapshot(options = {}) {', 'R42 diagnostic snapshot option');
controller = once(
  controller,
  `      marker: 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
      active: this.visible,`,
  `      marker: 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
      diagnosticMarker: 'LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC',
      traceCount: this.r42TraceCount,
      lastPaint: this.r42LastPaint,
      diagnosticTrace: options?.includeTrace === true ? this._r42TraceSnapshot() : undefined,
      active: this.visible,`,
  'R42 full diagnostic snapshot fields'
);

// Overlay renderer: report actual DOM computed opacity immediately after commit
// and at several paint boundaries. These callbacks are observation-only and are
// generation-guarded; stale cue timers cannot mutate current content.
const paintHelpers = String.raw`function r42PaintSnapshot(stage, payload, generation) {
  if (generation !== renderGeneration) return;
  const root = document.getElementById('root');
  const stack = document.getElementById('stack');
  if (!root || !stack) return;
  const rootStyle = getComputedStyle(root);
  const stackStyle = getComputedStyle(stack);
  const cueNodes = [...stack.querySelectorAll('.lilac-vtt-cue')];
  try {
    ipcRenderer.send('r42-subtitle-overlay:paint', {
      marker:'LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC',
      stage,
      revision:Number(payload?.revision) || 0,
      generation,
      rootDisplay:String(rootStyle.display || ''),
      rootOpacity:String(rootStyle.opacity || ''),
      rootVisibility:String(rootStyle.visibility || ''),
      stackOpacity:String(stackStyle.opacity || ''),
      cueOpacities:cueNodes.map(node => String(getComputedStyle(node).opacity || '')),
      cueTransitions:cueNodes.map(node => {
        const style = getComputedStyle(node);
        return String(style.transitionProperty || '') + '|' + String(style.transitionDuration || '') + '|' + String(style.transitionDelay || '') + '|' + String(style.animationName || '') + '|' + String(style.animationDuration || '');
      })
    });
  } catch {}
}
function r42SchedulePaintSnapshots(payload, generation) {
  r42PaintSnapshot('dom-commit', payload, generation);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      r42PaintSnapshot('raf-1', payload, generation);
      requestAnimationFrame(() => r42PaintSnapshot('raf-2', payload, generation));
    });
  }
  for (const delay of [50, 100, 200, 300]) {
    setTimeout(() => r42PaintSnapshot('t+' + delay + 'ms', payload, generation), delay);
  }
}

`;
overlayPreload = once(overlayPreload, 'let ready = false;', paintHelpers + 'let ready = false;', 'R42 paint diagnostic helpers');
overlayPreload = once(
  overlayPreload,
  `    document.body.dataset.revision = String(payload.revision || 0);
    return;`,
  `    document.body.dataset.revision = String(payload.revision || 0);
    r42PaintSnapshot('inactive-commit', payload, generation);
    return;`,
  'R42 inactive overlay commit trace'
);
overlayPreload = once(
  overlayPreload,
  `  document.body.dataset.marker = 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY';
}`,
  `  document.body.dataset.marker = 'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY';
  r42SchedulePaintSnapshots(payload, generation);
}`,
  'R42 active overlay paint sampling'
);

// Expose the controller's trace to the existing libmpv diagnostics object without
// adding a new user action. The source/video hot paths remain unchanged.
main = once(
  main,
  `  r40SubtitleOverlay = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir: __dirname });`,
  `  r40SubtitleOverlay = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir: __dirname });
  globalThis.__lilacR42SubtitleOverlayDiagnostics = () => r40SubtitleOverlay?.snapshot?.({ includeTrace:true }) || null; // LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC`,
  'R42 global overlay diagnostic getter'
);
main = once(
  main,
  `    return r40SubtitleOverlay.snapshot();`,
  `    return r40SubtitleOverlay.snapshot({ includeTrace:true });`,
  'R42 explicit overlay-state IPC includes trace'
);
bridge = once(
  bridge,
  `        r26BoundaryTrace: {`,
  `        r42SubtitleOverlay: typeof globalThis.__lilacR42SubtitleOverlayDiagnostics === 'function' ? globalThis.__lilacR42SubtitleOverlayDiagnostics() : null, // LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC
        r26BoundaryTrace: {`,
  'R42 include subtitle overlay in existing diagnostics'
);

write('src/libmpv-shared-entry.js', entry);
write('electron/r40-subtitle-overlay-window.cjs', controller);
write('electron/r40-subtitle-overlay-preload.cjs', overlayPreload);
write('electron/main.cjs', main);
write('electron/libmpv-shared-main.cjs', bridge);

const finalEntry = read('src/libmpv-shared-entry.js');
const finalController = read('electron/r40-subtitle-overlay-window.cjs');
const finalOverlayPreload = read('electron/r40-subtitle-overlay-preload.cjs');
const finalMain = read('electron/main.cjs');
const finalBridge = read('electron/libmpv-shared-main.cjs');
for (const [text, marker, label] of [
  [finalEntry, '_r42SubtitleStyleDiagnostic', 'renderer'],
  [finalController, 'diagnosticTrace', 'controller'],
  [finalController, "r42-subtitle-overlay:paint", 'controller paint channel'],
  [finalOverlayPreload, 'r42SchedulePaintSnapshots', 'overlay paint sampler'],
  [finalMain, '__lilacR42SubtitleOverlayDiagnostics', 'main getter'],
  [finalBridge, 'r42SubtitleOverlay', 'bridge diagnostics']
]) requireMarker(text, marker, `R42 final ${label}`);
for (const text of [finalEntry, finalController, finalOverlayPreload, finalMain, finalBridge]) requireMarker(text, 'LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC', 'R42 final marker');

console.log('R42_SUBTITLE_HANDOFF_DIAGNOSTIC_OK behavior=observation-only sourceStyle=opacity+transition+animation controller=bounded-256-lifecycle-ring overlayPaint=commit+raf2+50/100/200/300ms diagnostics=existing-libmpv-object');

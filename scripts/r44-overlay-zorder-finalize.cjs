'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'electron', 'r40-subtitle-overlay-window.cjs');
let text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
if (!text.includes('LILAC_R44_PREWARMED_SUBTITLE_OVERLAY')) throw new Error('R44 z-order finalize requires R44 prewarm transform');
const from = "    try { if (typeof win.setOpacity === 'function') win.setOpacity(1); } catch {}\n    this.revealPending = false;\n    this._r44Trace('reveal-visible', parent, { reason });";
const to = "    // Re-anchor once after two compositor paints. The native R33 owned popup may\n    // have been shown after blur/prewarm began; doing this while the overlay is still\n    // opacity 0 avoids cue-time z-order churn and keeps the subtitle HWND above it.\n    try { win.moveTop?.(); this.zOrderReanchors += 1; } catch {}\n    try { if (typeof win.setOpacity === 'function') win.setOpacity(1); } catch {}\n    this.revealPending = false;\n    this._r44Trace('reveal-visible-reanchored', parent, { reason });";
const first = text.indexOf(from);
if (first < 0 || text.indexOf(from, first + from.length) >= 0) throw new Error('R44 z-order finalize anchor mismatch');
text = text.slice(0, first) + to + text.slice(first + from.length);
fs.writeFileSync(target, text, 'utf8');
if (!text.includes('reveal-visible-reanchored')) throw new Error('R44 z-order finalize marker missing');
console.log('R44_OVERLAY_ZORDER_FINALIZE_OK reanchor=double-raf-before-opacity1 cue-time-moveTop=avoided');

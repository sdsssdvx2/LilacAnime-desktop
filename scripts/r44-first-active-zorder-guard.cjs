'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'electron', 'r40-subtitle-overlay-window.cjs');
let text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
if (!text.includes('LILAC_R44_PREWARMED_SUBTITLE_OVERLAY') || !text.includes('reveal-visible-reanchored')) {
  throw new Error('R44 first-active z-order guard requires prewarm + finalize transforms');
}
function once(from,to,label){const i=text.indexOf(from);if(i<0||text.indexOf(from,i+from.length)>=0)throw new Error(`R44 first-active anchor mismatch ${label}`);text=text.slice(0,i)+to+text.slice(i+from.length);}
once(
  "    this.firstShowSafeReveals = 0;\n    this.zOrderReanchors = 0;",
  "    this.firstShowSafeReveals = 0;\n    this.firstActiveSessionReanchors = 0;\n    this.sessionNeedsActiveReanchor = false;\n    this.zOrderReanchors = 0;",
  'state'
);
once(
  "      this.prewarmShows += 1;\n      this.visible = true;\n      this.contentActive = false;",
  "      this.prewarmShows += 1;\n      this.sessionNeedsActiveReanchor = true;\n      this.visible = true;\n      this.contentActive = false;",
  'prewarm session flag'
);
once(
  "    } else {\n      this.visible = true;\n      this.contentActive = true;\n      if (!this.revealPending) { try { if (typeof win.setOpacity === 'function') win.setOpacity(1); } catch {} }\n      this._r44Trace('active-existing-prewarmed-hwnd', parent, { revision: safe.revision });\n    }",
  "    } else {\n      this.visible = true;\n      this.contentActive = true;\n      if (this.sessionNeedsActiveReanchor) {\n        // R33 native popup can enter the owned-popup stack after blur prewarm. Re-anchor\n        // only the first active cue, while this overlay is fully transparent, then\n        // wait two paints before exposing subtitle pixels. Later cues never move z-order.\n        this.sessionNeedsActiveReanchor = false;\n        this.firstActiveSessionReanchors += 1;\n        try { if (typeof win.setOpacity === 'function') win.setOpacity(0); } catch {}\n        try { win.moveTop?.(); this.zOrderReanchors += 1; } catch {}\n        this._r44Trace('first-active-session-reanchor-opacity-zero', parent, { revision: safe.revision });\n        await this._r44RevealAfterPaint(win, parent, 'r44-first-active-session-reanchor');\n      } else if (!this.revealPending) {\n        try { if (typeof win.setOpacity === 'function') win.setOpacity(1); } catch {}\n      }\n      this._r44Trace('active-existing-prewarmed-hwnd', parent, { revision: safe.revision });\n    }",
  'first active guarded reanchor'
);
once(
  "      this.revealPending = false;\n      try { if (typeof win.setOpacity === 'function') win.setOpacity(0); } catch {}",
  "      this.revealPending = false;\n      this.sessionNeedsActiveReanchor = false;\n      try { if (typeof win.setOpacity === 'function') win.setOpacity(0); } catch {}",
  'hard hide reset'
);
once(
  "      firstShowSafeReveals: this.firstShowSafeReveals,\n      zOrderReanchors: this.zOrderReanchors,",
  "      firstShowSafeReveals: this.firstShowSafeReveals,\n      firstActiveSessionReanchors: this.firstActiveSessionReanchors,\n      sessionNeedsActiveReanchor: this.sessionNeedsActiveReanchor,\n      zOrderReanchors: this.zOrderReanchors,",
  'snapshot'
);
fs.writeFileSync(target,text,'utf8');
for(const marker of ['first-active-session-reanchor-opacity-zero','firstActiveSessionReanchors','sessionNeedsActiveReanchor'])if(!text.includes(marker))throw new Error(`R44 first-active marker missing ${marker}`);
console.log('R44_FIRST_ACTIVE_ZORDER_GUARD_OK first-active=opacity0+single-session-reanchor+double-raf later-cues=no-zorder-churn');

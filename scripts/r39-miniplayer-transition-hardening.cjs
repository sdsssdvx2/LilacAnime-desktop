'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'electron', 'miniplayer-window.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldBlock = `      win.setBounds?.(next, true);\n      win.show?.();\n      pin('after-show');\n      win.focus?.();\n      pin('after-focus');\n      await wait(50);\n      if (!pin('verify-50ms')) throw new Error(diag.lastError || 'always-on-top verification failed');\n      return this.snapshot(win);`;
const newBlock = `      // LILAC_R39_MINIPLAYER_BOUNDS_SETTLE: Windows can deliver leave-full-screen\n      // before the native restore transaction has finished. A bounds write issued at\n      // that instant is later overwritten by the old normal bounds (the real R38\n      // package reproduced this as 944x640 instead of the requested 16:9 mini-player).\n      const boundsMatch = actual => Boolean(actual) &&\n        Math.abs(Number(actual.x) - next.x) <= 3 && Math.abs(Number(actual.y) - next.y) <= 3 &&\n        Math.abs(Number(actual.width) - next.width) <= 3 && Math.abs(Number(actual.height) - next.height) <= 3;\n      const settleBounds = async reason => {\n        let last = win.getBounds?.() || null;\n        for (let attempt = 1; attempt <= 4; attempt += 1) {\n          win.setBounds?.(next, false);\n          await wait(attempt === 1 ? 80 : 120);\n          last = win.getBounds?.() || last;\n          if (boundsMatch(last)) return last;\n        }\n        diag.lastError = 'mini-player bounds did not settle: ' + String(reason || 'bounds') + ' actual=' + JSON.stringify(last) + ' target=' + JSON.stringify(next);\n        throw new Error(diag.lastError);\n      };\n\n      // Give the native fullscreen/unmaximize restore a chance to commit before the\n      // first mini-player bounds write, then verify again after show/focus because\n      // either operation can complete a delayed restore on Windows.\n      await wait(80);\n      await settleBounds('after-fullscreen-restore');\n      win.show?.();\n      pin('after-show');\n      win.focus?.();\n      pin('after-focus');\n      await wait(80);\n      if (!boundsMatch(win.getBounds?.())) await settleBounds('after-show-focus');\n      if (!pin('verify-bounds-settled')) throw new Error(diag.lastError || 'always-on-top verification failed');\n      return this.snapshot(win);`;

const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error(`R39 mini-player transition anchor expected once, found ${count}`);
source = source.replace(oldBlock, newBlock);
for (const marker of ['LILAC_R39_MINIPLAYER_BOUNDS_SETTLE', 'settleBounds', "after-fullscreen-restore", "after-show-focus", "verify-bounds-settled"]) {
  if (!source.includes(marker)) throw new Error(`R39 mini-player transition marker missing: ${marker}`);
}
fs.writeFileSync(target, source);
console.log('R39_MINIPLAYER_TRANSITION_HARDENING_OK fullscreenRestore=bounds-settle+verify attempts=4 topmost=preserved');

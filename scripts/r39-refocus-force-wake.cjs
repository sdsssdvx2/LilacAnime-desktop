'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', 'electron/libmpv-shared-main.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldBlock = `    if (wake) {
      r39PumpPhaseWakeups += 1;
      schedulePump(0);
    }`;
const newBlock = `    if (wake) {
      r39PumpPhaseWakeups += 1;
      // LILAC_R39_REFOCUS_FORCE_WAKE: schedulePump() intentionally refuses to
      // replace an existing timer. Refocus must not inherit a stale native-only
      // delay, so cancel the pending timer before requesting the immediate pump.
      if (pumpTimer) {
        clearTimeout(pumpTimer);
        pumpTimer = null;
      }
      schedulePump(0);
    }`;
const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error(`R39 refocus force-wake anchor expected once, found ${count}`);
source = source.replace(oldBlock, newBlock);
for (const marker of ['LILAC_R39_REFOCUS_FORCE_WAKE', 'clearTimeout(pumpTimer)', 'pumpTimer = null', 'schedulePump(0)']) {
  if (!source.includes(marker)) throw new Error(`R39 force-wake marker missing: ${marker}`);
}
fs.writeFileSync(target, source, 'utf8');
console.log('R39_REFOCUS_FORCE_WAKE_OK phase=reset timer=replace-existing focusWake=immediate');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function once(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

if (!source.includes('LILAC_R40_FRESH_FRAME_WAKE_GATING') ||
    !source.includes('LILAC_R40_CALLBACK_WATCHDOG_ONLY') ||
    !source.includes('frameProducerStarted')) {
  throw new Error('R40 watchdog-authority correction requires callback pacing + native producer baseline');
}

// R3E makes native producer mode callback-driven even if the historical JS
// bookkeeping flag nativeUpdateCallbackInstalled becomes stale across a source
// lifecycle. Never allow R3E's 0/6 ms queue-drain nextDelay to revive as a JS
// cadence timer while the native producer is active. The timer is recovery-only.
const oldFinally = `        if (nativeUpdateCallbackInstalled && nativeWakePending &&\n            (nativeWakePendingFrameId <= 0 || nativeWakePendingFrameId > Number(metrics.lastFrameId || 0))) {\n          nativeWakePending = false;\n          nativeWakePendingFrameId = 0;\n          metrics.nativeUpdateWakeups += 1;\n          void pump('pending-signal');\n        } else {\n          nativeWakePending = false;\n          nativeWakePendingFrameId = 0;\n          // LILAC_R40_CALLBACK_WATCHDOG_ONLY: native callbacks own frame cadence;\n          // the timer exists only as a 250 ms recovery path when callbacks stop.\n          schedulePump(nativeUpdateCallbackInstalled ? R30_PRODUCER_JS_WATCHDOG_MS : nextDelay);\n        }`;
const newFinally = `        const r40CallbackAuthoritative = frameProducerStarted || nativeUpdateCallbackInstalled; // LILAC_R40_PRODUCER_CALLBACK_AUTHORITY\n        if (r40CallbackAuthoritative && nativeWakePending &&\n            (nativeWakePendingFrameId <= 0 || nativeWakePendingFrameId > Number(metrics.lastFrameId || 0))) {\n          nativeWakePending = false;\n          nativeWakePendingFrameId = 0;\n          metrics.nativeUpdateWakeups += 1;\n          void pump('pending-signal');\n        } else {\n          nativeWakePending = false;\n          nativeWakePendingFrameId = 0;\n          // LILAC_R40_CALLBACK_WATCHDOG_ONLY: native callbacks/native producer own frame cadence;\n          // the timer exists only as a 250 ms recovery path when callbacks stop.\n          schedulePump(r40CallbackAuthoritative ? R30_PRODUCER_JS_WATCHDOG_MS : nextDelay);\n        }`;
once(oldFinally, newFinally, 'native producer callback-authority finally');

for (const marker of [
  'LILAC_R40_PRODUCER_CALLBACK_AUTHORITY',
  'const r40CallbackAuthoritative = frameProducerStarted || nativeUpdateCallbackInstalled',
  'schedulePump(r40CallbackAuthoritative ? R30_PRODUCER_JS_WATCHDOG_MS : nextDelay)'
]) {
  if (!source.includes(marker)) throw new Error(`R40 watchdog-authority marker missing: ${marker}`);
}
if (source.includes('schedulePump(nativeUpdateCallbackInstalled ? R30_PRODUCER_JS_WATCHDOG_MS : nextDelay)')) {
  throw new Error('stale JS-only callback watchdog condition survived');
}

fs.writeFileSync(target, source, 'utf8');
console.log('R40_CALLBACK_WATCHDOG_AUTHORITY_OK authority=native-producer-or-installed-callback jsTimer=250ms-recovery-only r3e-0ms-6ms-nextDelay=suppressed-while-producer-active');

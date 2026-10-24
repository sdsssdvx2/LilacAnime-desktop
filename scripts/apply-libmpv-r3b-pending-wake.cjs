'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

if (!source.includes('nativeUpdateCallbackInstalled') || !source.includes('wakePumpFromNative')) {
  throw new Error('R3B pending wake fix requires native update callback transform first');
}

replaceOnce(
  `  let nativeUpdateCallbackInstalled = false;\n  const MAX_PENDING_DELIVERY_FRAMES = 12;`,
  `  let nativeUpdateCallbackInstalled = false;\n  let nativeWakePending = false;\n  const MAX_PENDING_DELIVERY_FRAMES = 12;`,
  'pending native wake state'
);

replaceOnce(
  `    if (pumpRunning) return;\n    metrics.nativeUpdateWakeups += 1;\n    void pump();`,
  `    if (pumpRunning) {\n      nativeWakePending = true;\n      return;\n    }\n    nativeWakePending = false;\n    metrics.nativeUpdateWakeups += 1;\n    void pump();`,
  'retain callback during active pump'
);

replaceOnce(
  `    } finally {\n      pumpRunning = false;\n      if (active && !disposed) schedulePump(nextDelay);\n    }`,
  `    } finally {\n      pumpRunning = false;\n      if (active && !disposed) {\n        if (nativeUpdateCallbackInstalled && nativeWakePending) {\n          nativeWakePending = false;\n          metrics.nativeUpdateWakeups += 1;\n          void pump();\n        } else {\n          schedulePump(nextDelay);\n        }\n      }\n    }`,
  'drain pending wake before fallback timer'
);

replaceOnce(
  `    generation += 1;\n    lastNativeFramePerfAt = 0;`,
  `    generation += 1;\n    nativeWakePending = false;\n    lastNativeFramePerfAt = 0;`,
  'reset pending wake for new source'
);

for (const marker of [
  'let nativeWakePending = false',
  'nativeWakePending = true',
  'nativeUpdateCallbackInstalled && nativeWakePending',
  'nativeWakePending = false;\n          metrics.nativeUpdateWakeups += 1;\n          void pump()'
]) {
  if (!source.includes(marker)) throw new Error(`R3B pending-wake marker missing: ${marker}`);
}

fs.writeFileSync(target, source);
console.log('LIBMPV_R3B_PENDING_WAKE_OK callbackDuringPump=latched fallbackTimer=non-authoritative');

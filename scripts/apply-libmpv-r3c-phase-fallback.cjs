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

for (const marker of ['nativeUpdateCallbackInstalled', 'nativeWakePending', 'nextActivePumpDelay', 'advanceNativeFrameDeadline', 'pollPlayback']) {
  if (!source.includes(marker)) throw new Error(`R3C phase fallback requires marker: ${marker}`);
}

// The native render-update callback is an early wake hint, not the sole clock.
// Keep the absolute 23.976-style source-deadline timer armed in parallel so a
// coalesced or missed callback cannot turn into the old 250ms watchdog gap.
replaceOnce(
  '    let nextDelay = nativeUpdateCallbackInstalled ? 250 : 4;',
  '    let nextDelay = 4;',
  'default hybrid fallback delay'
);
replaceOnce(
  '        nextDelay = nativeUpdateCallbackInstalled ? 250 : nextActivePumpDelay();',
  '        nextDelay = nextActivePumpDelay();',
  'no-frame hybrid fallback delay'
);
replaceOnce(
  '      nextDelay = nativeUpdateCallbackInstalled ? 250 : nextActivePumpDelay(lastNativeFramePerfAt);',
  '      nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);',
  'frame hybrid fallback delay'
);

if (source.includes('nativeUpdateCallbackInstalled ? 250')) throw new Error('250ms callback watchdog survived');
for (const marker of ['nextDelay = nextActivePumpDelay();', 'nextDelay = nextActivePumpDelay(lastNativeFramePerfAt);', 'nativeUpdateCallbackInstalled && nativeWakePending']) {
  if (!source.includes(marker)) throw new Error(`hybrid callback+phase marker missing: ${marker}`);
}
if (source.includes('await sharedTexture.sendSharedTexture')) throw new Error('hybrid fallback regressed decoupled delivery');

fs.writeFileSync(target, source);
console.log('LIBMPV_R3C_PHASE_FALLBACK_OK callback=wake-hint timer=absolute-source-deadline watchdog250=removed');

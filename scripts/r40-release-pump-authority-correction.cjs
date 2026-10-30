'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

for (const marker of [
  'LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN',
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R40_FRESH_FRAME_WAKE_GATING',
  'LILAC_R40_PRODUCER_CALLBACK_AUTHORITY'
]) {
  if (!source.includes(marker)) throw new Error(`R40 release-pump correction requires marker: ${marker}`);
}
if (source.includes('LILAC_R40_RELEASE_CALLBACK_AUTHORITY')) {
  throw new Error('R40 release-pump authority correction already applied');
}

const start = source.indexOf('  function releaseNativeFrame(');
const end = source.indexOf('\n\n  function schedulePump(', start);
if (start < 0 || end <= start || source.indexOf('  function releaseNativeFrame(', start + 1) >= 0) {
  throw new Error('releaseNativeFrame boundary must be unique and precede schedulePump');
}

let block = source.slice(start, end);
const immediate = '    schedulePump(0);';
const count = block.split(immediate).length - 1;
if (count !== 1) throw new Error(`releaseNativeFrame expected exactly one immediate pump, found ${count}`);
if (!block.includes('pendingFrames.delete(key);')) throw new Error('releaseNativeFrame pending ownership release missing');
if (!block.includes('metrics.receiverReleases += 1;')) throw new Error('releaseNativeFrame receiver release accounting missing');
if (!block.includes('r34FocusHandoffPending')) throw new Error('releaseNativeFrame R34/R37 handoff bookkeeping missing');

const replacement = `    // LILAC_R40_RELEASE_CALLBACK_AUTHORITY: allReferencesReleased is ownership\n    // completion, not a frame-cadence source. In native-producer/callback mode the\n    // next ready frame arrives through the frame-id TSFN, while pump() keeps the\n    // existing 250 ms recovery watchdog armed. Preserve the legacy immediate pump\n    // only when neither callback authority is active.\n    if (!(frameProducerStarted || nativeUpdateCallbackInstalled)) {\n      schedulePump(0);\n    }`;
block = block.replace(immediate, replacement);
source = source.slice(0, start) + block + source.slice(end);

const finalBlock = source.slice(start, source.indexOf('\n\n  function schedulePump(', start));
if (!finalBlock.includes('LILAC_R40_RELEASE_CALLBACK_AUTHORITY')) throw new Error('release authority marker missing after patch');
if (!finalBlock.includes('if (!(frameProducerStarted || nativeUpdateCallbackInstalled))')) throw new Error('release authority condition missing after patch');
if ((finalBlock.split('schedulePump(0);').length - 1) !== 1) throw new Error('releaseNativeFrame schedulePump count drifted after patch');
for (const marker of ['r34FocusHandoffPending', 'r36FocusHandoffReleasedFrames', 'r34CompleteFocusHandoff']) {
  if (!finalBlock.includes(marker)) throw new Error(`R37 handoff release bookkeeping lost: ${marker}`);
}

fs.writeFileSync(target, source, 'utf8');
console.log('R40_RELEASE_PUMP_AUTHORITY_OK release=ownership-only producerCadence=frame-id-tsfn legacyImmediatePump=preserved callbackWatchdog=250ms r37AckBookkeeping=preserved');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const smokePath = path.join(root, 'scripts', 'r33-owned-popup-visible-focus-smoke.cjs');
let source = fs.readFileSync(smokePath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('LILAC_R34_HOSTED_VISUAL_PROOF')) throw new Error('R35 hosted startup hardening requires final R34 hosted visual proof');
if (!source.includes('LILAC_R34_HOSTED_REFOCUS_HARDENING')) throw new Error('R35 hosted startup hardening requires final R34 refocus hardening');
if (source.includes('LILAC_R35_HOSTED_NATIVE_STARTUP_HARDENING')) throw new Error('R35 hosted startup hardening already applied');

const oldBlock = `    await waitUntil(() => {
      const s = addon.nativePresenterStats(id);
      return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;
    }, 6000, 'owned popup visible/presenting');`;

const newBlock = `    // LILAC_R35_HOSTED_NATIVE_STARTUP_HARDENING
    // A GitHub hosted GPU occasionally needs several seconds to create the first
    // swapchain/present after the VM has just rebuilt the native addon. Preserve
    // the exact same proof (visible HWND + >=4 native presents); only widen the
    // startup observation window. On failure, print enough native/player state to
    // distinguish a renderer/fixture problem from presenter startup latency.
    try {
      await waitUntil(() => {
        const s = addon.nativePresenterStats(id);
        return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;
      }, 15000, 'owned popup visible/presenting');
    } catch (error) {
      let presenter = null, playback = null;
      try { presenter = addon.nativePresenterStats(id); } catch {}
      try { playback = addon.pollPlayback(id); } catch {}
      throw new Error('owned popup visible/presenting hosted startup timeout presenter=' + JSON.stringify(presenter) + ' playback=' + JSON.stringify(playback) + ' cause=' + String(error?.message || error));
    }`;

const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error('R35 hosted startup wait anchor expected once, found ' + count);
source = source.replace(oldBlock, newBlock);

// The widened 15s observation window must not outlive the synthetic media.
// The old 12s fixture can naturally hit EOF/auto-pause before a slow hosted GPU
// creates its first owned-popup swapchain, producing a false presenter failure.
// Extend only the smoke fixture; product playback/runtime code is untouched.
const fixtureDurationCount = source.split('duration=12').length - 1;
if (fixtureDurationCount !== 2) throw new Error('R35 hosted fixture duration anchors expected twice, found ' + fixtureDurationCount);
source = source.replaceAll('duration=12', 'duration=30');

// The focused baseline has no Chromium receiver in this native DWM smoke. Starting
// the 24-slot producer while the popup is intentionally hidden can therefore fill
// every slot before the hosted desktop capture finishes. Once all 24 frames are
// in-flight, blur cannot produce the first native-only frame and the test reports
// a false startup timeout (renderedFrames=24, nativeOnlyFrames=0, presentSOk=0).
// Start the producer only after the real BrowserWindow blur has activated the R33
// native-owned popup. Product code is untouched; the test still proves the same
// native-only DWM output, 900ms main-thread autonomy and focus recovery.
// R34's prebaseline watchdog may already have wrapped the producer line with stage
// markers. Move those markers together with the producer so diagnostics remain true.
const plainEarlyProducer = `    addon.open(id, media);
    await waitUntil(() => addon.pollPlayback(id)?.fileLoaded === true, 10000, 'fixture load');
    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');
    addon.setNativePresenterVisible(id, false);`;
const stagedEarlyProducer = `    addon.open(id, media);
    await waitUntil(() => addon.pollPlayback(id)?.fileLoaded === true, 10000, 'fixture load');
    console.log('R34_PRE_R33_STAGE=before-producer-start');
    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');
    console.log('R34_PRE_R33_STAGE=producer-started');
    addon.setNativePresenterVisible(id, false);`;
const plainCount = source.split(plainEarlyProducer).length - 1;
const stagedCount = source.split(stagedEarlyProducer).length - 1;
if (plainCount + stagedCount !== 1) {
  throw new Error('R35 hosted producer-start anchor expected one plain/staged form, found plain=' + plainCount + ' staged=' + stagedCount);
}
const deferredProducer = `    addon.open(id, media);
    await waitUntil(() => addon.pollPlayback(id)?.fileLoaded === true, 10000, 'fixture load');
    // LILAC_R35_HOSTED_NATIVE_STARTUP_NO_QUEUE_SATURATION
    addon.setNativePresenterVisible(id, false);`;
const hadR34ProducerStages = stagedCount === 1;
source = source.replace(hadR34ProducerStages ? stagedEarlyProducer : plainEarlyProducer, deferredProducer);

const blurAnchor = `    await waitUntil(() => !main.isFocused() && rival.isFocused(), 3000, 'real BrowserWindow blur');`;
const movedProducer = hadR34ProducerStages
  ? `    console.log('R34_PRE_R33_STAGE=before-producer-start');\n    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');\n    console.log('R34_PRE_R33_STAGE=producer-started');`
  : `    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');`;
const blurWithProducer = `${blurAnchor}\n${movedProducer}`;
const blurAnchorCount = source.split(blurAnchor).length - 1;
if (blurAnchorCount !== 1) throw new Error('R35 hosted blur anchor expected once, found ' + blurAnchorCount);
source = source.replace(blurAnchor, blurWithProducer);

// Do not weaken any of the downstream qualification gates.
for (const required of [
  'presentSOkFrames',
  'presentOccludedFrames',
  'presentOtherStatusFrames',
  'blockMain(900)',
  'autonomousPresented=',
  'focusRecovery=hidden',
  'R33_VISIBLE_FOCUS_SMOKE_OK',
  'LILAC_R35_HOSTED_NATIVE_STARTUP_NO_QUEUE_SATURATION'
]) {
  if (!source.includes(required)) throw new Error('R35 hosted startup hardening lost proof gate: ' + required);
}
if (!source.includes("15000, 'owned popup visible/presenting'")) throw new Error('R35 hosted startup timeout was not widened');
if (source.includes("6000, 'owned popup visible/presenting'")) throw new Error('R35 old hosted startup timeout survived');
if (source.includes('duration=12') || source.split('duration=30').length - 1 !== 2) throw new Error('R35 hosted fixture lifetime hardening failed');
const startFrameCount = source.split("addon.startFrameProducer(id, 640, 360)").length - 1;
if (startFrameCount !== 1 || source.indexOf("addon.startFrameProducer(id, 640, 360)") < source.indexOf("'real BrowserWindow blur'")) {
  throw new Error('R35 hosted producer must start exactly once after real blur');
}
if (hadR34ProducerStages) {
  const beforeStage = source.indexOf('R34_PRE_R33_STAGE=before-producer-start');
  const afterStage = source.indexOf('R34_PRE_R33_STAGE=producer-started');
  const blurAt = source.indexOf("'real BrowserWindow blur'");
  const startAt = source.indexOf('addon.startFrameProducer(id, 640, 360)');
  if (!(blurAt < beforeStage && beforeStage < startAt && startAt < afterStage)) {
    throw new Error('R35 hosted R34 producer stage markers no longer bracket deferred producer start');
  }
}

fs.writeFileSync(smokePath, source, 'utf8');
console.log('R35_HOSTED_NATIVE_STARTUP_HARDENING_OK timeoutMs=15000 fixtureSeconds=30 producerStart=after-blur noFocusedQueueSaturation=1 r34StageMarkers=' + (hadR34ProducerStages ? 'moved' : 'absent') + ' proof=unchanged exactSOk=required nonSOk=zero mainStallMs=900 timeoutTelemetry=presenter+playback');

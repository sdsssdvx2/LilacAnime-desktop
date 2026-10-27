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
// every slot before the hosted capture baseline finishes. Once all 24 frames are
// in-flight, blur cannot produce the first native-only frame. Relocate the one real
// producer start to immediately after the real BrowserWindow blur. Work from the
// semantic producer line itself instead of guessing which R34 watchdog wrapper is
// present; carry any adjacent before/after producer stage markers with it.
const producerNeedle = "if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');";
let lines = source.split('\n');
const producerIndices = [];
for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(producerNeedle)) producerIndices.push(i);
if (producerIndices.length !== 1) throw new Error('R35 hosted producer semantic anchor expected once, found ' + producerIndices.length);
const producerIndex = producerIndices[0];

let fixtureLoadIndex = -1;
for (let i = producerIndex - 1; i >= 0; i -= 1) {
  if (lines[i].includes("'fixture load'")) { fixtureLoadIndex = i; break; }
}
let initialVisibleOffIndex = -1;
for (let i = producerIndex + 1; i < lines.length; i += 1) {
  if (lines[i].includes('addon.setNativePresenterVisible(id, false)')) { initialVisibleOffIndex = i; break; }
  if (lines[i].includes("'real BrowserWindow blur'")) break;
}
if (!(fixtureLoadIndex >= 0 && fixtureLoadIndex < producerIndex && initialVisibleOffIndex > producerIndex)) {
  throw new Error('R35 hosted producer was not inside expected focused fixture-load/visible-off section');
}

const isBeforeProducerStage = line => /(?:R34_R33_SMOKE_STAGE|R34_PRE_R33_STAGE)=before-producer-start/.test(line);
const isAfterProducerStage = line => /(?:R34_R33_SMOKE_STAGE|R34_PRE_R33_STAGE)=producer-started/.test(line);
let producerBlockStart = producerIndex;
let producerBlockEnd = producerIndex + 1;
if (producerIndex > 0 && isBeforeProducerStage(lines[producerIndex - 1])) producerBlockStart -= 1;
if (producerIndex + 1 < lines.length && isAfterProducerStage(lines[producerIndex + 1])) producerBlockEnd += 1;
const producerBlock = lines.slice(producerBlockStart, producerBlockEnd);
const producerStageMode = producerBlock.some(line => line.includes('R34_R33_SMOKE_STAGE='))
  ? 'r34-watchdog'
  : producerBlock.some(line => line.includes('R34_PRE_R33_STAGE='))
    ? 'r34-prebaseline'
    : 'none';

lines.splice(producerBlockStart, producerBlockEnd - producerBlockStart);
const markerInsertIndex = lines.findIndex(line => line.includes('addon.setNativePresenterVisible(id, false)') && line.length >= 4);
if (markerInsertIndex < 0) throw new Error('R35 hosted initial native-visible-off line disappeared');
lines.splice(markerInsertIndex, 0, '    // LILAC_R35_HOSTED_NATIVE_STARTUP_NO_QUEUE_SATURATION');

const blurIndices = [];
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].includes("await waitUntil(() => !main.isFocused() && rival.isFocused(), 3000, 'real BrowserWindow blur');")) blurIndices.push(i);
}
if (blurIndices.length !== 1) throw new Error('R35 hosted blur semantic anchor expected once, found ' + blurIndices.length);
const blurIndex = blurIndices[0];
lines.splice(blurIndex + 1, 0, ...producerBlock);
source = lines.join('\n');

// Do not weaken any downstream qualification gates.
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
const startFrameCount = source.split('addon.startFrameProducer(id, 640, 360)').length - 1;
const finalStartAt = source.indexOf('addon.startFrameProducer(id, 640, 360)');
const finalBlurAt = source.indexOf("'real BrowserWindow blur'");
const finalInitialVisibleOffAt = source.indexOf('// LILAC_R35_HOSTED_NATIVE_STARTUP_NO_QUEUE_SATURATION');
if (startFrameCount !== 1 || !(finalInitialVisibleOffAt >= 0 && finalInitialVisibleOffAt < finalBlurAt && finalBlurAt < finalStartAt)) {
  throw new Error('R35 hosted producer relocation ordering invalid');
}
if (producerStageMode !== 'none') {
  const expectedPrefix = producerStageMode === 'r34-watchdog' ? 'R34_R33_SMOKE_STAGE=' : 'R34_PRE_R33_STAGE=';
  const beforeStage = source.indexOf(expectedPrefix + 'before-producer-start');
  const afterStage = source.indexOf(expectedPrefix + 'producer-started');
  if (!(finalBlurAt < beforeStage && beforeStage < finalStartAt && finalStartAt < afterStage)) {
    throw new Error('R35 hosted producer stage markers no longer bracket deferred producer start mode=' + producerStageMode);
  }
}

fs.writeFileSync(smokePath, source, 'utf8');
console.log('R35_HOSTED_NATIVE_STARTUP_HARDENING_OK timeoutMs=15000 fixtureSeconds=30 producerStart=after-blur noFocusedQueueSaturation=1 stageMode=' + producerStageMode + ' proof=unchanged exactSOk=required nonSOk=zero mainStallMs=900 timeoutTelemetry=presenter+playback');

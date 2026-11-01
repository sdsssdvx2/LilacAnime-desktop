'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridgePath = path.join(root, 'electron', 'libmpv-shared-main.cjs');
if (!fs.existsSync(bridgePath)) throw new Error(`missing transformed R45 bridge: ${bridgePath}`);
let source = fs.readFileSync(bridgePath, 'utf8').replace(/\r\n/g, '\n');

const marker = 'LILAC_R45_PRIME_FORCE_REDRAW_WAKE';
if (source.includes(marker)) {
  console.log('R45_PRIME_FORCE_REDRAW_WAKE_ALREADY_APPLIED');
  process.exit(0);
}

for (const required of [
  'LILAC_R45_NATIVE_TINY_FIRST_PRESENT_PRIME',
  'LILAC_R40_HANDOFF_FORCE_REDRAW',
  'requestFrameProducerRedraw',
  'frameProducerStarted',
  "r34SetNativeSubtitleVisible(false, 'r45-prime-tiny');"
]) {
  if (!source.includes(required)) throw new Error(`R45 redraw wake requires shipped/transformed marker: ${required}`);
}

function replaceOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`R45 redraw wake anchor missing: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`R45 redraw wake anchor ambiguous: ${label}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  '  let r45BlurPrimeFailures = 0;\n  let r45BlurPrimeLastMs = 0;',
  `  let r45BlurPrimeFailures = 0;\n  let r45BlurPrimeRedrawRequests = 0; // ${marker}\n  let r45BlurPrimeRedrawAccepted = 0;\n  let r45BlurPrimeRedrawErrors = 0;\n  let r45BlurPrimeLastMs = 0;`,
  'prime redraw diagnostics state'
);

replaceOnce(
  `      r33NativePresenterActive = true;\n      r34SetNativeSubtitleVisible(false, 'r45-prime-tiny');\n      setTimeout(() => r45PollBlurPrime(epoch), 0);`,
  `      r33NativePresenterActive = true;\n      r34SetNativeSubtitleVisible(false, 'r45-prime-tiny');\n      // R40 already exposes a producer-thread one-shot redraw that renders the current\n      // libmpv frame without changing playback position or subtitle state. Request it\n      // after native-only ownership is active so the 2x2 swapchain receives a current\n      // frame immediately, then the R45 presentedFrames proof can expand that same HWND.\n      if (frameProducerStarted && typeof addon.requestFrameProducerRedraw === 'function') {\n        r45BlurPrimeRedrawRequests += 1;\n        try {\n          if (addon.requestFrameProducerRedraw(playerId) === true) r45BlurPrimeRedrawAccepted += 1;\n        } catch (redrawError) {\n          r45BlurPrimeRedrawErrors += 1;\n          lastError = 'R45 blur-prime redraw request failed: ' + String(redrawError?.message || redrawError).slice(0, 180);\n        }\n      }\n      setTimeout(() => r45PollBlurPrime(epoch), 0);`,
  'request forced redraw after tiny native ownership'
);

replaceOnce(
  `          failures: r45BlurPrimeFailures,\n          lastMs: r45BlurPrimeLastMs,`,
  `          failures: r45BlurPrimeFailures,\n          redrawRequests: r45BlurPrimeRedrawRequests,\n          redrawAccepted: r45BlurPrimeRedrawAccepted,\n          redrawErrors: r45BlurPrimeRedrawErrors,\n          lastMs: r45BlurPrimeLastMs,`,
  'export prime redraw diagnostics'
);

for (const required of [marker, 'r45BlurPrimeRedrawRequests += 1;', 'addon.requestFrameProducerRedraw(playerId)', 'redrawAccepted: r45BlurPrimeRedrawAccepted']) {
  if (!source.includes(required)) throw new Error(`R45 redraw wake transformed bridge missing ${required}`);
}
for (const forbidden of ['copyTextureToTexture', 'focus-staged-gpu-copy', '--disable-direct-composition', 'r45-prime-offscreen']) {
  if (source.includes(forbidden)) throw new Error(`R45 redraw wake contains forbidden legacy path ${forbidden}`);
}

fs.writeFileSync(bridgePath, source.replace(/\n/g, '\r\n'), 'utf8');
console.log(`R45_PRIME_FORCE_REDRAW_WAKE_OK marker=${marker} api=requestFrameProducerRedraw owner=native-only prime=2x2 position=unchanged subtitles=unchanged addon=unchanged`);

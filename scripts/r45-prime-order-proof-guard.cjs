'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridgePath = path.join(root, 'electron', 'libmpv-shared-main.cjs');
if (!fs.existsSync(bridgePath)) throw new Error(`missing transformed R45 bridge: ${bridgePath}`);
let source = fs.readFileSync(bridgePath, 'utf8').replace(/\r\n/g, '\n');

const marker = 'LILAC_R45_FIRST_PRESENT_TINY_PROOF';
if (source.includes(marker)) {
  console.log('R45_FIRST_PRESENT_TINY_PROOF_ALREADY_APPLIED');
  process.exit(0);
}
for (const required of [
  'LILAC_R45_NATIVE_TINY_FIRST_PRESENT_PRIME',
  'LILAC_R45_PRIME_FORCE_REDRAW_WAKE',
  'r45BlurPrimePending',
  'r45ApplyTinyPrimeBounds()',
  'r45PollBlurPrime(epoch)',
  'r32SyncNativePresenterBounds'
]) {
  if (!source.includes(required)) throw new Error(`R45 tiny-proof prerequisite missing ${required}`);
}

function replaceOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`R45 tiny-proof anchor missing: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`R45 tiny-proof anchor ambiguous: ${label}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

// Guard every ordinary geometry resync while priming. The popup may remain visible,
// but it must stay at exactly the stored 2x2 corner until a real Present is proven.
const syncStart = source.indexOf('  function r32SyncNativePresenterBounds(');
if (syncStart < 0) throw new Error('R45 tiny-proof could not locate r32SyncNativePresenterBounds');
const openBrace = source.indexOf('{', syncStart);
if (openBrace < 0) throw new Error('R45 tiny-proof sync helper brace missing');
let depth = 0;
let syncEnd = -1;
for (let i = openBrace; i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') {
    depth -= 1;
    if (depth === 0) { syncEnd = i + 1; break; }
  }
}
if (syncEnd < 0) throw new Error('R45 tiny-proof sync helper end missing');
const syncBlock = source.slice(syncStart, syncEnd);
if (!syncBlock.includes('setNativePresenterBounds')) throw new Error('R45 tiny-proof sync helper semantic mismatch');
const renamedSync = syncBlock.replace('function r32SyncNativePresenterBounds(', 'function r45BaseSyncNativePresenterBounds(');
if (renamedSync === syncBlock) throw new Error('R45 tiny-proof sync helper rename failed');
const wrapper = `${renamedSync}\n\n  function r32SyncNativePresenterBounds(...args) {\n    if (r45BlurPrimePending) return r45ApplyTinyPrimeBounds();\n    return r45BaseSyncNativePresenterBounds(...args);\n  }`;
source = source.slice(0, syncStart) + wrapper + source.slice(syncEnd);

replaceOnce(
  '  let r45BlurPrimeRedrawErrors = 0;\n  let r45BlurPrimeLastMs = 0;',
  `  let r45BlurPrimeRedrawErrors = 0;\n  let r45BlurPrimeFirstPresentTinyProofs = 0; // ${marker}\n  let r45BlurPrimePrePresentFullExposureViolations = 0;\n  let r45BlurPrimeLastProofPresented = 0;\n  let r45BlurPrimeLastProofX = 0;\n  let r45BlurPrimeLastProofY = 0;\n  let r45BlurPrimeLastProofWidth = 0;\n  let r45BlurPrimeLastProofHeight = 0;\n  let r45BlurPrimeLastProofWallMs = 0;\n  let r45BlurPrimeLastExposeWallMs = 0;\n  let r45BlurPrimeLastMs = 0;`,
  'tiny-proof diagnostics state'
);

replaceOnce(
  `    const presented = r45ReadNativePresentedFrames();\n    if (presented != null && presented > r45BlurPrimeBaselinePresented) {\n      r45CommitBlurPrime(epoch, 'presented');\n      return;\n    }`,
  `    let presented = null;\n    let proofX = null;\n    let proofY = null;\n    let proofWidth = null;\n    let proofHeight = null;\n    let proofVisible = false;\n    try {\n      const proofStats = addon?.nativePresenterStats?.(playerId);\n      const proofPresented = Number(proofStats?.presentedFrames);\n      if (Number.isFinite(proofPresented)) presented = proofPresented;\n      const x = Number(proofStats?.x);\n      const y = Number(proofStats?.y);\n      const width = Number(proofStats?.screenWidth);\n      const height = Number(proofStats?.screenHeight);\n      if (Number.isFinite(x)) proofX = x;\n      if (Number.isFinite(y)) proofY = y;\n      if (Number.isFinite(width)) proofWidth = width;\n      if (Number.isFinite(height)) proofHeight = height;\n      proofVisible = proofStats?.windowVisible === true;\n    } catch {}\n    const tinyGeometry = proofX === r45BlurPrimeX && proofY === r45BlurPrimeY &&\n      proofWidth != null && proofHeight != null &&\n      proofWidth <= R45_BLUR_PRIME_SIZE && proofHeight <= R45_BLUR_PRIME_SIZE;\n    if (proofVisible && !tinyGeometry) {\n      r45BlurPrimePrePresentFullExposureViolations += 1;\n      r45BlurPrimeFailures += 1;\n      r45CancelBlurPrime('pre-present-not-tiny', true);\n      return;\n    }\n    if (presented != null && presented > r45BlurPrimeBaselinePresented) {\n      r45BlurPrimeLastProofPresented = presented;\n      r45BlurPrimeLastProofX = proofX ?? 0;\n      r45BlurPrimeLastProofY = proofY ?? 0;\n      r45BlurPrimeLastProofWidth = proofWidth ?? 0;\n      r45BlurPrimeLastProofHeight = proofHeight ?? 0;\n      r45BlurPrimeLastProofWallMs = Date.now();\n      if (!tinyGeometry) {\n        r45BlurPrimePrePresentFullExposureViolations += 1;\n        r45BlurPrimeFailures += 1;\n        r45CancelBlurPrime('first-present-not-tiny', true);\n        return;\n      }\n      r45BlurPrimeFirstPresentTinyProofs += 1;\n      r45CommitBlurPrime(epoch, 'presented');\n      return;\n    }`,
  'prove first Present happened on tiny surface'
);

replaceOnce(
  `    if (!r45RestoreNativePresenterBounds()) r45BlurPrimeFailures += 1;\n    r34SetNativeSubtitleVisible(r33NativePresenterActive, 'r45-prime-' + outcome);`,
  `    if (!r45RestoreNativePresenterBounds()) r45BlurPrimeFailures += 1;\n    r45BlurPrimeLastExposeWallMs = Date.now();\n    r34SetNativeSubtitleVisible(r33NativePresenterActive, 'r45-prime-' + outcome);`,
  'record full exposure time after bounds restore'
);

replaceOnce(
  `          redrawErrors: r45BlurPrimeRedrawErrors,\n          lastMs: r45BlurPrimeLastMs,`,
  `          redrawErrors: r45BlurPrimeRedrawErrors,\n          firstPresentTinyProofs: r45BlurPrimeFirstPresentTinyProofs,\n          prePresentFullExposureViolations: r45BlurPrimePrePresentFullExposureViolations,\n          lastProofPresented: r45BlurPrimeLastProofPresented,\n          lastProofX: r45BlurPrimeLastProofX,\n          lastProofY: r45BlurPrimeLastProofY,\n          lastProofWidth: r45BlurPrimeLastProofWidth,\n          lastProofHeight: r45BlurPrimeLastProofHeight,\n          lastProofWallMs: r45BlurPrimeLastProofWallMs,\n          lastExposeWallMs: r45BlurPrimeLastExposeWallMs,\n          lastMs: r45BlurPrimeLastMs,`,
  'export tiny-proof diagnostics'
);

for (const required of [
  marker,
  'function r45BaseSyncNativePresenterBounds(',
  'function r32SyncNativePresenterBounds(...args)',
  'r45BlurPrimeFirstPresentTinyProofs += 1;',
  "r45CancelBlurPrime('first-present-not-tiny', true)",
  'prePresentFullExposureViolations: r45BlurPrimePrePresentFullExposureViolations'
]) {
  if (!source.includes(required)) throw new Error(`R45 tiny-proof transformed bridge missing ${required}`);
}
for (const forbidden of ['copyTextureToTexture', 'focus-staged-gpu-copy', '--disable-direct-composition', '-32000', 'FIRST_PRESENT_OFFSCREEN']) {
  if (source.includes(forbidden)) throw new Error(`R45 tiny-proof contains forbidden path ${forbidden}`);
}

fs.writeFileSync(bridgePath, source.replace(/\n/g, '\r\n'), 'utf8');
console.log(`R45_FIRST_PRESENT_TINY_PROOF_OK marker=${marker} geometryGuard=pending-2x2 proof=presentedFrames+x/y+GetWindowRect violationAction=hide-and-cancel`);

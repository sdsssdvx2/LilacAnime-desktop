'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridgePath = path.join(root, 'electron', 'libmpv-shared-main.cjs');
if (!fs.existsSync(bridgePath)) throw new Error(`missing reconstructed R44 bridge: ${bridgePath}`);
let source = fs.readFileSync(bridgePath, 'utf8').replace(/\r\n/g, '\n');

const marker = 'LILAC_R45_NATIVE_OFFSCREEN_FIRST_PRESENT_PRIME';
if (source.includes(marker)) {
  console.log('R45_NATIVE_OFFSCREEN_FIRST_PRESENT_PRIME_ALREADY_APPLIED');
  process.exit(0);
}

function replaceOnce(text, before, after, label) {
  const index = text.indexOf(before);
  if (index < 0) throw new Error(`R45 transform anchor missing: ${label}`);
  if (text.indexOf(before, index + before.length) >= 0) throw new Error(`R45 transform anchor ambiguous: ${label}`);
  return text.slice(0, index) + after + text.slice(index + before.length);
}

source = replaceOnce(
  source,
  '  let r33FocusTransitions = 0;',
  `  let r33FocusTransitions = 0;\n  // ${marker}\n  // On blur the owned native popup used to become visible before its swapchain had\n  // presented a current video frame. Prime it offscreen, then expose it only after\n  // nativePresenterStats().presentedFrames advances. This preserves the R41 focused\n  // visual-commit handoff while preventing the native popup's initial black buffer\n  // from becoming a user-visible transition frame.\n  let r45BlurPrimeEpoch = 0;\n  let r45BlurPrimePending = false;\n  let r45BlurPrimeStartedAt = 0;\n  let r45BlurPrimeBaselinePresented = 0;\n  let r45BlurPrimeSuccesses = 0;\n  let r45BlurPrimeTimeouts = 0;\n  let r45BlurPrimeCancels = 0;\n  let r45BlurPrimeFailures = 0;\n  let r45BlurPrimeLastMs = 0;\n  let r45BlurPrimeMaxMs = 0;\n  const R45_BLUR_PRIME_TIMEOUT_MS = 500;\n  const R45_BLUR_PRIME_POLL_MS = 4;`,
  'R33 focus transition state'
);

const helperStart = source.indexOf('  function r32ApplyNativePresenterFocus(focused) {');
if (helperStart < 0) throw new Error('R45 shipped R44 focus helper start missing');
let depth = 0;
let helperEnd = -1;
let seenBrace = false;
for (let i = helperStart; i < source.length; i += 1) {
  const ch = source[i];
  if (ch === '{') { depth += 1; seenBrace = true; }
  else if (ch === '}') {
    depth -= 1;
    if (seenBrace && depth === 0) { helperEnd = i + 1; break; }
  }
}
if (helperEnd < 0) throw new Error('R45 shipped R44 focus helper end missing');
const oldHelper = source.slice(helperStart, helperEnd);
for (const required of [
  "r39ReanchorPumpPhase(focused ? 'focus' : 'blur');",
  'r33ConfigureOwnedPresenter();',
  'r32SyncNativePresenterBounds();',
  'addon.setNativePresenterVisible(playerId, useNative)',
  "r34BeginFocusHandoff();"
]) {
  if (!oldHelper.includes(required)) throw new Error(`R45 R44 focus helper semantic anchor missing: ${required}`);
}

const newHelper = `  function r45ReadNativePresentedFrames() {\n    if (!addon || playerId == null || typeof addon.nativePresenterStats !== 'function') return null;\n    try {\n      const stats = addon.nativePresenterStats(playerId);\n      const value = Number(stats?.presentedFrames);\n      return Number.isFinite(value) ? value : null;\n    } catch {\n      return null;\n    }\n  }\n\n  function r45RestoreNativePresenterBounds() {\n    try { return r32SyncNativePresenterBounds() === true; } catch { return false; }\n  }\n\n  function r45CancelBlurPrime(reason, hideNative = true) {\n    const wasPending = r45BlurPrimePending;\n    r45BlurPrimeEpoch += 1;\n    r45BlurPrimePending = false;\n    if (wasPending) r45BlurPrimeCancels += 1;\n    if (hideNative) {\n      try { addon.setNativePresenterVisible(playerId, false); } catch {}\n      r33NativePresenterActive = false;\n      r34SetNativeSubtitleVisible(false, 'r45-prime-cancel-' + String(reason || 'unknown'));\n    }\n    r45RestoreNativePresenterBounds();\n  }\n\n  function r45CommitBlurPrime(epoch, outcome) {\n    if (!r45BlurPrimePending || epoch !== r45BlurPrimeEpoch) return false;\n    r45BlurPrimePending = false;\n    const elapsed = Math.max(0, Date.now() - r45BlurPrimeStartedAt);\n    r45BlurPrimeLastMs = elapsed;\n    r45BlurPrimeMaxMs = Math.max(r45BlurPrimeMaxMs, elapsed);\n    if (outcome === 'presented') r45BlurPrimeSuccesses += 1;\n    else if (outcome === 'timeout') r45BlurPrimeTimeouts += 1;\n    else r45BlurPrimeFailures += 1;\n    // The popup is already visible, but remains far outside the virtual desktop until\n    // a video Present has populated its backbuffer. Moving the same HWND to the real\n    // target does not create a new show/hide compositor animation.\n    if (!r45RestoreNativePresenterBounds()) r45BlurPrimeFailures += 1;\n    r34SetNativeSubtitleVisible(r33NativePresenterActive, 'r45-prime-' + outcome);\n    return true;\n  }\n\n  function r45PollBlurPrime(epoch) {\n    if (!r45BlurPrimePending || epoch !== r45BlurPrimeEpoch) return;\n    const presented = r45ReadNativePresentedFrames();\n    if (presented != null && presented > r45BlurPrimeBaselinePresented) {\n      r45CommitBlurPrime(epoch, 'presented');\n      return;\n    }\n    if (Date.now() - r45BlurPrimeStartedAt >= R45_BLUR_PRIME_TIMEOUT_MS) {\n      // Fail open rather than leave video invisible indefinitely on an unexpected\n      // driver/addon stall. Diagnostics make this path explicit.\n      r45CommitBlurPrime(epoch, 'timeout');\n      return;\n    }\n    setTimeout(() => r45PollBlurPrime(epoch), R45_BLUR_PRIME_POLL_MS);\n  }\n\n  function r45BeginBlurPrime() {\n    const baseline = r45ReadNativePresentedFrames();\n    if (baseline == null || typeof addon.setNativePresenterBounds !== 'function') {\n      r45BlurPrimeFailures += 1;\n      return false;\n    }\n    r45BlurPrimeEpoch += 1;\n    const epoch = r45BlurPrimeEpoch;\n    r45BlurPrimePending = true;\n    r45BlurPrimeStartedAt = Date.now();\n    r45BlurPrimeBaselinePresented = baseline;\n    const offscreenX = Math.max(-32000, -32000 + Math.min(0, -Math.max(1, targetWidth)));\n    const offscreenY = Math.max(-32000, -32000 + Math.min(0, -Math.max(1, targetHeight)));\n    try {\n      const moved = addon.setNativePresenterBounds(playerId, offscreenX, offscreenY, targetWidth, targetHeight);\n      const accepted = addon.setNativePresenterVisible(playerId, true);\n      if (moved !== true || accepted !== true) {\n        r45BlurPrimePending = false;\n        r45BlurPrimeFailures += 1;\n        r45RestoreNativePresenterBounds();\n        return false;\n      }\n      r33NativePresenterActive = true;\n      // Keep native subtitles suppressed while the video HWND is offscreen. R40/R44's\n      // single-DOM overlay owns user-visible unfocused subtitles.\n      r34SetNativeSubtitleVisible(false, 'r45-prime-offscreen');\n      setTimeout(() => r45PollBlurPrime(epoch), 0);\n      return true;\n    } catch {\n      r45BlurPrimePending = false;\n      r45BlurPrimeFailures += 1;\n      r45RestoreNativePresenterBounds();\n      return false;\n    }\n  }\n\n  function r32ApplyNativePresenterFocus(focused) {\n    if (!addon || playerId == null) return;\n    r33FocusTransitions += 1;\n    r39ReanchorPumpPhase(focused ? 'focus' : 'blur');\n    r33ConfigureOwnedPresenter();\n\n    if (Boolean(focused)) {\n      // A popup that is still being primed has never been exposed over Chromium, so\n      // there is nothing to hand off. Cancel it synchronously and restore bounds.\n      if (r45BlurPrimePending) {\n        r45CancelBlurPrime('refocus', true);\n        r27LastDispatchWallMs = 0;\n        return;\n      }\n      r32SyncNativePresenterBounds();\n      if (r33NativePresenterActive && active && r32TargetVisible) {\n        r34BeginFocusHandoff();\n        // Preserve R41 exactly: while playback is moving, only the renderer's explicit\n        // fresh-frame visual commit may retire the native plane.\n        return;\n      }\n      r34CancelFocusHandoff('focus-without-native');\n      try { addon.setNativePresenterVisible(playerId, false); } catch {}\n      r33NativePresenterActive = false;\n      r34SetNativeSubtitleVisible(false, 'focus-clean');\n      r27LastDispatchWallMs = 0;\n      return;\n    }\n\n    r34CancelFocusHandoff('blur');\n    r27LastDispatchWallMs = 0;\n    const useNative = active && r32TargetVisible;\n    if (!useNative) {\n      r45CancelBlurPrime('blur-inactive', true);\n      return;\n    }\n\n    // Do not put the native HWND at its user-visible target until its swapchain has\n    // actually presented a current video frame. If priming cannot be established,\n    // preserve the old fail-open behavior rather than risking a persistent blank.\n    if (r45BeginBlurPrime()) return;\n    let nativeReady = false;\n    try {\n      r32SyncNativePresenterBounds();\n      const accepted = addon.setNativePresenterVisible(playerId, true);\n      nativeReady = accepted === true;\n      r33NativePresenterActive = nativeReady;\n      r34SetNativeSubtitleVisible(nativeReady, 'r45-prime-fail-open');\n    } catch (error) {\n      lastError = 'R45 native presenter blur prime failed: ' + String(error?.message || error).slice(0, 180);\n      r33NativePresenterActive = false;\n      r34SetNativeSubtitleVisible(false, 'r45-prime-error');\n    }\n  }`;

source = source.slice(0, helperStart) + newHelper + source.slice(helperEnd);

source = replaceOnce(
  source,
  '        focusTransitions: r33FocusTransitions,',
  `        focusTransitions: r33FocusTransitions,\n        r45BlurPrime: {\n          marker: '${marker}',\n          pending: r45BlurPrimePending,\n          epoch: r45BlurPrimeEpoch,\n          baselinePresented: r45BlurPrimeBaselinePresented,\n          successes: r45BlurPrimeSuccesses,\n          timeouts: r45BlurPrimeTimeouts,\n          cancels: r45BlurPrimeCancels,\n          failures: r45BlurPrimeFailures,\n          lastMs: r45BlurPrimeLastMs,\n          maxMs: r45BlurPrimeMaxMs,\n          timeoutMs: R45_BLUR_PRIME_TIMEOUT_MS,\n          pollMs: R45_BLUR_PRIME_POLL_MS\n        },`,
  'R33 diagnostics focusTransitions'
);

for (const required of [marker, 'r45BeginBlurPrime()', "r45CommitBlurPrime(epoch, 'presented')", "r34BeginFocusHandoff();"]) {
  if (!source.includes(required)) throw new Error(`R45 transformed bridge missing ${required}`);
}
for (const forbidden of ['copyTextureToTexture', 'focus-staged-gpu-copy', '--disable-direct-composition']) {
  if (source.includes(forbidden)) throw new Error(`R45 transformed bridge contains forbidden legacy path ${forbidden}`);
}

fs.writeFileSync(bridgePath, source.replace(/\n/g, '\r\n'), 'utf8');
console.log(`R45_NATIVE_OFFSCREEN_FIRST_PRESENT_PRIME_OK marker=${marker} timeoutMs=500 pollMs=4 focusHandoff=R41-preserved nativeAddon=unchanged`);

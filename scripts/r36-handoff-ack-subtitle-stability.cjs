'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(label + ': expected exactly one anchor, found ' + count);
  return source.replace(needle, replacement);
}
function replaceInside(source, startNeedle, endNeedle, needle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(label + ': function boundary missing');
  const block = source.slice(start, end);
  const patched = replaceOnce(block, needle, replacement, label);
  return source.slice(0, start) + patched + source.slice(end);
}
function replaceAllExact(source, needle, replacement, expected, label) {
  const count = source.split(needle).length - 1;
  if (count !== expected) throw new Error(label + ': expected ' + expected + ' anchors, found ' + count);
  return source.split(needle).join(replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');
let entry = read('src/libmpv-shared-entry.js');
let app = read('src/app.js');

for (const marker of ['LILAC_R34_HANDOFF_SENT_ACK','LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY','r34FocusHandoffSentFrames','r35FocusRedrawArms']) {
  if (!bridge.includes(marker)) throw new Error('R36 requires R35 handoff baseline: ' + marker);
}
if (!entry.includes('LILAC_R35_ASS_PLACEMENT_RECOVERY') || !app.includes('track.dataset.lilacNativePath')) {
  throw new Error('R36 requires R35/R32 subtitle baseline');
}
if (bridge.includes('LILAC_R36_HANDOFF_ACK_ORDER') || entry.includes('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC')) {
  throw new Error('R36 already applied');
}

// ---------------------------------------------------------------------------
// 1) Fix the real R35 release-before-send bookkeeping race.
// Electron can acknowledge allReferencesReleased before the awaited send path
// resumes and inserts frameId into r34FocusHandoffSentFrames. R34 then discards
// that release forever and leaves the native popup over Chromium. Track both
// halves independently and complete when either ordering observes the other.
// ---------------------------------------------------------------------------
bridge = replaceOnce(
  bridge,
  '  const r34FocusHandoffSentFrames = new Set();',
  `  const r34FocusHandoffSentFrames = new Set(); // LILAC_R36_HANDOFF_ACK_ORDER
  const r36FocusHandoffReleasedFrames = new Set();
  const R36_HANDOFF_FAIL_OPEN_MS = 1500;
  const R36_SUPPLY_GAP_CAPACITY = 48;
  const r36SupplyGaps = new Array(R36_SUPPLY_GAP_CAPACITY);
  let r36SupplyGapNext = 0;
  let r36SupplyGapCount = 0;
  let r36ReleaseBeforeSend = 0;
  let r36SendAfterRelease = 0;
  let r36AckCompletions = 0;
  let r36MirrorArmFailures = 0;
  let r36FailOpenCount = 0;
  let r36LastFailOpenWallMs = 0;
  let r36HandoffFailOpenTimer = null;`,
  'R36 ack-order state'
);

const r36Helpers = String.raw`
  function r36ClearHandoffFailOpen() {
    if (r36HandoffFailOpenTimer) clearTimeout(r36HandoffFailOpenTimer);
    r36HandoffFailOpenTimer = null;
  }

  function r36PushSupplyGap(entry) {
    r36SupplyGaps[r36SupplyGapNext] = entry;
    r36SupplyGapNext = (r36SupplyGapNext + 1) % R36_SUPPLY_GAP_CAPACITY;
    r36SupplyGapCount = Math.min(R36_SUPPLY_GAP_CAPACITY, r36SupplyGapCount + 1);
  }

  function r36SnapshotSupplyGaps() {
    const out = [];
    const start = (r36SupplyGapNext - r36SupplyGapCount + R36_SUPPLY_GAP_CAPACITY) % R36_SUPPLY_GAP_CAPACITY;
    for (let i = 0; i < r36SupplyGapCount; i += 1) out.push({ ...r36SupplyGaps[(start + i) % R36_SUPPLY_GAP_CAPACITY] });
    return out;
  }

  function r36ArmHandoffFailOpen() {
    r36ClearHandoffFailOpen();
    const minFrameId = r34FocusHandoffMinFrameId;
    r36HandoffFailOpenTimer = setTimeout(() => {
      r36HandoffFailOpenTimer = null;
      if (!r34FocusHandoffPending || r34FocusHandoffMinFrameId !== minFrameId) return;
      const focused = Boolean(attachedWindow && !attachedWindow.isDestroyed?.() && attachedWindow.isFocused?.());
      if (!focused) return;
      r36FailOpenCount += 1;
      r36LastFailOpenWallMs = Date.now();
      r34FocusHandoffPending = false;
      r34FocusHandoffMinFrameId = 0;
      r34FocusHandoffStartedWallMs = 0;
      r34FocusHandoffSentFrames.clear();
      r36FocusHandoffReleasedFrames.clear();
      try { addon.setNativePresenterMirrorChromium(playerId, false); } catch {}
      r34SetNativeSubtitleVisible(false, 'r36-focus-fail-open');
      try { addon.setNativePresenterVisible(playerId, false); } catch {}
      r33NativePresenterActive = false;
      r27LastDispatchWallMs = 0;
    }, R36_HANDOFF_FAIL_OPEN_MS);
  }

`;
bridge = replaceOnce(
  bridge,
  '  function r34SetNativeSubtitleVisible(visible, reason = \'focus\') {',
  r36Helpers + '  function r34SetNativeSubtitleVisible(visible, reason = \'focus\') {',
  'R36 helper insertion'
);

// The visibility command itself is also the paused redraw trigger. R35 counted
// failures whenever active flipped false during a focus edge even though the
// player still existed. Visibility is safe whenever addon/playerId exist.
bridge = replaceInside(
  bridge,
  '  function r34SetNativeSubtitleVisible(',
  '  function r34CancelFocusHandoff(',
  '    if (!addon || playerId == null || !active) return false;',
  '    if (!addon || playerId == null) return false;',
  'R36 subtitle visibility guard'
);

// R34 ack hardening clears the sent set in cancel/begin/complete. Keep released
// bookkeeping and the emergency timer scoped to exactly the same lifecycle.
bridge = replaceAllExact(
  bridge,
  '    r34FocusHandoffSentFrames.clear();\n',
  '    r34FocusHandoffSentFrames.clear();\n    r36FocusHandoffReleasedFrames.clear();\n    r36ClearHandoffFailOpen();\n',
  3,
  'R36 handoff lifecycle reset'
);

// A rejected native mirror arm must not leave pending=true. A successful arm gets
// a bounded fail-open so Chromium UI can never be covered indefinitely again.
bridge = replaceInside(
  bridge,
  '  function r34BeginFocusHandoff(',
  '  function r34CompleteFocusHandoff(',
  `    try {
      return addon.setNativePresenterMirrorChromium(playerId, true) === true;
    } catch (error) {`,
  `    try {
      const armed = addon.setNativePresenterMirrorChromium(playerId, true) === true;
      if (armed) {
        r36ArmHandoffFailOpen();
        return true;
      }
      r36MirrorArmFailures += 1;
      r34FocusHandoffPending = false;
      r34FocusHandoffMinFrameId = 0;
      r34FocusHandoffStartedWallMs = 0;
      return false;
    } catch (error) {`,
  'R36 mirror arm hardening'
);

// Do not arm a redraw handoff for an inactive/hidden player. This is the exact
// state that produced 5/10 redraw failures in the user's R35 capture.
bridge = replaceOnce(
  bridge,
  '      if (r33NativePresenterActive && r34BeginFocusHandoff()) {',
  '      if (r33NativePresenterActive && active && r32TargetVisible && r34BeginFocusHandoff()) {',
  'R36 active focus handoff gate'
);

// Release path: remember renderer consumption even if the successful send marker
// has not been inserted yet. Existing completion still handles send-first order.
bridge = replaceOnce(
  bridge,
  '    r34CompleteFocusHandoff(ownerPlayerId, frameId);',
  `    if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {
      const releasedFrameId = Number(frameId);
      if (!r34FocusHandoffSentFrames.has(releasedFrameId)) r36ReleaseBeforeSend += 1;
      r36FocusHandoffReleasedFrames.add(releasedFrameId);
      while (r36FocusHandoffReleasedFrames.size > 24) r36FocusHandoffReleasedFrames.delete(r36FocusHandoffReleasedFrames.values().next().value);
    }
    r34CompleteFocusHandoff(ownerPlayerId, frameId);`,
  'R36 release-before-send tracking'
);

// Send path: if release already happened, complete immediately now that both
// conditions are proven. If release arrives later, the existing release call does
// the completion. No extra IPC, polling, fence or per-frame promise is added.
const oldSentMark = `      if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {
        r34FocusHandoffSentFrames.add(Number(frameId));
        while (r34FocusHandoffSentFrames.size > 24) r34FocusHandoffSentFrames.delete(r34FocusHandoffSentFrames.values().next().value);
      }
`;
const newSentMark = `      if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {
        const sentFrameId = Number(frameId);
        r34FocusHandoffSentFrames.add(sentFrameId);
        if (r36FocusHandoffReleasedFrames.has(sentFrameId)) {
          r36SendAfterRelease += 1;
          r36AckCompletions += 1;
          r34CompleteFocusHandoff(ownerPlayerId, sentFrameId);
        }
        while (r34FocusHandoffSentFrames.size > 24) r34FocusHandoffSentFrames.delete(r34FocusHandoffSentFrames.values().next().value);
      }
`;
bridge = replaceOnce(bridge, oldSentMark, newSentMark, 'R36 send-after-release completion');

// Count normal send-first completions too. This runs only after the original
// sent-frame gate has accepted the release.
bridge = replaceInside(
  bridge,
  '  function r34CompleteFocusHandoff(',
  '  function r32ApplyNativePresenterFocus(',
  '    r34FocusHandoffCompleted += 1;\n',
  `    r34FocusHandoffCompleted += 1;
    r36AckCompletions += 1;
`,
  'R36 ack completion counter'
);
// send-after-release already incremented just before calling complete; avoid double
// counting that one path by removing the pre-call increment and let complete own it.
bridge = bridge.replace('          r36AckCompletions += 1;\n          r34CompleteFocusHandoff(ownerPlayerId, sentFrameId);', '          r34CompleteFocusHandoff(ownerPlayerId, sentFrameId);');

// Retain enough context around >60ms supply gaps without synchronously polling
// libmpv. The cached R31 state makes a future single diagnostic distinguish focus
// handoff, pause/cache state and genuine focused supply gaps at negligible cost.
const oldGapBlock = `      if (r27DispatchGapMs >= 60) {
        r27PushRing(r27MainAnomalies, 'anomaly', 'anomaly', {
          kind: 'dispatch-gap',
          frameId: Number(frameId) || 0,
          wallMs: r26DispatchWallMs,
          gapMs: r27DispatchGapMs,
          focused: r27MainFocused
        });
      }`;
const newGapBlock = `      if (r27DispatchGapMs >= 60) {
        r27PushRing(r27MainAnomalies, 'anomaly', 'anomaly', {
          kind: 'dispatch-gap',
          frameId: Number(frameId) || 0,
          wallMs: r26DispatchWallMs,
          gapMs: r27DispatchGapMs,
          focused: r27MainFocused
        });
        r36PushSupplyGap({
          frameId: Number(frameId) || 0,
          timestampUs: Number(timestampUs) || 0,
          wallMs: r26DispatchWallMs,
          gapMs: r27DispatchGapMs,
          focused: r27MainFocused,
          handoffPending: r34FocusHandoffPending,
          nativePresenterActive: r33NativePresenterActive,
          stateAgeMs: r31StateSampleWallMs > 0 ? Math.max(0, r26DispatchWallMs - r31StateSampleWallMs) : null,
          paused: lastState?.paused === true,
          pausedForCache: lastState?.pausedForCache === true,
          time: Number(lastState?.time) || 0,
          cacheBufferingState: Number(lastState?.cacheBufferingState) || 0
        });
      }`;
bridge = replaceOnce(bridge, oldGapBlock, newGapBlock, 'R36 low-overhead supply-gap attribution');

bridge = replaceOnce(
  bridge,
  `          r35FocusRedrawArms,
          r35FocusRedrawFailures
`,
  `          r35FocusRedrawArms,
          r35FocusRedrawFailures,
          r36Ack: {
            marker: 'LILAC_R36_HANDOFF_ACK_ORDER',
            releasedBeforeSent: r36FocusHandoffReleasedFrames.size,
            releaseBeforeSendEvents: r36ReleaseBeforeSend,
            sendAfterReleaseEvents: r36SendAfterRelease,
            completions: r36AckCompletions,
            mirrorArmFailures: r36MirrorArmFailures,
            failOpenMs: R36_HANDOFF_FAIL_OPEN_MS,
            failOpenCount: r36FailOpenCount,
            lastFailOpenWallMs: r36LastFailOpenWallMs
          },
          r36SupplyGaps: r36SnapshotSupplyGaps()
`,
  'R36 diagnostics'
);

// ---------------------------------------------------------------------------
// 2) Deterministic native fallback subtitles.
// R35's `scale` preserves authored ASS positioning, which is exactly why the
// fallback jumped hundreds of pixels relative to Lilac's HTML/VTT subtitle.
// The native popup is a fallback-only surface, so feed it the plain dialogue path
// whenever available and strip ASS tags/styles as a final safety net. This lets
// R32's explicit sub-pos/font-size/border mapping own placement again without
// returning to destructive `force`.
// ---------------------------------------------------------------------------
entry = replaceOnce(
  entry,
  "      ['set_property', 'sub-ass-override', 'scale'], // LILAC_R34_SUBTITLE_SINGLE_OWNER LILAC_R35_ASS_PLACEMENT_RECOVERY",
  "      ['set_property', 'sub-ass-override', 'strip'], // LILAC_R34_SUBTITLE_SINGLE_OWNER LILAC_R35_ASS_PLACEMENT_RECOVERY LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC",
  'R36 deterministic native subtitle style'
);
app = replaceOnce(
  app,
  "  const nativeSubtitlePath=(options.assPath&&typeof assEffectsEnabled==='function'&&assEffectsEnabled()?options.assPath:options.path)||'';",
  "  const nativeSubtitlePath=(options.path||options.assPath)||''; // LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE",
  'R36 plain native subtitle source preference'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('src/libmpv-shared-entry.js', entry);
write('src/app.js', app);

buildSync({
  entryPoints: [file('src/libmpv-shared-entry.js')],
  outfile: file('src/libmpv-shared.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome152',
  logLevel: 'info'
});

const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalEntry = read('src/libmpv-shared-entry.js');
const finalBundle = read('src/libmpv-shared.generated.js');
const finalApp = read('src/app.js');
for (const marker of [
  'LILAC_R36_HANDOFF_ACK_ORDER','r36FocusHandoffReleasedFrames','r36ReleaseBeforeSend','r36SendAfterRelease',
  'R36_HANDOFF_FAIL_OPEN_MS = 1500','r36SupplyGaps','r36-focus-fail-open',
  'r33NativePresenterActive && active && r32TargetVisible && r34BeginFocusHandoff()'
]) if (!finalBridge.includes(marker)) throw new Error('R36 bridge marker missing: ' + marker);
if (!finalEntry.includes("'sub-ass-override', 'strip'") || !finalEntry.includes('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC')) {
  throw new Error('R36 native subtitle strip source gate failed');
}
if (!finalBundle.includes('sub-ass-override') || !finalBundle.includes('strip')) throw new Error('R36 bundled subtitle strip missing');
if (finalEntry.includes("'sub-ass-override', 'force'") || finalEntry.includes("'sub-ass-override', 'scale'")) {
  throw new Error('R36 retained non-deterministic/destructive native subtitle override');
}
if (!finalApp.includes('LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE') || !finalApp.includes('(options.path||options.assPath)')) {
  throw new Error('R36 plain native subtitle path gate failed');
}
if (finalBridge.includes('if (!addon || playerId == null || !active) return false;')) {
  throw new Error('R36 retained active-dependent paused redraw visibility guard');
}
console.log('R36_HANDOFF_ACK_SUBTITLE_STABILITY_OK ack=bidirectional-order+1500ms-fail-open pausedRedraw=active-gated subtitle=plain-source+ass-strip supplyGap=cache-state-ring r33NativeOnly=preserved');

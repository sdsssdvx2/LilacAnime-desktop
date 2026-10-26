'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'electron/libmpv-shared-main.cjs');
let bridge = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function replaceInside(source, startNeedle, endNeedle, needle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(`${label}: function boundary missing`);
  const block = source.slice(start, end);
  const patched = replaceOnce(block, needle, replacement, label);
  return source.slice(0, start) + patched + source.slice(end);
}

if (!bridge.includes('LILAC_R34_FOCUS_HANDOFF') || !bridge.includes('r34CompleteFocusHandoff')) {
  throw new Error('R34 focus handoff baseline missing');
}
if (bridge.includes('LILAC_R34_HANDOFF_SENT_ACK')) throw new Error('R34 handoff sent-ack hardening already applied');

bridge = replaceOnce(
  bridge,
  '  let r34FocusHandoffMinFrameId = 0;',
  '  let r34FocusHandoffMinFrameId = 0; // LILAC_R34_HANDOFF_SENT_ACK\n  const r34FocusHandoffSentFrames = new Set();',
  'R34 sent-ack state'
);

bridge = replaceInside(
  bridge,
  '  function r34CancelFocusHandoff(',
  '  function r34BeginFocusHandoff(',
  '    r34FocusHandoffStartedWallMs = 0;\n',
  '    r34FocusHandoffStartedWallMs = 0;\n    r34FocusHandoffSentFrames.clear();\n',
  'R34 sent-ack cancel reset'
);
bridge = replaceInside(
  bridge,
  '  function r34BeginFocusHandoff(',
  '  function r34CompleteFocusHandoff(',
  '    r34FocusHandoffStartedWallMs = Date.now();\n',
  '    r34FocusHandoffStartedWallMs = Date.now();\n    r34FocusHandoffSentFrames.clear();\n',
  'R34 sent-ack begin reset'
);
bridge = replaceInside(
  bridge,
  '  function r34CompleteFocusHandoff(',
  '  function r32ApplyNativePresenterFocus(',
  '    if (!r34FocusHandoffPending || ownerPlayerId !== playerId || Number(frameId) < r34FocusHandoffMinFrameId) return;\n',
  '    if (!r34FocusHandoffPending || ownerPlayerId !== playerId || Number(frameId) < r34FocusHandoffMinFrameId || !r34FocusHandoffSentFrames.has(Number(frameId))) return;\n',
  'R34 sent-ack completion gate'
);
bridge = replaceInside(
  bridge,
  '  function r34CompleteFocusHandoff(',
  '  function r32ApplyNativePresenterFocus(',
  '    r34FocusHandoffStartedWallMs = 0;\n',
  '    r34FocusHandoffStartedWallMs = 0;\n    r34FocusHandoffSentFrames.clear();\n',
  'R34 sent-ack completion reset'
);

// sendImportedFrame is serialized by R24. Mark only a frame whose Electron
// sharedTexture send promise actually fulfilled. allReferencesReleased then proves
// that exact successfully-sent frame has no remaining main/renderer references.
bridge = replaceOnce(
  bridge,
  '      metrics.sentFrames += 1;\n',
  `      metrics.sentFrames += 1;
      if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {
        r34FocusHandoffSentFrames.add(Number(frameId));
        while (r34FocusHandoffSentFrames.size > 24) r34FocusHandoffSentFrames.delete(r34FocusHandoffSentFrames.values().next().value);
      }
`,
  'R34 sent-ack successful send mark'
);

bridge = replaceOnce(
  bridge,
  '          subtitleVisible: r34SubtitleVisible,\n          subtitleTransitions: r34SubtitleTransitions\n',
  '          subtitleVisible: r34SubtitleVisible,\n          subtitleTransitions: r34SubtitleTransitions,\n          sentAwaitingRelease: r34FocusHandoffSentFrames.size\n',
  'R34 sent-ack diagnostics'
);

fs.writeFileSync(target, bridge, 'utf8');
const out = fs.readFileSync(target, 'utf8');
for (const marker of [
  'LILAC_R34_HANDOFF_SENT_ACK',
  'r34FocusHandoffSentFrames',
  '!r34FocusHandoffSentFrames.has(Number(frameId))',
  'r34FocusHandoffSentFrames.add(Number(frameId))',
  'sentAwaitingRelease: r34FocusHandoffSentFrames.size'
]) {
  if (!out.includes(marker)) throw new Error(`R34 handoff sent-ack marker missing: ${marker}`);
}
console.log('R34_HANDOFF_SENT_ACK_OK completion=successful-send+allReferencesReleased staleOrFailedRelease=ignored cap=24');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r37-explicit-handoff-e2e-smoke.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function once(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

// R37 used subtitleVisible=true as a convenient proxy for entering the
// unfocused native-owned surface. R40 deliberately makes that proxy invalid:
// the native video popup is still required, but subtitle rendering belongs to
// the separate single-DOM transparent overlay and native sub-visibility must
// remain disabled. Keep every R37 handoff/ACK/transport assertion and adapt only
// this obsolete subtitle proxy when R40 diagnostics prove the new authority is
// present in the generated bridge state.
once(
  `    const view = r37State(bridge);\n    return view.focus.active === true && view.handoff.subtitleVisible === true;`,
  `    const view = r37State(bridge);\n    const r40SingleDom = Object.prototype.hasOwnProperty.call(view.handoff || {}, 'r40NativeSubtitleSuppressedRequests');\n    const r40SuppressionReady = view.handoff.subtitleVisible === false && Number(view.handoff.r40NativeSubtitleSuppressedRequests || 0) >= expectedAck;\n    return view.focus.active === true && (r40SingleDom ? r40SuppressionReady : view.handoff.subtitleVisible === true);`,
  'R37 native-active subtitle proxy'
);

once(
  `  const blurred = r37State(bridge);\n  if (Number(blurred.r36.uiHoleRects || 0) !== 0)`,
  `  const blurred = r37State(bridge);\n  const r40SingleDom = Object.prototype.hasOwnProperty.call(blurred.handoff || {}, 'r40NativeSubtitleSuppressedRequests');\n  if (r40SingleDom && blurred.handoff.subtitleVisible !== false) throw new Error(\`\${label} R40 native subtitle unexpectedly visible\`);\n  if (r40SingleDom && Number(blurred.handoff.r40NativeSubtitleSuppressedRequests || 0) < expectedAck) throw new Error(\`\${label} R40 native subtitle suppression count too low=\${blurred.handoff.r40NativeSubtitleSuppressedRequests}\`);\n  if (Number(blurred.r36.uiHoleRects || 0) !== 0)`,
  'R37 blurred R40 subtitle authority assertion'
);

// R40 no longer toggles native subtitle visibility to provoke libmpv redraws.
// The paused/no-subtitle handoff must instead exercise the producer-thread
// one-shot current-frame redraw. Measure that exact cycle so a natural or stray
// update cannot accidentally make this regression test pass.
once(
  `    bridge.command(['sub-remove']);\n    await sleep(120);\n    const pausedNoSubtitle = await focusCycle(bridge, main, other, 3, 'paused-no-subtitle');`,
  `    bridge.command(['sub-remove']);\n    await sleep(120);\n    const r40ForcedRedrawBefore = Number(bridge.state()?.frameProducer?.forcedRedrawFrames || 0);\n    const r40HandoffRedrawBefore = Number(r37State(bridge).r37?.r40HandoffRedrawAccepted || 0);\n    const pausedNoSubtitle = await focusCycle(bridge, main, other, 3, 'paused-no-subtitle');\n    const r40ForcedRedrawAfter = Number(bridge.state()?.frameProducer?.forcedRedrawFrames || 0);\n    const r40HandoffRedrawAfter = Number(r37State(bridge).r37?.r40HandoffRedrawAccepted || 0);\n    const r40RedrawDiagnosticsPresent = Object.prototype.hasOwnProperty.call(bridge.state()?.frameProducer || {}, 'forcedRedrawFrames');\n    if (r40RedrawDiagnosticsPresent && r40HandoffRedrawAfter <= r40HandoffRedrawBefore) throw new Error(\`paused-no-subtitle R40 handoff redraw request was not accepted before=\${r40HandoffRedrawBefore} after=\${r40HandoffRedrawAfter}\`);\n    if (r40RedrawDiagnosticsPresent && r40ForcedRedrawAfter <= r40ForcedRedrawBefore) throw new Error(\`paused-no-subtitle R40 forced redraw frame was not produced before=\${r40ForcedRedrawBefore} after=\${r40ForcedRedrawAfter}\`);`,
  'R37 paused-no-subtitle forced redraw proof'
);

once(
  `    if (Number(final.r37.rendererAckCompletions || 0) !== 3) throw new Error(\`expected 3 R37 ACK completions got \${final.r37.rendererAckCompletions}\`);`,
  `    if (Number(final.r37.rendererAckCompletions || 0) !== 3) throw new Error(\`expected 3 R37 ACK completions got \${final.r37.rendererAckCompletions}\`);\n    const r40SingleDomFinal = Object.prototype.hasOwnProperty.call(final.handoff || {}, 'r40NativeSubtitleSuppressedRequests');\n    if (r40SingleDomFinal && Number(final.handoff.r40NativeSubtitleSuppressedRequests || 0) < 3) throw new Error(\`R40 native subtitle suppression was not exercised across all focus cycles count=\${final.handoff.r40NativeSubtitleSuppressedRequests}\`);\n    const r40RedrawFinal = final.state?.frameProducer || {};\n    if (Object.prototype.hasOwnProperty.call(r40RedrawFinal, 'forcedRedrawRequests')) {\n      if (Number(final.r37.r40HandoffRedrawAccepted || 0) < 3) throw new Error(\`R40 handoff redraw was not accepted across all cycles count=\${final.r37.r40HandoffRedrawAccepted}\`);\n      if (Number(r40RedrawFinal.forcedRedrawRequests || 0) < 3) throw new Error(\`R40 producer redraw requests too low count=\${r40RedrawFinal.forcedRedrawRequests}\`);\n      if (Number(r40RedrawFinal.forcedRedrawFrames || 0) < 1) throw new Error('R40 producer emitted no forced redraw frame');\n    }`,
  'R37 final R40 semantic proof'
);

fs.writeFileSync(target, source, 'utf8');
console.log('R40_R37_E2E_SEMANTIC_COMPAT_OK nativeSurface=R37-preserved nativeSubtitle=R40-single-DOM-suppressed perCycleSuppression=required handoffRedraw=producer-thread-one-shot pausedNoSubtitle=forced-frame-required ackTransportAssertions=unchanged');

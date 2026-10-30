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
  `    const view = r37State(bridge);\n    const r40SingleDom = Object.prototype.hasOwnProperty.call(view.handoff || {}, 'r40NativeSubtitleSuppressedRequests');\n    return view.focus.active === true && (r40SingleDom ? view.handoff.subtitleVisible === false : view.handoff.subtitleVisible === true);`,
  'R37 native-active subtitle proxy'
);

once(
  `  const blurred = r37State(bridge);\n  if (Number(blurred.r36.uiHoleRects || 0) !== 0)`,
  `  const blurred = r37State(bridge);\n  const r40SingleDom = Object.prototype.hasOwnProperty.call(blurred.handoff || {}, 'r40NativeSubtitleSuppressedRequests');\n  if (r40SingleDom && blurred.handoff.subtitleVisible !== false) throw new Error(\`${'${label}'} R40 native subtitle unexpectedly visible\`);\n  if (Number(blurred.r36.uiHoleRects || 0) !== 0)`,
  'R37 blurred R40 subtitle authority assertion'
);

once(
  `    if (Number(final.r37.rendererAckCompletions || 0) !== 3) throw new Error(\`expected 3 R37 ACK completions got ${'${final.r37.rendererAckCompletions}'}\`);`,
  `    if (Number(final.r37.rendererAckCompletions || 0) !== 3) throw new Error(\`expected 3 R37 ACK completions got ${'${final.r37.rendererAckCompletions}'}\`);\n    const r40SingleDomFinal = Object.prototype.hasOwnProperty.call(final.handoff || {}, 'r40NativeSubtitleSuppressedRequests');\n    if (r40SingleDomFinal && Number(final.handoff.r40NativeSubtitleSuppressedRequests || 0) < 3) throw new Error(\`R40 native subtitle suppression was not exercised across all focus cycles count=${'${final.handoff.r40NativeSubtitleSuppressedRequests}'}\`);`,
  'R37 final R40 subtitle suppression proof'
);

fs.writeFileSync(target, source, 'utf8');
console.log('R40_R37_E2E_SEMANTIC_COMPAT_OK nativeSurface=R37-preserved nativeSubtitle=R40-single-DOM-suppressed ackTransportAssertions=unchanged');

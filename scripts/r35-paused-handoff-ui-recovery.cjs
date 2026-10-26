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

let bridge = read('electron/libmpv-shared-main.cjs');
let entry = read('src/libmpv-shared-entry.js');

if (!bridge.includes('LILAC_R34_FOCUS_HANDOFF') || !bridge.includes('LILAC_R34_HANDOFF_SENT_ACK')) {
  throw new Error('R35 requires qualified R34 handoff baseline');
}
if (!entry.includes('LILAC_R34_SUBTITLE_SINGLE_OWNER')) {
  throw new Error('R35 requires R34 subtitle ownership baseline');
}
if (bridge.includes('LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY') || entry.includes('LILAC_R35_ASS_PLACEMENT_RECOVERY')) {
  throw new Error('R35 already applied');
}

// R34 deliberately kept the native owned popup above Chromium until a fresh
// Chromium frame was successfully sent and all references were released. That is
// correct while playback is moving, but a paused mpv produces no fresh frame, so
// the popup can cover the HTML UI forever. Arm the mirror first, then hide only
// the native subtitle. Changing sub-visibility invalidates libass composition and
// asks mpv for a redraw of the current paused frame; because mirror is already
// armed, that redraw can complete the exact same send+release handoff proof.
bridge = replaceOnce(
  bridge,
  '  let r34SubtitleTransitions = 0;',
  '  let r34SubtitleTransitions = 0; // LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY\n  let r35FocusRedrawArms = 0;\n  let r35FocusRedrawFailures = 0;',
  'R35 focus redraw counters'
);

bridge = replaceOnce(
  bridge,
  '      if (r33NativePresenterActive && r34BeginFocusHandoff()) return;',
  `      if (r33NativePresenterActive && r34BeginFocusHandoff()) {
        r35FocusRedrawArms += 1;
        if (!r34SetNativeSubtitleVisible(false, 'r35-focus-handoff-redraw')) r35FocusRedrawFailures += 1;
        return;
      }`,
  'R35 focus handoff redraw arm'
);

bridge = replaceOnce(
  bridge,
  '          sentAwaitingRelease: r34FocusHandoffSentFrames.size\n',
  `          sentAwaitingRelease: r34FocusHandoffSentFrames.size,
          r35FocusRedrawArms,
          r35FocusRedrawFailures
`,
  'R35 handoff diagnostics'
);

// R34 used force so normal sub-pos/font/border settings would override ASS.
// mpv documents force as potentially destructive because it applies almost all
// normal sub-* options to ASS. R32 already had explicit fallback style mapping;
// use mpv's default scale-level ASS override instead so authored ASS placement is
// preserved while the fallback remains legible and user scaling still works.
entry = replaceOnce(
  entry,
  "      ['set_property', 'sub-ass-override', 'force'], // LILAC_R34_SUBTITLE_SINGLE_OWNER",
  "      ['set_property', 'sub-ass-override', 'scale'], // LILAC_R34_SUBTITLE_SINGLE_OWNER LILAC_R35_ASS_PLACEMENT_RECOVERY",
  'R35 ASS override de-escalation'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('src/libmpv-shared-entry.js', entry);

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
for (const marker of ['LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY','r35FocusRedrawArms','r35-focus-handoff-redraw']) {
  if (!finalBridge.includes(marker)) throw new Error('R35 bridge marker missing: ' + marker);
}
// Source gates may assert the exact authored literal and retained marker. The
// generated esbuild bundle is free to normalize quote style and strip comments,
// so validate its runtime semantics rather than source formatting.
if (!finalEntry.includes("'sub-ass-override', 'scale'") || !finalEntry.includes('LILAC_R35_ASS_PLACEMENT_RECOVERY')) {
  throw new Error('R35 subtitle source marker missing');
}
if (!finalBundle.includes('sub-ass-override') || !finalBundle.includes('scale')) {
  throw new Error('R35 bundled subtitle override semantics missing');
}
if (finalEntry.includes("'sub-ass-override', 'force'")) throw new Error('R35 destructive ASS force override survived source');
if (/sub-ass-override[^\n]{0,80}["']force["']/.test(finalBundle)) throw new Error('R35 destructive ASS force override survived bundle');
if (!finalBridge.includes("r34SetNativeSubtitleVisible(false, 'r35-focus-handoff-redraw')")) {
  throw new Error('R35 paused redraw trigger missing');
}
console.log('R35_PAUSED_HANDOFF_UI_RECOVERY_OK mirrorFirst=1 focusNativeSubtitleOff=1 pausedRedrawTrigger=1 assOverride=scale bundleGate=semantic htmlUiUncoverAfterSendRelease=1');

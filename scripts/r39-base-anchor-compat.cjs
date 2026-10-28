'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, 'r39-refocus-pip-subtitle-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const escapedOld = "        r33FocusSurface: {\\n          mode: 'owned-popup-native-only-unfocused',";
const escapedNew = "      r33FocusSurface: {\\n        mode: 'owned-popup-native-only-unfocused',";
const literalOld = "        r33FocusSurface: {\n          mode: 'owned-popup-native-only-unfocused',";
const literalNew = "      r33FocusSurface: {\n        mode: 'owned-popup-native-only-unfocused',";

const escapedCount = source.split(escapedOld).length - 1;
const literalCount = source.split(literalOld).length - 1;
if (escapedCount < 1) throw new Error(`R39 base compat expected at least one escaped stale r33FocusSurface anchor, found ${escapedCount}`);
if (literalCount < 1) throw new Error(`R39 base compat expected at least one literal stale r33FocusSurface template, found ${literalCount}`);

source = source.split(escapedOld).join(escapedNew);
source = source.split(literalOld).join(literalNew);

// r39MiniPlayer is a sibling of r33FocusSurface in copied diagnostics. Keep its
// generated indentation at the actual R38 object level too; whitespace is semantic
// only to the transform anchors, but normalizing it prevents another self-mismatch.
source = source.split('        r39MiniPlayer: attachedWindow?.__lilacMiniPlayerDiagnostics || {')
  .join('      r39MiniPlayer: attachedWindow?.__lilacMiniPlayerDiagnostics || {');

if (source.includes(escapedOld) || source.includes(literalOld)) {
  throw new Error('R39 base compat left stale r33FocusSurface indentation');
}
for (const marker of [
  escapedNew,
  literalNew,
  "      r39MiniPlayer: attachedWindow?.__lilacMiniPlayerDiagnostics || {",
  'R39 phase diagnostics',
  'R39 mini-player bridge diagnostics'
]) {
  if (!source.includes(marker)) throw new Error(`R39 base compat missing corrected marker: ${marker}`);
}

fs.writeFileSync(target, source, 'utf8');
console.log(`R39_BASE_ANCHOR_COMPAT_OK r33FocusSurfaceIndent=R38-actual escaped=${escapedCount} literal=${literalCount} siblingMiniPlayer=normalized`);

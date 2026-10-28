'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(process.argv[2] || path.join(__dirname, 'r39-refocus-pip-subtitle-fix.cjs'));
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const escapedOld = "        r33FocusSurface: {\\n          mode: 'owned-popup-native-only-unfocused',";
const escapedNew = "      r33FocusSurface: {\\n        mode: 'owned-popup-native-only-unfocused',";
const literalOld = "        r33FocusSurface: {\n          mode: 'owned-popup-native-only-unfocused',";
const literalNew = "      r33FocusSurface: {\n        mode: 'owned-popup-native-only-unfocused',";

const escapedCount = source.split(escapedOld).length - 1;
const literalCount = source.split(literalOld).length - 1;
if (escapedCount < 1) throw new Error(`R39 temp compat expected escaped stale anchor, found ${escapedCount}`);
if (literalCount < 1) throw new Error(`R39 temp compat expected literal stale template, found ${literalCount}`);

source = source.split(escapedOld).join(escapedNew);
source = source.split(literalOld).join(literalNew);
source = source.split('        r39MiniPlayer: attachedWindow?.__lilacMiniPlayerDiagnostics || {')
  .join('      r39MiniPlayer: attachedWindow?.__lilacMiniPlayerDiagnostics || {');

if (source.includes(escapedOld) || source.includes(literalOld)) throw new Error('R39 temp compat left stale diagnostics indentation');
for (const marker of [escapedNew, literalNew, "      r39MiniPlayer: attachedWindow?.__lilacMiniPlayerDiagnostics || {"]) {
  if (!source.includes(marker)) throw new Error(`R39 temp compat missing corrected marker: ${marker}`);
}

fs.writeFileSync(target, source, 'utf8');
console.log(`R39_BASE_ANCHOR_COMPAT_V2_OK target=${path.basename(target)} mode=temp-copy escaped=${escapedCount} literal=${literalCount} workingTreeMutation=none`);

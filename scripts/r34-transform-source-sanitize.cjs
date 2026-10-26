'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r34-focus-handoff-stall-fix.cjs');
let text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceExactOrAlready(needle, replacement, label) {
  const before = text.split(needle).length - 1;
  const after = text.split(replacement).length - 1;
  if (before === 1 && after === 0) {
    text = text.replace(needle, replacement);
    return 'replaced';
  }
  if (before === 0 && after === 1) return 'already';
  throw new Error(`${label}: expected one original or one sanitized occurrence, found original=${before} sanitized=${after}`);
}

function replaceAllCounted(needle, replacement, expected, label) {
  const before = text.split(needle).length - 1;
  const after = text.split(replacement).length - 1;
  if (before === expected && after === 0) {
    text = text.split(needle).join(replacement);
    return 'replaced';
  }
  if (before === 0 && after === expected) return 'already';
  throw new Error(`${label}: expected ${expected} originals or ${expected} sanitized occurrences, found original=${before} sanitized=${after}`);
}

function replaceLineContaining(needle, replacement, label) {
  const lines = text.split('\n');
  const matches = [];
  const already = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(needle)) matches.push(i);
    if (lines[i] === replacement) already.push(i);
  }
  if (matches.length === 1 && already.length === 0) {
    lines[matches[0]] = replacement;
    text = lines.join('\n');
    return 'replaced';
  }
  if (matches.length === 0 && already.length === 1) return 'already';
  throw new Error(`${label}: expected one offending line or one sanitized line, found offending=${matches.length} sanitized=${already.length}`);
}

function replaceLineStarting(needle, replacement, label) {
  const lines = text.split('\n');
  const matches = [];
  const already = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(needle)) matches.push(i);
    if (lines[i] === replacement) already.push(i);
  }
  if (matches.length === 1 && already.length === 0) {
    lines[matches[0]] = replacement;
    text = lines.join('\n');
    return 'replaced';
  }
  if (matches.length === 0 && already.length === 1) return 'already';
  throw new Error(`${label}: expected one definition line or one sanitized line, found offending=${matches.length} sanitized=${already.length}`);
}

function replaceSection(startMarker, endMarker, replacement, alreadyMarker, label) {
  if (text.includes(alreadyMarker)) return 'already';
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) throw new Error(`${label}: section boundary missing`);
  text = text.slice(0, start) + replacement + text.slice(end);
  return 'replaced';
}

const states = [];

// The R34 transform itself generates JavaScript with String.raw template literals.
// Backticks inside the generated bridge/cache snippets must therefore be removed
// before Node parses the transform. Use line-oriented matching so whitespace or
// nearby source-anchor changes cannot silently defeat the sanitizer.
states.push(replaceLineContaining(
  'lastError = `R34 focus handoff arm failed:',
  "      lastError = 'R34 focus handoff arm failed: ' + String(error?.message || error).slice(0, 180);",
  'R34 handoff nested template'
));
states.push(replaceLineContaining(
  'lastError = `R34 native presenter focus failed:',
  "      lastError = 'R34 native presenter focus failed: ' + String(error?.message || error).slice(0, 180);",
  'R34 presenter nested template'
));
states.push(replaceLineStarting(
  'function saveCatalogFile(provider,name,value){const key=`',
  "function saveCatalogFile(provider,name,value){const key=String(provider)+'-'+String(name);clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{r34QueueJsonWrite(path.join(app.getPath('userData'),key+'.json'),value())}catch{}},2000)} // LILAC_R34_CACHE_WRITE_WORKER`;",
  'R34 cache helper nested template'
));

const oldBundleGate = "for (const marker of ['LILAC_R34_SUBTITLE_SINGLE_OWNER',\"'sub-ass-override', 'force'\",'_r34NativeSubtitleLoaded']) assert(e.includes(marker) && bundle.includes(marker), `R34 subtitle marker missing: ${marker}`);";
const newBundleGate = "assert(e.includes('LILAC_R34_SUBTITLE_SINGLE_OWNER'), 'R34 subtitle source marker missing');\nfor (const marker of ['sub-ass-override','_r34NativeSubtitleLoaded']) assert(e.includes(marker) && bundle.includes(marker), `R34 subtitle runtime marker missing: ${marker}`);";
states.push(replaceExactOrAlready(oldBundleGate, newBundleGate, 'R34 bundle semantic gate'));

// R32's final bounds/subtitle safety pass adds setNativePresenterBounds to the
// bridge's required native export list. R34 is applied after that exact R33 tree,
// so normalize the old pre-bounds anchor and its replacement to the real R33 form.
states.push(replaceExactOrAlready(
  `  "'configureNativePresenter', 'setNativePresenterVisible', 'nativePresenterStats', 'destroyPlayer']",`,
  `  "'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterBounds', 'nativePresenterStats', 'destroyPlayer']",`,
  'R34 R33 bridge require needle'
));
states.push(replaceExactOrAlready(
  `  "'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterMirrorChromium', 'nativePresenterStats', 'destroyPlayer']",`,
  `  "'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterMirrorChromium', 'setNativePresenterBounds', 'nativePresenterStats', 'destroyPlayer']",`,
  'R34 R33 bridge require replacement'
));

// Stop depending on the exact text following addon.command(). R31 appends state
// cache invalidation there, and future qualified stages may append more. Replace
// the whole transform section with a command()-bounded patch which searches only
// for the one native call inside that function and inserts authority immediately
// after it while preserving everything that follows.
const structuralCommandPatch = [
  '// After renderer sub-add, main immediately reapplies the authoritative focus state.',
  '// Renderer no longer races BrowserWindow focus with document.hasFocus().',
  '// LILAC_R34_STRUCTURAL_SUBTITLE_COMMAND_PATCH',
  "const commandStart = bridge.indexOf('  function command(value) {');",
  "const commandEnd = bridge.indexOf('\\n\\n  function ', commandStart + 1);",
  "if (commandStart < 0 || commandEnd <= commandStart) throw new Error('R34 command() structural boundary missing');",
  'let commandBlock = bridge.slice(commandStart, commandEnd);',
  "const commandCall = '    addon.command(playerId, commandArray);';",
  "commandBlock = replaceOnce(commandBlock, commandCall, commandCall + \"\\n    if (commandArray[0] === 'sub-add') {\\n      r34SetNativeSubtitleVisible(r33NativePresenterActive, 'sub-add-authority');\\n    }\", 'R34 subtitle authority inside command()');",
  'bridge = bridge.slice(0, commandStart) + commandBlock + bridge.slice(commandEnd);',
  '',
  ''
].join('\n');
states.push(replaceSection(
  '// After renderer sub-add, main immediately reapplies the authoritative focus state.',
  '// Add bounded handoff state to the existing diagnostics object without adding any',
  structuralCommandPatch,
  'LILAC_R34_STRUCTURAL_SUBTITLE_COMMAND_PATCH',
  'R34 structural subtitle command patch'
));

// R33's actual low-rate event-loop probe uses the original names from
// r33-stall-attribution-probe.cjs. An early R34 draft used later experimental
// R33_MAIN_* aliases which were never shipped. Both the needle and replacement
// diagnostics snippets contain each name once, hence exactly two occurrences.
for (const [oldName, shippedName] of [
  ['R33_MAIN_HEARTBEAT_MS', 'R33_HEARTBEAT_MS'],
  ['R33_MAIN_STALL_THRESHOLD_MS', 'R33_HEARTBEAT_STALL_MS'],
  ['r33MainStallCount', 'r33EventLoopStallCount'],
  ['r33MainStallMaxMs', 'r33EventLoopMaxGapMs'],
  ['r33MainStallLastMs', 'r33EventLoopLastGapMs'],
  ['r33MainStallLastWallMs', 'r33EventLoopLastWallMs']
]) {
  states.push(replaceAllCounted(oldName, shippedName, 2, `R34 R33 heartbeat name ${oldName}`));
}

// Do not claim the native fallback subtitle is loaded unless mpv accepted sub-add.
states.push(replaceExactOrAlready(
  `        await this._command(['sub-add', r32NativeSubtitle, 'select']);\n        this._r34NativeSubtitleLoaded = true;`,
  `        this._r34NativeSubtitleLoaded = await this._command(['sub-add', r32NativeSubtitle, 'select']);`,
  'R34 native subtitle loaded acknowledgement'
));

for (const forbidden of [
  'lastError = `R34 focus handoff arm failed:',
  'lastError = `R34 native presenter focus failed:',
  'R33_MAIN_HEARTBEAT_MS',
  'r33MainStallCount',
  "'      addon.command(playerId, commandArray);\\n      return { ok: true };'"
]) {
  if (text.includes(forbidden)) throw new Error(`R34 syntax sanitizer left forbidden/stale transform text: ${forbidden}`);
}
const cacheDefinitionLines = text.split('\n').filter(line => line.startsWith('function saveCatalogFile(provider,name,value){const key=`'));
if (cacheDefinitionLines.length) throw new Error(`R34 syntax sanitizer left ${cacheDefinitionLines.length} nested-template cache definition(s)`);
if (!text.includes('LILAC_R34_STRUCTURAL_SUBTITLE_COMMAND_PATCH')) throw new Error('R34 structural subtitle command patch marker missing');

fs.writeFileSync(target, text, 'utf8');
console.log(`R34_TRANSFORM_SOURCE_SANITIZE_OK idempotent=1 states=${states.join(',')} nestedTemplates=3 lineMatched=1 bundleGate=runtime-semantic bridgeAnchor=R33-bounds-aware commandPatch=structural-function-boundary heartbeatAnchor=R33-shipped subtitleLoadAck=1`);

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

// R31 inserted state-cache invalidation between addon.command() and the return.
// Normalize both the match and replacement in the R34 transform so subtitle
// authority is added without deleting that already-qualified R31 behavior.
states.push(replaceExactOrAlready(
  "  '      addon.command(playerId, commandArray);\\n      return { ok: true };',",
  "  \"      addon.command(playerId, commandArray);\\n      if (commandArray[0] === 'set_property' && ['time-pos', 'pause', 'speed'].includes(commandArray[1])) {\\n        r31LastPlaybackPollPerfMs = -Infinity;\\n      }\\n      return { ok: true };\",",
  'R34 final R31 command needle'
));
states.push(replaceExactOrAlready(
  "`      addon.command(playerId, commandArray);\n      if (commandArray[0] === 'sub-add') {\n        r34SetNativeSubtitleVisible(r33NativePresenterActive, 'sub-add-authority');\n      }\n      return { ok: true };`,",
  "`      addon.command(playerId, commandArray);\n      if (commandArray[0] === 'sub-add') {\n        r34SetNativeSubtitleVisible(r33NativePresenterActive, 'sub-add-authority');\n      }\n      if (commandArray[0] === 'set_property' && ['time-pos', 'pause', 'speed'].includes(commandArray[1])) {\n        r31LastPlaybackPollPerfMs = -Infinity;\n      }\n      return { ok: true };`,",
  'R34 preserve R31 command invalidation'
));

// Do not claim the native fallback subtitle is loaded unless mpv accepted sub-add.
states.push(replaceExactOrAlready(
  `        await this._command(['sub-add', r32NativeSubtitle, 'select']);\n        this._r34NativeSubtitleLoaded = true;`,
  `        this._r34NativeSubtitleLoaded = await this._command(['sub-add', r32NativeSubtitle, 'select']);`,
  'R34 native subtitle loaded acknowledgement'
));

for (const forbidden of [
  'lastError = `R34 focus handoff arm failed:',
  'lastError = `R34 native presenter focus failed:'
]) {
  if (text.includes(forbidden)) throw new Error(`R34 syntax sanitizer left forbidden nested template: ${forbidden}`);
}
const cacheDefinitionLines = text.split('\n').filter(line => line.startsWith('function saveCatalogFile(provider,name,value){const key=`'));
if (cacheDefinitionLines.length) throw new Error(`R34 syntax sanitizer left ${cacheDefinitionLines.length} nested-template cache definition(s)`);

fs.writeFileSync(target, text, 'utf8');
console.log(`R34_TRANSFORM_SOURCE_SANITIZE_OK idempotent=1 states=${states.join(',')} nestedTemplates=3 lineMatched=1 bundleGate=runtime-semantic bridgeAnchor=R33-bounds-aware commandAnchor=R31-aware subtitleLoadAck=1`);

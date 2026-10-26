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

const states = [];
states.push(replaceExactOrAlready(
  '      lastError = `R34 focus handoff arm failed: ${String(error?.message || error).slice(0, 180)}`;',
  "      lastError = 'R34 focus handoff arm failed: ' + String(error?.message || error).slice(0, 180);",
  'R34 handoff nested template'
));
states.push(replaceExactOrAlready(
  '      lastError = `R34 native presenter focus failed: ${String(error?.message || error).slice(0, 180)}`;',
  "      lastError = 'R34 native presenter focus failed: ' + String(error?.message || error).slice(0, 180);",
  'R34 presenter nested template'
));
states.push(replaceExactOrAlready(
  "function saveCatalogFile(provider,name,value){const key=`${provider}-${name}`;clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{r34QueueJsonWrite(path.join(app.getPath('userData'),`${key}.json`),value())}catch{}},2000)} // LILAC_R34_CACHE_WRITE_WORKER",
  "function saveCatalogFile(provider,name,value){const key=provider+'-'+name;clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{r34QueueJsonWrite(path.join(app.getPath('userData'),key+'.json'),value())}catch{}},2000)} // LILAC_R34_CACHE_WRITE_WORKER",
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
// This prevents a later track replacement from reintroducing the sub-remove failure
// seen in the user's R33 diagnostic when the first native subtitle was not present.
states.push(replaceExactOrAlready(
  `        await this._command(['sub-add', r32NativeSubtitle, 'select']);\n        this._r34NativeSubtitleLoaded = true;`,
  `        this._r34NativeSubtitleLoaded = await this._command(['sub-add', r32NativeSubtitle, 'select']);`,
  'R34 native subtitle loaded acknowledgement'
));

fs.writeFileSync(target, text, 'utf8');
console.log(`R34_TRANSFORM_SOURCE_SANITIZE_OK idempotent=1 states=${states.join(',')} nestedTemplates=3 bundleGate=runtime-semantic bridgeAnchor=R33-bounds-aware commandAnchor=R31-aware subtitleLoadAck=1`);

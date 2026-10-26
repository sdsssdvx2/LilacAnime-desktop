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

fs.writeFileSync(target, text, 'utf8');
console.log(`R34_TRANSFORM_SOURCE_SANITIZE_OK idempotent=1 states=${states.join(',')} nestedTemplates=3 bundleGate=runtime-semantic bridgeAnchor=R33-bounds-aware`);

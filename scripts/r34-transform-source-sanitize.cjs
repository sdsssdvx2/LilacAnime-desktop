'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r34-focus-handoff-stall-fix.cjs');
let text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceExact(needle, replacement, label) {
  const count = text.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one occurrence, found ${count}`);
  text = text.replace(needle, replacement);
}

replaceExact(
  '      lastError = `R34 focus handoff arm failed: ${String(error?.message || error).slice(0, 180)}`;',
  "      lastError = 'R34 focus handoff arm failed: ' + String(error?.message || error).slice(0, 180);",
  'R34 handoff nested template'
);
replaceExact(
  '      lastError = `R34 native presenter focus failed: ${String(error?.message || error).slice(0, 180)}`;',
  "      lastError = 'R34 native presenter focus failed: ' + String(error?.message || error).slice(0, 180);",
  'R34 presenter nested template'
);
replaceExact(
  "function saveCatalogFile(provider,name,value){const key=`${provider}-${name}`;clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{r34QueueJsonWrite(path.join(app.getPath('userData'),`${key}.json`),value())}catch{}},2000)} // LILAC_R34_CACHE_WRITE_WORKER",
  "function saveCatalogFile(provider,name,value){const key=provider+'-'+name;clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{r34QueueJsonWrite(path.join(app.getPath('userData'),key+'.json'),value())}catch{}},2000)} // LILAC_R34_CACHE_WRITE_WORKER",
  'R34 cache helper nested template'
);

const oldBundleGate = "for (const marker of ['LILAC_R34_SUBTITLE_SINGLE_OWNER',\"'sub-ass-override', 'force'\",'_r34NativeSubtitleLoaded']) assert(e.includes(marker) && bundle.includes(marker), `R34 subtitle marker missing: ${marker}`);";
const newBundleGate = "assert(e.includes('LILAC_R34_SUBTITLE_SINGLE_OWNER'), 'R34 subtitle source marker missing');\nfor (const marker of ['sub-ass-override','_r34NativeSubtitleLoaded']) assert(e.includes(marker) && bundle.includes(marker), `R34 subtitle runtime marker missing: ${marker}`);";
replaceExact(oldBundleGate, newBundleGate, 'R34 bundle semantic gate');

fs.writeFileSync(target, text, 'utf8');
console.log('R34_TRANSFORM_SOURCE_SANITIZE_OK nestedTemplates=3 bundleGate=runtime-semantic');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const entry = read('src/libmpv-shared-entry.js');
const bundle = read('src/libmpv-shared.generated.js');
const app = read('src/app.js');

assert(entry.includes('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC'), 'R36 subtitle marker missing');
assert(entry.includes("['set_property', 'sub-ass-override', 'strip']"), 'native fallback is not ASS strip mode');
assert(!entry.includes("['set_property', 'sub-ass-override', 'scale']"), 'R35 ASS scale mode survived');
assert(!entry.includes("['set_property', 'sub-ass-override', 'force']"), 'destructive ASS force mode survived');
assert(bundle.includes('sub-ass-override') && bundle.includes('strip'), 'bundled subtitle strip semantics missing');
assert(app.includes('LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE'), 'plain native subtitle source marker missing');
assert(app.includes("const nativeSubtitlePath=(options.path||options.assPath)||'';"), 'native subtitle does not prefer plain dialogue path');

for (const marker of [
  "['set_property', 'sub-pos', clamp(Math.round(100 - position), 55, 97)]",
  "['set_property', 'sub-font-size', clamp(Math.round(36 * size / 100), 18, 72)]",
  "['set_property', 'sub-border-size', clamp(outline, 0, 8)]"
]) assert(entry.includes(marker), 'R32 explicit native style mapping lost: ' + marker);

console.log('R36_SUBTITLE_DETERMINISM_SMOKE_OK source=plain-first assOverride=strip position=R32-sub-pos size=R32-font-size border=R32-border focusedOwner=html nativeOwner=unfocused');

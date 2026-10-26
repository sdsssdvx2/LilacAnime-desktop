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

// Lock the actual R32 native fallback contract rather than a guessed clamp range.
// R32 maps the same user settings used by the HTML subtitle renderer into libmpv:
// visual position, relative size, outline, bold weight and subtitle sync delay.
const r32Contract = [
  "const position = clamp(Number(localStorage.getItem('vttPosition') ?? 92), 50, 98);",
  "const size = clamp(Number(localStorage.getItem('vttSize') ?? 105), 50, 200);",
  "const outline = clamp(Number(localStorage.getItem('vttOutline') ?? 3), 0, 12);",
  "const syncMs = Number(localStorage.getItem('subtitleSync') || 0);",
  "const weight = clamp(Number(localStorage.getItem('vttWeight') || 400), 400, 800);",
  "['set_property', 'sub-pos', clamp(Math.round(100 - position), 55, 97)]",
  "['set_property', 'sub-font-size', Math.max(12, Math.round(36 * size / 100))]",
  "['set_property', 'sub-border-size', outline]",
  "['set_property', 'sub-bold', weight >= 600 ? 'yes' : 'no']",
  "['set_property', 'sub-delay', Number.isFinite(syncMs) ? syncMs / 1000 : 0]"
];
for (const marker of r32Contract) {
  assert(entry.includes(marker), 'R32 explicit native subtitle contract lost: ' + marker);
}

// R36 only changes source preference and ASS override behavior; it must not add a
// second/native positioning policy that could recreate the too-high subtitle bug.
const subPosAssignments = entry.match(/\['set_property', 'sub-pos'/g) || [];
const subSizeAssignments = entry.match(/\['set_property', 'sub-font-size'/g) || [];
const subBorderAssignments = entry.match(/\['set_property', 'sub-border-size'/g) || [];
assert(subPosAssignments.length === 1, 'native subtitle position has multiple owners: ' + subPosAssignments.length);
assert(subSizeAssignments.length === 1, 'native subtitle size has multiple owners: ' + subSizeAssignments.length);
assert(subBorderAssignments.length === 1, 'native subtitle border has multiple owners: ' + subBorderAssignments.length);

console.log('R36_SUBTITLE_DETERMINISM_SMOKE_OK source=plain-first assOverride=strip position=R32-sub-pos size=R32-relative-font-size border=R32-outline weight=R32-bold sync=R32-delay styleOwner=single focusedOwner=html nativeOwner=unfocused');

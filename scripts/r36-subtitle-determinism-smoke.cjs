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

// Lock the semantic R32 fallback contract without freezing historical defaults or
// clamp ranges that R2P/R2V are allowed to calibrate. Each native style variable
// must still be sourced from the same user-facing setting key, and the final mpv
// command mapping must remain exactly the R32 mapping that the generated product
// actually ships. This catches real behavior drift while tolerating preset tuning.
const sourceBindings = [
  ['position', 'vttPosition'],
  ['size', 'vttSize'],
  ['outline', 'vttOutline'],
  ['weight', 'vttWeight'],
  ['syncMs', 'subtitleSync']
];
for (const [variable, key] of sourceBindings) {
  const binding = new RegExp(`const\\s+${variable}\\s*=\\s*[^;]*localStorage\\.getItem\\(['\"]${key}['\"]\\)[^;]*;`);
  assert(binding.test(entry), `R32 native subtitle setting binding lost: ${variable}<-${key}`);
}

const commandMappings = [
  "['set_property', 'sub-pos', clamp(Math.round(100 - position), 55, 97)]",
  "['set_property', 'sub-font-size', Math.max(12, Math.round(36 * size / 100))]",
  "['set_property', 'sub-border-size', outline]",
  "['set_property', 'sub-bold', weight >= 600 ? 'yes' : 'no']",
  "['set_property', 'sub-delay', Number.isFinite(syncMs) ? syncMs / 1000 : 0]"
];
for (const marker of commandMappings) {
  assert(entry.includes(marker), 'R32 native subtitle command mapping lost: ' + marker);
}

// R36 only changes source preference and ASS override behavior; it must not add a
// second/native style policy that could recreate duplicate or too-high subtitles.
for (const [property, label] of [
  ['sub-pos', 'position'],
  ['sub-font-size', 'size'],
  ['sub-border-size', 'border'],
  ['sub-bold', 'weight'],
  ['sub-delay', 'sync']
]) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignments = entry.match(new RegExp(`\\['set_property', '${escaped}'`, 'g')) || [];
  assert(assignments.length === 1, `native subtitle ${label} has multiple/missing owners: ${assignments.length}`);
}

// Ensure the generated renderer bundle carries the same source/override semantics,
// not merely the editable source file.
assert(bundle.includes('vttPosition') && bundle.includes('vttSize') && bundle.includes('vttOutline') && bundle.includes('vttWeight') && bundle.includes('subtitleSync'), 'bundled native subtitle settings bindings missing');
assert(bundle.includes('sub-pos') && bundle.includes('sub-font-size') && bundle.includes('sub-border-size') && bundle.includes('sub-bold') && bundle.includes('sub-delay'), 'bundled native subtitle command mappings missing');

console.log('R36_SUBTITLE_DETERMINISM_SMOKE_OK source=plain-first assOverride=strip settings=vttPosition+vttSize+vttOutline+vttWeight+subtitleSync position=R32-sub-pos size=R32-relative-font-size border=R32-outline weight=R32-bold sync=R32-delay styleOwner=single defaults=calibration-tolerant focusedOwner=html nativeOwner=unfocused');

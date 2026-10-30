'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const controllerPath = path.join(root, 'electron', 'r40-subtitle-overlay-window.cjs');
let main = fs.readFileSync(mainPath, 'utf8').replace(/\r\n/g, '\n');
const controller = fs.readFileSync(controllerPath, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!main.includes('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY')) {
  throw new Error('R40 subtitle lifecycle hardening requires single-DOM transform first');
}
if (!controller.includes('LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY') || !controller.includes('async reconcileDeferred(')) {
  throw new Error('R40 subtitle lifecycle hardening requires deferred controller support');
}
if (main.includes('LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY')) {
  throw new Error('R40 subtitle lifecycle hardening already applied');
}

main = replaceOnce(
  main,
  `  win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'));\n  win.on('hide', () => r40SubtitleOverlay?.hide('owner-hidden'));`,
  `  win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'));\n  win.on('blur', () => { // LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY\n    Promise.resolve(r40SubtitleOverlay?.reconcileDeferred(win, 'owner-blur')).catch(() => {});\n  });\n  win.on('hide', () => r40SubtitleOverlay?.hide('owner-hidden'));`,
  'owner blur deferred subtitle replay'
);

for (const marker of [
  'LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY',
  "reconcileDeferred(win, 'owner-blur')",
  "win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'))"
]) {
  if (!main.includes(marker)) throw new Error(`R40 subtitle lifecycle marker missing: ${marker}`);
}

fs.writeFileSync(mainPath, main, 'utf8');
console.log('R40_SUBTITLE_CONTROLLER_LIFECYCLE_HARDENING_OK deferred=focused-active-payload replay=real-owner-blur once=controller-owned polling=none');

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'mpv-native-entry.js');
let source = fs.readFileSync(entry, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

if (!source.includes('LILAC_MPV_LAYOUT_FIX_D2')) {
  replaceOnce(
    "  style.textContent = `\n",
    "  style.textContent = `\n    /* LILAC_MPV_LAYOUT_FIX_D2: the custom element replaced <video>, so it must inherit the original full-screen video geometry. */\n    body.player-mode #videoStage {\n      position: absolute !important;\n      inset: 0 !important;\n      width: 100% !important;\n      height: 100% !important;\n    }\n    body.player-mode #videoStage > lilac-mpv-video#video {\n      position: absolute !important;\n      inset: 0 !important;\n      display: block !important;\n      width: 100% !important;\n      height: 100% !important;\n      min-width: 100% !important;\n      min-height: 100% !important;\n      background: #000 !important;\n    }\n",
    'full-size hosted video CSS'
  );

  replaceOnce(
    "    const rect = this.getBoundingClientRect();\n    const holes = [];",
    "    const ownRect = this.getBoundingClientRect();\n    const stageRect = document.querySelector('#videoStage')?.getBoundingClientRect?.();\n    const rect = ownRect.width > 1 && ownRect.height > 1\n      ? ownRect\n      : (stageRect && stageRect.width > 1 && stageRect.height > 1 ? stageRect : ownRect);\n    const holes = [];",
    'host bounds fallback to video stage'
  );
}

fs.writeFileSync(entry, source);

buildSync({
  entryPoints: [entry],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

const generated = fs.readFileSync(path.join(root, 'src', 'mpv-native.generated.js'), 'utf8');
for (const marker of ['LILAC_MPV_LAYOUT_FIX_D2', "querySelector(\"#videoStage\")"]) {
  if (!generated.includes(marker)) throw new Error(`layout fix marker missing: ${marker}`);
}

console.log('V11D2 hosted mpv layout fix applied: full-size custom video + videoStage bounds fallback.');

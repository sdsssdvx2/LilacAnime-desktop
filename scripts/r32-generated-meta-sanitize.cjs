'use strict';

const fs = require('node:fs');
const target = process.argv[2];
if (!target) throw new Error('generated meta path required');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

// The native rebuild replacement is itself a single-quoted PowerShell here-string.
// Its embedded JS smoke must therefore use the opposite here-string delimiter.
const smokeAt = source.indexOf("$presenterSmoke = Join-Path $temp 'r32-native-presenter-smoke.cjs'");
if (smokeAt < 0) throw new Error('presenter smoke block missing');
const openAt = source.indexOf("\n@'\n", smokeAt);
const closeAt = source.indexOf("\n'@ | Set-Content $presenterSmoke -Encoding utf8", openAt + 4);
if (openAt < 0 || closeAt < 0) throw new Error('presenter smoke here-string delimiters missing');
source = source.slice(0, openAt) + '\n@"\n' + source.slice(openAt + 4, closeAt) + '\n"@ | Set-Content $presenterSmoke -Encoding utf8' + source.slice(closeAt + "\n'@ | Set-Content $presenterSmoke -Encoding utf8".length);

// Restore and execute a real worker_threads RPC smoke after the R32 transform.
replaceOnce(
  "  'scripts/r32-flix-worker-native-focus-fix.cjs'\n)) {",
  "  'scripts/r32-flix-worker-native-focus-fix.cjs',\n  'scripts/r32-flix-worker-smoke.cjs'\n)) {",
  'support worker smoke'
);
replaceOnce(
  "'r31-focus-compositor-state-coalesce-fix.cjs','r32-flix-worker-native-focus-fix.cjs')) {",
  "'r31-focus-compositor-state-coalesce-fix.cjs','r32-flix-worker-native-focus-fix.cjs','r32-flix-worker-smoke.cjs')) {",
  'restore worker smoke'
);
replaceOnce(
  "node scripts/r32-flix-worker-native-focus-fix.cjs\nAssert-Exit 'R32 focus/stutter patch'",
  "node scripts/r32-flix-worker-native-focus-fix.cjs\nAssert-Exit 'R32 focus/stutter patch'\nnode scripts/r32-flix-worker-smoke.cjs\nAssert-Exit 'R32 Flix worker RPC smoke'",
  'run worker smoke'
);

// Do not make the packaged gate depend on esbuild retaining dead R31 Canvas2D
// helper symbols after R32 has deliberately disabled that path.
replaceOnce(
  "if ($shipPreload -notmatch 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD' -or $shipPreload -notmatch 'data-lilac-libmpv-focus-shield' -or $shipPreload -notmatch 'r31DrawFocusShield') { throw 'packaged R31 focus shield source missing' }\nif ($shipPreload -notmatch 'const r31UseFocusShield = false' -or $shipPreload -notmatch 'R32_NATIVE_HWND_FOCUS_SURFACE') { throw 'packaged R32 native focus routing missing' }",
  "if ($shipPreload -notmatch 'R32_NATIVE_HWND_FOCUS_SURFACE' -or $shipPreload -notmatch 'direct-receive-webgpu-copy') { throw 'packaged R32 native focus routing/direct focused presenter missing' }",
  'package shield gate'
);

fs.writeFileSync(target, source, 'utf8');
console.log('R32_GENERATED_META_SANITIZE_OK hereString=opposite-delimiter flixSmoke=enabled packageGate=r32-only');

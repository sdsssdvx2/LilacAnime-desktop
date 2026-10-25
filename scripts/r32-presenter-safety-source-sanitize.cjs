'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r32-presenter-bounds-subtitle-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function once(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  source = source.replace(needle, replacement);
}

once(
  'Int32Value(env, player->nativePresenterX)',
  'DoubleValue(env, static_cast<double>(player->nativePresenterX))',
  'signed presenter x diagnostic'
);
once(
  'Int32Value(env, player->nativePresenterY)',
  'DoubleValue(env, static_cast<double>(player->nativePresenterY))',
  'signed presenter y diagnostic'
);

const oldResize = `const resizeStart = bridge.indexOf('  function resize(value = {}) {');\nconst resizeEnd = bridge.indexOf('\\n  }', resizeStart);\nif (resizeStart < 0 || resizeEnd <= resizeStart) throw new Error('R32 resize function missing');\nconst resizeSlice = bridge.slice(resizeStart, resizeEnd + 4);\nif (!resizeSlice.includes('const size = setTargetSize(value);')) throw new Error('R32 resize size update missing');\nconst resizedSlice = resizeSlice.replace('    const size = setTargetSize(value);', '    const size = setTargetSize(value);\\n    r32SyncNativePresenterBounds();');\nbridge = bridge.slice(0, resizeStart) + resizedSlice + bridge.slice(resizeEnd + 4);`;
const newResize = `bridge = replaceOnce(\n  bridge,\n  \`  function resize(value = {}) {\\n    const size = setTargetSize(value);\`,\n  \`  function resize(value = {}) {\\n    const size = setTargetSize(value);\\n    r32SyncNativePresenterBounds();\`,\n  'sync native presenter bounds on resize'\n);`;
once(oldResize, newResize, 'structural resize patch');

// R31 can legitimately add fields inside _surfaceSize(), so never require the
// whole pre-R31 method text. Rewrite the complete method by structural boundaries.
const surfacePatchStart = source.indexOf("entry = replaceOnce(\n  entry,\n  `  _surfaceSize() {");
const surfacePatchEnd = source.indexOf("\n\nconst loadTrackAt", surfacePatchStart);
if (surfacePatchStart < 0 || surfacePatchEnd <= surfacePatchStart) throw new Error('surface patch source block not found');
const structuralSurfacePatch = String.raw`const surfaceStart = entry.indexOf('  _surfaceSize() {');
const surfaceEnd = entry.indexOf('\n\n  _queueSurfaceResize()', surfaceStart);
if (surfaceStart < 0 || surfaceEnd <= surfaceStart) throw new Error('R32 renderer _surfaceSize method boundary missing');
const surfaceSection = entry.slice(surfaceStart, surfaceEnd);
for (const marker of ['getBoundingClientRect()', 'devicePixelRatio', 'rect.width', 'rect.height']) {
  if (!surfaceSection.includes(marker)) throw new Error('R32 renderer _surfaceSize baseline missing: ' + marker);
}
const r32SurfaceMethod = [
  "  _surfaceSize() {",
  "    const rect = this.getBoundingClientRect();",
  "    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);",
  "    return {",
  "      x: Math.round(rect.left * dpr),",
  "      y: Math.round(rect.top * dpr),",
  "      width: clamp(Math.round(Math.max(2, rect.width) * dpr), 2, 3840),",
  "      height: clamp(Math.round(Math.max(2, rect.height) * dpr), 2, 2160),",
  "      visible: this.isConnected && rect.width > 1 && rect.height > 1",
  "    };",
  "  }"
].join('\n');
entry = entry.slice(0, surfaceStart) + r32SurfaceMethod + entry.slice(surfaceEnd);`;
source = source.slice(0, surfacePatchStart) + structuralSurfacePatch + source.slice(surfacePatchEnd);

const oldGate = `for (const marker of ['LILAC_R32_NATIVE_SUBTITLE_FALLBACK','dataset.lilacNativePath','sub-add','sub-visibility','rect.left * dpr','rect.top * dpr']) {\n  if (!finalEntry.includes(marker) || (marker !== 'dataset.lilacNativePath' && marker !== 'sub-add' && marker !== 'sub-visibility' && !finalBundle.includes(marker))) {\n    throw new Error(\`R32 renderer fallback marker missing: \${marker}\`);\n  }\n}`;
const newGate = `for (const marker of ['LILAC_R32_NATIVE_SUBTITLE_FALLBACK','dataset.lilacNativePath','sub-add','sub-visibility','rect.left * dpr','rect.top * dpr']) {\n  if (!finalEntry.includes(marker)) throw new Error(\`R32 renderer fallback source marker missing: \${marker}\`);\n}\nfor (const marker of ['sub-add','sub-visibility']) {\n  if (!finalBundle.includes(marker)) throw new Error(\`R32 renderer fallback bundle marker missing: \${marker}\`);\n}\nif (!finalBundle.includes('.left *') || !finalBundle.includes('.top *')) throw new Error('R32 physical video rectangle missing from renderer bundle');`;
once(oldGate, newGate, 'bundle marker gate');

fs.writeFileSync(target, source);
console.log('R32_PRESENTER_SAFETY_SOURCE_SANITIZE_OK signedXY=double resize=structural surface=method-boundary syntax=no-raw-template bundleGate=runtime-code');

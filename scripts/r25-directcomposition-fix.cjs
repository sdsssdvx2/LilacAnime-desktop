'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let main = read('electron/main.cjs');

// R24 ruled out shared-texture delivery fan-out: user hardware showed
// deliveryMaxInFlight=1 and max sendSharedTexture ~=23 ms, while the renderer
// still recorded a ~296 ms receive/present gap and black flashing whenever the
// Lilac window lost focus. Keep the qualified R3E native producer, Electron 44
// sharedTexture transport and direct WebGPU presenter untouched. A current
// Chromium/Windows regression report shows presentation freezes on the default
// DirectComposition path while another window is interacted with, eliminated by
// --disable-direct-composition. This R25 build is an intentionally minimal A/B.
assert(main.includes('LILAC_R24_INACTIVE_COMPOSITOR_GUARD'), 'R25 requires R24 inactive compositor baseline');
assert(main.includes("app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');"), 'R24 occlusion guard missing');
assert(!main.includes('LILAC_R25_DISABLE_DIRECT_COMPOSITION'), 'R25 DirectComposition guard already applied');

main = replaceOnce(
  main,
  "app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');",
  `app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');\n// LILAC_R25_DISABLE_DIRECT_COMPOSITION: Windows focus/occlusion A/B. This does\n// not disable GPU acceleration, D3D11 decoding, Electron sharedTexture, or WebGPU;\n// it only bypasses Chromium's Windows DirectComposition presentation surface.\napp.commandLine.appendSwitch('disable-direct-composition');`,
  'disable DirectComposition after R24 occlusion guard'
);

for (const marker of [
  'LILAC_R24_INACTIVE_COMPOSITOR_GUARD',
  'LILAC_R25_DISABLE_DIRECT_COMPOSITION',
  "appendSwitch('disable-direct-composition')",
  "appendSwitch('disable-backgrounding-occluded-windows')",
  "CalculateNativeWinOcclusion"
]) assert(main.includes(marker), `R25 main marker missing: ${marker}`);

write('electron/main.cjs', main);
console.log('R25_DIRECTCOMPOSITION_OK directComposition=disabled gpuAcceleration=preserved nativeProducer=unchanged sharedTexture=unchanged webgpu=unchanged');

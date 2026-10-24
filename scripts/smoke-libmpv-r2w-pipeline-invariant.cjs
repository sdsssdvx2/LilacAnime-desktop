'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const transform = read('scripts/apply-libmpv-r2w-aspect-cadence.cjs');
const preload = read('electron/libmpv-shared-preload.cjs');
const bridge = read('electron/libmpv-shared-main.cjs');

for (const forbidden of [
  'native/libmpv-d3d11-bridge',
  'lilac-libmpv-player-bridge.node',
  'libmpv-2.dll',
  'player_addon.cc',
  'binding.gyp'
]) {
  assert.equal(transform.includes(forbidden), false, `R2W transform touches native payload marker: ${forbidden}`);
}
for (const marker of [
  "rendererMode = 'webgpu-copy'",
  'copyExternalImageToTexture',
  'presentedFrames += 1;',
  'observePresentationCadence(metadata);'
]) assert.ok(preload.includes(marker), `qualified WebGPU path marker missing after R2W: ${marker}`);
for (const forbidden of ['await requestAnimationFrame', 'await nextFrame', "getContext('2d'"]) {
  assert.equal(preload.includes(forbidden), false, `R2W changed qualified frame lifetime/renderer: ${forbidden}`);
}
assert.ok(bridge.includes('fps: Number(lastState?.fps) || 0'), 'source fps is not forwarded as scalar diagnostic metadata');
assert.ok(bridge.includes('displayFrequency: Number(displayState.frequency) || 0'), 'display refresh is not forwarded as scalar diagnostic metadata');
console.log('LIBMPV_R2W_PIPELINE_INVARIANT_OK nativePayload=untouched frameLifetime=immediate renderer=webgpu-copy');

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const transform = fs.readFileSync(path.join(root, 'scripts', 'apply-libmpv-r2p-subtitle-ui.cjs'), 'utf8');
const entry = fs.readFileSync(path.join(root, 'src', 'libmpv-shared-entry.js'), 'utf8');

const forbiddenFiles = [
  'electron/libmpv-shared-main.cjs',
  'electron/libmpv-shared-preload.cjs',
  'electron/lilac-libmpv-player-bridge.node',
  'electron/libmpv-2.dll'
];
for (const relative of forbiddenFiles) {
  for (const prefix of [`write('${relative}'`, `write("${relative}"`, `read('${relative}'`, `read("${relative}"`]) {
    if (transform.includes(prefix)) throw new Error(`R2P transform touches playback pipeline file: ${relative}`);
  }
}
for (const forbidden of ['getImageData(', 'toDataURL(', 'readPixels(', 'mapAsync(', 'copyTextureToBuffer(', 'drawImage(']) {
  if (transform.includes(forbidden)) throw new Error(`R2P transform introduces frame/pixel operation: ${forbidden}`);
}
for (const required of ['copyExternalImageToTexture', 'data-lilac-libmpv-surface', 'refreshSubtitleOverlay()']) {
  if (!entry.includes(required)) throw new Error(`qualified renderer marker missing: ${required}`);
}
console.log('R2P_PLAYBACK_PIPELINE_UNTOUCHED_OK nativeFiles=0 frameOps=0 gpuCopy=preserved');

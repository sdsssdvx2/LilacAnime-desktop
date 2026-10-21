'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'electron', 'libmpv-shared-preload.cjs');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `let maxDrawMs = 0;\n`,
  `let maxDrawMs = 0;\n\nconst nextCompositorTurn = () => new Promise(resolve => requestAnimationFrame(resolve));\n`,
  'compositor turn helper'
);

replaceOnce(
  `  sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }, metadata = {}) => {`,
  `  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata = {}) => {`,
  'async receiver lifetime'
);

replaceOnce(
  `      // drawImage(VideoFrame) queues the GPU-backed copy. Chromium owns the GPU\n      // lifetime after this call, so holding all three imported textures across\n      // extra animation frames only starves the producer.\n      presentedFrames += 1;`,
  `      // Local Windows shared-texture probing proved that closing the VideoFrame\n      // immediately after drawImage can leave a stale frame. Keep the producer\n      // texture alive for two compositor turns, as the proven-safe path did.\n      // R2C expands the native pool to 24 slots, so this lifetime no longer\n      // starves a 23.976/30/60fps producer the way the old three-slot pool did.\n      await nextCompositorTurn();\n      await nextCompositorTurn();\n      presentedFrames += 1;`,
  'proven compositor lifetime'
);

fs.writeFileSync(target, source);

const check = fs.readFileSync(target, 'utf8');
for (const marker of [
  'nextCompositorTurn',
  'sharedTexture.setSharedTextureReceiver(async',
  'await nextCompositorTurn();\n      await nextCompositorTurn();',
  'R2C expands the native pool to 24 slots'
]) {
  if (!check.includes(marker)) throw new Error(`R2D marker missing: ${marker}`);
}

console.log('LIBMPV_R2D_SAFE_FRAME_LIFETIME_OK compositorTurns=2 pool=24');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  '  std::array<TextureSlot, 3> slots;\n',
  '  static constexpr size_t kSharedTextureSlots = 24;\n  std::array<TextureSlot, kSharedTextureSlots> slots;\n',
  'shared texture slot pool'
);

replaceOnce(
  '    {"audio-display", "no"},\n    {"vo", "libmpv"},',
  '    {"audio-display", "no"},\n    {"sid", "no"},\n    {"sub-auto", "no"},\n    {"vo", "libmpv"},',
  'native subtitle disable options'
);

replaceOnce(
  '  Set(env, out, "backpressureDrops", DoubleValue(env, static_cast<double>(player->droppedForBackpressure)));\n',
  '  Set(env, out, "backpressureDrops", DoubleValue(env, static_cast<double>(player->droppedForBackpressure)));\n  uint32_t inFlightSlots = 0;\n  for (const auto& slot : player->slots) if (slot.inFlight) inFlightSlots += 1;\n  Set(env, out, "textureSlotCount", Uint32Value(env, static_cast<uint32_t>(player->slots.size())));\n  Set(env, out, "textureSlotsInFlight", Uint32Value(env, inFlightSlots));\n',
  'shared texture slot diagnostics'
);

fs.writeFileSync(target, source);

const check = fs.readFileSync(target, 'utf8');
for (const marker of [
  'kSharedTextureSlots = 24',
  '{"sid", "no"}',
  '{"sub-auto", "no"}',
  'textureSlotCount',
  'textureSlotsInFlight'
]) {
  if (!check.includes(marker)) throw new Error(`R2C marker missing: ${marker}`);
}
if (check.includes('std::array<TextureSlot, 3>')) throw new Error('legacy three-slot texture pool remains');

console.log('LIBMPV_R2C_TEXTURE_POOL_OK slots=24 nativeSubtitles=disabled');

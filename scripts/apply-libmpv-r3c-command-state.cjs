'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('napi_value PollPlayback')) throw new Error('R3C command-state fix requires PollPlayback');

const needle = `  SetMaybeFlag(env, out, "paused", player, "pause");\n  SetMaybeFlag(env, out, "pausedForCache", player, "paused-for-cache");\n  return out;\n}\n\nnapi_value Poll(`;
const replacement = `  SetMaybeFlag(env, out, "paused", player, "pause");\n  SetMaybeFlag(env, out, "pausedForCache", player, "paused-for-cache");\n  // Preserve the public bridge state contract for command readback without\n  // reintroducing codec/track/cache diagnostics into the 250ms hot poll.\n  SetMaybeDouble(env, out, "volume", player, "volume");\n  SetMaybeDouble(env, out, "speed", player, "speed");\n  SetMaybeFlag(env, out, "mute", player, "mute");\n  return out;\n}\n\nnapi_value Poll(`;
const count = source.split(needle).length - 1;
if (count !== 1) throw new Error(`PollPlayback scalar anchor count=${count}`);
source = source.replace(needle, replacement);

const playbackStart = source.indexOf('napi_value PollPlayback');
const fullPollStart = source.indexOf('napi_value Poll(', playbackStart + 1);
const playbackBody = source.slice(playbackStart, fullPollStart);
for (const marker of [
  'SetMaybeDouble(env, out, "volume", player, "volume")',
  'SetMaybeDouble(env, out, "speed", player, "speed")',
  'SetMaybeFlag(env, out, "mute", player, "mute")'
]) {
  if (!playbackBody.includes(marker)) throw new Error(`command-state marker missing: ${marker}`);
}
for (const heavy of ['videoCodec', 'audioCodec', 'tracks', 'demuxerCacheDuration', 'hwdecCurrent']) {
  if (playbackBody.includes(heavy)) throw new Error(`heavy diagnostic leaked into PollPlayback: ${heavy}`);
}

fs.writeFileSync(target, source);
console.log('LIBMPV_R3C_COMMAND_STATE_OK playbackPoll=timing+volume+speed+mute heavyDiagnostics=full-only');

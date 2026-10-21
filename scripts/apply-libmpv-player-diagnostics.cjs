'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8');

const anchor = `  SetMaybeString(env, out, "vid", player, "vid");\n  SetMaybeString(env, out, "aid", player, "aid");\n  SetMaybeString(env, out, "hwdecCurrent", player, "hwdec-current");\n  return out;`;

const replacement = `  SetMaybeString(env, out, "vid", player, "vid");\n  SetMaybeString(env, out, "aid", player, "aid");\n  SetMaybeString(env, out, "hwdecCurrent", player, "hwdec-current");\n\n  // Safe scalar playback diagnostics only. Never expose filenames, URLs, headers,\n  // structured track enumeration, command lines, or other potentially sensitive values.\n  SetMaybeInt64(env, out, "voDropFrameCount", player, "vo-drop-frame-count");\n  SetMaybeInt64(env, out, "decoderFrameDropCount", player, "decoder-frame-drop-count");\n  SetMaybeInt64(env, out, "mistimedFrameCount", player, "mistimed-frame-count");\n  SetMaybeDouble(env, out, "estimatedVfFps", player, "estimated-vf-fps");\n  SetMaybeDouble(env, out, "displayFps", player, "display-fps");\n  SetMaybeDouble(env, out, "demuxerCacheDuration", player, "demuxer-cache-duration");\n  SetMaybeInt64(env, out, "cacheBufferingState", player, "cache-buffering-state");\n  SetMaybeInt64(env, out, "cacheSpeed", player, "cache-speed");\n  SetMaybeString(env, out, "currentVo", player, "current-vo");\n  SetMaybeString(env, out, "currentAo", player, "current-ao");\n  SetMaybeString(env, out, "audioDevice", player, "audio-device");\n  SetMaybeDouble(env, out, "volume", player, "volume");\n  SetMaybeFlag(env, out, "mute", player, "mute");\n  return out;`;

const occurrences = source.split(anchor).length - 1;
if (occurrences !== 1) throw new Error(`libmpv player diagnostics anchor expected once, found ${occurrences}`);
source = source.replace(anchor, replacement);
fs.writeFileSync(target, source);

for (const marker of [
  'voDropFrameCount',
  'mistimedFrameCount',
  'estimatedVfFps',
  'demuxerCacheDuration',
  'currentVo',
  'currentAo',
  'audioDevice'
]) {
  if (!source.includes(marker)) throw new Error(`libmpv player diagnostic marker missing: ${marker}`);
}
if (source.includes('"track-list"')) throw new Error('unsafe track enumeration property must not be added');
console.log('LIBMPV_PLAYER_DIAGNOSTICS_PATCH_OK');

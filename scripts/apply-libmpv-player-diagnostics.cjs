'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8');

if (source.includes('"voDropFrameCount"')) {
  throw new Error('libmpv player diagnostics already applied');
}

const anchor = /^(\s*)SetMaybeString\(env, out, "hwdecCurrent", player, "hwdec-current"\);\r?$/gm;
const matches = [...source.matchAll(anchor)];
if (matches.length !== 1) {
  throw new Error(`libmpv player diagnostics anchor expected once, found ${matches.length}`);
}

const indent = matches[0][1];
const metrics = [
  '',
  `${indent}// Safe scalar playback diagnostics only. Never expose filenames, URLs, headers,`,
  `${indent}// structured track enumeration, command lines, or other potentially sensitive values.`,
  `${indent}SetMaybeInt64(env, out, "voDropFrameCount", player, "vo-drop-frame-count");`,
  `${indent}SetMaybeInt64(env, out, "decoderFrameDropCount", player, "decoder-frame-drop-count");`,
  `${indent}SetMaybeInt64(env, out, "mistimedFrameCount", player, "mistimed-frame-count");`,
  `${indent}SetMaybeDouble(env, out, "estimatedVfFps", player, "estimated-vf-fps");`,
  `${indent}SetMaybeDouble(env, out, "displayFps", player, "display-fps");`,
  `${indent}SetMaybeDouble(env, out, "demuxerCacheDuration", player, "demuxer-cache-duration");`,
  `${indent}SetMaybeInt64(env, out, "cacheBufferingState", player, "cache-buffering-state");`,
  `${indent}SetMaybeInt64(env, out, "cacheSpeed", player, "cache-speed");`,
  `${indent}SetMaybeString(env, out, "currentVo", player, "current-vo");`,
  `${indent}SetMaybeString(env, out, "currentAo", player, "current-ao");`,
  `${indent}SetMaybeString(env, out, "audioDevice", player, "audio-device");`,
  `${indent}SetMaybeDouble(env, out, "volume", player, "volume");`,
  `${indent}SetMaybeFlag(env, out, "mute", player, "mute");`
].join('\n');

source = source.replace(anchor, match => `${match}${metrics}`);
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

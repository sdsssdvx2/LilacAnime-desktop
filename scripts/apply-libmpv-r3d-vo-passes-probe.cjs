'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const pollSignature = 'napi_value Poll(napi_env env, napi_callback_info info) {';
const pollStart = source.indexOf(pollSignature);
if (pollStart < 0) throw new Error('full Poll function missing');
const nextFunction = source.indexOf('\nnapi_value ', pollStart + pollSignature.length);
if (nextFunction < 0) throw new Error('could not bound full Poll function');
let poll = source.slice(pollStart, nextFunction);
const returnAnchor = '  return out;\n}';
if ((poll.split(returnAnchor).length - 1) !== 1) {
  throw new Error(`full Poll return anchor ambiguous: ${poll.split(returnAnchor).length - 1}`);
}

const probe = `  int64_t freshCount = 0;\n  napi_value freshPasses;\n  napi_create_array(env, &freshPasses);\n  if (GetInt64Property(player, "vo-passes/fresh/count", &freshCount)) {\n    Set(env, out, "voFreshCount", DoubleValue(env, static_cast<double>(freshCount)));\n    const int64_t limit = freshCount < 16 ? freshCount : 16;\n    for (int64_t i = 0; i < limit; i += 1) {\n      const std::string base = "vo-passes/fresh/" + std::to_string(i) + "/";\n      napi_value pass;\n      napi_create_object(env, &pass);\n      SetMaybeString(env, pass, "desc", player, (base + "desc").c_str());\n      SetMaybeInt64(env, pass, "lastNs", player, (base + "last").c_str());\n      SetMaybeInt64(env, pass, "avgNs", player, (base + "avg").c_str());\n      SetMaybeInt64(env, pass, "peakNs", player, (base + "peak").c_str());\n      napi_set_element(env, freshPasses, static_cast<uint32_t>(i), pass);\n    }\n  } else {\n    Set(env, out, "voFreshCount", NullValue(env));\n  }\n  Set(env, out, "voFreshPasses", freshPasses);\n`;

poll = poll.replace(returnAnchor, `${probe}${returnAnchor}`);
source = source.slice(0, pollStart) + poll + source.slice(nextFunction);

for (const marker of ['napi_value Poll(', 'vo-passes/fresh/count', 'voFreshPasses', 'lastNs', 'avgNs', 'peakNs']) {
  if (!source.includes(marker)) throw new Error(`vo-passes probe marker missing: ${marker}`);
}
const playbackStart = source.indexOf('napi_value PollPlayback(');
if (playbackStart >= 0) {
  const playbackNext = source.indexOf('\nnapi_value ', playbackStart + 1);
  const playback = source.slice(playbackStart, playbackNext > 0 ? playbackNext : undefined);
  if (playback.includes('voFreshPasses')) throw new Error('probe leaked into lightweight PollPlayback');
}

fs.writeFileSync(target, source);
console.log('LIBMPV_R3D_VO_PASSES_PROBE_OK target=full-Poll type=fresh maxPasses=16 fields=desc,last,avg,peak');

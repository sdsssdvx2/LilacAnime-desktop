'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const bridgePath = path.join(root, 'electron', 'mpv-native-main.cjs');
const entryPath = path.join(root, 'src', 'mpv-native-entry.js');
let bridge = fs.readFileSync(bridgePath, 'utf8');
let entry = fs.readFileSync(entryPath, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D2';")) {
  throw new Error('V13D3 expects the V13D2 renderer transform first');
}
if (!bridge.includes("route = 'local-bypass'")) {
  throw new Error('V13D3 local-bypass bridge anchor missing');
}

// Record only a coarse source class. Never expose the loopback port/path/session,
// upstream URL, headers, cookies, tokens, or the full mpv command line.
bridge = replaceOnce(
  bridge,
  "  let suppliedHeaderCount = 0;\n  let lastPid = null;",
  "  let suppliedHeaderCount = 0;\n  let localSourceKind = 'unknown';\n  let lastRecovery = { armed: false, attempted: false, commandOk: null, trigger: null, outcome: null };\n  let lastPid = null;",
  'V13D3 diagnostic state variables'
);

bridge = replaceOnce(
  bridge,
  "    if (parsed.protocol === 'file:') { route = 'file-bypass'; return { url: parsed.href, relayed: false }; }\n    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') { route = 'local-bypass'; return { url: parsed.href, relayed: false }; }\n    if (parsed.protocol !== 'https:') throw new Error(`native mpv rejected protocol: ${parsed.protocol}`);\n    const effective = typeof headersFor === 'function' ? headersFor(parsed, suppliedHeaders || {}) : suppliedHeaders || {};\n    route = 'relay';",
  "    if (parsed.protocol === 'file:') { localSourceKind = 'file'; route = 'file-bypass'; return { url: parsed.href, relayed: false }; }\n    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {\n      localSourceKind = parsed.pathname.startsWith('/__flix/') ? 'flix-loopback' : 'other-loopback';\n      route = 'local-bypass';\n      return { url: parsed.href, relayed: false };\n    }\n    if (parsed.protocol !== 'https:') throw new Error(`native mpv rejected protocol: ${parsed.protocol}`);\n    const effective = typeof headersFor === 'function' ? headersFor(parsed, suppliedHeaders || {}) : suppliedHeaders || {};\n    localSourceKind = 'remote-relay';\n    route = 'relay';",
  'V13D3 safe source classification'
);

// Query mpv's load lifecycle without asking for path/URL properties. idle-active is
// decisive here: true after a failed load means mpv accepted loadfile, then returned
// to idle without opening media. file-format/network flags are safe metadata only.
bridge = replaceOnce(
  bridge,
  "        ['get_property', 'container-fps'],['get_property', 'vid'],['get_property', 'aid'],['get_property', 'mute']\n      ], 700);",
  "        ['get_property', 'container-fps'],['get_property', 'vid'],['get_property', 'aid'],['get_property', 'mute'],\n        ['get_property', 'idle-active'],['get_property', 'playlist-count'],['get_property', 'playlist-pos'],\n        ['get_property', 'file-format'],['get_property', 'demuxer-via-network']\n      ], 700);",
  'V13D3 state query expansion'
);

bridge = replaceOnce(
  bridge,
  "      const numeric = index => { const number = Number(value(index)); return Number.isFinite(number) ? number : null; };",
  "      const numeric = index => { const raw = value(index); if (raw == null || raw === '') return null; const number = Number(raw); return Number.isFinite(number) ? number : null; };\n      const boolean = index => typeof value(index) === 'boolean' ? value(index) : null;",
  'V13D3 preserve unavailable state properties'
);

bridge = replaceOnce(
  bridge,
  "        time: numeric(0), duration: numeric(1), paused: Boolean(value(2)), volume: numeric(3),",
  "        time: numeric(0), duration: numeric(1), paused: boolean(2), volume: numeric(3),",
  'V13D3 preserve unavailable pause state'
);

bridge = replaceOnce(
  bridge,
  "        fps: numeric(7), vid: value(8), aid: value(9), muted: Boolean(value(10))\n      };",
  "        fps: numeric(7), vid: value(8), aid: value(9), muted: boolean(10),\n        idleActive: typeof value(11) === 'boolean' ? value(11) : null,\n        playlistCount: numeric(12), playlistPos: numeric(13),\n        fileFormat: typeof value(14) === 'string' ? value(14) : null,\n        networkDemux: typeof value(15) === 'boolean' ? value(15) : null\n      };",
  'V13D3 state result expansion'
);

bridge = replaceOnce(
  bridge,
  "      return { active: true, pid: lastPid, route, hostMode, time: null, duration: null, paused: null, width: null, height: null, codec: null, fps: null, muted: null };",
  "      return { active: true, pid: lastPid, route, hostMode, time: null, duration: null, paused: null, width: null, height: null, codec: null, fps: null, muted: null, idleActive: null, playlistCount: null, playlistPos: null, fileFormat: null, networkDemux: null };",
  'V13D3 state error result'
);

// One narrowly-scoped recovery: only the already-resolved ReAnime/Flix loopback
// path, only once, and only when mpv itself reports that it has returned to idle
// with no decoded media. A slow/still-loading source is never interrupted.
const recoveryRuntime = String.raw`
  function mediaReady(stateValue) {
    return Number(stateValue?.duration) > 0 || Number(stateValue?.width) > 0 || Number(stateValue?.height) > 0 || Boolean(stateValue?.codec) || Boolean(stateValue?.fileFormat);
  }

  function armLoopbackRecovery(prepared, expectedGeneration) {
    const armed = localSourceKind === 'flix-loopback';
    lastRecovery = { armed, attempted: false, commandOk: null, trigger: null, outcome: armed ? 'waiting' : 'not-applicable' };
    if (!armed) return;
    const timer = setTimeout(async () => {
      if (disposed || generation !== expectedGeneration || !child || child.exitCode != null || !pipeName) {
        lastRecovery = { ...lastRecovery, outcome: 'cancelled' };
        return;
      }
      const before = await state().catch(() => null);
      if (!before?.active) {
        lastRecovery = { ...lastRecovery, outcome: 'inactive' };
        return;
      }
      if (mediaReady(before)) {
        lastRecovery = { ...lastRecovery, outcome: 'media-ready' };
        return;
      }
      if (before.idleActive !== true) {
        lastRecovery = { ...lastRecovery, outcome: 'still-loading' };
        return;
      }
      lastRecovery = { armed: true, attempted: true, commandOk: false, trigger: 'idle-no-media', outcome: 'reload-sent' };
      try {
        const [reply] = await connectAndBatch([['loadfile', prepared.url, 'replace']], 2500);
        const commandOk = reply?.error === 'success';
        lastRecovery = { ...lastRecovery, commandOk, outcome: commandOk ? 'reload-accepted' : 'reload-rejected' };
        if (commandOk) await connectAndBatch([['set_property', 'pause', false]], 900).catch(() => {});
      } catch {
        lastRecovery = { ...lastRecovery, commandOk: false, outcome: 'reload-ipc-error' };
      }
    }, 6500);
    timer.unref?.();
  }
`;
bridge = replaceOnce(
  bridge,
  "  async function openPlayer(mediaUrl, suppliedHeaders, hls, bounds) {",
  recoveryRuntime + "\n  async function openPlayer(mediaUrl, suppliedHeaders, hls, bounds) {",
  'V13D3 recovery runtime'
);

bridge = replaceOnce(
  bridge,
  "      await connectAndBatch([['set_property', 'pause', false]], 900).catch(() => {});\n      syncOverlayBounds(lastRelativeBounds.visible);",
  "      await connectAndBatch([['set_property', 'pause', false]], 900).catch(() => {});\n      armLoopbackRecovery(prepared, myGeneration);\n      syncOverlayBounds(lastRelativeBounds.visible);",
  'V13D3 recovery arming'
);

bridge = replaceOnce(
  bridge,
  "    return { ok: true, pid: lastPid, route, relayed: Boolean(prepared.relayed), hostMode };",
  "    return { ok: true, pid: lastPid, route, relayed: Boolean(prepared.relayed), hostMode, localSourceKind };",
  'V13D3 safe open result'
);

bridge = replaceOnce(
  bridge,
  "    relay: relay.stats(), route, suppliedHeaderCount,",
  "    relay: relay.stats(), route, suppliedHeaderCount, localSourceKind, recovery: { ...lastRecovery },",
  'V13D3 bridge diagnostics'
);

entry = replaceOnce(
  entry,
  "const round = (value, digits = 2) => {\n  const number = Number(value);",
  "const round = (value, digits = 2) => {\n  if (value == null || value === '') return null;\n  const number = Number(value);",
  'V13D3 preserve null diagnostic numbers'
);

entry = replaceOnce(
  entry,
  "    const originalTime = Number(before?.time);",
  "    const originalTime = before?.time == null ? null : Number(before.time);",
  'V13D3 skip idle seek test'
);

entry = replaceOnce(
  entry,
  "      pidPresent: Boolean(openResult?.pid)\n    },",
  "      pidPresent: Boolean(openResult?.pid),\n      localSourceKind: openResult?.localSourceKind || null\n    },",
  'V13D3 open diagnostic source class'
);

entry = replaceOnce(
  entry,
  "      codec: state?.codec || null, fps: round(state?.fps), vid: state?.vid ?? null, aid: state?.aid ?? null,\n      error: state?.error || null",
  "      codec: state?.codec || null, fps: round(state?.fps), vid: state?.vid ?? null, aid: state?.aid ?? null,\n      idleActive: state?.idleActive ?? null, playlistCount: round(state?.playlistCount), playlistPos: round(state?.playlistPos),\n      fileFormat: state?.fileFormat || null, networkDemux: state?.networkDemux ?? null,\n      error: state?.error || null",
  'V13D3 renderer sample telemetry'
);

entry = replaceOnce(
  entry,
  "    if (last.aid != null) report.conclusionHints.push('audio-track-present');",
  "    if (Number(last.aid) > 0) report.conclusionHints.push('audio-track-present');\n    if (last.idleActive === true && !(Number(last.duration) > 0) && !(Number(last.width) > 0)) report.conclusionHints.push('mpv-returned-to-idle-without-media');\n    if (last.idleActive === false && !(Number(last.duration) > 0) && !(Number(last.width) > 0)) report.conclusionHints.push('mpv-still-loading-or-stalled');\n    if (report.bridge?.recovery?.attempted) report.conclusionHints.push(report.bridge.recovery.commandOk ? 'loopback-reload-accepted' : 'loopback-reload-failed');",
  'V13D3 conclusion hints'
);

entry = entry.replaceAll('V13D2', 'V13D3');
entry = entry.replaceAll('V13D2 docked-hwnd-mpv', 'V13D3 docked-hwnd-mpv');

fs.writeFileSync(bridgePath, bridge);
fs.writeFileSync(entryPath, entry);

buildSync({
  entryPoints: [entryPath],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

for (const relative of ['electron/mpv-native-main.cjs', 'src/mpv-native-entry.js', 'src/mpv-native.generated.js']) {
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const marker of relative.startsWith('electron/')
    ? ['idle-active', 'localSourceKind', 'armLoopbackRecovery', 'recovery: { ...lastRecovery }']
    : ['V13D3', 'idleActive', 'mpv-returned-to-idle-without-media']) {
    if (!text.includes(marker)) throw new Error(`V13D3 marker missing: ${relative} -> ${marker}`);
  }
}

console.log('V13D3 safe load-state diagnostics and one-shot Flix loopback recovery applied.');

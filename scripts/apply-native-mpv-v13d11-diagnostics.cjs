'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'src', 'mpv-native-entry.js');
const bridgePath = path.join(root, 'electron', 'mpv-native-main.cjs');
const flixPath = path.join(root, 'electron', 'flix-proxy.cjs');
let entry = fs.readFileSync(entryPath, 'utf8');
let bridge = fs.readFileSync(bridgePath, 'utf8');
let flix = fs.readFileSync(flixPath, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!entry.includes("const LILAC_AUTODIAG_VERSION = 'V13D10';")) {
  throw new Error('V13D11 diagnostics expect V13D10 first');
}
if (!bridge.includes('recovery: { ...lastRecovery }')) {
  throw new Error('V13D11 diagnostics expect V13D3 lifecycle diagnostics first');
}

// Instrument the actual Flix loopback source. The native bridge's relay is not
// involved when route=local-bypass, so relay.stats() alone cannot explain stalls.
const flixStatsRuntime = String.raw`
const flixStats={
  requests:0,manifests:0,segments:0,syntheticMasters:0,responsesOk:0,responsesError:0,
  upstreamRequests:0,upstreamErrors:0,hedges:0,stallHedges:0,upstreamBytes:0,servedBytes:0,
  decodedManifests:0,decodedSegments:0,invalidSegments:0,lastRequestAt:0,lastProgressAt:0,
  lastStatus:0,lastError:null
};
function safeDiagnosticError(error){return String(error?.message||error||'unknown').replace(/https?:\/\/[^\s]+/gi,'[media-url]').replace(/127\.0\.0\.1:\d+\/[^\s]*/gi,'[local-media]').slice(0,180)}
function flixProxyDiagnostics(){const now=Date.now(),activeSegments=[...sessions.values()].reduce((sum,data)=>sum+Math.max(0,Number(data.active)||0),0);return {
  listening:Boolean(server?.listening),sessions:sessions.size,requests:flixStats.requests,manifests:flixStats.manifests,
  segments:flixStats.segments,syntheticMasters:flixStats.syntheticMasters,responsesOk:flixStats.responsesOk,
  responsesError:flixStats.responsesError,upstreamRequests:flixStats.upstreamRequests,upstreamErrors:flixStats.upstreamErrors,
  hedges:flixStats.hedges,stallHedges:flixStats.stallHedges,upstreamMiB:Math.round(flixStats.upstreamBytes/10485.76)/100,
  servedMiB:Math.round(flixStats.servedBytes/10485.76)/100,decodedManifests:flixStats.decodedManifests,
  decodedSegments:flixStats.decodedSegments,invalidSegments:flixStats.invalidSegments,activeSegments,
  ahead:ahead.size,primed:primed.size,heldLists:heldLists.size,lastStatus:flixStats.lastStatus,
  lastRequestAgeMs:flixStats.lastRequestAt?Math.max(0,now-flixStats.lastRequestAt):null,
  lastProgressAgeMs:flixStats.lastProgressAt?Math.max(0,now-flixStats.lastProgressAt):null,
  lastError:flixStats.lastError
}}
`;
flix = replaceOnce(
  flix,
  'const sessions=new Map();\nlet server=null;\n',
  'const sessions=new Map();\nlet server=null;\n' + flixStatsRuntime + '\n',
  'V13D11 Flix stats runtime'
);
flix = replaceOnce(
  flix,
  '  const launch=()=>{\n    if(settled)return;',
  '  const launch=()=>{\n    if(settled)return;\n    if(controllers.length)flixStats.hedges++;flixStats.upstreamRequests++;',
  'V13D11 upstream request/hedge counting'
);
flix = replaceOnce(
  flix,
  'silence=setTimeout(()=>{stalled=true;launch()},stallMs);',
  'silence=setTimeout(()=>{stalled=true;flixStats.stallHedges++;launch()},stallMs);',
  'V13D11 stall hedge counting'
);
flix = replaceOnce(
  flix,
  '      const body=Buffer.concat(chunks);\n      if(start>0?',
  "      const body=Buffer.concat(chunks);flixStats.upstreamBytes+=body.length;flixStats.lastProgressAt=Date.now();flixStats.lastStatus=response.status;\n      if(start>0?",
  'V13D11 upstream progress counting'
);
flix = replaceOnce(
  flix,
  "    }).catch(error=>{clearTimeout(silence);pending--;lastError=error;if(!pending)launch()});",
  "    }).catch(error=>{clearTimeout(silence);pending--;lastError=error;if(!settled&&error?.name!=='AbortError'){flixStats.upstreamErrors++;flixStats.lastError=safeDiagnosticError(error)}if(!pending)launch()});",
  'V13D11 upstream failure counting'
);
flix = replaceOnce(
  flix,
  'async function handle(req,res){try{',
  'async function handle(req,res){flixStats.requests++;flixStats.lastRequestAt=Date.now();try{',
  'V13D11 request counting'
);
flix = replaceOnce(
  flix,
  "if(parts[2]==='master.m3u8'&&data.videoUrl&&data.audioUrl){",
  "if(parts[2]==='master.m3u8'&&data.videoUrl&&data.audioUrl){flixStats.syntheticMasters++;",
  'V13D11 synthetic master counting'
);
flix = replaceOnce(
  flix,
  'const headers=requestHeaders(data);const type=kind(target);let upstream,raw,body;',
  "const headers=requestHeaders(data);const type=kind(target);if(type==='m3u8')flixStats.manifests++;else if(type==='segment')flixStats.segments++;let upstream,raw,body;",
  'V13D11 source-kind counting'
);
flix = replaceOnce(
  flix,
  "    if(type==='m3u8'){body=decodeManifest(raw,data.pk,target,parts[1],server.address().port);break}",
  "    if(type==='m3u8'){body=decodeManifest(raw,data.pk,target,parts[1],server.address().port);flixStats.decodedManifests++;break}",
  'V13D11 manifest decode counting'
);
flix = replaceOnce(
  flix,
  '    body=decodeSegment(raw);if(isMedia(body))break;',
  '    body=decodeSegment(raw);if(isMedia(body)){flixStats.decodedSegments++;break;}',
  'V13D11 segment decode counting'
);
flix = replaceOnce(
  flix,
  '    const ts=findTs(body)||findTs(raw);if(ts){body=ts;break}',
  '    const ts=findTs(body)||findTs(raw);if(ts){body=ts;flixStats.decodedSegments++;break}',
  'V13D11 TS recovery counting'
);
flix = replaceOnce(
  flix,
  "  if(!body)throw new Error('영상 조각 데이터가 올바르지 않습니다.');res.writeHead(200,",
  "  if(!body){flixStats.invalidSegments++;throw new Error('영상 조각 데이터가 올바르지 않습니다.')}flixStats.responsesOk++;flixStats.servedBytes+=body.length;res.writeHead(200,",
  'V13D11 successful response counting'
);
flix = replaceOnce(
  flix,
  "}catch(error){const body=Buffer.from(`FLIX_DECODE_FAILED: ${error.message}`);",
  "}catch(error){flixStats.responsesError++;flixStats.lastError=safeDiagnosticError(error);const body=Buffer.from(`FLIX_DECODE_FAILED: ${error.message}`);",
  'V13D11 proxy error counting'
);
flix = replaceOnce(
  flix,
  'module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,fetchHedged,primeFlix};',
  'module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,fetchHedged,primeFlix,flixProxyDiagnostics};',
  'V13D11 Flix diagnostics export'
);

bridge = replaceOnce(
  bridge,
  "const { createMpvRelay } = require('./mpv-relay.cjs');",
  "const { createMpvRelay } = require('./mpv-relay.cjs');\nconst { flixProxyDiagnostics } = require('./flix-proxy.cjs');",
  'V13D11 bridge Flix diagnostics import'
);
bridge = replaceOnce(
  bridge,
  "  let lastRecovery = { armed: false, attempted: false, commandOk: null, trigger: null, outcome: null };\n  let lastPid = null;",
  "  let lastRecovery = { armed: false, attempted: false, commandOk: null, trigger: null, outcome: null };\n  let mpvLogLines = [];\n  let mpvLogRemainder = '';\n  let mpvLifecycle = {};\n  let lastPid = null;",
  'V13D11 bridge diagnostic variables'
);

const bridgeDiagRuntime = String.raw`
  function safeMpvLogLine(value) {
    return String(value || '')
      .replace(/https?:\/\/[^\s"']+/gi, '[media-url]')
      .replace(/127\.0\.0\.1:\d+\/[^\s"']*/gi, '[local-media]')
      .replace(/\\\\\.\\pipe\\[^\s"']+/gi, '[ipc-pipe]')
      .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
      .replace(/\b(Authorization|Cookie|Referer|Origin)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]')
      .slice(0, 260);
  }

  function consumeMpvLog(chunk) {
    mpvLogRemainder += String(chunk || '');
    for (;;) {
      const at = mpvLogRemainder.indexOf('\n');
      if (at < 0) break;
      const line = safeMpvLogLine(mpvLogRemainder.slice(0, at).trim());
      mpvLogRemainder = mpvLogRemainder.slice(at + 1);
      if (line) mpvLogLines.push(line);
      if (mpvLogLines.length > 80) mpvLogLines.splice(0, mpvLogLines.length - 80);
    }
  }

  function lifecycleSnapshot() {
    const base = Number(mpvLifecycle.openStartedAt) || 0;
    const delta = value => base && value ? Math.max(0, Number(value) - base) : null;
    return {
      openAgeMs: base ? Math.max(0, Date.now() - base) : null,
      preparedMs: delta(mpvLifecycle.preparedAt),
      helperReadyMs: delta(mpvLifecycle.helperReadyAt),
      ipcReadyMs: delta(mpvLifecycle.ipcReadyAt),
      loadAcceptedMs: delta(mpvLifecycle.loadAcceptedAt),
      processExitCode: mpvLifecycle.processExitCode ?? null
    };
  }

  function safeTrackList(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 16).map(track => ({
      id: Number(track?.id) || null,
      type: typeof track?.type === 'string' ? track.type : null,
      codec: typeof track?.codec === 'string' ? track.codec : null,
      lang: typeof track?.lang === 'string' ? track.lang : null,
      selected: Boolean(track?.selected),
      default: Boolean(track?.default),
      external: Boolean(track?.external)
    }));
  }
`;
bridge = replaceOnce(
  bridge,
  '  function mpvExecutable() {',
  bridgeDiagRuntime + '\n  function mpvExecutable() {',
  'V13D11 bridge diagnostic runtime'
);
bridge = replaceOnce(
  bridge,
  "    const prepared = await prepare(mediaUrl, suppliedHeaders, hls);\n    await closePlayer();",
  "    mpvLogLines = []; mpvLogRemainder = ''; mpvLifecycle = { openStartedAt: Date.now(), processExitCode: null };\n    const prepared = await prepare(mediaUrl, suppliedHeaders, hls);\n    mpvLifecycle.preparedAt = Date.now();\n    await closePlayer();",
  'V13D11 open lifecycle start'
);
bridge = replaceOnce(
  bridge,
  "    const host = await startHostHelper(lastRelativeBounds);\n    if (!host?.hwnd)",
  "    const host = await startHostHelper(lastRelativeBounds);\n    mpvLifecycle.helperReadyAt = Date.now();\n    if (!host?.hwnd)",
  'V13D11 helper ready timing'
);
bridge = replaceOnce(
  bridge,
  "      '--keep-open=no','--idle=yes','--osd-level=0','--cursor-autohide=always'",
  "      '--keep-open=no','--idle=yes','--osd-level=0','--cursor-autohide=always',\n      '--msg-level=all=warn,demux=info,cplayer=info,ffmpeg=warn'",
  'V13D11 mpv diagnostic log level'
);
bridge = replaceOnce(
  bridge,
  "    child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });\n    lastPid = child.pid || null;",
  "    child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });\n    child.stderr?.setEncoding('utf8');\n    child.stderr?.on('data', consumeMpvLog);\n    lastPid = child.pid || null;",
  'V13D11 mpv stderr capture'
);
bridge = replaceOnce(
  bridge,
  "    child.once('exit', () => {\n      if (generation !== myGeneration) return;",
  "    child.once('exit', code => {\n      mpvLifecycle.processExitCode = code ?? null;\n      if (generation !== myGeneration) return;",
  'V13D11 mpv exit diagnostics'
);
bridge = replaceOnce(
  bridge,
  "      await waitForIpc();\n      syncHostBounds();",
  "      await waitForIpc();\n      mpvLifecycle.ipcReadyAt = Date.now();\n      syncHostBounds();",
  'V13D11 IPC ready timing'
);
bridge = replaceOnce(
  bridge,
  "      if (loadReply?.error !== 'success') throw new Error(`mpv loadfile failed: ${loadReply?.error || 'unknown'}`);\n      await connectAndBatch",
  "      if (loadReply?.error !== 'success') throw new Error(`mpv loadfile failed: ${loadReply?.error || 'unknown'}`);\n      mpvLifecycle.loadAcceptedAt = Date.now();\n      await connectAndBatch",
  'V13D11 load accepted timing'
);
bridge = replaceOnce(
  bridge,
  "        ['get_property', 'file-format'],['get_property', 'demuxer-via-network']\n      ], 700);",
  "        ['get_property', 'file-format'],['get_property', 'demuxer-via-network'],\n        ['get_property', 'paused-for-cache'],['get_property', 'cache-buffering-state'],['get_property', 'cache-speed'],\n        ['get_property', 'eof-reached'],['get_property', 'current-vo'],['get_property', 'hwdec-current'],\n        ['get_property', 'current-ao'],['get_property', 'track-list']\n      ], 900);",
  'V13D11 deep state query'
);
bridge = replaceOnce(
  bridge,
  "        fileFormat: typeof value(14) === 'string' ? value(14) : null,\n        networkDemux: typeof value(15) === 'boolean' ? value(15) : null\n      };",
  "        fileFormat: typeof value(14) === 'string' ? value(14) : null,\n        networkDemux: typeof value(15) === 'boolean' ? value(15) : null,\n        pausedForCache: boolean(16), cacheBufferingState: numeric(17), cacheSpeed: numeric(18),\n        eofReached: boolean(19), vo: typeof value(20) === 'string' ? value(20) : null,\n        hwdec: typeof value(21) === 'string' ? value(21) : null, ao: typeof value(22) === 'string' ? value(22) : null,\n        tracks: safeTrackList(value(23))\n      };",
  'V13D11 deep state result'
);
bridge = replaceOnce(
  bridge,
  "    relay: relay.stats(), route, suppliedHeaderCount, localSourceKind, recovery: { ...lastRecovery },",
  "    relay: relay.stats(), sourceProxy: flixProxyDiagnostics(), route, suppliedHeaderCount, localSourceKind, recovery: { ...lastRecovery },\n    mpvLog: mpvLogLines.slice(-60), lifecycle: lifecycleSnapshot(),",
  'V13D11 bridge diagnostics expansion'
);

entry = replaceOnce(
  entry,
  "      fileFormat: state?.fileFormat || null, networkDemux: state?.networkDemux ?? null,\n      error: state?.error || null",
  "      fileFormat: state?.fileFormat || null, networkDemux: state?.networkDemux ?? null,\n      pausedForCache: state?.pausedForCache ?? null, cacheBufferingState: round(state?.cacheBufferingState),\n      cacheSpeed: round(state?.cacheSpeed), eofReached: state?.eofReached ?? null, vo: state?.vo || null,\n      hwdec: state?.hwdec || null, ao: state?.ao || null, tracks: Array.isArray(state?.tracks) ? state.tracks : [],\n      error: state?.error || null",
  'V13D11 renderer deep state telemetry'
);
entry = replaceOnce(
  entry,
  "    if (report.bridge?.hostReady) report.conclusionHints.push('native-host-reported-ready');",
  "    if (report.bridge?.hostReady) report.conclusionHints.push('native-host-reported-ready');\n    if (Number(report.bridge?.sourceProxy?.requests) > 0) report.conclusionHints.push('flix-loopback-received-requests');\n    if (Number(report.bridge?.sourceProxy?.segments) > 0 && Number(report.bridge?.sourceProxy?.decodedSegments) === 0) report.conclusionHints.push('flix-segment-not-yet-decoded');\n    if (Number(report.bridge?.sourceProxy?.upstreamErrors) > 0 || Number(report.bridge?.sourceProxy?.responsesError) > 0) report.conclusionHints.push('flix-source-errors-observed');",
  'V13D11 source-proxy conclusion hints'
);
entry = entry.replaceAll('V13D10', 'V13D11');

fs.writeFileSync(entryPath, entry);
fs.writeFileSync(bridgePath, bridge);
fs.writeFileSync(flixPath, flix);

buildSync({
  entryPoints: [entryPath],
  outfile: path.join(root, 'src', 'mpv-native.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'info'
});

for (const relative of ['src/mpv-native-entry.js','src/mpv-native.generated.js','electron/mpv-native-main.cjs','electron/flix-proxy.cjs']) {
  execFileSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'inherit' });
}
const finalEntry = fs.readFileSync(entryPath, 'utf8');
const finalBridge = fs.readFileSync(bridgePath, 'utf8');
const finalFlix = fs.readFileSync(flixPath, 'utf8');
for (const marker of ['V13D11','pausedForCache','cacheBufferingState','flix-loopback-received-requests']) if (!finalEntry.includes(marker)) throw new Error(`V13D11 entry marker missing: ${marker}`);
for (const marker of ['flixProxyDiagnostics','mpvLogLines','lifecycleSnapshot','track-list','stdio: [\'ignore\', \'ignore\', \'pipe\']']) if (!finalBridge.includes(marker)) throw new Error(`V13D11 bridge marker missing: ${marker}`);
for (const marker of ['flixProxyDiagnostics','stallHedges','decodedSegments','lastProgressAgeMs']) if (!finalFlix.includes(marker)) throw new Error(`V13D11 Flix marker missing: ${marker}`);
if (/mpvLogLines[^\n]*mediaUrl/.test(finalBridge)) throw new Error('V13D11 raw media URL leaked into log ring');

console.log('V13D11 adds sanitized mpv logs, deep state, lifecycle timings, and actual Flix loopback telemetry.');

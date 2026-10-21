'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'electron', 'flix-proxy.cjs');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(needle, replacement, label) {
  const n = source.split(needle).length - 1;
  if (n !== 1) throw new Error(`${label}: expected one anchor, found ${n}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  'let server=null;\n',
  `let server=null;\nconst diag={requests:0,playlists:0,segments:0,other:0,errors:0,responseBytes:0,lastActivityAt:0,lastKind:null};\nfunction touch(kindName){diag.requests++;diag.lastActivityAt=Date.now();diag.lastKind=kindName||null;if(kindName==='m3u8')diag.playlists++;else if(kindName==='segment')diag.segments++;else diag.other++}\nfunction flixProxyStats(){return {requests:diag.requests,playlists:diag.playlists,segments:diag.segments,other:diag.other,errors:diag.errors,responseMiB:Math.round(diag.responseBytes/104857.6)/10,lastActivityAt:diag.lastActivityAt,lastKind:diag.lastKind,sessions:sessions.size,aheadInFlight:ahead.size,primed:primed.size,heldLists:heldLists.size,listening:Boolean(server?.listening)}}\n`,
  'diag globals'
);

replaceOnce(
  "const target=Buffer.from(parts.slice(2).join('/'),'base64url').toString();const headers=requestHeaders(data);const type=kind(target);let upstream,raw,body;",
  "const target=Buffer.from(parts.slice(2).join('/'),'base64url').toString();const headers=requestHeaders(data);const type=kind(target);touch(type);let upstream,raw,body;",
  'request kind counters'
);

replaceOnce(
  "if(!body)throw new Error('영상 조각 데이터가 올바르지 않습니다.');res.writeHead(200,{'content-type':type==='m3u8'?'application/vnd.apple.mpegurl':type==='segment'?'video/mp4':upstream.headers.get('content-type')||'application/octet-stream','content-length':body.length,'access-control-allow-origin':'*','cache-control':'no-store','accept-ranges':'none'});res.end(req.method==='HEAD'?undefined:body)}catch(error){const body=Buffer.from(`FLIX_DECODE_FAILED: ${error.message}`);",
  "if(!body)throw new Error('영상 조각 데이터가 올바르지 않습니다.');diag.responseBytes+=body.length;diag.lastActivityAt=Date.now();res.writeHead(200,{'content-type':type==='m3u8'?'application/vnd.apple.mpegurl':type==='segment'?'video/mp4':upstream.headers.get('content-type')||'application/octet-stream','content-length':body.length,'access-control-allow-origin':'*','cache-control':'no-store','accept-ranges':'none'});res.end(req.method==='HEAD'?undefined:body)}catch(error){diag.errors++;diag.lastActivityAt=Date.now();const body=Buffer.from(`FLIX_DECODE_FAILED: ${error.message}`);",
  'response and error counters'
);

replaceOnce(
  'module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,fetchHedged,primeFlix};',
  'module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,fetchHedged,primeFlix,flixProxyStats};',
  'stats export'
);

for (const marker of ['function flixProxyStats()', 'diag.responseBytes+=body.length', 'flixProxyStats};']) {
  if (!source.includes(marker)) throw new Error(`Flix diagnostics marker missing: ${marker}`);
}
if (/url\s*:/i.test(source.slice(source.indexOf('function flixProxyStats()'), source.indexOf('function flixProxyStats()') + 500))) {
  throw new Error('Flix diagnostics snapshot must not expose URL fields');
}
fs.writeFileSync(target, source);
console.log('FLIX_PROXY_DIAGNOSTICS_PATCH_OK');

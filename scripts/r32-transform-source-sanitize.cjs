'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const target = path.resolve(__dirname, 'r32-flix-worker-native-focus-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

// 1) Remove a nested template literal from the generated worker wrapper. The
// outer R32 transform intentionally uses one large String.raw template.
replaceOnce(
  "  worker.on('exit',code=>{if(code!==0&&r32Worker===worker)fail(new Error(`Flix worker exited (${code})`));else if(r32Worker===worker)r32Worker=null;});",
  "  worker.on('exit',code=>{if(code!==0&&r32Worker===worker)fail(new Error('Flix worker exited ('+code+')'));else if(r32Worker===worker)r32Worker=null;});",
  'nested Flix worker exit template'
);

// 2) R31's diagnostic patch appends flixProxyStats to the original export list.
// Preserve that API and move its state into the worker too. The worker pushes a
// small 4 Hz stats snapshot to main so the existing synchronous D2 diagnostic
// path can stay synchronous without doing segment work or RPC on the main loop.
replaceOnce(
  "const oldFlixExports = 'module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,fetchHedged,primeFlix,flixReadable};';",
  "const oldFlixExports = 'module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,fetchHedged,primeFlix,flixReadable,flixProxyStats};';",
  'R31 Flix export anchor'
);
replaceOnce(
  "const r32DirectApi={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,primeFlix,flixReadable};",
  "const r32DirectApi={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy,primeFlix,flixReadable,flixProxyStats};",
  'worker direct diagnostics API'
);
replaceOnce(
  "if(!isMainThread&&workerData?.lilacR32FlixWorker===true){\n  parentPort.on('message',async message=>{",
  "if(!isMainThread&&workerData?.lilacR32FlixWorker===true){\n  const r32StatsTimer=setInterval(()=>{try{parentPort.postMessage({type:'stats',value:flixProxyStats()})}catch{}},250);\n  r32StatsTimer.unref?.();\n  try{parentPort.postMessage({type:'stats',value:flixProxyStats()})}catch{}\n  parentPort.on('message',async message=>{",
  'worker stats push'
);
replaceOnce(
  "let r32Worker=null,r32WorkerSeq=0;\nconst r32WorkerPending=new Map();",
  "let r32Worker=null,r32WorkerSeq=0;\nlet r32WorkerStats={requests:0,playlists:0,segments:0,other:0,errors:0,responseMiB:0,lastActivityAt:0,lastKind:null,sessions:0,aheadInFlight:0,primed:0,heldLists:0,listening:false};\nconst r32WorkerPending=new Map();",
  'main cached Flix stats'
);
replaceOnce(
  "  worker.on('message',message=>{\n    const pending=r32WorkerPending.get(Number(message?.id));if(!pending)return;",
  "  worker.on('message',message=>{\n    if(message?.type==='stats'&&message.value&&typeof message.value==='object'){r32WorkerStats={...r32WorkerStats,...message.value};return;}\n    const pending=r32WorkerPending.get(Number(message?.id));if(!pending)return;",
  'main worker stats receiver'
);
replaceOnce(
  "  closeFlixProxy:r32CloseWorker,\n  primeFlix:(...args)=>r32Rpc('primeFlix',args),",
  "  closeFlixProxy:r32CloseWorker,\n  flixProxyStats:()=>({...r32WorkerStats,listening:Boolean(r32Worker)&&Boolean(r32WorkerStats.listening)}),\n  primeFlix:(...args)=>r32Rpc('primeFlix',args),",
  'main synchronous Flix diagnostics export'
);

fs.writeFileSync(target, source, 'utf8');

// The qualified R31 builder intentionally checks out pinned source commits. In
// GitHub Actions, record this deterministic normalization as a local-only commit
// so that checkout sees a clean tree. The commit is not pushed; the branch keeps
// this sanitizer as the reproducible build input.
if (process.env.GITHUB_ACTIONS === 'true') {
  const run = (args, label) => {
    const result = spawnSync('git', args, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || result.stdout || '').slice(0,500)}`);
  };
  run(['config','user.name','github-actions[bot]'], 'git user.name');
  run(['config','user.email','41898282+github-actions[bot]@users.noreply.github.com'], 'git user.email');
  run(['add','scripts/r32-flix-worker-native-focus-fix.cjs'], 'git add sanitized transform');
  run(['commit','-m','ci: normalize R32 generated transform source'], 'git commit sanitized transform');
}

console.log('R32_TRANSFORM_SOURCE_SANITIZE_OK nestedFlixTemplate=removed flixExports=R31+stats-cache flixStatsPushHz=4 ciTree=clean');

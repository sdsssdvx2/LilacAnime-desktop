'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const requestedScript = process.argv[2];
const timeoutMs = Math.max(30_000, Number(process.argv[3]) || 180_000);
if (!requestedScript) throw new Error('usage: node r37-run-e2e-with-timeout.cjs <script> [timeoutMs]');

const root = path.resolve(__dirname, '..');

// TEMPORARY R37 diagnosis only. Run #44 proved that native producer frames keep
// popping through frame 47, while frame 22 is the last one recorded/imported/sent.
// Dump the exact generated product-bridge source between those two instrumentation
// anchors so the next fix targets the real post-pop discard branch rather than
// changing renderer/WebGPU/native-presenter behavior speculatively.
const productBridge = path.join(root, 'electron', 'libmpv-shared-main.cjs');
if (fs.existsSync(productBridge)) {
  const bridgeSource = fs.readFileSync(productBridge, 'utf8').replace(/\r\n/g, '\n');
  const popAnchor = '      metrics.nativeFrames += 1;';
  const recordAnchor = '      metrics.lastFrameId = Number(nativeFrame.frameId) || metrics.lastFrameId;';
  const popAt = bridgeSource.indexOf(popAnchor);
  const recordAt = popAt >= 0 ? bridgeSource.indexOf(recordAnchor, popAt + popAnchor.length) : -1;
  if (popAt >= 0 && recordAt > popAt) {
    const contextStart = Math.max(0, popAt - 500);
    const contextEnd = Math.min(bridgeSource.length, recordAt + recordAnchor.length + 300);
    console.log('R37_POST_POP_DROP_SOURCE_BEGIN');
    console.log(bridgeSource.slice(contextStart, contextEnd));
    console.log('R37_POST_POP_DROP_SOURCE_END');
  } else {
    console.log(`R37_POST_POP_DROP_SOURCE_MISSING popAt=${popAt} recordAt=${recordAt}`);
  }
}

// TEMPORARY R37 diagnosis only: qualification still requests the raw E2E path,
// but route that exact request through the require-cache diagnostic bridge copy.
// The wrapper executes the same E2E body and leaves product/package bytes intact.
const rawE2e = path.normalize('scripts/r37-explicit-handoff-e2e-smoke.cjs');
const requestedNormalized = path.normalize(requestedScript);
const diagnosticRelative = 'scripts/r37-node-api-callback-diagnostic.cjs';
const script = requestedNormalized === rawE2e ? diagnosticRelative : requestedScript;
if (script !== requestedScript) {
  console.log(`R37_E2E_DIAGNOSTIC_ROUTE requested=${requestedScript} actual=${script} mode=frame-flow productBytes=unchanged`);
}

const childScript = path.resolve(root, script);
const electronExe = require('electron');
if (typeof electronExe !== 'string' || !fs.existsSync(electronExe)) {
  throw new Error(`Electron executable not found: ${String(electronExe)}`);
}
if (!fs.existsSync(childScript)) throw new Error(`R37 E2E script not found: ${childScript}`);

const expectedMarker = 'R37_EXPLICIT_HANDOFF_E2E_OK';
const electronArgs = [
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--use-angle=d3d11',
  childScript
];

console.log(`R37_E2E_PARENT_START timeoutMs=${timeoutMs} requestedScript=${requestedScript} script=${script} nodeOptions=${String(process.env.NODE_OPTIONS || '')} args=${electronArgs.slice(0, -1).join(',')}`);

const child = spawn(electronExe, electronArgs, {
  cwd: root,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

let done = false;
let markerSeen = false;
let tail = '';
const TAIL_LIMIT = 64 * 1024;

function observe(chunk, target) {
  const text = String(chunk || '');
  target.write(text);
  tail = (tail + text).slice(-TAIL_LIMIT);
  if (text.includes(expectedMarker) || tail.includes(expectedMarker)) markerSeen = true;
}

child.stdout.on('data', chunk => observe(chunk, process.stdout));
child.stderr.on('data', chunk => observe(chunk, process.stderr));

function killTree() {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
        timeout: 15_000
      });
    } catch (error) {
      console.error(`R37_E2E_PARENT_TASKKILL_ERROR error=${String(error?.message || error).slice(0, 300)}`);
    }
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

const timer = setTimeout(() => {
  if (done) return;
  done = true;
  console.error(`R37_E2E_PARENT_TIMEOUT timeoutMs=${timeoutMs} pid=${child.pid || 0} markerSeen=${markerSeen}`);
  if (tail) console.error(`R37_E2E_PARENT_TAIL_BEGIN\n${tail}\nR37_E2E_PARENT_TAIL_END`);
  killTree();
  process.exit(124);
}, timeoutMs);
timer.unref?.();

child.once('error', error => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.error(`R37_E2E_PARENT_SPAWN_ERROR ${String(error?.stack || error).slice(0, 2000)}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (signal || code !== 0) {
    console.error(`R37_E2E_PARENT_FAIL code=${String(code)} signal=${String(signal || '')} markerSeen=${markerSeen}`);
    if (tail) console.error(`R37_E2E_PARENT_TAIL_BEGIN\n${tail}\nR37_E2E_PARENT_TAIL_END`);
    process.exit(Number.isInteger(code) && code !== 0 ? code : 1);
  }
  if (!markerSeen) {
    console.error(`R37_E2E_PARENT_MARKER_MISSING code=0 expected=${expectedMarker}`);
    if (tail) console.error(`R37_E2E_PARENT_TAIL_BEGIN\n${tail}\nR37_E2E_PARENT_TAIL_END`);
    process.exit(1);
  }
  console.log(`R37_E2E_PARENT_OK code=0 marker=${expectedMarker}`);
  process.exit(0);
});

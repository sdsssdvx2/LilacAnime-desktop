'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const requestedScript = process.argv[2];
const timeoutMs = Math.max(30_000, Number(process.argv[3]) || 180_000);
if (!requestedScript) throw new Error('usage: node r37-run-e2e-with-timeout.cjs <script> [timeoutMs]');

const root = path.resolve(__dirname, '..');
const rawE2e = path.normalize('scripts/r37-explicit-handoff-e2e-smoke.cjs');
const requestedNormalized = path.normalize(requestedScript);
if (requestedNormalized !== rawE2e) {
  throw new Error(`R37 final launcher accepts only the raw product E2E: requested=${requestedScript}`);
}

// Final R37 qualification must load the real product bridge directly. Do not
// route through require-cache wrappers, callback suppressors, source copies, or
// diagnostic instrumentation. The E2E itself rejects DEP0168 and validates three
// focus cycles against the packaged runtime contract.
const script = requestedScript;
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

console.log(`R37_E2E_PARENT_START timeoutMs=${timeoutMs} script=${script} mode=raw-product-bridge callbackWrapper=off nodeOptions=${String(process.env.NODE_OPTIONS || '')} args=${electronArgs.slice(0, -1).join(',')}`);

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
  console.log(`R37_E2E_PARENT_OK code=0 marker=${expectedMarker} mode=raw-product-bridge callbackWrapper=off`);
  process.exit(0);
});

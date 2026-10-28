'use strict';

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const script = process.argv[2];
const marker = process.argv[3];
const timeoutMs = Math.max(1000, Number(process.argv[4] || 180000));
if (!script || !marker) {
  console.error('usage: node r40-run-electron-gate.cjs <script> <required-marker> [timeout-ms]');
  process.exit(2);
}

const electron = require('electron');
const childScript = path.resolve(script);
const args = [
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--use-angle=d3d11',
  childScript
];

let stdout = '';
let stderr = '';
let settled = false;
const child = spawn(electron, args, {
  cwd: process.cwd(),
  env: process.env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

const append = (kind, chunk) => {
  const text = String(chunk || '');
  if (kind === 'stdout') stdout += text;
  else stderr += text;
  process[kind].write(text);
};
child.stdout.on('data', chunk => append('stdout', chunk));
child.stderr.on('data', chunk => append('stderr', chunk));

function killTree() {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' }); } catch {}
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  killTree();
  console.error(`R40_ELECTRON_GATE_FAIL reason=timeout script=${path.basename(script)} marker=${marker} timeoutMs=${timeoutMs}`);
  process.exit(124);
}, timeoutMs);

child.on('error', error => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.error(`R40_ELECTRON_GATE_FAIL reason=spawn script=${path.basename(script)} marker=${marker} error=${String(error?.message || error)}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  const combined = `${stdout}\n${stderr}`;
  const markerSeen = combined.includes(marker);
  if (code !== 0 || !markerSeen) {
    console.error(`R40_ELECTRON_GATE_FAIL reason=${code !== 0 ? 'child-exit' : 'missing-marker'} script=${path.basename(script)} marker=${marker} code=${code} signal=${signal || ''} markerSeen=${markerSeen ? 1 : 0}`);
    process.exit(code && Number.isInteger(code) ? code : 1);
  }
  console.log(`R40_ELECTRON_GATE_OK script=${path.basename(script)} marker=${marker} childExit=0 markerSeen=1`);
});

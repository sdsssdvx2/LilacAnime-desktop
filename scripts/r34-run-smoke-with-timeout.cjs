'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const script = process.argv[2];
const label = process.argv[3] || path.basename(String(script || 'smoke'));
const timeoutMs = Math.max(10_000, Number(process.argv[4]) || 120_000);
if (!script) throw new Error('usage: node r34-run-smoke-with-timeout.cjs <script> [label] [timeoutMs]');

const root = path.resolve(__dirname, '..');
const childScript = path.resolve(root, script);
const electronExe = require('electron');
if (typeof electronExe !== 'string' || !fs.existsSync(electronExe)) {
  throw new Error(`Electron executable not found: ${String(electronExe)}`);
}
if (!fs.existsSync(childScript)) throw new Error(`Smoke script not found: ${childScript}`);

const producerNodeMode = /r32-native-producer-watchdog-smoke\.cjs$/i.test(childScript);
const childEnv = { ...process.env };
if (producerNodeMode) childEnv.ELECTRON_RUN_AS_NODE = '1';
else delete childEnv.ELECTRON_RUN_AS_NODE;

const expectedMarkers = new Map([
  ['r32-native-producer-watchdog-smoke.cjs', 'R32_NATIVE_PRODUCER_WATCHDOG_OK'],
  ['r33-owned-popup-visible-focus-smoke.cjs', 'R33_VISIBLE_FOCUS_SMOKE_OK'],
  ['r34-focus-handoff-native-smoke.cjs', 'R34_NATIVE_HANDOFF_SMOKE_OK'],
  ['r37-native-handoff-freeze-smoke.cjs', 'R37_NATIVE_HANDOFF_FREEZE_OK'],
  ['r37-explicit-handoff-e2e-smoke.cjs', 'R37_EXPLICIT_HANDOFF_E2E_OK']
]);
const expectedMarker = expectedMarkers.get(path.basename(childScript));
if (!expectedMarker) throw new Error(`No authoritative success marker configured for smoke: ${path.basename(childScript)}`);

console.log(`R34_SMOKE_PARENT_START label=${label} timeoutMs=${timeoutMs} script=${script} launcher=electron-exe-direct mode=${producerNodeMode ? 'electron-run-as-node' : 'electron-app'} expect=${expectedMarker}`);

const child = spawn(electronExe, [childScript], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let done = false;
let markerSeen = false;
let tail = '';
const TAIL_LIMIT = 32 * 1024;
function observe(chunk, target) {
  const text = String(chunk || '');
  target.write(text);
  tail = (tail + text).slice(-TAIL_LIMIT);
  if (text.includes(expectedMarker) || tail.includes(expectedMarker)) markerSeen = true;
}
child.stdout.on('data', chunk => observe(chunk, process.stdout));
child.stderr.on('data', chunk => observe(chunk, process.stderr));

const timer = setTimeout(() => {
  if (done) return;
  done = true;
  console.error(`R34_SMOKE_PARENT_TIMEOUT label=${label} timeoutMs=${timeoutMs} pid=${child.pid || 0} expect=${expectedMarker}`);
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
        timeout: 15_000
      });
    } catch (error) {
      console.error(`R34_SMOKE_PARENT_TASKKILL_ERROR label=${label} error=${String(error?.message || error).slice(0, 300)}`);
    }
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
  process.exit(124);
}, timeoutMs);
timer.unref?.();

child.once('error', error => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.error(`R34_SMOKE_PARENT_SPAWN_ERROR label=${label} error=${String(error?.stack || error).slice(0, 1000)}`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (signal || code !== 0) {
    console.error(`R34_SMOKE_PARENT_FAIL label=${label} code=${String(code)} signal=${String(signal || '')} markerSeen=${markerSeen}`);
    process.exit(Number.isInteger(code) && code !== 0 ? code : 1);
  }
  if (!markerSeen) {
    console.error(`R34_SMOKE_PARENT_MARKER_MISSING label=${label} code=0 expected=${expectedMarker}`);
    process.exit(1);
  }
  console.log(`R34_SMOKE_PARENT_OK label=${label} code=0 marker=${expectedMarker}`);
  process.exit(0);
});
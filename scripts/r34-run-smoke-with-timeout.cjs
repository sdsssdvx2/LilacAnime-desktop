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
// Do not go through node_modules/.bin/electron.cmd or cmd.exe here. Windows
// cmd /S /C quote stripping made the quoted .cmd path itself become argv[0] in
// hosted CI. The electron npm package exposes the concrete electron.exe path
// when required from ordinary Node, so spawn that executable directly.
const electronExe = require('electron');
if (typeof electronExe !== 'string' || !fs.existsSync(electronExe)) {
  throw new Error(`Electron executable not found: ${String(electronExe)}`);
}
if (!fs.existsSync(childScript)) throw new Error(`Smoke script not found: ${childScript}`);
console.log(`R34_SMOKE_PARENT_START label=${label} timeoutMs=${timeoutMs} script=${script} launcher=electron-exe-direct`);

const child = spawn(electronExe, [childScript], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
});
let done = false;
const timer = setTimeout(() => {
  if (done) return;
  done = true;
  console.error(`R34_SMOKE_PARENT_TIMEOUT label=${label} timeoutMs=${timeoutMs} pid=${child.pid || 0}`);
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
    console.error(`R34_SMOKE_PARENT_FAIL label=${label} code=${String(code)} signal=${String(signal || '')}`);
    process.exit(Number.isInteger(code) ? code : 1);
  }
  console.log(`R34_SMOKE_PARENT_OK label=${label} code=0`);
  process.exit(0);
});
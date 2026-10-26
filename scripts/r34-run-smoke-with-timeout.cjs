'use strict';

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const script = process.argv[2];
const label = process.argv[3] || path.basename(String(script || 'smoke'));
const timeoutMs = Math.max(10_000, Number(process.argv[4]) || 120_000);
if (!script) throw new Error('usage: node r34-run-smoke-with-timeout.cjs <script> [label] [timeoutMs]');

const root = path.resolve(__dirname, '..');
const electronCmd = path.join(root, 'node_modules', '.bin', 'electron.cmd');
const childScript = path.resolve(root, script);
const comspec = process.env.ComSpec || 'cmd.exe';
const commandLine = `"${electronCmd}" "${childScript}"`;
console.log(`R34_SMOKE_PARENT_START label=${label} timeoutMs=${timeoutMs} script=${script}`);

const child = spawn(comspec, ['/d', '/s', '/c', commandLine], {
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

'use strict';

const { spawnSync } = require('node:child_process');

const [, , electron, script, okMarker, timeoutArg = '180'] = process.argv;
if (!electron || !script || !okMarker) {
  console.error('usage: node run-electron-native-smoke.cjs <electron.exe> <script> <ok-marker> [timeout-sec]');
  process.exit(64);
}
const timeoutSec = Math.max(1, Number(timeoutArg) || 180);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const result = spawnSync(electron, [script], {
  cwd: process.cwd(),
  env,
  encoding: 'utf8',
  timeout: timeoutSec * 1000,
  maxBuffer: 16 * 1024 * 1024,
  windowsHide: true
});
const stdout = result.stdout || '';
const stderr = result.stderr || '';
process.stdout.write(`===== ${script} =====\n${stdout}`);
if (stderr) process.stderr.write(stderr);
if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    console.error(`${script} timed out after ${timeoutSec}s`);
    process.exit(124);
  }
  console.error(`${script} spawn error: ${result.error.stack || result.error}`);
  process.exit(125);
}
if (result.signal) {
  console.error(`${script} terminated by signal=${result.signal}`);
  process.exit(126);
}
if (result.status !== 0) {
  console.error(`${script} failed exit=${String(result.status)}`);
  process.exit(Number.isInteger(result.status) ? result.status : 127);
}
if (!stdout.includes(okMarker)) {
  console.error(`${script} missing ${okMarker}`);
  process.exit(65);
}
console.log(`NATIVE_SMOKE_RUNNER_OK script=${script} exit=0 marker=${okMarker}`);

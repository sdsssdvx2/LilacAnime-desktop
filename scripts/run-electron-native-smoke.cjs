'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [, , electron, script, okMarker, timeoutArg = '180'] = process.argv;
if (!electron || !script || !okMarker) {
  console.error('usage: node run-electron-native-smoke.cjs <electron.exe> <script> <ok-marker> [timeout-sec]');
  process.exit(64);
}

function replaceExactly(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one historical anchor, found ${count}`);
  return source.replace(needle, replacement);
}

function prepareCompatibilityScript(inputScript) {
  const resolved = path.resolve(process.cwd(), inputScript);
  if (path.basename(resolved) !== 'smoke-libmpv-native-command-roundtrip.cjs') {
    return { script: inputScript, cleanup: null, compatibility: 'none' };
  }

  let source = fs.readFileSync(resolved, 'utf8');
  if (source.includes('fullDiagnostics ? bridge.state({ fullDiagnostics: true }) : bridge.state()')) {
    return { script: inputScript, cleanup: null, compatibility: 'r3c-full-diagnostics-already-current' };
  }

  // R3C deliberately made bridge.state() lightweight on the playback hot path.
  // The historical command smoke predates that contract and therefore cannot see
  // volume/speed unless it explicitly requests full diagnostics. Apply the exact
  // previously-qualified statefix test contract to a temporary sibling only; the
  // product source and historical smoke remain unchanged.
  source = replaceExactly(
    source,
    'async function waitForState(bridge, label, predicate, timeoutMs = 5000) {',
    'async function waitForState(bridge, label, predicate, timeoutMs = 5000, fullDiagnostics = false) {',
    'command smoke waitForState signature'
  );
  source = replaceExactly(
    source,
    '    last = bridge.state();',
    '    last = fullDiagnostics ? bridge.state({ fullDiagnostics: true }) : bridge.state();',
    'command smoke conditional diagnostics read'
  );
  source = replaceExactly(
    source,
    "    const volumeState = await waitForState(bridge, 'volume readback', state => Math.abs(Number(state.volume) - 37) <= 0.5);",
    "    const volumeState = await waitForState(bridge, 'volume readback', state => Math.abs(Number(state.volume) - 37) <= 0.5, 5000, true);",
    'command smoke volume full diagnostics'
  );
  source = replaceExactly(
    source,
    "    const speedState = await waitForState(bridge, 'speed readback', state => Math.abs(Number(state.speed) - 1.5) <= 0.02);",
    "    const speedState = await waitForState(bridge, 'speed readback', state => Math.abs(Number(state.speed) - 1.5) <= 0.02, 5000, true);",
    'command smoke speed full diagnostics'
  );
  source = replaceExactly(
    source,
    '    const finalState = bridge.state();',
    '    const finalState = bridge.state({ fullDiagnostics: true });',
    'command smoke final full diagnostics'
  );

  const temp = path.join(path.dirname(resolved), '.qualification-command-roundtrip.cjs');
  fs.writeFileSync(temp, source, 'utf8');
  return {
    script: temp,
    compatibility: 'r3c-full-diagnostics-qualified-contract',
    cleanup: () => {
      try { fs.unlinkSync(temp); } catch {}
    }
  };
}

const timeoutSec = Math.max(1, Number(timeoutArg) || 180);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
let prepared;
try {
  prepared = prepareCompatibilityScript(script);
} catch (error) {
  console.error(`native smoke compatibility preparation failed: ${error?.stack || error}`);
  process.exit(66);
}
if (prepared.compatibility !== 'none') {
  console.log(`NATIVE_SMOKE_COMPAT=${prepared.compatibility} source=${script}`);
}

let result;
try {
  result = spawnSync(electron, [prepared.script], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
} finally {
  prepared.cleanup?.();
}

const stdout = result?.stdout || '';
const stderr = result?.stderr || '';
process.stdout.write(`===== ${script} =====\n${stdout}`);
if (stderr) process.stderr.write(stderr);
if (result?.error) {
  if (result.error.code === 'ETIMEDOUT') {
    console.error(`${script} timed out after ${timeoutSec}s`);
    process.exit(124);
  }
  console.error(`${script} spawn error: ${result.error.stack || result.error}`);
  process.exit(125);
}
if (result?.signal) {
  console.error(`${script} terminated by signal=${result.signal}`);
  process.exit(126);
}
if (result?.status !== 0) {
  console.error(`${script} failed exit=${String(result?.status)}`);
  process.exit(Number.isInteger(result?.status) ? result.status : 127);
}
if (!stdout.includes(okMarker)) {
  console.error(`${script} missing ${okMarker}`);
  process.exit(65);
}
console.log(`NATIVE_SMOKE_RUNNER_OK script=${script} exit=0 marker=${okMarker}`);

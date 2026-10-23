'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scripts = [
  'normalize-libmpv-r2k-upstream.cjs',
  'apply-flix-proxy-diagnostics.cjs',
  'apply-libmpv-flix-diagnostics-wiring.cjs',
  'apply-libmpv-player-diagnostics.cjs',
  'apply-libmpv-renderer-compat.cjs',
  'apply-libmpv-renderer-diagnostics.cjs',
  'apply-libmpv-d3-runtime-fixes.cjs'
];

for (const name of scripts) {
  const full = path.join(__dirname, name);
  process.stdout.write(`D2_PREFLIGHT_PATCH_START=${name}\n`);
  execFileSync(process.execPath, [full], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });
  process.stdout.write(`D2_PREFLIGHT_PATCH_OK=${name}\n`);
}

console.log('LIBMPV_D2_PREFLIGHT_ALL_OK');

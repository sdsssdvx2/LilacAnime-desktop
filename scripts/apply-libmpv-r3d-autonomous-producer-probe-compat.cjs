'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let s = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
if (!s.includes('StartAutonomousProbeWorker') || !s.includes('std::max(')) {
  throw new Error('autonomous producer probe must be applied first');
}
if (!s.includes('#define NOMINMAX')) {
  const anchor = '#include <node_api.h>\n#include <windows.h>\n';
  const count = s.split(anchor).length - 1;
  if (count !== 1) throw new Error(`windows include anchor count=${count}`);
  s = s.replace(anchor, '#include <node_api.h>\n#define NOMINMAX\n#include <windows.h>\n#include <algorithm>\n');
}
fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_AUTONOMOUS_PROBE_COMPAT_OK nominmax=1 algorithm=1');

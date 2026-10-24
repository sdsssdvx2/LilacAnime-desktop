'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let s = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = s.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  s = s.replace(needle, replacement);
}

if (!s.includes('StartAutonomousProbeWorker') || !s.includes('autonomousStop = false')) {
  throw new Error('autonomous producer probe must be applied first');
}

replaceOnce(
  '  bool autonomousStop = false;\n',
  '  std::atomic<bool> autonomousStop{false};\n',
  'atomic autonomous stop state');

replaceOnce(
  '      for (uint32_t drain = 0; drain < 8; drain += 1) {\n        const auto updateStarted = std::chrono::steady_clock::now();',
  '      for (uint32_t drain = 0; drain < 8; drain += 1) {\n        if (player->autonomousStop.load(std::memory_order_acquire)) break;\n        const auto updateStarted = std::chrono::steady_clock::now();',
  'stop check before every drain');

for (const marker of [
  'std::atomic<bool> autonomousStop{false}',
  'if (player->autonomousStop.load(std::memory_order_acquire)) break;'
]) if (!s.includes(marker)) throw new Error(`autonomous stopfix marker missing: ${marker}`);

fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_AUTONOMOUS_STOPFIX_OK stop=atomic check=per-drain');

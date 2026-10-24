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

if (!s.includes('std::atomic<bool> autonomousStop{false}') || !s.includes('StopAutonomousProbeWorker')) {
  throw new Error('autonomous stopfix-v2 requires stopfix-v1 first');
}

replaceOnce(
`  void StopAutonomousProbeWorker() {\n    autonomousEnabled.store(false, std::memory_order_release);\n    {\n      std::lock_guard<std::mutex> lock(autonomousMutex);\n      autonomousStop = true;\n    }\n    autonomousCv.notify_all();\n    if (autonomousThread.joinable()) autonomousThread.join();\n    autonomousWakePending.store(false, std::memory_order_release);\n  }`,
`  void StopAutonomousProbeWorker() {\n    autonomousEnabled.store(false, std::memory_order_release);\n    // Signal stop without waiting for autonomousMutex. The render worker owns\n    // that mutex while inside a frame render; taking it here delays the stop\n    // flag until after an entire drain burst, defeating the per-frame check.\n    autonomousStop.store(true, std::memory_order_release);\n    autonomousCv.notify_all();\n    if (autonomousThread.joinable()) autonomousThread.join();\n    autonomousWakePending.store(false, std::memory_order_release);\n  }`,
  'publish stop before mutex wait');

if (s.includes('lock_guard<std::mutex> lock(autonomousMutex);\n      autonomousStop = true')) {
  throw new Error('mutex-gated stop publication survived');
}
for (const marker of [
  'autonomousStop.store(true, std::memory_order_release);',
  'if (player->autonomousStop.load(std::memory_order_acquire)) break;'
]) if (!s.includes(marker)) throw new Error(`stopfix-v2 marker missing: ${marker}`);

fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_AUTONOMOUS_STOPFIX_V2_OK publish=pre-mutex join=after-signal maxOvershoot=one-inflight');

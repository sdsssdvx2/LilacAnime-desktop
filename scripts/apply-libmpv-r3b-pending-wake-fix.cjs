'use strict';

const fs = require('node:fs');
const path = require('node:path');
const file = relative => path.resolve(__dirname, '..', relative);

let bridge = fs.readFileSync(file('electron/libmpv-shared-main.cjs'), 'utf8').replace(/\r\n/g, '\n');

const oldWake = `    if (pumpRunning) return;\n    metrics.nativeUpdateWakeups += 1;\n    void pump();`;
const newWake = `    if (pumpRunning) {\n      // A render update can race the tiny window after render_context_update()\n      // but before pumpRunning is cleared. Never drop that edge: a zero-delay\n      // timer survives the current pump's 250ms fallback scheduling and runs\n      // immediately on the next JS turn.\n      schedulePump(0);\n      return;\n    }\n    metrics.nativeUpdateWakeups += 1;\n    void pump();`;
const count = bridge.split(oldWake).length - 1;
if (count !== 1) throw new Error(`R3B pending-wake anchor count=${count}`);
bridge = bridge.replace(oldWake, newWake);

for (const marker of ['wakePumpFromNative', 'if (pumpRunning) {', 'schedulePump(0);', 'nativeUpdateCallbackInstalled ? 250']) {
  if (!bridge.includes(marker)) throw new Error(`R3B pending-wake marker missing: ${marker}`);
}
if (bridge.includes('await sharedTexture.sendSharedTexture')) throw new Error('R3B pending-wake fix regressed decoupled delivery');

fs.writeFileSync(file('electron/libmpv-shared-main.cjs'), bridge);
console.log('LIBMPV_R3B_PENDING_WAKE_OK race=pump-running wake=zero-delay-coalesced fallbackMs=250');

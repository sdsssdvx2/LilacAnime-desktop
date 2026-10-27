'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const originalBridge = path.join(root, 'electron', 'libmpv-shared-main.cjs');
const diagnosticBridge = path.join(root, 'electron', 'libmpv-shared-main.r37-flow-diagnostic.cjs');
const e2eScript = path.join(root, 'scripts', 'r37-explicit-handoff-e2e-smoke.cjs');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!fs.existsSync(originalBridge)) throw new Error(`R37 bridge missing: ${originalBridge}`);
if (!fs.existsSync(e2eScript)) throw new Error(`R37 E2E smoke missing: ${e2eScript}`);

let source = fs.readFileSync(originalBridge, 'utf8').replace(/\r\n/g, '\n');
if (!source.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK') ||
    !source.includes('LILAC_R37_TS_FN_RELEASE_SCOPE_REPAIRED')) {
  throw new Error('R37 flow diagnostic requires the post-repair R37 product bridge');
}

// Diagnostic-only copy. Product bridge/package bytes stay untouched. The counters
// identify the exact stage where post-focus mirrored producer frames disappear.
source = replaceOnce(
  source,
  `'use strict';\n`,
  `'use strict';\n\nconst r37FlowDiagnostic = {\n  poppedUpdated: 0,\n  lastFrameRecorded: 0,\n  pendingRegistered: 0,\n  importAttempts: 0,\n  importSucceeded: 0,\n  enqueueCalls: 0,\n  sendEntered: 0,\n  sendRejected: 0,\n  lastPoppedFrameId: 0,\n  lastRecordedFrameId: 0,\n  lastPendingFrameId: 0,\n  lastImportedFrameId: 0,\n  lastEnqueuedFrameId: 0,\n  lastSendEnteredFrameId: 0,\n  lastSendRejectedFrameId: 0,\n  postPopStage: 'idle',\n  postPopErrors: 0,\n  firstPostPopError: null,\n  lastPostPopError: null\n};\nfunction r37FlowFrameId(value) {\n  const n = Number(value);\n  return Number.isFinite(n) ? n : 0;\n}\nfunction r37FlowError(error, frameId) {\n  const record = {\n    frameId: r37FlowFrameId(frameId),\n    stage: String(r37FlowDiagnostic.postPopStage || 'unknown'),\n    message: String(error?.message || error).slice(0, 500),\n    stack: String(error?.stack || error?.message || error).slice(0, 2400)\n  };\n  r37FlowDiagnostic.postPopErrors += 1;\n  if (!r37FlowDiagnostic.firstPostPopError) r37FlowDiagnostic.firstPostPopError = record;\n  r37FlowDiagnostic.lastPostPopError = record;\n}\nprocess.once('exit', () => {\n  console.error('R37_FRAME_FLOW_DIAGNOSTIC_SUMMARY ' + JSON.stringify(r37FlowDiagnostic));\n});\n`,
  'R37 flow diagnostic module prologue'
);

source = replaceOnce(
  source,
  '    pumpRunning = true;\n',
  `    pumpRunning = true;\n    r37FlowDiagnostic.postPopStage = 'idle';\n`,
  'R37 flow pump stage reset'
);

const postPopBlock = `      metrics.nativeFrames += 1;\n      lastNativeFramePerfAt = performance.now();\n      advanceNativeFrameDeadline(lastNativeFramePerfAt);\n      nextDelay = frameProducerStarted ? R30_PRODUCER_JS_WATCHDOG_MS : nextActivePumpDelay(lastNativeFramePerfAt);\n      const frameNow = Date.now();\n      if (!metrics.firstFrameAt) metrics.firstFrameAt = frameNow;\n      metrics.lastFrameAt = frameNow;\n      metrics.lastFrameId = Number(nativeFrame.frameId) || metrics.lastFrameId;\n`;
const postPopInstrumented = `      metrics.nativeFrames += 1;\n      r37FlowDiagnostic.poppedUpdated += 1;\n      r37FlowDiagnostic.lastPoppedFrameId = r37FlowFrameId(nativeFrame?.frameId);\n      r37FlowDiagnostic.postPopStage = 'before-performance-now';\n      lastNativeFramePerfAt = performance.now();\n      r37FlowDiagnostic.postPopStage = 'before-advance-deadline';\n      advanceNativeFrameDeadline(lastNativeFramePerfAt);\n      r37FlowDiagnostic.postPopStage = 'before-next-delay';\n      nextDelay = frameProducerStarted ? R30_PRODUCER_JS_WATCHDOG_MS : nextActivePumpDelay(lastNativeFramePerfAt);\n      r37FlowDiagnostic.postPopStage = 'before-date-now';\n      const frameNow = Date.now();\n      r37FlowDiagnostic.postPopStage = 'before-first-frame-at';\n      if (!metrics.firstFrameAt) metrics.firstFrameAt = frameNow;\n      r37FlowDiagnostic.postPopStage = 'before-last-frame-at';\n      metrics.lastFrameAt = frameNow;\n      r37FlowDiagnostic.postPopStage = 'before-last-frame-id';\n      metrics.lastFrameId = Number(nativeFrame.frameId) || metrics.lastFrameId;\n      r37FlowDiagnostic.lastFrameRecorded += 1;\n      r37FlowDiagnostic.lastRecordedFrameId = r37FlowFrameId(nativeFrame?.frameId);\n      r37FlowDiagnostic.postPopStage = 'after-last-frame-id';\n`;
source = replaceOnce(source, postPopBlock, postPopInstrumented, 'R37 flow post-pop micro-stages');

source = replaceOnce(
  source,
  `    } catch (error) {\n      lastError = String(error?.message || error).slice(0, 220);\n    } finally {\n      pumpRunning = false;`,
  `    } catch (error) {\n      if (r37FlowDiagnostic.postPopStage !== 'idle' && r37FlowDiagnostic.postPopStage !== 'after-last-frame-id') {\n        r37FlowError(error, typeof nativeFrame !== 'undefined' ? nativeFrame?.frameId : 0);\n      }\n      lastError = String(error?.message || error).slice(0, 220);\n    } finally {\n      pumpRunning = false;`,
  'R37 flow outer pump exception capture'
);

// The pendingFrames.set payload gained fields across R29-R37 reconstruction.
// Anchor on the unique call itself instead of its historical one-line object shape.
source = replaceOnce(
  source,
  'pendingFrames.set(',
  `r37FlowDiagnostic.pendingRegistered += 1;\n      r37FlowDiagnostic.lastPendingFrameId = r37FlowFrameId(frameId);\n      pendingFrames.set(`,
  'R37 flow pending registration stage'
);

source = replaceOnce(
  source,
  '        imported = sharedTexture.importSharedTexture({\n',
  `        r37FlowDiagnostic.importAttempts += 1;\n        imported = sharedTexture.importSharedTexture({\n`,
  'R37 flow import attempt stage'
);

source = replaceOnce(
  source,
  '      const delivery = {\n',
  `      if (imported) {\n        r37FlowDiagnostic.importSucceeded += 1;\n        r37FlowDiagnostic.lastImportedFrameId = r37FlowFrameId(frameId);\n      }\n      const delivery = {\n`,
  'R37 flow import success stage'
);

source = replaceOnce(
  source,
  '  function enqueueImportedFrame(delivery) {\n',
  `  function enqueueImportedFrame(delivery) {\n    r37FlowDiagnostic.enqueueCalls += 1;\n    r37FlowDiagnostic.lastEnqueuedFrameId = r37FlowFrameId(delivery?.frameId);\n`,
  'R37 flow enqueue stage'
);

source = replaceOnce(
  source,
  '  async function sendImportedFrame(delivery) {\n',
  `  async function sendImportedFrame(delivery) {\n    r37FlowDiagnostic.sendEntered += 1;\n    r37FlowDiagnostic.lastSendEnteredFrameId = r37FlowFrameId(delivery?.frameId);\n`,
  'R37 flow send-enter stage'
);

source = replaceOnce(
  source,
  '      if (!active || ownerGeneration !== generation || ownerPlayerId !== playerId || !attachedWindow || attachedWindow.isDestroyed()) return;\n',
  `      if (!active || ownerGeneration !== generation || ownerPlayerId !== playerId || !attachedWindow || attachedWindow.isDestroyed()) {\n        r37FlowDiagnostic.sendRejected += 1;\n        r37FlowDiagnostic.lastSendRejectedFrameId = r37FlowFrameId(frameId);\n        return;\n      }\n`,
  'R37 flow send precondition stage'
);

// Keep this probe independent of any speculative mailbox variant. R37's stable
// diagnostics always contain regionNativeClears, while the mailbox escape has now
// been deliberately removed after run #46 identified the real release-scope fault.
const diagAnchor = '            regionNativeClears: r37PresenterRegionNativeClears';
source = replaceOnce(
  source,
  diagAnchor,
  `${diagAnchor},\n            frameFlowDiagnostic: { ...r37FlowDiagnostic }`,
  'R37 flow state diagnostics'
);

for (const marker of [
  'r37FlowDiagnostic.poppedUpdated',
  "postPopStage = 'before-advance-deadline'",
  'r37FlowError(error',
  'r37FlowDiagnostic.pendingRegistered',
  'r37FlowDiagnostic.importSucceeded',
  'r37FlowDiagnostic.enqueueCalls',
  'r37FlowDiagnostic.sendEntered',
  'frameFlowDiagnostic: { ...r37FlowDiagnostic }'
]) {
  if (!source.includes(marker)) throw new Error(`R37 flow diagnostic marker missing: ${marker}`);
}

fs.writeFileSync(diagnosticBridge, source, 'utf8');
const cleanupDiagnosticBridge = () => {
  try { fs.unlinkSync(diagnosticBridge); } catch {}
};
process.once('exit', cleanupDiagnosticBridge);

if (process.env.R37_NODE_API_DIAGNOSTIC_PREPARE_ONLY === '1') {
  console.log('R37_FRAME_FLOW_DIAGNOSTIC_PREPARE_OK stages=post-pop-micro+pending+import+enqueue+send productBytes=unchanged');
  process.exit(0);
}

const originalResolved = require.resolve(originalBridge);
require(diagnosticBridge);
const diagnosticResolved = require.resolve(diagnosticBridge);
const diagnosticModule = require.cache[diagnosticResolved];
if (!diagnosticModule) throw new Error('R37 flow diagnostic bridge module did not enter require cache');
require.cache[originalResolved] = diagnosticModule;

console.log('R37_FRAME_FLOW_DIAGNOSTIC_INSTALLED stages=post-pop-micro+pending+import+enqueue+send productBytes=unchanged');
require(e2eScript);

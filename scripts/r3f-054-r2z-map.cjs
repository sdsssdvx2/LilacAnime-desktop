'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = process.cwd();
const node = process.execPath;

function run(command, args = [], label = command) {
  console.log(`R3F_STAGE_RUN=${label}`);
  const result = cp.spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}
function runNode(script, label = script) {
  run(node, ['--check', script], `${label}:syntax`);
  run(node, [script], label);
}
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
function json(file) { return JSON.parse(read(file)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function markers(text, expected, label) {
  for (const marker of expected) assert(text.includes(marker), `${label} missing marker: ${marker}`);
}
function absent(text, forbidden, label) {
  for (const marker of forbidden) assert(!text.includes(marker), `${label} retained forbidden marker: ${marker}`);
}
function identity(version, tag, label) {
  const pkg = json('package.json');
  assert(pkg.version === version, `${label} version mismatch: ${pkg.version}`);
  assert(pkg.lilacCustomTag === tag, `${label} tag mismatch: ${pkg.lilacCustomTag}`);
  console.log(`R3F_IDENTITY_OK=${label} version=${version} tag=${tag}`);
}
function preserve054(label) {
  const ui = read('src/app.js') + read('src/player.js') + read('src/index.html');
  markers(ui, ['playerSeekHint', 'controlsOnPlaying', 'showSeekHint'], `${label} upstream UI`);
  const updater = read('electron/updater.cjs');
  markers(updater, ['CUSTOM_RELEASES_API', 'checkCustom()', "!MAC && !DEB && this.state.status === 'ready'"], `${label} updater`);
  assert(!fs.existsSync(path.join(root, 'electron/miruro-session.cjs')), `${label} resurrected obsolete Miruro session`);
  assert(fs.existsSync(path.join(root, 'electron/miruro-browser.cjs')), `${label} removed 0.5.54 Miruro browser`);
  markers(read('electron/main.cjs'), ["const API = 'https://api.tenrai.org/v1';"], `${label} Tenrai`);
  console.log(`R3F_0554_PRESERVE_OK=${label}`);
}
function patchR2WFor054() {
  const target = path.join(root, 'scripts', 'apply-libmpv-r2w-aspect-cadence.cjs');
  let source = fs.readFileSync(target, 'utf8');
  const oldBlock = `main = replaceOnce(main,\n  "  app,\\n  ipcMain,\\n  userAgent: ANDROID_WEBVIEW_UA,",\n  "  app,\\n  ipcMain,\\n  screen,\\n  userAgent: ANDROID_WEBVIEW_UA,",\n  'bridge screen injection');`;
  const newBlock = `main = replaceOnce(main,\n  "  userAgent: ANDROID_WEBVIEW_UA,",\n  "  screen,\\n  userAgent: ANDROID_WEBVIEW_UA,",\n  'bridge screen injection');`;
  const count = source.split(oldBlock).length - 1;
  assert(count === 1, `R2W 0.5.54 patch expected one historical screen-injection block, found ${count}`);
  source = source.replace(oldBlock, newBlock);
  fs.writeFileSync(target, source);
  console.log('R3F_0554_R2W_PATCH_OK screenAnchor=userAgent-only uniqueness=enforced');
}

// Authoritative R2M -> R2V reconstruction. The child intentionally checks out
// the pinned historical tooling commit while preserving branch-only 0.5.54
// compatibility helpers in temp files; when it returns, the working tree is the
// fully reconstructed R2V product and this parent process continues from memory.
runNode('scripts/r3f-054-r2v-map.cjs', 'R2V_AUTHORITATIVE_MAP');
identity('0.5.50-libmpv-r2v.rc1', 'libmpv-r2k-v0.5.50-r5', 'R2V_PARENT');
preserve054('R2V_PARENT');

patchR2WFor054();
runNode('scripts/apply-libmpv-r2w-aspect-cadence.cjs', 'R2W');
identity('0.5.50-libmpv-r2w.rc1', 'libmpv-r2k-v0.5.50-r6', 'R2W');
markers(read('electron/main.cjs'), ['LILAC_R2W_ASPECT_CADENCE'], 'R2W main');
markers(read('electron/libmpv-shared-preload.cjs'), ['createRollingCadenceTracker', 'observePresentationCadence(metadata)'], 'R2W preload');
preserve054('R2W');

runNode('scripts/apply-libmpv-r2x-vsync-fullscreen.cjs', 'R2X');
identity('0.5.50-libmpv-r2x.rc1', 'libmpv-r2k-v0.5.50-r7', 'R2X');
let preload = read('electron/libmpv-shared-preload.cjs');
markers(preload, ["presentationMode = 'raf-staged-copy'", 'stagingTexture', 'copyTextureToTexture'], 'R2X staged presenter');
preserve054('R2X');

runNode('scripts/apply-libmpv-r2x-pipeline-diagnostics.cjs', 'R2X_PIPELINE_DIAGNOSTICS');
runNode('scripts/rebundle-libmpv-r2x-preload.cjs', 'R2X_PRELOAD_REBUNDLE');
markers(read('electron/libmpv-shared-main.cjs'), ['nativeCadenceTracker', 'avgSendSharedTextureMs'], 'R2X pipeline bridge');
markers(read('electron/libmpv-shared-preload.cjs'), ['receiveCadenceTracker', 'lastReceiveCadence'], 'R2X pipeline preload');
preserve054('R2X_DIAGNOSTICS');

runNode('scripts/apply-libmpv-r2y-cadence-fix.cjs', 'R2Y_CADENCE');
identity('0.5.50-libmpv-r2y.rc1', 'libmpv-r2k-v0.5.50-r8', 'R2Y');
preload = read('electron/libmpv-shared-preload.cjs');
markers(preload, ["presentationMode = 'raf-warm-staged-copy'", 'ensureGpuPresentLoop', 'GPU_PRESENT_IDLE_STOP_MS = 500'], 'R2Y warm presenter');
let bridge = read('electron/libmpv-shared-main.cjs');
markers(bridge, ['ACTIVE_PUMP_RETRY_MS = 2', 'ACTIVE_PUMP_LEAD_MS = 6', 'nextActivePumpDelay'], 'R2Y phase pump');
preserve054('R2Y_CADENCE');

runNode('scripts/apply-libmpv-r2y-timestamp-phase.cjs', 'R2Y_TIMESTAMP_PHASE');
bridge = read('electron/libmpv-shared-main.cjs');
markers(bridge, ['pumpExpectedFps', 'refreshPumpTimingState', 'lastPumpStatePollPerfAt'], 'R2Y FPS phase');
absent(bridge, ['measuredIntervalMs', 'lastNativeTimestampUs'], 'R2Y FPS phase');
preserve054('R2Y_PHASE');

runNode('scripts/apply-libmpv-r2z-direct-present-ui-fixed.cjs', 'R2Z');
identity('0.5.50-libmpv-r2z.rc1', 'libmpv-r2k-v0.5.50-r9', 'R2Z');
preload = read('electron/libmpv-shared-preload.cjs');
markers(preload, [
  "presentationMode = 'direct-receive-webgpu-copy'",
  'copyExternalImageToTexture',
  'gpu.context.getCurrentTexture()',
  'observePresentationCadence(metadata, performance.now())'
], 'R2Z direct presenter');
absent(preload, [
  'stagingTexture', 'copyTextureToTexture', 'ensureGpuPresentLoop',
  'GPU_PRESENT_IDLE_STOP_MS', 'requestAnimationFrame(', 'setSharedTextureReceiver(async'
], 'R2Z direct presenter');
bridge = read('electron/libmpv-shared-main.cjs');
markers(bridge, [
  'ACTIVE_PUMP_RETRY_MS = 2', 'ACTIVE_PUMP_LEAD_MS = 6',
  'pumpExpectedFps', 'refreshPumpTimingState'
], 'R2Z phase-aware pump');
const css = read('src/player-android.css');
markers(css, [
  '.immersive-player .player-top { padding-right: 28px; }',
  '.immersive-player .player-settings { right: 16px; }'
], 'R2Z stable UI');
absent(css, [
  '.immersive-player.windowed .player-top',
  '.immersive-player.windowed .player-settings'
], 'R2Z stable UI');
const bundled = read('electron/preload-libmpv-shared.generated.cjs');
markers(bundled, ["direct-receive-webgpu-copy", 'copyExternalImageToTexture', 'receiveCadenceTracker'], 'R2Z bundled preload');
absent(bundled, ['stagingTexture', 'copyTextureToTexture', 'ensureGpuPresentLoop', 'requestAnimationFrame(', 'setSharedTextureReceiver(async'], 'R2Z bundled preload');
preserve054('R2Z');

console.log('R3F_0554_R2Z_MAP_OK chain=R2V-R2W-R2X-diagnostics-R2Y-phase-R2Z direct=1 rafGate=0 phasePump=1 uiStable=1');

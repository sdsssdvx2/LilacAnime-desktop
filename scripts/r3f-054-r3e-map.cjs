'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

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
function file(relative) { return path.join(root, relative); }
function read(relative) { return fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n'); }
function json(relative) { return JSON.parse(read(relative)); }
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
function sha256IfPresent(relative) {
  if (!fs.existsSync(file(relative))) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file(relative))).digest('hex');
}
function preserve054(label) {
  const ui = read('src/app.js') + read('src/player.js') + read('src/index.html');
  markers(ui, ['playerSeekHint', 'controlsOnPlaying', 'showSeekHint'], `${label} upstream UI`);

  const updater = read('electron/updater.cjs');
  markers(updater, ['CUSTOM_RELEASES_API', 'checkCustom()', "!MAC && !DEB && this.state.status === 'ready'"], `${label} updater`);

  assert(!fs.existsSync(file('electron/miruro-session.cjs')), `${label} resurrected obsolete Miruro session`);
  assert(fs.existsSync(file('electron/miruro-browser.cjs')), `${label} removed 0.5.54 Miruro browser`);

  const main = read('electron/main.cjs');
  markers(main, [
    "const API = 'https://api.tenrai.org/v1';",
    'LILAC_LIBMPV_SHARED_SOURCE_PATCH',
    'createLibmpvSharedBridge({',
    'await libmpvShared.ensure()',
    'await libmpvShared.attachWindow(win)'
  ], `${label} main/runtime wiring`);
  assert(!main.includes('api.jikan.moe'), `${label} resurrected Jikan runtime URL`);

  const preload = read('electron/preload.cjs');
  markers(preload, ['libmpvSharedOpen', 'libmpvSharedCommand', 'libmpvSharedState', 'libmpvSharedDiagnostics'], `${label} preload bridge`);

  const pkg = json('package.json');
  assert(pkg.build?.linux, `${label} lost Linux packaging`);
  assert(pkg.build?.deb, `${label} lost deb packaging`);
  console.log(`R3F_0554_PRESERVE_OK=${label} ui=seek+controls miruro=browser updater=custom+deb tenrai=1 sharedRuntime=1`);
}
function directPresenterInvariant(label) {
  const preload = read('electron/libmpv-shared-preload.cjs');
  markers(preload, [
    "presentationMode = 'direct-receive-webgpu-copy'",
    'copyExternalImageToTexture',
    'gpu.context.getCurrentTexture()',
    'observePresentationCadence(metadata, performance.now())'
  ], `${label} direct presenter`);
  absent(preload, [
    'stagingTexture', 'copyTextureToTexture', 'ensureGpuPresentLoop',
    'GPU_PRESENT_IDLE_STOP_MS', 'requestAnimationFrame(', 'setSharedTextureReceiver(async'
  ], `${label} direct presenter`);

  const bundled = read('electron/preload-libmpv-shared.generated.cjs');
  markers(bundled, ['direct-receive-webgpu-copy', 'copyExternalImageToTexture', 'receiveCadenceTracker'], `${label} bundled presenter`);
  absent(bundled, ['stagingTexture', 'copyTextureToTexture', 'ensureGpuPresentLoop', 'requestAnimationFrame(', 'setSharedTextureReceiver(async'], `${label} bundled presenter`);
  console.log(`R3F_DIRECT_PRESENTER_OK=${label} mode=direct-receive-webgpu-copy rafGate=0 sourceLifetime=immediate`);
}
function stageGuard(label) {
  preserve054(label);
  directPresenterInvariant(label);
}

runNode('scripts/r3f-054-r2z-map.cjs', 'R2Z_AUTHORITATIVE_MAP');
identity('0.5.50-libmpv-r2z.rc1', 'libmpv-r2k-v0.5.50-r9', 'R2Z_PARENT');
stageGuard('R2Z_PARENT');

const packagedNativeBefore = {
  addon: sha256IfPresent('electron/lilac-libmpv-player-bridge.node'),
  dll: sha256IfPresent('electron/libmpv-2.dll')
};

// R3A authoritative corrected sequence. The pinned transform uses bounded async
// delivery (12 pending frames), not the earlier experimental queue/tick constants.
runNode('scripts/apply-libmpv-r3a-decoupled-delivery.cjs', 'R3A_DECOUPLED');
identity('0.5.50-libmpv-r3a.rc1', 'libmpv-r2k-v0.5.50-r10', 'R3A_DECOUPLED');
runNode('scripts/apply-libmpv-r3a-poll-cadence-fix.cjs', 'R3A_POLL_CADENCE');
runNode('scripts/apply-libmpv-r3a-phase-deadline.cjs', 'R3A_PHASE_DEADLINE');
let bridge = read('electron/libmpv-shared-main.cjs');
markers(bridge, [
  'MAX_PENDING_DELIVERY_FRAMES = 12', 'async function deliverImportedFrame',
  'void deliverImportedFrame(delivery)', 'sendInvokeMaxMs',
  'nextNativeFrameDeadlinePerfAt', 'pumpPhaseCatchupPeriods', 'pumpPhaseLateMaxMs'
], 'R3A bridge');
runNode('scripts/smoke-libmpv-r3a-decoupled-delivery.cjs', 'R3A_SOURCE_SMOKE');
stageGuard('R3A');

runNode('scripts/apply-libmpv-r3b-update-callback.cjs', 'R3B_UPDATE_CALLBACK');
identity('0.5.50-libmpv-r3b.rc1', 'libmpv-r2k-v0.5.50-r11', 'R3B_CALLBACK');
runNode('scripts/apply-libmpv-r3b-pending-wake.cjs', 'R3B_PENDING_WAKE');
bridge = read('electron/libmpv-shared-main.cjs');
markers(bridge, ['nativeUpdateCallbackInstalled', 'wakePumpFromNative', 'nativeWakePending'], 'R3B bridge');
markers(read('native/libmpv-d3d11-bridge/player_addon.cc'), ['mpv_render_context_set_update_callback'], 'R3B native');
runNode('scripts/smoke-libmpv-r3b-update-callback.cjs', 'R3B_SOURCE_SMOKE');
stageGuard('R3B');

runNode('scripts/apply-libmpv-r3c-hotpath-state.cjs', 'R3C_HOTPATH_STATE');
identity('0.5.50-libmpv-r3c.rc1', 'libmpv-r2k-v0.5.50-r12', 'R3C');
bridge = read('electron/libmpv-shared-main.cjs');
markers(bridge, ['pollPlayback', 'nativeWakePending', 'nextNativeFrameDeadlinePerfAt'], 'R3C bridge');
markers(read('native/libmpv-d3d11-bridge/player_addon.cc'), ['PollPlayback'], 'R3C native');
stageGuard('R3C');

runNode('scripts/apply-libmpv-r3d-stall-isolation.cjs', 'R3D_STALL_ISOLATION');
identity('0.5.50-libmpv-r3d.rc1', 'libmpv-r2k-v0.5.50-r13', 'R3D');
bridge = read('electron/libmpv-shared-main.cjs');
markers(bridge, ['NO_FRAME_BURST_RETRIES = 3', 'NO_FRAME_BACKOFF_MS = 6', 'async function deliverImportedFrame'], 'R3D bridge');
const r3dNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
markers(r3dNative, ['nativeUpdateMs', 'nativeEnsureTextureMs', 'nativeRenderMs'], 'R3D native timing');
stageGuard('R3D');

runNode('scripts/normalize-libmpv-r3e-pending-anchor.cjs', 'R3E_COMPAT_NORMALIZE');
runNode('scripts/apply-libmpv-r3e-native-producer.cjs', 'R3E_NATIVE_PRODUCER');
identity('0.5.50-libmpv-r3e.rc1', 'libmpv-r2k-v0.5.50-r14', 'R3E');
bridge = read('electron/libmpv-shared-main.cjs');
markers(bridge, [
  'frameProducerStarted', 'startFrameProducer', 'popProducedFrame',
  'releaseProducedFrame', 'frameProducerStats'
], 'R3E bridge');
const r3eNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
markers(r3eNative, [
  'FrameProducerReadyFrame', 'StartFrameProducerWorker', 'producerRawWakeSignals',
  'producerWakePending', 'producerReady', 'startFrameProducer', 'popProducedFrame',
  'releaseProducedFrame', 'frameProducerStats'
], 'R3E native producer');
stageGuard('R3E');

const packagedNativeAfter = {
  addon: sha256IfPresent('electron/lilac-libmpv-player-bridge.node'),
  dll: sha256IfPresent('electron/libmpv-2.dll')
};
assert(packagedNativeAfter.addon === packagedNativeBefore.addon, `R3 mapping replaced packaged addon bytes: ${packagedNativeBefore.addon} -> ${packagedNativeAfter.addon}`);
assert(packagedNativeAfter.dll === packagedNativeBefore.dll, `R3 mapping replaced packaged DLL bytes: ${packagedNativeBefore.dll} -> ${packagedNativeAfter.dll}`);

console.log(`R3F_0554_R3E_MAP_OK chain=R2Z-R3A-R3B-pending-R3C-R3D-R3E direct=1 upstream054=preserved nativeSource=producer packagedNativeBytes=unchanged`);

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');
function once(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function replaceR37FreezeWithLiveNative(source) {
  const marker = '// LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF:';
  const markerCount = source.split(marker).length - 1;
  if (markerCount !== 1) throw new Error(`R41 live native presentation marker: expected exactly one R37 freeze marker, found ${markerCount}`);
  const markerIndex = source.indexOf(marker);
  const presentNeedle = 'R32PresentNativeFrame(player, slot, renderWidth, renderHeight);';
  const presentIndex = source.indexOf(presentNeedle, markerIndex);
  if (presentIndex < 0) throw new Error('R41 live native presentation: R32PresentNativeFrame missing after R37 freeze marker');
  const ifIndex = source.lastIndexOf('        if (', markerIndex);
  const closeNeedle = '\n        }';
  const closeIndex = source.indexOf(closeNeedle, presentIndex + presentNeedle.length);
  if (ifIndex < 0 || closeIndex < 0 || markerIndex - ifIndex > 700 || closeIndex - markerIndex > 700) {
    throw new Error('R41 live native presentation: R37 freeze block structural boundary missing');
  }
  const endIndex = closeIndex + closeNeedle.length;
  const block = source.slice(ifIndex, endIndex);
  for (const required of [
    'rc >= 0',
    'producerStop.load(std::memory_order_acquire)',
    'r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)',
    marker,
    presentNeedle
  ]) {
    if (!block.includes(required)) throw new Error(`R41 live native presentation: freeze block missing semantic anchor ${required}`);
  }
  const duplicatePresent = source.indexOf(presentNeedle, presentIndex + presentNeedle.length);
  if (duplicatePresent >= 0 && duplicatePresent < endIndex) throw new Error('R41 live native presentation: ambiguous native present call inside freeze block');
  const replacement = `        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {\n          // LILAC_R41_LIVE_NATIVE_HANDOFF: R40 has a separate transparent subtitle\n          // overlay and keeps libmpv sub-visibility=no, so the owned popup can keep\n          // presenting current video while Chromium is mirrored/recovering.\n          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }`;
  return source.slice(0, ifIndex) + replacement + source.slice(endIndex);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');
let preload = read('electron/libmpv-shared-preload.cjs');
const pkg = JSON.parse(read('package.json'));

for (const marker of [
  'LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF',
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY',
  'LILAC_R40_CALLBACK_AUTHORITATIVE_PRODUCER'
]) {
  if (!(native.includes(marker) || bridge.includes(marker) || preload.includes(marker))) {
    throw new Error(`R41 requires qualified R40/R37 baseline: ${marker}`);
  }
}
if (!preload.includes("presentationMode = 'direct-receive-webgpu-copy'") || !preload.includes('copyExternalImageToTexture')) {
  throw new Error('R41 requires focused direct WebGPU baseline');
}
if (native.includes('LILAC_R41_LIVE_NATIVE_HANDOFF') || preload.includes('LILAC_R41_VISUAL_HANDOFF_COMMIT')) {
  throw new Error('R41 visual handoff already applied');
}
for (const forbidden of ['copyTextureToTexture', 'focus-staged-gpu-copy', '--disable-direct-composition']) {
  if (native.includes(forbidden) || bridge.includes(forbidden) || preload.includes(forbidden)) throw new Error(`R41 refuses forbidden path: ${forbidden}`);
}

// R40 user recording + diagnostics proved the R37 freeze rule is now harmful:
// focused Chromium can receive its first frame and ACK within a few milliseconds,
// then suffer a 648-776 ms supply gap. R40 also permanently suppresses native
// subtitle pixels, so the old reason for freezing the visible native frame no
// longer exists. Keep the owned popup presenting current VIDEO while the same
// frames are mirrored into Chromium. It remains the visual safety surface until
// the renderer proves a sustained direct-WebGPU cadence.
native = replaceR37FreezeWithLiveNative(native);

// Tell the renderer whether this epoch needs sustained moving-video proof. The
// cached playback state is sufficient here; pause/speed commands invalidate that
// cache in the existing R31 path. No new native poll is added to the hot path.
bridge = once(
  bridge,
  `          r37HandoffEpoch: r34FocusHandoffPending ? r37PendingHandoffEpoch : 0\n        });`,
  `          r37HandoffEpoch: r34FocusHandoffPending ? r37PendingHandoffEpoch : 0,\n          r41HandoffPlaying: r34FocusHandoffPending ? !(lastState?.paused === true) : false\n        });`,
  'R41 handoff playback-state metadata'
);

// Renderer-side visual-commit state. This is active only for a pending handoff;
// normal focused direct-WebGPU frames pay only the existing copy path.
preload = once(
  preload,
  `let lastGpuError = null;`,
  `let lastGpuError = null;\nlet r41HandoffEpoch = 0; // LILAC_R41_VISUAL_HANDOFF_COMMIT\nlet r41HandoffStableStartedAt = 0;\nlet r41HandoffLastFrameAt = 0;\nlet r41HandoffLastFrameId = 0;\nlet r41HandoffAckScheduledEpoch = 0;\nlet r41HandoffStableResets = 0;\nlet r41HandoffVisualCommits = 0;`,
  'R41 visual commit state'
);

const ackHelper = String.raw`
function r41ScheduleVisualHandoffAck(metadata) {
  const epoch = Number(metadata?.r37HandoffEpoch) || 0;
  const frameId = Number(metadata?.frameId) || 0;
  if (epoch <= 0 || frameId <= 0) return;
  const now = performance.now();
  if (epoch !== r41HandoffEpoch) {
    r41HandoffEpoch = epoch;
    r41HandoffStableStartedAt = now;
    r41HandoffLastFrameAt = now;
    r41HandoffLastFrameId = 0;
    r41HandoffAckScheduledEpoch = 0;
  }
  if (frameId <= r41HandoffLastFrameId) return;
  const expectedFps = Math.max(1, Number(metadata?.fps) || 24);
  const maxStableGapMs = Math.max(100, (1000 / expectedFps) * 2.5);
  if (r41HandoffLastFrameId > 0 && now - r41HandoffLastFrameAt > maxStableGapMs) {
    // Real R40 hardware hit 648-776 ms here after refocus. Restart the stability
    // window and keep the live native popup covering the Chromium gap.
    r41HandoffStableStartedAt = now;
    r41HandoffStableResets += 1;
  }
  r41HandoffLastFrameAt = now;
  r41HandoffLastFrameId = frameId;

  const playing = metadata?.r41HandoffPlaying === true;
  const stableForMs = Math.max(0, now - r41HandoffStableStartedAt);
  if (playing && stableForMs < 250) return;
  if (r41HandoffAckScheduledEpoch === epoch) return;
  r41HandoffAckScheduledEpoch = epoch;

  const payload = {
    epoch,
    playerId: Number(metadata?.playerId) || 0,
    generation: Number(metadata?.generation) || 0,
    frameId,
    marker: 'LILAC_R41_VISUAL_HANDOFF_COMMIT',
    stableForMs,
    stableResets: r41HandoffStableResets
  };
  const commit = () => {
    if (Number(metadata?.r37HandoffEpoch) !== r41HandoffEpoch) return;
    if (typeof document !== 'undefined' && document.hasFocus && !document.hasFocus()) return;
    r41HandoffVisualCommits += 1;
    try { ipcRenderer.send('libmpv-shared:r37-handoff-presented', payload); } catch {}
  };
  // A successful WebGPU copy is submission, not visible Chromium composition.
  // Cross two compositor animation boundaries before allowing main to hide the
  // live native popup. This runs once per handoff epoch, never once per frame.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(commit));
  } else {
    setTimeout(commit, 34);
  }
}

`;
const sendStatsIndex = preload.indexOf('function sendStats(');
if (sendStatsIndex < 0) throw new Error('R41 sendStats insertion boundary missing');
preload = preload.slice(0, sendStatsIndex) + ackHelper + preload.slice(sendStatsIndex);

const oldAck = `      if (r37HandoffCopied && Number(metadata?.r37HandoffEpoch) > 0) {\n        try {\n          ipcRenderer.send('libmpv-shared:r37-handoff-presented', {\n            epoch: Number(metadata.r37HandoffEpoch),\n            playerId: Number(metadata.playerId) || 0,\n            generation: Number(metadata.generation) || 0,\n            frameId: Number(metadata.frameId) || 0\n          });\n        } catch {}\n      }`;
preload = once(
  preload,
  oldAck,
  `      if (r37HandoffCopied && Number(metadata?.r37HandoffEpoch) > 0) {\n        r41ScheduleVisualHandoffAck(metadata);\n      }`,
  'R41 defer R37 ACK until sustained visual commit'
);

if (pkg.version !== '0.5.54-libmpv-r3f.rc20' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.54-r40') {
  throw new Error(`R41 expected R40 identity, got ${pkg.version} ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.54-libmpv-r3f.rc21';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.54-r41';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R41-Setup.${ext}';

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
write('electron/libmpv-shared-preload.cjs', preload);
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

const preloadEntry = file('electron/preload-libmpv-shared-entry.generated.cjs');
const preloadBundle = file('electron/preload-libmpv-shared.generated.cjs');
if (!fs.existsSync(preloadEntry)) throw new Error('R41 generated preload entry missing');
buildSync({
  entryPoints: [preloadEntry], outfile: preloadBundle, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'info'
});

const finalNative = read('native/libmpv-d3d11-bridge/player_addon.cc');
const finalBridge = read('electron/libmpv-shared-main.cjs');
const finalPreload = read('electron/libmpv-shared-preload.cjs');
const finalBundle = read('electron/preload-libmpv-shared.generated.cjs');
for (const marker of ['LILAC_R41_LIVE_NATIVE_HANDOFF']) if (!finalNative.includes(marker)) throw new Error(`R41 native marker missing ${marker}`);
for (const marker of ['r41HandoffPlaying']) if (!finalBridge.includes(marker)) throw new Error(`R41 bridge marker missing ${marker}`);
for (const marker of ['LILAC_R41_VISUAL_HANDOFF_COMMIT','r41ScheduleVisualHandoffAck','r41HandoffStableStartedAt','requestAnimationFrame(() => requestAnimationFrame(commit))']) {
  if (!finalPreload.includes(marker)) throw new Error(`R41 preload marker missing ${marker}`);
}
for (const marker of ['LILAC_R41_VISUAL_HANDOFF_COMMIT','r41ScheduleVisualHandoffAck']) if (!finalBundle.includes(marker)) throw new Error(`R41 bundled preload marker missing ${marker}`);
if (finalNative.includes('LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF')) throw new Error('R41 retained R37 native freeze marker');
for (const forbidden of ['copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition']) {
  if (finalNative.includes(forbidden) || finalBridge.includes(forbidden) || finalPreload.includes(forbidden)) throw new Error(`R41 introduced forbidden path ${forbidden}`);
}
console.log('R41_VISUAL_HANDOFF_CONTINUITY_OK native=live-during-mirror focused=direct-webgpu ack=sustained-250ms+double-raf paused=single-frame+double-raf r25=absent r28=absent');

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
  // Locate the generated R37 freeze by executable semantics, not by its comment.
  // R40/R41 compatibility transforms may preserve the condition while moving or
  // rewriting comments, so a marker-only anchor is intentionally forbidden here.
  const conditionNeedle = `        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire) &&\n            !player->r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)) {`;
  const conditionCount = source.split(conditionNeedle).length - 1;
  if (conditionCount !== 1) {
    throw new Error(`R41 live native presentation semantic condition: expected exactly one R37 freeze condition, found ${conditionCount}`);
  }
  const ifIndex = source.indexOf(conditionNeedle);
  const presentNeedle = 'R32PresentNativeFrame(player, slot, renderWidth, renderHeight);';
  const presentIndex = source.indexOf(presentNeedle, ifIndex + conditionNeedle.length);
  if (presentIndex < 0 || presentIndex - ifIndex > 900) {
    throw new Error('R41 live native presentation: nearby R32PresentNativeFrame missing after semantic R37 freeze condition');
  }
  const closeNeedle = '\n        }';
  const closeIndex = source.indexOf(closeNeedle, presentIndex + presentNeedle.length);
  if (closeIndex < 0 || closeIndex - ifIndex > 1100) {
    throw new Error('R41 live native presentation: semantic R37 freeze block boundary missing');
  }
  const endIndex = closeIndex + closeNeedle.length;
  const block = source.slice(ifIndex, endIndex);
  for (const required of [
    'rc >= 0',
    'producerStop.load(std::memory_order_acquire)',
    'r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)',
    presentNeedle
  ]) {
    if (!block.includes(required)) throw new Error(`R41 live native presentation: freeze block missing semantic anchor ${required}`);
  }
  const replacement = `        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {\n          // LILAC_R41_LIVE_NATIVE_HANDOFF: R40 has a separate transparent subtitle\n          // overlay and keeps libmpv sub-visibility=no, so the owned popup can keep\n          // presenting current video while Chromium is mirrored/recovering.\n          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }`;
  return source.slice(0, ifIndex) + replacement + source.slice(endIndex);
}
function replaceR37RendererAckWithVisualCommit(source) {
  // Locate the R37 ACK by the unique IPC send and its enclosing copied-frame
  // guard. R40 may alter whitespace/comments around release bookkeeping, so the
  // exact multiline source is deliberately not an anchor.
  const sendNeedle = "ipcRenderer.send('libmpv-shared:r37-handoff-presented'";
  const sendCount = source.split(sendNeedle).length - 1;
  if (sendCount !== 1) {
    throw new Error(`R41 renderer ACK semantic send: expected exactly one R37 handoff send, found ${sendCount}`);
  }
  const sendIndex = source.indexOf(sendNeedle);
  const guardNeedle = 'if (r37HandoffCopied';
  const guardCount = source.split(guardNeedle).length - 1;
  if (guardCount !== 1) {
    throw new Error(`R41 renderer ACK semantic guard: expected exactly one copied-frame guard, found ${guardCount}`);
  }
  const ifIndex = source.lastIndexOf(guardNeedle, sendIndex);
  if (ifIndex < 0 || sendIndex - ifIndex > 900) {
    throw new Error('R41 renderer ACK semantic guard missing near R37 handoff send');
  }
  const openIndex = source.indexOf('{', ifIndex);
  if (openIndex < 0 || openIndex > sendIndex) throw new Error('R41 renderer ACK opening brace missing');

  // This generated block has nested object/catch braces. Match the enclosing
  // guard structurally while ignoring braces inside quoted strings/comments.
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let closeIndex = -1;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1] || '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { closeIndex = i; break; }
    }
  }
  if (closeIndex < 0 || closeIndex - ifIndex > 1400) {
    throw new Error('R41 renderer ACK semantic block boundary missing');
  }
  const block = source.slice(ifIndex, closeIndex + 1);
  for (const required of [
    'r37HandoffCopied',
    'r37HandoffEpoch',
    sendNeedle,
    'playerId',
    'generation',
    'frameId'
  ]) {
    if (!block.includes(required)) throw new Error(`R41 renderer ACK block missing semantic anchor ${required}`);
  }
  const lineStart = source.lastIndexOf('\n', ifIndex) + 1;
  const indent = source.slice(lineStart, ifIndex);
  if (!/^\s*$/.test(indent)) throw new Error('R41 renderer ACK indentation boundary invalid');
  const replacement = `${indent}if (r37HandoffCopied && Number(metadata?.r37HandoffEpoch) > 0) {\n${indent}  r41ScheduleVisualHandoffAck(metadata);\n${indent}}`;
  return source.slice(0, lineStart) + replacement + source.slice(closeIndex + 1);
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
preload = replaceR37RendererAckWithVisualCommit(preload);

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
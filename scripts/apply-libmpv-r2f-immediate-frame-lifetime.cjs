'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const found = source.split(needle).length - 1;
  if (found !== 1) throw new Error(`${label}: expected exactly one anchor, found ${found}`);
  return source.replace(needle, replacement);
}

function replaceAllExpected(source, needle, replacement, expected, label) {
  const found = source.split(needle).length - 1;
  if (found !== expected) throw new Error(`${label}: expected ${expected} anchors, found ${found}`);
  return source.split(needle).join(replacement);
}

const QUALIFICATION_ID = 'LILAC-LIBMPV-HWQ-R2F-IMMEDIATE';

// R2C currently chains R2D, which reintroduces an async sharedTexture receiver
// and holds each VideoFrame/imported texture for two compositor turns. The user's
// Electron 43 hardware result showed ~1.13 s average release latency, 19 pending
// frames, and Chromium's manual-destruction warning. This qualification keeps the
// exact Electron 43.8.1 baseline and removes only that R2D hold so we can isolate
// the lifetime rule from an Electron-version change.
let preload = read('electron/libmpv-shared-preload.cjs');
preload = replaceOnce(
  preload,
  `let maxDrawMs = 0;\n\nconst nextCompositorTurn = () => new Promise(resolve => requestAnimationFrame(resolve));\n`,
  `let maxDrawMs = 0;\nlet videoFramesCreated = 0;\nlet videoFramesClosed = 0;\nlet activeVideoFrames = 0;\nlet videoFrameCloseFailures = 0;\nlet textureReleaseCalls = 0;\nlet textureReleaseFailures = 0;\n`,
  'remove R2D compositor helper and add lifetime counters'
);
preload = replaceOnce(
  preload,
  `  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata = {}) => {`,
  `  sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }, metadata = {}) => {`,
  'restore synchronous sharedTexture receiver'
);
preload = replaceOnce(
  preload,
  `      avgDrawMs: drawSamples ? Math.round((drawTotalMs / drawSamples) * 1000) / 1000 : 0,\n      ...extra`,
  `      avgDrawMs: drawSamples ? Math.round((drawTotalMs / drawSamples) * 1000) / 1000 : 0,\n      videoFramesCreated,\n      videoFramesClosed,\n      activeVideoFrames,\n      videoFrameCloseFailures,\n      textureReleaseCalls,\n      textureReleaseFailures,\n      ...extra`,
  'receiver lifetime stats'
);
preload = replaceOnce(
  preload,
  `      frame = importedSharedTexture.getVideoFrame();\n      const drawStarted = performance.now();`,
  `      frame = importedSharedTexture.getVideoFrame();\n      videoFramesCreated += 1;\n      activeVideoFrames += 1;\n      const drawStarted = performance.now();`,
  'VideoFrame create accounting'
);
preload = replaceOnce(
  preload,
  `      // Local Windows shared-texture probing proved that closing the VideoFrame\n      // immediately after drawImage can leave a stale frame. Keep the producer\n      // texture alive for two compositor turns, as the proven-safe path did.\n      // R2C expands the native pool to 24 slots, so this lifetime no longer\n      // starves a 23.976/30/60fps producer the way the old three-slot pool did.\n      await nextCompositorTurn();\n      await nextCompositorTurn();\n      presentedFrames += 1;`,
  `      // R2F qualification: drawImage has queued the GPU-backed draw. Close the\n      // VideoFrame and release the imported texture in this same receiver turn so\n      // producer ownership cannot accumulate behind compositor callbacks.\n      presentedFrames += 1;`,
  'remove R2D two-compositor-turn hold'
);
preload = replaceOnce(
  preload,
  `    } finally {\n      try { frame?.close?.(); } catch {}\n      try { importedSharedTexture?.release?.(); } catch {}\n    }`,
  `    } finally {\n      let lifetimeFailure = false;\n      try {\n        if (frame?.close) {\n          frame.close();\n          videoFramesClosed += 1;\n          activeVideoFrames = Math.max(0, activeVideoFrames - 1);\n        }\n      } catch {\n        videoFrameCloseFailures += 1;\n        lifetimeFailure = true;\n      }\n      try {\n        if (importedSharedTexture?.release) {\n          importedSharedTexture.release();\n          textureReleaseCalls += 1;\n        }\n      } catch {\n        textureReleaseFailures += 1;\n        lifetimeFailure = true;\n      }\n      if (lifetimeFailure) {\n        sendStats({\n          lastFrameId: Number(metadata?.frameId) || 0,\n          reason: 'lifetime-release-failed'\n        }, true);\n      }\n    }`,
  'explicit immediate VideoFrame and imported texture release accounting'
);
write('electron/libmpv-shared-preload.cjs', preload);

let bridge = read('electron/libmpv-shared-main.cjs');
bridge = replaceOnce(
  bridge,
  `        drawFailures: numeric('drawFailures'),\n        lastFrameAt: numeric('lastFrameAt'),`,
  `        drawFailures: numeric('drawFailures'),\n        videoFramesCreated: numeric('videoFramesCreated'),\n        videoFramesClosed: numeric('videoFramesClosed'),\n        activeVideoFrames: numeric('activeVideoFrames'),\n        videoFrameCloseFailures: numeric('videoFrameCloseFailures'),\n        textureReleaseCalls: numeric('textureReleaseCalls'),\n        textureReleaseFailures: numeric('textureReleaseFailures'),\n        lastFrameAt: numeric('lastFrameAt'),`,
  'bridge lifetime stats parser'
);
write('electron/libmpv-shared-main.cjs', bridge);

let qualification = read('electron/libmpv-hardware-qualification.cjs');
qualification = replaceAllExpected(
  qualification,
  `'LILAC-LIBMPV-HWQ-R1'`,
  `'${QUALIFICATION_ID}'`,
  2,
  'qualification id'
);
qualification = replaceOnce(
  qualification,
  `    immediateFrameRelease: !preload.includes('await nextFrame()') && !preload.includes('const nextFrame'),`,
  `    immediateFrameRelease: !preload.includes('await nextFrame()') && !preload.includes('const nextFrame') && !preload.includes('nextCompositorTurn') && !preload.includes('setSharedTextureReceiver(async'),`,
  'strict immediate lifetime architecture marker'
);
qualification = replaceOnce(
  qualification,
  `    drawDiagnostics: preload.includes('avgDrawMs'),`,
  `    drawDiagnostics: preload.includes('avgDrawMs'),\n    lifetimeDiagnostics: preload.includes('activeVideoFrames') && preload.includes('videoFrameCloseFailures') && preload.includes('textureReleaseFailures'),`,
  'qualification lifetime diagnostics architecture marker'
);
qualification = replaceOnce(
  qualification,
  `      drawFailures: Number(end?.receiver?.drawFailures || 0)\n    };`,
  `      drawFailures: Number(end?.receiver?.drawFailures || 0),\n      videoFramesCreated: Number(end?.receiver?.videoFramesCreated || 0),\n      videoFramesClosed: Number(end?.receiver?.videoFramesClosed || 0),\n      activeVideoFrames: Number(end?.receiver?.activeVideoFrames || 0),\n      videoFrameCloseFailures: Number(end?.receiver?.videoFrameCloseFailures || 0),\n      textureReleaseCalls: Number(end?.receiver?.textureReleaseCalls || 0),\n      textureReleaseFailures: Number(end?.receiver?.textureReleaseFailures || 0)\n    };`,
  'qualification throughput lifetime metrics'
);
qualification = replaceOnce(
  qualification,
  `    if (presentedFps < MIN_PRESENT_FPS) throw new Error(\`presented FPS below release threshold: \${throughput.measuredPresentedFps}\`);`,
  `    const unclosedVideoFrames = Math.max(0, throughput.videoFramesCreated - throughput.videoFramesClosed);\n    if (throughput.videoFrameCloseFailures !== 0) throw new Error(\`VideoFrame close failures: \${throughput.videoFrameCloseFailures}\`);\n    if (throughput.textureReleaseFailures !== 0) throw new Error(\`shared texture release call failures: \${throughput.textureReleaseFailures}\`);\n    if (unclosedVideoFrames > 1) throw new Error(\`VideoFrame lifetime leak detected: created=\${throughput.videoFramesCreated} closed=\${throughput.videoFramesClosed}\`);\n    if (presentedFps < MIN_PRESENT_FPS) throw new Error(\`presented FPS below release threshold: \${throughput.measuredPresentedFps}\`);`,
  'qualification lifetime gates before throughput gate'
);
qualification = replaceOnce(
  qualification,
  `          maxDrawMs: Number(state?.receiver?.maxDrawMs || 0)\n        },`,
  `          maxDrawMs: Number(state?.receiver?.maxDrawMs || 0),\n          videoFramesCreated: Number(state?.receiver?.videoFramesCreated || 0),\n          videoFramesClosed: Number(state?.receiver?.videoFramesClosed || 0),\n          activeVideoFrames: Number(state?.receiver?.activeVideoFrames || 0),\n          videoFrameCloseFailures: Number(state?.receiver?.videoFrameCloseFailures || 0),\n          textureReleaseCalls: Number(state?.receiver?.textureReleaseCalls || 0),\n          textureReleaseFailures: Number(state?.receiver?.textureReleaseFailures || 0)\n        },`,
  'qualification failure lifetime diagnostics'
);
write('electron/libmpv-hardware-qualification.cjs', qualification);

const finalPreload = read('electron/libmpv-shared-preload.cjs');
for (const forbidden of ['nextCompositorTurn', 'setSharedTextureReceiver(async']) {
  if (finalPreload.includes(forbidden)) throw new Error(`R2F forbidden lifetime marker remains: ${forbidden}`);
}
for (const marker of [
  'setSharedTextureReceiver(({ importedSharedTexture }',
  'videoFramesCreated',
  'videoFramesClosed',
  'videoFrameCloseFailures',
  'textureReleaseCalls',
  'textureReleaseFailures',
  "reason: 'lifetime-release-failed'"
]) {
  if (!finalPreload.includes(marker)) throw new Error(`R2F preload marker missing: ${marker}`);
}
const finalQualification = read('electron/libmpv-hardware-qualification.cjs');
for (const marker of [QUALIFICATION_ID, 'lifetimeDiagnostics', "!preload.includes('nextCompositorTurn')", 'VideoFrame lifetime leak detected']) {
  if (!finalQualification.includes(marker)) throw new Error(`R2F qualification marker missing: ${marker}`);
}

console.log('LIBMPV_R2F_IMMEDIATE_FRAME_LIFETIME_OK electron=43.8.1 compositorHold=0');

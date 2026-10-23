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

const ELECTRON_VERSION = '44.9.3';
const QUALIFICATION_ID = 'LILAC-LIBMPV-HWQ-R2-E44';

// Keep the production branch untouched: this transform is only invoked by the
// isolated Electron 44 hardware qualification workflow. Electron 44.1+ carries
// sharedTexture lifetime fixes that are absent from Electron 43.x, and 44.4.1+
// additionally releases imported textures on their owning sequence.
let integration = read('scripts/apply-libmpv-shared-texture.cjs');
integration = replaceAllExpected(integration, `'43.8.1'`, `'${ELECTRON_VERSION}'`, 2, 'Electron pin in shared integration');
integration = replaceOnce(integration, `target: 'chrome150'`, `target: 'chrome152'`, 'Chromium target for Electron 44');
write('scripts/apply-libmpv-shared-texture.cjs', integration);

let preload = read('electron/libmpv-shared-preload.cjs');
preload = replaceOnce(
  preload,
  `let maxDrawMs = 0;`,
  `let maxDrawMs = 0;\nlet videoFramesCreated = 0;\nlet videoFramesClosed = 0;\nlet activeVideoFrames = 0;\nlet videoFrameCloseFailures = 0;\nlet textureReleaseCalls = 0;\nlet textureReleaseFailures = 0;`,
  'receiver lifetime counters'
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
  `    } finally {\n      try { frame?.close?.(); } catch {}\n      try { importedSharedTexture?.release?.(); } catch {}\n    }`,
  `    } finally {\n      let lifetimeFailure = false;\n      try {\n        if (frame?.close) {\n          frame.close();\n          videoFramesClosed += 1;\n          activeVideoFrames = Math.max(0, activeVideoFrames - 1);\n        }\n      } catch {\n        videoFrameCloseFailures += 1;\n        lifetimeFailure = true;\n      }\n      try {\n        if (importedSharedTexture?.release) {\n          importedSharedTexture.release();\n          textureReleaseCalls += 1;\n        }\n      } catch {\n        textureReleaseFailures += 1;\n        lifetimeFailure = true;\n      }\n      if (lifetimeFailure) {\n        sendStats({\n          lastFrameId: Number(metadata?.frameId) || 0,\n          reason: 'lifetime-release-failed'\n        }, true);\n      }\n    }`,
  'explicit VideoFrame and shared texture lifetime accounting'
);
write('electron/libmpv-shared-preload.cjs', preload);

let bridge = read('electron/libmpv-shared-main.cjs');
bridge = replaceOnce(
  bridge,
  `        drawFailures: numeric('drawFailures'),\n        lastFrameAt: numeric('lastFrameAt'),`,
  `        drawFailures: numeric('drawFailures'),\n        videoFramesCreated: numeric('videoFramesCreated'),\n        videoFramesClosed: numeric('videoFramesClosed'),\n        activeVideoFrames: numeric('activeVideoFrames'),\n        videoFrameCloseFailures: numeric('videoFrameCloseFailures'),\n        textureReleaseCalls: numeric('textureReleaseCalls'),\n        textureReleaseFailures: numeric('textureReleaseFailures'),\n        lastFrameAt: numeric('lastFrameAt'),`,
  'bridge receiver lifetime stats'
);
write('electron/libmpv-shared-main.cjs', bridge);

let qualification = read('electron/libmpv-hardware-qualification.cjs');
qualification = replaceOnce(
  qualification,
  `const EXPECTED_ELECTRON = '43.8.1';`,
  `const EXPECTED_ELECTRON = '${ELECTRON_VERSION}';`,
  'qualification Electron pin'
);
qualification = replaceAllExpected(
  qualification,
  `'LILAC-LIBMPV-HWQ-R1'`,
  `'${QUALIFICATION_ID}'`,
  2,
  'qualification id'
);
qualification = replaceOnce(
  qualification,
  `    drawDiagnostics: preload.includes('avgDrawMs'),`,
  `    drawDiagnostics: preload.includes('avgDrawMs'),\n    lifetimeDiagnostics: preload.includes('activeVideoFrames') && preload.includes('videoFrameCloseFailures') && preload.includes('textureReleaseFailures'),`,
  'qualification architecture lifetime marker'
);
qualification = replaceOnce(
  qualification,
  `      drawFailures: Number(end?.receiver?.drawFailures || 0)\n    };`,
  `      drawFailures: Number(end?.receiver?.drawFailures || 0),\n      videoFramesCreated: Number(end?.receiver?.videoFramesCreated || 0),\n      videoFramesClosed: Number(end?.receiver?.videoFramesClosed || 0),\n      activeVideoFrames: Number(end?.receiver?.activeVideoFrames || 0),\n      videoFrameCloseFailures: Number(end?.receiver?.videoFrameCloseFailures || 0),\n      textureReleaseCalls: Number(end?.receiver?.textureReleaseCalls || 0),\n      textureReleaseFailures: Number(end?.receiver?.textureReleaseFailures || 0)\n    };`,
  'qualification throughput lifetime metrics'
);
qualification = replaceOnce(
  qualification,
  `    if (presentedFps < MIN_PRESENT_FPS) throw new Error(\`presented FPS below release threshold: ${'${throughput.measuredPresentedFps}'}\`);`,
  `    const unclosedVideoFrames = Math.max(0, throughput.videoFramesCreated - throughput.videoFramesClosed);\n    if (throughput.videoFrameCloseFailures !== 0) throw new Error(\`VideoFrame close failures: ${'${throughput.videoFrameCloseFailures}'}\`);\n    if (throughput.textureReleaseFailures !== 0) throw new Error(\`shared texture release call failures: ${'${throughput.textureReleaseFailures}'}\`);\n    if (unclosedVideoFrames > 1) throw new Error(\`VideoFrame lifetime leak detected: created=${'${throughput.videoFramesCreated}'} closed=${'${throughput.videoFramesClosed}'}\`);\n    if (presentedFps < MIN_PRESENT_FPS) throw new Error(\`presented FPS below release threshold: ${'${throughput.measuredPresentedFps}'}\`);`,
  'qualification lifetime gates'
);
qualification = replaceOnce(
  qualification,
  `          maxDrawMs: Number(state?.receiver?.maxDrawMs || 0)\n        },`,
  `          maxDrawMs: Number(state?.receiver?.maxDrawMs || 0),\n          videoFramesCreated: Number(state?.receiver?.videoFramesCreated || 0),\n          videoFramesClosed: Number(state?.receiver?.videoFramesClosed || 0),\n          activeVideoFrames: Number(state?.receiver?.activeVideoFrames || 0),\n          videoFrameCloseFailures: Number(state?.receiver?.videoFrameCloseFailures || 0),\n          textureReleaseCalls: Number(state?.receiver?.textureReleaseCalls || 0),\n          textureReleaseFailures: Number(state?.receiver?.textureReleaseFailures || 0)\n        },`,
  'qualification failure lifetime diagnostics'
);
write('electron/libmpv-hardware-qualification.cjs', qualification);

for (const [relative, markers] of [
  ['scripts/apply-libmpv-shared-texture.cjs', [`'${ELECTRON_VERSION}'`, "target: 'chrome152'"]],
  ['electron/libmpv-shared-preload.cjs', ['videoFramesCreated', 'videoFramesClosed', 'videoFrameCloseFailures', 'textureReleaseFailures', "reason: 'lifetime-release-failed'"]],
  ['electron/libmpv-shared-main.cjs', ["numeric('videoFramesCreated')", "numeric('textureReleaseFailures')"]],
  ['electron/libmpv-hardware-qualification.cjs', [`const EXPECTED_ELECTRON = '${ELECTRON_VERSION}'`, QUALIFICATION_ID, 'lifetimeDiagnostics', 'VideoFrame lifetime leak detected']]
]) {
  const source = read(relative);
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${relative} missing R3 marker: ${marker}`);
  }
}

console.log(`LIBMPV_R3_ELECTRON44_LIFETIME_DIAGNOSTICS_OK electron=${ELECTRON_VERSION}`);

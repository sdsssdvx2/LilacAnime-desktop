'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r37-explicit-handoff-clean-focus.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

// Qualified R36 still carries the R26/R27 frame metadata after displayFrequency.
// Insert R37's epoch after the final R27 field rather than assuming the old R24
// object shape. This preserves every existing diagnostic field.
replaceOnce(
  "  '          displayFrequency\\n        });',\n  `          displayFrequency,\n          r37HandoffEpoch: r34FocusHandoffPending ? r37PendingHandoffEpoch : 0\n        });`,",
  "  '          r27DispatchGapMs\\n        });',\n  `          r27DispatchGapMs,\n          r37HandoffEpoch: r34FocusHandoffPending ? r37PendingHandoffEpoch : 0\n        });`,",
  'R37 qualified-R36 metadata anchor'
);

// R33 inserted native-ownership bookkeeping immediately before the presenter
// call and R34/R36 retained it. Matching the whole pre-R33 multiline block is
// therefore too brittle. Scope the transform to StartFrameProducerWorker and
// extend only its already-qualified render-success guard. This preserves the
// R33 ownership decision, R34 Chromium-mirror queue path and all R36 native UI
// diagnostics byte-for-byte while freezing only the visible swapchain.
replaceOnce(
  `native = replaceOnce(\n  native,\n  \`        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {\n          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }\`,\n  \`        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire) &&\n            !player->r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)) {\n          // LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF: preserve the last visible\n          // native frame while the redraw is mirrored to Chromium.\n          R32PresentNativeFrame(player, slot, renderWidth, renderHeight);\n        }\`,\n  'R37 freeze native popup during mirror handoff'\n);`,
  `native = replaceInside(\n  native,\n  'bool StartFrameProducerWorker(',\n  'napi_value StartFrameProducer(',\n  '        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire)) {',\n  \`        if (rc >= 0 && !player->producerStop.load(std::memory_order_acquire) &&\n            !player->r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)) { // LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF\`,\n  'R37 freeze native popup during mirror handoff'\n);`,
  'R37 qualified-R36 native producer freeze anchor'
);

// R30 and every qualified build after it intentionally preserve Electron's
// managed SharedTextureImported.release() lifetime path, but the exact spelling
// around that call has drifted. Keep the actual release line byte-for-byte and
// insert R37's one-shot handoff ACK immediately after the unique managed-release
// line instead of assuming the older one-line try/catch spelling. The marker is
// a real ACK payload field (not just a source comment) so esbuild must retain it
// in the generated preload bundle used by packaged-source gates.
replaceOnce(
  `preload = replaceOnce(\n  preload,\n  '      try { importedSharedTexture?.release?.(); } catch {}',\n  \`      try { importedSharedTexture?.release?.(); } catch {}\n      if (r37HandoffCopied && Number(metadata?.r37HandoffEpoch) > 0) {\n        try {\n          ipcRenderer.send('libmpv-shared:r37-handoff-presented', {\n            epoch: Number(metadata.r37HandoffEpoch),\n            playerId: Number(metadata.playerId) || 0,\n            generation: Number(metadata.generation) || 0,\n            frameId: Number(metadata.frameId) || 0\n          });\n        } catch {}\n      }\`,\n  'R37 renderer ACK after release'\n);`,
  `const r37ManagedReleaseLines = preload.match(/^[^\\n]*importedSharedTexture\\?\\.release[^\\n]*$/gm) || [];\nif (r37ManagedReleaseLines.length !== 1) {\n  throw new Error('R37 renderer managed release anchor count=' + r37ManagedReleaseLines.length);\n}\nconst r37ManagedReleaseLine = r37ManagedReleaseLines[0];\nconst r37RendererAckAfterRelease = [\n  r37ManagedReleaseLine,\n  '      if (r37HandoffCopied && Number(metadata?.r37HandoffEpoch) > 0) {',\n  '        try {',\n  \"          ipcRenderer.send('libmpv-shared:r37-handoff-presented', {\",\n  \"            marker: 'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',\",\n  '            epoch: Number(metadata.r37HandoffEpoch),',\n  '            playerId: Number(metadata.playerId) || 0,',\n  '            generation: Number(metadata.generation) || 0,',\n  '            frameId: Number(metadata.frameId) || 0',\n  '          });',\n  '        } catch {}',\n  '      }'\n].join('\\n');\npreload = preload.replace(r37ManagedReleaseLine, r37RendererAckAfterRelease);`,
  'R37 qualified-R36 managed-release ACK anchor'
);

// R36's builder intentionally stores the exact Windows artifact filename in
// package.json. Keep the same convention so the stable identity/package gate is
// exact rather than relying on electron-builder template expansion.
replaceOnce(
  "pkg.build.win.artifactName = 'LilacAnime-Libmpv-R37-Setup.${ext}';",
  "pkg.build.win.artifactName = 'LilacAnime-Libmpv-R37-Setup.exe';",
  'R37 exact artifact name'
);

fs.writeFileSync(target, source, 'utf8');
console.log('R37_TRANSFORM_ANCHOR_COMPAT_OK metadata=r27-tail+epoch diagnostics=preserved nativeFreeze=producer-scoped rendererAck=managed-release-line+runtime-marker artifact=exact-exe');

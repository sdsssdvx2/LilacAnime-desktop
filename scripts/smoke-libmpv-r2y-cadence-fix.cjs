'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const preload = read('electron/libmpv-shared-preload.cjs');
const generated = read('electron/preload-libmpv-shared.generated.cjs');
const bridge = read('electron/libmpv-shared-main.cjs');
const css = read('src/player-android.css');
const pkg = JSON.parse(read('package.json'));

for (const source of [preload, generated]) {
  assert.match(source, /raf-warm-staged-copy/);
  assert.match(source, /ensureGpuPresentLoop/);
  assert.match(source, /GPU_PRESENT_IDLE_STOP_MS/);
  assert.match(source, /gpuPresentLoopTicks/);
  assert.match(source, /copyExternalImageToTexture/);
  assert.match(source, /copyTextureToTexture/);
  assert.match(source, /receiveCadenceTracker/);
  assert.doesNotMatch(source, /scheduleGpuPresent\(gpu\)/);
  assert.doesNotMatch(source, /setSharedTextureReceiver\(async/);
  assert.doesNotMatch(source, /await requestAnimationFrame/);
}
assert.equal((preload.match(/getCurrentTexture\(\)/g) || []).length, 1, 'swapchain acquisition must remain final-present only');
assert.match(preload, /if \(frame\?\.close\) \{\s*frame\.close\(\);/s, 'VideoFrame immediate close must remain');
assert.match(preload, /if \(importedSharedTexture\?\.release\) \{\s*importedSharedTexture\.release\(\);/s, 'shared texture immediate release must remain');
assert.match(bridge, /ACTIVE_PUMP_RETRY_MS = 2/);
assert.match(bridge, /ACTIVE_PUMP_LEAD_MS = 6/);
assert.match(bridge, /nextActivePumpDelay/);
assert.match(bridge, /lastNativeFramePerfAt = performance\.now\(\)/);
assert.match(bridge, /gpuPresentLoopTicks: numeric\('gpuPresentLoopTicks'\)/);
assert.doesNotMatch(bridge, /let nextDelay = 16;/);
assert.doesNotMatch(bridge, /nextDelay = 16;/);
assert.match(css, /\.immersive-player\.windowed \.player-top \{ padding-right: 158px; \}/);
assert.match(css, /\.immersive-player\.windowed \.player-settings \{ right: 150px; \}/);
assert.doesNotMatch(css, /\.immersive-player \.player-top \{ padding-right: 158px; \}/);
assert.equal(pkg.version, '0.5.50-libmpv-r2y.rc1');
assert.equal(pkg.lilacCustomTag, 'libmpv-r2k-v0.5.50-r8');
assert.equal(pkg.build.win.artifactName, 'LilacAnime-Libmpv-R2Y-Setup.${ext}');

console.log('LIBMPV_R2Y_CADENCE_FIX_SMOKE_OK presenter=warm-rAF pump=phase-aware ui=original-right immediateLifetime=1');

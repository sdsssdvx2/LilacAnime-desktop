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
  assert.match(source, /direct-receive-webgpu-copy/);
  assert.match(source, /copyExternalImageToTexture/);
  assert.match(source, /\{ texture: gpu\.context\.getCurrentTexture\(\) \}/);
  assert.match(source, /presentedFrames \+= 1/);
  assert.match(source, /observePresentationCadence\(metadata, performance\.now\(\)\)/);
  assert.doesNotMatch(source, /stagingTexture/);
  assert.doesNotMatch(source, /copyTextureToTexture/);
  assert.doesNotMatch(source, /ensureGpuPresentLoop/);
  assert.doesNotMatch(source, /GPU_PRESENT_IDLE_STOP_MS/);
  assert.doesNotMatch(source, /requestAnimationFrame\(/);
  assert.doesNotMatch(source, /setSharedTextureReceiver\(async/);
  assert.doesNotMatch(source, /await requestAnimationFrame/);
}
assert.equal((preload.match(/getCurrentTexture\(\)/g) || []).length, 1, 'canvas texture must be acquired exactly once in direct receiver copy');
assert.match(preload, /if \(frame\?\.close\) \{\s*frame\.close\(\);/s, 'VideoFrame immediate close must remain');
assert.match(preload, /if \(importedSharedTexture\?\.release\) \{\s*importedSharedTexture\.release\(\);/s, 'shared texture immediate release must remain');

const receiverStart = preload.indexOf('sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }');
const receiverFinally = preload.indexOf('} finally {', receiverStart);
const receiverEnd = preload.indexOf("reason: 'lifetime-release-failed'", receiverFinally);
assert.ok(receiverStart >= 0 && receiverFinally > receiverStart && receiverEnd > receiverFinally, 'receiver immediate-release block missing');
assert.doesNotMatch(preload.slice(receiverStart, receiverEnd), /\bawait\b/, 'receiver must not await before releasing source');

for (const marker of ['ACTIVE_PUMP_RETRY_MS = 2', 'ACTIVE_PUMP_LEAD_MS = 6', 'pumpExpectedFps', 'refreshPumpTimingState']) {
  assert.ok(bridge.includes(marker), `phase-aware pump marker missing: ${marker}`);
}
assert.doesNotMatch(bridge, /let nextDelay = 16;/);
assert.doesNotMatch(bridge, /nextDelay = 16;/);

assert.match(css, /\.immersive-player \.player-top \{ padding-right: 28px; \}/);
assert.match(css, /\.immersive-player \.player-settings \{ right: 16px; \}/);
assert.doesNotMatch(css, /\.immersive-player\.windowed \.player-top/);
assert.doesNotMatch(css, /\.immersive-player\.windowed \.player-settings/);

assert.equal(pkg.version, '0.5.50-libmpv-r2z.rc1');
assert.equal(pkg.lilacCustomTag, 'libmpv-r2k-v0.5.50-r9');
assert.equal(pkg.build.win.artifactName, 'LilacAnime-Libmpv-R2Z-Setup.${ext}');

console.log('LIBMPV_R2Z_DIRECT_PRESENT_SMOKE_OK presenter=direct-receive-webgpu-copy staging=0 rafGate=0 phasePump=1 uiFullscreenInvariant=1');

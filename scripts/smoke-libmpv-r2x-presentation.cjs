'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const preload = read('electron/libmpv-shared-preload.cjs');
const generated = read('electron/preload-libmpv-shared.generated.cjs');
const bridge = read('electron/libmpv-shared-main.cjs');
const entry = read('src/libmpv-shared-entry.js');
const css = read('src/player-android.css');
const main = read('electron/main.cjs');
const pkg = JSON.parse(read('package.json'));

for (const source of [preload, generated]) {
  assert.match(source, /raf-staged-copy/);
  assert.match(source, /copyExternalImageToTexture/);
  assert.match(source, /stagingTexture/);
  assert.match(source, /copyTextureToTexture/);
  assert.match(source, /scheduleGpuPresent/);
  assert.match(source, /receiveCadenceTracker/);
  assert.match(source, /lastReceiveCadence/);
  assert.doesNotMatch(source, /setSharedTextureReceiver\(async/);
  assert.doesNotMatch(source, /await requestAnimationFrame/);
}

assert.equal((preload.match(/getCurrentTexture\(\)/g) || []).length, 1, 'swapchain texture should only be acquired in final presenter');
assert.match(preload, /\{ texture: gpu\.stagingTexture \}/, 'source frame must copy into private GPU staging texture');
assert.match(preload, /if \(frame\?\.close\) \{\s*frame\.close\(\);/s, 'VideoFrame immediate close must remain');
assert.match(preload, /if \(importedSharedTexture\?\.release\) \{\s*importedSharedTexture\.release\(\);/s, 'shared texture immediate release must remain');
const receiverStart = preload.indexOf('sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }');
const receiverFinally = preload.indexOf('} finally {', receiverStart);
const receiverEnd = preload.indexOf("reason: 'lifetime-release-failed'", receiverFinally);
assert.ok(receiverStart >= 0 && receiverFinally > receiverStart && receiverEnd > receiverFinally, 'explicit receiver finally release block missing');
const receiverLifetimeBlock = preload.slice(receiverStart, receiverEnd);
assert.doesNotMatch(receiverLifetimeBlock, /\bawait\b/, 'source receiver must not await before releasing VideoFrame/shared texture');
for (const marker of ['gpuPresentFrames', 'gpuCoalescedFrames', 'avgSendSharedTextureMs', 'sendSharedTextureMaxMs', 'nativeCadenceTracker', 'receiveCadence']) {
  assert.ok(bridge.includes(marker), `bridge diagnostic marker missing: ${marker}`);
}
assert.match(entry, /object-fit:contain/);
assert.match(css, /\.immersive-player \.player-top \{ padding-right: 158px; \}/);
assert.match(css, /\.immersive-player \.player-settings \{ right: 16px; \}/);
assert.doesNotMatch(css, /\.immersive-player\.windowed \.player-settings \{ right: 150px; \}/);
assert.match(main, /setVideoAspectSuspended\(win,true\)/);
assert.match(main, /bindVideoAspectFullscreen\(win\)/);
assert.equal(pkg.version, '0.5.50-libmpv-r2x.rc1');
assert.equal(pkg.lilacCustomTag, 'libmpv-r2k-v0.5.50-r7');
assert.equal(pkg.build.win.artifactName, 'LilacAnime-Libmpv-R2X-Setup.${ext}');

console.log('LIBMPV_R2X_PRESENTATION_SMOKE_OK sourceCopy=immediate-staging sourceRelease=same-turn finalPresent=rAF diagnostics=native-send-receive-present canvasAspect=contain uiSafeArea=stable');

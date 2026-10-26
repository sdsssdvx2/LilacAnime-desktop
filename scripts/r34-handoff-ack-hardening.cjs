'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'electron/libmpv-shared-main.cjs');
const nativeTarget = path.join(root, 'native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
let native = fs.readFileSync(nativeTarget, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function replaceInside(source, startNeedle, endNeedle, needle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(`${label}: function boundary missing`);
  const block = source.slice(start, end);
  const patched = replaceOnce(block, needle, replacement, label);
  return source.slice(0, start) + patched + source.slice(end);
}
function replaceSection(source, startNeedle, endNeedle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(`${label}: section boundary missing`);
  if (source.indexOf(startNeedle, start + startNeedle.length) >= 0) throw new Error(`${label}: start anchor not unique`);
  return source.slice(0, start) + replacement + source.slice(end);
}

if (!bridge.includes('LILAC_R34_FOCUS_HANDOFF') || !bridge.includes('r34CompleteFocusHandoff')) {
  throw new Error('R34 focus handoff baseline missing');
}
if (bridge.includes('LILAC_R34_HANDOFF_SENT_ACK')) throw new Error('R34 handoff sent-ack hardening already applied');
if (!native.includes('LILAC_R33_PRESENT_RESULT_PROOF') || !native.includes('r34MirrorChromiumDuringHandoff')) {
  throw new Error('R34 native presenter baseline missing');
}
if (native.includes('LILAC_R34_NONBLOCKING_PRESENT')) throw new Error('R34 nonblocking presenter hardening already applied');

bridge = replaceOnce(
  bridge,
  '  let r34FocusHandoffMinFrameId = 0;',
  '  let r34FocusHandoffMinFrameId = 0; // LILAC_R34_HANDOFF_SENT_ACK\n  const r34FocusHandoffSentFrames = new Set();',
  'R34 sent-ack state'
);

bridge = replaceInside(
  bridge,
  '  function r34CancelFocusHandoff(',
  '  function r34BeginFocusHandoff(',
  '    r34FocusHandoffStartedWallMs = 0;\n',
  '    r34FocusHandoffStartedWallMs = 0;\n    r34FocusHandoffSentFrames.clear();\n',
  'R34 sent-ack cancel reset'
);
bridge = replaceInside(
  bridge,
  '  function r34BeginFocusHandoff(',
  '  function r34CompleteFocusHandoff(',
  '    r34FocusHandoffStartedWallMs = Date.now();\n',
  '    r34FocusHandoffStartedWallMs = Date.now();\n    r34FocusHandoffSentFrames.clear();\n',
  'R34 sent-ack begin reset'
);
bridge = replaceInside(
  bridge,
  '  function r34CompleteFocusHandoff(',
  '  function r32ApplyNativePresenterFocus(',
  '    if (!r34FocusHandoffPending || ownerPlayerId !== playerId || Number(frameId) < r34FocusHandoffMinFrameId) return;\n',
  '    if (!r34FocusHandoffPending || ownerPlayerId !== playerId || Number(frameId) < r34FocusHandoffMinFrameId || !r34FocusHandoffSentFrames.has(Number(frameId))) return;\n',
  'R34 sent-ack completion gate'
);
bridge = replaceInside(
  bridge,
  '  function r34CompleteFocusHandoff(',
  '  function r32ApplyNativePresenterFocus(',
  '    r34FocusHandoffStartedWallMs = 0;\n',
  '    r34FocusHandoffStartedWallMs = 0;\n    r34FocusHandoffSentFrames.clear();\n',
  'R34 sent-ack completion reset'
);

bridge = replaceOnce(
  bridge,
  '      metrics.sentFrames += 1;\n',
  `      metrics.sentFrames += 1;
      if (r34FocusHandoffPending && ownerPlayerId === playerId && Number(frameId) >= r34FocusHandoffMinFrameId) {
        r34FocusHandoffSentFrames.add(Number(frameId));
        while (r34FocusHandoffSentFrames.size > 24) r34FocusHandoffSentFrames.delete(r34FocusHandoffSentFrames.values().next().value);
      }
`,
  'R34 sent-ack successful send mark'
);
bridge = replaceOnce(
  bridge,
  '          subtitleVisible: r34SubtitleVisible,\n          subtitleTransitions: r34SubtitleTransitions\n',
  '          subtitleVisible: r34SubtitleVisible,\n          subtitleTransitions: r34SubtitleTransitions,\n          sentAwaitingRelease: r34FocusHandoffSentFrames.size\n',
  'R34 sent-ack diagnostics'
);

// Keep focus/visibility N-API responsive even if Windows presentation is busy.
native = replaceOnce(
  native,
  '  HRESULT r33LastPresentHr = S_OK;\n',
  '  HRESULT r33LastPresentHr = S_OK;\n  uint64_t r34PresentBusyFrames = 0; // LILAC_R34_NONBLOCKING_PRESENT\n',
  'R34 nonblocking presenter counter'
);
const presentReplacement = String.raw`bool R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {
  if (!player || !slot || !slot->texture || !player->nativePresenterRequested.load(std::memory_order_acquire)) return false;
  const auto started = std::chrono::steady_clock::now();
  ComPtr<IDXGISwapChain> presentSwapChain;
  ComPtr<ID3D11Texture2D> presentBackBuffer;
  {
    std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
    if (!player->nativePresenterRequested.load(std::memory_order_acquire) || !player->nativePresenterHwnd) return false;
    std::string error;
    if (!R32EnsurePresenterSwapChain(player, width, height, &error)) {
      player->nativePresenterFailures += 1;
      player->r33PresentOtherStatusFrames += 1;
      player->nativePresenterLastError = error;
      return false;
    }
    presentSwapChain = player->nativePresenterSwapChain;
    presentBackBuffer = player->nativePresenterBackBuffer;
  }
  if (!presentSwapChain || !presentBackBuffer || !player->nativePresenterRequested.load(std::memory_order_acquire)) return false;
  player->context->CopyResource(presentBackBuffer.Get(), slot->texture.Get());
  const HRESULT hr = presentSwapChain->Present(0, DXGI_PRESENT_DO_NOT_WAIT);
  const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  std::lock_guard<std::mutex> lock(player->nativePresenterMutex);
  player->r33LastPresentHr = hr;
  if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
    player->r34PresentBusyFrames += 1;
    player->nativePresenterLastError = "Present native presenter busy " + HrHex(hr);
    return true;
  }
  if (hr == DXGI_STATUS_OCCLUDED) {
    player->r33PresentOccludedFrames += 1;
    player->nativePresenterLastError = "Present native presenter occluded " + HrHex(hr);
    return false;
  }
  if (hr != S_OK) {
    player->r33PresentOtherStatusFrames += 1;
    if (FAILED(hr)) player->nativePresenterFailures += 1;
    player->nativePresenterLastError = "Present native presenter non-S_OK " + HrHex(hr);
    return false;
  }
  player->nativePresenterFrames += 1;
  player->r33PresentSOkFrames += 1;
  player->nativePresenterPresentTotalMs += elapsed;
  player->nativePresenterPresentMaxMs = std::max(player->nativePresenterPresentMaxMs, elapsed);
  player->nativePresenterLastError.clear();
  return true;
}

`;
native = replaceSection(
  native,
  'bool R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {',
  'bool SetOption(Player* player, const char* key, const char* value, std::string* error) {',
  presentReplacement,
  'R34 nonblocking native presenter'
);
native = replaceOnce(
  native,
  '  Set(env, out, "presentOtherStatusFrames", DoubleValue(env, static_cast<double>(player->r33PresentOtherStatusFrames)));\n',
  '  Set(env, out, "presentOtherStatusFrames", DoubleValue(env, static_cast<double>(player->r33PresentOtherStatusFrames)));\n  Set(env, out, "r34PresentBusyFrames", DoubleValue(env, static_cast<double>(player->r34PresentBusyFrames)));\n',
  'R34 nonblocking presenter diagnostics'
);

fs.writeFileSync(target, bridge, 'utf8');
fs.writeFileSync(nativeTarget, native, 'utf8');

// The inherited R33 visible-focus smoke performs synchronous N-API calls. If one
// driver/Win32 call blocks, an in-process JS timeout cannot fire. Wrap the exact
// smoke in a parent Electron process and execute the original body in a separate
// Electron child. The parent can terminate the entire child tree after 90s and
// preserve the last stage marker, turning an indefinite CI hang into evidence.
const smokeTarget = path.join(root, 'scripts/r33-owned-popup-visible-focus-smoke.cjs');
if (fs.existsSync(smokeTarget)) {
  let smoke = fs.readFileSync(smokeTarget, 'utf8').replace(/\r\n/g, '\n');
  if (!smoke.includes('LILAC_R34_R33_SMOKE_WATCHDOG')) {
    smoke = replaceOnce(smoke, "  await app.whenReady();\n", "  console.log('R34_R33_SMOKE_STAGE=before-app-ready');\n  await app.whenReady();\n  console.log('R34_R33_SMOKE_STAGE=app-ready');\n", 'R34 R33 smoke app-ready stage');
    smoke = replaceOnce(smoke, "    if (addon.configureNativePresenter(id, hwndText(main)) !== true) throw new Error('configureNativePresenter failed');\n", "    console.log('R34_R33_SMOKE_STAGE=before-configure');\n    if (addon.configureNativePresenter(id, hwndText(main)) !== true) throw new Error('configureNativePresenter failed');\n    console.log('R34_R33_SMOKE_STAGE=configured');\n", 'R34 R33 smoke configure stage');
    smoke = replaceOnce(smoke, "    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');\n", "    console.log('R34_R33_SMOKE_STAGE=before-producer-start');\n    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');\n    console.log('R34_R33_SMOKE_STAGE=producer-started');\n", 'R34 R33 smoke producer stage');
    smoke = replaceOnce(smoke, "    await waitUntil(() => {\n      const s = addon.nativePresenterStats(id);\n      return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;\n    }, 6000, 'owned popup visible/presenting');\n", "    console.log('R34_R33_SMOKE_STAGE=before-native-visible-wait');\n    await waitUntil(() => {\n      const s = addon.nativePresenterStats(id);\n      return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;\n    }, 6000, 'owned popup visible/presenting');\n    console.log('R34_R33_SMOKE_STAGE=native-visible');\n", 'R34 R33 smoke visible stage');
    smoke = replaceOnce(smoke, "    blockMain(900);\n", "    console.log('R34_R33_SMOKE_STAGE=before-main-block');\n    blockMain(900);\n    console.log('R34_R33_SMOKE_STAGE=after-main-block');\n", 'R34 R33 smoke block stage');
    smoke = replaceOnce(smoke, "    main.focus();\n    await waitUntil(() => main.isFocused(), 3000, 'owner refocus');\n", "    console.log('R34_R33_SMOKE_STAGE=before-refocus');\n    main.focus();\n    await waitUntil(() => main.isFocused(), 3000, 'owner refocus');\n    console.log('R34_R33_SMOKE_STAGE=refocused');\n", 'R34 R33 smoke refocus stage');
    smoke = replaceOnce(smoke, "    if (id != null) {\n      try { addon.setNativePresenterVisible(id, false); } catch {}\n", "    if (id != null) {\n      console.log('R34_R33_SMOKE_STAGE=cleanup-visible-off');\n      try { addon.setNativePresenterVisible(id, false); } catch {}\n      console.log('R34_R33_SMOKE_STAGE=cleanup-stop-producer');\n", 'R34 R33 smoke cleanup stage');
    smoke = replaceOnce(smoke, "      try { addon.stopFrameProducer(id); } catch {}\n      try { addon.destroyPlayer(id); } catch {}\n", "      try { addon.stopFrameProducer(id); } catch {}\n      console.log('R34_R33_SMOKE_STAGE=cleanup-destroy');\n      try { addon.destroyPlayer(id); } catch {}\n      console.log('R34_R33_SMOKE_STAGE=cleanup-native-done');\n", 'R34 R33 smoke destroy stage');
    smoke = smoke.replace(/^'use strict';\n/, '');
    const parent = String.raw`'use strict';
// LILAC_R34_R33_SMOKE_WATCHDOG
if (process.env.LILAC_R34_R33_SMOKE_CHILD === '1') {
__R34_CHILD_BODY__
} else {
  const { spawn, spawnSync } = require('node:child_process');
  const child = spawn(process.execPath, [__filename], {
    env: { ...process.env, LILAC_R34_R33_SMOKE_CHILD: '1' },
    stdio: 'inherit',
    windowsHide: true
  });
  let settled = false;
  const hard = setTimeout(() => {
    if (settled) return;
    console.error('R34_R33_SMOKE_TIMEOUT=90s childPid=' + String(child.pid || 0));
    if (process.platform === 'win32' && child.pid) {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'inherit', windowsHide: true, timeout: 10000 }); } catch {}
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(124);
  }, 90000);
  child.on('error', error => {
    if (settled) return;
    settled = true;
    clearTimeout(hard);
    console.error(error?.stack || error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(hard);
    if (signal) console.error('R34_R33_SMOKE_CHILD_SIGNAL=' + signal);
    process.exit(Number.isInteger(code) ? code : 1);
  });
}
`;
    fs.writeFileSync(smokeTarget, parent.replace('__R34_CHILD_BODY__', smoke), 'utf8');
  }
}

const out = fs.readFileSync(target, 'utf8');
const nativeOut = fs.readFileSync(nativeTarget, 'utf8');
for (const marker of ['LILAC_R34_HANDOFF_SENT_ACK','r34FocusHandoffSentFrames','!r34FocusHandoffSentFrames.has(Number(frameId))','r34FocusHandoffSentFrames.add(Number(frameId))','sentAwaitingRelease: r34FocusHandoffSentFrames.size']) {
  if (!out.includes(marker)) throw new Error(`R34 handoff sent-ack marker missing: ${marker}`);
}
for (const marker of ['LILAC_R34_NONBLOCKING_PRESENT','DXGI_PRESENT_DO_NOT_WAIT','DXGI_ERROR_WAS_STILL_DRAWING','r34PresentBusyFrames','presentSwapChain = player->nativePresenterSwapChain','presentBackBuffer = player->nativePresenterBackBuffer']) {
  if (!nativeOut.includes(marker)) throw new Error(`R34 nonblocking presenter marker missing: ${marker}`);
}
const presentStart = nativeOut.indexOf('bool R32PresentNativeFrame(');
const presentEnd = nativeOut.indexOf('bool SetOption(', presentStart);
const presentBody = nativeOut.slice(presentStart, presentEnd);
if (presentBody.includes('Present(0, 0)') || !presentBody.includes('Present(0, DXGI_PRESENT_DO_NOT_WAIT)')) throw new Error('R34 blocking native Present survived');
if (fs.existsSync(smokeTarget)) {
  const smokeOut = fs.readFileSync(smokeTarget, 'utf8');
  if (!smokeOut.includes('LILAC_R34_R33_SMOKE_WATCHDOG') || !smokeOut.includes('R34_R33_SMOKE_STAGE=cleanup-native-done')) throw new Error('R34 inherited R33 smoke watchdog instrumentation missing');
}
console.log('R34_HANDOFF_SENT_ACK_OK completion=successful-send+allReferencesReleased staleOrFailedRelease=ignored cap=24');
console.log('R34_NONBLOCKING_PRESENT_OK present=DO_NOT_WAIT presenterMutex=not-held-across-present busy=keep-last-native-frame mirror=chromium-still-delivered');
console.log('R34_R33_SMOKE_WATCHDOG_OK childProcess=isolated hardTimeoutMs=90000 stageMarkers=1');

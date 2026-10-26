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

// sendImportedFrame is serialized by R24. Mark only a frame whose Electron
// sharedTexture send promise actually fulfilled. allReferencesReleased then proves
// that exact successfully-sent frame has no remaining main/renderer references.
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

// The R33 focus presenter held nativePresenterMutex across IDXGISwapChain::Present.
// If DWM/driver presentation blocks, every focus/visibility/stats N-API call waits
// on the same mutex and the whole Electron process can deadlock. R34 snapshots
// COM references under the mutex, presents outside it, and uses DO_NOT_WAIT. A
// WAS_STILL_DRAWING frame keeps the already-presented native popup authoritative;
// in R34 mirror mode Chromium delivery still proceeds because the producer's
// native-only suppression is disabled while r34MirrorChromiumDuringHandoff=true.
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
const out = fs.readFileSync(target, 'utf8');
const nativeOut = fs.readFileSync(nativeTarget, 'utf8');
for (const marker of [
  'LILAC_R34_HANDOFF_SENT_ACK',
  'r34FocusHandoffSentFrames',
  '!r34FocusHandoffSentFrames.has(Number(frameId))',
  'r34FocusHandoffSentFrames.add(Number(frameId))',
  'sentAwaitingRelease: r34FocusHandoffSentFrames.size'
]) {
  if (!out.includes(marker)) throw new Error(`R34 handoff sent-ack marker missing: ${marker}`);
}
for (const marker of [
  'LILAC_R34_NONBLOCKING_PRESENT',
  'DXGI_PRESENT_DO_NOT_WAIT',
  'DXGI_ERROR_WAS_STILL_DRAWING',
  'r34PresentBusyFrames',
  'presentSwapChain = player->nativePresenterSwapChain',
  'presentBackBuffer = player->nativePresenterBackBuffer'
]) {
  if (!nativeOut.includes(marker)) throw new Error(`R34 nonblocking presenter marker missing: ${marker}`);
}
const presentStart = nativeOut.indexOf('bool R32PresentNativeFrame(');
const presentEnd = nativeOut.indexOf('bool SetOption(', presentStart);
const presentBody = nativeOut.slice(presentStart, presentEnd);
if (presentBody.includes('Present(0, 0)') || !presentBody.includes('Present(0, DXGI_PRESENT_DO_NOT_WAIT)')) {
  throw new Error('R34 blocking native Present survived');
}
console.log('R34_HANDOFF_SENT_ACK_OK completion=successful-send+allReferencesReleased staleOrFailedRelease=ignored cap=24');
console.log('R34_NONBLOCKING_PRESENT_OK present=DO_NOT_WAIT presenterMutex=not-held-across-present busy=keep-last-native-frame mirror=chromium-still-delivered');

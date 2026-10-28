'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const readOptional = rel => { const p = path.join(root, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : ''; };
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const pkg = JSON.parse(read('package.json'));
const bridge = read('electron/libmpv-shared-main.cjs');
const sharedPreload = read('electron/libmpv-shared-preload.cjs');
const entry = read('src/libmpv-shared-entry.js');
const player = read('src/player.js');
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
const mini = read('electron/miniplayer-window.cjs');
const native = readOptional('native/libmpv-d3d11-bridge/player_addon.cc');

assert(pkg.version === '0.5.54-libmpv-r3f.rc19', `unexpected R39 version: ${pkg.version}`);
assert(pkg.lilacCustomTag === 'libmpv-r2k-v0.5.54-r39', `unexpected R39 tag: ${pkg.lilacCustomTag}`);
assert(pkg.build?.win?.artifactName === 'LilacAnime-Libmpv-R39-Setup.${ext}', 'unexpected R39 artifact name');
assert(pkg.build?.appId === 'com.lilac.anime.desktop.libmpvr2jcandidate', `stable appId drifted: ${pkg.build?.appId}`);
assert(pkg.build?.productName === 'LilacAnime Libmpv', `stable productName drifted: ${pkg.build?.productName}`);
assert(pkg.build?.win?.executableName === 'LilacAnime-Libmpv-R2K', `stable executable drifted: ${pkg.build?.win?.executableName}`);

for (const marker of ['LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','LILAC_R37_NO_STALE_UI_HOLES','LILAC_R37_NO_REGION_CHURN']) assert(bridge.includes(marker), `R37 bridge invariant missing: ${marker}`);
if (native) assert(native.includes('LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF'), 'R37 native freeze invariant missing');
assert(sharedPreload.includes("presentationMode = 'direct-receive-webgpu-copy'"), 'focused direct WebGPU mode missing');
assert(sharedPreload.includes('copyExternalImageToTexture'), 'focused WebGPU copy primitive missing');
for (const forbidden of ['focus-staged-gpu-copy', 'copyTextureToTexture(', '--disable-direct-composition']) assert(!(bridge + sharedPreload + main + native).includes(forbidden), `failed historical path resurrected: ${forbidden}`);

const focusStart = bridge.indexOf('  function r32ApplyNativePresenterFocus(focused) {');
const focusEnd = bridge.indexOf('\n\n  function ensurePlayer() {', focusStart);
assert(focusStart >= 0 && focusEnd > focusStart, 'focus function boundary missing');
const focus = bridge.slice(focusStart, focusEnd);
assert(focus.includes("if (r33NativePresenterActive) r39ReanchorFocusedPump('native-to-direct-webgpu');"), 'native->focused reanchor call missing');
assert(focus.indexOf('r39ReanchorFocusedPump') < focus.indexOf('r34BeginFocusHandoff()'), 'reanchor must precede R37 handoff arm');
assert(!focus.includes("if (!r33NativePresenterActive) r39ReanchorFocusedPump"), 'steady focused path accidentally reanchors');
const reanchorStart = bridge.indexOf("  function r39ReanchorFocusedPump(reason = 'focus') {");
const reanchorEnd = bridge.indexOf('\n\n  function r32ApplyNativePresenterFocus', reanchorStart);
assert(reanchorStart >= 0 && reanchorEnd > reanchorStart, 'R39 reanchor helper missing');
const reanchor = bridge.slice(reanchorStart, reanchorEnd);
for (const marker of ['nextNativeFrameDeadlinePerfAt = 0', 'lastNativeFramePerfAt = 0', 'noFrameBurstCount = 0', 'schedulePump(0)']) assert(reanchor.includes(marker), `R39 reanchor primitive missing: ${marker}`);
assert(bridge.includes("classification: r39GapActivePlayback ? 'active-playback' : 'interaction-or-buffering'"), 'gap classification missing');
assert(bridge.includes('lastState?.paused !== true') && bridge.includes('lastState?.pausedForCache !== true') && bridge.includes('lastState?.seeking !== true'), 'active-playback gap filter incomplete');
assert(bridge.includes("marker: 'LILAC_R39_REFOCUS_PHASE_REANCHOR'"), 'R39 cadence diagnostics marker missing');

const domStart = entry.indexOf('  refreshSubtitleOverlay() {');
const domEnd = entry.indexOf('\n  async _syncR32NativeSubtitleFallbackStyle()', domStart);
const nativeSubStart = entry.indexOf('  async _syncR32NativeSubtitleFallbackStyle() {');
const nativeSubEnd = entry.indexOf('\n  async _loadTrack(element) {', nativeSubStart);
assert(domStart >= 0 && domEnd > domStart && nativeSubStart >= 0 && nativeSubEnd > nativeSubStart, 'subtitle renderer blocks missing');
const dom = entry.slice(domStart, domEnd), nativeSub = entry.slice(nativeSubStart, nativeSubEnd);
for (const marker of ["subtitleSize') || 100", "subtitlePosition') || 12", "vttOutline') ?? 2"]) { assert(dom.includes(marker), `DOM subtitle setting missing ${marker}`); assert(nativeSub.includes(marker), `native subtitle parity missing ${marker}`); }
assert(nativeSub.includes("localStorage.getItem('vttBold') === 'false' ? 400 : 700"), 'native default weight does not match DOM bold policy');
assert(dom.includes('browserVisualBottom=clamp(position-1.25,0,48)'), 'DOM visual baseline marker missing');
assert(nativeSub.includes('100 - (position - 1.25)'), 'native vertical baseline does not mirror DOM baseline');
assert(nativeSub.includes('LILAC_R39_NATIVE_SUBTITLE_PARITY'), 'subtitle parity marker missing');

for (const [source, marker, label] of [
  [player, 'setLibmpvMiniPlayer', 'renderer mini-player'], [player, '맨 위 고정을 확인하지 못했습니다', 'renderer topmost verification'],
  [preload, 'miniPlayerState:', 'preload mini-player diagnostics'], [main, 'player:miniplayer-state', 'main mini-player diagnostics IPC'],
  [entry, 'miniPlayer: await', 'diagnostic report mini-player state'], [mini, 'LILAC_R39_MINIPLAYER_TOPMOST', 'controller marker'],
  [mini, "process.platform === 'win32' ? 'pop-up-menu' : 'floating'", 'Windows topmost level'], [mini, "bind('blur'", 'blur repin'],
  [mini, "bind('always-on-top-changed'", 'topmost loss repin'], [mini, 'isAlwaysOnTop', 'topmost verification']
]) assert(source.includes(marker), `${label} missing: ${marker}`);
assert(main.includes("ipcMain.handle('player:miniplayer'"), 'mini-player action IPC missing');
assert(preload.includes('setMiniPlayer:'), 'mini-player action preload bridge missing');
assert(main.includes('LILAC_R38_UPDATE_ACTIVITY_CHECK'), 'R38 updater activity lifecycle marker missing');
assert(main.includes("r38CheckUpdaterOnActivity('window-focus')"), 'R38 focus updater hook missing');

console.log(`R39_RUNTIME_RECOVERY_SMOKE_OK root=${root} nativeSource=${native ? 'present' : 'packaged-unpacked-binary-only'} identity=rc19/r39 blackFlash=R37-preserved focused=direct-webgpu refocus=native-only-reanchor gaps=active-vs-interaction subtitle=DOM/native-parity pip=end-to-end+verified-topmost updater=R38-preserved`);

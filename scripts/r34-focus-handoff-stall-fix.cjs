'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => { fs.mkdirSync(path.dirname(file(relative)), { recursive: true }); fs.writeFileSync(file(relative), value, 'utf8'); };
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

function insertBeforeBoundary(source, startNeedle, endNeedle, insertion, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) throw new Error(`${label}: structural boundary missing`);
  return source.slice(0, end) + insertion + source.slice(end);
}

let native = read('native/libmpv-d3d11-bridge/player_addon.cc');
let bridge = read('electron/libmpv-shared-main.cjs');
let entry = read('src/libmpv-shared-entry.js');
let main = read('electron/main.cjs');
const pkg = JSON.parse(read('package.json'));

for (const marker of ['LILAC_R33_OWNED_POPUP_FOCUS_SURFACE','LILAC_R33_NATIVE_ONLY_UNFOCUSED','LILAC_R33_PRESENT_RESULT_PROOF']) {
  assert(native.includes(marker), `R34 requires R33 native marker: ${marker}`);
}
assert(bridge.includes('LILAC_R33_PRESENT_ACTIVATION_ACK') && bridge.includes('r33NativePresenterActive'), 'R34 requires R33 focus bridge');
assert(bridge.includes('LILAC_R27_FOCUS_STALL_RETENTION') && bridge.includes('r27LastDispatchWallMs'), 'R34 requires R27 retained diagnostics');
assert(entry.includes('LILAC_R32_NATIVE_SUBTITLE_FALLBACK'), 'R34 requires R32 native subtitle fallback');
assert(main.includes('LILAC_R33_COMMUNITY_ARCHIVE_WORKER'), 'R34 requires R33 archive worker baseline');
if ([native, bridge, entry, main].some(source => source.includes('LILAC_R34_FOCUS_HANDOFF'))) throw new Error('R34 already applied');

// ---------------------------------------------------------------------------
// A) Atomic focus handoff. R33 immediately hid the native popup on focus, which
// could reveal a stale/black Chromium canvas and also leave a multi-second gap
// before the first shared-texture frame resumed. During R34 handoff the producer
// continues native Present AND mirrors frames to Chromium. The popup is hidden
// only after allReferencesReleased proves a fresh Chromium frame was consumed.
// ---------------------------------------------------------------------------
native = replaceOnce(
  native,
  '  std::atomic<bool> nativePresenterRequested{false};',
  '  std::atomic<bool> nativePresenterRequested{false};\n  std::atomic<bool> r34MirrorChromiumDuringHandoff{false}; // LILAC_R34_FOCUS_HANDOFF',
  'R34 native handoff mirror state'
);

native = replaceOnce(
  native,
  '            if (r33NativeOwnsFrame) {',
  '            if (r33NativeOwnsFrame && !player->r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)) {',
  'R34 allow Chromium mirror during native ownership'
);

const visibleFn = native.indexOf('napi_value SetNativePresenterVisible(');
if (visibleFn < 0) throw new Error('R34 native presenter visibility API missing');
const statsFn = native.indexOf('napi_value NativePresenterStats(', visibleFn);
if (statsFn <= visibleFn) throw new Error('R34 native presenter stats boundary missing');
const mirrorApi = String.raw`
napi_value SetNativePresenterMirrorChromium(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  bool enabled = false;
  if (argc < 2 || !ReadUint32(env, argv[0], &id) || napi_get_value_bool(env, argv[1], &enabled) != napi_ok) {
    Throw(env, "setNativePresenterMirrorChromium(playerId, enabled) requires id and boolean");
    return nullptr;
  }
  std::lock_guard<std::mutex> globalLock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) return BoolValue(env, false);
  player->r34MirrorChromiumDuringHandoff.store(enabled, std::memory_order_release);
  return BoolValue(env, true);
}

`;
native = native.slice(0, statsFn) + mirrorApi + native.slice(statsFn);

native = replaceOnce(
  native,
  '    {"setNativePresenterVisible", nullptr, SetNativePresenterVisible, nullptr, nullptr, nullptr, napi_default, nullptr},',
  '    {"setNativePresenterVisible", nullptr, SetNativePresenterVisible, nullptr, nullptr, nullptr, napi_default, nullptr},\n    {"setNativePresenterMirrorChromium", nullptr, SetNativePresenterMirrorChromium, nullptr, nullptr, nullptr, napi_default, nullptr},',
  'R34 native handoff export'
);

bridge = replaceOnce(
  bridge,
  "'configureNativePresenter', 'setNativePresenterVisible', 'nativePresenterStats', 'destroyPlayer']",
  "'configureNativePresenter', 'setNativePresenterVisible', 'setNativePresenterMirrorChromium', 'nativePresenterStats', 'destroyPlayer']",
  'R34 bridge require handoff export'
);

bridge = replaceOnce(
  bridge,
  '  let r33NativePresenterActive = false;',
  `  let r33NativePresenterActive = false; // LILAC_R34_FOCUS_HANDOFF
  let r34FocusHandoffPending = false;
  let r34FocusHandoffMinFrameId = 0;
  let r34FocusHandoffStartedWallMs = 0;
  let r34FocusHandoffCompleted = 0;
  let r34FocusHandoffCancelled = 0;
  let r34FocusHandoffMaxMs = 0;
  let r34SubtitleVisible = false;
  let r34SubtitleTransitions = 0;`,
  'R34 bridge handoff state'
);

const focusStart = bridge.indexOf('  function r32ApplyNativePresenterFocus(focused) {');
const focusEnd = bridge.indexOf('\n\n  function ensurePlayer() {', focusStart);
if (focusStart < 0 || focusEnd <= focusStart) throw new Error('R34 focus helper boundary missing');
const focusReplacement = String.raw`  function r34SetNativeSubtitleVisible(visible, reason = 'focus') {
    if (!addon || playerId == null || !active) return false;
    const next = Boolean(visible);
    try {
      addon.command(playerId, ['set', 'sub-visibility', next ? 'yes' : 'no']);
      if (r34SubtitleVisible !== next) r34SubtitleTransitions += 1;
      r34SubtitleVisible = next;
      return true;
    } catch (error) {
      metrics.commandFailures += 1;
      metrics.lastCommandError = { command: 'set', property: 'sub-visibility', error: safeBridgeError(error), reason };
      return false;
    }
  }

  function r34CancelFocusHandoff(reason = 'cancel') {
    if (!addon || playerId == null) return;
    if (r34FocusHandoffPending) r34FocusHandoffCancelled += 1;
    r34FocusHandoffPending = false;
    r34FocusHandoffMinFrameId = 0;
    r34FocusHandoffStartedWallMs = 0;
    try { addon.setNativePresenterMirrorChromium(playerId, false); } catch {}
  }

  function r34BeginFocusHandoff() {
    if (!addon || playerId == null || !r33NativePresenterActive) return false;
    r34FocusHandoffPending = true;
    r34FocusHandoffMinFrameId = Math.max(1, (Number(metrics.lastFrameId) || 0) + 1);
    r34FocusHandoffStartedWallMs = Date.now();
    // Reset R27's delivery-gap baseline: the preceding native-only interval had
    // intentionally no Chromium frames and must not become a fake giant gap.
    r27LastDispatchWallMs = 0;
    try {
      return addon.setNativePresenterMirrorChromium(playerId, true) === true;
    } catch (error) {
      lastError = 'R34 focus handoff arm failed: ' + String(error?.message || error).slice(0, 180);
      r34FocusHandoffPending = false;
      return false;
    }
  }

  function r34CompleteFocusHandoff(ownerPlayerId, frameId) {
    if (!r34FocusHandoffPending || ownerPlayerId !== playerId || Number(frameId) < r34FocusHandoffMinFrameId) return;
    const elapsed = Math.max(0, Date.now() - r34FocusHandoffStartedWallMs);
    r34FocusHandoffMaxMs = Math.max(r34FocusHandoffMaxMs, elapsed);
    r34FocusHandoffCompleted += 1;
    r34FocusHandoffPending = false;
    r34FocusHandoffMinFrameId = 0;
    r34FocusHandoffStartedWallMs = 0;
    try { addon.setNativePresenterMirrorChromium(playerId, false); } catch {}
    // Hide libmpv subtitle first, then remove the covering popup. This leaves one
    // authoritative HTML subtitle after the already-consumed Chromium frame.
    r34SetNativeSubtitleVisible(false, 'handoff-complete');
    try { addon.setNativePresenterVisible(playerId, false); } catch {}
    r33NativePresenterActive = false;
  }

  function r32ApplyNativePresenterFocus(focused) {
    if (!addon || playerId == null) return;
    r33FocusTransitions += 1;
    if (Boolean(focused)) {
      if (r33NativePresenterActive && r34BeginFocusHandoff()) return;
      r34CancelFocusHandoff('focused-without-native');
      try { addon.setNativePresenterVisible(playerId, false); } catch {}
      r33NativePresenterActive = false;
      r34SetNativeSubtitleVisible(false, 'focus-direct');
      r27LastDispatchWallMs = 0;
      return;
    }

    r34CancelFocusHandoff('blur');
    const useNative = active && r32TargetVisible;
    let nativeReady = false;
    try {
      const accepted = addon.setNativePresenterVisible(playerId, useNative);
      nativeReady = useNative && accepted === true;
      r33NativePresenterActive = nativeReady;
      r34SetNativeSubtitleVisible(nativeReady, 'blur-native');
    } catch (error) {
      r33NativePresenterActive = false;
      r34SetNativeSubtitleVisible(false, 'blur-fail-open');
      lastError = 'R34 native presenter focus failed: ' + String(error?.message || error).slice(0, 180);
    }
  }`;
bridge = bridge.slice(0, focusStart) + focusReplacement + bridge.slice(focusEnd);

// allReferencesReleased is our renderer-consumption acknowledgement. Preserve the
// existing slot-release behavior and finish a pending focus handoff afterwards.
const releaseStart = bridge.indexOf('  function releaseNativeFrame(ownerPlayerId, slotId, frameId) {');
const releaseEnd = bridge.indexOf('\n\n  function schedulePump(', releaseStart);
if (releaseStart < 0 || releaseEnd <= releaseStart) throw new Error('R34 releaseNativeFrame boundary missing');
let releaseBlock = bridge.slice(releaseStart, releaseEnd);
const releaseClose = releaseBlock.lastIndexOf('\n  }');
if (releaseClose < 0) throw new Error('R34 releaseNativeFrame close missing');
releaseBlock = releaseBlock.slice(0, releaseClose) + '\n    r34CompleteFocusHandoff(ownerPlayerId, frameId);' + releaseBlock.slice(releaseClose);
bridge = bridge.slice(0, releaseStart) + releaseBlock + bridge.slice(releaseEnd);

// After renderer sub-add, main immediately reapplies the authoritative focus state.
// Renderer no longer races BrowserWindow focus with document.hasFocus().
bridge = replaceOnce(
  bridge,
  '      addon.command(playerId, commandArray);\n      return { ok: true };',
  `      addon.command(playerId, commandArray);
      if (commandArray[0] === 'sub-add') {
        r34SetNativeSubtitleVisible(r33NativePresenterActive, 'sub-add-authority');
      }
      return { ok: true };`,
  'R34 subtitle authority after sub-add'
);

// Add bounded handoff state to the existing diagnostics object without adding any
// per-frame IPC. This lives beside R33 focus-surface diagnostics.
bridge = replaceOnce(
  bridge,
  `        eventLoopHeartbeat: {
          intervalMs: R33_MAIN_HEARTBEAT_MS,
          stallThresholdMs: R33_MAIN_STALL_THRESHOLD_MS,
          stallCount: r33MainStallCount,
          maxGapMs: r33MainStallMaxMs,
          lastGapMs: r33MainStallLastMs,
          lastWallMs: r33MainStallLastWallMs
        }`,
  `        eventLoopHeartbeat: {
          intervalMs: R33_MAIN_HEARTBEAT_MS,
          stallThresholdMs: R33_MAIN_STALL_THRESHOLD_MS,
          stallCount: r33MainStallCount,
          maxGapMs: r33MainStallMaxMs,
          lastGapMs: r33MainStallLastMs,
          lastWallMs: r33MainStallLastWallMs
        },
        r34Handoff: {
          pending: r34FocusHandoffPending,
          minFrameId: r34FocusHandoffMinFrameId,
          completed: r34FocusHandoffCompleted,
          cancelled: r34FocusHandoffCancelled,
          maxMs: r34FocusHandoffMaxMs,
          subtitleVisible: r34SubtitleVisible,
          subtitleTransitions: r34SubtitleTransitions
        }`,
  'R34 handoff diagnostics'
);

// ---------------------------------------------------------------------------
// B) Subtitle regression repair. The HTML renderer owns subtitles while focused;
// the libmpv ASS track is fallback-only for the native popup. Never let renderer
// focus state toggle mpv visibility. Force ASS override only for this hidden/native
// fallback so sub-pos/font/border settings actually match the HTML preferences.
// ---------------------------------------------------------------------------
entry = replaceOnce(
  entry,
  `    const commands = [
      ['set_property', 'sub-pos', clamp(Math.round(100 - position), 55, 97)],`,
  `    const commands = [
      ['set_property', 'sub-ass-override', 'force'], // LILAC_R34_SUBTITLE_SINGLE_OWNER
      ['set_property', 'sub-pos', clamp(Math.round(100 - position), 55, 97)],`,
  'R34 native ASS fallback authority'
);
entry = replaceOnce(
  entry,
  `        await this._command(['set_property', 'sub-visibility', document.hasFocus() ? 'no' : 'yes']);`,
  `        // Main BrowserWindow focus is the sole visibility authority in R34.
        // Keeping this renderer focus-neutral removes the R32/R33 race that could
        // leave both libmpv ASS and HTML VTT subtitles visible after refocus.`,
  'R34 remove renderer focus subtitle race'
);
entry = replaceOnce(
  entry,
  `        await this._command(['sub-remove']);
        await this._command(['sub-add', r32NativeSubtitle, 'select']);`,
  `        if (this._r34NativeSubtitleLoaded === true) await this._command(['sub-remove']);
        await this._command(['sub-add', r32NativeSubtitle, 'select']);
        this._r34NativeSubtitleLoaded = true;`,
  'R34 avoid first-load sub-remove failure'
);
entry = replaceOnce(
  entry,
  '    this._trackByElement = new Map();',
  '    this._trackByElement = new Map();\n    this._r34NativeSubtitleLoaded = false;',
  'R34 subtitle loaded constructor init'
);
const r34OpenStart = entry.indexOf('  async openLilacSource(');
const r34OpenEnd = entry.indexOf('\n  async play()', r34OpenStart);
if (r34OpenStart < 0 || r34OpenEnd <= r34OpenStart) throw new Error('R34 openLilacSource structural boundary missing');
let r34OpenBlock = entry.slice(r34OpenStart, r34OpenEnd);
r34OpenBlock = replaceOnce(
  r34OpenBlock,
  '    const token = ++this._openToken;',
  '    const token = ++this._openToken;\n    this._r34NativeSubtitleLoaded = false;',
  'R34 subtitle loaded open reset'
);
entry = entry.slice(0, r34OpenStart) + r34OpenBlock + entry.slice(r34OpenEnd);

// ---------------------------------------------------------------------------
// C) Remove the largest known synchronous background disk writes from Electron
// main. Catalog indexes are explicitly several MB and were being JSON.stringify'd
// + writeFileSync'd on the playback thread. A persistent worker coalesces writes
// by path and does both serialization and disk I/O off-main.
// ---------------------------------------------------------------------------
const cacheWorkerSource = String.raw`'use strict';
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const pending = new Map();
let draining = false;
async function drain(){
  if(draining)return;draining=true;
  try{
    while(pending.size){
      const [target,value]=pending.entries().next().value;pending.delete(target);
      try{await fs.promises.mkdir(path.dirname(target),{recursive:true});await fs.promises.writeFile(target,JSON.stringify(value),'utf8');parentPort.postMessage({ok:true,target})}
      catch(error){parentPort.postMessage({ok:false,target,error:String(error?.message||error).slice(0,240)})}
    }
  }finally{draining=false;if(pending.size)void drain()}
}
parentPort.on('message',message=>{if(!message?.target)return;pending.set(String(message.target),message.value);void drain()});
`;
write('electron/cache-write-worker.cjs', cacheWorkerSource);

const catalogAnchor = 'const indexSaveTimers={};\nfunction saveCatalogFile(provider,name,value){const key=`${provider}-${name}`;clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{fs.writeFileSync(path.join(app.getPath(\'userData\'),`${key}.json`),JSON.stringify(value()))}catch{}},2000)}';
assert(main.includes(catalogAnchor), 'R34 catalog save anchor missing');
const cacheHelpers = String.raw`const indexSaveTimers={};
let r34CacheWriteWorker=null,r34CacheWriteSubmitted=0,r34CacheWriteCompleted=0,r34CacheWriteErrors=0;
function r34CacheWriteWorkerEntry(){
  const entry=path.join(__dirname,'cache-write-worker.cjs');
  return entry.includes('app.asar.unpacked')?entry:(entry.includes('app.asar')?entry.replace(/app\.asar(?=[\\/])/,'app.asar.unpacked'):entry);
}
function r34EnsureCacheWriteWorker(){
  if(r34CacheWriteWorker)return r34CacheWriteWorker;
  const worker=new Worker(r34CacheWriteWorkerEntry());
  worker.unref();
  worker.on('message',message=>{if(message?.ok)r34CacheWriteCompleted+=1;else r34CacheWriteErrors+=1});
  worker.on('error',()=>{r34CacheWriteErrors+=1;if(r34CacheWriteWorker===worker)r34CacheWriteWorker=null});
  worker.on('exit',()=>{if(r34CacheWriteWorker===worker)r34CacheWriteWorker=null});
  r34CacheWriteWorker=worker;return worker;
}
function r34QueueJsonWrite(target,value){
  try{r34CacheWriteSubmitted+=1;r34EnsureCacheWriteWorker().postMessage({target,value})}catch{r34CacheWriteErrors+=1}
}
function saveCatalogFile(provider,name,value){const key=String(provider)+'-'+String(name);clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{r34QueueJsonWrite(path.join(app.getPath('userData'),key+'.json'),value())}catch{}},2000)} // LILAC_R34_CACHE_WRITE_WORKER`;
main = main.replace(catalogAnchor, cacheHelpers);

main = replaceOnce(
  main,
  `function saveDisplayTitles(){clearTimeout(displayTitleSaveTimer);displayTitleSaveTimer=setTimeout(()=>{try{fs.writeFileSync(displayTitleFile(),JSON.stringify(displayTitleStore()),'utf8')}catch{}},1000)}`,
  `function saveDisplayTitles(){clearTimeout(displayTitleSaveTimer);displayTitleSaveTimer=setTimeout(()=>{try{r34QueueJsonWrite(displayTitleFile(),displayTitleStore())}catch{}},1000)}`,
  'R34 display-title async worker write'
);
main = replaceOnce(
  main,
  `tmdbOverviewDisk[key]={text,time:Date.now()};try{fs.writeFileSync(tmdbOverviewFile(),JSON.stringify(tmdbOverviewDisk),'utf8')}catch{}`,
  `tmdbOverviewDisk[key]={text,time:Date.now()};r34QueueJsonWrite(tmdbOverviewFile(),tmdbOverviewDisk)`,
  'R34 TMDB overview worker write'
);
main = replaceOnce(
  main,
  `artworkDisk[key]={banner,logos,time:Date.now()};try{fs.writeFileSync(artworkFile(),JSON.stringify(artworkDisk),'utf8')}catch{}`,
  `artworkDisk[key]={banner,logos,time:Date.now()};r34QueueJsonWrite(artworkFile(),artworkDisk)`,
  'R34 artwork worker write'
);
main = replaceOnce(
  main,
  `anissiaCatalogData={time:Date.now(),items};try{fs.writeFileSync(file,JSON.stringify(anissiaCatalogData))}catch{/* kept in memory */}`,
  `anissiaCatalogData={time:Date.now(),items};r34QueueJsonWrite(file,anissiaCatalogData)`,
  'R34 Anissia catalog worker write'
);

pkg.build ||= {};
const unpack = Array.isArray(pkg.build.asarUnpack) ? pkg.build.asarUnpack : (pkg.build.asarUnpack ? [pkg.build.asarUnpack] : []);
if (!unpack.includes('electron/cache-write-worker.cjs')) unpack.push('electron/cache-write-worker.cjs');
pkg.build.asarUnpack = unpack;

write('native/libmpv-d3d11-bridge/player_addon.cc', native);
write('electron/libmpv-shared-main.cjs', bridge);
write('src/libmpv-shared-entry.js', entry);
write('electron/main.cjs', main);
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

buildSync({
  entryPoints: [file('src/libmpv-shared-entry.js')],
  outfile: file('src/libmpv-shared.generated.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome152',
  logLevel: 'info'
});

const n = read('native/libmpv-d3d11-bridge/player_addon.cc');
const b = read('electron/libmpv-shared-main.cjs');
const e = read('src/libmpv-shared-entry.js');
const m = read('electron/main.cjs');
const bundle = read('src/libmpv-shared.generated.js');
const p = JSON.parse(read('package.json'));
for (const marker of ['LILAC_R34_FOCUS_HANDOFF','r34MirrorChromiumDuringHandoff','SetNativePresenterMirrorChromium','setNativePresenterMirrorChromium']) assert(n.includes(marker), `R34 native marker missing: ${marker}`);
for (const marker of ['r34FocusHandoffPending','r34BeginFocusHandoff','r34CompleteFocusHandoff','r34SetNativeSubtitleVisible','r27LastDispatchWallMs = 0']) assert(b.includes(marker), `R34 bridge marker missing: ${marker}`);
assert(!e.includes("document.hasFocus() ? 'no' : 'yes'"), 'R34 renderer subtitle focus race survived');
for (const marker of ['LILAC_R34_SUBTITLE_SINGLE_OWNER',"'sub-ass-override', 'force'",'_r34NativeSubtitleLoaded']) assert(e.includes(marker) && bundle.includes(marker), `R34 subtitle marker missing: ${marker}`);
for (const marker of ['LILAC_R34_CACHE_WRITE_WORKER','r34QueueJsonWrite','cache-write-worker.cjs']) assert(m.includes(marker), `R34 main cache-worker marker missing: ${marker}`);
assert(!m.includes("saveCatalogFile(provider,name,value){const key=`${provider}-${name}`;clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{fs.writeFileSync"), 'R34 blocking catalog writer survived');
assert(p.build.asarUnpack.includes('electron/cache-write-worker.cjs'), 'R34 cache worker missing from asarUnpack');
assert(read('electron/cache-write-worker.cjs').includes('pending.set') && read('electron/cache-write-worker.cjs').includes('fs.promises.writeFile'), 'R34 cache worker source invalid');
console.log('R34_FOCUS_HANDOFF_STALL_FIX_OK handoff=native+chromium-until-consumed subtitle=single-main-owner+ass-force cacheWrites=worker-coalesced r27NativeGapReset=1');

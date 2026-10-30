$ErrorActionPreference='Stop'

function Assert-Exit([string]$label){ if($LASTEXITCODE-ne 0){ throw "$label failed with exit code $LASTEXITCODE" } }
function Sha256([string]$path){ (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }

# R39's qualified builder intentionally reconstructs a historical clean worktree.
# Preserve every R40 source outside it and restore only after R39 final6 has passed.
$stash=Join-Path $env:RUNNER_TEMP 'lilac-r40-preflight-support'
Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stash | Out-Null
$scriptSupport=@(
  'r40-callback-pacing-fix.cjs',
  'r40-callback-watchdog-authority-correction.cjs',
  'r40-release-pump-authority-correction.cjs',
  'r40-schedule-callsite-audit.cjs',
  'r40-callback-pacing-runtime-smoke.cjs',
  'r40-native-subtitle-overlay-runtime-smoke.cjs',
  'r40-subtitle-runtime-focus-hardening.cjs',
  'r40-subtitle-runtime-coverage-hardening.cjs',
  'r40-subtitle-controller-lifecycle-hardening.cjs',
  'r40-single-dom-subtitle-overlay-fix.cjs',
  'r40-subtitle-anchor-compat.cjs',
  'r40-run-electron-gate.cjs',
  'r40-rebundle-renderer.cjs',
  'r40-finalize-identity.cjs',
  'r40-preflight.ps1'
)
$electronSupport=@(
  'r40-subtitle-overlay.html',
  'r40-subtitle-overlay-preload.cjs',
  'r40-subtitle-overlay-window.cjs'
)
foreach($name in $scriptSupport){
  $src=Join-Path 'scripts' $name
  if(-not(Test-Path $src)){throw "R40 preflight support missing before R39 reconstruction: $name"}
  Copy-Item $src (Join-Path $stash $name) -Force
}
foreach($name in $electronSupport){
  $src=Join-Path 'electron' $name
  if(-not(Test-Path $src)){throw "R40 overlay support missing before R39 reconstruction: $name"}
  Copy-Item $src (Join-Path $stash $name) -Force
}

Write-Host 'R40_PREFLIGHT_BEGIN baseline=exact-R39-final6 candidate=callback-pacing+single-dom-subtitle-overlay'

# Same sanitizers and exact qualification entrypoint as authoritative R39 final6.
node scripts/r32-transform-source-sanitize.cjs
Assert-Exit 'R40 preflight R32 transform sanitize'
node scripts/r33-transform-source-sanitize.cjs
Assert-Exit 'R40 preflight R33 transform sanitize'
node scripts/r36-transform-r35-anchor-compat.cjs
Assert-Exit 'R40 preflight R36 transform compat'
& ./scripts/r39-final-wrapper-v4.ps1
Assert-Exit 'R40 preflight exact R39 final6 reconstruction/qualification'

# Rehydrate candidate-only files after R39's historical clean checkout.
New-Item -ItemType Directory -Force -Path scripts | Out-Null
New-Item -ItemType Directory -Force -Path electron | Out-Null
foreach($name in $scriptSupport){ Copy-Item (Join-Path $stash $name) (Join-Path 'scripts' $name) -Force }
foreach($name in $electronSupport){ Copy-Item (Join-Path $stash $name) (Join-Path 'electron' $name) -Force }

$updaterBefore=Sha256 'electron/updater.cjs'
$focusedPreloadBefore=Sha256 'electron/libmpv-shared-preload.cjs'
$focusedBundleBefore=Sha256 'electron/preload-libmpv-shared.generated.cjs'
$dllBefore=Sha256 'electron/libmpv-2.dll'
if($dllBefore-ne $env:QUALIFIED_DLL_SHA256){throw 'R40 preflight R39 DLL baseline mismatch'}

foreach($script in $scriptSupport | Where-Object {$_ -like '*.cjs'}){
  node --check (Join-Path 'scripts' $script)
  Assert-Exit "R40 syntax $script"
}
foreach($script in @('electron/r40-subtitle-overlay-preload.cjs','electron/r40-subtitle-overlay-window.cjs')){
  node --check $script
  Assert-Exit "R40 syntax $script"
}

# Harden hosted-Windows subtitle proof. First require a genuine rival focus after
# the R33 presenter is already visible, then add deliberate focus-order race,
# custom-font readiness, nested markup and natural multiline geometry coverage.
node scripts/r40-subtitle-runtime-focus-hardening.cjs
Assert-Exit 'R40 subtitle runtime post-presenter focus hardening'
node scripts/r40-subtitle-runtime-coverage-hardening.cjs
Assert-Exit 'R40 subtitle runtime race/font/multiline coverage hardening'
node --check scripts/r40-native-subtitle-overlay-runtime-smoke.cjs
Assert-Exit 'R40 fully hardened subtitle runtime smoke syntax'

# Normalize only the R40 transform script itself against exact final-R39 formatting.
# Product files are still fail-closed and are not modified by this compatibility pass.
node scripts/r40-subtitle-anchor-compat.cjs scripts/r40-single-dom-subtitle-overlay-fix.cjs
Assert-Exit 'R40 subtitle transform anchor compat'
node --check scripts/r40-single-dom-subtitle-overlay-fix.cjs
Assert-Exit 'R40 subtitle transform syntax after compat'

node scripts/r40-callback-pacing-fix.cjs
Assert-Exit 'R40 callback pacing transform'
node scripts/r40-callback-watchdog-authority-correction.cjs
Assert-Exit 'R40 native producer callback authority correction'
node scripts/r40-release-pump-authority-correction.cjs
Assert-Exit 'R40 release-time immediate pump authority correction'
node scripts/r40-single-dom-subtitle-overlay-fix.cjs
Assert-Exit 'R40 single DOM subtitle transform'
node scripts/r40-subtitle-controller-lifecycle-hardening.cjs
Assert-Exit 'R40 subtitle owner-blur deferred replay lifecycle hardening'
node scripts/r40-rebundle-renderer.cjs
Assert-Exit 'R40 renderer rebundle'
node scripts/r40-finalize-identity.cjs
Assert-Exit 'R40 identity'

# Read-only audit of the fully generated bridge. This must run before native
# compilation/runtime so every schedulePump caller is visible in CI logs and a
# pacing failure can be attributed to an exact source location instead of guessed.
node scripts/r40-schedule-callsite-audit.cjs
Assert-Exit 'R40 schedulePump generated-callsite audit'

# Parse all changed JavaScript before native compilation.
foreach($script in @(
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/libmpv-shared-main.cjs',
  'src/libmpv-shared-entry.js',
  'src/libmpv-shared.generated.js',
  'electron/r40-subtitle-overlay-preload.cjs',
  'electron/r40-subtitle-overlay-window.cjs'
)){
  node --check $script
  Assert-Exit "R40 post-transform syntax $script"
}

$native=Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$bridge=Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$entry=Get-Content 'src/libmpv-shared-entry.js' -Raw
$renderer=Get-Content 'src/libmpv-shared.generated.js' -Raw
$main=Get-Content 'electron/main.cjs' -Raw
$preload=Get-Content 'electron/preload.cjs' -Raw
$overlayController=Get-Content 'electron/r40-subtitle-overlay-window.cjs' -Raw
$overlayPreload=Get-Content 'electron/r40-subtitle-overlay-preload.cjs' -Raw
foreach($marker in @('LILAC_R40_CALLBACK_AUTHORITATIVE_PRODUCER','producerWaitingForSlot','producerSignalWakeups','producerWatchdogWakeups','producerReleaseWakeups')){if(-not $native.Contains($marker)){throw "R40 native marker missing: $marker"}}
foreach($marker in @('LILAC_R40_FRESH_FRAME_WAKE_GATING','LILAC_R40_PRODUCER_CALLBACK_AUTHORITY','LILAC_R40_RELEASE_CALLBACK_AUTHORITY','r40FreshFrameSignals','r40StaleFrameSignals','r40NoFrameTimerTicks','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')){if(-not $bridge.Contains($marker)){throw "R40 bridge marker missing: $marker"}}
# Source-only comments prove the transform ran; bundled output is checked against
# executable symbols/strings because esbuild may strip comments by design.
foreach($marker in @('LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY','_r40SubtitleComputedStyle','_r40SubtitlePayload','_r40QueueSubtitleOverlaySync')){if(-not $entry.Contains($marker)){throw "R40 renderer source marker missing: $marker"}}
foreach($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','_r40SubtitleComputedStyle','_r40SubtitlePayload','_r40QueueSubtitleOverlaySync','setNativeSubtitleOverlay','getBoundingClientRect')){if(-not $renderer.Contains($marker)){throw "R40 renderer bundle semantic marker missing: $marker"}}
foreach($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY','R40SubtitleOverlayWindowController',"player:native-subtitle-overlay","reconcileDeferred(win, 'owner-blur')")){if(-not $main.Contains($marker)){throw "R40 main overlay marker missing: $marker"}}
foreach($marker in @('setNativeSubtitleOverlay','nativeSubtitleOverlayState')){if(-not $preload.Contains($marker)){throw "R40 preload overlay marker missing: $marker"}}
foreach($marker in @('LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY','deferredActivePayload','deferredReplayCount','async reconcileDeferred(')){if(-not $overlayController.Contains($marker)){throw "R40 overlay controller race marker missing: $marker"}}
foreach($marker in @('LILAC_R40_CUSTOM_FONT_FORMAT_AGNOSTIC','document.fonts.load','renderGeneration','fontReady')){if(-not $overlayPreload.Contains($marker)){throw "R40 overlay font marker missing: $marker"}}
if($overlayPreload.Contains('format("truetype")')){throw 'R40 overlay reintroduced hard-coded truetype font hint'}
if($native.Contains('std::chrono::milliseconds(6)')){throw 'R40 native 6ms producer polling survived'}
if($bridge.Contains('focus-staged-gpu-copy')-or$bridge.Contains('copyTextureToTexture')){throw 'R40 resurrected forbidden R28 staged renderer path'}
if($native.Contains('--disable-direct-composition')){throw 'R40 resurrected forbidden R25 Direct Composition disable'}
if((Sha256 'electron/updater.cjs')-ne $updaterBefore){throw 'R40 changed protected R38 updater'}
if((Sha256 'electron/libmpv-shared-preload.cjs')-ne $focusedPreloadBefore-or(Sha256 'electron/preload-libmpv-shared.generated.cjs')-ne $focusedBundleBefore){throw 'R40 changed protected focused direct-WebGPU preload bytes'}
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R40 changed qualified libmpv DLL'}

# R40 changes native producer synchronization, so compile it for the same Electron ABI.
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R40 native addon compile'
$rebuilt='native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if(-not(Test-Path $rebuilt)){throw 'R40 compiled addon missing'}
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R40 DLL drifted after native compile'}

# Hard runtime gates. The parent launcher requires an explicit success marker as
# well as exit code 0, so an Electron app.quit() false-pass cannot qualify R40.
$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL=(Resolve-Path 'electron/libmpv-2.dll').Path
try{
  node scripts/r40-run-electron-gate.cjs scripts/r40-callback-pacing-runtime-smoke.cjs R40_CALLBACK_PACING_RUNTIME_OK 180000
  Assert-Exit 'R40 callback pacing runtime hard gate'
  node scripts/r40-run-electron-gate.cjs scripts/r40-native-subtitle-overlay-runtime-smoke.cjs R40_NATIVE_SUBTITLE_OVERLAY_RUNTIME_OK 150000
  Assert-Exit 'R40 native subtitle overlay race/font/multiline/raw-HWND pixel hard gate'
  node scripts/r37-run-e2e-with-timeout.cjs scripts/r37-explicit-handoff-e2e-smoke.cjs 180000
  Assert-Exit 'R40 protected R37 raw shared-texture E2E'
  node scripts/r40-run-electron-gate.cjs scripts/r39-miniplayer-native-topmost-runtime-smoke.cjs R39_MINIPLAYER_NATIVE_TOPMOST_RUNTIME_OK 150000
  Assert-Exit 'R40 protected R39 mini-player/native topmost hard gate'
}
finally{
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}

$pkg=Get-Content 'package.json' -Raw|ConvertFrom-Json
if($pkg.version-ne '0.5.54-libmpv-r3f.rc20'-or$pkg.lilacCustomTag-ne 'libmpv-r2k-v0.5.54-r40'){throw 'R40 candidate identity mismatch'}
Write-Host "R40_PREFLIGHT_OK version=$($pkg.version) electron=$env:ELECTRON_VERSION callbackProducer=compiled+pacing-runtime-hard-gated releaseWake=backpressure-only releasePump=legacy-only jsWake=frameId-gated+producer-authority subtitle=single-DOM+multiline+custom-font-ready+focus-race-replayed+raw-HWND-pixel-gated overlay=transparent-owned-window r33=preserved r37=raw-e2e-repassed r38Updater=byte-identical r39PiP=real-native-topmost-repassed focused=direct-webgpu-byte-identical addonSha=$(Sha256 'electron/lilac-libmpv-player-bridge.node') dll=$dllBefore"

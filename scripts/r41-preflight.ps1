$ErrorActionPreference='Stop'
function Assert-Exit([string]$label){ if($LASTEXITCODE-ne 0){ throw "$label failed with exit code $LASTEXITCODE" } }
function Sha256([string]$path){ (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }

# R40 preflight reconstructs a historical clean worktree, so preserve R41-only
# support outside the repository and restore it after the fully qualified R40 base.
$stash=Join-Path $env:RUNNER_TEMP 'lilac-r41-preflight-support'
Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stash|Out-Null
$r41Support=@('r41-visual-handoff-continuity-fix.cjs','r41-live-handoff-native-smoke.cjs','r41-preflight.ps1')
foreach($name in $r41Support){
  $src=Join-Path 'scripts' $name
  if(-not(Test-Path $src)){throw "R41 support missing before R40 reconstruction: $name"}
  Copy-Item $src (Join-Path $stash $name) -Force
}

Write-Host 'R41_PREFLIGHT_BEGIN baseline=qualified-R40 evidence=user-black-frame+648-776ms-refocus-gap candidate=live-native-handoff+sustained-webgpu-visual-commit'
try {
  ./scripts/r40-preflight.ps1
  Assert-Exit 'R41 exact R40 qualification baseline'
}
finally {
  New-Item -ItemType Directory -Force -Path scripts|Out-Null
  foreach($name in $r41Support){ Copy-Item (Join-Path $stash $name) (Join-Path 'scripts' $name) -Force }
}

$updaterBefore=Sha256 'electron/updater.cjs'
$dllBefore=Sha256 'electron/libmpv-2.dll'
$mainBefore=Sha256 'electron/main.cjs'
$subtitleControllerBefore=Sha256 'electron/r40-subtitle-overlay-window.cjs'
$subtitlePreloadBefore=Sha256 'electron/r40-subtitle-overlay-preload.cjs'

foreach($script in @('scripts/r41-visual-handoff-continuity-fix.cjs','scripts/r41-live-handoff-native-smoke.cjs')){
  node --check $script
  Assert-Exit "R41 syntax $script"
}
node scripts/r41-visual-handoff-continuity-fix.cjs
Assert-Exit 'R41 visual handoff continuity transform'

foreach($script in @('electron/libmpv-shared-main.cjs','electron/libmpv-shared-preload.cjs','electron/preload-libmpv-shared.generated.cjs')){
  node --check $script
  Assert-Exit "R41 generated syntax $script"
}

$native=Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$bridge=Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$preload=Get-Content 'electron/libmpv-shared-preload.cjs' -Raw
$bundle=Get-Content 'electron/preload-libmpv-shared.generated.cjs' -Raw
foreach($marker in @('LILAC_R41_LIVE_NATIVE_HANDOFF')){if(-not $native.Contains($marker)){throw "R41 native marker missing: $marker"}}
foreach($marker in @('r41HandoffPlaying','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','LILAC_R40_HANDOFF_FORCE_REDRAW')){if(-not $bridge.Contains($marker)){throw "R41 bridge marker missing: $marker"}}
foreach($marker in @('LILAC_R41_VISUAL_HANDOFF_COMMIT','r41ScheduleVisualHandoffAck','r41HandoffStableStartedAt','r41HandoffStableResets','requestAnimationFrame(() => requestAnimationFrame(commit))',"presentationMode = 'direct-receive-webgpu-copy'",'copyExternalImageToTexture')){if(-not $preload.Contains($marker)){throw "R41 preload marker missing: $marker"}}
# esbuild rewrites whitespace/assignment formatting, so packaged semantics are
# gated by stable behavior tokens rather than source-format text.
foreach($marker in @('LILAC_R41_VISUAL_HANDOFF_COMMIT','r41ScheduleVisualHandoffAck','direct-receive-webgpu-copy','copyExternalImageToTexture')){if(-not $bundle.Contains($marker)){throw "R41 bundled preload marker missing: $marker"}}
if($native.Contains('LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF')){throw 'R41 retained obsolete R37 native handoff freeze'}
foreach($forbidden in @('copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition')){if($native.Contains($forbidden)-or$bridge.Contains($forbidden)-or$preload.Contains($forbidden)){throw "R41 forbidden path present: $forbidden"}}
if((Sha256 'electron/updater.cjs')-ne $updaterBefore){throw 'R41 changed protected R38 updater'}
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R41 changed qualified libmpv DLL'}
if((Sha256 'electron/main.cjs')-ne $mainBefore){throw 'R41 unexpectedly changed main process outside shared bridge'}
if((Sha256 'electron/r40-subtitle-overlay-window.cjs')-ne $subtitleControllerBefore-or(Sha256 'electron/r40-subtitle-overlay-preload.cjs')-ne $subtitlePreloadBefore){throw 'R41 changed protected R40 subtitle overlay implementation'}

# Native presentation semantics changed only at the mirror handoff conditional.
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R41 native addon compile'
$rebuilt='native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if(-not(Test-Path $rebuilt)){throw 'R41 compiled addon missing'}
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R41 DLL drifted after native compile'}

$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL=(Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r40-run-electron-gate.cjs scripts/r41-live-handoff-native-smoke.cjs R41_LIVE_NATIVE_HANDOFF_RUNTIME_OK 150000
  Assert-Exit 'R41 live native handoff runtime hard gate'

  # R37 E2E now exercises the real delayed ACK path. R40 pacing then proves that
  # focused direct-WebGPU recovery/cadence is still intact after ownership swap.
  node scripts/r37-run-e2e-with-timeout.cjs scripts/r37-explicit-handoff-e2e-smoke.cjs 180000
  Assert-Exit 'R41 protected R37 explicit handoff E2E'
  node scripts/r40-run-electron-gate.cjs scripts/r40-callback-pacing-runtime-smoke.cjs R40_CALLBACK_PACING_RUNTIME_OK 180000
  Assert-Exit 'R41 R40 direct-WebGPU callback pacing regression gate'
  node scripts/r40-run-electron-gate.cjs scripts/r40-native-subtitle-overlay-runtime-smoke.cjs R40_NATIVE_SUBTITLE_OVERLAY_RUNTIME_OK 150000
  Assert-Exit 'R41 R40 subtitle overlay regression gate'
  node scripts/r40-run-electron-gate.cjs scripts/r39-miniplayer-native-topmost-runtime-smoke.cjs R39_MINIPLAYER_NATIVE_TOPMOST_RUNTIME_OK 150000
  Assert-Exit 'R41 R39 mini-player/native topmost regression gate'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}

$pkg=Get-Content 'package.json' -Raw|ConvertFrom-Json
if($pkg.version-ne '0.5.54-libmpv-r3f.rc21'-or$pkg.lilacCustomTag-ne 'libmpv-r2k-v0.5.54-r41'){throw 'R41 candidate identity mismatch'}
Write-Host "R41_PREFLIGHT_OK version=$($pkg.version) evidence=user-r40-black+focus-gaps nativeHandoff=live-mirror chromiumCommit=stable-250ms+double-raf pausedCommit=single-frame+double-raf focused=direct-webgpu r33=preserved r37=semantic-e2e-repassed r38Updater=byte-identical r39Topmost=repassed r40Subtitle=repassed r25=absent r28=absent addonSha=$(Sha256 'electron/lilac-libmpv-player-bridge.node') dll=$dllBefore"

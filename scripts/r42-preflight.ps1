$ErrorActionPreference='Stop'
function Assert-Exit([string]$label){ if($LASTEXITCODE-ne 0){ throw "$label failed with exit code $LASTEXITCODE" } }
function Sha256([string]$path){ (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }

# R41/R40 qualification reconstructs historical worktrees. Preserve every R42
# support file outside the repository and restore it after exact R41 qualification.
$stash=Join-Path $env:RUNNER_TEMP 'lilac-r42-diagnostic-support'
Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stash | Out-Null
$r42Support=@(Get-ChildItem scripts -File -Filter 'r42-*' | Select-Object -ExpandProperty Name)
if(-not($r42Support -contains 'r42-subtitle-handoff-diagnostic.cjs')){throw 'R42 transform missing before R41 reconstruction'}
if(-not($r42Support -contains 'r42-preflight.ps1')){throw 'R42 preflight missing before R41 reconstruction'}
foreach($name in $r42Support){ Copy-Item (Join-Path 'scripts' $name) (Join-Path $stash $name) -Force }

Write-Host 'R42_DIAGNOSTIC_PREFLIGHT_BEGIN baseline=qualified-R41 scope=subtitle-handoff-observation-only'
try {
  ./scripts/r41-preflight.ps1
  Assert-Exit 'R42 exact R41 qualification baseline'
}
finally {
  New-Item -ItemType Directory -Force -Path scripts | Out-Null
  foreach($name in $r42Support){ Copy-Item (Join-Path $stash $name) (Join-Path 'scripts' $name) -Force }
}

$updaterBefore=Sha256 'electron/updater.cjs'
$focusedPreloadBefore=Sha256 'electron/libmpv-shared-preload.cjs'
$focusedBundleBefore=Sha256 'electron/preload-libmpv-shared.generated.cjs'
$nativeSourceBefore=Sha256 'native/libmpv-d3d11-bridge/player_addon.cc'
$addonBefore=Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllBefore=Sha256 'electron/libmpv-2.dll'
$pkgBefore=Sha256 'package.json'

node --check scripts/r42-subtitle-handoff-diagnostic.cjs
Assert-Exit 'R42 transform syntax'
node scripts/r42-subtitle-handoff-diagnostic.cjs
Assert-Exit 'R42 subtitle handoff diagnostic transform'

# The source subtitle serializer is part of the normal renderer bundle. Rebuild it
# with the same qualified R40/R41 bundler; focused WebGPU preload is untouched.
node scripts/r40-rebundle-renderer.cjs
Assert-Exit 'R42 renderer rebundle'

foreach($script in @(
  'src/libmpv-shared-entry.js',
  'src/libmpv-shared.generated.js',
  'electron/main.cjs',
  'electron/libmpv-shared-main.cjs',
  'electron/r40-subtitle-overlay-window.cjs',
  'electron/r40-subtitle-overlay-preload.cjs'
)){
  node --check $script
  Assert-Exit "R42 post-transform syntax $script"
}

# Fail closed if this diagnostic build drifts any protected playback/update binary
# or identity. Only the source DOM subtitle serializer, subtitle overlay, main
# diagnostic getter and bridge diagnostics object may differ from qualified R41.
if((Sha256 'electron/updater.cjs')-ne $updaterBefore){throw 'R42 changed protected R38 updater'}
if((Sha256 'electron/libmpv-shared-preload.cjs')-ne $focusedPreloadBefore){throw 'R42 changed focused direct-WebGPU preload'}
if((Sha256 'electron/preload-libmpv-shared.generated.cjs')-ne $focusedBundleBefore){throw 'R42 changed focused direct-WebGPU preload bundle'}
if((Sha256 'native/libmpv-d3d11-bridge/player_addon.cc')-ne $nativeSourceBefore){throw 'R42 changed R41 native presenter source'}
if((Sha256 'electron/lilac-libmpv-player-bridge.node')-ne $addonBefore){throw 'R42 changed R41 native addon'}
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R42 changed qualified libmpv DLL'}
if((Sha256 'package.json')-ne $pkgBefore){throw 'R42 changed R41 package/update identity'}

$entry=Get-Content 'src/libmpv-shared-entry.js' -Raw
$renderer=Get-Content 'src/libmpv-shared.generated.js' -Raw
$main=Get-Content 'electron/main.cjs' -Raw
$bridge=Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$controller=Get-Content 'electron/r40-subtitle-overlay-window.cjs' -Raw
$overlayPreload=Get-Content 'electron/r40-subtitle-overlay-preload.cjs' -Raw
foreach($pair in @(
  @($entry,'_r42SubtitleStyleDiagnostic'),
  @($renderer,'_r42SubtitleStyleDiagnostic'),
  @($main,'__lilacR42SubtitleOverlayDiagnostics'),
  @($bridge,'r42SubtitleOverlay'),
  @($controller,'diagnosticTrace'),
  @($overlayPreload,'r42SchedulePaintSnapshots')
)){
  if(-not([string]$pair[0]).Contains([string]$pair[1])){throw "R42 diagnostic marker missing $($pair[1])"}
}
foreach($text in @($entry,$renderer,$main,$bridge,$controller,$overlayPreload)){
  if(-not $text.Contains('LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC')){throw 'R42 common diagnostic marker missing'}
}
foreach($forbidden in @('copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition')){
  if($bridge.Contains($forbidden)-or$entry.Contains($forbidden)){throw "R42 introduced forbidden path $forbidden"}
}

# Re-run the two runtime gates nearest this change. R41 preflight already re-passed
# the entire protected baseline before instrumentation was applied.
$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL=(Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r40-run-electron-gate.cjs scripts/r40-native-subtitle-overlay-runtime-smoke.cjs R40_NATIVE_SUBTITLE_OVERLAY_RUNTIME_OK 150000
  Assert-Exit 'R42 modified subtitle overlay runtime regression gate'
  node scripts/r40-run-electron-gate.cjs scripts/r41-live-handoff-native-smoke.cjs R41_LIVE_NATIVE_HANDOFF_RUNTIME_OK 150000
  Assert-Exit 'R42 protected R41 live native handoff regression gate'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}

Write-Host "R42_DIAGNOSTIC_PREFLIGHT_OK updater=$updaterBefore focusedPreload=$focusedPreloadBefore addon=$addonBefore dll=$dllBefore sourceStyle=opacity+transition+animation overlayTrace=256 paintSamples=commit+raf2+50/100/200/300ms identity=R41-unchanged"

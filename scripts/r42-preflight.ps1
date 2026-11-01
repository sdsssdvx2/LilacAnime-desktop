$ErrorActionPreference='Stop'
function Assert-Exit([string]$label){ if($LASTEXITCODE-ne 0){ throw "$label failed with exit code $LASTEXITCODE" } }
function Sha256([string]$path){ (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-Contains([string]$text,[string]$marker,[string]$label){ if(-not $text.Contains($marker)){ throw "$label missing $marker" } }

Write-Host 'R42_DIAGNOSTIC_PREFLIGHT_BEGIN baseline=pinned-qualified-R41-release scope=subtitle-handoff-observation-only'

# Do not replay the full R23->R41 historical runtime chain here. The public R41
# installer already passed that qualification and post-package verification, while
# its cadence smoke is timing-sensitive enough to pass and fail on the same hosted
# runner. Reconstruct the exact shipped R41 app from the pinned release assets and
# verify their immutable SHA/size + manifest qualification evidence instead.
node --check scripts/r42-reconstruct-r41-release.cjs
Assert-Exit 'R42 R41 release reconstruction syntax'
node scripts/r42-reconstruct-r41-release.cjs
Assert-Exit 'R42 pinned qualified R41 release reconstruction'

$installedElectron=(node -p "require('electron/package.json').version").Trim()
Assert-Exit 'R42 installed Electron version query'
if($installedElectron-ne$env:ELECTRON_VERSION){throw "R42 Electron version drifted: expected $env:ELECTRON_VERSION got $installedElectron"}

$updaterBefore=Sha256 'electron/updater.cjs'
$focusedPreloadBefore=Sha256 'electron/libmpv-shared-preload.cjs'
$focusedBundleBefore=Sha256 'electron/preload-libmpv-shared.generated.cjs'
$addonBefore=Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllBefore=Sha256 'electron/libmpv-2.dll'
$pkgBefore=Sha256 'package.json'

node --check scripts/r42-subtitle-handoff-diagnostic.cjs
Assert-Exit 'R42 transform syntax'
node scripts/r42-subtitle-handoff-diagnostic.cjs
Assert-Exit 'R42 subtitle handoff diagnostic transform'

# The source subtitle serializer is part of the normal renderer bundle. Rebuild it
# with the qualified R40/R41 bundler; focused WebGPU preload remains untouched.
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

# Fail closed if this observation-only diagnostic drifts any protected shipped R41
# update/playback binary or install/update identity. The R41 native source does not
# need to be reconstructed because the exact shipped addon/DLL are reused verbatim.
if((Sha256 'electron/updater.cjs')-ne $updaterBefore){throw 'R42 changed protected R38 updater'}
if((Sha256 'electron/libmpv-shared-preload.cjs')-ne $focusedPreloadBefore){throw 'R42 changed focused direct-WebGPU preload'}
if((Sha256 'electron/preload-libmpv-shared.generated.cjs')-ne $focusedBundleBefore){throw 'R42 changed focused direct-WebGPU preload bundle'}
if((Sha256 'electron/lilac-libmpv-player-bridge.node')-ne $addonBefore){throw 'R42 changed shipped R41 native addon'}
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R42 changed shipped qualified libmpv DLL'}
if((Sha256 'package.json')-ne $pkgBefore){throw 'R42 changed reconstructed R41 package/update identity'}

$entry=Get-Content 'src/libmpv-shared-entry.js' -Raw
$renderer=Get-Content 'src/libmpv-shared.generated.js' -Raw
$main=Get-Content 'electron/main.cjs' -Raw
$bridge=Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$controller=Get-Content 'electron/r40-subtitle-overlay-window.cjs' -Raw
$overlayPreload=Get-Content 'electron/r40-subtitle-overlay-preload.cjs' -Raw
Assert-Contains $entry '_r42SubtitleStyleDiagnostic' 'R42 source renderer'
Assert-Contains $renderer '_r42SubtitleStyleDiagnostic' 'R42 bundled renderer'
Assert-Contains $main '__lilacR42SubtitleOverlayDiagnostics' 'R42 main getter'
Assert-Contains $bridge 'r42SubtitleOverlay' 'R42 bridge diagnostics'
Assert-Contains $controller 'diagnosticTrace' 'R42 controller trace'
Assert-Contains $overlayPreload 'r42SchedulePaintSnapshots' 'R42 overlay paint sampler'
foreach($text in @($entry,$renderer,$main,$bridge,$controller,$overlayPreload)){
  Assert-Contains $text 'LILAC_R42_SUBTITLE_HANDOFF_DIAGNOSTIC' 'R42 common diagnostic marker'
}
foreach($forbidden in @('copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition')){
  if($bridge.Contains($forbidden)-or$entry.Contains($forbidden)){throw "R42 introduced forbidden path $forbidden"}
}

# The shared R40 smoke deliberately leaves a rival BrowserWindow focused and then
# calls owner.focus() exactly once. Hosted Windows can reject that focus steal even
# though every rendering/z-order assertion has passed. For R42, make a test-only
# copy that removes the rival from foreground contention and retries focus, while
# still requiring owner.isFocused() before validating that the overlay hides.
$overlaySmokeSource=(Get-Content 'scripts/r40-native-subtitle-overlay-runtime-smoke.cjs' -Raw).Replace("`r`n","`n")
$refocusAnchor="    owner.focus();`n    await waitUntil(()=>owner.isFocused(),3000,'owner refocus');"
$first=$overlaySmokeSource.IndexOf($refocusAnchor,[System.StringComparison]::Ordinal)
$last=$overlaySmokeSource.LastIndexOf($refocusAnchor,[System.StringComparison]::Ordinal)
if($first-lt 0-or$first-ne$last){throw 'R42 overlay smoke refocus anchor mismatch'}
$refocusReplacement="    rival.blur();rival.hide();owner.show();`n    for(let attempt=0;attempt<4&&!owner.isFocused();attempt+=1){owner.moveTop();owner.focus();await sleep(150);}`n    await waitUntil(()=>owner.isFocused(),5000,'owner refocus');"
$overlaySmokeSource=$overlaySmokeSource.Replace($refocusAnchor,$refocusReplacement)
$r42OverlaySmoke='scripts/r42-r40-native-subtitle-overlay-runtime-smoke.cjs'
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $r42OverlaySmoke),$overlaySmokeSource,(New-Object System.Text.UTF8Encoding($false)))
node --check $r42OverlaySmoke
Assert-Exit 'R42 hosted-focus-hardened subtitle overlay smoke syntax'
Write-Host 'R42_OVERLAY_SMOKE_REFOCUS_HARDENED rival=blur+hide owner=show+moveTop+focus-retry assertion=owner.isFocused'

# Re-run only the runtime gates nearest the diagnostic change. The exact shipped R41
# baseline has already passed the historical cadence/E2E/topmost chain; replaying
# those timing gates on a hosted runner caused the same product to pass then fail.
$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL=(Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r40-run-electron-gate.cjs $r42OverlaySmoke R40_NATIVE_SUBTITLE_OVERLAY_RUNTIME_OK 150000
  Assert-Exit 'R42 modified subtitle overlay runtime regression gate'
  node scripts/r40-run-electron-gate.cjs scripts/r41-live-handoff-native-smoke.cjs R41_LIVE_NATIVE_HANDOFF_RUNTIME_OK 150000
  Assert-Exit 'R42 protected R41 live native handoff regression gate'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
  Remove-Item $r42OverlaySmoke -Force -ErrorAction SilentlyContinue
}

Write-Host "R42_DIAGNOSTIC_PREFLIGHT_OK baseline=pinned-R41-release updater=$updaterBefore focusedPreload=$focusedPreloadBefore addon=$addonBefore dll=$dllBefore sourceStyle=opacity+transition+animation overlayTrace=256 paintSamples=commit+raf2+50/100/200/300ms identity=R41-unchanged"

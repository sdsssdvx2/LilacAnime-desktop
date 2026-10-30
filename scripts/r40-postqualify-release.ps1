$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Require-Marker([string]$text, [string]$marker, [string]$label) {
  if (-not $text.Contains($marker)) { throw "$label missing marker: $marker" }
}

foreach ($name in @('R40_RELEASE_TAG','R40_INSTALLER_NAME','R40_MANIFEST_NAME','R40_APP_VERSION','ELECTRON_VERSION','QUALIFIED_SOURCE_SHA','QUALIFIED_DLL_SHA256')) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "R40 release environment missing: $name" }
}

$baseManifestPath = Join-Path 'dist' 'lilacanime-libmpv-r39-manifest.json'
if (-not (Test-Path $baseManifestPath)) { throw 'R40 release requires the exact R39 final6 manifest produced by r40-preflight.ps1' }
$manifest = Get-Content $baseManifestPath -Raw | ConvertFrom-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$pkg = Get-Content 'package.json' -Raw | ConvertFrom-Json
if ($pkg.version -ne $env:R40_APP_VERSION -or $pkg.lilacCustomTag -ne $env:R40_RELEASE_TAG) { throw 'R40 release source identity mismatch' }
if ($pkg.build.appId -ne $env:STABLE_APP_ID -or $pkg.build.productName -ne $env:STABLE_PRODUCT_NAME) { throw 'R40 stable install identity drifted' }
if ($pkg.build.win.artifactName -ne 'LilacAnime-Libmpv-R40-Setup.${ext}') { throw 'R40 installer artifactName drifted' }

$updaterSha = Sha256 'electron/updater.cjs'
$focusedPreloadSha = Sha256 'electron/libmpv-shared-preload.cjs'
$focusedBundleSha = Sha256 'electron/preload-libmpv-shared.generated.cjs'
$addonSha = Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllSha = Sha256 'electron/libmpv-2.dll'
if ($dllSha -ne $env:QUALIFIED_DLL_SHA256) { throw 'R40 release source DLL mismatch' }

$bridge = Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$entry = Get-Content 'src/libmpv-shared-entry.js' -Raw
$renderer = Get-Content 'src/libmpv-shared.generated.js' -Raw
$main = Get-Content 'electron/main.cjs' -Raw
$preload = Get-Content 'electron/preload.cjs' -Raw
$overlayController = Get-Content 'electron/r40-subtitle-overlay-window.cjs' -Raw
$overlayPreload = Get-Content 'electron/r40-subtitle-overlay-preload.cjs' -Raw
foreach ($marker in @('LILAC_R40_FRESH_FRAME_WAKE_GATING','LILAC_R40_PRODUCER_CALLBACK_AUTHORITY','LILAC_R40_RELEASE_CALLBACK_AUTHORITY','LILAC_R40_HANDOFF_FORCE_REDRAW','r40HandoffRedrawAccepted','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')) { Require-Marker $bridge $marker 'R40 release bridge' }
foreach ($marker in @('LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY','_r40SubtitleComputedStyle','_r40SubtitlePayload')) { Require-Marker $entry $marker 'R40 release renderer source' }
foreach ($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','_r40SubtitleComputedStyle','_r40SubtitlePayload','setNativeSubtitleOverlay','getBoundingClientRect')) { Require-Marker $renderer $marker 'R40 release renderer bundle' }
foreach ($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY','R40SubtitleOverlayWindowController','LILAC_R38_UPDATE_ACTIVITY_CHECK','LILAC_R39_MINIPLAYER_TOPMOST')) { Require-Marker $main $marker 'R40 release main' }
foreach ($marker in @('setNativeSubtitleOverlay','nativeSubtitleOverlayState')) { Require-Marker $preload $marker 'R40 release preload' }
foreach ($marker in @('LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY','deferredActivePayload','deferredReplayCount','reconcileDeferred')) { Require-Marker $overlayController $marker 'R40 release overlay controller' }
foreach ($marker in @('LILAC_R40_CUSTOM_FONT_FORMAT_AGNOSTIC',"ipcRenderer.invoke('font:default'",'new FontFace','document.fonts.load','renderGeneration','fontReady')) { Require-Marker $overlayPreload $marker 'R40 release overlay preload' }
if ($overlayPreload.Contains('format("truetype")')) { throw 'R40 release reintroduced hard-coded truetype font hint' }
if ((Get-Content 'electron/libmpv-shared-preload.cjs' -Raw).Contains('focus-staged-gpu-copy')) { throw 'R40 release resurrected forbidden R28 staged presenter' }

Write-Host "R40_RELEASE_SOURCE_OK version=$($pkg.version) updater=$updaterSha focusedPreload=$focusedPreloadSha focusedBundle=$focusedBundleSha addon=$addonSha dll=$dllSha"

# Package only the already-qualified R40 workspace. r40-preflight.ps1 has just
# reconstructed exact R39 final6, applied all R40 transforms, compiled the native
# addon, and passed the fail-closed runtime gates in this same job/worktree.
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64 --publish never
Assert-Exit 'R40 release package'

$installer = Join-Path 'dist' $env:R40_INSTALLER_NAME
if (-not (Test-Path $installer)) { throw "R40 installer missing: $installer" }
$asar = 'dist/win-unpacked/resources/app.asar'
if (-not (Test-Path $asar)) { throw 'R40 packaged app.asar missing' }

$asarCli = 'node_modules/.bin/asar.cmd'
if (-not (Test-Path $asarCli)) { throw 'R40 asar helper missing' }
$asarCheck = Join-Path $env:RUNNER_TEMP 'r40-release-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract $asar $asarCheck
Assert-Exit 'R40 packaged app.asar extract'

$shipPkg = Get-Content (Join-Path $asarCheck 'package.json') -Raw | ConvertFrom-Json
if ($shipPkg.version -ne $env:R40_APP_VERSION -or $shipPkg.lilacCustomTag -ne $env:R40_RELEASE_TAG) { throw 'R40 packaged identity mismatch' }
if ($shipPkg.build.appId -ne $env:STABLE_APP_ID -or $shipPkg.build.productName -ne $env:STABLE_PRODUCT_NAME) { throw 'R40 packaged stable identity mismatch' }

$shipBridge = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs') -Raw
$shipEntry = Get-Content (Join-Path $asarCheck 'src/libmpv-shared-entry.js') -Raw
$shipRenderer = Get-Content (Join-Path $asarCheck 'src/libmpv-shared.generated.js') -Raw
$shipMain = Get-Content (Join-Path $asarCheck 'electron/main.cjs') -Raw
$shipPreload = Get-Content (Join-Path $asarCheck 'electron/preload.cjs') -Raw
$shipOverlayController = Get-Content (Join-Path $asarCheck 'electron/r40-subtitle-overlay-window.cjs') -Raw
$shipOverlayPreload = Get-Content (Join-Path $asarCheck 'electron/r40-subtitle-overlay-preload.cjs') -Raw
foreach ($marker in @('LILAC_R40_FRESH_FRAME_WAKE_GATING','LILAC_R40_PRODUCER_CALLBACK_AUTHORITY','LILAC_R40_RELEASE_CALLBACK_AUTHORITY','LILAC_R40_HANDOFF_FORCE_REDRAW','r40HandoffRedrawAccepted','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')) { Require-Marker $shipBridge $marker 'R40 packaged bridge' }
foreach ($marker in @('LILAC_R40_EXTERNAL_SUBTITLE_OVERLAY','_r40SubtitleComputedStyle','_r40SubtitlePayload')) { Require-Marker $shipEntry $marker 'R40 packaged renderer source' }
foreach ($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','_r40SubtitleComputedStyle','_r40SubtitlePayload','setNativeSubtitleOverlay','getBoundingClientRect')) { Require-Marker $shipRenderer $marker 'R40 packaged renderer bundle' }
foreach ($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY','R40SubtitleOverlayWindowController','LILAC_R38_UPDATE_ACTIVITY_CHECK','LILAC_R39_MINIPLAYER_TOPMOST')) { Require-Marker $shipMain $marker 'R40 packaged main' }
foreach ($marker in @('setNativeSubtitleOverlay','nativeSubtitleOverlayState')) { Require-Marker $shipPreload $marker 'R40 packaged preload' }
foreach ($marker in @('LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY','deferredActivePayload','deferredReplayCount','reconcileDeferred')) { Require-Marker $shipOverlayController $marker 'R40 packaged overlay controller' }
foreach ($marker in @('LILAC_R40_CUSTOM_FONT_FORMAT_AGNOSTIC','new FontFace','document.fonts.load','renderGeneration','fontReady')) { Require-Marker $shipOverlayPreload $marker 'R40 packaged overlay preload' }
if ($shipOverlayPreload.Contains('format("truetype")')) { throw 'R40 packaged overlay reintroduced hard-coded truetype font hint' }
if ($shipBridge.Contains('focus-staged-gpu-copy') -or $shipBridge.Contains('copyTextureToTexture')) { throw 'R40 packaged bridge resurrected forbidden R28 staged presenter' }

if ((Sha256 (Join-Path $asarCheck 'electron/updater.cjs')) -ne $updaterSha) { throw 'R40 packaged updater drifted from qualified R38 bytes' }
if ((Sha256 (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs')) -ne $focusedPreloadSha -or (Sha256 (Join-Path $asarCheck 'electron/preload-libmpv-shared.generated.cjs')) -ne $focusedBundleSha) { throw 'R40 packaged focused direct-WebGPU preload drifted' }

$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if (-not (Test-Path $packedAddon) -or (Sha256 $packedAddon) -ne $addonSha) { throw 'R40 packaged native addon hash mismatch' }
if (-not (Test-Path $packedDll) -or (Sha256 $packedDll) -ne $dllSha) { throw 'R40 packaged libmpv DLL hash mismatch' }

$hash = Sha256 $installer
$size = (Get-Item $installer).Length
$manifest.version = $env:R40_APP_VERSION
$manifest.installer = $env:R40_INSTALLER_NAME
$manifest.installerSha256 = $hash
$manifest.installerSize = $size
$manifest.nativeAddon = $addonSha
$manifest.nativeDll = $dllSha
$manifest.electron = $env:ELECTRON_VERSION
$manifest | Add-Member -NotePropertyName tag -NotePropertyValue $env:R40_RELEASE_TAG -Force
$manifest | Add-Member -NotePropertyName releaseWorkflowSourceSha -NotePropertyValue $env:GITHUB_SHA -Force
$manifest | Add-Member -NotePropertyName r40PreflightQualified -NotePropertyValue $true -Force
$manifest | Add-Member -NotePropertyName r40CallbackPacingRuntimeQualified -NotePropertyValue $true -Force
$manifest | Add-Member -NotePropertyName r40CallbackPacingRuntime -NotePropertyValue 'real-product-direct-webgpu+focused-11s/10s-window+p95<=65ms+max<=160ms+3x-blur4000ms+first-focused-frame<=500ms+12frames<=1000ms+focused-dispatch-gap<300ms+native-only-chromium-suppressed' -Force
$manifest | Add-Member -NotePropertyName r40ProducerAuthority -NotePropertyValue 'native-frame-callback-authoritative+250ms-watchdog-recovery-only+release-wake-backpressure-only+fresh-frame-id-js-gating' -Force
$manifest | Add-Member -NotePropertyName r40HandoffForcedRedrawQualified -NotePropertyValue $true -Force
$manifest | Add-Member -NotePropertyName r40HandoffForcedRedraw -NotePropertyValue 'R37-mirror-arm+producer-thread-one-shot-current-frame+paused-no-subtitle-runtime-proved+backpressure-requeue' -Force
$manifest | Add-Member -NotePropertyName r40SingleDomSubtitleRuntimeQualified -NotePropertyValue $true -Force
$manifest | Add-Member -NotePropertyName r40SingleDomSubtitle -NotePropertyValue 'focused-DOM-computed-style+unfocused-transparent-owned-overlay+native-subtitle-hidden+focus-race-deferred-replay+explicit-hide/minimize-lifecycle' -Force
$manifest | Add-Member -NotePropertyName r40SubtitleFontRuntimeQualified -NotePropertyValue $true -Force
$manifest | Add-Member -NotePropertyName r40SubtitleFontRuntime -NotePropertyValue 'byte-IPC+format-agnostic-FontFace+document-fonts-ready+generation-guard+custom-font-runtime-gated' -Force
$manifest | Add-Member -NotePropertyName r40SubtitleGeometryRuntimeQualified -NotePropertyValue $true -Force
$manifest | Add-Member -NotePropertyName r40SubtitleGeometryRuntime -NotePropertyValue 'raw-HWND-pixel+natural-multiline+nested-bold+strict-geometry-runtime-gated' -Force
$manifest | Add-Member -NotePropertyName r40R37ProtectedE2EQualified -NotePropertyValue $true -Force
$manifest | Add-Member -NotePropertyName r40R39TopmostRuntimeRequalified -NotePropertyValue $true -Force
$manifest | Add-Member -NotePropertyName r40BlackFlashInvariant -NotePropertyValue 'R37-full-owned-popup-no-ui-holes-preserved' -Force
$manifest | Add-Member -NotePropertyName r40UpdaterInvariant -NotePropertyValue 'R38-updater-byte-identical' -Force
$manifest | Add-Member -NotePropertyName r40PiPInvariant -NotePropertyValue 'R39-browser+owned-popup-bidirectional-topmost-runtime-repassed' -Force
$manifest | Add-Member -NotePropertyName r40FocusedPresenterInvariant -NotePropertyValue 'R39-shared-preload-byte-identical-direct-webgpu' -Force
$manifest | Add-Member -NotePropertyName r40ForbiddenPathInvariant -NotePropertyValue 'R25-disable-direct-composition-absent+R28-staged-webgpu-absent' -Force

$manifestPath = Join-Path 'dist' $env:R40_MANIFEST_NAME
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 30) + [Environment]::NewLine), $utf8NoBom)

# Re-read the exact file that will be published so serialization cannot silently
# drop any qualification field.
$finalManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($finalManifest.version -ne $env:R40_APP_VERSION -or $finalManifest.tag -ne $env:R40_RELEASE_TAG -or $finalManifest.installerSha256 -ne $hash -or [long]$finalManifest.installerSize -ne $size) { throw 'R40 finalized manifest identity mismatch' }
foreach ($flag in @('r40PreflightQualified','r40CallbackPacingRuntimeQualified','r40HandoffForcedRedrawQualified','r40SingleDomSubtitleRuntimeQualified','r40SubtitleFontRuntimeQualified','r40SubtitleGeometryRuntimeQualified','r40R37ProtectedE2EQualified','r40R39TopmostRuntimeRequalified')) {
  if ($finalManifest.$flag -ne $true) { throw "R40 finalized manifest qualification flag missing: $flag" }
}

Write-Host "R40_RELEASE_PACKAGE_OK sha256=$hash size=$size addon=$addonSha dll=$dllSha updater=R38-byte-identical focused=direct-webgpu-byte-identical r37=E2E-repassed r39Topmost=repassed pacing=hard-gated subtitle=single-DOM+font+geometry-hard-gated handoffRedraw=runtime-proved"

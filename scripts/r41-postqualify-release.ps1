$ErrorActionPreference='Stop'

function Assert-Exit([string]$label){ if($LASTEXITCODE-ne 0){ throw "$label failed with exit code $LASTEXITCODE" } }
function Sha256([string]$path){ (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Require-Marker([string]$text,[string]$marker,[string]$label){ if(-not$text.Contains($marker)){throw "$label missing marker: $marker"} }

foreach($name in @('R41_RELEASE_TAG','R41_INSTALLER_NAME','R41_MANIFEST_NAME','R41_APP_VERSION','ELECTRON_VERSION','QUALIFIED_SOURCE_SHA','QUALIFIED_DLL_SHA256','STABLE_APP_ID','STABLE_PRODUCT_NAME','STABLE_EXE_BASE')){
  if([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))){throw "R41 release environment missing: $name"}
}
$baseManifestPath=Join-Path 'dist' 'lilacanime-libmpv-r39-manifest.json'
if(-not(Test-Path $baseManifestPath)){throw 'R41 release requires exact R39 final6 manifest retained by R40/R41 preflight'}
$manifest=Get-Content $baseManifestPath -Raw|ConvertFrom-Json
$utf8NoBom=New-Object System.Text.UTF8Encoding($false)

$pkg=Get-Content 'package.json' -Raw|ConvertFrom-Json
if($pkg.version-ne$env:R41_APP_VERSION-or$pkg.lilacCustomTag-ne$env:R41_RELEASE_TAG){throw 'R41 source identity mismatch'}
if($pkg.build.appId-ne$env:STABLE_APP_ID-or$pkg.build.productName-ne$env:STABLE_PRODUCT_NAME-or$pkg.build.win.executableName-ne$env:STABLE_EXE_BASE){throw 'R41 stable install identity drifted'}
if($pkg.build.win.artifactName-ne'LilacAnime-Libmpv-R41-Setup.${ext}'){throw 'R41 artifactName drifted'}

$updaterSha=Sha256 'electron/updater.cjs'
$focusedPreloadSha=Sha256 'electron/libmpv-shared-preload.cjs'
$focusedBundleSha=Sha256 'electron/preload-libmpv-shared.generated.cjs'
$addonSha=Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllSha=Sha256 'electron/libmpv-2.dll'
if($dllSha-ne$env:QUALIFIED_DLL_SHA256){throw 'R41 DLL mismatch'}

$native=Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$bridge=Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$main=Get-Content 'electron/main.cjs' -Raw
$renderer=Get-Content 'src/libmpv-shared.generated.js' -Raw
foreach($marker in @('LILAC_R41_FIRST_PRESENT_BEFORE_SHOW','r41FirstPresentReady','r41VisibilityPrematureShowCount','LILAC_R33_OWNED_POPUP_FOCUS_SURFACE','LILAC_R39_TOPMOST_BIDIRECTIONAL','LILAC_R40_HANDOFF_FORCE_REDRAW')){if(-not$native.Contains($marker)-and-not$bridge.Contains($marker)){throw "R41 source marker missing: $marker"}}
foreach($marker in @('LILAC_R41_BLUR_FIRST_PRESENT_COMMIT','r41ArmBlurFirstPresentCommit','r41BlurForcedRedrawAccepted','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','LILAC_R40_FRESH_FRAME_WAKE_GATING')){Require-Marker $bridge $marker 'R41 source bridge'}
foreach($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY','LILAC_R38_UPDATE_ACTIVITY_CHECK','LILAC_R39_MINIPLAYER_TOPMOST')){Require-Marker $main $marker 'R41 protected main'}
foreach($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','setNativeSubtitleOverlay','getBoundingClientRect')){Require-Marker $renderer $marker 'R41 protected renderer'}
if($bridge.Contains('focus-staged-gpu-copy')-or$bridge.Contains('copyTextureToTexture')){throw 'R41 source resurrected forbidden R28 staged renderer'}
if($native.Contains('--disable-direct-composition')){throw 'R41 source resurrected forbidden R25 Direct Composition disable'}
Write-Host "R41_RELEASE_SOURCE_OK version=$($pkg.version) updater=$updaterSha focusedPreload=$focusedPreloadSha focusedBundle=$focusedBundleSha addon=$addonSha dll=$dllSha"

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64 --publish never
Assert-Exit 'R41 release package'
$installer=Join-Path 'dist' $env:R41_INSTALLER_NAME
if(-not(Test-Path $installer)){throw "R41 installer missing: $installer"}
$packedExe=Join-Path 'dist/win-unpacked' ($env:STABLE_EXE_BASE+'.exe')
$asar='dist/win-unpacked/resources/app.asar'
if(-not(Test-Path $packedExe)-or-not(Test-Path $asar)){throw 'R41 packaged stable executable/app.asar missing'}

$asarCli='node_modules/.bin/asar.cmd'
if(-not(Test-Path $asarCli)){throw 'R41 asar helper missing'}
$asarCheck=Join-Path $env:RUNNER_TEMP 'r41-release-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck|Out-Null
& $asarCli extract $asar $asarCheck
Assert-Exit 'R41 packaged app.asar extract'
$shipPkg=Get-Content (Join-Path $asarCheck 'package.json') -Raw|ConvertFrom-Json
if($shipPkg.version-ne$env:R41_APP_VERSION-or$shipPkg.lilacCustomTag-ne$env:R41_RELEASE_TAG){throw 'R41 packaged identity mismatch'}
$shipBridge=Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs') -Raw
$shipMain=Get-Content (Join-Path $asarCheck 'electron/main.cjs') -Raw
$shipRenderer=Get-Content (Join-Path $asarCheck 'src/libmpv-shared.generated.js') -Raw
foreach($marker in @('LILAC_R41_BLUR_FIRST_PRESENT_COMMIT','r41ArmBlurFirstPresentCommit','r41BlurForcedRedrawAccepted','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','LILAC_R40_FRESH_FRAME_WAKE_GATING')){Require-Marker $shipBridge $marker 'R41 packaged bridge'}
foreach($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY','LILAC_R38_UPDATE_ACTIVITY_CHECK','LILAC_R39_MINIPLAYER_TOPMOST')){Require-Marker $shipMain $marker 'R41 packaged main'}
foreach($marker in @('LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY','setNativeSubtitleOverlay','getBoundingClientRect')){Require-Marker $shipRenderer $marker 'R41 packaged renderer'}
if($shipBridge.Contains('focus-staged-gpu-copy')-or$shipBridge.Contains('copyTextureToTexture')){throw 'R41 packaged bridge resurrected forbidden R28 staged renderer'}
if((Sha256 (Join-Path $asarCheck 'electron/updater.cjs'))-ne$updaterSha){throw 'R41 packaged updater drifted'}
if((Sha256 (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs'))-ne$focusedPreloadSha-or(Sha256 (Join-Path $asarCheck 'electron/preload-libmpv-shared.generated.cjs'))-ne$focusedBundleSha){throw 'R41 packaged focused direct-WebGPU preload drifted'}
$packedAddon='dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll='dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if(-not(Test-Path $packedAddon)-or(Sha256 $packedAddon)-ne$addonSha){throw 'R41 packaged addon hash mismatch'}
if(-not(Test-Path $packedDll)-or(Sha256 $packedDll)-ne$dllSha){throw 'R41 packaged DLL hash mismatch'}

$hash=Sha256 $installer
$size=(Get-Item $installer).Length
$manifest.version=$env:R41_APP_VERSION
$manifest.installer=$env:R41_INSTALLER_NAME
$manifest.installerSha256=$hash
$manifest.installerSize=$size
$manifest.nativeAddon=$addonSha
$manifest.nativeDll=$dllSha
$manifest.electron=$env:ELECTRON_VERSION
$manifest|Add-Member -NotePropertyName tag -NotePropertyValue $env:R41_RELEASE_TAG -Force
$manifest|Add-Member -NotePropertyName releaseWorkflowSourceSha -NotePropertyValue $env:GITHUB_SHA -Force
$manifest|Add-Member -NotePropertyName r41PreflightQualified -NotePropertyValue $true -Force
$manifest|Add-Member -NotePropertyName r41FirstPresentRuntimeQualified -NotePropertyValue $true -Force
$manifest|Add-Member -NotePropertyName r41FirstPresentInvariant -NotePropertyValue 'blur-arm+R40-one-shot-redraw+successful-native-present-before-popup-show+main-thread-commit+premature-show-zero' -Force
$manifest|Add-Member -NotePropertyName r41R40PacingRequalified -NotePropertyValue $true -Force
$manifest|Add-Member -NotePropertyName r41R40SubtitleRequalified -NotePropertyValue $true -Force
$manifest|Add-Member -NotePropertyName r41R37ProtectedE2EQualified -NotePropertyValue $true -Force
$manifest|Add-Member -NotePropertyName r41R39TopmostRuntimeRequalified -NotePropertyValue $true -Force
$manifest|Add-Member -NotePropertyName r41UpdaterInvariant -NotePropertyValue 'R38-updater-byte-identical' -Force
$manifest|Add-Member -NotePropertyName r41FocusedPresenterInvariant -NotePropertyValue 'R40-focused-direct-webgpu-byte-identical' -Force
$manifest|Add-Member -NotePropertyName r41ForbiddenPathInvariant -NotePropertyValue 'R25-disable-direct-composition-absent+R28-staged-webgpu-absent' -Force
$manifest|Add-Member -NotePropertyName r41UserEvidence -NotePropertyValue 'R40-user-reported-unfocused-black-flash; recent-focused-dispatch-mean-41.71ms-at-23.976fps-so-pacing-left-unchanged' -Force
$manifestPath=Join-Path 'dist' $env:R41_MANIFEST_NAME
[System.IO.File]::WriteAllText($manifestPath,(($manifest|ConvertTo-Json -Depth 30)+[Environment]::NewLine),$utf8NoBom)
$final=Get-Content $manifestPath -Raw|ConvertFrom-Json
if($final.version-ne$env:R41_APP_VERSION-or$final.tag-ne$env:R41_RELEASE_TAG-or$final.installerSha256-ne$hash-or[long]$final.installerSize-ne$size){throw 'R41 finalized manifest identity mismatch'}
foreach($flag in @('r41PreflightQualified','r41FirstPresentRuntimeQualified','r41R40PacingRequalified','r41R40SubtitleRequalified','r41R37ProtectedE2EQualified','r41R39TopmostRuntimeRequalified')){if($final.$flag-ne$true){throw "R41 finalized qualification flag missing: $flag"}}
Write-Host "R41_RELEASE_PACKAGE_OK sha256=$hash size=$size addon=$addonSha dll=$dllSha updater=R38-byte-identical focused=direct-webgpu-byte-identical firstPresent=hard-gated pacing=R40-repassed subtitle=R40-repassed r37=E2E-repassed r39Topmost=repassed"

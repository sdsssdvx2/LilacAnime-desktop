$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# R35's qualified builder already reconstructs the exact pinned R33 baseline,
# reapplies R34/R35, rebuilds Electron 44.9.3 native code and runs all inherited
# runtime smokes. Keep R36 sources outside that reconstruction, restore them, then
# apply and qualify R36 explicitly. This avoids another layer of generated
# PowerShell/quoting and makes every R36 gate visible in this file.
$r36Stash = Join-Path $env:RUNNER_TEMP 'lilac-r36-support'
Remove-Item $r36Stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $r36Stash | Out-Null
$r36Support = @(
  'r36-handoff-ack-subtitle-stability.cjs',
  'r36-handoff-ack-order-smoke.cjs',
  'r36-subtitle-determinism-smoke.cjs',
  'r36-native-ui-hole-smoke.cjs'
)
foreach ($name in $r36Support) {
  $src = Join-Path 'scripts' $name
  if (-not (Test-Path $src)) { throw "R36 support missing before R35 reconstruction: $name" }
  Copy-Item $src (Join-Path $r36Stash $name) -Force
}

Write-Host 'R36_BASELINE_BEGIN source=exact-R33->R34->R35 qualified-builder'
& ./scripts/r35-qualified-build.ps1
Assert-Exit 'R35 qualified baseline for R36'
Write-Host 'R36_BASELINE_OK inherited=R33-visible+900ms-autonomy+R34-active-handoff+R35-paused-subtitle+R35-paused-no-subtitle+cache-heartbeat'

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $r36Support) {
  Copy-Item (Join-Path $r36Stash $name) (Join-Path 'scripts' $name) -Force
}

# Apply R36 only after the fully qualified R35 working tree exists.
node --check scripts/r36-handoff-ack-subtitle-stability.cjs
Assert-Exit 'R36 transform syntax'
node scripts/r36-handoff-ack-subtitle-stability.cjs
Assert-Exit 'R36 product transform'
node --check scripts/r36-handoff-ack-order-smoke.cjs
Assert-Exit 'R36 ack-order smoke syntax'
node --check scripts/r36-subtitle-determinism-smoke.cjs
Assert-Exit 'R36 subtitle smoke syntax'
node --check scripts/r36-native-ui-hole-smoke.cjs
Assert-Exit 'R36 UI-hole smoke syntax'

# Static product invariants before native compilation.
$nativeSource = Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$bridge = Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$entry = Get-Content 'src/libmpv-shared-entry.js' -Raw
$appSource = Get-Content 'src/app.js' -Raw
$preload = Get-Content 'electron/libmpv-shared-preload.cjs' -Raw
$pkg = Get-Content package.json -Raw | ConvertFrom-Json

if (-not $nativeSource.Contains('LILAC_R36_UNFOCUSED_HTML_UI_HOLES') -or
    -not $nativeSource.Contains('SetNativePresenterUiHoles') -or
    -not $nativeSource.Contains('R36ApplyPresenterRegionLocked') -or
    -not $nativeSource.Contains('r36FirstHoleExcluded')) {
  throw 'R36 native UI-hole source gate failed'
}
if (-not $bridge.Contains('LILAC_R36_HANDOFF_ACK_ORDER') -or
    -not $bridge.Contains('r36FocusHandoffReleasedFrames') -or
    -not $bridge.Contains('R36_HANDOFF_FAIL_OPEN_MS = 1500') -or
    -not $bridge.Contains('r36TargetUiHoles') -or
    -not $bridge.Contains('r36SupplyGaps')) {
  throw 'R36 bridge handoff/UI-hole/diagnostic gate failed'
}
if (-not $entry.Contains('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC') -or
    -not $entry.Contains("'sub-ass-override', 'strip'") -or
    $entry.Contains("'sub-ass-override', 'force'") -or
    $entry.Contains("'sub-ass-override', 'scale'")) {
  throw 'R36 deterministic native subtitle gate failed'
}
if (-not $appSource.Contains('LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE') -or
    -not $appSource.Contains('LILAC_R36_UNFOCUSED_HTML_UI_HOLES') -or
    -not $appSource.Contains('R36_NATIVE_UI_HOLE_SELECTORS') -or
    -not $appSource.Contains('libmpvSharedResize(payload)')) {
  throw 'R36 renderer UI/subtitle gate failed'
}
if (-not $preload.Contains("presentationMode = 'direct-receive-webgpu-copy'") -or
    -not $preload.Contains('copyExternalImageToTexture')) {
  throw 'R36 focused direct WebGPU path drifted'
}
if ($preload.Contains('LILAC_R28_FOCUS_SAFE_PLAYBACK') -or $preload.Contains('focus-staged-gpu-copy')) {
  throw 'R36 resurrected failed R28 renderer path'
}
if ($pkg.version -ne $env:APP_VERSION -or $pkg.build.appId -ne $env:STABLE_APP_ID -or
    $pkg.build.productName -ne $env:STABLE_PRODUCT_NAME -or
    $pkg.build.win.executableName -ne $env:STABLE_EXE_BASE -or
    $pkg.build.win.artifactName -ne $env:INSTALLER_NAME) {
  throw 'R36 stable package identity/version gate failed'
}

$presentStart = $nativeSource.IndexOf('bool R32PresentNativeFrame(')
$presentEnd = $nativeSource.IndexOf('bool SetOption(', $presentStart)
if ($presentStart -lt 0 -or $presentEnd -le $presentStart) { throw 'R36 native Present source boundary missing' }
$presentBody = $nativeSource.Substring($presentStart, $presentEnd - $presentStart)
foreach ($forbidden in @('SetWindowRgn(', 'CreateRectRgn(', 'CombineRgn(', 'SetWindowPos(', 'ShowWindow(')) {
  if ($presentBody.Contains($forbidden)) { throw "R36 producer hot path contains UI operation: $forbidden" }
}
Write-Host 'R36_SOURCE_GATES_OK r33NativeOnly=preserved focused=direct-webgpu ack=bidirectional+1500ms-fail-open ui=owned-popup-region-holes-main-only subtitle=plain-first+ass-strip supplyGap=cached-state-no-extra-poll'

# R36 adds a new native N-API and Win32 region handling, so rebuild the addon
# against the same Electron/libmpv headers already pinned by the R35 baseline.
if (-not (Test-Path 'native/libmpv-d3d11-bridge/vendor/include/mpv/client.h')) { throw 'R36 inherited pinned libmpv headers missing' }
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R36 native addon rebuild'
$rebuilt = 'native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if (-not (Test-Path $rebuilt)) { throw 'R36 rebuilt addon missing' }
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
$r36AddonSha = Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllSha = Sha256 'electron/libmpv-2.dll'
if ($dllSha -ne $env:QUALIFIED_DLL_SHA256) { throw "R36 libmpv DLL drifted: $dllSha" }

# Source/model smokes catch state-machine and style regressions independently of
# Electron graphics availability.
node scripts/r36-handoff-ack-order-smoke.cjs
Assert-Exit 'R36 bidirectional handoff ack-order smoke'
node scripts/r36-subtitle-determinism-smoke.cjs
Assert-Exit 'R36 subtitle determinism smoke'

# Hardware/native qualification. All child trees are supervised externally so a
# synchronous driver/Win32 hang becomes a CI failure instead of hanging forever.
$env:LILAC_LIBMPV_PLAYER_ADDON = (Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL = (Resolve-Path 'electron/libmpv-2.dll').Path

node scripts/r34-run-smoke-with-timeout.cjs scripts/r32-native-producer-watchdog-smoke.cjs r36-r32-producer-watchdog 120000
Assert-Exit 'R36 inherited native producer watchdog'
node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r36-r33-visible-autonomy 120000
Assert-Exit 'R36 inherited R33 owned-popup visible/autonomy smoke'
node scripts/r35-run-smoke-with-timeout.cjs scripts/r36-native-ui-hole-smoke.cjs r36-native-ui-hole 120000
Assert-Exit 'R36 unfocused HTML UI-hole native smoke'
node scripts/r34-run-smoke-with-timeout.cjs scripts/r34-focus-handoff-native-smoke.cjs r36-r34-active-handoff 120000
Assert-Exit 'R36 inherited active focus handoff smoke'
node scripts/r35-run-smoke-with-timeout.cjs scripts/r35-paused-handoff-redraw-smoke.cjs r36-r35-paused-subtitle 120000
Assert-Exit 'R36 inherited paused subtitle handoff smoke'
node scripts/r35-run-smoke-with-timeout.cjs scripts/r35-paused-no-subtitle-handoff-smoke.cjs r36-r35-paused-no-subtitle 120000
Assert-Exit 'R36 inherited paused no-subtitle handoff smoke'
for ($cycle = 1; $cycle -le 3; $cycle++) {
  node scripts/r34-run-smoke-with-timeout.cjs scripts/r34-focus-handoff-native-smoke.cjs "r36-repeat-active-handoff-$cycle" 120000
  Assert-Exit "R36 repeated active handoff $cycle"
}

Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
Write-Host 'R36_RUNTIME_SMOKES_OK producerWatchdog=1 r33VisibleAutonomy=1 unfocusedHtmlUiHole=1 activeHandoff=1 pausedSubtitle=1 pausedNoSubtitle=1 activeHandoffRepeat=3 ackOrderCycles=200 subtitleDeterminism=1'

# Final packaging happens only after every post-R36 runtime gate has passed.
# R35 already applied the requested stable identity and APP_VERSION to package.json.
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64
Assert-Exit 'R36 final package'
$installer = Join-Path 'dist' $env:INSTALLER_NAME
if (-not (Test-Path $installer)) { throw "R36 installer missing: $installer" }

# Inspect the actual packaged app, not only the working tree.
$asarCli = 'node_modules/.bin/asar.cmd'
if (-not (Test-Path $asarCli)) { throw 'R36 asar helper missing' }
$asarCheck = Join-Path $env:RUNNER_TEMP 'r36-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R36 packaged asar extract'
$shipBridge = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs') -Raw
$shipEntry = Get-Content (Join-Path $asarCheck 'src/libmpv-shared-entry.js') -Raw
$shipApp = Get-Content (Join-Path $asarCheck 'src/app.js') -Raw
$shipPreload = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs') -Raw

if ($shipBridge -notmatch 'LILAC_R36_HANDOFF_ACK_ORDER' -or
    $shipBridge -notmatch 'r36FocusHandoffReleasedFrames' -or
    $shipBridge -notmatch 'R36_HANDOFF_FAIL_OPEN_MS = 1500' -or
    $shipBridge -notmatch 'r36TargetUiHoles') { throw 'packaged R36 bridge hardening missing' }
if ($shipEntry -notmatch 'LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC' -or
    $shipEntry -notmatch "'sub-ass-override', 'strip'") { throw 'packaged R36 subtitle determinism missing' }
if ($shipApp -notmatch 'LILAC_R36_UNFOCUSED_HTML_UI_HOLES' -or
    $shipApp -notmatch 'R36_NATIVE_UI_HOLE_SELECTORS' -or
    $shipApp -notmatch 'LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE') { throw 'packaged R36 renderer UI/subtitle hardening missing' }
if ($shipPreload -notmatch "presentationMode = 'direct-receive-webgpu-copy'" -or
    $shipPreload -notmatch 'copyExternalImageToTexture') { throw 'packaged R36 direct WebGPU focused path missing' }

$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
$worker = 'dist/win-unpacked/resources/app.asar.unpacked/electron/cache-write-worker.cjs'
if (-not (Test-Path $packedAddon) -or (Sha256 $packedAddon) -ne $r36AddonSha) { throw 'packaged R36 addon hash mismatch' }
if (-not (Test-Path $packedDll) -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'packaged R36 DLL hash mismatch' }
if (-not (Test-Path $worker)) { throw 'packaged R34/R35 cache worker missing in R36' }
Write-Host "R36_PACKAGED_SOURCE_OK addon=$r36AddonSha dll=$dllSha bridge=ack+ui-holes entry=ass-strip app=html-ui-holes focused=direct-webgpu"

# Final self-contained manifest. Keep inherited proof fields because the public
# verification step checks that R36 did not silently drop a qualified layer.
$hash = Sha256 $installer
$size = (Get-Item $installer).Length
$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
$manifest = [ordered]@{
  version = $env:APP_VERSION
  qualifiedSourceSha = $env:QUALIFIED_SOURCE_SHA
  electron = $env:ELECTRON_VERSION
  installer = $env:INSTALLER_NAME
  installerSha256 = $hash
  installerSize = $size
  nativeAddon = $r36AddonSha
  nativeDll = $env:QUALIFIED_DLL_SHA256
  r32NativeProducerWatchdog = 'callback-authoritative+250ms-native-watchdog'
  r32FlixIsolation = 'worker-thread-loopback-server+no-segment-main-ipc'
  r33FocusPresenter = 'same-libmpv-d3d11-texture+owned-ws-popup-unfocused'
  r33NativeOnlyUnfocused = 'producer-copyresource-present-S_OK+slot-release+no-tsfn-no-import-no-send-no-webgpu'
  r33PresentQualification = 'S_OK-only-native-ownership+DXGI_STATUS_OCCLUDED-fail-open+show-before-arm'
  r33OwnedPopupBlackErase = $false
  r33ChromiumDuplicateDelivery = $false
  r33StallAttribution = 'main-heartbeat50ms-threshold80+native-render-threshold60'
  r34FocusHandoff = 'native-present+chromium-mirror-until-successful-send+allReferencesReleased-then-hide'
  r34HandoffAck = 'successful-send+allReferencesReleased-only'
  r34NativePresent = 'DXGI_PRESENT_DO_NOT_WAIT+busy-keep-last-native-frame'
  r34SubtitleOwnership = 'main-only-focus-authority+html-focused+libmpv-unfocused+ass-override-strip'
  r34CacheWrites = 'catalog+display-title+tmdb-overview+artwork+anissia+korean-title+community-post+oped-worker-coalesced'
  r34MainStallIo = 'korean-title+community-post+tmdb-overview+artwork+anissia+oped-off-main+tmdb-key-memoized'
  r34R27GapReset = $true
  r35PausedHandoff = 'mirror-first+sub-visibility-redraw+successful-send+allReferencesReleased-then-hide'
  r35SubtitleOwnership = 'main-only+focus-native-off+unfocused-native-on+post-r36-ass-override-strip'
  r35RuntimeSmokes = 'r33-hosted-visual+r34-active-handoff+r35-paused-redraw+r35-paused-no-subtitle+r35-cache-heartbeat'
  r36HandoffAck = 'bidirectional-send-release-order+1500ms-focused-fail-open'
  r36UnfocusedUi = 'owned-popup-window-region-holes+html-controls-visible+native-video-autonomous'
  r36SubtitleFallback = 'plain-dialogue-source-first+ass-strip+r32-style-map'
  r36SupplyGapDiagnostics = 'cached-playback-state+focus-handoff-context+no-extra-native-poll'
  r36RuntimeSmokes = 'ack-order-200-cycles+subtitle-determinism+native-ui-hole+active-handoff-repeat3+inherited-r33-r35'
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 12) + [Environment]::NewLine), $utf8NoBom)

# The public-release workflow historically consumes these names. Overwrite them
# with the FINAL R36 package bytes, not the discarded intermediate R35 package.
"R34_ADDON_SHA256=$r36AddonSha" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"R34_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"R34_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "R36_BUILD_OK sha256=$hash size=$size addon=$r36AddonSha dll=$dllSha ui=html-holes+native-autonomy handoff=bidirectional-ack+fail-open subtitle=plain+strip repeatHandoff=3"

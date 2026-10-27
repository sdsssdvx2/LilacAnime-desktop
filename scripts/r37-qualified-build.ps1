$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$r37Stash = Join-Path $env:RUNNER_TEMP 'lilac-r37-support'
Remove-Item $r37Stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $r37Stash | Out-Null
$r37Support = @(
  'r37-transform-anchor-compat.cjs',
  'r37-explicit-handoff-clean-focus.cjs',
  'r37-native-handoff-freeze-smoke.cjs',
  'r37-explicit-handoff-e2e-smoke.cjs',
  'r37-run-e2e-with-timeout.cjs'
)
foreach ($name in $r37Support) {
  $src = Join-Path 'scripts' $name
  if (-not (Test-Path $src)) { throw "R37 support missing before R36 reconstruction: $name" }
  Copy-Item $src (Join-Path $r37Stash $name) -Force
}

$r37AppVersion = $env:APP_VERSION
$r37InstallerName = $env:INSTALLER_NAME
$r37ManifestName = $env:MANIFEST_NAME
$r37ReleaseTag = $env:RELEASE_TAG

try {
  $env:APP_VERSION = '0.5.54-libmpv-r3f.rc16'
  $env:INSTALLER_NAME = 'LilacAnime-Libmpv-R36-Setup.exe'
  $env:MANIFEST_NAME = 'lilacanime-libmpv-r36-manifest.json'
  $env:RELEASE_TAG = 'libmpv-r2k-v0.5.54-r36'

  Write-Host 'R37_BASELINE_BEGIN source=exact-qualified-R36'
  & ./scripts/r36-qualified-build.ps1
  Assert-Exit 'R36 qualified baseline for R37'
  Write-Host 'R37_BASELINE_OK inherited=R33-native-only+R36-direct-webgpu+R36-supply-gap-diagnostics'
}
finally {
  $env:APP_VERSION = $r37AppVersion
  $env:INSTALLER_NAME = $r37InstallerName
  $env:MANIFEST_NAME = $r37ManifestName
  $env:RELEASE_TAG = $r37ReleaseTag
}

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $r37Support) {
  Copy-Item (Join-Path $r37Stash $name) (Join-Path 'scripts' $name) -Force
}

node --check scripts/r37-transform-anchor-compat.cjs
Assert-Exit 'R37 transform-anchor compatibility syntax'
node scripts/r37-transform-anchor-compat.cjs
Assert-Exit 'R37 transform-anchor compatibility'
node --check scripts/r37-explicit-handoff-clean-focus.cjs
Assert-Exit 'R37 transform syntax'
node scripts/r37-explicit-handoff-clean-focus.cjs
Assert-Exit 'R37 product transform'
node --check scripts/r37-native-handoff-freeze-smoke.cjs
Assert-Exit 'R37 native freeze smoke syntax'
node --check scripts/r37-explicit-handoff-e2e-smoke.cjs
Assert-Exit 'R37 e2e smoke syntax'
node --check scripts/r37-run-e2e-with-timeout.cjs
Assert-Exit 'R37 bounded e2e launcher syntax'

$nativeSource = Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$bridge = Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$preload = Get-Content 'electron/libmpv-shared-preload.cjs' -Raw
$preloadBundle = Get-Content 'electron/preload-libmpv-shared.generated.cjs' -Raw
$entry = Get-Content 'src/libmpv-shared-entry.js' -Raw
$pkg = Get-Content package.json -Raw | ConvertFrom-Json

foreach ($marker in @(
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'r37CompleteFocusHandoffFromRendererAck',
  'libmpv-shared:r37-handoff-presented',
  'LILAC_R37_NO_STALE_UI_HOLES'
)) {
  if (-not $bridge.Contains($marker)) { throw "R37 bridge source marker missing: $marker" }
}
if (-not $nativeSource.Contains('LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF') -or
    -not $nativeSource.Contains('!player->r34MirrorChromiumDuringHandoff.load(std::memory_order_acquire)')) {
  throw 'R37 native handoff freeze source gate failed'
}
foreach ($marker in @(
  'LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK',
  'libmpv-shared:r37-handoff-presented',
  'r37HandoffCopied = true',
  "presentationMode = 'direct-receive-webgpu-copy'",
  'copyExternalImageToTexture'
)) {
  if (-not $preload.Contains($marker)) { throw "R37 preload source marker missing: $marker" }
}
if (-not $preloadBundle.Contains('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK') -or
    -not $preloadBundle.Contains('libmpv-shared:r37-handoff-presented') -or
    -not $preloadBundle.Contains("direct-receive-webgpu-copy")) {
  throw 'R37 generated preload bundle gate failed'
}
if ($bridge.Contains('setNativePresenterUiHoles(playerId, r36TargetUiHoles)') -or
    -not $bridge.Contains('setNativePresenterUiHoles(playerId, [])')) {
  throw 'R37 stale Chromium UI-hole path survived'
}
if (-not $entry.Contains('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC') -or
    -not $entry.Contains("'sub-ass-override', 'strip'")) {
  throw 'R37 lost qualified R36 subtitle fallback source'
}
if ($preload.Contains('focus-staged-gpu-copy') -or $preload.Contains('LILAC_R28_FOCUS_SAFE_PLAYBACK')) {
  throw 'R37 resurrected failed R28 renderer path'
}
if ($pkg.version -ne $env:APP_VERSION -or $pkg.build.appId -ne $env:STABLE_APP_ID -or
    $pkg.build.productName -ne $env:STABLE_PRODUCT_NAME -or
    $pkg.build.win.executableName -ne $env:STABLE_EXE_BASE -or
    $pkg.build.win.artifactName -ne $env:INSTALLER_NAME) {
  throw 'R37 stable package identity/version gate failed'
}
Write-Host 'R37_SOURCE_GATES_OK handoff=explicit-renderer-epoch-ack ui=full-native-popup-no-holes subtitle=freeze-native-pixels-until-ack focused=direct-webgpu r33NativeOnly=preserved'

if (-not (Test-Path 'native/libmpv-d3d11-bridge/vendor/include/mpv/client.h')) { throw 'R37 inherited pinned libmpv headers missing' }
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R37 native addon rebuild'
$rebuilt = 'native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if (-not (Test-Path $rebuilt)) { throw 'R37 rebuilt addon missing' }
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
$r37AddonSha = Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllSha = Sha256 'electron/libmpv-2.dll'
if ($dllSha -ne $env:QUALIFIED_DLL_SHA256) { throw "R37 libmpv DLL drifted: $dllSha" }

$env:LILAC_LIBMPV_PLAYER_ADDON = (Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL = (Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r37-r33-visible-autonomy 120000
  Assert-Exit 'R37 inherited R33 owned-popup autonomy smoke'

  & node_modules/.bin/electron.cmd scripts/r37-native-handoff-freeze-smoke.cjs
  Assert-Exit 'R37 native handoff freeze smoke'

  # Diagnostic-only policy: DEP0168 means a real exception escaped a Node-API
  # asynchronous callback but Node's compatibility policy suppressed it. Force
  # the correct uncaughtException behavior only for this R37 E2E child so CI
  # prints the original JS exception/stack instead of hiding it behind DEP0168.
  # The parent launcher owns a hard timeout and kills the full Electron process
  # tree, so a startup/policy regression cannot strand the qualification job.
  $r37PreviousNodeOptions = $env:NODE_OPTIONS
  $r37NodeApiPolicy = '--force-node-api-uncaught-exceptions-policy'
  try {
    if ([string]::IsNullOrWhiteSpace($r37PreviousNodeOptions)) {
      $env:NODE_OPTIONS = $r37NodeApiPolicy
    } elseif ($r37PreviousNodeOptions -notlike "*$r37NodeApiPolicy*") {
      $env:NODE_OPTIONS = "$r37PreviousNodeOptions $r37NodeApiPolicy"
    }
    Write-Host "R37_NODE_API_EXCEPTION_DIAGNOSTIC policy=forced nodeOptions=$env:NODE_OPTIONS parentTimeoutMs=180000"
    node scripts/r37-run-e2e-with-timeout.cjs scripts/r37-explicit-handoff-e2e-smoke.cjs 180000
    Assert-Exit 'R37 explicit handoff end-to-end smoke'
  }
  finally {
    if ($null -eq $r37PreviousNodeOptions) {
      Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    } else {
      $env:NODE_OPTIONS = $r37PreviousNodeOptions
    }
  }
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}
Write-Host 'R37_RUNTIME_SMOKES_OK r33VisibleAutonomy=1 nativeFreeze=1 realSharedTextureE2E=3cycles failOpenExpected=0 uiHolesExpected=0'

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64
Assert-Exit 'R37 final package'
$installer = Join-Path 'dist' $env:INSTALLER_NAME
if (-not (Test-Path $installer)) { throw "R37 installer missing: $installer" }

$asarCli = 'node_modules/.bin/asar.cmd'
if (-not (Test-Path $asarCli)) { throw 'R37 asar helper missing' }
$asarCheck = Join-Path $env:RUNNER_TEMP 'r37-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R37 packaged asar extract'

$shipBridge = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs') -Raw
$shipPreload = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs') -Raw
$shipPreloadBundle = Get-Content (Join-Path $asarCheck 'electron/preload-libmpv-shared.generated.cjs') -Raw
$shipEntry = Get-Content (Join-Path $asarCheck 'src/libmpv-shared-entry.js') -Raw
foreach ($marker in @('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','libmpv-shared:r37-handoff-presented','LILAC_R37_NO_STALE_UI_HOLES')) {
  if (-not $shipBridge.Contains($marker)) { throw "packaged R37 bridge missing: $marker" }
}
if (-not $shipPreload.Contains('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK') -or
    -not $shipPreload.Contains("presentationMode = 'direct-receive-webgpu-copy'")) {
  throw 'packaged R37 preload/direct WebGPU source missing'
}
if (-not $shipPreloadBundle.Contains('libmpv-shared:r37-handoff-presented')) { throw 'packaged R37 generated preload ACK missing' }
if (-not $shipEntry.Contains('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC')) { throw 'packaged R37 subtitle fallback missing' }

$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if (-not (Test-Path $packedAddon) -or (Sha256 $packedAddon) -ne $r37AddonSha) { throw 'packaged R37 addon hash mismatch' }
if (-not (Test-Path $packedDll) -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'packaged R37 DLL hash mismatch' }
Write-Host "R37_PACKAGED_SOURCE_OK addon=$r37AddonSha dll=$dllSha handoff=renderer-epoch-ack ui=no-holes nativeHandoff=frozen-last-frame focused=direct-webgpu"

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
  nativeAddon = $r37AddonSha
  nativeDll = $env:QUALIFIED_DLL_SHA256
  stableAppId = $env:STABLE_APP_ID
  stableProductName = $env:STABLE_PRODUCT_NAME
  stableShortcutName = $env:STABLE_SHORTCUT_NAME
  stableExecutable = $env:STABLE_EXE_BASE
  r33FocusPresenter = 'same-libmpv-d3d11-texture+owned-ws-popup-unfocused'
  r33NativeOnlyUnfocused = 'producer-copyresource-present-S_OK+slot-release+no-tsfn-no-import-no-send-no-webgpu'
  r33OwnedPopupBlackErase = $false
  r33ChromiumDuplicateDelivery = $false
  focusedPresenter = 'direct-receive-webgpu-copy'
  r36SubtitleFallback = 'plain-dialogue-source-first+ass-strip+r32-style-map'
  r36SupplyGapDiagnostics = 'cached-playback-state+focus-handoff-context+no-extra-native-poll'
  r37HandoffAck = 'explicit-renderer-epoch-after-direct-copy+imported-release'
  r37LegacyAllReferencesAck = 'slot-lifetime-only+handoff-diagnostic-not-ui-authority'
  r37NativeHandoff = 'freeze-visible-native-swapchain+mirror-redraw-to-chromium-until-renderer-ack'
  r37UnfocusedUi = 'full-r33-owned-popup+chromium-ui-holes-disabled'
  r37SubtitleHandoff = 'freeze-last-native-subtitle-pixels-until-renderer-ack+html-after-popup-hide'
  r37RuntimeSmokes = 'r33-native-autonomy+native-freeze+real-electron-sharedtexture-active+paused-subtitle+paused-no-subtitle'
  stutterStatus = 'not-claimed-fixed;direct-webgpu-retained;diagnostics-retained-for-display-phase-attribution'
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content $manifestPath -Encoding UTF8

Write-Host "R37_BUILD_OK sha256=$hash size=$size addon=$r37AddonSha dll=$dllSha handoff=explicit-renderer-ack ui=no-holes subtitle=freeze-until-ack stutterClaim=none"

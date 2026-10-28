$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$pkgBefore = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkgBefore.version -ne '0.5.54-libmpv-r3f.rc18' -or $pkgBefore.lilacCustomTag -ne 'libmpv-r2k-v0.5.54-r38') {
  throw "R39 requires exact R38 product baseline, got $($pkgBefore.version) $($pkgBefore.lilacCustomTag)"
}

$protected = [ordered]@{
  sharedPreload = Sha256 'electron/libmpv-shared-preload.cjs'
  sharedPreloadBundle = Sha256 'electron/preload-libmpv-shared.generated.cjs'
  nativeSource = Sha256 'native/libmpv-d3d11-bridge/player_addon.cc'
  addon = Sha256 'electron/lilac-libmpv-player-bridge.node'
  dll = Sha256 'electron/libmpv-2.dll'
  updater = Sha256 'electron/updater.cjs'
  desktopState = Sha256 'electron/desktop-state.cjs'
}
$rendererBefore = Sha256 'src/libmpv-shared.generated.js'

foreach ($script in @('scripts/r39-runtime-recovery-fix.cjs','scripts/r39-rebuild-renderer-bundle.cjs','scripts/r39-runtime-recovery-smoke.cjs','scripts/r39-refocus-phase-e2e-smoke.cjs','scripts/r39-miniplayer-electron-smoke.cjs')) {
  node --check $script
  Assert-Exit "syntax $script"
}
node scripts/r39-runtime-recovery-fix.cjs
Assert-Exit 'R39 runtime recovery transform'
node scripts/r39-rebuild-renderer-bundle.cjs
Assert-Exit 'R39 runtime renderer bundle rebuild'

foreach ($file in @('electron/libmpv-shared-main.cjs','src/libmpv-shared-entry.js','src/player.js','electron/main.cjs','electron/preload.cjs','electron/miniplayer-window.cjs')) {
  node --check $file
  Assert-Exit "post-transform syntax $file"
}
node scripts/r39-runtime-recovery-smoke.cjs
Assert-Exit 'R39 source recovery smoke'
$rendererAfter = Sha256 'src/libmpv-shared.generated.js'
if ($rendererAfter -eq $rendererBefore) { throw 'R39 renderer bundle did not change after entry modifications' }
Write-Host "R39_RENDERER_BUNDLE_HASH_OK before=$rendererBefore after=$rendererAfter"

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkg.version -ne $env:APP_VERSION -or $pkg.lilacCustomTag -ne $env:RELEASE_TAG -or
    $pkg.build.appId -ne $env:STABLE_APP_ID -or $pkg.build.productName -ne $env:STABLE_PRODUCT_NAME -or
    $pkg.build.win.executableName -ne $env:STABLE_EXE_BASE -or $pkg.build.win.artifactName -ne $env:INSTALLER_NAME) {
  throw 'R39 stable package/update identity gate failed'
}

# R39 deliberately changes the main bridge/renderer entry+bundle/player/window controller.
# The native producer, focused WebGPU preload, libmpv DLL, updater implementation,
# and desktop-state persistence implementation must remain byte-identical to R38.
if ((Sha256 'electron/libmpv-shared-preload.cjs') -ne $protected.sharedPreload -or
    (Sha256 'electron/preload-libmpv-shared.generated.cjs') -ne $protected.sharedPreloadBundle -or
    (Sha256 'native/libmpv-d3d11-bridge/player_addon.cc') -ne $protected.nativeSource -or
    (Sha256 'electron/lilac-libmpv-player-bridge.node') -ne $protected.addon -or
    (Sha256 'electron/libmpv-2.dll') -ne $protected.dll -or
    (Sha256 'electron/updater.cjs') -ne $protected.updater -or
    (Sha256 'electron/desktop-state.cjs') -ne $protected.desktopState) {
  throw 'R39 changed a protected R37/R38 playback/updater/persistence byte'
}
Write-Host "R39_PROTECTED_BYTES_OK sharedPreload=$($protected.sharedPreload) addon=$($protected.addon) dll=$($protected.dll) updater=$($protected.updater) native=R37-identical"

node --test tests/player-interactions.test.cjs tests/desktop-state.test.cjs
Assert-Exit 'R39 player/desktop-state unit tests'

node scripts/r38-updater-lifecycle-smoke.cjs
Assert-Exit 'R39 inherited actual custom updater lifecycle smoke'

$electronVersion = (Get-Content 'node_modules/electron/package.json' -Raw | ConvertFrom-Json).version
if ($electronVersion -ne $env:ELECTRON_VERSION) { throw "Electron version drift: $electronVersion expected $env:ELECTRON_VERSION" }

$env:LILAC_LIBMPV_PLAYER_ADDON = (Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL = (Resolve-Path 'electron/libmpv-2.dll').Path
try {
  & node_modules/.bin/electron.cmd scripts/r37-native-handoff-freeze-smoke.cjs
  Assert-Exit 'R39 inherited R37 native handoff freeze smoke'
  node scripts/r37-run-e2e-with-timeout.cjs scripts/r37-explicit-handoff-e2e-smoke.cjs 180000
  Assert-Exit 'R39 inherited R37 explicit handoff raw E2E'
  node scripts/r37-run-e2e-with-timeout.cjs scripts/r39-refocus-phase-e2e-smoke.cjs 180000
  Assert-Exit 'R39 native-only refocus phase E2E'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}

& node_modules/.bin/electron.cmd scripts/r39-miniplayer-electron-smoke.cjs
Assert-Exit 'R39 real Electron mini-player topmost smoke'
Write-Host 'R39_RUNTIME_SMOKES_OK r37BlackFlashRegression=1 r37RawE2E=1 r39RefocusE2E=4cycles miniPlayerRealWindows=2 win32Topmost=1 rendererBundle=rebuilt'

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64 --publish never
Assert-Exit 'R39 final package'
$installer = Join-Path 'dist' $env:INSTALLER_NAME
if (-not (Test-Path $installer)) { throw "R39 installer missing: $installer" }

$asarCli = 'node_modules/.bin/asar.cmd'
if (-not (Test-Path $asarCli)) { throw 'R39 asar helper missing' }
$asarCheck = Join-Path $env:RUNNER_TEMP 'r39-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R39 packaged asar extract'
node scripts/r39-runtime-recovery-smoke.cjs $asarCheck
Assert-Exit 'R39 packaged source recovery smoke'

$shipPkg = Get-Content (Join-Path $asarCheck 'package.json') -Raw | ConvertFrom-Json
if ($shipPkg.version -ne $env:APP_VERSION -or $shipPkg.lilacCustomTag -ne $env:RELEASE_TAG) { throw 'packaged R39 identity mismatch' }
$packedRenderer = Join-Path $asarCheck 'src/libmpv-shared.generated.js'
if (-not (Test-Path $packedRenderer)) { throw 'packaged R39 generated renderer missing' }
$packedRendererHash = Sha256 $packedRenderer
if ($packedRendererHash -ne $rendererAfter) { throw "packaged R39 renderer bundle drifted source=$rendererAfter packed=$packedRendererHash" }
if ((Sha256 (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs')) -ne $protected.sharedPreload -or
    (Sha256 (Join-Path $asarCheck 'electron/preload-libmpv-shared.generated.cjs')) -ne $protected.sharedPreloadBundle -or
    (Sha256 (Join-Path $asarCheck 'electron/updater.cjs')) -ne $protected.updater -or
    (Sha256 (Join-Path $asarCheck 'electron/desktop-state.cjs')) -ne $protected.desktopState) {
  throw 'packaged R39 protected JS bytes drifted'
}
$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if (-not (Test-Path $packedAddon) -or (Sha256 $packedAddon) -ne $protected.addon) { throw 'packaged R39 native addon drifted' }
if (-not (Test-Path $packedDll) -or (Sha256 $packedDll) -ne $protected.dll) { throw 'packaged R39 libmpv DLL drifted' }
Write-Host "R39_PACKAGED_SOURCE_OK customTag=$($shipPkg.lilacCustomTag) rendererBundle=$packedRendererHash sharedPreload=$($protected.sharedPreload) addon=$($protected.addon) dll=$($protected.dll) native=R37-identical updater=R38-identical"

$hash = Sha256 $installer
$size = (Get-Item $installer).Length
$manifest = [ordered]@{
  version = $env:APP_VERSION
  tag = $env:RELEASE_TAG
  qualifiedSourceSha = $env:QUALIFIED_SOURCE_SHA
  electron = $env:ELECTRON_VERSION
  installer = $env:INSTALLER_NAME
  installerSha256 = $hash
  installerSize = $size
  stableAppId = $env:STABLE_APP_ID
  stableProductName = $env:STABLE_PRODUCT_NAME
  stableShortcutName = $env:STABLE_SHORTCUT_NAME
  stableExecutable = $env:STABLE_EXE_BASE
  nativeAddonSha256 = $protected.addon
  nativeDllSha256 = $protected.dll
  sharedWebgpuPreloadSha256 = $protected.sharedPreload
  rendererBundleSha256 = $rendererAfter
  r39BlackFlashInvariant = 'R37-explicit-renderer-ACK+native-freeze-preserved'
  r39FocusedPresenter = 'direct-receive-webgpu-copy-preserved'
  r39RefocusRecovery = 'native-only-to-focused-phase-reanchor+immediate-pump'
  r39GapDiagnostics = 'active-playback-vs-interaction-buffering'
  r39SubtitleParity = 'native-fallback-uses-DOM-size-position-outline-weight-baseline'
  r39MiniPlayer = 'real-BrowserWindow+Win32-topmost-verified+runtime-diagnostics'
  r39Updater = 'R38-activity-aware-lifecycle-preserved'
}
$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine), $utf8NoBom)
Write-Host "R39_BUILD_OK sha256=$hash size=$size electron=$electronVersion rendererBundle=$rendererAfter refocus=4cycles-bounded-first-frame pip=real-win32-topmost subtitle=native-DOM-parity blackFlash=R37-preserved"

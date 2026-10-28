$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
if (-not (Test-Path $manifestPath)) { throw 'R39 pre-correction manifest missing' }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$updaterSha = Sha256 'electron/updater.cjs'
$sharedPreloadSha = Sha256 'electron/libmpv-shared-preload.cjs'
$sharedPreloadBundleSha = Sha256 'electron/preload-libmpv-shared.generated.cjs'
$dllSha = Sha256 'electron/libmpv-2.dll'
if ($dllSha -ne $env:QUALIFIED_DLL_SHA256) { throw 'R39 pre-correction DLL mismatch' }

node --check scripts/r39-topmost-bidirectional-fix.cjs
Assert-Exit 'R39 bidirectional topmost syntax'
node scripts/r39-topmost-bidirectional-fix.cjs
Assert-Exit 'R39 bidirectional topmost transform'

$native = Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
if (-not $native.Contains('LILAC_R39_TOPMOST_BIDIRECTIONAL') -or
    -not $native.Contains('r39OwnerTopmost ? HWND_TOPMOST : HWND_NOTOPMOST')) {
  throw 'R39 bidirectional native topmost gate failed'
}
if ($native.Contains('r39OwnerTopmost ? 0 : SWP_NOZORDER')) { throw 'R39 stale one-way topmost flags survived' }
if (-not $native.Contains('LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF') -or
    -not $native.Contains('LILAC_R33_OWNED_POPUP_FOCUS_SURFACE')) {
  throw 'R39 bidirectional repair disturbed R33/R37 native baseline'
}
if ((Sha256 'electron/updater.cjs') -ne $updaterSha -or
    (Sha256 'electron/libmpv-shared-preload.cjs') -ne $sharedPreloadSha -or
    (Sha256 'electron/preload-libmpv-shared.generated.cjs') -ne $sharedPreloadBundleSha -or
    (Sha256 'electron/libmpv-2.dll') -ne $dllSha) {
  throw 'R39 bidirectional repair touched protected non-native-source bytes'
}

& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R39 bidirectional native addon rebuild'
$rebuilt = 'native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if (-not (Test-Path $rebuilt)) { throw 'R39 bidirectional rebuilt addon missing' }
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
$r39AddonSha = Sha256 'electron/lilac-libmpv-player-bridge.node'

# Repeat native/focus runtime evidence after the final C++ z-order correction.
$env:LILAC_LIBMPV_PLAYER_ADDON = (Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL = (Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r39-final-r33-visible-autonomy 120000
  Assert-Exit 'R39 final R33 visible autonomy smoke'
  & node_modules/.bin/electron.cmd scripts/r37-native-handoff-freeze-smoke.cjs
  Assert-Exit 'R39 final R37 native handoff freeze smoke'
  node scripts/r37-run-e2e-with-timeout.cjs scripts/r37-explicit-handoff-e2e-smoke.cjs 180000
  Assert-Exit 'R39 final R37 raw E2E'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}
Write-Host 'R39_FINAL_RUNTIME_SMOKES_OK topmost=bidirectional r33VisibleAutonomy=1 r37NativeFreeze=1 r37RawE2E=1'

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64 --publish never
Assert-Exit 'R39 final corrected package'
$installer = Join-Path 'dist' $env:INSTALLER_NAME
if (-not (Test-Path $installer)) { throw 'R39 corrected installer missing' }

$asarCli = 'node_modules/.bin/asar.cmd'
$asarCheck = Join-Path $env:RUNNER_TEMP 'r39-final-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R39 corrected asar extract'
node scripts/r39-refocus-pip-subtitle-smoke.cjs $asarCheck
Assert-Exit 'R39 corrected packaged source smoke'

$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if (-not (Test-Path $packedAddon) -or (Sha256 $packedAddon) -ne $r39AddonSha) { throw 'R39 corrected packaged addon mismatch' }
if (-not (Test-Path $packedDll) -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'R39 corrected packaged DLL mismatch' }
if ((Sha256 (Join-Path $asarCheck 'electron/updater.cjs')) -ne $updaterSha) { throw 'R39 corrected package updater drift' }
if ((Sha256 (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs')) -ne $sharedPreloadSha -or
    (Sha256 (Join-Path $asarCheck 'electron/preload-libmpv-shared.generated.cjs')) -ne $sharedPreloadBundleSha) {
  throw 'R39 corrected package focused shared-preload drift'
}

$hash = Sha256 $installer
$size = (Get-Item $installer).Length
$manifest.version = $env:APP_VERSION
$manifest.installer = $env:INSTALLER_NAME
$manifest.installerSha256 = $hash
$manifest.installerSize = $size
$manifest.nativeAddon = $r39AddonSha
$manifest.nativeDll = $env:QUALIFIED_DLL_SHA256
$manifest | Add-Member -NotePropertyName tag -NotePropertyValue $env:RELEASE_TAG -Force
$manifest | Add-Member -NotePropertyName r39TopmostBidirectional -NotePropertyValue 'owner-topmost=>HWND_TOPMOST+owner-normal=>HWND_NOTOPMOST' -Force
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 30) + [Environment]::NewLine), $utf8NoBom)

Write-Host "R39_FINAL_BUILD_OK sha256=$hash size=$size addon=$r39AddonSha topmost=bidirectional refocus=phase-reanchor subtitle=parity updater=R38-preserved focused=direct-webgpu"

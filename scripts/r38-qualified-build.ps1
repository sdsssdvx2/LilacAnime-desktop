$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# R38 is deliberately updater-only. Reconstruct and fully qualify the exact R37
# product first, then change only main-process updater activity wiring + package
# release identity. The libmpv bridge/preload/native bytes must remain unchanged.
$r38Stash = Join-Path $env:RUNNER_TEMP 'lilac-r38-support'
Remove-Item $r38Stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $r38Stash | Out-Null
$r38Support = @('r38-updater-lifecycle-fix.cjs','r38-updater-lifecycle-smoke.cjs')
foreach ($name in $r38Support) {
  $src = Join-Path 'scripts' $name
  if (-not (Test-Path $src)) { throw "R38 support missing before R37 reconstruction: $name" }
  Copy-Item $src (Join-Path $r38Stash $name) -Force
}

$r38AppVersion = $env:APP_VERSION
$r38InstallerName = $env:INSTALLER_NAME
$r38ManifestName = $env:MANIFEST_NAME
$r38ReleaseTag = $env:RELEASE_TAG

try {
  $env:APP_VERSION = '0.5.54-libmpv-r3f.rc17'
  $env:INSTALLER_NAME = 'LilacAnime-Libmpv-R37-Setup.exe'
  $env:MANIFEST_NAME = 'lilacanime-libmpv-r37-manifest.json'
  $env:RELEASE_TAG = 'libmpv-r2k-v0.5.54-r37'
  Write-Host 'R38_BASELINE_BEGIN source=exact-qualified-R37'
  & ./scripts/r37-qualified-build.ps1
  Assert-Exit 'R37 qualified baseline for R38'
  Write-Host 'R38_BASELINE_OK inherited=R37-raw-e2e+R33-native-only+focused-direct-webgpu'
}
finally {
  $env:APP_VERSION = $r38AppVersion
  $env:INSTALLER_NAME = $r38InstallerName
  $env:MANIFEST_NAME = $r38ManifestName
  $env:RELEASE_TAG = $r38ReleaseTag
}

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $r38Support) {
  Copy-Item (Join-Path $r38Stash $name) (Join-Path 'scripts' $name) -Force
}

$baselineManifestPath = Join-Path 'dist' 'lilacanime-libmpv-r37-manifest.json'
if (-not (Test-Path $baselineManifestPath)) { throw 'R38 inherited R37 manifest missing' }
$manifest = Get-Content $baselineManifestPath -Raw | ConvertFrom-Json

$bridgeShaBefore = Sha256 'electron/libmpv-shared-main.cjs'
$preloadShaBefore = Sha256 'electron/libmpv-shared-preload.cjs'
$preloadBundleShaBefore = Sha256 'electron/preload-libmpv-shared.generated.cjs'
$nativeSourceShaBefore = Sha256 'native/libmpv-d3d11-bridge/player_addon.cc'
$addonShaBefore = Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllShaBefore = Sha256 'electron/libmpv-2.dll'
$updaterShaBefore = Sha256 'electron/updater.cjs'
$desktopStateShaBefore = Sha256 'electron/desktop-state.cjs'

node --check scripts/r38-updater-lifecycle-fix.cjs
Assert-Exit 'R38 updater lifecycle transform syntax'
node scripts/r38-updater-lifecycle-fix.cjs
Assert-Exit 'R38 updater lifecycle transform'

# Make updater identity an explicit release invariant instead of relying on the
# nested historical build chain to leave the right value behind.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$pkg.version = $env:APP_VERSION
$pkg.lilacCustomTag = $env:RELEASE_TAG
$pkg.build.appId = $env:STABLE_APP_ID
$pkg.build.productName = $env:STABLE_PRODUCT_NAME
$pkg.build.win.executableName = $env:STABLE_EXE_BASE
$pkg.build.win.artifactName = $env:INSTALLER_NAME
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $PWD 'package.json'), (($pkg | ConvertTo-Json -Depth 100) + [Environment]::NewLine), $utf8NoBom)

if ((Sha256 'electron/libmpv-shared-main.cjs') -ne $bridgeShaBefore -or
    (Sha256 'electron/libmpv-shared-preload.cjs') -ne $preloadShaBefore -or
    (Sha256 'electron/preload-libmpv-shared.generated.cjs') -ne $preloadBundleShaBefore -or
    (Sha256 'native/libmpv-d3d11-bridge/player_addon.cc') -ne $nativeSourceShaBefore -or
    (Sha256 'electron/lilac-libmpv-player-bridge.node') -ne $addonShaBefore -or
    (Sha256 'electron/libmpv-2.dll') -ne $dllShaBefore -or
    (Sha256 'electron/updater.cjs') -ne $updaterShaBefore -or
    (Sha256 'electron/desktop-state.cjs') -ne $desktopStateShaBefore) {
  throw 'R38 updater-only transform changed a protected playback/updater implementation file'
}

$main = Get-Content 'electron/main.cjs' -Raw
$updaterSource = Get-Content 'electron/updater.cjs' -Raw
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkg.version -ne $env:APP_VERSION -or $pkg.lilacCustomTag -ne $env:RELEASE_TAG -or
    $pkg.build.appId -ne $env:STABLE_APP_ID -or $pkg.build.productName -ne $env:STABLE_PRODUCT_NAME -or
    $pkg.build.win.executableName -ne $env:STABLE_EXE_BASE -or $pkg.build.win.artifactName -ne $env:INSTALLER_NAME) {
  throw 'R38 package/update identity gate failed'
}
foreach ($marker in @('LILAC_R38_UPDATE_ACTIVITY_CHECK','r38CheckUpdaterOnActivity','r38InstallReadyUpdateOnReveal','second-instance','tray-show','window-focus')) {
  if (-not $main.Contains($marker)) { throw "R38 main updater lifecycle marker missing: $marker" }
}
foreach ($marker in @('CUSTOM_RELEASES_API','CUSTOM_CURRENT_TAG','checkCustom()','compareCustom')) {
  if (-not $updaterSource.Contains($marker)) { throw "R38 custom updater marker missing: $marker" }
}
if (-not $main.Contains('updater?.installOnQuit()')) { throw 'R38 normal quit-time install hook missing' }
if (-not $main.Contains("presentationMode") -and (Get-Content 'electron/libmpv-shared-preload.cjs' -Raw) -notmatch "presentationMode = 'direct-receive-webgpu-copy'") {
  throw 'R38 focused direct WebGPU baseline missing'
}

node --check scripts/r38-updater-lifecycle-smoke.cjs
Assert-Exit 'R38 updater lifecycle smoke syntax'
node scripts/r38-updater-lifecycle-smoke.cjs
Assert-Exit 'R38 actual custom updater lifecycle smoke'
Write-Host 'R38_SOURCE_GATES_OK updater=custom-r2k activity=startup+periodic+second-instance+tray-show+focus readyInstall=before-reveal normalQuitInstall=preserved identity=release-tag-exact playbackBytes=R37-unchanged'

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64 --publish never
Assert-Exit 'R38 final package'
$installer = Join-Path 'dist' $env:INSTALLER_NAME
if (-not (Test-Path $installer)) { throw "R38 installer missing: $installer" }

$asarCli = 'node_modules/.bin/asar.cmd'
if (-not (Test-Path $asarCli)) { throw 'R38 asar helper missing' }
$asarCheck = Join-Path $env:RUNNER_TEMP 'r38-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R38 packaged asar extract'

node scripts/r38-updater-lifecycle-smoke.cjs $asarCheck
Assert-Exit 'R38 packaged updater lifecycle smoke'

$shipPkg = Get-Content (Join-Path $asarCheck 'package.json') -Raw | ConvertFrom-Json
$shipMain = Get-Content (Join-Path $asarCheck 'electron/main.cjs') -Raw
$shipUpdater = Get-Content (Join-Path $asarCheck 'electron/updater.cjs') -Raw
if ($shipPkg.version -ne $env:APP_VERSION -or $shipPkg.lilacCustomTag -ne $env:RELEASE_TAG) { throw 'packaged R38 updater identity mismatch' }
if (-not $shipMain.Contains('LILAC_R38_UPDATE_ACTIVITY_CHECK') -or -not $shipMain.Contains("r38InstallReadyUpdateOnReveal('tray-show')")) { throw 'packaged R38 updater activity wiring missing' }
if (-not $shipUpdater.Contains('CUSTOM_RELEASES_API') -or -not $shipUpdater.Contains('checkCustom()')) { throw 'packaged R38 custom updater missing' }
if ((Sha256 (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs')) -ne $bridgeShaBefore -or
    (Sha256 (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs')) -ne $preloadShaBefore -or
    (Sha256 (Join-Path $asarCheck 'electron/preload-libmpv-shared.generated.cjs')) -ne $preloadBundleShaBefore) {
  throw 'packaged R38 playback bridge/preload bytes drifted from qualified R37'
}
$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if (-not (Test-Path $packedAddon) -or (Sha256 $packedAddon) -ne $addonShaBefore) { throw 'packaged R38 native addon drifted from qualified R37' }
if (-not (Test-Path $packedDll) -or (Sha256 $packedDll) -ne $dllShaBefore) { throw 'packaged R38 libmpv DLL drifted from qualified R37' }
Write-Host "R38_PACKAGED_SOURCE_OK customTag=$($shipPkg.lilacCustomTag) updaterActivity=1 actualUpdaterSmoke=1 bridgeSha=$bridgeShaBefore preloadSha=$preloadShaBefore addon=$addonShaBefore dll=$dllShaBefore playbackBytes=R37-unchanged"

$hash = Sha256 $installer
$size = (Get-Item $installer).Length
$manifest.version = $env:APP_VERSION
$manifest.installer = $env:INSTALLER_NAME
$manifest.installerSha256 = $hash
$manifest.installerSize = $size
$manifest.nativeAddon = $addonShaBefore
$manifest.nativeDll = $dllShaBefore
$manifest | Add-Member -NotePropertyName tag -NotePropertyValue $env:RELEASE_TAG -Force
$manifest | Add-Member -NotePropertyName r38UpdaterIdentity -NotePropertyValue 'package-lilacCustomTag-equals-release-tag' -Force
$manifest | Add-Member -NotePropertyName r38UpdaterActivity -NotePropertyValue 'startup5s+periodic3h+second-instance+tray-show+window-focus-cooldown2m' -Force
$manifest | Add-Member -NotePropertyName r38ReadyInstall -NotePropertyValue 'install-and-relaunch-before-revealing-tray-resident-old-build' -Force
$manifest | Add-Member -NotePropertyName r38UpdaterRuntimeSmoke -NotePropertyValue 'actual-custom-updater-newest-selection+auto-download+current-latest' -Force
$manifest | Add-Member -NotePropertyName r38PlaybackBytes -NotePropertyValue 'r37-bridge+preload+native-byte-identical' -Force
$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine), $utf8NoBom)

Write-Host "R38_BUILD_OK sha256=$hash size=$size electron=$($manifest.electron) customTag=$env:RELEASE_TAG updater=activity-aware readyInstall=before-reveal actualUpdaterSmoke=1 playbackBytes=R37-unchanged"

$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# R39 starts from the fully qualified and published R38 product. Preserve the R38
# updater lifecycle exactly, then change only the three user-evidenced areas:
# refocus pump phase, mini-player/native-popup topmost behavior, and native subtitle
# parity. R33 owned-popup, R37 explicit handoff, focused direct WebGPU, updater, and
# libmpv DLL remain protected invariants.
$r39Stash = Join-Path $env:RUNNER_TEMP 'lilac-r39-support'
Remove-Item $r39Stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $r39Stash | Out-Null
$r39Support = @('r39-refocus-pip-subtitle-fix.cjs','r39-refocus-pip-subtitle-smoke.cjs')
foreach ($name in $r39Support) {
  $src = Join-Path 'scripts' $name
  if (-not (Test-Path $src)) { throw "R39 support missing before R38 reconstruction: $name" }
  Copy-Item $src (Join-Path $r39Stash $name) -Force
}

$r39AppVersion = $env:APP_VERSION
$r39InstallerName = $env:INSTALLER_NAME
$r39ManifestName = $env:MANIFEST_NAME
$r39ReleaseTag = $env:RELEASE_TAG

try {
  $env:APP_VERSION = '0.5.54-libmpv-r3f.rc18'
  $env:INSTALLER_NAME = 'LilacAnime-Libmpv-R38-Setup.exe'
  $env:MANIFEST_NAME = 'lilacanime-libmpv-r38-manifest.json'
  $env:RELEASE_TAG = 'libmpv-r2k-v0.5.54-r38'
  Write-Host 'R39_BASELINE_BEGIN source=exact-qualified-R38'
  & ./scripts/r38-qualified-build.ps1
  Assert-Exit 'R38 qualified baseline for R39'
  Write-Host 'R39_BASELINE_OK inherited=R33-native-only+R37-explicit-handoff+R38-updater+focused-direct-webgpu'
}
finally {
  $env:APP_VERSION = $r39AppVersion
  $env:INSTALLER_NAME = $r39InstallerName
  $env:MANIFEST_NAME = $r39ManifestName
  $env:RELEASE_TAG = $r39ReleaseTag
}

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $r39Support) {
  Copy-Item (Join-Path $r39Stash $name) (Join-Path 'scripts' $name) -Force
}

$baselineManifestPath = Join-Path 'dist' 'lilacanime-libmpv-r38-manifest.json'
if (-not (Test-Path $baselineManifestPath)) { throw 'R39 inherited R38 manifest missing' }
$manifest = Get-Content $baselineManifestPath -Raw | ConvertFrom-Json

$updaterShaBefore = Sha256 'electron/updater.cjs'
$dllShaBefore = Sha256 'electron/libmpv-2.dll'
$sharedPreloadShaBefore = Sha256 'electron/libmpv-shared-preload.cjs'
$sharedPreloadBundleShaBefore = Sha256 'electron/preload-libmpv-shared.generated.cjs'

node --check scripts/r39-refocus-pip-subtitle-fix.cjs
Assert-Exit 'R39 transform syntax'
node --check scripts/r39-refocus-pip-subtitle-smoke.cjs
Assert-Exit 'R39 smoke syntax'
node scripts/r39-refocus-pip-subtitle-fix.cjs
Assert-Exit 'R39 product transform'

# Release identity must remain on the stable app/executable channel so R38 can
# discover and install R39 without profile migration or uninstall.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$pkg.version = $env:APP_VERSION
$pkg.lilacCustomTag = $env:RELEASE_TAG
$pkg.build.appId = $env:STABLE_APP_ID
$pkg.build.productName = $env:STABLE_PRODUCT_NAME
$pkg.build.win.executableName = $env:STABLE_EXE_BASE
$pkg.build.win.artifactName = $env:INSTALLER_NAME
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $PWD 'package.json'), (($pkg | ConvertTo-Json -Depth 100) + [Environment]::NewLine), $utf8NoBom)

if ((Sha256 'electron/updater.cjs') -ne $updaterShaBefore) { throw 'R39 changed protected R38 updater implementation' }
if ((Sha256 'electron/libmpv-2.dll') -ne $dllShaBefore -or $dllShaBefore -ne $env:QUALIFIED_DLL_SHA256) { throw 'R39 changed protected libmpv DLL' }
if ((Sha256 'electron/libmpv-shared-preload.cjs') -ne $sharedPreloadShaBefore -or
    (Sha256 'electron/preload-libmpv-shared.generated.cjs') -ne $sharedPreloadBundleShaBefore) {
  throw 'R39 changed protected focused direct-WebGPU shared preload bytes'
}

$bridge = Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$native = Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$entry = Get-Content 'src/libmpv-shared-entry.js' -Raw
$main = Get-Content 'electron/main.cjs' -Raw
$preload = Get-Content 'electron/preload.cjs' -Raw
$mini = Get-Content 'electron/miniplayer-window.cjs' -Raw
$pkg = Get-Content package.json -Raw | ConvertFrom-Json

if ($pkg.version -ne $env:APP_VERSION -or $pkg.lilacCustomTag -ne $env:RELEASE_TAG -or
    $pkg.build.appId -ne $env:STABLE_APP_ID -or $pkg.build.productName -ne $env:STABLE_PRODUCT_NAME -or
    $pkg.build.win.executableName -ne $env:STABLE_EXE_BASE -or $pkg.build.win.artifactName -ne $env:INSTALLER_NAME) {
  throw 'R39 package identity gate failed'
}
foreach ($marker in @('LILAC_R39_REFOCUS_PHASE_REANCHOR','r39ReanchorPumpPhase','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','LILAC_R37_NO_STALE_UI_HOLES')) {
  if (-not $bridge.Contains($marker)) { throw "R39 bridge marker missing: $marker" }
}
foreach ($marker in @('LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC','HWND_TOPMOST','LILAC_R33_OWNED_POPUP_FOCUS_SURFACE','LILAC_R33_NATIVE_ONLY_UNFOCUSED')) {
  if (-not $native.Contains($marker)) { throw "R39 native marker missing: $marker" }
}
foreach ($marker in @('LILAC_R39_NATIVE_SUBTITLE_PARITY','browserBottomInset',"'sub-ass-override', 'strip'")) {
  if (-not $entry.Contains($marker)) { throw "R39 subtitle marker missing: $marker" }
}
foreach ($marker in @('LILAC_R38_UPDATE_ACTIVITY_CHECK','player:miniplayer-state','LILAC_R39_MINIPLAYER_TOPMOST')) {
  if (-not $main.Contains($marker)) { throw "R39 main marker missing: $marker" }
}
if (-not $preload.Contains('miniPlayerState:')) { throw 'R39 mini-player preload state bridge missing' }
foreach ($marker in @("'screen-saver'",'always-on-top-changed',"hook('blur'",'moveTop')) {
  if (-not $mini.Contains($marker)) { throw "R39 mini-player controller marker missing: $marker" }
}
if ($entry.Contains("'sub-ass-override', 'force'") -or $entry.Contains("'sub-ass-override', 'scale'")) { throw 'R39 resurrected rejected subtitle override mode' }
if ((Get-Content 'electron/libmpv-shared-preload.cjs' -Raw).Contains('focus-staged-gpu-copy')) { throw 'R39 resurrected failed R28 staged presenter' }
if ($native.Contains('--disable-direct-composition')) { throw 'R39 resurrected failed R25 Direct Composition disable' }

node scripts/r39-refocus-pip-subtitle-smoke.cjs
Assert-Exit 'R39 source/mini-player smoke'
Write-Host 'R39_SOURCE_GATES_OK refocus=phase-reanchor focusedWake=immediate pip=screen-saver+native-owner-topmost subtitle=dom-baseline+browser-inset r33=preserved r37=preserved updater=R38-preserved focused=direct-webgpu'

# Native z-order synchronization changes C++; rebuild against the same Electron 44 ABI.
if (-not (Test-Path 'native/libmpv-d3d11-bridge/vendor/include/mpv/client.h')) { throw 'R39 inherited pinned libmpv headers missing' }
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R39 native addon rebuild'
$rebuilt = 'native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if (-not (Test-Path $rebuilt)) { throw 'R39 rebuilt addon missing' }
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
$r39AddonSha = Sha256 'electron/lilac-libmpv-player-bridge.node'
if ((Sha256 'electron/libmpv-2.dll') -ne $env:QUALIFIED_DLL_SHA256) { throw 'R39 DLL drift after native rebuild' }

# Re-run the strongest inherited runtime proofs after the R39 native/main changes.
$env:LILAC_LIBMPV_PLAYER_ADDON = (Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL = (Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r39-r33-visible-autonomy 120000
  Assert-Exit 'R39 inherited R33 owned-popup autonomy smoke'
  & node_modules/.bin/electron.cmd scripts/r37-native-handoff-freeze-smoke.cjs
  Assert-Exit 'R39 inherited R37 native handoff freeze smoke'
  node scripts/r37-run-e2e-with-timeout.cjs scripts/r37-explicit-handoff-e2e-smoke.cjs 180000
  Assert-Exit 'R39 inherited R37 raw shared-texture E2E'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}
Write-Host 'R39_RUNTIME_SMOKES_OK r33VisibleAutonomy=1 r37NativeFreeze=1 r37RawSharedTextureE2E=3cycles miniplayerStateMachine=1'

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

node scripts/r39-refocus-pip-subtitle-smoke.cjs $asarCheck
Assert-Exit 'R39 packaged source/mini-player smoke'

$shipPkg = Get-Content (Join-Path $asarCheck 'package.json') -Raw | ConvertFrom-Json
$shipMain = Get-Content (Join-Path $asarCheck 'electron/main.cjs') -Raw
$shipBridge = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs') -Raw
$shipEntry = Get-Content (Join-Path $asarCheck 'src/libmpv-shared-entry.js') -Raw
$shipUpdater = Get-Content (Join-Path $asarCheck 'electron/updater.cjs') -Raw
if ($shipPkg.version -ne $env:APP_VERSION -or $shipPkg.lilacCustomTag -ne $env:RELEASE_TAG) { throw 'packaged R39 identity mismatch' }
if (-not $shipMain.Contains('LILAC_R38_UPDATE_ACTIVITY_CHECK') -or -not $shipMain.Contains('LILAC_R39_MINIPLAYER_TOPMOST')) { throw 'packaged R39 main lifecycle markers missing' }
if (-not $shipBridge.Contains('LILAC_R39_REFOCUS_PHASE_REANCHOR') -or -not $shipBridge.Contains('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')) { throw 'packaged R39 bridge markers missing' }
if (-not $shipEntry.Contains('LILAC_R39_NATIVE_SUBTITLE_PARITY') -or -not $shipEntry.Contains("'sub-ass-override', 'strip'")) { throw 'packaged R39 subtitle markers missing' }
if ((Sha256 (Join-Path $asarCheck 'electron/updater.cjs')) -ne $updaterShaBefore) { throw 'packaged R39 updater drifted from R38' }
if ((Sha256 (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs')) -ne $sharedPreloadShaBefore -or
    (Sha256 (Join-Path $asarCheck 'electron/preload-libmpv-shared.generated.cjs')) -ne $sharedPreloadBundleShaBefore) {
  throw 'packaged R39 focused direct-WebGPU preload drifted from R38'
}
$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if (-not (Test-Path $packedAddon) -or (Sha256 $packedAddon) -ne $r39AddonSha) { throw 'packaged R39 native addon hash mismatch' }
if (-not (Test-Path $packedDll) -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'packaged R39 libmpv DLL mismatch' }
Write-Host "R39_PACKAGED_SOURCE_OK updater=R38-preserved focused=direct-webgpu r37Handoff=preserved refocus=phase-reanchor pip=browser+native-topmost subtitle=parity addon=$r39AddonSha dll=$env:QUALIFIED_DLL_SHA256"

$hash = Sha256 $installer
$size = (Get-Item $installer).Length
$manifest.version = $env:APP_VERSION
$manifest.installer = $env:INSTALLER_NAME
$manifest.installerSha256 = $hash
$manifest.installerSize = $size
$manifest.nativeAddon = $r39AddonSha
$manifest.nativeDll = $env:QUALIFIED_DLL_SHA256
$manifest | Add-Member -NotePropertyName tag -NotePropertyValue $env:RELEASE_TAG -Force
$manifest | Add-Member -NotePropertyName r39RefocusPhase -NotePropertyValue 'reset-native-deadline-on-blur+reset-and-immediate-pump-on-focus' -Force
$manifest | Add-Member -NotePropertyName r39MiniPlayerTopmost -NotePropertyValue 'browser-screen-saver-self-heal+owned-popup-owner-topmost-sync' -Force
$manifest | Add-Member -NotePropertyName r39MiniPlayerDiagnostics -NotePropertyValue 'copied-diagnostics-active+alwaysOnTop+pinCount+native-ownerTopmost+windowTopmost' -Force
$manifest | Add-Member -NotePropertyName r39SubtitleParity -NotePropertyValue 'native-defaults-100-12-2-700+browser-22over720-bottom-inset+R36-strip' -Force
$manifest | Add-Member -NotePropertyName r39BlackFlashInvariant -NotePropertyValue 'R37-full-owned-popup-no-ui-holes-preserved' -Force
$manifest | Add-Member -NotePropertyName r39UpdaterInvariant -NotePropertyValue 'R38-updater-byte-identical' -Force
$manifest | Add-Member -NotePropertyName r39FocusedPresenterInvariant -NotePropertyValue 'R38-shared-preload-byte-identical-direct-webgpu' -Force
$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 30) + [Environment]::NewLine), $utf8NoBom)

Write-Host "R39_BUILD_OK sha256=$hash size=$size electron=$($manifest.electron) refocus=phase-reanchor pip=native-owner-topmost subtitle=parity updater=R38-preserved focused=direct-webgpu"

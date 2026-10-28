$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
if (-not (Test-Path $manifestPath)) { throw 'R39 base manifest missing before final correction' }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Protected R38/R37 playback/update bytes. R39 deliberately changes only main bridge
# focus scheduling, native popup z-order, mini-player window state, and subtitle renderer.
$updaterSha = Sha256 'electron/updater.cjs'
$sharedPreloadSha = Sha256 'electron/libmpv-shared-preload.cjs'
$sharedPreloadBundleSha = Sha256 'electron/preload-libmpv-shared.generated.cjs'
$dllSha = Sha256 'electron/libmpv-2.dll'
if ($dllSha -ne $env:QUALIFIED_DLL_SHA256) { throw 'R39 final pre-correction DLL mismatch' }

node --check scripts/r39-subtitle-r2v-calibration-correction.cjs
Assert-Exit 'R39 subtitle correction syntax'
node --check scripts/r39-refocus-force-wake.cjs
Assert-Exit 'R39 force-wake syntax'
node --check scripts/r39-topmost-bidirectional-fix.cjs
Assert-Exit 'R39 bidirectional topmost syntax'
node --check scripts/r39-rebundle-final-renderer.cjs
Assert-Exit 'R39 final renderer rebundle syntax'
node --check scripts/r39-final-subtitle-smoke.cjs
Assert-Exit 'R39 final subtitle smoke syntax'
node --check scripts/r39-final-smoke.cjs
Assert-Exit 'R39 final integrated smoke syntax'

node scripts/r39-subtitle-r2v-calibration-correction.cjs
Assert-Exit 'R39 R2V subtitle correction'
node scripts/r39-refocus-force-wake.cjs
Assert-Exit 'R39 refocus force-wake correction'
node scripts/r39-topmost-bidirectional-fix.cjs
Assert-Exit 'R39 bidirectional topmost correction'
node scripts/r39-rebundle-final-renderer.cjs
Assert-Exit 'R39 final renderer rebundle'

node scripts/r39-final-subtitle-smoke.cjs
Assert-Exit 'R39 final subtitle source smoke'
node scripts/r39-final-smoke.cjs
Assert-Exit 'R39 final integrated source smoke'

$bridge = Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$native = Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$entry = Get-Content 'src/libmpv-shared-entry.js' -Raw
$rendererBundle = Get-Content 'src/libmpv-shared.generated.js' -Raw
$player = Get-Content 'src/player.js' -Raw
$main = Get-Content 'electron/main.cjs' -Raw

foreach ($marker in @('LILAC_R39_REFOCUS_PHASE_REANCHOR','LILAC_R39_REFOCUS_FORCE_WAKE','clearTimeout(pumpTimer)','pumpTimer = null','schedulePump(0)','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','LILAC_R37_NO_STALE_UI_HOLES')) {
  if (-not $bridge.Contains($marker)) { throw "R39 final refocus/handoff marker missing: $marker" }
}
foreach ($marker in @('LILAC_R39_NATIVE_POPUP_TOPMOST_SYNC','LILAC_R39_TOPMOST_BIDIRECTIONAL','r39OwnerTopmost ? HWND_TOPMOST : HWND_NOTOPMOST','LILAC_R33_OWNED_POPUP_FOCUS_SURFACE','LILAC_R33_NATIVE_ONLY_UNFOCUSED')) {
  if (-not $native.Contains($marker)) { throw "R39 final native marker missing: $marker" }
}
foreach ($marker in @('LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY','r39NativeVisualBottom = clamp(position - 1.25, 0, 48)',"'sub-ass-override', 'strip'")) {
  if (-not $entry.Contains($marker)) { throw "R39 final subtitle marker missing: $marker" }
}
foreach ($marker in @('LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY','r39NativeVisualBottom','Malgun Gothic','Pretendard','Noto Sans KR','LILAC_R39_FINAL_RENDERER_ATTEST')) {
  if (-not $rendererBundle.Contains($marker)) { throw "R39 final generated renderer marker missing: $marker" }
}
foreach ($marker in @('libmpvMiniInvoker','LilacMiniPlayerDiagnostics','__lilac_miniplayer_on__')) {
  if (-not $player.Contains($marker)) { throw "R39 final mini-player UI bridge marker missing: $marker" }
}
if (-not $main.Contains("mode==='__lilac_miniplayer_on__'")) { throw 'R39 final mini-player fallback IPC missing' }
if ($entry.Contains('LILAC_R39_NATIVE_SUBTITLE_PARITY') -or $rendererBundle.Contains('LILAC_R39_NATIVE_SUBTITLE_PARITY')) { throw 'R39 final superseded subtitle marker survived' }
if ($entry.Contains("'sub-ass-override', 'force'") -or $entry.Contains("'sub-ass-override', 'scale'")) { throw 'R39 final rejected subtitle override mode returned' }
if ((Get-Content 'electron/libmpv-shared-preload.cjs' -Raw).Contains('focus-staged-gpu-copy')) { throw 'R39 final resurrected R28 staged presenter' }
if ($native.Contains('--disable-direct-composition')) { throw 'R39 final resurrected R25 Direct Composition disable' }

if ((Sha256 'electron/updater.cjs') -ne $updaterSha) { throw 'R39 final changed protected R38 updater' }
if ((Sha256 'electron/libmpv-shared-preload.cjs') -ne $sharedPreloadSha -or
    (Sha256 'electron/preload-libmpv-shared.generated.cjs') -ne $sharedPreloadBundleSha) {
  throw 'R39 final changed protected focused direct-WebGPU preload bytes'
}
if ((Sha256 'electron/libmpv-2.dll') -ne $dllSha) { throw 'R39 final changed protected libmpv DLL before native rebuild' }
Write-Host 'R39_FINAL_SOURCE_GATES_OK refocus=phase-reset+replace-existing-timer pip=direct+fallback+browser-self-heal+native-bidirectional subtitle=R2V-calibrated rendererBundle=refreshed r33=preserved r37=preserved r38Updater=preserved focused=direct-webgpu'

# C++ topmost synchronization changed; rebuild against the same Electron ABI.
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R39 final native addon rebuild'
$rebuilt = 'native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if (-not (Test-Path $rebuilt)) { throw 'R39 final rebuilt addon missing' }
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
$r39AddonSha = Sha256 'electron/lilac-libmpv-player-bridge.node'
if ((Sha256 'electron/libmpv-2.dll') -ne $env:QUALIFIED_DLL_SHA256) { throw 'R39 final DLL drift after native rebuild' }

# Repeat strongest existing native/focus runtime evidence only after ALL final changes.
$env:LILAC_LIBMPV_PLAYER_ADDON = (Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL = (Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r39-final-r33-visible-autonomy 120000
  Assert-Exit 'R39 final R33 owned-popup visible autonomy smoke'
  & node_modules/.bin/electron.cmd scripts/r37-native-handoff-freeze-smoke.cjs
  Assert-Exit 'R39 final R37 native handoff freeze smoke'
  node scripts/r37-run-e2e-with-timeout.cjs scripts/r37-explicit-handoff-e2e-smoke.cjs 180000
  Assert-Exit 'R39 final R37 raw shared-texture E2E'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}
Write-Host 'R39_FINAL_RUNTIME_SMOKES_OK r33VisibleAutonomy=1 r37NativeFreeze=1 r37RawSharedTextureE2E=3cycles refocusForceWake=source-proven miniplayerStateMachine=1'

# Repackage only after final runtime qualification.
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64 --publish never
Assert-Exit 'R39 final package'
$installer = Join-Path 'dist' $env:INSTALLER_NAME
if (-not (Test-Path $installer)) { throw "R39 final installer missing: $installer" }

$asarCli = 'node_modules/.bin/asar.cmd'
if (-not (Test-Path $asarCli)) { throw 'R39 final asar helper missing' }
$asarCheck = Join-Path $env:RUNNER_TEMP 'r39-final-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R39 final packaged asar extract'

node scripts/r39-final-subtitle-smoke.cjs $asarCheck
Assert-Exit 'R39 final packaged subtitle smoke'
node scripts/r39-final-smoke.cjs $asarCheck
Assert-Exit 'R39 final packaged integrated smoke'

$shipPkg = Get-Content (Join-Path $asarCheck 'package.json') -Raw | ConvertFrom-Json
$shipBridge = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs') -Raw
$shipEntry = Get-Content (Join-Path $asarCheck 'src/libmpv-shared-entry.js') -Raw
$shipRenderer = Get-Content (Join-Path $asarCheck 'src/libmpv-shared.generated.js') -Raw
$shipMain = Get-Content (Join-Path $asarCheck 'electron/main.cjs') -Raw
if ($shipPkg.version -ne $env:APP_VERSION -or $shipPkg.lilacCustomTag -ne $env:RELEASE_TAG) { throw 'R39 final packaged identity mismatch' }
foreach ($marker in @('LILAC_R39_REFOCUS_PHASE_REANCHOR','LILAC_R39_REFOCUS_FORCE_WAKE','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')) {
  if (-not $shipBridge.Contains($marker)) { throw "R39 final packaged bridge marker missing: $marker" }
}
foreach ($marker in @('LILAC_R39_NATIVE_SUBTITLE_R2V_PARITY','r39NativeVisualBottom')) {
  if (-not $shipEntry.Contains($marker) -or -not $shipRenderer.Contains($marker)) { throw "R39 final packaged subtitle source/bundle marker missing: $marker" }
}
if (-not $shipRenderer.Contains('LILAC_R39_FINAL_RENDERER_ATTEST')) { throw 'R39 final packaged runtime renderer was not refreshed' }
if (-not $shipMain.Contains('LILAC_R38_UPDATE_ACTIVITY_CHECK') -or -not $shipMain.Contains('LILAC_R39_MINIPLAYER_TOPMOST')) { throw 'R39 final packaged updater/mini-player lifecycle markers missing' }
if ((Sha256 (Join-Path $asarCheck 'electron/updater.cjs')) -ne $updaterSha) { throw 'R39 final packaged updater drifted from R38' }
if ((Sha256 (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs')) -ne $sharedPreloadSha -or
    (Sha256 (Join-Path $asarCheck 'electron/preload-libmpv-shared.generated.cjs')) -ne $sharedPreloadBundleSha) {
  throw 'R39 final packaged focused direct-WebGPU preload drifted from R38'
}
$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if (-not (Test-Path $packedAddon) -or (Sha256 $packedAddon) -ne $r39AddonSha) { throw 'R39 final packaged native addon hash mismatch' }
if (-not (Test-Path $packedDll) -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'R39 final packaged libmpv DLL mismatch' }
Write-Host "R39_FINAL_PACKAGED_OK updater=R38-byte-identical focused=direct-webgpu-byte-identical rendererBundle=R39-refreshed r37Handoff=preserved nativeAddon=$r39AddonSha dll=$env:QUALIFIED_DLL_SHA256"

# Finalize manifest from the base R39 manifest, replacing the intentionally temporary
# subtitle proof with the authoritative R2V-calibrated final proof.
$hash = Sha256 $installer
$size = (Get-Item $installer).Length
$manifest.version = $env:APP_VERSION
$manifest.installer = $env:INSTALLER_NAME
$manifest.installerSha256 = $hash
$manifest.installerSize = $size
$manifest.nativeAddon = $r39AddonSha
$manifest.nativeDll = $env:QUALIFIED_DLL_SHA256
$manifest | Add-Member -NotePropertyName tag -NotePropertyValue $env:RELEASE_TAG -Force
$manifest | Add-Member -NotePropertyName r39RefocusPhase -NotePropertyValue 'reset-native-deadline-on-blur+replace-pending-timer+reset-and-immediate-pump-on-focus' -Force
$manifest | Add-Member -NotePropertyName r39MiniPlayerTopmost -NotePropertyValue 'direct+R2V-fallback+browser-screen-saver-self-heal+owned-popup-owner-topmost-sync' -Force
$manifest | Add-Member -NotePropertyName r39TopmostBidirectional -NotePropertyValue 'owner-topmost=>HWND_TOPMOST+owner-normal=>HWND_NOTOPMOST' -Force
$manifest | Add-Member -NotePropertyName r39MiniPlayerDiagnostics -NotePropertyValue 'copied-diagnostics-active+alwaysOnTop+pinCount+native-ownerTopmost+windowTopmost' -Force
$manifest | Add-Member -NotePropertyName r39SubtitleParity -NotePropertyValue 'R2V-105-10-130-400-3-preserved+native-bottom-position-minus1.25+known-font-preset+R36-strip' -Force
$manifest | Add-Member -NotePropertyName r39RendererBundle -NotePropertyValue 'rebuilt-after-final-subtitle-correction+packaged-marker-verified' -Force
$manifest | Add-Member -NotePropertyName r39BlackFlashInvariant -NotePropertyValue 'R37-full-owned-popup-no-ui-holes-preserved' -Force
$manifest | Add-Member -NotePropertyName r39UpdaterInvariant -NotePropertyValue 'R38-updater-byte-identical' -Force
$manifest | Add-Member -NotePropertyName r39FocusedPresenterInvariant -NotePropertyValue 'R38-shared-preload-byte-identical-direct-webgpu' -Force
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 30) + [Environment]::NewLine), $utf8NoBom)

Write-Host "R39_FINAL_BUILD_OK sha256=$hash size=$size addon=$r39AddonSha refocus=phase-reanchor+forced-wake pip=direct+fallback+bidirectional-native-topmost subtitle=R2V-calibrated rendererBundle=refreshed updater=R38-preserved focused=direct-webgpu"

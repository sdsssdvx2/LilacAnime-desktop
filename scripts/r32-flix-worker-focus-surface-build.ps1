$ErrorActionPreference = 'Stop'

$base = Get-Content 'scripts/r31-focus-compositor-state-coalesce-build.ps1' -Raw
$patched = $base

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

$needle = @'
  'scripts/r31-transform-anchor-normalize.cjs',
  'scripts/r31-focus-compositor-state-coalesce-fix.cjs'
)) {
'@
$replacement = @'
  'scripts/r31-transform-anchor-normalize.cjs',
  'scripts/r31-focus-compositor-state-coalesce-fix.cjs',
  'scripts/r32-flix-worker-focus-surface-fix.cjs',
  'scripts/r32-packed-runtime-paths.cjs',
  'scripts/r32-runtime-bundle-normalize.cjs',
  'native/win32-libmpv-focus-presenter.cpp'
)) {
'@
$patched = Replace-Once $patched $needle $replacement 'R32 support list'

$needle = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs','r30-managed-release-producer-drain-fix.cjs','r31-transform-anchor-normalize.cjs','r31-focus-compositor-state-coalesce-fix.cjs')) {
'@
$replacement = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs','r30-managed-release-producer-drain-fix.cjs','r31-transform-anchor-normalize.cjs','r31-focus-compositor-state-coalesce-fix.cjs','r32-flix-worker-focus-surface-fix.cjs','r32-packed-runtime-paths.cjs','r32-runtime-bundle-normalize.cjs')) {
'@
$patched = Replace-Once $patched $needle $replacement 'R32 restore list'

$needle = @'
node scripts/r31-focus-compositor-state-coalesce-fix.cjs
Assert-Exit 'R31 compositor/state patch'
'@
$replacement = @'
node scripts/r31-focus-compositor-state-coalesce-fix.cjs
Assert-Exit 'R31 compositor/state patch'
New-Item -ItemType Directory -Force -Path native | Out-Null
Copy-Item (Join-Path $support 'win32-libmpv-focus-presenter.cpp') 'native/win32-libmpv-focus-presenter.cpp' -Force
node --check scripts/r32-flix-worker-focus-surface-fix.cjs
Assert-Exit 'R32 worker/focus syntax'
node scripts/r32-flix-worker-focus-surface-fix.cjs
Assert-Exit 'R32 worker/focus patch'
node --check scripts/r32-packed-runtime-paths.cjs
Assert-Exit 'R32 packed runtime path syntax'
node scripts/r32-packed-runtime-paths.cjs
Assert-Exit 'R32 packed runtime path patch'
node --check scripts/r32-runtime-bundle-normalize.cjs
Assert-Exit 'R32 runtime bundle normalize syntax'
node scripts/r32-runtime-bundle-normalize.cjs
Assert-Exit 'R32 runtime bundle normalize'
& cl.exe /nologo /EHsc /std:c++20 /O2 /DUNICODE /D_UNICODE native\win32-libmpv-focus-presenter.cpp /Fe:electron\win32-libmpv-focus-presenter.exe /link d3d11.lib dxgi.lib user32.lib
Assert-Exit 'R32 native focus presenter compile'
if (!(Test-Path 'electron\win32-libmpv-focus-presenter.exe')) { throw 'R32 native presenter EXE missing after compile' }
'@
$patched = Replace-Once $patched $needle $replacement 'apply R32'

$needle = @'
Write-Host 'R31_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=canvas2d-shield shieldPrewarm=1of8 focusRecovery=2 stateNativePollMs=1000 uiClock=wall-extrapolated managedRelease=1'
'@
$replacement = @'
$flixWrapper = Get-Content electron/flix-proxy.cjs -Raw
$flixWorker = Get-Content electron/flix-proxy-worker.cjs -Raw
$flixCore = Get-Content electron/flix-proxy-worker-core.cjs -Raw
$presenterSource = Get-Content native/win32-libmpv-focus-presenter.cpp -Raw
$presenterExe = Get-Item electron/win32-libmpv-focus-presenter.exe
if ($bridge -notmatch 'LILAC_R32_NATIVE_FOCUS_PRESENTER' -or $bridge -notmatch 'r32SubmitPresenterFrame' -or $bridge -notmatch 'focused-direct-webgpu/unfocused-win32-d3d11-child') { throw 'R32 native focus presenter bridge missing' }
if ($bridge -notmatch 'LilacAnime-R32-native' -or $bridge -notmatch "app.getPath\('temp'\)") { throw 'R32 packaged helper extraction missing' }
if ($rendererSource -notmatch 'rect.left \* dpr' -or $rendererSource -notmatch 'rect.top \* dpr' -or $rendererSource -notmatch 'visible: this.isConnected') { throw 'R32 renderer physical bounds source missing' }
if ($rendererBundle -notmatch 'rect.left \* dpr' -or $rendererBundle -notmatch 'rect.top \* dpr' -or $rendererBundle -notmatch 'visible: this.isConnected') { throw 'R32 renderer physical bounds bundle missing' }
if ($flixWrapper -notmatch 'LILAC_R32_FLIX_WORKER' -or $flixWrapper -notmatch 'LilacAnime-R32-flix-' -or $flixWrapper -notmatch 'new Worker') { throw 'R32 Flix worker wrapper missing' }
if ($flixWorker -notmatch 'parentPort' -or $flixWorker -notmatch 'createFlixProxyUrl' -or $flixCore -notmatch 'async function fetchRanges' -or $flixCore -notmatch 'function decodeSegment') { throw 'R32 Flix worker payload missing' }
if ($presenterSource -notmatch 'DuplicateHandle' -or $presenterSource -notmatch 'OpenSharedResource1' -or $presenterSource -notmatch 'CopyResource' -or $presenterSource -notmatch 'Present\(1, 0\)') { throw 'R32 native presenter source gates failed' }
if ($presenterExe.Length -lt 20000) { throw 'R32 native presenter EXE unexpectedly small' }
if ($preload -notmatch 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD') { throw 'R32 lost R31 renderer fallback' }
Write-Host 'R32_SOURCE_GATES_OK nativeProducer=unchanged focusedPresenter=direct-webgpu unfocusedPresenter=win32-d3d11-child fallback=R31-canvas2d flix=worker-loopback-server secondDecoder=0 cpuCopy=0'
'@
$patched = Replace-Once $patched $needle $replacement 'R32 source gate'

$needle = @'
if ($shipRenderer -notmatch 'LILAC_R31_STATE_CLOCK' -or $shipRenderer -notmatch '_estimatedCurrentTime' -or $shipRenderer -notmatch 'r31StateSampleWallMs') { throw 'packaged R31 renderer state clock missing' }
'@
$replacement = @'
if ($shipRenderer -notmatch 'LILAC_R31_STATE_CLOCK' -or $shipRenderer -notmatch '_estimatedCurrentTime' -or $shipRenderer -notmatch 'r31StateSampleWallMs') { throw 'packaged R31 renderer state clock missing' }
if ($shipBridge -notmatch 'LILAC_R32_NATIVE_FOCUS_PRESENTER' -or $shipBridge -notmatch 'r32SubmitPresenterFrame' -or $shipBridge -notmatch 'LilacAnime-R32-native') { throw 'packaged R32 native focus presenter missing' }
if ($shipRenderer -notmatch 'rect.left \* dpr' -or $shipRenderer -notmatch 'rect.top \* dpr' -or $shipRenderer -notmatch 'visible: this.isConnected') { throw 'packaged R32 renderer physical bounds missing' }
$shipFlix = Get-Content (Join-Path $asarCheck 'electron\flix-proxy.cjs') -Raw
$shipFlixWorker = Get-Content (Join-Path $asarCheck 'electron\flix-proxy-worker.cjs') -Raw
$shipFlixCore = Get-Content (Join-Path $asarCheck 'electron\flix-proxy-worker-core.cjs') -Raw
if ($shipFlix -notmatch 'LILAC_R32_FLIX_WORKER' -or $shipFlix -notmatch 'LilacAnime-R32-flix-' -or $shipFlixWorker -notmatch 'parentPort' -or $shipFlixCore -notmatch 'async function fetchRanges') { throw 'packaged R32 Flix worker missing' }
$shipPresenter = Get-ChildItem @($asarCheck,(Join-Path $unpacked.FullName 'resources\app.asar.unpacked')) -Recurse -File -Filter 'win32-libmpv-focus-presenter.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $shipPresenter -or $shipPresenter.Length -lt 20000) { throw 'packaged R32 native presenter missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'packaged R32 gate'

$needle = @'
  r31FocusCompositorShield = 'focused-direct-webgpu+unfocused-canvas2d-shield+prewarm8+recovery2'
  r31StateCoalesce = 'native-poll1000ms+renderer-wall-clock-extrapolation'
  r23WindowRepairPreserved = $true
'@
$replacement = @'
  r31FocusCompositorShield = 'focused-direct-webgpu+unfocused-canvas2d-shield+prewarm8+recovery2'
  r31StateCoalesce = 'native-poll1000ms+renderer-wall-clock-extrapolation'
  r32FlixWorkerIsolation = 'loopback-http-server+range-fetch+xor-decode-in-worker-thread'
  r32NativeFocusPresenter = 'focused-direct-webgpu+unfocused-win32-d3d11-child+R31-canvas2d-fallback'
  r32NativeFocusPresenterSha256 = (Sha256 $presenterExe.FullName)
  r23WindowRepairPreserved = $true
'@
$patched = Replace-Once $patched $needle $replacement 'R32 manifest fields'

$patched = Replace-Once $patched '"R31_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R32_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'hash env'
$patched = Replace-Once $patched '"R31_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R32_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'size env'
$patched = Replace-Once $patched 'Write-Host "R31_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=canvas2d-shield stateNativePollMs=1000 uiClock=wall-extrapolated managedRelease=1 producerWatchdogMs=250 backlog=newest-only"' 'Write-Host "R32_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeAddonUnchanged=1 mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=win32-d3d11-child fallback=R31-canvas2d flix=worker-loopback-server producerWatchdogMs=250 backlog=newest-only"' 'build marker'

$tempScript = Join-Path $env:RUNNER_TEMP 'r32-generated-build.ps1'
Set-Content $tempScript $patched -Encoding utf8
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

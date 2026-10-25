$ErrorActionPreference = 'Stop'

$base = Get-Content 'scripts/r30-managed-release-producer-drain-build.ps1' -Raw
$patched = $base

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

$needle = @'
  'scripts/r27-focus-stall-retention-fix.cjs',
  'scripts/r30-managed-release-producer-drain-fix.cjs'
)) {
'@
$replacement = @'
  'scripts/r27-focus-stall-retention-fix.cjs',
  'scripts/r30-managed-release-producer-drain-fix.cjs',
  'scripts/r31-transform-anchor-normalize.cjs',
  'scripts/r31-focus-compositor-state-coalesce-fix.cjs'
)) {
'@
$patched = Replace-Once $patched $needle $replacement 'support list'

$needle = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs','r30-managed-release-producer-drain-fix.cjs')) {
'@
$replacement = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs','r30-managed-release-producer-drain-fix.cjs','r31-transform-anchor-normalize.cjs','r31-focus-compositor-state-coalesce-fix.cjs')) {
'@
$patched = Replace-Once $patched $needle $replacement 'restore list'

$needle = @'
node scripts/r30-managed-release-producer-drain-fix.cjs
Assert-Exit 'R30 managed-release producer-drain patch'
'@
$replacement = @'
node scripts/r30-managed-release-producer-drain-fix.cjs
Assert-Exit 'R30 managed-release producer-drain patch'
node scripts/r31-transform-anchor-normalize.cjs
Assert-Exit 'R31 transform anchor normalization'
node --check scripts/r31-focus-compositor-state-coalesce-fix.cjs
Assert-Exit 'R31 compositor/state syntax'
node scripts/r31-focus-compositor-state-coalesce-fix.cjs
Assert-Exit 'R31 compositor/state patch'
'@
$patched = Replace-Once $patched $needle $replacement 'apply R31'

$needle = @'
Write-Host 'R30_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest presenter=R27-direct-webgpu rendererRelease=managed-sync-token producerWatchdogMs=250 backlog=newest-only r27=preserved'
'@
$replacement = @'
$rendererSource = Get-Content src/libmpv-shared-entry.js -Raw
$rendererBundle = Get-Content src/libmpv-shared.generated.js -Raw
if ($bridge -notmatch 'LILAC_R31_STATE_COALESCE' -or $bridge -notmatch 'R31_PLAYBACK_STATE_POLL_MS = 1000' -or $bridge -notmatch 'r31StateSampleWallMs' -or $bridge -notmatch 'r31StateCacheHits') { throw 'R31 state coalesce bridge missing' }
if ($preload -notmatch 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD' -or $preload -notmatch 'data-lilac-libmpv-focus-shield' -or $preload -notmatch 'r31DrawFocusShield' -or $preload -notmatch 'focused-direct-webgpu/unfocused-canvas2d-shield') { throw 'R31 focus compositor shield missing' }
if ($rendererSource -notmatch 'LILAC_R31_STATE_CLOCK' -or $rendererSource -notmatch '_estimatedCurrentTime' -or $rendererSource -notmatch 'r31StateSampleWallMs') { throw 'R31 renderer state clock source missing' }
if ($rendererBundle -notmatch 'LILAC_R31_STATE_CLOCK' -or $rendererBundle -notmatch '_estimatedCurrentTime' -or $rendererBundle -notmatch 'r31StateSampleWallMs') { throw 'R31 renderer state clock bundle missing' }
if ($preload -match 'LILAC_R28_FOCUS_SAFE_PLAYBACK' -or $preload -match 'r28FocusStagingTexture' -or $preload -match 'copyTextureToTexture') { throw 'failed R28 staging survived R31' }
if ($preload -match 'LILAC_R29_GPU_SAFE_LIFETIME' -or $preload -match 'r29GpuSafeReleaseCallbacks' -or $preload -match 'subtle.*release') { throw 'broken R29 lifetime path survived R31' }
if ($preload -match 'requestAnimationFrame\(' -or $preload -match 'onSubmittedWorkDone\(') { throw 'R31 preload reintroduced forbidden synchronization' }
Write-Host 'R31_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=canvas2d-shield shieldPrewarm=1of8 focusRecovery=2 stateNativePollMs=1000 uiClock=wall-extrapolated managedRelease=1'
'@
$patched = Replace-Once $patched $needle $replacement 'R31 source gate'

$needle = @'
if ($shipBridge -notmatch 'LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN' -or $shipBridge -notmatch 'r30PopLatestProducedFrame' -or $shipBridge -notmatch 'R30_PRODUCER_JS_WATCHDOG_MS = 250') { throw 'packaged R30 producer repair missing' }
'@
$replacement = @'
if ($shipBridge -notmatch 'LILAC_R30_MANAGED_RELEASE_PRODUCER_DRAIN' -or $shipBridge -notmatch 'r30PopLatestProducedFrame' -or $shipBridge -notmatch 'R30_PRODUCER_JS_WATCHDOG_MS = 250') { throw 'packaged R30 producer repair missing' }
if ($shipBridge -notmatch 'LILAC_R31_STATE_COALESCE' -or $shipBridge -notmatch 'R31_PLAYBACK_STATE_POLL_MS = 1000' -or $shipBridge -notmatch 'r31StateSampleWallMs') { throw 'packaged R31 state coalesce missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'packaged bridge R31 gate'

$needle = @'
if ($shipPreload -match 'requestAnimationFrame\(' -or $shipPreload -match 'onSubmittedWorkDone\(') { throw 'packaged R30 forbidden render synchronization survived' }
'@
$replacement = @'
if ($shipPreload -match 'requestAnimationFrame\(' -or $shipPreload -match 'onSubmittedWorkDone\(') { throw 'packaged R30 forbidden render synchronization survived' }
if ($shipPreload -notmatch 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD' -or $shipPreload -notmatch 'data-lilac-libmpv-focus-shield' -or $shipPreload -notmatch 'r31DrawFocusShield') { throw 'packaged R31 focus shield missing' }
if ($shipPreload -match 'LILAC_R28_FOCUS_SAFE_PLAYBACK' -or $shipPreload -match 'copyTextureToTexture' -or $shipPreload -match 'LILAC_R29_GPU_SAFE_LIFETIME' -or $shipPreload -match 'subtle.*release') { throw 'packaged failed renderer experiment survived R31' }
$shipRenderer = Get-Content (Join-Path $asarCheck 'src\libmpv-shared.generated.js') -Raw
if ($shipRenderer -notmatch 'LILAC_R31_STATE_CLOCK' -or $shipRenderer -notmatch '_estimatedCurrentTime' -or $shipRenderer -notmatch 'r31StateSampleWallMs') { throw 'packaged R31 renderer state clock missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'packaged R31 renderer gate'

$needle = @'
  r30ManagedReleaseProducerDrain = 'r27-renderer-byte-identical+managed-sync-token-release+producer-watchdog250+latest-backlog-collapse'
  r23WindowRepairPreserved = $true
'@
$replacement = @'
  r30ManagedReleaseProducerDrain = 'r27-renderer-byte-identical+managed-sync-token-release+producer-watchdog250+latest-backlog-collapse'
  r31FocusCompositorShield = 'focused-direct-webgpu+unfocused-canvas2d-shield+prewarm8+recovery2'
  r31StateCoalesce = 'native-poll1000ms+renderer-wall-clock-extrapolation'
  r23WindowRepairPreserved = $true
'@
$patched = Replace-Once $patched $needle $replacement 'R31 manifest fields'

$patched = Replace-Once $patched '"R30_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R31_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'hash env'
$patched = Replace-Once $patched '"R30_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R31_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'size env'
$patched = Replace-Once $patched 'Write-Host "R30_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest presenter=R27-direct-webgpu rendererRelease=managed-sync-token producerWatchdogMs=250 backlog=newest-only"' 'Write-Host "R31_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=canvas2d-shield stateNativePollMs=1000 uiClock=wall-extrapolated managedRelease=1 producerWatchdogMs=250 backlog=newest-only"' 'build marker'

$tempScript = Join-Path $env:RUNNER_TEMP 'r31-generated-build.ps1'
Set-Content $tempScript $patched -Encoding utf8
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ErrorActionPreference = 'Stop'

$base = Get-Content 'scripts/r24-performance-build.ps1' -Raw
$patched = $base

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

$needle = @'
  'scripts/r24-focus-delivery-fix.cjs'
)) {
'@
$replacement = @'
  'scripts/r24-focus-delivery-fix.cjs',
  'scripts/r26-stall-boundary-fix.cjs'
)) {
'@
$patched = Replace-Once $patched $needle $replacement 'support list'

$needle = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs')) {
'@
$replacement = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs')) {
'@
$patched = Replace-Once $patched $needle $replacement 'restore list'

$needle = @'
node scripts/r24-focus-delivery-fix.cjs
Assert-Exit 'R24 focus/delivery patch'
'@
$replacement = @'
node scripts/r24-focus-delivery-fix.cjs
Assert-Exit 'R24 focus/delivery patch'
node --check scripts/r26-stall-boundary-fix.cjs
Assert-Exit 'R26 boundary trace syntax'
node scripts/r26-stall-boundary-fix.cjs
Assert-Exit 'R26 boundary trace patch'
'@
$patched = Replace-Once $patched $needle $replacement 'apply R26'

$needle = @'
Write-Host 'R24_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest inactiveGuard=1 cadenceLazy=1 presenter=direct-webgpu'
'@
$replacement = @'
if ($bridge -notmatch 'LILAC_R26_STALL_BOUNDARY_TRACE' -or $bridge -notmatch 'r26BoundaryTrace' -or $bridge -notmatch 'r26DispatchWallMs') { throw 'R26 main boundary trace missing' }
if ($preload -notmatch 'LILAC_R26_STALL_BOUNDARY_TRACE' -or $preload -notmatch 'r26TransportMs' -or $preload -notmatch 'r26SnapshotRendererTrace') { throw 'R26 renderer boundary trace missing' }
if ($preload -match 'requestAnimationFrame\(' -or $preload -match 'onSubmittedWorkDone\(') { throw 'R26 changed renderer synchronization semantics' }
Write-Host 'R26_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest inactiveGuard=1 cadenceLazy=1 presenter=direct-webgpu trace=ring256-on-demand'
'@
$patched = Replace-Once $patched $needle $replacement 'source gate'

$needle = @'
if ($shipBridge -notmatch 'LILAC_R24_LATEST_FRAME_MAILBOX' -or $shipBridge -notmatch 'deliveryCoalescedFrames') { throw 'packaged mailbox missing' }
'@
$replacement = @'
if ($shipBridge -notmatch 'LILAC_R24_LATEST_FRAME_MAILBOX' -or $shipBridge -notmatch 'deliveryCoalescedFrames') { throw 'packaged mailbox missing' }
if ($shipBridge -notmatch 'LILAC_R26_STALL_BOUNDARY_TRACE' -or $shipBridge -notmatch 'r26BoundaryTrace') { throw 'packaged R26 main trace missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'packaged bridge gate'

$needle = @'
if ($shipPreload -notmatch 'LILAC_R24_CADENCE_LAZY' -or $shipPreload -notmatch 'receiveCadenceTracker\.record') { throw 'packaged lazy cadence missing' }
'@
$replacement = @'
if ($shipPreload -notmatch 'LILAC_R24_CADENCE_LAZY' -or $shipPreload -notmatch 'receiveCadenceTracker\.record') { throw 'packaged lazy cadence missing' }
if ($shipPreload -notmatch 'LILAC_R26_STALL_BOUNDARY_TRACE' -or $shipPreload -notmatch 'r26SnapshotRendererTrace' -or $shipPreload -notmatch 'r26TransportMs') { throw 'packaged R26 renderer trace missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'packaged preload gate'

$needle = @'
  cadenceHotpath = 'record-only-snapshot-4hz'
  r23WindowRepairPreserved = $true
'@
$replacement = @'
  cadenceHotpath = 'record-only-snapshot-4hz'
  r26BoundaryTrace = 'ring256-on-demand-main-dispatch-renderer-entry-getVideoFrame-gpu-copy-present-release'
  r23WindowRepairPreserved = $true
'@
$patched = Replace-Once $patched $needle $replacement 'manifest field'

$patched = Replace-Once $patched '"R24_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R26_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'hash env'
$patched = Replace-Once $patched '"R24_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R26_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'size env'
$patched = Replace-Once $patched 'Write-Host "R24_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest inactiveGuard=1 cadenceLazy=1"' 'Write-Host "R26_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest inactiveGuard=1 cadenceLazy=1 trace=ring256-on-demand"' 'build marker'

$tempScript = Join-Path $env:RUNNER_TEMP 'r26-generated-build.ps1'
Set-Content $tempScript $patched -Encoding utf8
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

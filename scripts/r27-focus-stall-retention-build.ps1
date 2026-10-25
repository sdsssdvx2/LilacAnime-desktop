$ErrorActionPreference = 'Stop'

$base = Get-Content 'scripts/r26-stall-boundary-build.ps1' -Raw
$patched = $base

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

$needle = @'
  'scripts/r24-focus-delivery-fix.cjs',
  'scripts/r26-stall-boundary-fix.cjs'
)) {
'@
$replacement = @'
  'scripts/r24-focus-delivery-fix.cjs',
  'scripts/r26-stall-boundary-fix.cjs',
  'scripts/r27-focus-stall-retention-fix.cjs'
)) {
'@
$patched = Replace-Once $patched $needle $replacement 'support list'

$needle = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs')) {
'@
$replacement = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs')) {
'@
$patched = Replace-Once $patched $needle $replacement 'restore list'

$needle = @'
node scripts/r26-stall-boundary-fix.cjs
Assert-Exit 'R26 boundary trace patch'
'@
$replacement = @'
node scripts/r26-stall-boundary-fix.cjs
Assert-Exit 'R26 boundary trace patch'
node --check scripts/r27-focus-stall-retention-fix.cjs
Assert-Exit 'R27 focus/stall retention syntax'
node scripts/r27-focus-stall-retention-fix.cjs
Assert-Exit 'R27 focus/stall retention patch'
'@
$patched = Replace-Once $patched $needle $replacement 'apply R27'

$needle = @'
Write-Host 'R26_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest inactiveGuard=1 cadenceLazy=1 presenter=direct-webgpu trace=ring256-on-demand'
'@
$replacement = @'
if ($bridge -notmatch 'LILAC_R27_FOCUS_STALL_RETENTION' -or $bridge -notmatch 'r27MainAnomalies' -or $bridge -notmatch 'r27MainFocusEvents' -or $bridge -notmatch 'r27DispatchGapMs') { throw 'R27 main retention trace missing' }
if ($preload -notmatch 'LILAC_R27_FOCUS_STALL_RETENTION' -or $preload -notmatch 'r27RendererAnomalies' -or $preload -notmatch 'r27WorstReceiverGap' -or $preload -notmatch 'visibilitychange') { throw 'R27 renderer retention trace missing' }
Write-Host 'R27_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest presenter=direct-webgpu r26=preserved anomaly64=1 focus=main+renderer visibility=renderer'
'@
$patched = Replace-Once $patched $needle $replacement 'source gate'

$needle = @'
if ($shipBridge -notmatch 'LILAC_R26_STALL_BOUNDARY_TRACE' -or $shipBridge -notmatch 'r26BoundaryTrace') { throw 'packaged R26 main trace missing' }
'@
$replacement = @'
if ($shipBridge -notmatch 'LILAC_R26_STALL_BOUNDARY_TRACE' -or $shipBridge -notmatch 'r26BoundaryTrace') { throw 'packaged R26 main trace missing' }
if ($shipBridge -notmatch 'LILAC_R27_FOCUS_STALL_RETENTION' -or $shipBridge -notmatch 'r27MainAnomalies' -or $shipBridge -notmatch 'r27FocusStallRetention') { throw 'packaged R27 main retention missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'packaged bridge gate'

$needle = @'
if ($shipPreload -notmatch 'r26SnapshotRendererTrace' -or $shipPreload -notmatch 'r26TransportMs' -or $shipPreload -notmatch 'libmpv-shared:r26-trace-request') { throw 'packaged R26 renderer trace missing' }
'@
$replacement = @'
if ($shipPreload -notmatch 'r26SnapshotRendererTrace' -or $shipPreload -notmatch 'r26TransportMs' -or $shipPreload -notmatch 'libmpv-shared:r26-trace-request') { throw 'packaged R26 renderer trace missing' }
if ($shipPreload -notmatch 'r27RendererAnomalies' -or $shipPreload -notmatch 'r27RendererFocusEvents' -or $shipPreload -notmatch 'r27WorstReceiverGap') { throw 'packaged R27 renderer retention missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'packaged preload gate'

$needle = @'
  r26BoundaryTrace = 'ring256-on-demand-main-dispatch-renderer-entry-getVideoFrame-gpu-copy-present-release'
  r23WindowRepairPreserved = $true
'@
$replacement = @'
  r26BoundaryTrace = 'ring256-on-demand-main-dispatch-renderer-entry-getVideoFrame-gpu-copy-present-release'
  r27FocusStallRetention = 'anomaly64-threshold60-main+renderer-focus-visibility'
  r23WindowRepairPreserved = $true
'@
$patched = Replace-Once $patched $needle $replacement 'manifest field'

$patched = Replace-Once $patched '"R26_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R27_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'hash env'
$patched = Replace-Once $patched '"R26_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R27_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'size env'
$patched = Replace-Once $patched 'Write-Host "R26_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest inactiveGuard=1 cadenceLazy=1 trace=ring256-on-demand"' 'Write-Host "R27_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest trace=ring256-on-demand anomaly64=1 focus=main+renderer"' 'build marker'

$tempScript = Join-Path $env:RUNNER_TEMP 'r27-generated-build.ps1'
Set-Content $tempScript $patched -Encoding utf8
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

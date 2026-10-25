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
  'scripts/r25-directcomposition-fix.cjs'
)) {
'@
$patched = Replace-Once $patched $needle $replacement 'support list'

$needle = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs')) {
'@
$replacement = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r25-directcomposition-fix.cjs')) {
'@
$patched = Replace-Once $patched $needle $replacement 'restore list'

$needle = @'
node scripts/r24-focus-delivery-fix.cjs
Assert-Exit 'R24 focus/delivery patch'
'@
$replacement = @'
node scripts/r24-focus-delivery-fix.cjs
Assert-Exit 'R24 focus/delivery patch'
node scripts/r25-directcomposition-fix.cjs
Assert-Exit 'R25 DirectComposition patch'
'@
$patched = Replace-Once $patched $needle $replacement 'apply R25'

$needle = @'
Write-Host 'R24_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest inactiveGuard=1 cadenceLazy=1 presenter=direct-webgpu'
'@
$replacement = @'
if ($main -notmatch 'LILAC_R25_DISABLE_DIRECT_COMPOSITION' -or $main -notmatch 'disable-direct-composition') { throw 'R25 DirectComposition bypass missing' }
Write-Host 'R25_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest inactiveGuard=1 directComposition=disabled cadenceLazy=1 presenter=direct-webgpu'
'@
$patched = Replace-Once $patched $needle $replacement 'source gate'

$needle = @'
if ($shipBridge -notmatch 'LILAC_R24_LATEST_FRAME_MAILBOX' -or $shipBridge -notmatch 'deliveryCoalescedFrames') { throw 'packaged mailbox missing' }
'@
$replacement = @'
if ($shipMain -notmatch 'LILAC_R25_DISABLE_DIRECT_COMPOSITION' -or $shipMain -notmatch 'disable-direct-composition') { throw 'packaged R25 DirectComposition bypass missing' }
if ($shipBridge -notmatch 'LILAC_R24_LATEST_FRAME_MAILBOX' -or $shipBridge -notmatch 'deliveryCoalescedFrames') { throw 'packaged mailbox missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'packaged gate'

$needle = @'
  inactiveCompositorGuard = $true
  cadenceHotpath = 'record-only-snapshot-4hz'
'@
$replacement = @'
  inactiveCompositorGuard = $true
  directCompositionDisabled = $true
  cadenceHotpath = 'record-only-snapshot-4hz'
'@
$patched = Replace-Once $patched $needle $replacement 'manifest field'

$patched = Replace-Once $patched '"R24_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R25_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'hash env'
$patched = Replace-Once $patched '"R24_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R25_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'size env'
$patched = Replace-Once $patched 'Write-Host "R24_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest inactiveGuard=1 cadenceLazy=1"' 'Write-Host "R25_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest inactiveGuard=1 directComposition=disabled cadenceLazy=1"' 'build marker'

$tempScript = Join-Path $env:RUNNER_TEMP 'r25-generated-build.ps1'
Set-Content $tempScript $patched -Encoding utf8
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ErrorActionPreference = 'Stop'

$base = Get-Content 'scripts/r24-performance-build.ps1' -Raw
$patched = $base

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

$patched = Replace-Once $patched `
"  'scripts/r24-focus-delivery-fix.cjs'`n)) {" `
"  'scripts/r24-focus-delivery-fix.cjs',`n  'scripts/r25-directcomposition-fix.cjs'`n)) {" 'support list'

$patched = Replace-Once $patched `
"foreach (`$name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs')) {" `
"foreach (`$name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r25-directcomposition-fix.cjs')) {" 'restore list'

$patched = Replace-Once $patched `
"node scripts/r24-focus-delivery-fix.cjs`nAssert-Exit 'R24 focus/delivery patch'" `
"node scripts/r24-focus-delivery-fix.cjs`nAssert-Exit 'R24 focus/delivery patch'`nnode scripts/r25-directcomposition-fix.cjs`nAssert-Exit 'R25 DirectComposition patch'" 'apply R25'

$patched = Replace-Once $patched `
"if (`$main -notmatch 'LILAC_R24_INACTIVE_COMPOSITOR_GUARD' -or `$main -notmatch 'disable-backgrounding-occluded-windows' -or `$main -notmatch 'CalculateNativeWinOcclusion') { throw 'R24 inactive compositor guard missing' }" `
"if (`$main -notmatch 'LILAC_R24_INACTIVE_COMPOSITOR_GUARD' -or `$main -notmatch 'disable-backgrounding-occluded-windows' -or `$main -notmatch 'CalculateNativeWinOcclusion') { throw 'R24 inactive compositor guard missing' }`nif (`$main -notmatch 'LILAC_R25_DISABLE_DIRECT_COMPOSITION' -or `$main -notmatch \"appendSwitch\\('disable-direct-composition'\\)\") { throw 'R25 DirectComposition bypass missing' }" 'source gate'

$patched = Replace-Once $patched `
"Write-Host 'R24_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest inactiveGuard=1 cadenceLazy=1 presenter=direct-webgpu'" `
"Write-Host 'R25_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest inactiveGuard=1 directComposition=disabled cadenceLazy=1 presenter=direct-webgpu'" 'source marker'

$patched = Replace-Once $patched `
"if (`$shipMain -notmatch 'LILAC_R24_INACTIVE_COMPOSITOR_GUARD' -or `$shipMain -notmatch 'CalculateNativeWinOcclusion') { throw 'packaged inactive guard missing' }" `
"if (`$shipMain -notmatch 'LILAC_R24_INACTIVE_COMPOSITOR_GUARD' -or `$shipMain -notmatch 'CalculateNativeWinOcclusion') { throw 'packaged inactive guard missing' }`nif (`$shipMain -notmatch 'LILAC_R25_DISABLE_DIRECT_COMPOSITION' -or `$shipMain -notmatch 'disable-direct-composition') { throw 'packaged R25 DirectComposition bypass missing' }" 'packaged gate'

$patched = Replace-Once $patched `
"  inactiveCompositorGuard = `$true`n  cadenceHotpath = 'record-only-snapshot-4hz'" `
"  inactiveCompositorGuard = `$true`n  directCompositionDisabled = `$true`n  cadenceHotpath = 'record-only-snapshot-4hz'" 'manifest field'

$patched = Replace-Once $patched `
'"R24_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' `
'"R25_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'hash env'
$patched = Replace-Once $patched `
'"R24_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' `
'"R25_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'size env'
$patched = Replace-Once $patched `
'Write-Host "R24_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest inactiveGuard=1 cadenceLazy=1"' `
'Write-Host "R25_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest inactiveGuard=1 directComposition=disabled cadenceLazy=1"' 'build marker'

$tempScript = Join-Path $env:RUNNER_TEMP 'r25-generated-build.ps1'
Set-Content $tempScript $patched -Encoding utf8
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

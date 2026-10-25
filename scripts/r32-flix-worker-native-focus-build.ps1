$ErrorActionPreference = 'Stop'

# eab226b is the fully reviewed R32 build core with the presenter-smoke callback
# fix in its history and BOM-free package/manifest writes. Keep that exact core
# and change only the producer qualification to match R32's 250 ms native watchdog.
$baseCommit = 'eab226b788528253da08225d7ca2de8935e1bf39'
$core = (& git show "$baseCommit`:scripts/r32-flix-worker-native-focus-build.ps1") -join "`n"
if ($LASTEXITCODE -ne 0 -or -not $core) { throw 'R32 fixed build core could not be loaded' }
$core += "`n"

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

$core = Replace-Once $core `
  "  'r32-native-presenter-smoke.cjs'" `
  ("  'r32-native-presenter-smoke.cjs'," + "`n" + "  'r32-native-producer-watchdog-smoke.cjs'") `
  'R32 watchdog smoke support entry'

$core = Replace-Once $core `
  '& node_modules/.bin/electron.cmd scripts/smoke-libmpv-r3e-native-producer.cjs' `
  '& node_modules/.bin/electron.cmd scripts/r32-native-producer-watchdog-smoke.cjs' `
  'R32 watchdog smoke invocation'

$core = Replace-Once $core `
  "Assert-Exit 'R32 native producer callback smoke'" `
  "Assert-Exit 'R32 native producer 250ms watchdog smoke'" `
  'R32 watchdog smoke assertion label'

$tempScript = Join-Path $env:RUNNER_TEMP 'r32-watchdog-qualified-build.ps1'
[System.IO.File]::WriteAllText($tempScript, $core, (New-Object System.Text.UTF8Encoding($false)))
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

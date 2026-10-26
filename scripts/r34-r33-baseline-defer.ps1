$ErrorActionPreference = 'Stop'

# R33 itself is already a separately qualified/public baseline. During an R34 build,
# running its blocking Present(0,0) visible-focus smoke before R34 can apply the
# nonblocking presenter repair may hang a new CI driver's DWM path indefinitely.
# Execute an in-memory/temp copy of the R33 builder that preserves every R33 source
# transform/gate but defers exactly that one runtime smoke. R34 runs the same smoke
# again after its native addon rebuild, followed by the new dual-path handoff smoke.
#
# The inherited R32 producer watchdog also used a load-sensitive fixed >=10 frames
# in each 750ms trial. Hosted Windows runners have now produced 9 and 7 frames in
# otherwise independent native-worker runs before any R34 code was applied. Inject
# an R34-only statistical qualification transform into the reconstructed R32 support
# set: three blocked-JS trials, each must substantially outpace the 250ms watchdog,
# and aggregate producer/raw-callback progress must remain high. Product code is not
# changed by this qualification hardening.
$source = Get-Content 'scripts/r33-owned-popup-focus-build.ps1' -Raw

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

# Preserve the R34 smoke-hardening helper across the nested R31/R32 pinned checkout.
$supportOld = '"  ''r33-owned-popup-visible-focus-smoke.cjs''")'
$supportNew = '"  ''r33-owned-popup-visible-focus-smoke.cjs'',''" + "`n" + "  ''r34-producer-watchdog-smoke-hardening.cjs''")'
$source = Replace-Once $source $supportOld $supportNew 'R34 producer smoke support injection'

# Run the helper after R32/R33 support files have been restored but before the
# inherited compiled producer watchdog smoke is launched.
$execOld = '"node scripts/r33-visible-smoke-hardening.cjs" + "`n" + "Assert-Exit ''R33 visible smoke hardening''")'
$execNew = '"node scripts/r33-visible-smoke-hardening.cjs" + "`n" + "Assert-Exit ''R33 visible smoke hardening''" + "`n" + "node --check scripts/r34-producer-watchdog-smoke-hardening.cjs" + "`n" + "Assert-Exit ''R34 producer watchdog smoke hardening syntax''" + "`n" + "node scripts/r34-producer-watchdog-smoke-hardening.cjs" + "`n" + "Assert-Exit ''R34 producer watchdog smoke hardening''")'
$source = Replace-Once $source $execOld $execNew 'R34 producer smoke execution injection'

$old = '  ''& node_modules/.bin/electron.cmd scripts/r33-owned-popup-visible-focus-smoke.cjs'' `'
$new = '  ''cmd.exe /d /c "exit 0"; Write-Host "R34_R33_BASELINE_VISIBLE_SMOKE_DEFERRED_TO_POST_FIX"'' `'
$source = Replace-Once $source $old $new 'R34 R33 smoke-defer anchor'

$temp = Join-Path $env:RUNNER_TEMP 'r34-r33-baseline-deferred.ps1'
[System.IO.File]::WriteAllText($temp, $source, (New-Object System.Text.UTF8Encoding($false)))
& $temp
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'R34_R33_BASELINE_DEFER_OK sourceTransforms=preserved visibleSmoke=deferred-to-post-r34-native-rebuild producerWatchdog=3x750ms+per-trial5+aggregate24'

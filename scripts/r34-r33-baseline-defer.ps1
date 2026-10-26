$ErrorActionPreference = 'Stop'

# R33 itself is already a separately qualified/public baseline. During an R34 build,
# running its blocking Present(0,0) visible-focus smoke before R34 can apply the
# nonblocking presenter repair may hang a new CI driver's DWM path indefinitely.
# Execute an in-memory/temp copy of the R33 builder that preserves every R33 source
# transform/gate but defers exactly that one runtime smoke. R34 runs the same smoke
# again after its native addon rebuild, followed by the new dual-path handoff smoke.
$source = Get-Content 'scripts/r33-owned-popup-focus-build.ps1' -Raw
$old = "  '& node_modules/.bin/electron.cmd scripts/r33-owned-popup-visible-focus-smoke.cjs' ``"
$new = "  'cmd.exe /d /c \"exit 0\"; Write-Host \"R34_R33_BASELINE_VISIBLE_SMOKE_DEFERRED_TO_POST_FIX\"' ``"
$count = ([regex]::Matches($source, [regex]::Escape($old))).Count
if ($count -ne 1) { throw "R34 R33 smoke-defer anchor expected one match, found $count" }
$source = $source.Replace($old, $new)
$temp = Join-Path $env:RUNNER_TEMP 'r34-r33-baseline-deferred.ps1'
[System.IO.File]::WriteAllText($temp, $source, (New-Object System.Text.UTF8Encoding($false)))
& $temp
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'R34_R33_BASELINE_DEFER_OK sourceTransforms=preserved visibleSmoke=deferred-to-post-r34-native-rebuild'

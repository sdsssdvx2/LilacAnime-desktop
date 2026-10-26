$ErrorActionPreference = 'Stop'

$source = Get-Content 'scripts/r34-focus-handoff-stall-build.ps1' -Raw

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

# Keep all post-R34 proof helpers available while the build temporarily checks out
# the pinned R33 baseline and reconstructs R34 from source.
$source = Replace-Once $source `
  "  'r34-focus-handoff-native-smoke.cjs'" `
  ("  'r34-focus-handoff-native-smoke.cjs'," + "`n" +
   "  'r34-hosted-visual-proof.cjs'," + "`n" +
   "  'r34-hosted-refocus-hardening.cjs'," + "`n" +
   "  'r34-run-smoke-with-timeout.cjs'," + "`n" +
   "  'r35-paused-handoff-ui-recovery.cjs'," + "`n" +
   "  'r35-paused-handoff-redraw-smoke.cjs'," + "`n" +
   "  'r35-run-smoke-with-timeout.cjs'," + "`n" +
   "  'r35-cache-worker-heartbeat-smoke.cjs'") `
  'R35 support stash'

# Reapply the final hosted R34 proof transforms, then R35. The product tree is
# modified only after reconstruction, never before the pinned checkout.
$source = Replace-Once $source `
  "Assert-Exit 'R34 smoke correctness hardening'" `
  ("Assert-Exit 'R34 smoke correctness hardening'" + "`n" +
   "node --check scripts/r34-hosted-visual-proof.cjs" + "`n" +
   "Assert-Exit 'R34 hosted visual proof syntax'" + "`n" +
   "node scripts/r34-hosted-visual-proof.cjs" + "`n" +
   "Assert-Exit 'R34 hosted visual proof transform'" + "`n" +
   "node --check scripts/r34-hosted-refocus-hardening.cjs" + "`n" +
   "Assert-Exit 'R34 hosted refocus hardening syntax'" + "`n" +
   "node scripts/r34-hosted-refocus-hardening.cjs" + "`n" +
   "Assert-Exit 'R34 hosted refocus hardening transform'" + "`n" +
   "node --check scripts/r35-paused-handoff-ui-recovery.cjs" + "`n" +
   "Assert-Exit 'R35 transform syntax'" + "`n" +
   "node scripts/r35-paused-handoff-ui-recovery.cjs" + "`n" +
   "Assert-Exit 'R35 product transform'") `
  'R35 transform execution'

# R35 intentionally changes only the ASS override level from force to scale.
# Update R34's qualification text/gates to expect the new value.
$source = $source.Replace("'sub-ass-override', 'force'", "'sub-ass-override', 'scale'")
$source = $source.Replace('assOverride=force', 'assOverride=scale')
$source = $source.Replace('ass-override-force', 'ass-override-scale')

$source = Replace-Once $source `
  "Write-Host 'R34_SOURCE_GATES_OK handoff=native+chromium-until-successful-send+allReferencesReleased subtitle=main-single-owner assOverride=scale cacheWrites=worker-coalesced mainCacheReads=async-or-memoized r27NativeGapReset=1 smokeProof=explicit-marker+nonzero-failure+nested-electron-removed'" `
  ("Write-Host 'R34_SOURCE_GATES_OK handoff=native+chromium-until-successful-send+allReferencesReleased subtitle=main-single-owner assOverride=scale cacheWrites=worker-coalesced mainCacheReads=async-or-memoized r27NativeGapReset=1 smokeProof=explicit-marker+nonzero-failure+nested-electron-removed'" + "`n" +
   "if(-not `$bridge.Contains('LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY') -or -not `$bridge.Contains('r35-focus-handoff-redraw')){throw 'R35 paused handoff source gate failed'}" + "`n" +
   "if(-not `$entry.Contains('LILAC_R35_ASS_PLACEMENT_RECOVERY')){throw 'R35 subtitle placement source gate failed'}" + "`n" +
   "Write-Host 'R35_SOURCE_GATES_OK handoff=mirror-first+paused-redraw subtitle=main-single-owner+ass-scale r33NativeOnly=preserved'") `
  'R35 source gates'

# External process-tree supervision from the final R34 qualifier remains in force.
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r32-native-producer-watchdog-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r32-native-producer-watchdog-smoke.cjs r32-producer-watchdog 120000' `
  'R35 producer smoke supervision'
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r33-owned-popup-visible-focus-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r33-postfix-dwm-focus 120000' `
  'R35 R33 visual smoke supervision'
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r34-focus-handoff-native-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r34-focus-handoff-native-smoke.cjs r34-dual-handoff 120000' `
  'R35 R34 handoff smoke supervision'

$source = Replace-Once $source `
  "Assert-Exit 'R34 dual-path focus handoff smoke'" `
  ("Assert-Exit 'R34 dual-path focus handoff smoke'" + "`n" +
   "node scripts/r35-run-smoke-with-timeout.cjs scripts/r35-paused-handoff-redraw-smoke.cjs r35-paused-redraw 120000" + "`n" +
   "Assert-Exit 'R35 paused focus handoff redraw smoke'" + "`n" +
   "node scripts/r35-cache-worker-heartbeat-smoke.cjs" + "`n" +
   "Assert-Exit 'R35 cache worker heartbeat smoke'" + "`n" +
   "Write-Host 'R35_RUNTIME_SMOKES_OK r33Visible=1 r34ActiveHandoff=1 r35PausedHandoff=1 cacheHeartbeat=1'") `
  'R35 runtime smokes'

# Preserve the final R34 hosted visual manifest proof and add R35-specific evidence.
$source = Replace-Once $source `
  "  r34RuntimeSmokes='producer-watchdog+r33-visible-dwm+r34-dual-handoff-explicit-markers'" `
  ("  r34HostedVisualProof='focused-capturePage-blue+native-visible-HWND+exact-S_OK+900ms-autonomous+mirror-sampleFrame-red+desktopCapturer-optional'" + "`n" +
   "  r34RuntimeSmokes='producer-watchdog+r33-hosted-visual-proof+r34-dual-handoff-red-source+explicit-markers'" + "`n" +
   "  r35PausedHandoff='mirror-first+sub-visibility-redraw+successful-send+allReferencesReleased-then-hide'" + "`n" +
   "  r35SubtitleOwnership='main-only+focus-native-off+unfocused-native-on+ass-override-scale'" + "`n" +
   "  r35RuntimeSmokes='r33-hosted-visual+r34-active-handoff+r35-paused-redraw+r35-cache-heartbeat'") `
  'R35 manifest fields'

# Verify the R35 markers survived into app.asar before installer creation finishes.
$source = Replace-Once $source `
  "`$worker='dist/win-unpacked/resources/app.asar.unpacked/electron/cache-write-worker.cjs';if(-not(Test-Path `$worker)){throw 'packaged R34 cache worker missing'}" `
  ("if(`$shipBridge-notmatch 'LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY' -or `$shipBridge-notmatch 'r35-focus-handoff-redraw'){throw 'packaged R35 paused handoff recovery missing'}" + "`n" +
   "if(`$shipEntry-notmatch 'LILAC_R35_ASS_PLACEMENT_RECOVERY'){throw 'packaged R35 subtitle placement recovery missing'}" + "`n" +
   "`$worker='dist/win-unpacked/resources/app.asar.unpacked/electron/cache-write-worker.cjs';if(-not(Test-Path `$worker)){throw 'packaged R34 cache worker missing'}") `
  'R35 packaged marker gates'

$temp = Join-Path $env:RUNNER_TEMP 'r35-qualified-build-generated.ps1'
[System.IO.File]::WriteAllText($temp,$source,(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'R35_QUALIFIED_BUILD_WRAPPER_OK base=R34 hostedVisual=preserved pausedHandoff=redraw+ack assOverride=scale cacheHeartbeat=stress'
& $temp
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

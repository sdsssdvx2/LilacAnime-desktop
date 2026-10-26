$ErrorActionPreference = 'Stop'

$source = Get-Content 'scripts/r34-focus-handoff-stall-build.ps1' -Raw

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

# Preserve all R34/R35/R36 proof helpers while the build reconstructs the pinned
# R33 product baseline. R36 stays a narrow post-R35 transform.
$source = Replace-Once $source `
  "  'r34-focus-handoff-native-smoke.cjs'" `
  ("  'r34-focus-handoff-native-smoke.cjs'," + "`n" +
   "  'r34-hosted-visual-proof.cjs'," + "`n" +
   "  'r34-hosted-refocus-hardening.cjs'," + "`n" +
   "  'r34-run-smoke-with-timeout.cjs'," + "`n" +
   "  'r35-hosted-native-startup-hardening.cjs'," + "`n" +
   "  'r35-paused-handoff-ui-recovery.cjs'," + "`n" +
   "  'r35-paused-handoff-redraw-smoke.cjs'," + "`n" +
   "  'r35-paused-no-subtitle-handoff-smoke.cjs'," + "`n" +
   "  'r35-run-smoke-with-timeout.cjs'," + "`n" +
   "  'r35-cache-worker-heartbeat-smoke.cjs'," + "`n" +
   "  'r36-handoff-ack-subtitle-stability.cjs'," + "`n" +
   "  'r36-handoff-ack-order-smoke.cjs'," + "`n" +
   "  'r36-subtitle-determinism-smoke.cjs'") `
  'R36 support stash'

# Reapply the final hosted visual transforms, then R35, then R36. R36 runs after
# R35 so its deterministic subtitle mode and bidirectional ack bookkeeping are the
# final shipped semantics.
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
   "node --check scripts/r35-hosted-native-startup-hardening.cjs" + "`n" +
   "Assert-Exit 'R35 hosted startup hardening syntax'" + "`n" +
   "node scripts/r35-hosted-native-startup-hardening.cjs" + "`n" +
   "Assert-Exit 'R35 hosted startup hardening transform'" + "`n" +
   "node --check scripts/r35-paused-handoff-ui-recovery.cjs" + "`n" +
   "Assert-Exit 'R35 transform syntax'" + "`n" +
   "node scripts/r35-paused-handoff-ui-recovery.cjs" + "`n" +
   "Assert-Exit 'R35 product transform'" + "`n" +
   "node --check scripts/r36-handoff-ack-subtitle-stability.cjs" + "`n" +
   "Assert-Exit 'R36 transform syntax'" + "`n" +
   "node scripts/r36-handoff-ack-subtitle-stability.cjs" + "`n" +
   "Assert-Exit 'R36 product transform'") `
  'R36 transform execution'

# Final shipped native fallback uses strip, not R34 force or R35 scale.
$source = $source.Replace("'sub-ass-override', 'force'", "'sub-ass-override', 'strip'")
$source = $source.Replace('assOverride=force', 'assOverride=strip')
$source = $source.Replace('ass-override-force', 'ass-override-strip')

# Keep the app source available to final source gates.
$source = Replace-Once $source `
  "`$entry=Get-Content 'src/libmpv-shared-entry.js' -Raw" `
  ("`$entry=Get-Content 'src/libmpv-shared-entry.js' -Raw" + "`n" + "`$appSource=Get-Content 'src/app.js' -Raw") `
  'R36 app source gate input'

$source = Replace-Once $source `
  "Write-Host 'R34_SOURCE_GATES_OK handoff=native+chromium-until-successful-send+allReferencesReleased subtitle=main-single-owner assOverride=strip cacheWrites=worker-coalesced mainCacheReads=async-or-memoized r27NativeGapReset=1 smokeProof=explicit-marker+nonzero-failure+nested-electron-removed'" `
  ("Write-Host 'R34_SOURCE_GATES_OK handoff=native+chromium-until-successful-send+allReferencesReleased subtitle=main-single-owner assOverride=strip cacheWrites=worker-coalesced mainCacheReads=async-or-memoized r27NativeGapReset=1 smokeProof=explicit-marker+nonzero-failure+nested-electron-removed'" + "`n" +
   "if(-not `$bridge.Contains('LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY') -or -not `$bridge.Contains('r35-focus-handoff-redraw')){throw 'R35 paused handoff source gate failed'}" + "`n" +
   "if(-not `$entry.Contains('LILAC_R35_ASS_PLACEMENT_RECOVERY')){throw 'R35 subtitle source marker gate failed'}" + "`n" +
   "if(-not `$bridge.Contains('LILAC_R36_HANDOFF_ACK_ORDER') -or -not `$bridge.Contains('r36FocusHandoffReleasedFrames') -or -not `$bridge.Contains('R36_HANDOFF_FAIL_OPEN_MS = 1500')){throw 'R36 bidirectional handoff source gate failed'}" + "`n" +
   "if(-not `$entry.Contains('LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC') -or -not `$entry.Contains(\"'sub-ass-override', 'strip'\")){throw 'R36 deterministic subtitle source gate failed'}" + "`n" +
   "if(-not `$appSource.Contains('LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE') -or -not `$appSource.Contains('(options.path||options.assPath)')){throw 'R36 plain native subtitle source gate failed'}" + "`n" +
   "Write-Host 'R35_SOURCE_GATES_OK handoff=mirror-first+paused-redraw subtitle=main-single-owner+post-r36-strip r33NativeOnly=preserved'" + "`n" +
   "Write-Host 'R36_SOURCE_GATES_OK ack=release-before-send+send-before-release failOpen=1500ms subtitle=plain-first+ass-strip supplyGap=cached-state-ring r33NativeOnly=preserved'") `
  'R36 source gates'

# Retain the final external smoke supervision used by R35.
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r32-native-producer-watchdog-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r32-native-producer-watchdog-smoke.cjs r32-producer-watchdog 120000' `
  'R36 producer smoke supervision'
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r33-owned-popup-visible-focus-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r33-postfix-dwm-focus 120000' `
  'R36 R33 visual smoke supervision'
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r34-focus-handoff-native-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r34-focus-handoff-native-smoke.cjs r34-dual-handoff 120000' `
  'R36 R34 handoff smoke supervision'

$source = Replace-Once $source `
  "Assert-Exit 'R34 dual-path focus handoff smoke'" `
  ("Assert-Exit 'R34 dual-path focus handoff smoke'" + "`n" +
   "node scripts/r35-run-smoke-with-timeout.cjs scripts/r35-paused-handoff-redraw-smoke.cjs r35-paused-redraw 120000" + "`n" +
   "Assert-Exit 'R35 paused focus handoff redraw smoke'" + "`n" +
   "node scripts/r35-run-smoke-with-timeout.cjs scripts/r35-paused-no-subtitle-handoff-smoke.cjs r35-paused-no-subtitle 120000" + "`n" +
   "Assert-Exit 'R35 paused no-subtitle focus handoff smoke'" + "`n" +
   "node scripts/r35-cache-worker-heartbeat-smoke.cjs" + "`n" +
   "Assert-Exit 'R35 cache worker heartbeat smoke'" + "`n" +
   "node scripts/r36-handoff-ack-order-smoke.cjs" + "`n" +
   "Assert-Exit 'R36 handoff ack order smoke'" + "`n" +
   "node scripts/r36-subtitle-determinism-smoke.cjs" + "`n" +
   "Assert-Exit 'R36 subtitle determinism smoke'" + "`n" +
   "for(`$r36Cycle=1;`$r36Cycle-le 3;`$r36Cycle++){node scripts/r35-run-smoke-with-timeout.cjs scripts/r34-focus-handoff-native-smoke.cjs (\"r36-repeat-active-handoff-`$r36Cycle\") 120000;Assert-Exit \"R36 repeat active handoff `$r36Cycle\"}" + "`n" +
   "Write-Host 'R35_RUNTIME_SMOKES_OK r33Visible=1 r34ActiveHandoff=1 r35PausedSubtitle=1 r35PausedNoSubtitle=1 cacheHeartbeat=1'" + "`n" +
   "Write-Host 'R36_RUNTIME_SMOKES_OK ackOrder=200-cycles subtitleDeterminism=source+bundle activeHandoffRepeat=3 inheritedR33Visible=1 inheritedPaused=2'") `
  'R36 runtime smokes'

# Final manifest proof: preserve R34/R35 evidence and add the exact R36 semantics.
$source = Replace-Once $source `
  "  r34RuntimeSmokes='producer-watchdog+r33-visible-dwm+r34-dual-handoff-explicit-markers'" `
  ("  r34HostedVisualProof='focused-capturePage-blue+native-visible-HWND+exact-S_OK+900ms-autonomous+mirror-sampleFrame-red+desktopCapturer-optional'" + "`n" +
   "  r34RuntimeSmokes='producer-watchdog+r33-hosted-visual-proof+r34-dual-handoff-red-source+explicit-markers'" + "`n" +
   "  r35PausedHandoff='mirror-first+sub-visibility-redraw+successful-send+allReferencesReleased-then-hide'" + "`n" +
   "  r35SubtitleOwnership='main-only+focus-native-off+unfocused-native-on+post-r36-ass-override-strip'" + "`n" +
   "  r35RuntimeSmokes='r33-hosted-visual+r34-active-handoff+r35-paused-redraw+r35-paused-no-subtitle+r35-cache-heartbeat'" + "`n" +
   "  r36HandoffAck='bidirectional-send-release-order+1500ms-focused-fail-open'" + "`n" +
   "  r36SubtitleFallback='plain-dialogue-source-first+ass-strip+r32-style-map'" + "`n" +
   "  r36SupplyGapDiagnostics='cached-playback-state+focus-handoff-context+no-extra-native-poll'" + "`n" +
   "  r36RuntimeSmokes='ack-order-200-cycles+subtitle-determinism+active-handoff-repeat3+inherited-r33-r35'") `
  'R36 manifest fields'

# Verify final shipped source inside app.asar, including the app.js plain-path rule.
$source = Replace-Once $source `
  "`$shipEntry=Get-Content (Join-Path `$asarCheck 'src/libmpv-shared-entry.js') -Raw" `
  ("`$shipEntry=Get-Content (Join-Path `$asarCheck 'src/libmpv-shared-entry.js') -Raw" + "`n" + "`$shipApp=Get-Content (Join-Path `$asarCheck 'src/app.js') -Raw") `
  'R36 packaged app source input'
$source = Replace-Once $source `
  "`$worker='dist/win-unpacked/resources/app.asar.unpacked/electron/cache-write-worker.cjs';if(-not(Test-Path `$worker)){throw 'packaged R34 cache worker missing'}" `
  ("if(`$shipBridge-notmatch 'LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY' -or `$shipBridge-notmatch 'r35-focus-handoff-redraw'){throw 'packaged R35 paused handoff recovery missing'}" + "`n" +
   "if(`$shipEntry-notmatch 'LILAC_R35_ASS_PLACEMENT_RECOVERY'){throw 'packaged R35 subtitle marker missing'}" + "`n" +
   "if(`$shipBridge-notmatch 'LILAC_R36_HANDOFF_ACK_ORDER' -or `$shipBridge-notmatch 'r36FocusHandoffReleasedFrames' -or `$shipBridge-notmatch 'R36_HANDOFF_FAIL_OPEN_MS = 1500'){throw 'packaged R36 handoff hardening missing'}" + "`n" +
   "if(`$shipEntry-notmatch 'LILAC_R36_NATIVE_SUBTITLE_DETERMINISTIC' -or `$shipEntry-notmatch \"'sub-ass-override', 'strip'\"){throw 'packaged R36 subtitle determinism missing'}" + "`n" +
   "if(`$shipApp-notmatch 'LILAC_R36_NATIVE_SUBTITLE_PLAIN_SOURCE'){throw 'packaged R36 plain subtitle source preference missing'}" + "`n" +
   "`$worker='dist/win-unpacked/resources/app.asar.unpacked/electron/cache-write-worker.cjs';if(-not(Test-Path `$worker)){throw 'packaged R34 cache worker missing'}") `
  'R36 packaged marker gates'

$temp = Join-Path $env:RUNNER_TEMP 'r36-qualified-build-generated.ps1'
[System.IO.File]::WriteAllText($temp,$source,(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'R36_QUALIFIED_BUILD_WRAPPER_OK base=R34+r35 ack=bidirectional+fail-open subtitle=plain-first+strip supplyGap=low-overhead repeatHandoff=3'
& $temp
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

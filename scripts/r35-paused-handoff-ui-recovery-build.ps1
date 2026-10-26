$ErrorActionPreference = 'Stop'

# R35 reuses the fully-qualified R34 reconstruction, native rebuild, DWM proof and
# packaging pipeline, but patches a temporary build-script copy. The tracked tree
# stays clean so the nested pinned R33/R34 reconstruction remains reproducible.
$source = Get-Content 'scripts/r34-focus-handoff-stall-build.ps1' -Raw

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

# Stash every R34 hosted-proof helper plus the R35 transforms/smokes across the
# pinned baseline checkout performed inside r34-r33-baseline-defer.ps1.
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

# Preserve the R34 hosted runner proof that caught native presenter visibility and
# exact S_OK presentation, then apply R35 only after all R34 hardening transforms.
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
   "Assert-Exit 'R35 paused handoff UI recovery transform'") `
  'R35 post-R34 transform execution'

# R35 intentionally de-escalates the destructive ASS force override to mpv's
# default scale level while keeping R34's single-owner visibility architecture.
$source = Replace-Once $source `
  "-or -not `$entry.Contains(\"'sub-ass-override', 'force'\")" `
  "-or -not `$entry.Contains(\"'sub-ass-override', 'scale'\")" `
  'R35 subtitle source gate override level'

$source = Replace-Once $source `
  "Write-Host 'R34_SOURCE_GATES_OK handoff=native+chromium-until-successful-send+allReferencesReleased subtitle=main-single-owner assOverride=force cacheWrites=worker-coalesced mainCacheReads=async-or-memoized r27NativeGapReset=1 smokeProof=explicit-marker+nonzero-failure+nested-electron-removed'" `
  ("if(-not `$bridge.Contains('LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY') -or -not `$bridge.Contains('r35-focus-handoff-redraw') -or -not `$bridge.Contains('r35FocusRedrawArms')){throw 'R35 paused handoff source gate failed'}" + "`n" +
   "if(-not `$entry.Contains('LILAC_R35_ASS_PLACEMENT_RECOVERY') -or `$entry.Contains(\"'sub-ass-override', 'force'\") -or -not `$entry.Contains(\"'sub-ass-override', 'scale'\")){throw 'R35 ASS placement source gate failed'}" + "`n" +
   "Write-Host 'R35_SOURCE_GATES_OK handoff=mirror-first+focus-subtitle-off+paused-redraw subtitle=main-single-owner+ass-scale cacheWrites=worker-coalesced r33NativeOnly=preserved'") `
  'R35 source gates'

# Supervise all Electron/native smokes out of process. The R35 smoke specifically
# proves the user-observed failure mode: paused native-only refocus with no naturally
# advancing frame cannot leave the owned popup covering HTML forever.
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r32-native-producer-watchdog-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r32-native-producer-watchdog-smoke.cjs r32-producer-watchdog 120000' `
  'R35 producer smoke timeout'
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r33-owned-popup-visible-focus-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r33-postfix-dwm-focus 120000' `
  'R35 R33 visible smoke timeout'
$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r34-focus-handoff-native-smoke.cjs' `
  ("node scripts/r34-run-smoke-with-timeout.cjs scripts/r34-focus-handoff-native-smoke.cjs r34-dual-handoff 120000" + "`n" +
   "Assert-Exit 'R34 dual-path focus handoff smoke'" + "`n" +
   "node scripts/r35-run-smoke-with-timeout.cjs scripts/r35-paused-handoff-redraw-smoke.cjs r35-paused-handoff-redraw 120000" + "`n" +
   "Assert-Exit 'R35 paused focus handoff redraw smoke'" + "`n" +
   "node scripts/r35-cache-worker-heartbeat-smoke.cjs" + "`n" +
   "Assert-Exit 'R35 cache worker heartbeat smoke'" + "`n" +
   "Write-Host 'R35_RUNTIME_SMOKES_OK activeHandoff=R34 pausedHandoff=R35 cacheHeartbeat=R35'") `
  'R35 runtime smoke injection'

# The replacement above already supplies the R34 assertion before R35; remove the
# original immediately-following duplicate assertion so failure attribution remains
# unambiguous.
$source = $source.Replace("Assert-Exit 'R34 dual-path focus handoff smoke'`r`nAssert-Exit 'R34 dual-path focus handoff smoke'", "Assert-Exit 'R34 dual-path focus handoff smoke'")
$source = $source.Replace("Assert-Exit 'R34 dual-path focus handoff smoke'`nAssert-Exit 'R34 dual-path focus handoff smoke'", "Assert-Exit 'R34 dual-path focus handoff smoke'")

# Hosted visual proof remains required. Keep historical R33 provenance but report
# the exact R35 qualification in the manifest as well.
$source = Replace-Once $source `
  "  r34RuntimeSmokes='producer-watchdog+r33-visible-dwm+r34-dual-handoff-explicit-markers'" `
  ("  r34HostedVisualProof='focused-capturePage-blue+native-visible-HWND+exact-S_OK+900ms-autonomous+mirror-sampleFrame-red+desktopCapturer-optional'" + "`n" +
   "  r34RuntimeSmokes='producer-watchdog+r33-hosted-visual-proof+r34-dual-handoff-red-source+explicit-markers'" + "`n" +
   "  r35PausedHandoff='mirror-first+sub-visibility-redraw+successful-send+allReferencesReleased-then-hide'" + "`n" +
   "  r35SubtitleOwnership='main-only+focus-native-off+unfocused-native-on+ass-override-scale'" + "`n" +
   "  r35RuntimeSmokes='r33-hosted-visual+r34-active-handoff+r35-paused-redraw+r35-cache-heartbeat'") `
  'R35 manifest qualification fields'
$source = Replace-Once $source `
  "  r34SubtitleOwnership='main-only-focus-authority+html-focused+libmpv-unfocused+ass-override-force'" `
  "  r34SubtitleOwnership='main-only-focus-authority+html-focused+libmpv-unfocused+ass-override-scale'" `
  'R35 manifest subtitle override correction'

# Packaged bytes must contain R35, not merely the build working tree.
$source = Replace-Once $source `
  "if(`$shipEntry-match \"document.hasFocus\\(\\) \\? 'no' : 'yes'\" -or `$shipEntry-notmatch 'LILAC_R34_SUBTITLE_SINGLE_OWNER'){throw 'packaged R34 subtitle regression fix missing'}" `
  ("if(`$shipEntry-match \"document.hasFocus\\(\\) \\? 'no' : 'yes'\" -or `$shipEntry-notmatch 'LILAC_R34_SUBTITLE_SINGLE_OWNER'){throw 'packaged R34 subtitle regression fix missing'}" + "`n" +
   "if(`$shipBridge-notmatch 'LILAC_R35_PAUSED_HANDOFF_UI_RECOVERY' -or `$shipBridge-notmatch 'r35-focus-handoff-redraw'){throw 'packaged R35 paused handoff recovery missing'}" + "`n" +
   "if(`$shipEntry-notmatch 'LILAC_R35_ASS_PLACEMENT_RECOVERY' -or `$shipEntry-match \"'sub-ass-override', 'force'\" -or `$shipEntry-notmatch \"'sub-ass-override', 'scale'\"){throw 'packaged R35 ASS placement recovery missing'}") `
  'R35 packaged source gates'

# Publish R35-named build variables for the workflow re-download verifier.
$source = Replace-Once $source '"R34_ADDON_SHA256=$r34AddonSha"' '"R35_ADDON_SHA256=$r34AddonSha"' 'R35 addon env name'
$source = Replace-Once $source '"R34_INSTALLER_SHA256=$hash"' '"R35_INSTALLER_SHA256=$hash"' 'R35 installer hash env name'
$source = Replace-Once $source '"R34_INSTALLER_SIZE=$size"' '"R35_INSTALLER_SIZE=$size"' 'R35 installer size env name'
$source = Replace-Once $source `
  'Write-Host "R34_BUILD_OK sha256=$hash size=$size addon=$r34AddonSha dll=$dllSha focusHandoff=successful-send+release subtitle=single-owner cacheWrites=worker-coalesced mainCacheReads=async-or-memoized runtimeSmokes=explicit-markers"' `
  'Write-Host "R35_BUILD_OK sha256=$hash size=$size addon=$r34AddonSha dll=$dllSha activeHandoff=R34 pausedHandoff=redraw+send+release subtitle=single-owner+ass-scale cacheWrites=worker+heartbeat runtimeSmokes=R33+R34+R35"' `
  'R35 build success marker'

# Coarse phase markers retained from the bounded R34 qualifier.
$source = Replace-Once $source "& ./scripts/r34-r33-baseline-defer.ps1" ("Write-Host 'R35_PHASE=baseline-start'" + "`n" + "& ./scripts/r34-r33-baseline-defer.ps1" + "`n" + "Write-Host 'R35_PHASE=baseline-complete'") 'R35 baseline phases'
$source = Replace-Once $source "node scripts/r34-transform-source-sanitize.cjs" ("Write-Host 'R35_PHASE=transform-start'" + "`n" + "node scripts/r34-transform-source-sanitize.cjs") 'R35 transform phase'
$source = Replace-Once $source "& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=`$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers" ("Write-Host 'R35_PHASE=native-rebuild-start'" + "`n" + "& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=`$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers" + "`n" + "Write-Host 'R35_PHASE=native-rebuild-complete'") 'R35 native phase'
$source = Replace-Once $source "`$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path" ("Write-Host 'R35_PHASE=runtime-smokes-start'" + "`n" + "`$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path") 'R35 runtime phase'
$source = Replace-Once $source "Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue" ("Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue" + "`n" + "Write-Host 'R35_PHASE=runtime-smokes-complete'") 'R35 runtime complete phase'
$source = Replace-Once $source "Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue" ("Write-Host 'R35_PHASE=final-package-start'" + "`n" + "Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue") 'R35 package phase'
$source = Replace-Once $source "`$installer=Join-Path 'dist' `$env:INSTALLER_NAME" ("Write-Host 'R35_PHASE=final-package-complete'" + "`n" + "`$installer=Join-Path 'dist' `$env:INSTALLER_NAME") 'R35 package complete phase'

$temp = Join-Path $env:RUNNER_TEMP 'r35-paused-handoff-ui-recovery-generated.ps1'
[System.IO.File]::WriteAllText($temp,$source,(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'R35_BUILD_WRAPPER_OK base=qualified-R34 pausedHandoff=subtitle-redraw assOverride=scale cacheHeartbeat=stress hostedVisual=preserved trackedTreeMutation=0'
& $temp
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ErrorActionPreference = 'Stop'

# Do not modify the tracked build script in-place: the nested R33 reconstruction
# performs pinned git checkouts and requires a clean working tree. Instead, patch a
# temporary copy so every post-R34 Electron smoke is supervised by a separate Node
# parent process that can kill a native-blocked child process tree.
$source = Get-Content 'scripts/r34-focus-handoff-stall-build.ps1' -Raw

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

$source = Replace-Once $source `
  "  'r34-focus-handoff-native-smoke.cjs'" `
  ("  'r34-focus-handoff-native-smoke.cjs'," + "`n" + "  'r34-hosted-visual-proof.cjs'," + "`n" + "  'r34-run-smoke-with-timeout.cjs'") `
  'R34 external smoke runner/hosted visual support'

# Apply the hosted-runner proof only after generic correctness hardening. Anchor on
# one stable line instead of a multi-line LF sequence so Windows checkout line
# endings cannot prevent injection.
$source = Replace-Once $source `
  "Assert-Exit 'R34 smoke correctness hardening'" `
  ("Assert-Exit 'R34 smoke correctness hardening'" + "`n" + "node --check scripts/r34-hosted-visual-proof.cjs" + "`n" + "Assert-Exit 'R34 hosted visual proof syntax'" + "`n" + "node scripts/r34-hosted-visual-proof.cjs" + "`n" + "Assert-Exit 'R34 hosted visual proof transform'") `
  'R34 hosted visual proof execution'

# Keep the historical R33 visual field for baseline provenance, but add an exact
# R34 qualification field describing what this run actually proves on hosted CI.
$source = Replace-Once $source `
  "  r34RuntimeSmokes='producer-watchdog+r33-visible-dwm+r34-dual-handoff-explicit-markers'" `
  ("  r34HostedVisualProof='focused-capturePage-blue+native-visible-HWND+exact-S_OK+900ms-autonomous+mirror-sampleFrame-red+desktopCapturer-optional'" + "`n" + "  r34RuntimeSmokes='producer-watchdog+r33-visible-dwm+r34-dual-handoff-explicit-markers'") `
  'R34 hosted visual manifest proof'

$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r32-native-producer-watchdog-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r32-native-producer-watchdog-smoke.cjs r32-producer-watchdog 120000' `
  'R34 producer smoke external timeout'

$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r33-owned-popup-visible-focus-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r33-owned-popup-visible-focus-smoke.cjs r33-postfix-dwm-focus 120000' `
  'R34 R33 DWM smoke external timeout'

$source = Replace-Once $source `
  '& node_modules/.bin/electron.cmd scripts/r34-focus-handoff-native-smoke.cjs' `
  'node scripts/r34-run-smoke-with-timeout.cjs scripts/r34-focus-handoff-native-smoke.cjs r34-dual-handoff 120000' `
  'R34 handoff smoke external timeout'

# Add coarse phase markers. If a future failure occurs, completed-job logs identify
# the exact boundary without relying on an in-process timer.
$source = Replace-Once $source `
  "& ./scripts/r34-r33-baseline-defer.ps1" `
  ("Write-Host 'R34_PHASE=baseline-start'" + "`n" + "& ./scripts/r34-r33-baseline-defer.ps1" + "`n" + "Write-Host 'R34_PHASE=baseline-complete'") `
  'R34 baseline phase markers'
$source = Replace-Once $source `
  "node scripts/r34-transform-source-sanitize.cjs" `
  ("Write-Host 'R34_PHASE=transform-start'" + "`n" + "node scripts/r34-transform-source-sanitize.cjs") `
  'R34 transform phase marker'
$source = Replace-Once $source `
  "& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=`$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers" `
  ("Write-Host 'R34_PHASE=native-rebuild-start'" + "`n" + "& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=`$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers" + "`n" + "Write-Host 'R34_PHASE=native-rebuild-complete'") `
  'R34 native rebuild phase markers'
$source = Replace-Once $source `
  "`$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path" `
  ("Write-Host 'R34_PHASE=runtime-smokes-start'" + "`n" + "`$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path") `
  'R34 runtime smoke phase marker'
$source = Replace-Once $source `
  "Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue" `
  ("Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue" + "`n" + "Write-Host 'R34_PHASE=runtime-smokes-complete'") `
  'R34 runtime smoke completion marker'
$source = Replace-Once $source `
  "Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue" `
  ("Write-Host 'R34_PHASE=final-package-start'" + "`n" + "Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue") `
  'R34 package phase marker'
$source = Replace-Once $source `
  "`$installer=Join-Path 'dist' `$env:INSTALLER_NAME" `
  ("Write-Host 'R34_PHASE=final-package-complete'" + "`n" + "`$installer=Join-Path 'dist' `$env:INSTALLER_NAME") `
  'R34 package completion marker'

$temp = Join-Path $env:RUNNER_TEMP 'r34-focus-handoff-stall-build-bounded-generated.ps1'
[System.IO.File]::WriteAllText($temp,$source,(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'R34_BOUNDED_BUILD_WRAPPER_OK smokeTimeoutMs=120000 phaseMarkers=baseline+transform+native+smokes+package hostedVisual=capturePage+exact-S_OK+source-sample desktopCapturer=optional trackedTreeMutation=0'
& $temp
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

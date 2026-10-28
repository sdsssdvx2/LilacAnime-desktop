$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}

# r39-qualified-build intentionally reconstructs exact R38/R37 from git history.
# Keep every late finalization script outside the worktree so nested reconstruction
# cannot silently remove the authoritative corrections before postqualification.
$stash = Join-Path $env:RUNNER_TEMP 'lilac-r39-final-v2-support'
Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stash | Out-Null
$lateSupport = @(
  'r39-subtitle-r2v-calibration-correction.cjs',
  'r39-refocus-force-wake.cjs',
  'r39-topmost-bidirectional-fix.cjs',
  'r39-rebundle-final-renderer.cjs',
  'r39-final-subtitle-smoke.cjs',
  'r39-final-smoke.cjs',
  'r39-postqualify-final.ps1'
)
foreach ($name in $lateSupport) {
  $src = Join-Path 'scripts' $name
  if (-not (Test-Path $src)) { throw "R39 final-v2 support missing before nested reconstruction: $name" }
  Copy-Item $src (Join-Path $stash $name) -Force
}

Write-Host 'R39_FINAL_V2_WRAPPER_BEGIN baseline=R38+baseR39 preserve=subtitleR2V+forceWake+bidirectionalTopmost+rendererRebundle+finalSmokes'
& ./scripts/r39-qualified-build.ps1
Assert-Exit 'R39 base qualification from final-v2 wrapper'

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $lateSupport) {
  Copy-Item (Join-Path $stash $name) (Join-Path 'scripts' $name) -Force
}

& ./scripts/r39-postqualify-final.ps1
Assert-Exit 'R39 authoritative final postqualification'
Write-Host 'R39_FINAL_V2_WRAPPER_OK nestedSupport=restored subtitle=R2V-calibrated refocus=forced-wake pip=bidirectional rendererBundle=refreshed finalRuntime=qualified'

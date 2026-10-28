$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}

# Preserve every authoritative late correction outside the worktree. The v2 base
# builder intentionally reconstructs exact historical R38 before applying base R39.
$stash = Join-Path $env:RUNNER_TEMP 'lilac-r39-final-v4-support'
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
  if (-not (Test-Path $src)) { throw "R39 final-v4 support missing before reconstruction: $name" }
  Copy-Item $src (Join-Path $stash $name) -Force
}

Write-Host 'R39_FINAL_V4_WRAPPER_BEGIN baselineBuilder=v2-clean-worktree final=R2V-subtitle+forceWake+bidirectionalTopmost+rendererRebundle'
& ./scripts/r39-qualified-build-v2.ps1
Assert-Exit 'R39 v2 base qualification from final-v4 wrapper'

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $lateSupport) {
  Copy-Item (Join-Path $stash $name) (Join-Path 'scripts' $name) -Force
}

& ./scripts/r39-postqualify-final.ps1
Assert-Exit 'R39 authoritative final-v4 postqualification'
Write-Host 'R39_FINAL_V4_WRAPPER_OK baseline=exact-R38-clean-checkout baseR39=qualified finalCorrections=qualified'

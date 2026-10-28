$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}

$stash = Join-Path $env:RUNNER_TEMP 'lilac-r39-final-support'
Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stash | Out-Null
$lateSupport = @('r39-topmost-bidirectional-fix.cjs','r39-postqualify-bidirectional.ps1')
foreach ($name in $lateSupport) {
  $src = Join-Path 'scripts' $name
  if (-not (Test-Path $src)) { throw "R39 final support missing before nested reconstruction: $name" }
  Copy-Item $src (Join-Path $stash $name) -Force
}

Write-Host 'R39_FINAL_WRAPPER_BEGIN preserve=bidirectional-fix+postqualify'
& ./scripts/r39-qualified-build.ps1
Assert-Exit 'R39 base qualification from final wrapper'

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $lateSupport) {
  Copy-Item (Join-Path $stash $name) (Join-Path 'scripts' $name) -Force
}

& ./scripts/r39-postqualify-bidirectional.ps1
Assert-Exit 'R39 final bidirectional postqualification'
Write-Host 'R39_FINAL_WRAPPER_OK nestedSupport=restored finalCorrection=qualified'

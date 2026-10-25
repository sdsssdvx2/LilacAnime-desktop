$ErrorActionPreference = 'Stop'

$generated = Join-Path $env:RUNNER_TEMP 'r32-generated-meta-build.ps1'
node --check scripts/r32-build-meta-generator.cjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/r32-build-meta-generator.cjs $generated
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $generated
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Preserve the original R39 post-baseline qualification body in memory before the
# nested exact-R38 builder checks out historical source and removes R39-only files.
$legacyBuildPath = 'scripts/r39-qualified-build.ps1'
if (-not (Test-Path $legacyBuildPath)) { throw 'R39 legacy qualified builder missing' }
$legacySource = Get-Content $legacyBuildPath -Raw
$suffixMarker = "`$baselineManifestPath = Join-Path 'dist' 'lilacanime-libmpv-r38-manifest.json'"
$suffixAt = $legacySource.IndexOf($suffixMarker)
if ($suffixAt -lt 0) { throw 'R39 legacy post-baseline qualification marker missing' }
$legacySuffix = $legacySource.Substring($suffixAt)

# Copy only support into RUNNER_TEMP. Correct the transform copy there; the tracked
# worktree remains byte-clean so historical git checkout cannot be blocked.
$r39Stash = Join-Path $env:RUNNER_TEMP 'lilac-r39-support-v2'
Remove-Item $r39Stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $r39Stash | Out-Null
$r39Support = @('r39-refocus-pip-subtitle-fix.cjs','r39-refocus-pip-subtitle-smoke.cjs')
foreach ($name in $r39Support) {
  $src = Join-Path 'scripts' $name
  if (-not (Test-Path $src)) { throw "R39 v2 support missing before R38 reconstruction: $name" }
  Copy-Item $src (Join-Path $r39Stash $name) -Force
}
$compat = 'scripts/r39-base-anchor-compat-v2.cjs'
if (-not (Test-Path $compat)) { throw 'R39 temp-copy anchor compatibility script missing' }
node --check $compat
Assert-Exit 'R39 temp-copy anchor compat syntax'
node $compat (Join-Path $r39Stash 'r39-refocus-pip-subtitle-fix.cjs')
Assert-Exit 'R39 temp-copy anchor compatibility'

# Prove no tracked source was changed before nested checkout. git diff --quiet returns
# 1 for any tracked worktree/index modification and therefore fails closed.
git diff --quiet -- scripts/r39-refocus-pip-subtitle-fix.cjs scripts/r39-refocus-pip-subtitle-smoke.cjs
if ($LASTEXITCODE -ne 0) { throw 'R39 v2 dirty worktree detected before exact-R38 reconstruction' }
Write-Host 'R39_V2_PREBASELINE_OK transformPatch=temp-only workingTree=clean'

$r39AppVersion = $env:APP_VERSION
$r39InstallerName = $env:INSTALLER_NAME
$r39ManifestName = $env:MANIFEST_NAME
$r39ReleaseTag = $env:RELEASE_TAG
try {
  $env:APP_VERSION = '0.5.54-libmpv-r3f.rc18'
  $env:INSTALLER_NAME = 'LilacAnime-Libmpv-R38-Setup.exe'
  $env:MANIFEST_NAME = 'lilacanime-libmpv-r38-manifest.json'
  $env:RELEASE_TAG = 'libmpv-r2k-v0.5.54-r38'
  Write-Host 'R39_BASELINE_BEGIN source=exact-qualified-R38 builder=v2-clean-worktree'
  & ./scripts/r38-qualified-build.ps1
  Assert-Exit 'R38 qualified baseline for R39 v2'
  Write-Host 'R39_BASELINE_OK inherited=R33-native-only+R37-explicit-handoff+R38-updater+focused-direct-webgpu builder=v2'
}
finally {
  $env:APP_VERSION = $r39AppVersion
  $env:INSTALLER_NAME = $r39InstallerName
  $env:MANIFEST_NAME = $r39ManifestName
  $env:RELEASE_TAG = $r39ReleaseTag
}

# Historical reconstruction removes branch-only scripts. Restore only the corrected
# temp support, then execute the unchanged post-baseline qualification body from the
# original R39 builder. This keeps one source of truth for all downstream gates.
New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $r39Support) {
  Copy-Item (Join-Path $r39Stash $name) (Join-Path 'scripts' $name) -Force
}
$restoredTransform = Get-Content 'scripts/r39-refocus-pip-subtitle-fix.cjs' -Raw
if (-not $restoredTransform.Contains("      r33FocusSurface: {\n        mode: 'owned-popup-native-only-unfocused',")) {
  throw 'R39 v2 restored transform does not contain reconstructed-R38 diagnostics anchor'
}
if ($restoredTransform.Contains("        r33FocusSurface: {\n          mode: 'owned-popup-native-only-unfocused',")) {
  throw 'R39 v2 restored transform still contains stale diagnostics anchor'
}

$suffixPath = Join-Path $env:RUNNER_TEMP 'r39-post-baseline-legacy-suffix.ps1'
[System.IO.File]::WriteAllText($suffixPath, $legacySuffix, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'R39_V2_POSTBASELINE_BEGIN source=legacy-qualified-suffix transform=temp-corrected'
. $suffixPath
Write-Host 'R39_V2_QUALIFIED_BUILD_OK baseline=exact-R38 transform=temp-corrected downstreamGates=legacy-preserved'

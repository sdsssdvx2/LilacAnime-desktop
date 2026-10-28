$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}

# The base R39 transform is intentionally preserved across the nested exact-R38
# reconstruction by r39-qualified-build.ps1. Normalize its diagnostics anchor to
# the actual reconstructed R38 indentation BEFORE that stash occurs.
node --check scripts/r39-base-anchor-compat.cjs
Assert-Exit 'R39 base anchor compat syntax'
node scripts/r39-base-anchor-compat.cjs
Assert-Exit 'R39 base anchor compatibility'

$patched = Get-Content 'scripts/r39-refocus-pip-subtitle-fix.cjs' -Raw
if (-not $patched.Contains("      r33FocusSurface: {\n        mode: 'owned-popup-native-only-unfocused',")) {
  throw 'R39 authoritative wrapper did not produce the reconstructed-R38 diagnostics anchor'
}
if ($patched.Contains("        r33FocusSurface: {\n          mode: 'owned-popup-native-only-unfocused',")) {
  throw 'R39 authoritative wrapper still contains stale diagnostics indentation'
}

Write-Host 'R39_AUTHORITATIVE_V3_ANCHOR_OK r33FocusSurface=R38-actual'
& ./scripts/r39-final-wrapper-v2.ps1
Assert-Exit 'R39 authoritative final-v2 qualification'
Write-Host 'R39_AUTHORITATIVE_V3_OK baseAnchor=corrected finalCorrections=fully-qualified'

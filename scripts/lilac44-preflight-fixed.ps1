$ErrorActionPreference='Stop'

# Keep the already-reviewed R44 preflight intact, but relocate only its generated
# cue-cycle smoke insertion. The original insertion point is before videoRect is
# declared in the R40 smoke; the corrected point is immediately after the native
# desktop red probe, where videoRect is guaranteed to exist.
$sourcePath=Join-Path (Get-Location) 'scripts/r44-preflight.ps1'
$text=(Get-Content $sourcePath -Raw).Replace("`r`n","`n")
$old='$source=$source.Replace($pixelAnchor,$pixelAnchor+$cycleInject)'
$new=@'
$cycleAnchor='    if(!dominantRed(redProbe))throw new Error(`R33 native popup red video not visible on actual desktop ${JSON.stringify(redProbe)} stats=${JSON.stringify(addon.nativePresenterStats(id))}`);'
$cycleFirst=$source.IndexOf($cycleAnchor,[System.StringComparison]::Ordinal)
$cycleLast=$source.LastIndexOf($cycleAnchor,[System.StringComparison]::Ordinal)
if($cycleFirst-lt 0-or$cycleFirst-ne$cycleLast){throw 'R44 corrected cue-cycle injection anchor mismatch'}
$source=$source.Replace($cycleAnchor,$cycleAnchor+$cycleInject)
'@
$matches=([regex]::Matches($text,[regex]::Escape($old))).Count
if($matches-ne 1){throw "R44 fixed-preflight patch expected one old injection, found $matches"}
$text=$text.Replace($old,$new.TrimEnd())

$temp=Join-Path (Get-Location) 'scripts/r44-preflight-fixed.generated.ps1'
[System.IO.File]::WriteAllText($temp,$text,(New-Object System.Text.UTF8Encoding($false)))
try {
  & $temp
  if($LASTEXITCODE-ne 0){throw "R44 corrected preflight exited $LASTEXITCODE"}
}
finally {
  Remove-Item $temp -Force -ErrorAction SilentlyContinue
}

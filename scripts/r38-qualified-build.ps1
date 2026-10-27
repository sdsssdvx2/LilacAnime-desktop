$ErrorActionPreference = 'Stop'

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}
function Assert-Exit([string]$label) { if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" } }

# Reuse the fully qualified R37 construction/runtime proof, but add the updater
# repair immediately after R37 product transforms and before the final package.
$source = Get-Content 'scripts/r37-qualified-build.ps1' -Raw

$source = Replace-Once $source `
  "  'r37-node-api-callback-diagnostic.cjs'" `
  ("  'r37-node-api-callback-diagnostic.cjs'," + "`n" +
   "  'r38-updater-channel-fix.cjs'," + "`n" +
   "  'r38-updater-channel-smoke.cjs'") `
  'R38 support stash'

$source = Replace-Once $source `
  "Assert-Exit 'R37 Node-API wake scope fix'" `
  ("Assert-Exit 'R37 Node-API wake scope fix'" + "`n" +
   "node --check scripts/r38-updater-channel-fix.cjs" + "`n" +
   "Assert-Exit 'R38 updater channel fix syntax'" + "`n" +
   "node scripts/r38-updater-channel-fix.cjs" + "`n" +
   "Assert-Exit 'R38 updater channel fix'" + "`n" +
   "node --check scripts/r38-updater-channel-smoke.cjs" + "`n" +
   "Assert-Exit 'R38 updater channel smoke syntax'" + "`n" +
   "node scripts/r38-updater-channel-smoke.cjs" + "`n" +
   "Assert-Exit 'R38 updater channel smoke'") `
  'R38 updater execution'

$temp = Join-Path $env:RUNNER_TEMP 'r38-qualified-build-generated.ps1'
[System.IO.File]::WriteAllText($temp,$source,(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'R38_QUALIFIED_BUILD_WRAPPER_OK base=R37 updaterTag=release-tag discovery=api+html startupRetry=60s playbackPath=unchanged'
& $temp
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# R37 already built and runtime-qualified the exact product bytes. Now prove the
# R38 updater repair survived into the packaged ASAR and record it in the external
# manifest that the public-release verification re-downloads.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkg.lilacCustomTag -ne $env:RELEASE_TAG) { throw "R38 working-tree custom tag mismatch: $($pkg.lilacCustomTag)" }

$asarCli = 'node_modules/.bin/asar.cmd'
if (-not (Test-Path $asarCli)) { throw 'R38 asar helper missing' }
$asarCheck = Join-Path $env:RUNNER_TEMP 'r38-updater-asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R38 packaged asar extract'

$shipPkg = Get-Content (Join-Path $asarCheck 'package.json') -Raw | ConvertFrom-Json
$shipUpdater = Get-Content (Join-Path $asarCheck 'electron/updater.cjs') -Raw
$shipMain = Get-Content (Join-Path $asarCheck 'electron/main.cjs') -Raw
if ($shipPkg.lilacCustomTag -ne $env:RELEASE_TAG) { throw "packaged R38 custom tag mismatch: $($shipPkg.lilacCustomTag)" }
foreach ($marker in @('LILAC_R38_CUSTOM_UPDATE_CHANNEL','discoverCustomReleaseFromHtml','CUSTOM_RELEASES_HTML','r38Discovery')) {
  if (-not $shipUpdater.Contains($marker)) { throw "packaged R38 updater marker missing: $marker" }
}
foreach ($marker in @('LILAC_R38_UPDATER_STARTUP_RETRY','updaterRetryTimer','60*1000')) {
  if (-not $shipMain.Contains($marker)) { throw "packaged R38 startup updater marker missing: $marker" }
}
if (-not $shipMain.Contains('updater?.installOnQuit()')) { throw 'packaged R38 install-on-quit wiring missing' }

$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
if (-not (Test-Path $manifestPath)) { throw "R38 manifest missing: $manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$manifest | Add-Member -NotePropertyName customUpdateTag -NotePropertyValue $env:RELEASE_TAG -Force
$manifest | Add-Member -NotePropertyName customUpdaterDiscovery -NotePropertyValue 'github-api+public-release-html-fallback' -Force
$manifest | Add-Member -NotePropertyName customUpdaterStartup -NotePropertyValue '5s-initial+60s-error-retry+3h-periodic' -Force
$manifest | Add-Member -NotePropertyName customUpdaterInstall -NotePropertyValue 'background-download+install-on-quit' -Force
$manifest | Add-Member -NotePropertyName r38UpdaterSmoke -NotePropertyValue 'current-api+api403-html-fallback-newer+background-download+packaged-tag' -Force
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Resolve-Path $manifestPath), (($manifest | ConvertTo-Json -Depth 100) + [Environment]::NewLine), $utf8NoBom)

Write-Host "R38_UPDATER_PACKAGED_OK tag=$($shipPkg.lilacCustomTag) discovery=github-api+html-fallback startup=5s+60s-retry+3h install=background-download+quit playback=R37-unchanged"

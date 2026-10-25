$ErrorActionPreference = 'Stop'

# eab226b is the fully reviewed R32 build core with the presenter-smoke callback
# fix in its history and BOM-free package/manifest writes. Keep that exact core
# and change only the producer qualification plus the final presenter safety pass.
$baseCommit = 'eab226b788528253da08225d7ca2de8935e1bf39'
$core = (& git show "$baseCommit`:scripts/r32-flix-worker-native-focus-build.ps1") -join "`n"
if ($LASTEXITCODE -ne 0 -or -not $core) { throw 'R32 fixed build core could not be loaded' }
$core += "`n"

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

$core = Replace-Once $core `
  "  'r32-native-presenter-smoke.cjs'" `
  ("  'r32-native-presenter-smoke.cjs'," + "`n" + "  'r32-native-producer-watchdog-smoke.cjs'," + "`n" + "  'r32-presenter-bounds-subtitle-fix.cjs'," + "`n" + "  'r32-presenter-safety-source-sanitize.cjs'," + "`n" + "  'r32-presenter-safety-anchor-fix.cjs'," + "`n" + "  'r32-presenter-api-relocate.cjs'") `
  'R32 watchdog/safety support entry'

$core = Replace-Once $core `
  "node scripts/r32-flix-worker-native-focus-fix.cjs`nAssert-Exit 'R32 transform'" `
  ("node scripts/r32-flix-worker-native-focus-fix.cjs" + "`n" + "Assert-Exit 'R32 transform'" + "`n" + "node --check scripts/r32-presenter-safety-source-sanitize.cjs" + "`n" + "Assert-Exit 'R32 presenter safety sanitizer syntax'" + "`n" + "node scripts/r32-presenter-safety-source-sanitize.cjs" + "`n" + "Assert-Exit 'R32 presenter safety sanitizer'" + "`n" + "node --check scripts/r32-presenter-safety-anchor-fix.cjs" + "`n" + "Assert-Exit 'R32 presenter safety anchor syntax'" + "`n" + "node scripts/r32-presenter-safety-anchor-fix.cjs" + "`n" + "Assert-Exit 'R32 presenter safety anchor'" + "`n" + "node --check scripts/r32-presenter-bounds-subtitle-fix.cjs" + "`n" + "Assert-Exit 'R32 presenter bounds/subtitle syntax'" + "`n" + "node scripts/r32-presenter-bounds-subtitle-fix.cjs" + "`n" + "Assert-Exit 'R32 presenter bounds/subtitle patch'" + "`n" + "node --check scripts/r32-presenter-api-relocate.cjs" + "`n" + "Assert-Exit 'R32 presenter API relocate syntax'" + "`n" + "node scripts/r32-presenter-api-relocate.cjs" + "`n" + "Assert-Exit 'R32 presenter API relocate'") `
  'R32 apply presenter safety pass'

# Replace only the legacy R32 presenter source gate. The R32 transform itself is an
# exact-anchor 6ms -> 250ms replaceOnce and self-checks the resulting 250ms marker;
# after rebuilding the addon, r32-native-producer-watchdog-smoke.cjs is the
# authoritative binary qualification (two 750ms JS stalls, producer must progress).
# Do not duplicate that proof here with assumptions about the reconstructed source
# spelling: earlier redundant gates produced false negatives before compilation.
$legacyGatePrefix = "if (`$nativeSource -notmatch 'LILAC_R32_NATIVE_HWND_FOCUS_SURFACE'"
$legacyGateStart = $core.IndexOf($legacyGatePrefix)
if ($legacyGateStart -lt 0) { throw 'R32 legacy native source gate prefix missing' }
$legacyGateEnd = $core.IndexOf("`n", $legacyGateStart)
if ($legacyGateEnd -lt 0) { $legacyGateEnd = $core.Length } else { $legacyGateEnd += 1 }
$newNativeGates = @'
if (-not $nativeSource.Contains('LILAC_R32_NATIVE_HWND_FOCUS_SURFACE')) { throw 'R32 native presenter marker missing' }
if (-not $nativeSource.Contains('R32PresentNativeFrame')) { throw 'R32 native presenter hotpath missing' }
if (-not $nativeSource.Contains('ConfigureNativePresenter')) { throw 'R32 native presenter configure API missing' }
'@
$core = $core.Substring(0, $legacyGateStart) + $newNativeGates + $core.Substring($legacyGateEnd)

$core = Replace-Once $core `
  '& node_modules/.bin/electron.cmd scripts/smoke-libmpv-r3e-native-producer.cjs' `
  '& node_modules/.bin/electron.cmd scripts/r32-native-producer-watchdog-smoke.cjs' `
  'R32 watchdog smoke invocation'

$core = Replace-Once $core `
  "Assert-Exit 'R32 native producer callback smoke'" `
  "Assert-Exit 'R32 native producer 250ms watchdog smoke'" `
  'R32 watchdog smoke assertion label'

# Strengthen the existing source qualification with literal/structural checks so a
# green build also proves the producer thread no longer mutates HWND geometry and
# renderer geometry contains physical x/y for the exact video element. The native
# presenter hotpath is bounded by SetOption; its JS-facing N-API block is relocated
# near Init after every existing player API so FindPlayer/SampleTexture are defined.
$extraGates = @'
$entry = Get-Content 'src/libmpv-shared-entry.js' -Raw
$appSource = Get-Content 'src/app.js' -Raw
if (-not $nativeSource.Contains('LILAC_R32_PRESENTER_BOUNDS_MAIN_THREAD') -or -not $nativeSource.Contains('SetNativePresenterBounds')) { throw 'R32 bounded presenter source gate failed' }
$presentStart = $nativeSource.IndexOf('void R32PresentNativeFrame(')
$presentEnd = $nativeSource.IndexOf('bool SetOption(Player* player, const char* key, const char* value, std::string* error) {', $presentStart)
if ($presentStart -lt 0 -or $presentEnd -le $presentStart) { throw 'R32 presenter hotpath audit boundary missing' }
$presentBody = $nativeSource.Substring($presentStart, $presentEnd - $presentStart)
if ($presentBody.Contains('SetWindowPos(') -or $presentBody.Contains('ShowWindow(') -or $presentBody.Contains('GetClientRect(')) { throw 'R32 producer thread still mutates HWND state' }
$sampleAt = $nativeSource.IndexOf('bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {')
$findAt = $nativeSource.IndexOf('Player* FindPlayer(uint32_t id) {')
$apiAt = $nativeSource.IndexOf('napi_value ConfigureNativePresenter(')
$initAt = $nativeSource.IndexOf('napi_value Init(napi_env env, napi_value exports) {')
if ($sampleAt -lt 0 -or $findAt -lt 0 -or $apiAt -le $findAt -or $apiAt -le $sampleAt -or $initAt -le $apiAt) { throw 'R32 presenter API ordering lost existing native helpers' }
if (-not $bridge.Contains('setNativePresenterBounds') -or -not $bridge.Contains('r32SyncNativePresenterBounds') -or -not $bridge.Contains('sub-visibility')) { throw 'R32 bounds/subtitle bridge gate failed' }
if (-not $entry.Contains('LILAC_R32_NATIVE_SUBTITLE_FALLBACK') -or -not $entry.Contains('rect.left * dpr') -or -not $entry.Contains('rect.top * dpr') -or -not $entry.Contains('sub-add')) { throw 'R32 video-rect/native-subtitle renderer gate failed' }
if (-not $appSource.Contains('lilacNativePath')) { throw 'R32 native subtitle source path gate failed' }
Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread+asar-unpacked nativeWatchdog=transform+selfcheck+binary-smoke r31CanvasShield=disabled stateNativePollMs=1000 videoRect=physical hwndOps=main-only subtitleFallback=libmpv-unfocused presenterApi=late-before-init existingNativeApis=preserved'
'@
$core = Replace-Once $core `
  "Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread+asar-unpacked nativeCallbackWatchdogMs=250 r31CanvasShield=disabled stateNativePollMs=1000'" `
  $extraGates `
  'R32 strengthen source qualification'

$tempScript = Join-Path $env:RUNNER_TEMP 'r32-watchdog-qualified-build.ps1'
[System.IO.File]::WriteAllText($tempScript, $core, (New-Object System.Text.UTF8Encoding($false)))
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

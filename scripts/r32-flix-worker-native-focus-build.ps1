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
  ("  'r32-native-presenter-smoke.cjs'," + "`n" + "  'r32-native-producer-watchdog-smoke.cjs'," + "`n" + "  'r32-presenter-bounds-subtitle-fix.cjs'," + "`n" + "  'r32-presenter-safety-source-sanitize.cjs'") `
  'R32 watchdog/safety support entry'

$core = Replace-Once $core `
  "node scripts/r32-flix-worker-native-focus-fix.cjs`nAssert-Exit 'R32 transform'" `
  ("node scripts/r32-flix-worker-native-focus-fix.cjs" + "`n" + "Assert-Exit 'R32 transform'" + "`n" + "node --check scripts/r32-presenter-safety-source-sanitize.cjs" + "`n" + "Assert-Exit 'R32 presenter safety sanitizer syntax'" + "`n" + "node scripts/r32-presenter-safety-source-sanitize.cjs" + "`n" + "Assert-Exit 'R32 presenter safety sanitizer'" + "`n" + "node --check scripts/r32-presenter-bounds-subtitle-fix.cjs" + "`n" + "Assert-Exit 'R32 presenter bounds/subtitle syntax'" + "`n" + "node scripts/r32-presenter-bounds-subtitle-fix.cjs" + "`n" + "Assert-Exit 'R32 presenter bounds/subtitle patch'") `
  'R32 apply presenter safety pass'

# Replace the old opaque four-term source gate structurally. Avoid regex entirely:
# locate the actual producer waiter, inspect a bounded local source slice, and let
# the runtime smoke below prove callback-authoritative progress through a JS stall.
$legacyGatePrefix = "if (`$nativeSource -notmatch 'LILAC_R32_NATIVE_HWND_FOCUS_SURFACE'"
$legacyGateStart = $core.IndexOf($legacyGatePrefix)
if ($legacyGateStart -lt 0) { throw 'R32 legacy native source gate prefix missing' }
$legacyGateEnd = $core.IndexOf("`n", $legacyGateStart)
if ($legacyGateEnd -lt 0) { $legacyGateEnd = $core.Length } else { $legacyGateEnd += 1 }
$newNativeGates = @'
if (-not $nativeSource.Contains('LILAC_R32_NATIVE_HWND_FOCUS_SURFACE')) { throw 'R32 native presenter marker missing' }
if (-not $nativeSource.Contains('R32PresentNativeFrame')) { throw 'R32 native presenter hotpath missing' }
if (-not $nativeSource.Contains('ConfigureNativePresenter')) { throw 'R32 native presenter configure API missing' }
$watchdogAt = $nativeSource.IndexOf('producerCv.wait_for(')
if ($watchdogAt -lt 0) { throw 'R32 native producer waiter missing' }
$watchdogLength = [Math]::Min(320, $nativeSource.Length - $watchdogAt)
$watchdogSource = $nativeSource.Substring($watchdogAt, $watchdogLength)
if (-not $watchdogSource.Contains('std::chrono::milliseconds(250)')) { throw 'R32 native producer 250ms watchdog waiter missing' }
if ($watchdogSource.Contains('std::chrono::milliseconds(6)')) { throw 'R32 legacy native producer 6ms waiter survived' }
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
# renderer geometry contains physical x/y for the exact video element.
$extraGates = @'
$entry = Get-Content 'src/libmpv-shared-entry.js' -Raw
$appSource = Get-Content 'src/app.js' -Raw
if (-not $nativeSource.Contains('LILAC_R32_PRESENTER_BOUNDS_MAIN_THREAD') -or -not $nativeSource.Contains('SetNativePresenterBounds')) { throw 'R32 bounded presenter source gate failed' }
$presentStart = $nativeSource.IndexOf('void R32PresentNativeFrame(')
$presentEnd = $nativeSource.IndexOf('napi_value ConfigureNativePresenter(', $presentStart)
if ($presentStart -lt 0 -or $presentEnd -le $presentStart) { throw 'R32 presenter hotpath audit boundary missing' }
$presentBody = $nativeSource.Substring($presentStart, $presentEnd - $presentStart)
if ($presentBody.Contains('SetWindowPos(') -or $presentBody.Contains('ShowWindow(') -or $presentBody.Contains('GetClientRect(')) { throw 'R32 producer thread still mutates HWND state' }
if (-not $bridge.Contains('setNativePresenterBounds') -or -not $bridge.Contains('r32SyncNativePresenterBounds') -or -not $bridge.Contains('sub-visibility')) { throw 'R32 bounds/subtitle bridge gate failed' }
if (-not $entry.Contains('LILAC_R32_NATIVE_SUBTITLE_FALLBACK') -or -not $entry.Contains('rect.left * dpr') -or -not $entry.Contains('rect.top * dpr') -or -not $entry.Contains('sub-add')) { throw 'R32 video-rect/native-subtitle renderer gate failed' }
if (-not $appSource.Contains('lilacNativePath')) { throw 'R32 native subtitle source path gate failed' }
Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread+asar-unpacked nativeCallbackWatchdogMs=250 r31CanvasShield=disabled stateNativePollMs=1000 videoRect=physical hwndOps=main-only subtitleFallback=libmpv-unfocused'
'@
$core = Replace-Once $core `
  "Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread+asar-unpacked nativeCallbackWatchdogMs=250 r31CanvasShield=disabled stateNativePollMs=1000'" `
  $extraGates `
  'R32 strengthen source qualification'

$tempScript = Join-Path $env:RUNNER_TEMP 'r32-watchdog-qualified-build.ps1'
[System.IO.File]::WriteAllText($tempScript, $core, (New-Object System.Text.UTF8Encoding($false)))
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

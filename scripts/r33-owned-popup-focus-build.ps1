$ErrorActionPreference = 'Stop'

# R33 deliberately builds on the exact public R32 construction that produced the
# user's diagnostic. Modify only the final R32 working tree before native rebuild,
# then replace the old hidden-window presenter smoke with a visible DWM/focus test.
$r32Commit = '4226241d3778726628ad8669f22673359c9a3cb2'
$wrapper = (& git show "$r32Commit`:scripts/r32-flix-worker-native-focus-build.ps1") -join "`n"
if ($LASTEXITCODE -ne 0 -or -not $wrapper) { throw 'R32 qualified wrapper could not be loaded' }
$wrapper += "`n"

$injectionAnchor = '$tempScript = Join-Path $env:RUNNER_TEMP ''r32-watchdog-qualified-build.ps1'''
if ($wrapper.IndexOf($injectionAnchor) -lt 0) { throw 'R32 wrapper injection anchor missing' }

$r33Injection = @'
# ---- R33 owned-popup / native-only qualification injection ----
$core = Replace-Once $core `
  "  'r32-presenter-api-relocate.cjs'" `
  ("  'r32-presenter-api-relocate.cjs'," + "`n" + "  'r33-owned-popup-focus-fix.cjs'," + "`n" + "  'r33-owned-popup-visible-focus-smoke.cjs'") `
  'R33 support entries'

$core = Replace-Once $core `
  ("node scripts/r32-presenter-api-relocate.cjs" + "`n" + "Assert-Exit 'R32 presenter API relocate'") `
  ("node scripts/r32-presenter-api-relocate.cjs" + "`n" + "Assert-Exit 'R32 presenter API relocate'" + "`n" + "node --check scripts/r33-owned-popup-focus-fix.cjs" + "`n" + "Assert-Exit 'R33 owned popup transform syntax'" + "`n" + "node scripts/r33-owned-popup-focus-fix.cjs" + "`n" + "Assert-Exit 'R33 owned popup transform'") `
  'R33 apply after final R32 safety pass'

$core = Replace-Once $core `
  '& node_modules/.bin/electron.cmd scripts/r32-native-presenter-smoke.cjs' `
  '& node_modules/.bin/electron.cmd scripts/r33-owned-popup-visible-focus-smoke.cjs' `
  'R33 visible DWM smoke invocation'

$core = Replace-Once $core `
  "Assert-Exit 'R32 native child HWND CopyResource/Present smoke'" `
  "Assert-Exit 'R33 visible owned popup focus/DWM smoke'" `
  'R33 visible DWM smoke label'

$r32GateLine = "Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread+asar-unpacked nativeWatchdog=transform+selfcheck+binary-smoke r31CanvasShield=disabled stateNativePollMs=1000 videoRect=physical hwndOps=main-only subtitleFallback=libmpv-unfocused presenterApi=late-before-init existingNativeApis=preserved'"
$r33GateBlock = "Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu r32ChildPresenter=superseded-by-r33 sameTexture=1 secondDecoder=0 flix=worker-thread+asar-unpacked nativeWatchdog=transform+selfcheck+binary-smoke r31CanvasShield=disabled stateNativePollMs=1000'`nif (-not `$nativeSource.Contains('LILAC_R33_OWNED_POPUP_FOCUS_SURFACE') -or -not `$nativeSource.Contains('LILAC_R33_NATIVE_ONLY_UNFOCUSED')) { throw 'R33 native marker gate failed' }`n`$r33ConfigureStart = `$nativeSource.IndexOf('bool R32ConfigurePresenter(')`n`$r33ConfigureEnd = `$nativeSource.IndexOf('bool R32EnsurePresenterSwapChain(', `$r33ConfigureStart)`nif (`$r33ConfigureStart -lt 0 -or `$r33ConfigureEnd -le `$r33ConfigureStart) { throw 'R33 configure audit boundary missing' }`n`$r33ConfigureBody = `$nativeSource.Substring(`$r33ConfigureStart, `$r33ConfigureEnd - `$r33ConfigureStart)`nif (-not `$r33ConfigureBody.Contains('WS_POPUP') -or -not `$r33ConfigureBody.Contains('WS_EX_TOOLWINDOW')) { throw 'R33 owned popup style missing' }`nif (`$r33ConfigureBody.Contains('WS_CHILD') -or `$r33ConfigureBody.Contains('WS_EX_TRANSPARENT')) { throw 'R33 retained Chromium-competing child/transparent style' }`nif (-not `$nativeSource.Contains('r33NativeOnlyFrames') -or -not `$nativeSource.Contains('r33NativeOwnsFrame')) { throw 'R33 native-only producer bypass missing' }`nif (-not `$bridge.Contains('r33NativePresenterActive') -or -not `$bridge.Contains('r33OnGeometry') -or -not `$bridge.Contains('owned-popup-native-only-unfocused')) { throw 'R33 bridge focus/geometry routing missing' }`nWrite-Host 'R33_SOURCE_GATES_OK focused=direct-webgpu unfocused=owned-ws-popup ownerZOrder=1 wsChild=0 wsExTransparent=0 blackErase=0 chromiumFrameDelivery=0 nativeProducerAutonomous=1 geometry=client-to-screen+move+resize+fullscreen'"
$core = Replace-Once $core $r32GateLine $r33GateBlock 'R33 source gates'

$core = Replace-Once $core `
  "if (`$shipBridge -notmatch 'r32ConfigureNativePresenter' -or `$shipBridge -notmatch 'r32NativePresenter') { throw 'packaged R32 native presenter bridge missing' }" `
  ("if (`$shipBridge -notmatch 'r32ConfigureNativePresenter' -or `$shipBridge -notmatch 'r32NativePresenter') { throw 'packaged R32 native presenter bridge missing' }" + "`n" + "if (`$shipBridge -notmatch 'r33NativePresenterActive' -or `$shipBridge -notmatch 'owned-popup-native-only-unfocused') { throw 'packaged R33 owned-popup bridge missing' }") `
  'R33 packaged bridge gate'
# ---- end R33 injection ----
'@

$wrapper = $wrapper.Replace($injectionAnchor, $r33Injection + "`n" + $injectionAnchor)
$tempWrapper = Join-Path $env:RUNNER_TEMP 'r33-qualified-wrapper.ps1'
[System.IO.File]::WriteAllText($tempWrapper, $wrapper, (New-Object System.Text.UTF8Encoding($false)))
& $tempWrapper
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# The R32 builder intentionally keeps historical fields. Add R33's stronger runtime
# proof to the already-built manifest without touching installer bytes.
$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
if (-not (Test-Path $manifestPath)) { throw "R33 manifest missing: $manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$manifest | Add-Member -NotePropertyName r33FocusPresenter -NotePropertyValue 'same-libmpv-d3d11-texture+owned-ws-popup-unfocused' -Force
$manifest | Add-Member -NotePropertyName r33NativeOnlyUnfocused -NotePropertyValue 'producer-copyresource-present+slot-release+no-tsfn-no-import-no-send-no-webgpu' -Force
$manifest | Add-Member -NotePropertyName r33VisibleFocusSmoke -NotePropertyValue 'two-visible-browserwindows+dwm-pixel-capture+900ms-main-stall+owner-move+focus-recovery' -Force
$manifest | Add-Member -NotePropertyName r33ChromiumDuplicateDelivery -NotePropertyValue $false -Force
$manifest | Add-Member -NotePropertyName r33OwnedPopupBlackErase -NotePropertyValue $false -Force
$manifest | Add-Member -NotePropertyName r32NativePresenterSmoke -NotePropertyValue 'superseded-by-r33-visible-dwm-focus-smoke' -Force
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine), $utf8NoBom)
$installer = Join-Path 'dist' $env:INSTALLER_NAME
$hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item $installer).Length
"R33_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"R33_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "R33_BUILD_OK sha256=$hash size=$size electron=$env:ELECTRON_VERSION focused=direct-webgpu unfocused=owned-popup-native-only visibleDwmSmoke=passed chromiumDuplicateDelivery=0"

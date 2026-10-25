$ErrorActionPreference = 'Stop'

$base = Get-Content 'scripts/r31-focus-compositor-state-coalesce-build.ps1' -Raw
$patched = $base

function Replace-Once([string]$Source,[string]$Needle,[string]$Replacement,[string]$Label) {
  $count = ([regex]::Matches($Source,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "$Label expected one anchor, found $count" }
  return $Source.Replace($Needle,$Replacement)
}

# Extend R31's generated build with the R32 transform source.
$needle = @'
  'scripts/r31-transform-anchor-normalize.cjs',
  'scripts/r31-focus-compositor-state-coalesce-fix.cjs'
)) {
'@
$replacement = @'
  'scripts/r31-transform-anchor-normalize.cjs',
  'scripts/r31-focus-compositor-state-coalesce-fix.cjs',
  'scripts/r32-flix-worker-native-focus-fix.cjs'
)) {
'@
$patched = Replace-Once $patched $needle $replacement 'R32 support list'

$needle = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs','r30-managed-release-producer-drain-fix.cjs','r31-transform-anchor-normalize.cjs','r31-focus-compositor-state-coalesce-fix.cjs')) {
'@
$replacement = @'
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs','r30-managed-release-producer-drain-fix.cjs','r31-transform-anchor-normalize.cjs','r31-focus-compositor-state-coalesce-fix.cjs','r32-flix-worker-native-focus-fix.cjs')) {
'@
$patched = Replace-Once $patched $needle $replacement 'R32 restore list'

$needle = @'
node scripts/r31-focus-compositor-state-coalesce-fix.cjs
Assert-Exit 'R31 compositor/state patch'
'@
$replacement = @'
node scripts/r31-focus-compositor-state-coalesce-fix.cjs
Assert-Exit 'R31 compositor/state patch'
node --check scripts/r32-flix-worker-native-focus-fix.cjs
Assert-Exit 'R32 focus/stutter syntax'
node scripts/r32-flix-worker-native-focus-fix.cjs
Assert-Exit 'R32 focus/stutter patch'
'@
$patched = Replace-Once $patched $needle $replacement 'R32 apply transform'

# Extend R31 source gates with the new native/worker invariants and prove the
# failed Canvas2D fallback is no longer active.
$needle = @'
Write-Host 'R31_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=canvas2d-shield shieldPrewarm=1of8 focusRecovery=2 stateNativePollMs=1000 uiClock=wall-extrapolated managedRelease=1'
'@
$replacement = @'
$nativeSource = Get-Content native/libmpv-d3d11-bridge/player_addon.cc -Raw
$flixSource = Get-Content electron/flix-proxy.cjs -Raw
if ($nativeSource -notmatch 'LILAC_R32_NATIVE_HWND_FOCUS_SURFACE' -or $nativeSource -notmatch 'R32PresentNativeFrame' -or $nativeSource -notmatch 'ConfigureNativePresenter' -or $nativeSource -notmatch 'std::chrono::milliseconds\(250\)') { throw 'R32 native presenter/watchdog source missing' }
if ($bridge -notmatch 'r32ConfigureNativePresenter' -or $bridge -notmatch 'r32ApplyNativePresenterFocus' -or $bridge -notmatch 'r32NativePresenter') { throw 'R32 native presenter bridge missing' }
if ($preload -notmatch 'const r31UseFocusShield = false' -or $preload -notmatch 'const r31MirrorNow = false') { throw 'R32 failed to disable R31 Canvas2D active path' }
if ($flixSource -notmatch 'LILAC_R32_FLIX_WORKER_ISOLATION' -or $flixSource -notmatch 'new Worker\(__filename' -or $flixSource -notmatch 'r32Rpc') { throw 'R32 Flix worker isolation missing' }
Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread nativeCallbackWatchdogMs=250 r31CanvasShield=disabled stateNativePollMs=1000'
'@
$patched = Replace-Once $patched $needle $replacement 'R32 source gate'

# Add packaged JS gates. The native addon is checked by hash plus a real
# Electron BrowserWindow child-HWND smoke inserted below.
$needle = @'
if ($shipPreload -notmatch 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD' -or $shipPreload -notmatch 'data-lilac-libmpv-focus-shield' -or $shipPreload -notmatch 'r31DrawFocusShield') { throw 'packaged R31 focus shield missing' }
'@
$replacement = @'
if ($shipPreload -notmatch 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD' -or $shipPreload -notmatch 'data-lilac-libmpv-focus-shield' -or $shipPreload -notmatch 'r31DrawFocusShield') { throw 'packaged R31 focus shield source missing' }
if ($shipPreload -notmatch 'const r31UseFocusShield = false' -or $shipPreload -notmatch 'R32_NATIVE_HWND_FOCUS_SURFACE') { throw 'packaged R32 native focus routing missing' }
$shipFlix = Get-Content (Join-Path $asarCheck 'electron\flix-proxy.cjs') -Raw
if ($shipFlix -notmatch 'LILAC_R32_FLIX_WORKER_ISOLATION' -or $shipFlix -notmatch 'new Worker\(__filename' -or $shipFlix -notmatch 'r32Rpc') { throw 'packaged R32 Flix worker isolation missing' }
'@
$patched = Replace-Once $patched $needle $replacement 'R32 packaged JS gates'

# Add R32 manifest fields while retaining the R31 evidence fields.
$needle = @'
  r31StateCoalesce = 'native-poll1000ms+renderer-wall-clock-extrapolation'
  r23WindowRepairPreserved = $true
'@
$replacement = @'
  r31StateCoalesce = 'native-poll1000ms+renderer-wall-clock-extrapolation'
  r32FocusPresenter = 'same-libmpv-d3d11-texture+native-ws-child-dxgi-unfocused'
  r32FlixIsolation = 'worker-thread-loopback-server+no-segment-main-ipc'
  r32NativeProducerWatchdog = 'callback-authoritative+250ms-native-watchdog'
  r23WindowRepairPreserved = $true
'@
$patched = Replace-Once $patched $needle $replacement 'R32 manifest fields'

# R32 changes the addon intentionally, so inject a pinned rebuild/smoke step into
# the final generated R31 build AFTER the old R23 payload is restored. These
# replacement operations execute inside the generated R31 meta-build, where the
# inherited R24 payload block is present.
$injectBefore = @'
$tempScript = Join-Path $env:RUNNER_TEMP 'r31-generated-build.ps1'
'@
$injected = @'
# R32 native addon rebuild and runtime qualification.
$needle = @'
Copy-Item $addon.FullName electron/lilac-libmpv-player-bridge.node -Force
Copy-Item $dll.FullName electron/libmpv-2.dll -Force
'@
$replacement = @'
Copy-Item $addon.FullName electron/lilac-libmpv-player-bridge.node -Force
Copy-Item $dll.FullName electron/libmpv-2.dll -Force

$archive = Join-Path $temp 'r32-libmpv-sdk.7z'
$sdk = Join-Path $temp 'r32-libmpv-sdk'
curl.exe -L --fail --retry 3 --retry-delay 2 -o $archive $env:LIBMPV_SDK_URL
Assert-Exit 'R32 libmpv SDK download'
if ((Sha256 $archive) -ne $env:LIBMPV_SDK_SHA256) { throw 'R32 libmpv SDK hash mismatch' }
New-Item -ItemType Directory -Force -Path $sdk | Out-Null
7z.exe x $archive "-o$sdk" -y | Out-Null
Assert-Exit 'R32 libmpv SDK extraction'
$client = Get-ChildItem $sdk -Recurse -File -Filter client.h | Where-Object { (Split-Path (Split-Path $_.FullName -Parent) -Leaf) -eq 'mpv' } | Select-Object -First 1
if (-not $client) { throw 'R32 libmpv client.h missing' }
$vendor = Join-Path $PWD 'native/libmpv-d3d11-bridge/vendor/include/mpv'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
Copy-Item (Join-Path (Split-Path $client.FullName -Parent) '*') $vendor -Recurse -Force
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R32 native addon rebuild'
Copy-Item native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node electron/lilac-libmpv-player-bridge.node -Force
$env:R32_ADDON_SHA256 = Sha256 'electron/lilac-libmpv-player-bridge.node'
"R32_ADDON_SHA256=$env:R32_ADDON_SHA256" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
if ($env:R32_ADDON_SHA256 -eq $env:QUALIFIED_ADDON_SHA256) { throw 'R32 addon unexpectedly byte-identical to R23 native payload' }

# Existing R3E producer smoke proves the 250ms native watchdog did not break the
# callback-authoritative worker, including progress during a blocked JS thread.
$env:LILAC_LIBMPV_PLAYER_ADDON = (Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL = (Resolve-Path 'electron/libmpv-2.dll').Path
$oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
try {
  & node_modules/.bin/electron.cmd scripts/smoke-libmpv-r3e-native-producer.cjs
  Assert-Exit 'R32 producer callback smoke'
} finally {
  if ($null -eq $oldRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode }
}

# Create a real Electron BrowserWindow and prove the rebuilt addon can create a
# raw WS_CHILD under its HWND without using an external mpv process.
$presenterSmoke = Join-Path $temp 'r32-native-presenter-smoke.cjs'
@'
const {app,BrowserWindow}=require('electron');
(async()=>{await app.whenReady();let win,id;try{win=new BrowserWindow({show:false,width:640,height:360,webPreferences:{backgroundThrottling:false}});const addon=require(process.env.LILAC_LIBMPV_PLAYER_ADDON);for(const name of ['configureNativePresenter','setNativePresenterVisible','nativePresenterStats'])if(typeof addon[name]!=='function')throw new Error(`missing ${name}`);const created=addon.createPlayer();id=Number(created.playerId);const raw=win.getNativeWindowHandle();const hwnd=(raw.length>=8?raw.readBigUInt64LE(0):BigInt(raw.readUInt32LE(0))).toString(10);if(addon.configureNativePresenter(id,hwnd)!==true)throw new Error('configureNativePresenter failed');const stats=addon.nativePresenterStats(id);if(!stats?.configured||stats.marker!=='LILAC_R32_NATIVE_HWND_FOCUS_SURFACE')throw new Error(`presenter not configured ${JSON.stringify(stats)}`);if(addon.setNativePresenterVisible(id,false)!==true)throw new Error('presenter visibility control failed');console.log(`R32_NATIVE_PRESENTER_SMOKE_OK configured=${stats.configured} deviceMode=${created.deviceMode}`);}finally{try{if(id)require(process.env.LILAC_LIBMPV_PLAYER_ADDON).destroyPlayer(id)}catch{}try{win?.destroy()}catch{}app.quit();}})().catch(e=>{console.error(e?.stack||e);process.exitCode=1;app.quit();});
'@ | Set-Content $presenterSmoke -Encoding utf8
& node_modules/.bin/electron.cmd $presenterSmoke
Assert-Exit 'R32 native presenter BrowserWindow smoke'
Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
'@
$patched = Replace-Once $patched $needle $replacement 'R32 inject native rebuild'

$needle = @'
if ((Sha256 $packedAddon) -ne $env:QUALIFIED_ADDON_SHA256 -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'R24 native payload drifted' }
'@
$replacement = @'
if ((Sha256 $packedAddon) -ne $env:R32_ADDON_SHA256) { throw 'R32 packaged addon hash mismatch' }
if ((Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'R32 packaged libmpv DLL drifted' }
'@
$patched = Replace-Once $patched $needle $replacement 'R32 packaged native hash gate'

$needle = @'
  nativeProducer = 'unchanged-r3e-native-callback-worker'
'@
$replacement = @'
  nativeProducer = 'r32-r3e-native-callback-worker-watchdog250+native-hwnd-focus-presenter'
'@
$patched = Replace-Once $patched $needle $replacement 'R32 manifest native producer'

# The R31 wrapper still labels its successful hash/size outputs. Rename them only
# after all inherited qualification logic has been generated.
$patched = Replace-Once $patched '"R31_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R32_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'R32 hash env'
$patched = Replace-Once $patched '"R31_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' '"R32_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append' 'R32 size env'
$patched = Replace-Once $patched 'Write-Host "R31_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=canvas2d-shield stateNativePollMs=1000 uiClock=wall-extrapolated managedRelease=1 producerWatchdogMs=250 backlog=newest-only"' 'Write-Host "R32_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) addonSha256=$env:R32_ADDON_SHA256 libmpvDllUnchanged=1 focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd flix=worker-thread nativeWatchdogMs=250 r31CanvasShield=disabled stateNativePollMs=1000"' 'R32 build marker'

$tempScript = Join-Path $env:RUNNER_TEMP 'r31-generated-build.ps1'
'@
$patched = Replace-Once $patched $injectBefore $injected 'R32 inject final generated-build patches'

$tempScript = Join-Path $env:RUNNER_TEMP 'r32-generated-meta-build.ps1'
Set-Content $tempScript $patched -Encoding utf8
& $tempScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

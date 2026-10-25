'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'scripts/r31-focus-compositor-state-coalesce-build.ps1');
const outputPath = process.argv[2];
if (!outputPath) throw new Error('output path required');
let source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  "  'scripts/r31-transform-anchor-normalize.cjs',\n  'scripts/r31-focus-compositor-state-coalesce-fix.cjs'\n)) {\n",
  "  'scripts/r31-transform-anchor-normalize.cjs',\n  'scripts/r31-focus-compositor-state-coalesce-fix.cjs',\n  'scripts/r32-flix-worker-native-focus-fix.cjs'\n)) {\n",
  'support list'
);
replaceOnce(
  "foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs','r30-managed-release-producer-drain-fix.cjs','r31-transform-anchor-normalize.cjs','r31-focus-compositor-state-coalesce-fix.cjs')) {",
  "foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs','r26-stall-boundary-fix.cjs','r27-focus-stall-retention-fix.cjs','r30-managed-release-producer-drain-fix.cjs','r31-transform-anchor-normalize.cjs','r31-focus-compositor-state-coalesce-fix.cjs','r32-flix-worker-native-focus-fix.cjs')) {",
  'restore list'
);
replaceOnce(
  "node scripts/r31-focus-compositor-state-coalesce-fix.cjs\nAssert-Exit 'R31 compositor/state patch'\n",
  "node scripts/r31-focus-compositor-state-coalesce-fix.cjs\nAssert-Exit 'R31 compositor/state patch'\nnode --check scripts/r32-flix-worker-native-focus-fix.cjs\nAssert-Exit 'R32 focus/stutter syntax'\nnode scripts/r32-flix-worker-native-focus-fix.cjs\nAssert-Exit 'R32 focus/stutter patch'\n",
  'apply R32'
);
replaceOnce(
  "Write-Host 'R31_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=canvas2d-shield shieldPrewarm=1of8 focusRecovery=2 stateNativePollMs=1000 uiClock=wall-extrapolated managedRelease=1'",
  String.raw`$nativeSource = Get-Content native/libmpv-d3d11-bridge/player_addon.cc -Raw
$flixSource = Get-Content electron/flix-proxy.cjs -Raw
if ($nativeSource -notmatch 'LILAC_R32_NATIVE_HWND_FOCUS_SURFACE' -or $nativeSource -notmatch 'R32PresentNativeFrame' -or $nativeSource -notmatch 'ConfigureNativePresenter' -or $nativeSource -notmatch 'std::chrono::milliseconds\(250\)') { throw 'R32 native presenter/watchdog source missing' }
if ($bridge -notmatch 'r32ConfigureNativePresenter' -or $bridge -notmatch 'r32ApplyNativePresenterFocus' -or $bridge -notmatch 'r32NativePresenter') { throw 'R32 native presenter bridge missing' }
if ($preload -notmatch 'const r31UseFocusShield = false' -or $preload -notmatch 'const r31MirrorNow = false') { throw 'R32 failed to disable R31 Canvas2D active path' }
if ($flixSource -notmatch 'LILAC_R32_FLIX_WORKER_ISOLATION' -or $flixSource -notmatch 'new Worker\(__filename' -or $flixSource -notmatch 'r32Rpc') { throw 'R32 Flix worker isolation missing' }
Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread nativeCallbackWatchdogMs=250 r31CanvasShield=disabled stateNativePollMs=1000'`,
  'R32 source gate'
);
replaceOnce(
  "if ($shipPreload -notmatch 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD' -or $shipPreload -notmatch 'data-lilac-libmpv-focus-shield' -or $shipPreload -notmatch 'r31DrawFocusShield') { throw 'packaged R31 focus shield missing' }",
  String.raw`if ($shipPreload -notmatch 'LILAC_R31_FOCUS_COMPOSITOR_SHIELD' -or $shipPreload -notmatch 'data-lilac-libmpv-focus-shield' -or $shipPreload -notmatch 'r31DrawFocusShield') { throw 'packaged R31 focus shield source missing' }
if ($shipPreload -notmatch 'const r31UseFocusShield = false' -or $shipPreload -notmatch 'R32_NATIVE_HWND_FOCUS_SURFACE') { throw 'packaged R32 native focus routing missing' }
$shipFlix = Get-Content (Join-Path $asarCheck 'electron\flix-proxy.cjs') -Raw
if ($shipFlix -notmatch 'LILAC_R32_FLIX_WORKER_ISOLATION' -or $shipFlix -notmatch 'new Worker\(__filename' -or $shipFlix -notmatch 'r32Rpc') { throw 'packaged R32 Flix worker isolation missing' }`,
  'R32 packaged JS gate'
);
replaceOnce(
  "  r31StateCoalesce = 'native-poll1000ms+renderer-wall-clock-extrapolation'\n  r23WindowRepairPreserved = $true",
  "  r31StateCoalesce = 'native-poll1000ms+renderer-wall-clock-extrapolation'\n  r32FocusPresenter = 'same-libmpv-d3d11-texture+native-ws-child-dxgi-unfocused'\n  r32FlixIsolation = 'worker-thread-loopback-server+no-segment-main-ipc'\n  r32NativeProducerWatchdog = 'callback-authoritative+250ms-native-watchdog'\n  r23WindowRepairPreserved = $true",
  'R32 manifest fields'
);

const injection = String.raw`
# R32 patches against the fully generated R30/R31 build body.
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

$presenterSmoke = Join-Path $temp 'r32-native-presenter-smoke.cjs'
@'
const {app,BrowserWindow}=require('electron');
(async()=>{await app.whenReady();let win,id,addon;try{win=new BrowserWindow({show:false,width:640,height:360,webPreferences:{backgroundThrottling:false}});addon=require(process.env.LILAC_LIBMPV_PLAYER_ADDON);for(const name of ['configureNativePresenter','setNativePresenterVisible','nativePresenterStats'])if(typeof addon[name]!=='function')throw new Error('missing '+name);const created=addon.createPlayer();id=Number(created.playerId);const raw=win.getNativeWindowHandle();const hwnd=(raw.length>=8?raw.readBigUInt64LE(0):BigInt(raw.readUInt32LE(0))).toString(10);if(addon.configureNativePresenter(id,hwnd)!==true)throw new Error('configureNativePresenter failed');const stats=addon.nativePresenterStats(id);if(!stats||!stats.configured||stats.marker!=='LILAC_R32_NATIVE_HWND_FOCUS_SURFACE')throw new Error('presenter not configured '+JSON.stringify(stats));if(addon.setNativePresenterVisible(id,false)!==true)throw new Error('presenter visibility control failed');console.log('R32_NATIVE_PRESENTER_SMOKE_OK configured='+stats.configured+' deviceMode='+created.deviceMode);}finally{try{if(id&&addon)addon.destroyPlayer(id)}catch{}try{if(win)win.destroy()}catch{}app.quit();}})().catch(e=>{console.error(e&&e.stack||e);process.exitCode=1;app.quit();});
'@ | Set-Content $presenterSmoke -Encoding utf8
& node_modules/.bin/electron.cmd $presenterSmoke
Assert-Exit 'R32 native presenter BrowserWindow smoke'
Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
'@
$patched = Replace-Once $patched $needle $replacement 'R32 native rebuild injection'

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

`;
replaceOnce("$tempScript = Join-Path $env:RUNNER_TEMP 'r31-generated-build.ps1'\n", injection + "$tempScript = Join-Path $env:RUNNER_TEMP 'r31-generated-build.ps1'\n", 'inject final build patches');
replaceOnce('"R31_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append', '"R32_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append', 'hash env');
replaceOnce('"R31_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append', '"R32_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append', 'size env');
replaceOnce(
  'Write-Host "R31_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest focusedPresenter=direct-webgpu unfocusedPresenter=canvas2d-shield stateNativePollMs=1000 uiClock=wall-extrapolated managedRelease=1 producerWatchdogMs=250 backlog=newest-only"',
  'Write-Host "R32_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) addonSha256=$env:R32_ADDON_SHA256 libmpvDllUnchanged=1 focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd flix=worker-thread nativeWatchdogMs=250 r31CanvasShield=disabled stateNativePollMs=1000"',
  'build marker'
);

fs.writeFileSync(outputPath, source, 'utf8');
console.log('R32_BUILD_META_GENERATOR_OK');

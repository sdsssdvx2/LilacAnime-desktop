$ErrorActionPreference = 'Stop'

function Assert-Exit([string]$label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
function Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Preserve R32-only support files because the qualified R31 builder reconstructs
# the product tree from pinned source/tooling commits before applying its patches.
$stash = Join-Path $env:RUNNER_TEMP 'lilac-r32-support'
Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stash | Out-Null
$r32Support = @(
  'r32-flix-worker-native-focus-fix.cjs',
  'r32-worker-unpack-fix.cjs',
  'r32-flix-worker-smoke.cjs',
  'r32-native-presenter-smoke.cjs'
)
foreach ($name in $r32Support) {
  $source = Join-Path 'scripts' $name
  if (-not (Test-Path $source)) { throw "R32 support file missing before R31 reconstruction: $name" }
  Copy-Item $source (Join-Path $stash $name) -Force
}
$producerSmokeStash = Join-Path $stash 'smoke-libmpv-r3e-native-producer.cjs'
if (Test-Path 'scripts/smoke-libmpv-r3e-native-producer.cjs') {
  Copy-Item 'scripts/smoke-libmpv-r3e-native-producer.cjs' $producerSmokeStash -Force
}

# Start from the already-qualified R31 product construction rather than nesting
# another meta-transform into the old build chain. R31 performs the exact pinned
# 0.5.54 reconstruction, R23/R24/R26/R27/R30/R31 patches, Electron API probe and
# baseline packaging. R32 is then applied to that concrete working tree.
& ./scripts/r31-focus-compositor-state-coalesce-build.ps1
Assert-Exit 'qualified R31 baseline build'

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach ($name in $r32Support) { Copy-Item (Join-Path $stash $name) (Join-Path 'scripts' $name) -Force }
if (-not (Test-Path 'scripts/smoke-libmpv-r3e-native-producer.cjs') -and (Test-Path $producerSmokeStash)) {
  Copy-Item $producerSmokeStash 'scripts/smoke-libmpv-r3e-native-producer.cjs' -Force
}
if (-not (Test-Path 'scripts/smoke-libmpv-r3e-native-producer.cjs')) { throw 'R32 producer smoke unavailable after R31 reconstruction' }

node --check scripts/r32-flix-worker-native-focus-fix.cjs
Assert-Exit 'R32 transform syntax'
node scripts/r32-flix-worker-native-focus-fix.cjs
Assert-Exit 'R32 transform'
node --check scripts/r32-worker-unpack-fix.cjs
Assert-Exit 'R32 worker unpack syntax'
node scripts/r32-worker-unpack-fix.cjs
Assert-Exit 'R32 worker unpack transform'
node scripts/r32-flix-worker-smoke.cjs
Assert-Exit 'R32 Flix worker RPC smoke'

$nativeSource = Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$bridge = Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$preload = Get-Content 'electron/libmpv-shared-preload.cjs' -Raw
$flix = Get-Content 'electron/flix-proxy.cjs' -Raw
if ($nativeSource -notmatch 'LILAC_R32_NATIVE_HWND_FOCUS_SURFACE' -or $nativeSource -notmatch 'R32PresentNativeFrame' -or $nativeSource -notmatch 'ConfigureNativePresenter' -or $nativeSource -notmatch 'std::chrono::milliseconds\(250\)') { throw 'R32 native focus/watchdog source gate failed' }
if ($bridge -notmatch 'r32ConfigureNativePresenter' -or $bridge -notmatch 'r32ApplyNativePresenterFocus' -or $bridge -notmatch 'r32NativePresenter') { throw 'R32 bridge focus routing source gate failed' }
if ($preload -notmatch 'const r31UseFocusShield = false' -or $preload -notmatch 'const r31MirrorNow = false' -or $preload -notmatch 'copyExternalImageToTexture') { throw 'R32 focused direct / disabled Canvas2D source gate failed' }
if ($preload -match 'LILAC_R28_FOCUS_SAFE_PLAYBACK' -or $preload -match 'copyTextureToTexture' -or $preload -match 'LILAC_R29_GPU_SAFE_LIFETIME' -or $preload -match 'subtle.*release') { throw 'failed renderer experiment survived R32' }
if ($preload -match 'requestAnimationFrame\(' -or $preload -match 'onSubmittedWorkDone\(') { throw 'R32 reintroduced forbidden renderer synchronization' }
if ($flix -notmatch 'LILAC_R32_FLIX_WORKER_ISOLATION' -or $flix -notmatch 'new Worker\(workerEntry' -or $flix -notmatch 'app\.asar\.unpacked' -or $flix -notmatch 'r32Rpc') { throw 'R32 Flix worker isolation source gate failed' }
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if (@($pkg.build.asarUnpack) -notcontains 'electron/flix-proxy.cjs') { throw 'R32 Flix worker is not configured for asarUnpack' }
Write-Host 'R32_SOURCE_GATES_OK focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd sameTexture=1 secondDecoder=0 flix=worker-thread+asar-unpacked nativeCallbackWatchdogMs=250 r31CanvasShield=disabled stateNativePollMs=1000'

# Rebuild only the N-API addon against Electron 44.9.3. The pinned libmpv DLL is
# preserved byte-for-byte. This intentionally changes the addon because R32 adds
# the native HWND presenter and native 250ms callback watchdog.
$temp = Join-Path $env:RUNNER_TEMP 'lilac-r32-native'
Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$archive = Join-Path $temp 'libmpv-sdk.7z'
$sdk = Join-Path $temp 'sdk'
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
if (-not (Test-Path 'node_modules/.bin/node-gyp.cmd')) {
  npm install --no-save --no-audit --no-fund node-gyp@12.2.0
  Assert-Exit 'R32 node-gyp install'
}
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R32 native addon rebuild'
$rebuiltAddon = 'native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if (-not (Test-Path $rebuiltAddon)) { throw 'R32 rebuilt addon missing' }
Copy-Item $rebuiltAddon 'electron/lilac-libmpv-player-bridge.node' -Force
$r32AddonSha = Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllSha = Sha256 'electron/libmpv-2.dll'
if ($r32AddonSha -eq $env:QUALIFIED_ADDON_SHA256) { throw 'R32 rebuilt addon unexpectedly equals the R23 addon hash' }
if ($dllSha -ne $env:QUALIFIED_DLL_SHA256) { throw 'R32 libmpv DLL drifted before runtime smoke' }
$env:R32_ADDON_SHA256 = $r32AddonSha
"R32_ADDON_SHA256=$r32AddonSha" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append

# The existing producer smoke proves callback-authoritative rendering continues
# through a 260ms synchronous JS block with the native fallback stretched to 250ms.
$env:LILAC_LIBMPV_PLAYER_ADDON = (Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL = (Resolve-Path 'electron/libmpv-2.dll').Path
$oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
try {
  & node_modules/.bin/electron.cmd scripts/smoke-libmpv-r3e-native-producer.cjs
  Assert-Exit 'R32 native producer callback smoke'
} finally {
  if ($null -eq $oldRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode }
}

# Stronger than a HWND-creation check: generate a real 640x360 media fixture,
# render it through libmpv's native producer, CopyResource the SAME TextureSlot to
# the raw child swapchain and require >=4 successful Present calls with no failure.
& node_modules/.bin/electron.cmd scripts/r32-native-presenter-smoke.cjs
Assert-Exit 'R32 native child HWND CopyResource/Present smoke'
Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue

# Force stable installed identity and the requested R32 artifact/version after the
# R31 baseline build, then package again with the rebuilt addon and unpacked worker.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$pkg.version = $env:APP_VERSION
$pkg.build.appId = $env:STABLE_APP_ID
$pkg.build.productName = $env:STABLE_PRODUCT_NAME
$pkg.build.win.executableName = $env:STABLE_EXE_BASE
$pkg.build.win.artifactName = $env:INSTALLER_NAME
$pkg | ConvertTo-Json -Depth 100 | Set-Content package.json -Encoding utf8
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64
Assert-Exit 'R32 final electron-builder package'
$installer = Join-Path 'dist' $env:INSTALLER_NAME
if (-not (Test-Path $installer)) { throw "R32 installer missing: $installer" }

# Inspect the real packaged app rather than trusting source-only markers.
$asarCli = 'node_modules/.bin/asar.cmd'
if (-not (Test-Path $asarCli)) {
  npm install --no-save --no-audit --no-fund @electron/asar@3.2.18
  Assert-Exit 'R32 asar helper install'
}
$asarCheck = Join-Path $temp 'asar-check'
Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $asarCheck | Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R32 packaged asar extract'
$shipBridge = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs') -Raw
$shipPreload = Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-preload.cjs') -Raw
if ($shipBridge -notmatch 'r32ConfigureNativePresenter' -or $shipBridge -notmatch 'r32NativePresenter') { throw 'packaged R32 native presenter bridge missing' }
if ($shipPreload -notmatch 'const r31UseFocusShield = false' -or $shipPreload -notmatch 'copyExternalImageToTexture') { throw 'packaged R32 focused direct / disabled shield routing missing' }
if ($shipPreload -match 'requestAnimationFrame\(' -or $shipPreload -match 'onSubmittedWorkDone\(' -or $shipPreload -match 'copyTextureToTexture') { throw 'packaged R32 forbidden renderer synchronization/staging survived' }
$unpackedFlix = 'dist/win-unpacked/resources/app.asar.unpacked/electron/flix-proxy.cjs'
if (-not (Test-Path $unpackedFlix)) { throw 'packaged R32 unpacked Flix worker entry missing' }
$shipFlix = Get-Content $unpackedFlix -Raw
if ($shipFlix -notmatch 'LILAC_R32_FLIX_WORKER_ISOLATION' -or $shipFlix -notmatch 'app\.asar\.unpacked' -or $shipFlix -notmatch 'new Worker\(workerEntry') { throw 'packaged R32 Flix worker routing missing' }
$packedAddon = 'dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node'
$packedDll = 'dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if (-not (Test-Path $packedAddon) -or -not (Test-Path $packedDll)) { throw 'packaged R32 native payload missing' }
if ((Sha256 $packedAddon) -ne $r32AddonSha) { throw 'packaged R32 addon hash mismatch' }
if ((Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'packaged R32 libmpv DLL hash mismatch' }

$hash = Sha256 $installer
$size = (Get-Item $installer).Length
$manifest = [ordered]@{
  version = $env:APP_VERSION
  qualifiedSourceSha = $env:QUALIFIED_SOURCE_SHA
  electron = $env:ELECTRON_VERSION
  installer = $env:INSTALLER_NAME
  installerSha256 = $hash
  installerSize = $size
  nativeAddon = $r32AddonSha
  nativeDll = $env:QUALIFIED_DLL_SHA256
  sharedTextureImport = 'function'
  sharedTextureSend = 'function'
  deliveryMode = 'serial-latest-frame-mailbox'
  inactiveCompositorGuard = $true
  cadenceHotpath = 'record-only-snapshot-4hz'
  r26BoundaryTrace = 'ring256-on-demand-main-dispatch-renderer-entry-getVideoFrame-gpu-copy-present-release'
  r27FocusStallRetention = 'anomaly64-threshold60-main+renderer-focus-visibility'
  r30ManagedReleaseProducerDrain = 'r27-renderer-byte-identical+managed-sync-token-release+producer-watchdog250+latest-backlog-collapse'
  r31StateCoalesce = 'native-poll1000ms+renderer-wall-clock-extrapolation'
  r32FocusPresenter = 'same-libmpv-d3d11-texture+native-ws-child-dxgi-unfocused'
  r32FlixIsolation = 'worker-thread-loopback-server+no-segment-main-ipc'
  r32NativeProducerWatchdog = 'callback-authoritative+250ms-native-watchdog'
  r32NativePresenterSmoke = 'real-media-copyresource-present>=4-zero-failure'
  r32FlixWorkerSmoke = 'prime-empty-worker-rpc'
  r31CanvasShieldActive = $false
  secondDecoder = $false
  cpuReadback = $false
  rafGate = $false
  gpuCompletionFence = $false
}
$manifestPath = Join-Path 'dist' $env:MANIFEST_NAME
$manifest | ConvertTo-Json -Depth 8 | Set-Content $manifestPath -Encoding utf8
"R32_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"R32_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "R32_BUILD_OK sha256=$hash size=$size electron=$env:ELECTRON_VERSION addonSha256=$r32AddonSha libmpvDllUnchanged=1 focusedPresenter=direct-webgpu unfocusedPresenter=native-child-hwnd flix=worker-thread+asar-unpacked nativeWatchdogMs=250 r31CanvasShield=disabled"

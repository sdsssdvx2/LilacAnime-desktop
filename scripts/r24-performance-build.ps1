$ErrorActionPreference = 'Stop'

function Sha256([string]$Path) { (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-Exit([string]$Label) { if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit $LASTEXITCODE" } }

$repo = $env:GITHUB_REPOSITORY
$temp = $env:RUNNER_TEMP
$support = Join-Path $temp 'r24-support'
New-Item -ItemType Directory -Force -Path $support | Out-Null
foreach ($item in @(
  'scripts/r23-render-window-fix.cjs',
  'scripts/r23-window-controller-smoke.cjs',
  'build/stable-installer-r23.nsh',
  'scripts/r24-cadence-hotpath-fix.cjs',
  'scripts/r24-focus-delivery-fix.cjs'
)) {
  if (!(Test-Path $item)) { throw "R24 support source missing: $item" }
  Copy-Item $item (Join-Path $support ([IO.Path]::GetFileName($item))) -Force
}

# Reconstruct the exact qualified 0.5.54/R3E product source. No upstream rebase.
git checkout --detach $env:QUALIFIED_SOURCE_SHA
Assert-Exit 'qualified source checkout'
if ((git rev-parse HEAD).Trim() -ne $env:QUALIFIED_SOURCE_SHA) { throw 'qualified source SHA mismatch' }
node --check scripts/r3f-054-r3e-map.cjs
Assert-Exit 'R3F map syntax'
node scripts/r3f-054-r3e-map.cjs
Assert-Exit 'R3F map reconstruction'

# R22 packaging-order fix is mandatory: install Electron 44 after mapping.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ([string]$pkg.devDependencies.electron -ne $env:ELECTRON_VERSION) { throw "mapped Electron request mismatch: $($pkg.devDependencies.electron)" }
npm install --no-audit --no-fund
Assert-Exit 'post-transform npm install'
$installedElectron = (node -p "require('electron/package.json').version").Trim()
if ($installedElectron -ne $env:ELECTRON_VERSION) { throw "installed Electron mismatch: $installedElectron" }

# Restore and apply R23 user-approved window/PiP repair first, then R24 performance-only changes.
New-Item -ItemType Directory -Force -Path build,scripts | Out-Null
Copy-Item (Join-Path $support 'stable-installer-r23.nsh') 'build/stable-installer-r23.nsh' -Force
foreach ($name in @('r23-render-window-fix.cjs','r23-window-controller-smoke.cjs','r24-cadence-hotpath-fix.cjs','r24-focus-delivery-fix.cjs')) {
  Copy-Item (Join-Path $support $name) (Join-Path 'scripts' $name) -Force
}
node scripts/r23-render-window-fix.cjs
Assert-Exit 'R23 render/window baseline patch'
node scripts/r23-window-controller-smoke.cjs
Assert-Exit 'R23 window controller smoke'
node scripts/r24-cadence-hotpath-fix.cjs
Assert-Exit 'R24 lazy cadence patch'
node scripts/r24-focus-delivery-fix.cjs
Assert-Exit 'R24 focus/delivery patch'

# Static source gates before packaging.
node --check electron/main.cjs
Assert-Exit 'main syntax'
node --check electron/libmpv-shared-main.cjs
Assert-Exit 'bridge syntax'
node --check electron/libmpv-shared-preload.cjs
Assert-Exit 'preload syntax'
$main = Get-Content electron/main.cjs -Raw
$bridge = Get-Content electron/libmpv-shared-main.cjs -Raw
$preload = Get-Content electron/libmpv-shared-preload.cjs -Raw
$cadence = Get-Content electron/libmpv-cadence.cjs -Raw
if ($main -notmatch 'LILAC_R24_INACTIVE_COMPOSITOR_GUARD' -or $main -notmatch 'disable-backgrounding-occluded-windows' -or $main -notmatch 'CalculateNativeWinOcclusion') { throw 'R24 inactive compositor guard missing' }
if ($bridge -notmatch 'LILAC_R24_LATEST_FRAME_MAILBOX' -or $bridge -notmatch 'deliveryCoalescedFrames' -or $bridge -notmatch 'enqueueImportedFrame\(delivery\)') { throw 'R24 latest-frame mailbox missing' }
if ($bridge -match 'async function deliverImportedFrame\(delivery\)' -or $bridge -match 'void deliverImportedFrame\(delivery\)') { throw 'R24 concurrent delivery path survived' }
if ($preload -notmatch 'LILAC_R24_CADENCE_LAZY' -or $preload -notmatch 'receiveCadenceTracker\.record' -or $preload -notmatch 'cadenceTracker\.record') { throw 'R24 lazy cadence preload missing' }
if ($preload -match 'lastReceiveCadence = receiveCadenceTracker\.add' -or $preload -match 'lastCadence = cadenceTracker\.add') { throw 'per-frame cadence snapshot survived' }
if ($preload -match 'onSubmittedWorkDone\(' -or $preload -match 'requestAnimationFrame\(') { throw 'forbidden renderer synchronization path survived' }
if ($cadence -notmatch 'return \{ add, record, snapshot, reset \}') { throw 'cheap cadence recorder export missing' }
Write-Host 'R24_SOURCE_GATES_OK nativeProducer=unchanged mailbox=serial-latest inactiveGuard=1 cadenceLazy=1 presenter=direct-webgpu'

# Reuse the independently qualified native payload. R24 must not change it.
$baseDir = Join-Path $temp 'r24-base'
$raw = Join-Path $baseDir 'raw'
$nested = Join-Path $baseDir 'nested'
New-Item -ItemType Directory -Force -Path $baseDir,$raw,$nested | Out-Null
gh release download $env:BASE_RELEASE_TAG --repo $repo --dir $baseDir --pattern $env:BASE_INSTALLER_NAME
Assert-Exit 'R23 base download'
$baseInstaller = Join-Path $baseDir $env:BASE_INSTALLER_NAME
if ((Sha256 $baseInstaller) -ne $env:BASE_INSTALLER_SHA256) { throw 'R23 base installer hash mismatch' }
7z.exe x $baseInstaller "-o$raw" -y | Out-Null
Assert-Exit 'R23 base extraction'
$i = 0
foreach ($archive in @(Get-ChildItem $raw -Recurse -File | Where-Object { $_.Name -match '(?i)(\.7z$|\.zip$)' } | Sort-Object Length -Descending)) {
  $i += 1
  $out = Join-Path $nested "a$i"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  7z.exe x $archive.FullName "-o$out" -y | Out-Null
}
$addon = Get-ChildItem @($raw,$nested) -Recurse -File -Filter 'lilac-libmpv-player-bridge.node' -ErrorAction SilentlyContinue | Select-Object -First 1
$dll = Get-ChildItem @($raw,$nested) -Recurse -File -Filter 'libmpv-2.dll' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $addon -or -not $dll) { throw 'qualified native payload not recoverable from R23' }
if ((Sha256 $addon.FullName) -ne $env:QUALIFIED_ADDON_SHA256) { throw 'qualified addon hash mismatch' }
if ((Sha256 $dll.FullName) -ne $env:QUALIFIED_DLL_SHA256) { throw 'qualified DLL hash mismatch' }
Copy-Item $addon.FullName electron/lilac-libmpv-player-bridge.node -Force
Copy-Item $dll.FullName electron/libmpv-2.dll -Force

# Keep stable product/update identity. Installer-path UX is intentionally not redesigned in R24.
@'
const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
if(p.name!=='lilacanime-desktop') throw new Error('profile package name changed');
if(p.devDependencies?.electron!==process.env.ELECTRON_VERSION) throw new Error('Electron request drifted');
p.version=process.env.APP_VERSION;
p.lilacCustomTag=process.env.RELEASE_TAG;
p.build=p.build||{};
p.build.appId=process.env.STABLE_APP_ID;
p.build.productName=process.env.STABLE_PRODUCT_NAME;
p.build.asarUnpack=Array.from(new Set([...(p.build.asarUnpack||[]),'electron/lilac-libmpv-player-bridge.node','electron/libmpv-2.dll']));
p.build.win=p.build.win||{};
p.build.win.executableName=process.env.STABLE_EXE_BASE;
p.build.win.target='nsis';
p.build.win.artifactName=process.env.INSTALLER_NAME.replace(/\.exe$/,'.${ext}');
p.build.nsis={...(p.build.nsis||{}),oneClick:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:'always',createStartMenuShortcut:true,shortcutName:process.env.STABLE_SHORTCUT_NAME,uninstallDisplayName:process.env.STABLE_PRODUCT_NAME,include:'build/stable-installer-r23.nsh'};
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
'@ | node
Assert-Exit 'R24 identity patch'

# Probe the actual Electron used to package the app.
$probeScript = Join-Path $temp 'r24-electron-api-probe.cjs'
@'
const {app,sharedTexture}=require('electron');
app.whenReady().then(()=>{const v=process.versions.electron;const ok=!!sharedTexture&&typeof sharedTexture.importSharedTexture==='function'&&typeof sharedTexture.sendSharedTexture==='function';console.log(`R24_ELECTRON_API_PROBE electron=${v} sharedTexture=${ok?1:0}`);if(v!==process.env.ELECTRON_VERSION||!ok)process.exitCode=31;app.quit();}).catch(e=>{console.error(e);process.exitCode=32;app.quit();});
'@ | Set-Content $probeScript -Encoding utf8
& npx.cmd electron $probeScript
Assert-Exit 'local Electron sharedTexture probe'

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& npx.cmd electron-builder --win nsis --publish never
Assert-Exit 'R24 NSIS build'
$installer = Get-ChildItem dist -File -Filter $env:INSTALLER_NAME | Select-Object -First 1
if (-not $installer -or $installer.Length -lt 10000000) { throw 'R24 installer missing' }

$unpacked = Get-ChildItem dist -Directory | Where-Object { $_.Name -match 'win.*unpacked' } | Select-Object -First 1
if (-not $unpacked) { throw 'R24 win-unpacked missing' }
$appExe = Join-Path $unpacked.FullName "$env:STABLE_EXE_BASE.exe"
$appAsar = Join-Path $unpacked.FullName 'resources\app.asar'
$packedAddon = Join-Path $unpacked.FullName 'resources\app.asar.unpacked\electron\lilac-libmpv-player-bridge.node'
$packedDll = Join-Path $unpacked.FullName 'resources\app.asar.unpacked\electron\libmpv-2.dll'
foreach ($p in @($appExe,$appAsar,$packedAddon,$packedDll)) { if (!(Test-Path $p)) { throw "packaged path missing: $p" } }
if ((Sha256 $packedAddon) -ne $env:QUALIFIED_ADDON_SHA256 -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'R24 native payload drifted' }

# Prove the exact shipped app.asar contains every R24 change.
$asarCheck = Join-Path $temp 'r24-asar-check'
& npx.cmd asar extract $appAsar $asarCheck
Assert-Exit 'R24 app.asar extraction'
$shipMain = Get-Content (Join-Path $asarCheck 'electron\main.cjs') -Raw
$shipBridge = Get-Content (Join-Path $asarCheck 'electron\libmpv-shared-main.cjs') -Raw
$shipPreload = Get-Content (Join-Path $asarCheck 'electron\preload-libmpv-shared.generated.cjs') -Raw
if ($shipMain -notmatch 'LILAC_R24_INACTIVE_COMPOSITOR_GUARD' -or $shipMain -notmatch 'CalculateNativeWinOcclusion') { throw 'packaged inactive guard missing' }
if ($shipBridge -notmatch 'LILAC_R24_LATEST_FRAME_MAILBOX' -or $shipBridge -notmatch 'deliveryCoalescedFrames') { throw 'packaged mailbox missing' }
if ($shipBridge -match 'async function deliverImportedFrame\(delivery\)') { throw 'packaged concurrent delivery helper survived' }
if ($shipPreload -notmatch 'LILAC_R24_CADENCE_LAZY' -or $shipPreload -notmatch 'receiveCadenceTracker\.record') { throw 'packaged lazy cadence missing' }
if ($shipPreload -match 'onSubmittedWorkDone\(' -or $shipPreload -match 'requestAnimationFrame\(') { throw 'packaged forbidden render sync survived' }

# Exact packaged Electron runtime probe by swapping only app.asar in a temporary copy.
$runtimeCopy = Join-Path $temp 'r24-runtime-copy'
Copy-Item $unpacked.FullName $runtimeCopy -Recurse -Force
$runtimeExe = Join-Path $runtimeCopy "$env:STABLE_EXE_BASE.exe"
$runtimeResources = Join-Path $runtimeCopy 'resources'
$probeDir = Join-Path $temp 'r24-probe-app'
$probeAsar = Join-Path $temp 'r24-probe.asar'
$probeOut = Join-Path $temp 'r24-packaged-runtime-probe.json'
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
'{"name":"r24-runtime-probe","version":"1.0.0","main":"main.cjs"}' | Set-Content (Join-Path $probeDir 'package.json') -Encoding utf8
@'
const fs=require('node:fs');const {app,sharedTexture}=require('electron');app.whenReady().then(()=>{fs.writeFileSync(process.env.LILAC_R24_RUNTIME_PROBE_OUT,JSON.stringify({electron:process.versions.electron,importType:typeof sharedTexture?.importSharedTexture,sendType:typeof sharedTexture?.sendSharedTexture}));app.quit();}).catch(e=>{fs.writeFileSync(process.env.LILAC_R24_RUNTIME_PROBE_OUT,JSON.stringify({error:String(e)}));app.quit();});
'@ | Set-Content (Join-Path $probeDir 'main.cjs') -Encoding utf8
& npx.cmd asar pack $probeDir $probeAsar
Assert-Exit 'R24 probe asar pack'
Copy-Item $probeAsar (Join-Path $runtimeResources 'app.asar') -Force
$env:LILAC_R24_RUNTIME_PROBE_OUT = $probeOut
$rp = Start-Process $runtimeExe -Wait -PassThru
Remove-Item Env:LILAC_R24_RUNTIME_PROBE_OUT -ErrorAction SilentlyContinue
if ($rp.ExitCode -ne 0 -or !(Test-Path $probeOut)) { throw "R24 packaged runtime probe failed exit=$($rp.ExitCode)" }
$runtimeProbe = Get-Content $probeOut -Raw | ConvertFrom-Json
if ($runtimeProbe.electron -ne $env:ELECTRON_VERSION -or $runtimeProbe.importType -ne 'function' -or $runtimeProbe.sendType -ne 'function') { throw 'R24 packaged runtime sharedTexture proof failed' }

$hash = Sha256 $installer.FullName
$size = $installer.Length
$manifest = [ordered]@{
  schema = 1
  tag = $env:RELEASE_TAG
  version = $env:APP_VERSION
  installer = $env:INSTALLER_NAME
  installerSha256 = $hash
  installerSize = $size
  electron = $runtimeProbe.electron
  sharedTextureImport = $runtimeProbe.importType
  sharedTextureSend = $runtimeProbe.sendType
  nativeAddonSha256 = (Sha256 $packedAddon)
  libmpvDllSha256 = (Sha256 $packedDll)
  nativeProducer = 'unchanged-r3e-native-callback-worker'
  presentationMode = 'direct-receive-webgpu-copy'
  deliveryMode = 'serial-latest-frame-mailbox'
  inactiveCompositorGuard = $true
  cadenceHotpath = 'record-only-snapshot-4hz'
  r23WindowRepairPreserved = $true
} | ConvertTo-Json -Depth 5
$manifest | Set-Content (Join-Path dist $env:MANIFEST_NAME) -Encoding utf8
"R24_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"R24_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "R24_BUILD_OK sha256=$hash size=$size electron=$($runtimeProbe.electron) nativeUnchanged=1 mailbox=serial-latest inactiveGuard=1 cadenceLazy=1"

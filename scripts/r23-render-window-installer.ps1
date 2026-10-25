$ErrorActionPreference = 'Stop'

function Sha256([string]$Path) { (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-Exit([string]$Label) { if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit $LASTEXITCODE" } }
function NormalizePath([string]$Path) { if (-not $Path) { return '' }; return [IO.Path]::GetFullPath($Path).TrimEnd('\') }

$repo = $env:GITHUB_REPOSITORY
$temp = $env:RUNNER_TEMP
$patchBackup = Join-Path $temp 'r23-render-window-fix.cjs'
$smokeBackup = Join-Path $temp 'r23-window-controller-smoke.cjs'
$hookBackup = Join-Path $temp 'stable-installer-r23.nsh'
Copy-Item 'scripts/r23-render-window-fix.cjs' $patchBackup -Force
Copy-Item 'scripts/r23-window-controller-smoke.cjs' $smokeBackup -Force
Copy-Item 'build/stable-installer-r23.nsh' $hookBackup -Force
foreach ($p in @($patchBackup,$smokeBackup,$hookBackup)) { if (!(Test-Path $p)) { throw "R23 support backup missing: $p" } }

# Reconstruct the exact R3F source used by R15/R22. Do not rebase product code.
git checkout --detach $env:QUALIFIED_SOURCE_SHA
Assert-Exit 'qualified source checkout'
if ((git rev-parse HEAD).Trim() -ne $env:QUALIFIED_SOURCE_SHA) { throw 'qualified source SHA mismatch' }
node --check scripts/r3f-054-r3e-map.cjs
Assert-Exit 'R3F map syntax'
node scripts/r3f-054-r3e-map.cjs
Assert-Exit 'R3F map reconstruction'

# Preserve the R22 runtime-order fix: reconcile dependencies after the mapping
# changes the app from upstream Electron 38 to Electron 44.9.3.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ([string]$pkg.devDependencies.electron -ne $env:ELECTRON_VERSION) { throw "mapped Electron request mismatch: $($pkg.devDependencies.electron)" }
npm install --no-audit --no-fund
Assert-Exit 'post-transform npm install'
$installedElectron = (node -p "require('electron/package.json').version").Trim()
if ($installedElectron -ne $env:ELECTRON_VERSION) { throw "installed Electron mismatch: $installedElectron" }
Write-Host "R23_ELECTRON_BASELINE_OK requested=$env:ELECTRON_VERSION installed=$installedElectron"

# Restore R23-only sources after the historical mapping checkout, apply the
# renderer/window patch, then run the window-state unit smoke.
New-Item -ItemType Directory -Force -Path build,scripts | Out-Null
Copy-Item $hookBackup 'build/stable-installer-r23.nsh' -Force
Copy-Item $patchBackup 'scripts/r23-render-window-fix.cjs' -Force
Copy-Item $smokeBackup 'scripts/r23-window-controller-smoke.cjs' -Force
node --check scripts/r23-render-window-fix.cjs
Assert-Exit 'R23 patch syntax'
node scripts/r23-render-window-fix.cjs
Assert-Exit 'R23 render/window patch'
node --check scripts/r23-window-controller-smoke.cjs
Assert-Exit 'R23 window smoke syntax'
node scripts/r23-window-controller-smoke.cjs
Assert-Exit 'R23 window controller smoke'

$preloadSource = Get-Content 'electron/libmpv-shared-preload.cjs' -Raw
$preloadBundle = Get-Content 'electron/preload-libmpv-shared.generated.cjs' -Raw
$windowCss = Get-Content 'src/window.css' -Raw
$miniController = Get-Content 'electron/miniplayer-window.cjs' -Raw
foreach ($text in @($preloadSource,$preloadBundle)) {
  if ($text -notmatch 'LILAC_R23_RENDER_HOTPATH' -or $text -notmatch 'RECEIVER_STATS_INTERVAL_MS' -or $text -notmatch 'copyExternalImageToTexture') { throw 'R23 render markers missing' }
  if ($text -match 'onSubmittedWorkDone\(' -or $text -match 'requestAnimationFrame\(') { throw 'R23 forbidden renderer synchronization marker survived' }
}
if ($windowCss -notmatch 'LILAC_R23_WINDOW_DRAG' -or $windowCss -notmatch 'body\.libmpv-mini-player \.immersive-player::before') { throw 'R23 drag strip missing' }
if ($miniController -notmatch "setAlwaysOnTop\?\.\(true, 'floating'\)" -or $miniController -notmatch "waitForWindowEvent\(win, 'unmaximize'\)") { throw 'R23 mini-player state repair missing' }
Write-Host 'R23_SOURCE_GATES_OK nativeProducer=unchanged presenter=direct-webgpu statsHz=4 gpuFence=off drag=1 topmost=1'

# Reuse only the independently qualified native addon/libmpv DLL bytes from R22.
$baseDir = Join-Path $temp 'r23-base'
$raw = Join-Path $baseDir 'raw'
$nested = Join-Path $baseDir 'nested'
New-Item -ItemType Directory -Force -Path $baseDir,$raw,$nested | Out-Null
gh release download $env:BASE_RELEASE_TAG --repo $repo --dir $baseDir --pattern $env:BASE_INSTALLER_NAME
Assert-Exit 'R22 base download'
$baseInstaller = Join-Path $baseDir $env:BASE_INSTALLER_NAME
if ((Sha256 $baseInstaller) -ne $env:BASE_INSTALLER_SHA256) { throw 'R22 base installer hash mismatch' }
7z.exe x $baseInstaller "-o$raw" -y | Out-Null
Assert-Exit 'R22 base extraction'
$i = 0
foreach ($archive in @(Get-ChildItem $raw -Recurse -File | Where-Object { $_.Name -match '(?i)(\.7z$|\.zip$)' } | Sort-Object Length -Descending)) {
  $i += 1
  $out = Join-Path $nested "a$i"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  7z.exe x $archive.FullName "-o$out" -y | Out-Null
}
$addon = Get-ChildItem @($raw,$nested) -Recurse -File -Filter 'lilac-libmpv-player-bridge.node' -ErrorAction SilentlyContinue | Select-Object -First 1
$dll = Get-ChildItem @($raw,$nested) -Recurse -File -Filter 'libmpv-2.dll' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $addon -or -not $dll) { throw 'qualified native payload not recoverable from R22' }
if ((Sha256 $addon.FullName) -ne $env:QUALIFIED_ADDON_SHA256) { throw 'qualified addon hash mismatch' }
if ((Sha256 $dll.FullName) -ne $env:QUALIFIED_DLL_SHA256) { throw 'qualified DLL hash mismatch' }
Copy-Item $addon.FullName electron/lilac-libmpv-player-bridge.node -Force
Copy-Item $dll.FullName electron/libmpv-2.dll -Force
Write-Host "R23_NATIVE_REUSE_OK addon=$env:QUALIFIED_ADDON_SHA256 dll=$env:QUALIFIED_DLL_SHA256"

# Release identity + assisted installer. The page is explicitly restored. The
# NSIS hook pins APP_FILENAME to LilacAnime-Libmpv so electron-builder cannot
# reintroduce the R2J/versioned nested directory name.
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
Assert-Exit 'R23 identity patch'

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkg.name -ne 'lilacanime-desktop' -or $pkg.version -ne $env:APP_VERSION -or $pkg.build.appId -ne $env:STABLE_APP_ID -or $pkg.build.nsis.include -ne 'build/stable-installer-r23.nsh') { throw 'R23 identity verification failed' }
if ($pkg.build.nsis.allowToChangeInstallationDirectory -ne $true) { throw 'R23 install directory page is not enabled' }
$hookText = Get-Content 'build/stable-installer-r23.nsh' -Raw
if ($hookText -notmatch '!define APP_FILENAME "LilacAnime-Libmpv"' -or $hookText -notmatch 'allowToChangeInstallationDirectory') { throw 'R23 stable directory-page guard missing' }
if ((node -p "require('electron/package.json').version").Trim() -ne $env:ELECTRON_VERSION) { throw 'Electron drifted after R23 identity patch' }
Write-Host 'R23_INSTALLER_UX_SOURCE_OK directoryPage=enabled appFilename=LilacAnime-Libmpv defaultStableFolder=1'

# Probe the actual local Electron used for packaging.
$probeScript = Join-Path $temp 'r23-electron-api-probe.cjs'
@'
const {app, sharedTexture}=require('electron');
app.whenReady().then(()=>{
  const v=process.versions.electron;
  const ok=!!sharedTexture && typeof sharedTexture.importSharedTexture==='function' && typeof sharedTexture.sendSharedTexture==='function';
  console.log(`R23_LOCAL_ELECTRON_API_PROBE electron=${v} sharedTexture=${ok?1:0}`);
  if(v!==process.env.ELECTRON_VERSION||!ok) process.exitCode=31;
  app.quit();
}).catch(e=>{console.error(e);process.exitCode=32;app.quit();});
'@ | Set-Content $probeScript -Encoding utf8
& npx.cmd electron $probeScript
Assert-Exit 'local Electron sharedTexture probe'

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
$env:DEBUG = 'electron-builder'
& npx.cmd electron-builder --win nsis --publish never
Assert-Exit 'R23 NSIS build'
Remove-Item Env:DEBUG -ErrorAction SilentlyContinue
$installer = Get-ChildItem dist -File -Filter $env:INSTALLER_NAME | Select-Object -First 1
if (-not $installer -or $installer.Length -lt 10000000) { throw 'R23 installer missing' }

$unpacked = Get-ChildItem dist -Directory | Where-Object { $_.Name -match 'win.*unpacked' } | Select-Object -First 1
if (-not $unpacked) { throw 'win-unpacked missing' }
$appExe = Join-Path $unpacked.FullName "$env:STABLE_EXE_BASE.exe"
$appAsar = Join-Path $unpacked.FullName 'resources\app.asar'
$packedAddon = Join-Path $unpacked.FullName 'resources\app.asar.unpacked\electron\lilac-libmpv-player-bridge.node'
$packedDll = Join-Path $unpacked.FullName 'resources\app.asar.unpacked\electron\libmpv-2.dll'
foreach ($p in @($appExe,$appAsar,$packedAddon,$packedDll)) { if (!(Test-Path $p)) { throw "packaged path missing: $p" } }
if ((Sha256 $packedAddon) -ne $env:QUALIFIED_ADDON_SHA256 -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'packaged native bytes changed' }
$shippingAsarHash = Sha256 $appAsar

# Prove the modified source actually reached app.asar, not only the working tree.
$asarCheck = Join-Path $temp 'r23-asar-check'
& npx.cmd asar extract $appAsar $asarCheck
Assert-Exit 'R23 app.asar extraction'
$shippedPreload = Get-Content (Join-Path $asarCheck 'electron\preload-libmpv-shared.generated.cjs') -Raw
$shippedWindowCss = Get-Content (Join-Path $asarCheck 'src\window.css') -Raw
$shippedMini = Get-Content (Join-Path $asarCheck 'electron\miniplayer-window.cjs') -Raw
if ($shippedPreload -notmatch 'LILAC_R23_RENDER_HOTPATH' -or $shippedPreload -match 'onSubmittedWorkDone\(' -or $shippedPreload -match 'requestAnimationFrame\(') { throw 'packaged R23 renderer hotpath proof failed' }
if ($shippedWindowCss -notmatch 'LILAC_R23_WINDOW_DRAG' -or $shippedMini -notmatch "setAlwaysOnTop\?\.\(true, 'floating'\)") { throw 'packaged R23 window repair proof failed' }
Write-Host "R23_PACKAGED_APP_OK asar=$shippingAsarHash rendererHotpath=1 drag=1 topmost=1 addon=$env:QUALIFIED_ADDON_SHA256 dll=$env:QUALIFIED_DLL_SHA256"

# Exact packaged Electron runtime probe (same strong guard introduced by R22).
$runtimeCopy = Join-Path $temp 'r23-runtime-copy'
Copy-Item $unpacked.FullName $runtimeCopy -Recurse -Force
$runtimeExe = Join-Path $runtimeCopy "$env:STABLE_EXE_BASE.exe"
$runtimeResources = Join-Path $runtimeCopy 'resources'
$probeDir = Join-Path $temp 'r23-probe-app'
$probeAsar = Join-Path $temp 'r23-probe.asar'
$probeOut = Join-Path $temp 'r23-packaged-runtime-probe.json'
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
'{"name":"r23-runtime-probe","version":"1.0.0","main":"main.cjs"}' | Set-Content (Join-Path $probeDir 'package.json') -Encoding utf8
@'
const fs=require('node:fs');
const {app,sharedTexture}=require('electron');
app.whenReady().then(()=>{
 const result={electron:process.versions.electron,hasSharedTexture:!!sharedTexture,importType:typeof sharedTexture?.importSharedTexture,sendType:typeof sharedTexture?.sendSharedTexture};
 fs.writeFileSync(process.env.LILAC_R23_RUNTIME_PROBE_OUT,JSON.stringify(result)); app.quit();
}).catch(e=>{fs.writeFileSync(process.env.LILAC_R23_RUNTIME_PROBE_OUT,JSON.stringify({error:String(e)}));app.quit();});
'@ | Set-Content (Join-Path $probeDir 'main.cjs') -Encoding utf8
& npx.cmd asar pack $probeDir $probeAsar
Assert-Exit 'R23 probe asar pack'
Copy-Item $probeAsar (Join-Path $runtimeResources 'app.asar') -Force
$env:LILAC_R23_RUNTIME_PROBE_OUT = $probeOut
$rp = Start-Process $runtimeExe -Wait -PassThru
Remove-Item Env:LILAC_R23_RUNTIME_PROBE_OUT -ErrorAction SilentlyContinue
if ($rp.ExitCode -ne 0 -or !(Test-Path $probeOut)) { throw "packaged runtime probe failed exit=$($rp.ExitCode)" }
$runtimeProbe = Get-Content $probeOut -Raw | ConvertFrom-Json
if ($runtimeProbe.electron -ne $env:ELECTRON_VERSION -or $runtimeProbe.importType -ne 'function' -or $runtimeProbe.sendType -ne 'function') { throw "packaged runtime lacks Electron 44 sharedTexture: $($runtimeProbe | ConvertTo-Json -Compress)" }
Write-Host "R23_PACKAGED_RUNTIME_API_OK electron=$($runtimeProbe.electron) sharedTexture=1"

# Extract the final installer and prove its runtime bytes too.
$verifyRaw = Join-Path $temp 'r23-installer-raw'
$verifyNested = Join-Path $temp 'r23-installer-nested'
New-Item -ItemType Directory -Force -Path $verifyRaw,$verifyNested | Out-Null
7z.exe x $installer.FullName "-o$verifyRaw" -y | Out-Null
Assert-Exit 'R23 installer outer extraction'
$i=0
foreach($archive in @(Get-ChildItem $verifyRaw -Recurse -File | Where-Object { $_.Name -match '(?i)(\.7z$|\.zip$)' } | Sort-Object Length -Descending)) {
  $i+=1; $out=Join-Path $verifyNested "a$i"; New-Item -ItemType Directory -Force -Path $out | Out-Null; 7z.exe x $archive.FullName "-o$out" -y | Out-Null
}
$installerAppDir=$null
foreach($candidate in @(Get-ChildItem @($verifyRaw,$verifyNested) -Recurse -File -Filter "$env:STABLE_EXE_BASE.exe" -ErrorAction SilentlyContinue)) {
  if(Test-Path (Join-Path $candidate.Directory.FullName 'resources\app.asar')) { $installerAppDir=$candidate.Directory.FullName; break }
}
if(-not $installerAppDir){throw 'R23 installer packaged app directory not found'}
$installerAsar=Join-Path $installerAppDir 'resources\app.asar'
$installerAddon=Join-Path $installerAppDir 'resources\app.asar.unpacked\electron\lilac-libmpv-player-bridge.node'
$installerDll=Join-Path $installerAppDir 'resources\app.asar.unpacked\electron\libmpv-2.dll'
if((Sha256 $installerAsar)-ne $shippingAsarHash){throw 'R23 installer app.asar differs from win-unpacked'}
if((Sha256 $installerAddon)-ne $env:QUALIFIED_ADDON_SHA256 -or (Sha256 $installerDll)-ne $env:QUALIFIED_DLL_SHA256){throw 'R23 installer native payload mismatch'}
$installerProbeDir=Join-Path $temp 'r23-installer-runtime-copy'
Copy-Item $installerAppDir $installerProbeDir -Recurse -Force
Copy-Item $probeAsar (Join-Path $installerProbeDir 'resources\app.asar') -Force
$installerProbeOut=Join-Path $temp 'r23-installer-runtime-probe.json'
$env:LILAC_R23_RUNTIME_PROBE_OUT=$installerProbeOut
$ip=Start-Process (Join-Path $installerProbeDir "$env:STABLE_EXE_BASE.exe") -Wait -PassThru
Remove-Item Env:LILAC_R23_RUNTIME_PROBE_OUT -ErrorAction SilentlyContinue
if($ip.ExitCode-ne 0 -or !(Test-Path $installerProbeOut)){throw "R23 installer runtime probe failed exit=$($ip.ExitCode)"}
$installerRuntimeProbe=Get-Content $installerProbeOut -Raw|ConvertFrom-Json
if($installerRuntimeProbe.electron-ne $env:ELECTRON_VERSION -or $installerRuntimeProbe.importType-ne 'function' -or $installerRuntimeProbe.sendType-ne 'function'){throw "R23 installer runtime lacks sharedTexture: $($installerRuntimeProbe|ConvertTo-Json -Compress)"}
Write-Host "R23_INSTALLER_RUNTIME_API_OK electron=$($installerRuntimeProbe.electron) sharedTexture=1 exactInstallerPayload=1"

# Real silent installer qualification. The interactive page is compile-enabled;
# silent updates skip UI but exercise customInit/customInstall and prove the exact
# stable path, launch target, shortcut and profile retention.
$installRoot = Join-Path $temp 'r23-install-root'
$expectedInstall = Join-Path $installRoot $env:STABLE_FOLDER_NAME
$expectedExe = Join-Path $expectedInstall "$env:STABLE_EXE_BASE.exe"
$dirProbe = Join-Path $temp 'r23-installdir.txt'
$launchProbe = Join-Path $temp 'r23-launch.txt'
$profileDir = Join-Path $env:APPDATA 'lilacanime-desktop'
$profileSentinel = Join-Path $profileDir 'r23-profile-retention-sentinel.txt'
New-Item -ItemType Directory -Force -Path $installRoot,$profileDir | Out-Null
'preserve-me' | Set-Content $profileSentinel -Encoding utf8
$env:LILAC_INSTALL_ROOT=$installRoot
$env:LILAC_R23_INSTALLDIR_PROBE=$dirProbe
$env:LILAC_R23_LAUNCH_PROBE=$launchProbe
$installProcess = Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($installProcess.ExitCode -ne 0) { throw "R23 silent install failed exit=$($installProcess.ExitCode)" }
foreach($v in 'LILAC_INSTALL_ROOT','LILAC_R23_INSTALLDIR_PROBE','LILAC_R23_LAUNCH_PROBE'){ Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
if (!(Test-Path $expectedExe)) { throw "R23 stable executable missing: $expectedExe" }
if (!(Test-Path $dirProbe) -or (NormalizePath (Get-Content $dirProbe -Raw).Trim()) -ne (NormalizePath $expectedInstall)) { throw 'R23 installer selected a nested/wrong directory' }
if (!(Test-Path $launchProbe) -or (NormalizePath (Get-Content $launchProbe -Raw).Trim()) -ne (NormalizePath $expectedExe)) { throw 'R23 finish launch target mismatch' }
if (!(Test-Path $profileSentinel)) { throw 'R23 install touched profile data' }
$startLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LilacAnime Libmpv.lnk'
if (!(Test-Path $startLink)) { throw 'R23 stable Start menu shortcut missing' }
$shell = New-Object -ComObject WScript.Shell
$linkTarget = $shell.CreateShortcut($startLink).TargetPath
if ((NormalizePath $linkTarget) -ne (NormalizePath $expectedExe)) { throw "R23 shortcut target mismatch: $linkTarget" }
Write-Host "R23_INSTALL_MIGRATION_OK path=$expectedInstall shortcut=$linkTarget profile=preserved directoryPage=enabled"

# Reinstall once to prove path/shortcut stability.
$env:LILAC_INSTALL_ROOT=$installRoot
$env:LILAC_R23_INSTALLDIR_PROBE=$dirProbe
$env:LILAC_R23_LAUNCH_PROBE=$launchProbe
$reinstallProcess = Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
foreach($v in 'LILAC_INSTALL_ROOT','LILAC_R23_INSTALLDIR_PROBE','LILAC_R23_LAUNCH_PROBE'){ Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
if ($reinstallProcess.ExitCode -ne 0 -or !(Test-Path $profileSentinel) -or !(Test-Path $expectedExe)) { throw 'R23 reinstall stability failed' }
$linkTarget2 = $shell.CreateShortcut($startLink).TargetPath
if ((NormalizePath $linkTarget2) -ne (NormalizePath $expectedExe)) { throw 'R23 reinstall shortcut drifted' }
Write-Host 'R23_REINSTALL_OK stablePath=1 stableShortcut=1 profile=preserved'

# Runner cleanup only; never invoke the app uninstaller because its normal user
# data cleanup is irrelevant to qualification and would erase our sentinel.
Remove-Item $expectedInstall -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $installRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $startLink -Force -ErrorAction SilentlyContinue
Remove-Item $profileSentinel -Force -ErrorAction SilentlyContinue

$hash=Sha256 $installer.FullName
$size=$installer.Length
$manifest=[ordered]@{
  schema=10; releaseTag=$env:RELEASE_TAG; installer=$env:INSTALLER_NAME; installerSha256=$hash; installerSize=[long]$size;
  version=$env:APP_VERSION; profilePackageName='lilacanime-desktop'; profileIdentity='unchanged';
  stableInstallFolder=$env:STABLE_FOLDER_NAME; stableShortcut=$env:STABLE_SHORTCUT_NAME; installDirectoryPage=$true; installerAppFilename='LilacAnime-Libmpv';
  electronRuntimeFix='R22-preserved'; requestedElectron=$env:ELECTRON_VERSION; installedBuilderElectron=$installedElectron; packagedRuntimeElectron=[string]$installerRuntimeProbe.electron;
  packagedSharedTextureImport=[string]$installerRuntimeProbe.importType; packagedSharedTextureSend=[string]$installerRuntimeProbe.sendType;
  rendererMode='direct-receive-webgpu-copy'; receiverStatsIntervalMs=250; gpuCompletionFenceSampling=$false; nativeProducer='unchanged-qualified-R3E';
  windowDrag='dedicated-windowed-and-mini-strip'; miniPlayerAlwaysOnTop='post-bounds-reapply-with-show-restore-pin';
  installerRuntimeProbe='exact-extracted-installer-payload-pass'; installerMigrationProbe='stable-path-shortcut-profile-pass';
  appAsarSha256=$shippingAsarHash; addonSha256=$env:QUALIFIED_ADDON_SHA256; dllSha256=$env:QUALIFIED_DLL_SHA256;
  sourceQualifiedCommit=$env:QUALIFIED_SOURCE_SHA
}
$manifest|ConvertTo-Json -Depth 5|Set-Content (Join-Path dist $env:MANIFEST_NAME) -Encoding utf8
"R23_INSTALLER_SHA256=$hash"|Out-File $env:GITHUB_ENV -Append -Encoding utf8
"R23_INSTALLER_SIZE=$size"|Out-File $env:GITHUB_ENV -Append -Encoding utf8
Write-Host "R23_MANIFEST_OK sha256=$hash size=$size electron=$($installerRuntimeProbe.electron) sharedTexture=1 rendererHotpath=1 windowRepair=1 directoryPage=1"

$ErrorActionPreference = 'Stop'

function Sha256([string]$Path) { (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-Exit([string]$Label) { if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit $LASTEXITCODE" } }

$repo = $env:GITHUB_REPOSITORY
$temp = $env:RUNNER_TEMP
$hookBackup = Join-Path $temp 'stable-installer-r21.nsh'
Copy-Item 'build/stable-installer-r21.nsh' $hookBackup -Force
if (!(Test-Path $hookBackup)) { throw 'stable installer hook backup failed' }

# Reconstruct the exact qualified R3F source. The mapping intentionally starts
# from upstream 0.5.54 and replays the qualified libmpv stack.
git checkout --detach $env:QUALIFIED_SOURCE_SHA
Assert-Exit 'qualified source checkout'
if ((git rev-parse HEAD).Trim() -ne $env:QUALIFIED_SOURCE_SHA) { throw 'qualified source SHA mismatch' }
node --check scripts/r3f-054-r3e-map.cjs
Assert-Exit 'R3F map syntax'
node scripts/r3f-054-r3e-map.cjs
Assert-Exit 'R3F map reconstruction'

# Root-cause fix: r3f-054-rebase-preflight runs npm ci BEFORE the R2G transform
# changes package.json to Electron 44.9.3. R2J ran npm install again afterwards;
# R15 did not. Force dependency reconciliation now and prove the installed runtime.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ([string]$pkg.devDependencies.electron -ne '44.9.3') {
  throw "mapped package did not request Electron 44.9.3: $($pkg.devDependencies.electron)"
}
npm install --no-audit --no-fund
Assert-Exit 'post-transform npm install'
$installedElectron = (node -p "require('electron/package.json').version").Trim()
if ($installedElectron -ne $env:ELECTRON_VERSION) { throw "installed Electron mismatch: $installedElectron" }
Write-Host "R22_DEPENDENCY_ORDER_FIX_OK requested=44.9.3 installed=$installedElectron"

# Restore the already-qualified stable installer UX hook after the historical
# checkout/mapping sequence replaced the working tree.
New-Item -ItemType Directory -Force -Path build | Out-Null
Copy-Item $hookBackup 'build/stable-installer-r21.nsh' -Force

# Reuse only the exact qualified native addon and libmpv DLL bytes from R21.
# R21's app runtime was wrong, but these native payload hashes were built for
# Electron 44.9.3 and were independently qualified in R15.
$baseDir = Join-Path $temp 'r22-base'
$raw = Join-Path $baseDir 'raw'
$nested = Join-Path $baseDir 'nested'
New-Item -ItemType Directory -Force -Path $baseDir,$raw,$nested | Out-Null
gh release download $env:BASE_RELEASE_TAG --repo $repo --dir $baseDir --pattern $env:BASE_INSTALLER_NAME
Assert-Exit 'R21 base download'
$baseInstaller = Join-Path $baseDir $env:BASE_INSTALLER_NAME
if ((Sha256 $baseInstaller) -ne $env:BASE_INSTALLER_SHA256) { throw 'R21 base installer hash mismatch' }
7z.exe x $baseInstaller "-o$raw" -y | Out-Null
Assert-Exit 'R21 base extraction'
$i = 0
foreach ($archive in @(Get-ChildItem $raw -Recurse -File | Where-Object { $_.Name -match '(?i)(\.7z$|\.zip$)' } | Sort-Object Length -Descending)) {
  $i += 1
  $out = Join-Path $nested "a$i"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  7z.exe x $archive.FullName "-o$out" -y | Out-Null
}
$addon = Get-ChildItem @($raw,$nested) -Recurse -File -Filter 'lilac-libmpv-player-bridge.node' -ErrorAction SilentlyContinue | Select-Object -First 1
$dll = Get-ChildItem @($raw,$nested) -Recurse -File -Filter 'libmpv-2.dll' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $addon -or -not $dll) { throw 'qualified native payload not recoverable from R21' }
if ((Sha256 $addon.FullName) -ne $env:QUALIFIED_ADDON_SHA256) { throw 'qualified addon hash mismatch' }
if ((Sha256 $dll.FullName) -ne $env:QUALIFIED_DLL_SHA256) { throw 'qualified DLL hash mismatch' }
Copy-Item $addon.FullName electron/lilac-libmpv-player-bridge.node -Force
Copy-Item $dll.FullName electron/libmpv-2.dll -Force
Write-Host "R22_NATIVE_REUSE_OK addon=$env:QUALIFIED_ADDON_SHA256 dll=$env:QUALIFIED_DLL_SHA256"

# Apply only release/install identity changes. Keep package name/profile identity.
@'
const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
if(p.name!=='lilacanime-desktop') throw new Error('profile package name changed');
if(p.devDependencies?.electron!=='44.9.3') throw new Error('Electron request drifted');
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
p.build.nsis={...(p.build.nsis||{}),oneClick:false,allowToChangeInstallationDirectory:false,createDesktopShortcut:'always',createStartMenuShortcut:true,shortcutName:process.env.STABLE_SHORTCUT_NAME,uninstallDisplayName:process.env.STABLE_PRODUCT_NAME,include:'build/stable-installer-r21.nsh'};
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
'@ | node
Assert-Exit 'R22 identity patch'

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkg.name -ne 'lilacanime-desktop' -or $pkg.version -ne $env:APP_VERSION -or $pkg.build.appId -ne $env:STABLE_APP_ID -or $pkg.build.nsis.include -ne 'build/stable-installer-r21.nsh') { throw 'R22 identity verification failed' }
if ((node -p "require('electron/package.json').version").Trim() -ne $env:ELECTRON_VERSION) { throw 'Electron drifted after identity patch' }

# Main-process API probe against the exact local Electron runtime used by builder.
$probeScript = Join-Path $temp 'r22-electron-api-probe.cjs'
@'
const {app, sharedTexture}=require('electron');
app.whenReady().then(()=>{
  const v=process.versions.electron;
  const ok=!!sharedTexture && typeof sharedTexture.importSharedTexture==='function' && typeof sharedTexture.sendSharedTexture==='function';
  console.log(`R22_LOCAL_ELECTRON_API_PROBE electron=${v} sharedTexture=${ok?1:0}`);
  if(v!=='44.9.3'||!ok) process.exitCode=31;
  app.quit();
}).catch(e=>{console.error(e);process.exitCode=32;app.quit();});
'@ | Set-Content $probeScript -Encoding utf8
& npx.cmd electron $probeScript
Assert-Exit 'local Electron sharedTexture probe'

# Build with the reconciled Electron 44.9.3 dependency.
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
$env:DEBUG = 'electron-builder'
& npx.cmd electron-builder --win nsis --publish never
Assert-Exit 'R22 NSIS build'
Remove-Item Env:DEBUG -ErrorAction SilentlyContinue
$installer = Get-ChildItem dist -File -Filter $env:INSTALLER_NAME | Select-Object -First 1
if (-not $installer -or $installer.Length -lt 10000000) { throw 'R22 installer missing' }

# Confirm packaged app code/native bytes and identify the unpacked runtime.
$unpacked = Get-ChildItem dist -Directory | Where-Object { $_.Name -match 'win.*unpacked' } | Select-Object -First 1
if (-not $unpacked) { throw 'win-unpacked missing' }
$appExe = Join-Path $unpacked.FullName "$env:STABLE_EXE_BASE.exe"
$appAsar = Join-Path $unpacked.FullName 'resources\app.asar'
$packedAddon = Join-Path $unpacked.FullName 'resources\app.asar.unpacked\electron\lilac-libmpv-player-bridge.node'
$packedDll = Join-Path $unpacked.FullName 'resources\app.asar.unpacked\electron\libmpv-2.dll'
foreach ($p in @($appExe,$appAsar,$packedAddon,$packedDll)) { if (!(Test-Path $p)) { throw "packaged path missing: $p" } }
if ((Sha256 $packedAddon) -ne $env:QUALIFIED_ADDON_SHA256 -or (Sha256 $packedDll) -ne $env:QUALIFIED_DLL_SHA256) { throw 'packaged native bytes changed' }
$shippingAsarHash = Sha256 $appAsar
Write-Host "R22_PACKAGED_NATIVE_OK asar=$shippingAsarHash addon=$env:QUALIFIED_ADDON_SHA256 dll=$env:QUALIFIED_DLL_SHA256"

# Strong proof: replace app.asar only in a COPY of win-unpacked with a tiny probe,
# then execute the exact packaged Electron EXE. This tests the shipped runtime,
# not npx Electron and not source metadata.
$runtimeCopy = Join-Path $temp 'r22-runtime-copy'
Copy-Item $unpacked.FullName $runtimeCopy -Recurse -Force
$runtimeExe = Join-Path $runtimeCopy "$env:STABLE_EXE_BASE.exe"
$runtimeResources = Join-Path $runtimeCopy 'resources'
$probeDir = Join-Path $temp 'r22-probe-app'
$probeAsar = Join-Path $temp 'r22-probe.asar'
$probeOut = Join-Path $temp 'r22-packaged-runtime-probe.json'
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
'{"name":"r22-runtime-probe","version":"1.0.0","main":"main.cjs"}' | Set-Content (Join-Path $probeDir 'package.json') -Encoding utf8
@'
const fs=require('node:fs');
const {app,sharedTexture}=require('electron');
app.whenReady().then(()=>{
 const result={electron:process.versions.electron,hasSharedTexture:!!sharedTexture,importType:typeof sharedTexture?.importSharedTexture,sendType:typeof sharedTexture?.sendSharedTexture};
 fs.writeFileSync(process.env.LILAC_R22_RUNTIME_PROBE_OUT,JSON.stringify(result));
 app.quit();
}).catch(e=>{fs.writeFileSync(process.env.LILAC_R22_RUNTIME_PROBE_OUT,JSON.stringify({error:String(e)}));app.quit();});
'@ | Set-Content (Join-Path $probeDir 'main.cjs') -Encoding utf8
& npx.cmd asar pack $probeDir $probeAsar
Assert-Exit 'probe asar pack'
Copy-Item $probeAsar (Join-Path $runtimeResources 'app.asar') -Force
$env:LILAC_R22_RUNTIME_PROBE_OUT = $probeOut
$rp = Start-Process $runtimeExe -Wait -PassThru
Remove-Item Env:LILAC_R22_RUNTIME_PROBE_OUT -ErrorAction SilentlyContinue
if ($rp.ExitCode -ne 0 -or !(Test-Path $probeOut)) { throw "packaged runtime probe failed exit=$($rp.ExitCode)" }
$runtimeProbe = Get-Content $probeOut -Raw | ConvertFrom-Json
if ($runtimeProbe.electron -ne $env:ELECTRON_VERSION -or $runtimeProbe.importType -ne 'function' -or $runtimeProbe.sendType -ne 'function') {
  throw "packaged runtime lacks Electron 44 sharedTexture: $($runtimeProbe | ConvertTo-Json -Compress)"
}
Write-Host "R22_PACKAGED_RUNTIME_API_OK electron=$($runtimeProbe.electron) import=$($runtimeProbe.importType) send=$($runtimeProbe.sendType)"

# Extract the final NSIS and run the same probe against the exact runtime bytes
# contained in the installer. This closes the gap that let R15 pass with a
# separate Electron 44 smoke binary while shipping another runtime.
$verifyRaw = Join-Path $temp 'r22-installer-raw'
$verifyNested = Join-Path $temp 'r22-installer-nested'
New-Item -ItemType Directory -Force -Path $verifyRaw,$verifyNested | Out-Null
7z.exe x $installer.FullName "-o$verifyRaw" -y | Out-Null
Assert-Exit 'R22 installer outer extraction'
$i=0
foreach($archive in @(Get-ChildItem $verifyRaw -Recurse -File | Where-Object { $_.Name -match '(?i)(\.7z$|\.zip$)' } | Sort-Object Length -Descending)) {
  $i+=1; $out=Join-Path $verifyNested "a$i"; New-Item -ItemType Directory -Force -Path $out | Out-Null; 7z.exe x $archive.FullName "-o$out" -y | Out-Null
}
$installerAppDir=$null
foreach($candidate in @(Get-ChildItem @($verifyRaw,$verifyNested) -Recurse -File -Filter "$env:STABLE_EXE_BASE.exe" -ErrorAction SilentlyContinue)) {
  if(Test-Path (Join-Path $candidate.Directory.FullName 'resources\app.asar')) { $installerAppDir=$candidate.Directory.FullName; break }
}
if(-not $installerAppDir){throw 'installer packaged app directory not found'}
$installerAsar=Join-Path $installerAppDir 'resources\app.asar'
$installerAddon=Join-Path $installerAppDir 'resources\app.asar.unpacked\electron\lilac-libmpv-player-bridge.node'
$installerDll=Join-Path $installerAppDir 'resources\app.asar.unpacked\electron\libmpv-2.dll'
if((Sha256 $installerAsar)-ne $shippingAsarHash){throw 'installer app.asar differs from win-unpacked shipping asar'}
if((Sha256 $installerAddon)-ne $env:QUALIFIED_ADDON_SHA256 -or (Sha256 $installerDll)-ne $env:QUALIFIED_DLL_SHA256){throw 'installer native payload mismatch'}
$installerProbeDir=Join-Path $temp 'r22-installer-runtime-copy'
Copy-Item $installerAppDir $installerProbeDir -Recurse -Force
Copy-Item $probeAsar (Join-Path $installerProbeDir 'resources\app.asar') -Force
$installerProbeOut=Join-Path $temp 'r22-installer-runtime-probe.json'
$env:LILAC_R22_RUNTIME_PROBE_OUT=$installerProbeOut
$ip=Start-Process (Join-Path $installerProbeDir "$env:STABLE_EXE_BASE.exe") -Wait -PassThru
Remove-Item Env:LILAC_R22_RUNTIME_PROBE_OUT -ErrorAction SilentlyContinue
if($ip.ExitCode-ne 0 -or !(Test-Path $installerProbeOut)){throw "installer runtime probe failed exit=$($ip.ExitCode)"}
$installerRuntimeProbe=Get-Content $installerProbeOut -Raw|ConvertFrom-Json
if($installerRuntimeProbe.electron-ne $env:ELECTRON_VERSION -or $installerRuntimeProbe.importType-ne 'function' -or $installerRuntimeProbe.sendType-ne 'function'){throw "installer runtime lacks sharedTexture: $($installerRuntimeProbe|ConvertTo-Json -Compress)"}
Write-Host "R22_INSTALLER_RUNTIME_API_OK electron=$($installerRuntimeProbe.electron) sharedTexture=1 exactInstallerPayload=1"

$hash=Sha256 $installer.FullName
$size=$installer.Length
$manifest=[ordered]@{
  schema=9; releaseTag=$env:RELEASE_TAG; installer=$env:INSTALLER_NAME; installerSha256=$hash; installerSize=[long]$size;
  version=$env:APP_VERSION; profilePackageName='lilacanime-desktop'; profileIdentity='unchanged';
  stableInstallFolder=$env:STABLE_FOLDER_NAME; stableShortcut=$env:STABLE_SHORTCUT_NAME;
  rootCause='post-transform-electron-dependency-not-reinstalled-in-r15';
  requestedElectron='44.9.3'; installedBuilderElectron=$installedElectron; packagedRuntimeElectron=[string]$installerRuntimeProbe.electron;
  packagedSharedTextureImport=[string]$installerRuntimeProbe.importType; packagedSharedTextureSend=[string]$installerRuntimeProbe.sendType;
  installerRuntimeProbe='exact-extracted-installer-payload-pass'; appAsarSha256=$shippingAsarHash;
  addonSha256=$env:QUALIFIED_ADDON_SHA256; dllSha256=$env:QUALIFIED_DLL_SHA256;
  sourceQualifiedCommit=$env:QUALIFIED_SOURCE_SHA; payloadQualification='R3F source replay plus exact installer Electron API probe'
}
$manifest|ConvertTo-Json -Depth 5|Set-Content (Join-Path dist $env:MANIFEST_NAME) -Encoding utf8
"R22_INSTALLER_SHA256=$hash"|Out-File $env:GITHUB_ENV -Append -Encoding utf8
"R22_INSTALLER_SIZE=$size"|Out-File $env:GITHUB_ENV -Append -Encoding utf8
Write-Host "R22_MANIFEST_OK sha256=$hash size=$size electron=$($installerRuntimeProbe.electron) sharedTexture=1"

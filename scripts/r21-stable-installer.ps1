$ErrorActionPreference = 'Stop'

function Sha256([string]$Path) { (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-PathEqual([string]$Actual,[string]$Expected,[string]$Message) {
  if ([IO.Path]::GetFullPath($Actual) -ne [IO.Path]::GetFullPath($Expected)) { throw "$Message actual=$Actual expected=$Expected" }
}

$repo=$env:GITHUB_REPOSITORY
$temp=$env:RUNNER_TEMP
$base=Join-Path $temp 'r21-base';$raw=Join-Path $base 'raw';$nested=Join-Path $base 'nested'
New-Item -ItemType Directory -Force -Path $base,$raw,$nested|Out-Null

gh release download $env:BASE_RELEASE_TAG --repo $repo --dir $base --pattern $env:BASE_INSTALLER_NAME
if($LASTEXITCODE-ne 0){throw 'base release download failed'}
$baseInstaller=Join-Path $base $env:BASE_INSTALLER_NAME
if((Sha256 $baseInstaller)-ne $env:BASE_INSTALLER_SHA256){throw 'base installer hash mismatch'}
7z.exe x $baseInstaller "-o$raw" -y|Out-Null
if($LASTEXITCODE-ne 0){throw 'base extraction failed'}
$i=0
foreach($archive in @(Get-ChildItem $raw -Recurse -File|Where-Object{$_.Name-match'(?i)(\.7z$|\.zip$)'}|Sort-Object Length -Descending)){
  $i++;$out=Join-Path $nested "a$i";New-Item -ItemType Directory -Force -Path $out|Out-Null;7z.exe x $archive.FullName "-o$out" -y|Out-Null
}
$appDir=$null;$appExe=$null
foreach($exe in @(Get-ChildItem @($raw,$nested) -Recurse -File -Filter '*.exe' -ErrorAction SilentlyContinue)){
  if(Test-Path (Join-Path $exe.Directory.FullName 'resources\app.asar')){$appDir=$exe.Directory.FullName;$appExe=$exe;break}
}
if(-not $appDir){throw 'prepackaged app not found'}
$asar=Join-Path $appDir 'resources\app.asar'
$addon=Get-ChildItem $appDir -Recurse -File -Filter 'lilac-libmpv-player-bridge.node'|Select-Object -First 1
$dll=Get-ChildItem $appDir -Recurse -File -Filter 'libmpv-2.dll'|Select-Object -First 1
if((Sha256 $appExe.FullName)-ne $env:BASE_APP_EXE_SHA256){throw 'app exe mismatch'}
if((Sha256 $asar)-ne $env:BASE_APP_ASAR_SHA256){throw 'app asar mismatch'}
if((Sha256 $addon.FullName)-ne $env:BASE_ADDON_SHA256){throw 'addon mismatch'}
if((Sha256 $dll.FullName)-ne $env:BASE_DLL_SHA256){throw 'dll mismatch'}
$exeBase=[IO.Path]::GetFileNameWithoutExtension($appExe.Name)
Write-Host "R21_BASE_PAYLOAD_OK exe=$(Sha256 $appExe.FullName) asar=$(Sha256 $asar) addon=$(Sha256 $addon.FullName) dll=$(Sha256 $dll.FullName)"

$patch=@'
const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
if(p.name!=='lilacanime-desktop') throw new Error('profile package name changed');
p.version=process.env.APP_VERSION;
p.build=p.build||{};
p.build.appId=process.env.STABLE_APP_ID;
p.build.productName=process.env.STABLE_PRODUCT_NAME;
p.build.win=p.build.win||{};
p.build.win.executableName=process.env.R21_EXE_BASE;
p.build.win.target='nsis';
p.build.win.artifactName='LilacAnime-Libmpv-R21-Setup.${ext}';
p.build.nsis={...(p.build.nsis||{}),oneClick:false,allowToChangeInstallationDirectory:false,createDesktopShortcut:'always',createStartMenuShortcut:true,shortcutName:process.env.STABLE_SHORTCUT_NAME,uninstallDisplayName:process.env.STABLE_PRODUCT_NAME,include:'build/stable-installer-r21.nsh'};
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
'@
$patchPath=Join-Path $temp 'r21-patch.cjs';Set-Content $patchPath $patch -Encoding utf8
$env:R21_EXE_BASE=$exeBase
node $patchPath
if($LASTEXITCODE-ne 0){throw 'package patch failed'}
$p=Get-Content package.json -Raw|ConvertFrom-Json
if($p.build.nsis.allowToChangeInstallationDirectory-ne $false){throw 'directory page enabled'}
if($p.build.nsis.include-ne 'build/stable-installer-r21.nsh'){throw 'R21 hook missing'}
$hook=Get-Content build/stable-installer-r21.nsh -Raw
foreach($marker in @('StrCpy $launchLink "$appExe"','taskkill.exe /F /T /IM','LILAC_R21_LAUNCH_PROBE')){if(-not $hook.Contains($marker)){throw "R21 hook marker missing: $marker"}}
Write-Host 'R21_POLICY_OK directoryPage=disabled finishLaunch=directAppExe legacyProcessTreeKill=1 cleanupVerified=1'

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
npx.cmd electron-builder --win nsis --prepackaged $appDir --publish never
if($LASTEXITCODE-ne 0){throw 'R21 build failed'}
$installer=Get-ChildItem dist -File -Filter $env:INSTALLER_NAME|Select-Object -First 1
if(-not $installer -or $installer.Length-lt 10000000){throw 'R21 installer missing'}

$verifyRaw=Join-Path $temp 'r21-verify-raw';$verifyNested=Join-Path $temp 'r21-verify-nested';New-Item -ItemType Directory -Force -Path $verifyRaw,$verifyNested|Out-Null
7z.exe x $installer.FullName "-o$verifyRaw" -y|Out-Null
$i=0
foreach($archive in @(Get-ChildItem $verifyRaw -Recurse -File|Where-Object{$_.Name-match'(?i)(\.7z$|\.zip$)'}|Sort-Object Length -Descending)){$i++;$out=Join-Path $verifyNested "a$i";New-Item -ItemType Directory -Force -Path $out|Out-Null;7z.exe x $archive.FullName "-o$out" -y|Out-Null}
$packedDir=$null;$packedExe=$null
foreach($exe in @(Get-ChildItem @($verifyRaw,$verifyNested) -Recurse -File -Filter '*.exe' -ErrorAction SilentlyContinue)){if(Test-Path (Join-Path $exe.Directory.FullName 'resources\app.asar')){$packedDir=$exe.Directory.FullName;$packedExe=$exe;break}}
if(-not $packedDir){throw 'packed app missing'}
$packedAddon=Get-ChildItem $packedDir -Recurse -File -Filter 'lilac-libmpv-player-bridge.node'|Select-Object -First 1
$packedDll=Get-ChildItem $packedDir -Recurse -File -Filter 'libmpv-2.dll'|Select-Object -First 1
if((Sha256 $packedExe.FullName)-ne $env:BASE_APP_EXE_SHA256){throw 'packed exe changed'}
if((Sha256 (Join-Path $packedDir 'resources\app.asar'))-ne $env:BASE_APP_ASAR_SHA256){throw 'packed asar changed'}
if((Sha256 $packedAddon.FullName)-ne $env:BASE_ADDON_SHA256){throw 'packed addon changed'}
if((Sha256 $packedDll.FullName)-ne $env:BASE_DLL_SHA256){throw 'packed dll changed'}
Write-Host 'R21_EXACT_APP_BYTES_OK'

# Build a real R2J payload source.
$test=Join-Path $temp 'r21-runtime-repair';$downloads=Join-Path $test 'downloads';$sourceLegacy=Join-Path $test 'source\LilacAnime-Libmpv-R2J-SubtitleFix';$backup=Join-Path $test 'legacy-backup';$root=Join-Path $test 'stable-root';$stable=Join-Path $root $env:STABLE_FOLDER_NAME
New-Item -ItemType Directory -Force -Path $downloads,$sourceLegacy,$root|Out-Null
gh release download $env:R2J_RELEASE_TAG --repo $repo --dir $downloads --pattern $env:R2J_INSTALLER_NAME
if($LASTEXITCODE-ne 0){throw 'R2J download failed'}
$oldInstaller=Join-Path $downloads $env:R2J_INSTALLER_NAME
if((Sha256 $oldInstaller)-ne $env:R2J_INSTALLER_SHA256){throw 'R2J hash mismatch'}
$proc=Start-Process $oldInstaller -ArgumentList @('/S',"/D=$sourceLegacy") -Wait -PassThru
if($proc.ExitCode-ne 0){throw 'R2J source install failed'}
$sourceOldExe=Get-ChildItem $sourceLegacy -File -Filter '*.exe'|Where-Object{$_.Name-notmatch'(?i)uninstall'}|Select-Object -First 1
if(-not $sourceOldExe -or $sourceOldExe.Name-ne 'LilacAnime-Libmpv-R2J-SubtitleFix.exe'){throw "unexpected R2J exe: $($sourceOldExe.Name)"}
Copy-Item $sourceLegacy $backup -Recurse -Force

$profile=Join-Path $env:APPDATA 'lilacanime-desktop';New-Item -ItemType Directory -Force -Path $profile|Out-Null
$sentinel=Join-Path $profile 'r21-profile-retention-sentinel.txt';$value="keep-$([guid]::NewGuid())";Set-Content $sentinel $value -NoNewline

# Establish the user's R20-like state: canonical registry/install is stable.
$noopLegacy=Join-Path $test 'noop\LilacAnime-Libmpv-R2J-SubtitleFix'
$env:LILAC_INSTALL_ROOT=$root;$env:LILAC_LEGACY_INSTALL_DIR=$noopLegacy
$proc=Start-Process $baseInstaller -ArgumentList '/S' -Wait -PassThru
if($proc.ExitCode-ne 0){throw 'R20 stable setup failed'}
$newExe=Join-Path $stable $appExe.Name
if(!(Test-Path $newExe)){throw 'stable executable missing after R20 setup'}
if((Get-Content $sentinel -Raw)-ne $value){throw 'profile changed during R20 setup'}

# Recreate a detached old folder and an actively running old-named process.
$legacy=Join-Path $test 'detached\LilacAnime-Libmpv-R2J-SubtitleFix';Copy-Item $backup $legacy -Recurse -Force
$detachedOldExe=Join-Path $legacy 'LilacAnime-Libmpv-R2J-SubtitleFix.exe'
if(!(Test-Path (Join-Path $legacy 'resources\app.asar'))-or !(Test-Path $detachedOldExe)){throw 'detached legacy recreation failed'}
Move-Item $detachedOldExe "$detachedOldExe.real" -Force
Copy-Item "$env:SystemRoot\System32\cmd.exe" $detachedOldExe -Force
$runningOld=Start-Process $detachedOldExe -ArgumentList @('/d','/c','ping -t 127.0.0.1') -PassThru
Start-Sleep -Milliseconds 800
$runningOld.Refresh();if($runningOld.HasExited){throw 'running legacy process simulation exited too early'}

$menu=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs';New-Item -ItemType Directory -Force -Path $menu|Out-Null
$stalePin=Join-Path $menu 'LilacAnime Legacy Pin Simulation.lnk';$canonical=Join-Path $menu 'LilacAnime Libmpv.lnk';$ws=New-Object -ComObject WScript.Shell
$sc=$ws.CreateShortcut($stalePin);$sc.TargetPath=$detachedOldExe;$sc.Save()
$probe=Join-Path $test 'finish-launch-target.txt';Remove-Item $probe -Force -ErrorAction SilentlyContinue

$env:LILAC_LEGACY_INSTALL_DIR=$legacy;$env:LILAC_R21_LAUNCH_PROBE=$probe
$proc=Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
if($proc.ExitCode-ne 0){throw "R21 detached repair failed $($proc.ExitCode)"}
$runningOld.Refresh();if(-not $runningOld.HasExited){Stop-Process -Id $runningOld.Id -Force -ErrorAction SilentlyContinue;throw 'R21 did not terminate running legacy process'}
if(Test-Path $legacy){throw 'running detached legacy folder survived R21'}
if(!(Test-Path $newExe)){throw 'stable executable missing after R21'}
if((Get-Content $sentinel -Raw)-ne $value){throw 'profile sentinel lost in R21'}
if(!(Test-Path $canonical)){throw 'canonical Start shortcut missing'}
$target=$ws.CreateShortcut($canonical).TargetPath;Assert-PathEqual $target $newExe 'canonical shortcut target mismatch'
if(!(Test-Path $probe)){throw 'finish launch probe missing'}
$launchTarget=(Get-Content $probe -Raw).Trim();Assert-PathEqual $launchTarget $newExe 'finish launch target is not canonical app exe'
$staleTarget=$ws.CreateShortcut($stalePin).TargetPath;if(Test-Path $staleTarget){throw 'stale pin target still executable'}
Write-Host "R21_RUNNING_DETACHED_REPAIR_OK legacyProcessKilled=1 legacyRemoved=1 finishLaunch=$launchTarget canonicalTarget=$target profileRetained=1"

# Reinstall must keep the canonical path and direct Finish launch invariant.
Remove-Item $probe -Force -ErrorAction SilentlyContinue
$proc=Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
if($proc.ExitCode-ne 0){throw 'R21 reinstall failed'}
if((Get-Content $sentinel -Raw)-ne $value){throw 'profile changed on R21 reinstall'}
if(Test-Path $legacy){throw 'legacy folder reappeared on reinstall'}
$target2=$ws.CreateShortcut($canonical).TargetPath;Assert-PathEqual $target2 $newExe 'canonical shortcut regressed on reinstall'
$launchTarget2=(Get-Content $probe -Raw).Trim();Assert-PathEqual $launchTarget2 $newExe 'finish launch target regressed on reinstall'
Write-Host 'R21_REINSTALL_STABLE_OK'

Remove-Item Env:LILAC_INSTALL_ROOT,Env:LILAC_LEGACY_INSTALL_DIR,Env:LILAC_R21_LAUNCH_PROBE -ErrorAction SilentlyContinue

$hash=Sha256 $installer.FullName;$size=$installer.Length
$manifest=[ordered]@{
 schema=8;releaseTag=$env:RELEASE_TAG;installer=$env:INSTALLER_NAME;installerSha256=$hash;installerSize=[long]$size;
 visibleProductName=$env:STABLE_PRODUCT_NAME;installFolder=$env:STABLE_FOLDER_NAME;startMenuShortcut=$env:STABLE_SHORTCUT_NAME;
 directorySelectionPage='disabled';finishLaunchPolicy='direct-current-appExe-not-shortcut';shortcutPolicy='force-recreate-to-current-appExe-after-install';
 runningDetachedLegacyRegression='real-r2j-folder-plus-running-old-named-process-pass';legacyProcessPolicy='taskkill-F-T-exact-r2j-image';legacyRemovalVerification='hard-fail-if-app-asar-survives';
 stalePinnedTarget='old-target-made-non-executable-by-verified-legacy-cleanup';profilePackageName='lilacanime-desktop';profileRetention='sentinel-pass';
 baseRelease=$env:BASE_RELEASE_TAG;baseAppExeSha256=$env:BASE_APP_EXE_SHA256;baseAppAsarSha256=$env:BASE_APP_ASAR_SHA256;addonSha256=$env:BASE_ADDON_SHA256;dllSha256=$env:BASE_DLL_SHA256;
 payloadQualification='byte-identical-to-qualified-r15-r20-app'
}
$manifest|ConvertTo-Json -Depth 4|Set-Content (Join-Path dist $env:MANIFEST_NAME) -Encoding utf8
"R21_INSTALLER_SHA256=$hash"|Out-File $env:GITHUB_ENV -Append -Encoding utf8
"R21_INSTALLER_SIZE=$size"|Out-File $env:GITHUB_ENV -Append -Encoding utf8
Write-Host "R21_MANIFEST_OK sha256=$hash size=$size"

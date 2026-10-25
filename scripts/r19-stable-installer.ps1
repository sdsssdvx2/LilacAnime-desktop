$ErrorActionPreference = 'Stop'

function Sha256([string]$Path) {
  (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$repo = $env:GITHUB_REPOSITORY
$temp = $env:RUNNER_TEMP
$base = Join-Path $temp 'r19-base'
$raw = Join-Path $base 'raw'
$nested = Join-Path $base 'nested'
New-Item -ItemType Directory -Force -Path $base,$raw,$nested | Out-Null

gh release download $env:BASE_RELEASE_TAG --repo $repo --dir $base --pattern $env:BASE_INSTALLER_NAME
if ($LASTEXITCODE -ne 0) { throw 'base release download failed' }
$baseInstaller = Join-Path $base $env:BASE_INSTALLER_NAME
if ((Sha256 $baseInstaller) -ne $env:BASE_INSTALLER_SHA256) { throw 'base installer hash mismatch' }

7z.exe x $baseInstaller "-o$raw" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'base installer extraction failed' }
$i = 0
foreach ($archive in @(Get-ChildItem $raw -Recurse -File | Where-Object { $_.Name -match '(?i)(\.7z$|\.zip$)' } | Sort-Object Length -Descending)) {
  $i++
  $out = Join-Path $nested "a$i"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  7z.exe x $archive.FullName "-o$out" -y | Out-Null
}
$appDir = $null
$appExe = $null
foreach ($exe in @(Get-ChildItem @($raw,$nested) -Recurse -File -Filter '*.exe' -ErrorAction SilentlyContinue)) {
  if (Test-Path (Join-Path $exe.Directory.FullName 'resources\app.asar')) {
    $appDir = $exe.Directory.FullName
    $appExe = $exe
    break
  }
}
if (-not $appDir) { throw 'prepackaged app not found' }
$asar = Join-Path $appDir 'resources\app.asar'
$addon = Get-ChildItem $appDir -Recurse -File -Filter 'lilac-libmpv-player-bridge.node' | Select-Object -First 1
$dll = Get-ChildItem $appDir -Recurse -File -Filter 'libmpv-2.dll' | Select-Object -First 1
if ((Sha256 $appExe.FullName) -ne $env:BASE_APP_EXE_SHA256) { throw 'app exe mismatch' }
if ((Sha256 $asar) -ne $env:BASE_APP_ASAR_SHA256) { throw 'app asar mismatch' }
if ((Sha256 $addon.FullName) -ne $env:BASE_ADDON_SHA256) { throw 'addon mismatch' }
if ((Sha256 $dll.FullName) -ne $env:BASE_DLL_SHA256) { throw 'dll mismatch' }
$exeBase = [IO.Path]::GetFileNameWithoutExtension($appExe.Name)
Write-Host "R19_BASE_PAYLOAD_OK exe=$(Sha256 $appExe.FullName) asar=$(Sha256 $asar) addon=$(Sha256 $addon.FullName) dll=$(Sha256 $dll.FullName)"

$patch = @'
const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
if(p.name!=='lilacanime-desktop') throw new Error('profile package name changed');
p.version=process.env.APP_VERSION;
p.build=p.build||{};
p.build.appId=process.env.STABLE_APP_ID;
p.build.productName=process.env.STABLE_PRODUCT_NAME;
p.build.win=p.build.win||{};
p.build.win.executableName=process.env.R19_EXE_BASE;
p.build.win.target='nsis';
p.build.win.artifactName='LilacAnime-Libmpv-R19-Setup.${ext}';
p.build.nsis={...(p.build.nsis||{}),oneClick:false,allowToChangeInstallationDirectory:false,createDesktopShortcut:'always',createStartMenuShortcut:true,shortcutName:process.env.STABLE_SHORTCUT_NAME,uninstallDisplayName:process.env.STABLE_PRODUCT_NAME,include:'build/stable-installer-r19.nsh'};
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
'@
$patchPath = Join-Path $temp 'r19-patch.cjs'
Set-Content $patchPath $patch -Encoding utf8
$env:R19_EXE_BASE = $exeBase
node $patchPath
if ($LASTEXITCODE -ne 0) { throw 'package metadata patch failed' }
$p = Get-Content package.json -Raw | ConvertFrom-Json
if ($p.build.nsis.allowToChangeInstallationDirectory -ne $false) { throw 'directory page enabled' }
if ($p.build.nsis.include -ne 'build/stable-installer-r19.nsh') { throw 'R19 hook missing' }
Write-Host "R19_POLICY_OK directoryPage=disabled stableFolder=$env:STABLE_FOLDER_NAME shortcutRetarget=forced"

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
npx.cmd electron-builder --win nsis --prepackaged $appDir --publish never
if ($LASTEXITCODE -ne 0) { throw 'R19 build failed' }
$installer = Get-ChildItem dist -File -Filter $env:INSTALLER_NAME | Select-Object -First 1
if (-not $installer -or $installer.Length -lt 10000000) { throw 'R19 installer missing' }

$verifyRaw = Join-Path $temp 'r19-verify-raw'
$verifyNested = Join-Path $temp 'r19-verify-nested'
New-Item -ItemType Directory -Force -Path $verifyRaw,$verifyNested | Out-Null
7z.exe x $installer.FullName "-o$verifyRaw" -y | Out-Null
$i = 0
foreach ($archive in @(Get-ChildItem $verifyRaw -Recurse -File | Where-Object { $_.Name -match '(?i)(\.7z$|\.zip$)' } | Sort-Object Length -Descending)) {
  $i++
  $out = Join-Path $verifyNested "a$i"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  7z.exe x $archive.FullName "-o$out" -y | Out-Null
}
$packedDir = $null
$packedExe = $null
foreach ($exe in @(Get-ChildItem @($verifyRaw,$verifyNested) -Recurse -File -Filter '*.exe' -ErrorAction SilentlyContinue)) {
  if (Test-Path (Join-Path $exe.Directory.FullName 'resources\app.asar')) { $packedDir=$exe.Directory.FullName; $packedExe=$exe; break }
}
if (-not $packedDir) { throw 'packed app not found' }
$packedAddon = Get-ChildItem $packedDir -Recurse -File -Filter 'lilac-libmpv-player-bridge.node' | Select-Object -First 1
$packedDll = Get-ChildItem $packedDir -Recurse -File -Filter 'libmpv-2.dll' | Select-Object -First 1
if ((Sha256 $packedExe.FullName) -ne $env:BASE_APP_EXE_SHA256) { throw 'packed exe changed' }
if ((Sha256 (Join-Path $packedDir 'resources\app.asar')) -ne $env:BASE_APP_ASAR_SHA256) { throw 'packed asar changed' }
if ((Sha256 $packedAddon.FullName) -ne $env:BASE_ADDON_SHA256) { throw 'packed addon changed' }
if ((Sha256 $packedDll.FullName) -ne $env:BASE_DLL_SHA256) { throw 'packed dll changed' }
Write-Host 'R19_EXACT_APP_BYTES_OK'

$migrate = Join-Path $temp 'r19-migrate'
$downloads = Join-Path $migrate 'downloads'
$legacy = Join-Path $migrate 'legacy\LilacAnime-Libmpv-R2J-SubtitleFix'
$root = Join-Path $migrate 'stable-root'
$stable = Join-Path $root $env:STABLE_FOLDER_NAME
New-Item -ItemType Directory -Force -Path $downloads,$legacy,$root | Out-Null

gh release download $env:R2J_RELEASE_TAG --repo $repo --dir $downloads --pattern $env:R2J_INSTALLER_NAME
if ($LASTEXITCODE -ne 0) { throw 'R2J download failed' }
$oldInstaller = Join-Path $downloads $env:R2J_INSTALLER_NAME
if ((Sha256 $oldInstaller) -ne $env:R2J_INSTALLER_SHA256) { throw 'R2J hash mismatch' }
$proc = Start-Process $oldInstaller -ArgumentList @('/S',"/D=$legacy") -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw "R2J install failed $($proc.ExitCode)" }
$oldExe = Get-ChildItem $legacy -File -Filter '*.exe' | Where-Object { $_.Name -notmatch '(?i)uninstall' } | Select-Object -First 1
if (-not $oldExe) { throw 'R2J executable missing' }

$menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Force -Path $menu | Out-Null
$oldLink = Join-Path $menu 'LilacAnime Libmpv R2J Subtitle Fix.lnk'
$newLink = Join-Path $menu 'LilacAnime Libmpv.lnk'
$ws = New-Object -ComObject WScript.Shell
Remove-Item $oldLink,$newLink -Force -ErrorAction SilentlyContinue
$shortcut = $ws.CreateShortcut($oldLink)
$shortcut.TargetPath = $oldExe.FullName
$shortcut.Save()

$profile = Join-Path $env:APPDATA 'lilacanime-desktop'
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$sentinel = Join-Path $profile 'r19-profile-retention-sentinel.txt'
$value = "keep-$([guid]::NewGuid())"
Set-Content $sentinel $value -NoNewline

$env:LILAC_INSTALL_ROOT = $root
$proc = Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw "R19 migration failed $($proc.ExitCode)" }
$newExe = Join-Path $stable $appExe.Name
if (!(Test-Path $newExe)) { throw 'stable executable missing' }
if (Test-Path $legacy) { throw 'legacy folder survived' }
if (!(Test-Path $sentinel) -or (Get-Content $sentinel -Raw) -ne $value) { throw 'profile sentinel lost' }
if (!(Test-Path $newLink)) { throw 'new Start shortcut missing' }
$target = $ws.CreateShortcut($newLink).TargetPath
if ([IO.Path]::GetFullPath($target) -ne [IO.Path]::GetFullPath($newExe)) { throw "stale shortcut survived: $target" }
if (Test-Path $oldLink) { throw 'old Start shortcut survived' }
$desktop = [Environment]::GetFolderPath('Desktop')
$desktopLink = Join-Path $desktop 'LilacAnime Libmpv.lnk'
if (!(Test-Path $desktopLink)) { throw 'desktop shortcut missing' }
$desktopTarget = $ws.CreateShortcut($desktopLink).TargetPath
if ([IO.Path]::GetFullPath($desktopTarget) -ne [IO.Path]::GetFullPath($newExe)) { throw "desktop shortcut mismatch: $desktopTarget" }

$proc = Start-Process $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw 'R19 reinstall failed' }
$target2 = $ws.CreateShortcut($newLink).TargetPath
if ([IO.Path]::GetFullPath($target2) -ne [IO.Path]::GetFullPath($newExe)) { throw 'shortcut target regressed on reinstall' }
if ((Get-Content $sentinel -Raw) -ne $value) { throw 'profile changed on reinstall' }
Remove-Item Env:LILAC_INSTALL_ROOT -ErrorAction SilentlyContinue
Write-Host "R19_STALE_SHORTCUT_REGRESSION_OK oldTarget=$($oldExe.FullName) newTarget=$target profileRetained=1 oldFolderRemoved=1 reinstallStable=1"

$hash = Sha256 $installer.FullName
$size = $installer.Length
$manifest = [ordered]@{
  schema = 6
  releaseTag = $env:RELEASE_TAG
  installer = $env:INSTALLER_NAME
  installerSha256 = $hash
  installerSize = [long]$size
  visibleProductName = $env:STABLE_PRODUCT_NAME
  installFolder = $env:STABLE_FOLDER_NAME
  startMenuShortcut = $env:STABLE_SHORTCUT_NAME
  directorySelectionPage = 'disabled'
  shortcutPolicy = 'force-recreate-to-current-appExe-after-install'
  staleShortcutRegression = 'real-r2j-old-target-forced-pass'
  profilePackageName = 'lilacanime-desktop'
  profileRetention = 'real-r2j-upgrade-sentinel-pass'
  legacyInstallCleanup = 'real-r2j-old-folder-removed'
  baseRelease = $env:BASE_RELEASE_TAG
  baseAppExeSha256 = $env:BASE_APP_EXE_SHA256
  baseAppAsarSha256 = $env:BASE_APP_ASAR_SHA256
  addonSha256 = $env:BASE_ADDON_SHA256
  dllSha256 = $env:BASE_DLL_SHA256
  payloadQualification = 'byte-identical-to-qualified-r15-r18-app'
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path dist $env:MANIFEST_NAME) -Encoding utf8
"R19_INSTALLER_SHA256=$hash" | Out-File $env:GITHUB_ENV -Append -Encoding utf8
"R19_INSTALLER_SIZE=$size" | Out-File $env:GITHUB_ENV -Append -Encoding utf8
Write-Host "R19_MANIFEST_OK sha256=$hash size=$size"

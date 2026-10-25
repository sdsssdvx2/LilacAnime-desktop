$ErrorActionPreference='Stop'

function NormalizePath([string]$Path){ if(-not $Path){return ''}; [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function FindInstallInfoKey([string]$InstallLocation){
  foreach($root in @('HKCU:\Software','HKLM:\Software')){
    if(!(Test-Path $root)){continue}
    foreach($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue)){
      try{$p=Get-ItemProperty $key.PSPath -ErrorAction Stop}catch{continue}
      if($p.PSObject.Properties.Name -contains 'InstallLocation'){
        if((NormalizePath ([string]$p.InstallLocation)) -eq (NormalizePath $InstallLocation)){return $key.PSPath}
      }
    }
  }
  return $null
}
function FindUninstallKey(){
  foreach($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')){
    if(!(Test-Path $root)){continue}
    foreach($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue)){
      try{$p=Get-ItemProperty $key.PSPath -ErrorAction Stop}catch{continue}
      if([string]$p.DisplayName -eq $env:STABLE_PRODUCT_NAME){return $key.PSPath}
    }
  }
  return $null
}

$temp=$env:RUNNER_TEMP
$installer=Join-Path (Join-Path $env:GITHUB_WORKSPACE 'dist') $env:INSTALLER_NAME
if(!(Test-Path $installer)){throw 'R23 installer missing for nested migration smoke'}
$root=Join-Path $temp 'r23-install-root'
$stable=Join-Path $root $env:STABLE_FOLDER_NAME
$nested=Join-Path $stable 'LilacAnime-Libmpv-R2J-SubtitleFix'
$stableExe=Join-Path $stable "$env:STABLE_EXE_BASE.exe"
$nestedExe=Join-Path $nested "$env:STABLE_EXE_BASE.exe"
$dirProbe=Join-Path $temp 'r23-nested-dir.txt'
$launchProbe=Join-Path $temp 'r23-nested-launch.txt'
$profileDir=Join-Path $env:APPDATA 'lilacanime-desktop'
$sentinel=Join-Path $profileDir 'r23-nested-profile-sentinel.txt'
$startLink=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LilacAnime Libmpv.lnk'

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $root,$profileDir|Out-Null
'nested-preserve-me'|Set-Content $sentinel -Encoding utf8

# First produce a valid stable installation and its real registry records.
$env:LILAC_INSTALL_ROOT=$root
$p=Start-Process $installer -ArgumentList '/S' -Wait -PassThru
Remove-Item Env:LILAC_INSTALL_ROOT -ErrorAction SilentlyContinue
if($p.ExitCode-ne 0 -or !(Test-Path $stableExe)){throw "R23 seed install failed exit=$($p.ExitCode)"}
$installKey=FindInstallInfoKey $stable
$uninstallKey=FindUninstallKey
if(-not $installKey){throw 'could not locate electron-builder install registry key'}
if(-not $uninstallKey){throw 'could not locate electron-builder uninstall registry key'}

# Reproduce the user's real state: the executable tree lives one level deeper in
# a historical R2J folder and both registry + shortcut point there.
$stage=Join-Path $temp 'r23-nested-stage'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Move-Item $stable $stage
New-Item -ItemType Directory -Force -Path $stable|Out-Null
Move-Item $stage $nested
if(!(Test-Path $nestedExe)){throw 'failed to construct nested R2J app tree'}
Set-ItemProperty -Path $installKey -Name InstallLocation -Value $nested
$nestedUninstaller=Join-Path $nested "Uninstall $env:STABLE_EXE_BASE.exe"
if(Test-Path $nestedUninstaller){
  Set-ItemProperty -Path $uninstallKey -Name UninstallString -Value ('"'+$nestedUninstaller+'" /currentuser')
  Set-ItemProperty -Path $uninstallKey -Name QuietUninstallString -Value ('"'+$nestedUninstaller+'" /currentuser /S')
}
$shell=New-Object -ComObject WScript.Shell
if(Test-Path $startLink){
  $lnk=$shell.CreateShortcut($startLink);$lnk.TargetPath=$nestedExe;$lnk.WorkingDirectory=$nested;$lnk.Save()
}
if((NormalizePath ((Get-ItemProperty $installKey).InstallLocation))-ne (NormalizePath $nested)){throw 'nested registry reproduction failed'}
Write-Host "R23_NESTED_REPRO_OK install=$nested registry=1 staleShortcut=1"

# This is the important path: same silent install style used by the in-app updater.
$env:LILAC_INSTALL_ROOT=$root
$env:LILAC_R23_INSTALLDIR_PROBE=$dirProbe
$env:LILAC_R23_LAUNCH_PROBE=$launchProbe
$p2=Start-Process $installer -ArgumentList '/S','--updated' -Wait -PassThru
foreach($v in 'LILAC_INSTALL_ROOT','LILAC_R23_INSTALLDIR_PROBE','LILAC_R23_LAUNCH_PROBE'){Remove-Item "Env:$v" -ErrorAction SilentlyContinue}
if($p2.ExitCode-ne 0){throw "R23 nested migration install failed exit=$($p2.ExitCode)"}
if(!(Test-Path $stableExe)){throw "R23 did not migrate executable to stable parent: $stableExe"}
if(!(Test-Path $dirProbe) -or (NormalizePath (Get-Content $dirProbe -Raw).Trim()) -ne (NormalizePath $stable)){throw 'R23 nested migration selected wrong install directory'}
if(!(Test-Path $launchProbe) -or (NormalizePath (Get-Content $launchProbe -Raw).Trim()) -ne (NormalizePath $stableExe)){throw 'R23 nested migration launch target stayed stale'}
if(!(Test-Path $sentinel)){throw 'R23 nested migration touched profile data'}
if(!(Test-Path $startLink)){throw 'R23 nested migration lost stable shortcut'}
$target=$shell.CreateShortcut($startLink).TargetPath
if((NormalizePath $target)-ne (NormalizePath $stableExe)){throw "R23 nested migration shortcut stayed stale: $target"}
if(Test-Path (Join-Path $nested 'resources\app.asar')){throw 'R23 nested migration left the historical executable tree active'}
$finalInstallKey=FindInstallInfoKey $stable
if(-not $finalInstallKey){throw 'R23 nested migration registry did not move to stable parent'}
Write-Host "R23_NESTED_MIGRATION_OK stable=$stable nestedGone=1 shortcut=$target profile=preserved updaterStyle=silent"

# Add this stronger result to the already-created release manifest.
$manifestPath=Join-Path (Join-Path $env:GITHUB_WORKSPACE 'dist') $env:MANIFEST_NAME
$m=Get-Content $manifestPath -Raw|ConvertFrom-Json
$m|Add-Member -NotePropertyName nestedMigrationProbe -NotePropertyValue 'r2j-nested-to-stable-pass' -Force
$m|Add-Member -NotePropertyName nestedMigrationSource -NotePropertyValue 'registry+shortcut+physical-tree-reproduction' -Force
$m|ConvertTo-Json -Depth 6|Set-Content $manifestPath -Encoding utf8

# Runner-only cleanup.
Remove-Item $stable -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $startLink -Force -ErrorAction SilentlyContinue
Remove-Item $sentinel -Force -ErrorAction SilentlyContinue

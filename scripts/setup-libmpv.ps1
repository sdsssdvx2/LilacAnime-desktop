param(
  [string]$TargetRoot = (Join-Path $env:USERPROFILE 'libmpv')
)

$ErrorActionPreference = 'Stop'

$Tag = '20261018'
$Asset = 'mpv-dev-x86_64-20261018-git-01e2533f31.7z'
$ExpectedSha256 = 'd7f5621f42b6e161fe032df914a10bdece28a89df3e57c6c3e16a5a250929b5e'
$Url = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$Tag/$Asset"
$Archive = Join-Path $env:TEMP $Asset
$Extract = Join-Path $env:TEMP "lilac-libmpv-$Tag"

Write-Host "Downloading pinned libmpv SDK/runtime: $Asset"
& curl.exe -L --fail --silent --show-error -o $Archive $Url
if ($LASTEXITCODE -ne 0) { throw 'libmpv download failed' }

$Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $ExpectedSha256) {
  throw "libmpv SHA-256 mismatch. expected=$ExpectedSha256 actual=$Actual"
}

Remove-Item $Extract -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Extract -Force | Out-Null

& 7z.exe x -y "-o$Extract" $Archive | Out-Host
if ($LASTEXITCODE -ne 0) { throw '7z extraction failed' }

$ClientHeader = Get-ChildItem $Extract -Recurse -File -Filter client.h |
  Where-Object { $_.Directory.Name -eq 'mpv' } |
  Select-Object -First 1
if (-not $ClientHeader) { throw 'mpv/client.h not found in SDK archive' }

$IncludeRoot = Split-Path $ClientHeader.Directory.FullName -Parent
$Dll = Get-ChildItem $Extract -Recurse -File |
  Where-Object { $_.Name -in @('libmpv-2.dll','mpv-2.dll') } |
  Select-Object -First 1
if (-not $Dll) { throw 'libmpv runtime DLL not found in SDK archive' }

$IncludeTarget = Join-Path $TargetRoot 'include'
$BinTarget = Join-Path $TargetRoot 'bin'
$LibTarget = Join-Path $TargetRoot 'lib'
New-Item -ItemType Directory -Path $IncludeTarget,$BinTarget,$LibTarget -Force | Out-Null

Remove-Item (Join-Path $IncludeTarget 'mpv') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $IncludeRoot 'mpv') (Join-Path $IncludeTarget 'mpv') -Recurse -Force
Copy-Item $Dll.FullName (Join-Path $BinTarget 'libmpv-2.dll') -Force

$DefPath = Join-Path $LibTarget 'mpv.def'
$LibPath = Join-Path $LibTarget 'mpv.lib'
$Exports = & dumpbin.exe /nologo /exports (Join-Path $BinTarget 'libmpv-2.dll') |
  Select-String '^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)' |
  ForEach-Object { $_.Matches[0].Groups[1].Value }
if ($LASTEXITCODE -ne 0 -or -not $Exports) {
  throw 'dumpbin could not read libmpv exports. Run under an MSVC developer environment.'
}

@('LIBRARY libmpv-2.dll','EXPORTS') + $Exports | Set-Content $DefPath -Encoding ascii
& lib.exe /nologo "/def:$DefPath" "/out:$LibPath" /machine:x64
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $LibPath)) { throw 'lib.exe failed to create mpv.lib' }

$env:MPV_INCLUDE_DIR = $IncludeTarget
$env:MPV_RUNTIME_DIR = $BinTarget
$env:MPV_LIB = $LibPath

if ($env:GITHUB_ENV) {
  "MPV_INCLUDE_DIR=$IncludeTarget" | Add-Content $env:GITHUB_ENV
  "MPV_RUNTIME_DIR=$BinTarget" | Add-Content $env:GITHUB_ENV
  "MPV_LIB=$LibPath" | Add-Content $env:GITHUB_ENV
}

Write-Host "libmpv ready: $TargetRoot"
Write-Host "MPV_INCLUDE_DIR=$IncludeTarget"
Write-Host "MPV_RUNTIME_DIR=$BinTarget"
Write-Host "MPV_LIB=$LibPath"

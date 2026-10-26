$ErrorActionPreference = 'Stop'
function Assert-Exit([string]$label){if($LASTEXITCODE-ne 0){throw "$label failed with exit code $LASTEXITCODE"}}
function Sha256([string]$path){return (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()}

# R33 is the exact user-tested baseline. Preserve every R34 support transform
# across R33's pinned reconstruction, then apply R34 only to the concrete,
# qualified R33 working tree. The one R33 visible-focus runtime smoke is deferred
# until after R34 repairs its blocking native Present path; every R33 source gate
# and transform still runs unchanged.
$r34Stash=Join-Path $env:RUNNER_TEMP 'lilac-r34-support'
Remove-Item $r34Stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $r34Stash|Out-Null
$r34Support=@(
  'r34-transform-source-sanitize.cjs',
  'r34-focus-handoff-stall-fix.cjs',
  'r34-handoff-ack-hardening.cjs',
  'r34-main-stall-hardening.cjs',
  'r34-focus-handoff-native-smoke.cjs'
)
foreach($name in $r34Support){$src=Join-Path 'scripts' $name;if(-not(Test-Path $src)){throw "R34 support missing: $name"};Copy-Item $src (Join-Path $r34Stash $name) -Force}

& ./scripts/r34-r33-baseline-defer.ps1
Assert-Exit 'qualified R33 baseline build with visible smoke deferred'
New-Item -ItemType Directory -Force -Path scripts|Out-Null
foreach($name in $r34Support){Copy-Item (Join-Path $r34Stash $name) (Join-Path 'scripts' $name) -Force}

# The sanitizer is idempotent and runs only after the pinned checkout so it cannot
# dirty the tree before R33 reconstructs the exact product source.
node scripts/r34-transform-source-sanitize.cjs
Assert-Exit 'R34 transform source sanitize'
node --check scripts/r34-focus-handoff-stall-fix.cjs
Assert-Exit 'R34 transform syntax'
node scripts/r34-focus-handoff-stall-fix.cjs
Assert-Exit 'R34 focus handoff/stall transform'
node --check scripts/r34-handoff-ack-hardening.cjs
Assert-Exit 'R34 handoff sent-ack syntax'
node scripts/r34-handoff-ack-hardening.cjs
Assert-Exit 'R34 handoff sent-ack hardening'
node --check scripts/r34-main-stall-hardening.cjs
Assert-Exit 'R34 main stall I/O syntax'
node scripts/r34-main-stall-hardening.cjs
Assert-Exit 'R34 main stall I/O hardening'

$nativeSource=Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$bridge=Get-Content 'electron/libmpv-shared-main.cjs' -Raw
$entry=Get-Content 'src/libmpv-shared-entry.js' -Raw
$main=Get-Content 'electron/main.cjs' -Raw
if(-not $nativeSource.Contains('LILAC_R34_FOCUS_HANDOFF') -or -not $nativeSource.Contains('SetNativePresenterMirrorChromium') -or -not $nativeSource.Contains('r34MirrorChromiumDuringHandoff')){throw 'R34 native handoff source gate failed'}
if(-not $bridge.Contains('r34BeginFocusHandoff') -or -not $bridge.Contains('r34CompleteFocusHandoff') -or -not $bridge.Contains('r34SetNativeSubtitleVisible')){throw 'R34 bridge handoff/subtitle gate failed'}
if(-not $bridge.Contains('LILAC_R34_HANDOFF_SENT_ACK') -or -not $bridge.Contains('r34FocusHandoffSentFrames') -or -not $bridge.Contains('!r34FocusHandoffSentFrames.has(Number(frameId))')){throw 'R34 successful-send handoff acknowledgement gate failed'}
if($entry.Contains("document.hasFocus() ? 'no' : 'yes'") -or -not $entry.Contains('LILAC_R34_SUBTITLE_SINGLE_OWNER') -or -not $entry.Contains("'sub-ass-override', 'force'")){throw 'R34 subtitle single-owner/style gate failed'}
if(-not $main.Contains('LILAC_R34_CACHE_WRITE_WORKER') -or $main.Contains("saveCatalogFile(provider,name,value){const key=`${provider}-${name}`;clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{fs.writeFileSync")){throw 'R34 main cache-worker gate failed'}
if(-not $main.Contains('LILAC_R34_MAIN_STALL_IO_HARDENING') -or -not $main.Contains('async function readKoreanTitleCache()') -or -not $main.Contains('r34QueueJsonWrite(file,fresh)')){throw 'R34 main stall I/O hardening gate failed'}
if($main.Contains("const disk=readKoreanTitleCache();") -or $main.Contains("communityPostCache.set(blog,fresh);try{fs.writeFileSync(file,JSON.stringify(fresh))")){throw 'R34 blocking metadata cache path survived'}
Write-Host 'R34_SOURCE_GATES_OK handoff=native+chromium-until-successful-send+allReferencesReleased subtitle=main-single-owner assOverride=force cacheWrites=worker-coalesced mainCacheReads=async-or-memoized r27NativeGapReset=1'

# R34 changes the native producer decision and N-API surface, so rebuild the addon
# against Electron 44.9.3. R33 already downloaded/pinned headers into vendor/include.
if(-not(Test-Path 'native/libmpv-d3d11-bridge/vendor/include/mpv/client.h')){throw 'R34 inherited pinned libmpv headers missing'}
& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R34 native addon rebuild'
$rebuilt='native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if(-not(Test-Path $rebuilt)){throw 'R34 rebuilt addon missing'}
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
$r34AddonSha=Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllSha=Sha256 'electron/libmpv-2.dll'
if($dllSha-ne $env:QUALIFIED_DLL_SHA256){throw 'R34 libmpv DLL drifted'}

$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL=(Resolve-Path 'electron/libmpv-2.dll').Path
& node_modules/.bin/electron.cmd scripts/r32-native-producer-watchdog-smoke.cjs
Assert-Exit 'R34 inherited native producer watchdog smoke'
# This is the exact R33 DWM focus smoke deferred above. It now exercises the
# repaired R34 nonblocking presenter instead of the known blocking R33 Present.
& node_modules/.bin/electron.cmd scripts/r33-owned-popup-visible-focus-smoke.cjs
Assert-Exit 'R34 post-fix inherited visible owned-popup DWM smoke'
& node_modules/.bin/electron.cmd scripts/r34-focus-handoff-native-smoke.cjs
Assert-Exit 'R34 dual-path focus handoff smoke'
Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue

# Repackage only after every source/native/runtime gate has passed.
$pkg=Get-Content package.json -Raw|ConvertFrom-Json
$pkg.version=$env:APP_VERSION
$pkg.build.appId=$env:STABLE_APP_ID
$pkg.build.productName=$env:STABLE_PRODUCT_NAME
$pkg.build.win.executableName=$env:STABLE_EXE_BASE
$pkg.build.win.artifactName=$env:INSTALLER_NAME
$utf8NoBom=New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $PWD 'package.json'),(($pkg|ConvertTo-Json -Depth 100)+[Environment]::NewLine),$utf8NoBom)
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& node_modules/.bin/electron-builder.cmd --win nsis --x64
Assert-Exit 'R34 final package'
$installer=Join-Path 'dist' $env:INSTALLER_NAME
if(-not(Test-Path $installer)){throw "R34 installer missing: $installer"}

$asarCli='node_modules/.bin/asar.cmd';if(-not(Test-Path $asarCli)){throw 'R34 asar helper missing'}
$asarCheck=Join-Path $env:RUNNER_TEMP 'r34-asar-check';Remove-Item $asarCheck -Recurse -Force -ErrorAction SilentlyContinue;New-Item -ItemType Directory -Force -Path $asarCheck|Out-Null
& $asarCli extract 'dist/win-unpacked/resources/app.asar' $asarCheck
Assert-Exit 'R34 packaged asar extract'
$shipBridge=Get-Content (Join-Path $asarCheck 'electron/libmpv-shared-main.cjs') -Raw
$shipEntry=Get-Content (Join-Path $asarCheck 'src/libmpv-shared-entry.js') -Raw
$shipMain=Get-Content (Join-Path $asarCheck 'electron/main.cjs') -Raw
if($shipBridge-notmatch 'r34BeginFocusHandoff' -or $shipBridge-notmatch 'setNativePresenterMirrorChromium' -or $shipBridge-notmatch 'r34SetNativeSubtitleVisible'){throw 'packaged R34 handoff/subtitle bridge missing'}
if($shipBridge-notmatch 'LILAC_R34_HANDOFF_SENT_ACK' -or $shipBridge-notmatch 'r34FocusHandoffSentFrames'){throw 'packaged R34 successful-send acknowledgement missing'}
if($shipEntry-match "document.hasFocus\(\) \? 'no' : 'yes'" -or $shipEntry-notmatch 'LILAC_R34_SUBTITLE_SINGLE_OWNER'){throw 'packaged R34 subtitle regression fix missing'}
if($shipMain-notmatch 'LILAC_R34_CACHE_WRITE_WORKER' -or $shipMain-notmatch 'LILAC_R34_MAIN_STALL_IO_HARDENING'){throw 'packaged R34 cache worker/main-I/O hardening missing'}
if($shipMain-match 'const disk=readKoreanTitleCache\(\);' -or $shipMain-match 'communityPostCache\.set\(blog,fresh\);try\{fs\.writeFileSync'){throw 'packaged R34 blocking metadata cache path survived'}
$worker='dist/win-unpacked/resources/app.asar.unpacked/electron/cache-write-worker.cjs';if(-not(Test-Path $worker)){throw 'packaged R34 cache worker missing'}
$packedAddon='dist/win-unpacked/resources/app.asar.unpacked/electron/lilac-libmpv-player-bridge.node';$packedDll='dist/win-unpacked/resources/app.asar.unpacked/electron/libmpv-2.dll'
if((Sha256 $packedAddon)-ne $r34AddonSha){throw 'packaged R34 addon hash mismatch'}
if((Sha256 $packedDll)-ne $env:QUALIFIED_DLL_SHA256){throw 'packaged R34 DLL hash mismatch'}

$manifestPath=Join-Path 'dist' $env:MANIFEST_NAME
$manifest=if(Test-Path $manifestPath){Get-Content $manifestPath -Raw|ConvertFrom-Json}else{[pscustomobject]@{}}
$hash=Sha256 $installer;$size=(Get-Item $installer).Length
$manifest|Add-Member -NotePropertyName version -NotePropertyValue $env:APP_VERSION -Force
$manifest|Add-Member -NotePropertyName installer -NotePropertyValue $env:INSTALLER_NAME -Force
$manifest|Add-Member -NotePropertyName installerSha256 -NotePropertyValue $hash -Force
$manifest|Add-Member -NotePropertyName installerSize -NotePropertyValue $size -Force
$manifest|Add-Member -NotePropertyName nativeAddon -NotePropertyValue $r34AddonSha -Force
$manifest|Add-Member -NotePropertyName nativeDll -NotePropertyValue $env:QUALIFIED_DLL_SHA256 -Force
$manifest|Add-Member -NotePropertyName r34FocusHandoff -NotePropertyValue 'native-present+chromium-mirror-until-successful-send+allReferencesReleased-then-hide' -Force
$manifest|Add-Member -NotePropertyName r34HandoffAck -NotePropertyValue 'successful-send+allReferencesReleased-only' -Force
$manifest|Add-Member -NotePropertyName r34SubtitleOwnership -NotePropertyValue 'main-only-focus-authority+html-focused+libmpv-unfocused+ass-override-force' -Force
$manifest|Add-Member -NotePropertyName r34CacheWrites -NotePropertyValue 'catalog+display-title+tmdb-overview+artwork+anissia+korean-title+community-post+oped-worker-coalesced' -Force
$manifest|Add-Member -NotePropertyName r34MainStallIo -NotePropertyValue 'korean-title+community-post+tmdb-overview+artwork+anissia+oped-off-main+tmdb-key-memoized' -Force
$manifest|Add-Member -NotePropertyName r34R27GapReset -NotePropertyValue $true -Force
[System.IO.File]::WriteAllText($manifestPath,(($manifest|ConvertTo-Json -Depth 12)+[Environment]::NewLine),$utf8NoBom)
"R34_ADDON_SHA256=$r34AddonSha"|Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"R34_INSTALLER_SHA256=$hash"|Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"R34_INSTALLER_SIZE=$size"|Out-File $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "R34_BUILD_OK sha256=$hash size=$size addon=$r34AddonSha dll=$dllSha focusHandoff=successful-send+release subtitle=single-owner cacheWrites=worker-coalesced mainCacheReads=async-or-memoized"

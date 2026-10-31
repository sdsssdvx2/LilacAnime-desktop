$ErrorActionPreference='Stop'

function Assert-Exit([string]$label){ if($LASTEXITCODE-ne 0){ throw "$label failed with exit code $LASTEXITCODE" } }
function Sha256([string]$path){ (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }

$stash=Join-Path $env:RUNNER_TEMP 'lilac-r41-preflight-support'
Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stash | Out-Null
$r41Support=@(
  'r41-first-present-latch.cjs',
  'r41-first-present-runtime-smoke.cjs',
  'r41-finalize-identity.cjs',
  'r41-preflight.ps1'
)
foreach($name in $r41Support){
  $src=Join-Path 'scripts' $name
  if(-not(Test-Path $src)){throw "R41 preflight support missing: $name"}
  Copy-Item $src (Join-Path $stash $name) -Force
}

Write-Host 'R41_PREFLIGHT_BEGIN baseline=exact-R40 candidate=blur-first-present-latch+display-diagnostics'
& ./scripts/r40-preflight.ps1
Assert-Exit 'R41 exact R40 reconstruction/qualification'

New-Item -ItemType Directory -Force -Path scripts | Out-Null
foreach($name in $r41Support){ Copy-Item (Join-Path $stash $name) (Join-Path 'scripts' $name) -Force }
foreach($script in $r41Support | Where-Object {$_ -like '*.cjs'}){
  node --check (Join-Path 'scripts' $script)
  Assert-Exit "R41 syntax $script"
}

$updaterBefore=Sha256 'electron/updater.cjs'
$focusedPreloadBefore=Sha256 'electron/libmpv-shared-preload.cjs'
$focusedBundleBefore=Sha256 'electron/preload-libmpv-shared.generated.cjs'
$dllBefore=Sha256 'electron/libmpv-2.dll'
if($dllBefore-ne $env:QUALIFIED_DLL_SHA256){throw 'R41 exact R40 DLL baseline mismatch'}

node scripts/r41-first-present-latch.cjs
Assert-Exit 'R41 blur first-present latch transform'
node scripts/r41-finalize-identity.cjs
Assert-Exit 'R41 identity'

$native=Get-Content 'native/libmpv-d3d11-bridge/player_addon.cc' -Raw
$bridge=Get-Content 'electron/libmpv-shared-main.cjs' -Raw
foreach($marker in @('LILAC_R41_FIRST_PRESENT_BEFORE_SHOW','r41FirstPresentReady','r41VisibilityPrematureShowCount','LILAC_R33_OWNED_POPUP_FOCUS_SURFACE','LILAC_R39_TOPMOST_BIDIRECTIONAL','LILAC_R40_HANDOFF_FORCE_REDRAW')){if(-not $native.Contains($marker)-and-not $bridge.Contains($marker)){throw "R41 required marker missing: $marker"}}
foreach($marker in @('LILAC_R41_BLUR_FIRST_PRESENT_COMMIT','r41ArmBlurFirstPresentCommit','r41BlurForcedRedrawAccepted','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','LILAC_R40_FRESH_FRAME_WAKE_GATING')){if(-not $bridge.Contains($marker)){throw "R41 bridge marker missing: $marker"}}

$presentStart=$native.IndexOf('void R32PresentNativeFrame(')
$presentEnd=$native.IndexOf('bool SetOption(Player* player, const char* key, const char* value, std::string* error) {',$presentStart)
if($presentStart-lt 0-or$presentEnd-le$presentStart){throw 'R41 native present boundary missing'}
$presentBody=$native.Substring($presentStart,$presentEnd-$presentStart)
foreach($forbidden in @('SetWindowPos(','ShowWindow(','GetClientRect(','ClientToScreen(')){if($presentBody.Contains($forbidden)){throw "R41 reintroduced producer-thread HWND mutation: $forbidden"}}
if($bridge.Contains('focus-staged-gpu-copy')-or$bridge.Contains('copyTextureToTexture')){throw 'R41 resurrected forbidden R28 staged WebGPU path'}
if($native.Contains('--disable-direct-composition')){throw 'R41 resurrected forbidden R25 Direct Composition disable'}
if((Sha256 'electron/updater.cjs')-ne $updaterBefore){throw 'R41 changed protected R38 updater'}
if((Sha256 'electron/libmpv-shared-preload.cjs')-ne $focusedPreloadBefore-or(Sha256 'electron/preload-libmpv-shared.generated.cjs')-ne $focusedBundleBefore){throw 'R41 changed focused direct-WebGPU preload bytes'}
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R41 changed qualified libmpv DLL'}

& node_modules/.bin/node-gyp.cmd rebuild --directory native/libmpv-d3d11-bridge --target=$env:ELECTRON_VERSION --dist-url=https://electronjs.org/headers
Assert-Exit 'R41 native addon compile'
$rebuilt='native/libmpv-d3d11-bridge/build/Release/lilac_libmpv_player_bridge.node'
if(-not(Test-Path $rebuilt)){throw 'R41 compiled addon missing'}
Copy-Item $rebuilt 'electron/lilac-libmpv-player-bridge.node' -Force
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R41 DLL drifted after native compile'}

$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL=(Resolve-Path 'electron/libmpv-2.dll').Path
try{
  node scripts/r40-run-electron-gate.cjs scripts/r41-first-present-runtime-smoke.cjs R41_FIRST_PRESENT_RUNTIME_OK 150000
  Assert-Exit 'R41 first-present DWM/runtime hard gate'
  node scripts/r40-run-electron-gate.cjs scripts/r40-callback-pacing-runtime-smoke.cjs R40_CALLBACK_PACING_RUNTIME_OK 180000
  Assert-Exit 'R41 protected R40 callback pacing hard gate'
  node scripts/r40-run-electron-gate.cjs scripts/r40-native-subtitle-overlay-runtime-smoke.cjs R40_NATIVE_SUBTITLE_OVERLAY_RUNTIME_OK 150000
  Assert-Exit 'R41 protected R40 subtitle overlay hard gate'
  node scripts/r37-run-e2e-with-timeout.cjs scripts/r37-explicit-handoff-e2e-smoke.cjs 180000
  Assert-Exit 'R41 protected R37 raw shared-texture E2E'
  node scripts/r40-run-electron-gate.cjs scripts/r39-miniplayer-native-topmost-runtime-smoke.cjs R39_MINIPLAYER_NATIVE_TOPMOST_RUNTIME_OK 150000
  Assert-Exit 'R41 protected R39 mini-player/native topmost hard gate'
}
finally{
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
}

$pkg=Get-Content 'package.json' -Raw|ConvertFrom-Json
if($pkg.version-ne '0.5.54-libmpv-r3f.rc21'-or$pkg.lilacCustomTag-ne 'libmpv-r2k-v0.5.54-r41'){throw 'R41 candidate identity mismatch'}
Write-Host "R41_PREFLIGHT_OK version=$($pkg.version) firstPresent=arm+forced-redraw+present-before-show+main-thread-commit prematureShow=hard-zero r40Pacing=repassed r40Subtitle=repassed r37=raw-e2e-repassed r38Updater=byte-identical r39PiP=topmost-repassed focused=direct-webgpu-byte-identical forbiddenR25R28=absent addonSha=$(Sha256 'electron/lilac-libmpv-player-bridge.node') dll=$dllBefore"

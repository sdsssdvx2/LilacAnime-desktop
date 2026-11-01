$ErrorActionPreference='Stop'
function Assert-Exit([string]$label){ if($LASTEXITCODE-ne 0){ throw "$label failed with exit code $LASTEXITCODE" } }
function Sha256([string]$path){ (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-Contains([string]$text,[string]$marker,[string]$label){ if(-not $text.Contains($marker)){ throw "$label missing $marker" } }

Write-Host 'R43_PREFLIGHT_BEGIN baseline=pinned-qualified-R41-release fix=persistent-unfocused-subtitle-HWND'

node --check scripts/r42-reconstruct-r41-release.cjs
Assert-Exit 'R43 R41 release reconstruction syntax'
node scripts/r42-reconstruct-r41-release.cjs
Assert-Exit 'R43 pinned qualified R41 release reconstruction'

$installedElectron=(node -p "require('electron/package.json').version").Trim()
Assert-Exit 'R43 installed Electron version query'
if($installedElectron-ne$env:ELECTRON_VERSION){throw "R43 Electron version drifted: expected $env:ELECTRON_VERSION got $installedElectron"}

$updaterBefore=Sha256 'electron/updater.cjs'
$focusedPreloadBefore=Sha256 'electron/libmpv-shared-preload.cjs'
$focusedBundleBefore=Sha256 'electron/preload-libmpv-shared.generated.cjs'
$addonBefore=Sha256 'electron/lilac-libmpv-player-bridge.node'
$dllBefore=Sha256 'electron/libmpv-2.dll'
$mainBefore=Sha256 'electron/main.cjs'
$bridgeBefore=Sha256 'electron/libmpv-shared-main.cjs'
$overlayPreloadBefore=Sha256 'electron/r40-subtitle-overlay-preload.cjs'

node --check scripts/r43-subtitle-persistent-hwnd.cjs
Assert-Exit 'R43 subtitle persistent-HWND transform syntax'
node scripts/r43-subtitle-persistent-hwnd.cjs
Assert-Exit 'R43 subtitle persistent-HWND transform'

foreach($script in @(
  'electron/r40-subtitle-overlay-window.cjs',
  'electron/r40-subtitle-overlay-preload.cjs',
  'electron/main.cjs',
  'electron/libmpv-shared-main.cjs',
  'electron/libmpv-shared-preload.cjs',
  'electron/preload-libmpv-shared.generated.cjs'
)){
  node --check $script
  Assert-Exit "R43 post-transform syntax $script"
}

# The fix is deliberately controller-only. Everything that renders video, handles
# update installation, or paints the subtitle DOM must remain exactly the shipped R41 bytes.
if((Sha256 'electron/updater.cjs')-ne $updaterBefore){throw 'R43 changed protected R38 updater'}
if((Sha256 'electron/libmpv-shared-preload.cjs')-ne $focusedPreloadBefore){throw 'R43 changed focused direct-WebGPU preload'}
if((Sha256 'electron/preload-libmpv-shared.generated.cjs')-ne $focusedBundleBefore){throw 'R43 changed focused direct-WebGPU preload bundle'}
if((Sha256 'electron/lilac-libmpv-player-bridge.node')-ne $addonBefore){throw 'R43 changed shipped R41 native addon'}
if((Sha256 'electron/libmpv-2.dll')-ne $dllBefore){throw 'R43 changed shipped qualified libmpv DLL'}
if((Sha256 'electron/main.cjs')-ne $mainBefore){throw 'R43 changed protected R41 main process'}
if((Sha256 'electron/libmpv-shared-main.cjs')-ne $bridgeBefore){throw 'R43 changed protected R41 libmpv bridge'}
if((Sha256 'electron/r40-subtitle-overlay-preload.cjs')-ne $overlayPreloadBefore){throw 'R43 changed subtitle DOM renderer/preload'}

$pkg=Get-Content 'package.json' -Raw | ConvertFrom-Json
if([string]$pkg.version-ne$env:R43_APP_VERSION-or[string]$pkg.lilacCustomTag-ne$env:R43_RELEASE_TAG){throw "R43 package identity mismatch $($pkg.version) $($pkg.lilacCustomTag)"}
if([string]$pkg.build.appId-ne$env:STABLE_APP_ID-or[string]$pkg.build.productName-ne$env:STABLE_PRODUCT_NAME-or[string]$pkg.build.win.executableName-ne$env:STABLE_EXE_BASE){throw 'R43 stable install identity drifted'}
if([string]$pkg.build.win.artifactName-ne'LilacAnime-Libmpv-R43-Setup.${ext}'){throw 'R43 artifactName drifted'}

$controller=Get-Content 'electron/r40-subtitle-overlay-window.cjs' -Raw
foreach($marker in @(
  'LILAC_R43_PERSISTENT_SUBTITLE_OVERLAY_HWND',
  'r43-inactive-payload-kept-hwnd',
  'r43-payload-active-existing-hwnd',
  'if (!wasWindowVisible) win.showInactive()',
  'active: this.contentActive',
  'hwndSessionVisible: this.visible'
)){Assert-Contains $controller $marker 'R43 subtitle controller'}
foreach($forbidden in @('copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition')){
  if($controller.Contains($forbidden)){throw "R43 introduced forbidden path $forbidden"}
}

# Build an R43-only runtime smoke from the already-qualified R40 smoke. Do not alter
# the shared historical gate. Add four inactive->active cue gaps while a rival stays
# focused. The owned transparent HWND must remain visible, its DOM must clear to zero
# subtitle pixels, and subsequent cues must return without another showInactive/hide.
$source=(Get-Content 'scripts/r40-native-subtitle-overlay-runtime-smoke.cjs' -Raw).Replace("`r`n","`n")
$anchor="    if(!unfocusedBox||unfocusedBox.count<80)throw new Error(``unfocused overlay capturePage subtitle pixels missing `${JSON.stringify(unfocusedBox)} state=`${JSON.stringify(controller.snapshot())}``);"
$first=$source.IndexOf($anchor,[System.StringComparison]::Ordinal)
$last=$source.LastIndexOf($anchor,[System.StringComparison]::Ordinal)
if($first-lt 0-or$first-ne$last){throw 'R43 cue-gap injection anchor mismatch'}
$inject=@'

    const r43Initial=controller.snapshot();
    const r43InitialShowCount=r43Initial.showCount;
    const r43InitialHideCount=r43Initial.hideCount;
    if(r43Initial.windowVisible!==true||r43Initial.active!==true)throw new Error(`R43 initial overlay state invalid ${JSON.stringify(r43Initial)}`);
    for(let cycle=0;cycle<4;cycle+=1){
      if(owner.isFocused()||!rival.isFocused())throw new Error(`R43 rival focus lost before cue gap cycle=${cycle}`);
      const inactive={...payload,revision:100+(cycle*2),active:false,cues:[]};
      const cleared=await controller.update(owner,inactive);
      const clearState=controller.snapshot();
      if(cleared?.visible!==false||clearState.active!==false||clearState.windowVisible!==true||clearState.hwndSessionVisible!==true)throw new Error(`R43 cue gap hid HWND cycle=${cycle} result=${JSON.stringify(cleared)} state=${JSON.stringify(clearState)}`);
      if(clearState.showCount!==r43InitialShowCount||clearState.hideCount!==r43InitialHideCount)throw new Error(`R43 cue gap changed HWND show/hide counters cycle=${cycle} ${JSON.stringify(clearState)}`);
      await waitUntil(async()=>await overlayWin.webContents.executeJavaScript("document.body.dataset.active==='0'"),3000,`R43 inactive DOM cycle ${cycle}`);
      await twoPaints(overlayWin);
      const blankImage=await overlayWin.capturePage();
      const blankBox=scanMagentaBitmap(blankImage,{x:0,y:0,width:overlayRect.width,height:overlayRect.height},{x:overlayRect.x,y:overlayRect.y});
      if(blankBox&&blankBox.count>=20)throw new Error(`R43 inactive DOM retained subtitle pixels cycle=${cycle} ${JSON.stringify(blankBox)}`);

      const active={...payload,revision:101+(cycle*2),active:true};
      const shown=await controller.update(owner,active);
      const activeState=controller.snapshot();
      if(shown?.visible!==true||activeState.active!==true||activeState.windowVisible!==true||activeState.hwndSessionVisible!==true)throw new Error(`R43 active cue failed cycle=${cycle} result=${JSON.stringify(shown)} state=${JSON.stringify(activeState)}`);
      if(activeState.showCount!==r43InitialShowCount||activeState.hideCount!==r43InitialHideCount)throw new Error(`R43 active cue re-showed/re-hid HWND cycle=${cycle} ${JSON.stringify(activeState)}`);
      await waitUntil(async()=>await overlayWin.webContents.executeJavaScript(`document.body.dataset.active==='1'&&document.body.dataset.revision==='${101+(cycle*2)}'`),3000,`R43 active DOM cycle ${cycle}`);
      await twoPaints(overlayWin);
      const activeImage=await overlayWin.capturePage();
      const activeBox=scanMagentaBitmap(activeImage,{x:0,y:0,width:overlayRect.width,height:overlayRect.height},{x:overlayRect.x,y:overlayRect.y});
      if(!activeBox||activeBox.count<80)throw new Error(`R43 active cue pixels missing cycle=${cycle} ${JSON.stringify(activeBox)}`);
    }
    console.log(`R43_CUE_GAP_PERSISTENT_HWND_OK cycles=4 showCount=${controller.snapshot().showCount} hideCount=${controller.snapshot().hideCount} rivalFocused=${rival.isFocused()?1:0}`);
'@
$source=$source.Replace($anchor,$anchor+$inject)

# Hosted Windows may reject a one-shot foreground focus steal from the rival. Remove
# the rival and retry, but still require a genuine owner.isFocused() before checking
# that refocus hard-hides the persistent overlay HWND.
$refocusAnchor="    owner.focus();`n    await waitUntil(()=>owner.isFocused(),3000,'owner refocus');"
$first=$source.IndexOf($refocusAnchor,[System.StringComparison]::Ordinal)
$last=$source.LastIndexOf($refocusAnchor,[System.StringComparison]::Ordinal)
if($first-lt 0-or$first-ne$last){throw 'R43 overlay smoke refocus anchor mismatch'}
$refocusReplacement="    rival.blur();rival.hide();owner.show();`n    for(let attempt=0;attempt<4&&!owner.isFocused();attempt+=1){owner.moveTop();owner.focus();await sleep(150);}`n    await waitUntil(()=>owner.isFocused(),5000,'owner refocus');"
$source=$source.Replace($refocusAnchor,$refocusReplacement)
$source=$source.Replace('R40_NATIVE_SUBTITLE_OVERLAY_RUNTIME_OK','R43_PERSISTENT_SUBTITLE_HWND_RUNTIME_OK')
$r43Smoke='scripts/r43-persistent-subtitle-hwnd-runtime-smoke.generated.cjs'
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $r43Smoke),$source,(New-Object System.Text.UTF8Encoding($false)))
node --check $r43Smoke
Assert-Exit 'R43 persistent subtitle HWND runtime smoke syntax'

$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL=(Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r40-run-electron-gate.cjs $r43Smoke R43_PERSISTENT_SUBTITLE_HWND_RUNTIME_OK 150000
  Assert-Exit 'R43 persistent subtitle HWND runtime regression gate'
  node scripts/r40-run-electron-gate.cjs scripts/r41-live-handoff-native-smoke.cjs R41_LIVE_NATIVE_HANDOFF_RUNTIME_OK 150000
  Assert-Exit 'R43 protected R41 live native handoff regression gate'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
  Remove-Item $r43Smoke -Force -ErrorAction SilentlyContinue
}

# Export immutable R41 protected hashes into the next packaging step. GitHub Actions
# environment files are append-only; local runs simply skip this convenience.
if($env:GITHUB_ENV){
  @(
    "R43_EXPECTED_UPDATER_SHA256=$updaterBefore",
    "R43_EXPECTED_FOCUSED_PRELOAD_SHA256=$focusedPreloadBefore",
    "R43_EXPECTED_FOCUSED_BUNDLE_SHA256=$focusedBundleBefore",
    "R43_EXPECTED_ADDON_SHA256=$addonBefore",
    "R43_EXPECTED_DLL_SHA256=$dllBefore",
    "R43_EXPECTED_MAIN_SHA256=$mainBefore",
    "R43_EXPECTED_BRIDGE_SHA256=$bridgeBefore",
    "R43_EXPECTED_OVERLAY_PRELOAD_SHA256=$overlayPreloadBefore"
  ) | Add-Content -Path $env:GITHUB_ENV -Encoding utf8
}

Write-Host "R43_PREFLIGHT_OK baseline=pinned-R41-release cueGapCycles=4 overlayHwnd=kept-visible dom=clear-only refocus=hard-hide updater=$updaterBefore focusedPreload=$focusedPreloadBefore addon=$addonBefore dll=$dllBefore"

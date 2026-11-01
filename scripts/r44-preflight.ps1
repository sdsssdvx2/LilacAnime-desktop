$ErrorActionPreference='Stop'
function Assert-Exit([string]$label){ if($LASTEXITCODE-ne 0){ throw "$label failed with exit code $LASTEXITCODE" } }
function Sha256([string]$path){ (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-Contains([string]$text,[string]$marker,[string]$label){ if(-not $text.Contains($marker)){ throw "$label missing $marker" } }

Write-Host 'R44_PREFLIGHT_BEGIN baseline=qualified-R43 first-cue=prewarm+serialized-load transition=opacity0+double-raf zorder=session-once'

# Reconstruct and requalify the already-published R43 product from the pinned R41
# release before touching R44. This gives R44 the exact controller semantics that the
# user just tested and keeps all earlier native/WebGPU regression gates intact.
./scripts/r43-preflight.ps1
Assert-Exit 'R44 qualified R43 baseline preflight'

$protectedBefore=@{
  updater=Sha256 'electron/updater.cjs'
  focusedPreload=Sha256 'electron/libmpv-shared-preload.cjs'
  focusedBundle=Sha256 'electron/preload-libmpv-shared.generated.cjs'
  addon=Sha256 'electron/lilac-libmpv-player-bridge.node'
  dll=Sha256 'electron/libmpv-2.dll'
  bridge=Sha256 'electron/libmpv-shared-main.cjs'
  overlayPreload=Sha256 'electron/r40-subtitle-overlay-preload.cjs'
}
$mainBefore=Sha256 'electron/main.cjs'
$controllerBefore=Sha256 'electron/r40-subtitle-overlay-window.cjs'

foreach($script in @(
  'scripts/r44-overlay-prewarm-race-fix.cjs',
  'scripts/r44-overlay-zorder-finalize.cjs',
  'scripts/r44-first-active-zorder-guard.cjs',
  'scripts/r44-overlay-concurrent-ensure-smoke.cjs'
)){
  node --check $script
  Assert-Exit "R44 source syntax $script"
}

node scripts/r44-overlay-prewarm-race-fix.cjs
Assert-Exit 'R44 prewarm/race transform'
node scripts/r44-overlay-zorder-finalize.cjs
Assert-Exit 'R44 post-paint z-order finalize'
node scripts/r44-first-active-zorder-guard.cjs
Assert-Exit 'R44 first-active z-order guard'

foreach($script in @(
  'electron/r40-subtitle-overlay-window.cjs',
  'electron/r40-subtitle-overlay-preload.cjs',
  'electron/main.cjs',
  'electron/libmpv-shared-main.cjs',
  'electron/libmpv-shared-preload.cjs',
  'electron/preload-libmpv-shared.generated.cjs'
)){
  node --check $script
  Assert-Exit "R44 post-transform syntax $script"
}

foreach($entry in $protectedBefore.GetEnumerator()){
  $path=switch($entry.Key){
    'updater'{'electron/updater.cjs'}
    'focusedPreload'{'electron/libmpv-shared-preload.cjs'}
    'focusedBundle'{'electron/preload-libmpv-shared.generated.cjs'}
    'addon'{'electron/lilac-libmpv-player-bridge.node'}
    'dll'{'electron/libmpv-2.dll'}
    'bridge'{'electron/libmpv-shared-main.cjs'}
    'overlayPreload'{'electron/r40-subtitle-overlay-preload.cjs'}
  }
  if((Sha256 $path)-ne$entry.Value){throw "R44 changed protected R43/R41 byte set $($entry.Key)"}
}
if((Sha256 'electron/main.cjs')-eq$mainBefore){throw 'R44 expected main lifecycle hook change but main hash is unchanged'}
if((Sha256 'electron/r40-subtitle-overlay-window.cjs')-eq$controllerBefore){throw 'R44 expected subtitle controller change but controller hash is unchanged'}

$pkg=Get-Content 'package.json' -Raw|ConvertFrom-Json
if([string]$pkg.version-ne$env:R44_APP_VERSION-or[string]$pkg.lilacCustomTag-ne$env:R44_RELEASE_TAG){throw "R44 package identity mismatch $($pkg.version) $($pkg.lilacCustomTag)"}
if([string]$pkg.build.appId-ne$env:STABLE_APP_ID-or[string]$pkg.build.productName-ne$env:STABLE_PRODUCT_NAME-or[string]$pkg.build.win.executableName-ne$env:STABLE_EXE_BASE){throw 'R44 stable install identity drifted'}
if([string]$pkg.build.win.artifactName-ne'LilacAnime-Libmpv-R44-Setup.${ext}'){throw 'R44 artifactName drifted'}

$controller=Get-Content 'electron/r40-subtitle-overlay-window.cjs' -Raw
$main=Get-Content 'electron/main.cjs' -Raw
foreach($marker in @(
  'LILAC_R44_PREWARMED_SUBTITLE_OVERLAY',
  'await this.ensurePromise',
  'prewarm-show-opacity-zero',
  'reveal-visible-reanchored',
  'first-active-session-reanchor-opacity-zero',
  'r44-payload-active-prewarmed-hwnd',
  'transitionTrace: this.transitionTrace.slice()',
  'sessionNeedsActiveReanchor'
)){Assert-Contains $controller $marker 'R44 subtitle controller'}
foreach($marker in @('LILAC_R44_PREWARMED_SUBTITLE_OVERLAY',"prewarm(win, 'owner-blur')","reconcileDeferred(win, 'owner-blur')")){Assert-Contains $main $marker 'R44 main lifecycle'}
foreach($forbidden in @('copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition')){
  if($controller.Contains($forbidden)-or$main.Contains($forbidden)){throw "R44 introduced forbidden path $forbidden"}
}

# Controller-only race gate: start blur prewarm and first active cue concurrently.
node scripts/r40-run-electron-gate.cjs scripts/r44-overlay-concurrent-ensure-smoke.cjs R44_CONCURRENT_OVERLAY_ENSURE_OK 90000
Assert-Exit 'R44 concurrent ensure/load regression gate'

# Extend the already-qualified R40 native subtitle smoke with the R44 session sequence:
# an empty transparent HWND must be prewarmed before native-only playback, first active
# content must reuse it, one guarded z-order reanchor may occur for the first cue, and
# all later cue gaps/active cues must change neither HWND visibility nor z-order.
$source=(Get-Content 'scripts/r40-native-subtitle-overlay-runtime-smoke.cjs' -Raw).Replace("`r`n","`n")
$blurAnchor="    await waitUntil(()=>!owner.isFocused()&&rival.isFocused(),3000,'owner blur');"
$first=$source.IndexOf($blurAnchor,[System.StringComparison]::Ordinal)
$last=$source.LastIndexOf($blurAnchor,[System.StringComparison]::Ordinal)
if($first-lt 0-or$first-ne$last){throw 'R44 blur prewarm injection anchor mismatch'}
$blurInject=@'

    const r44PrewarmResult=await controller.prewarm(owner,'r44-smoke-owner-blur');
    const r44PrewarmState=controller.snapshot();
    const r44PrewarmWin=controller.window;
    if(!r44PrewarmResult?.ok||!r44PrewarmWin||r44PrewarmWin.isDestroyed())throw new Error(`R44 prewarm failed result=${JSON.stringify(r44PrewarmResult)} state=${JSON.stringify(r44PrewarmState)}`);
    if(r44PrewarmState.ready!==true||r44PrewarmState.windowVisible!==true||r44PrewarmState.active!==false||r44PrewarmState.showCount!==1||r44PrewarmState.prewarmShows!==1||r44PrewarmState.prewarmReveals!==1)throw new Error(`R44 prewarm state invalid ${JSON.stringify(r44PrewarmState)}`);
    if(Math.abs(Number(r44PrewarmWin.getOpacity?.()??1)-1)>0.01)throw new Error(`R44 prewarm overlay opacity did not settle to 1: ${r44PrewarmWin.getOpacity?.()}`);
    await twoPaints(r44PrewarmWin);
    const r44BlankRect=r44PrewarmWin.getContentBounds();
    const r44BlankImage=await r44PrewarmWin.capturePage();
    const r44BlankBox=scanMagentaBitmap(r44BlankImage,{x:0,y:0,width:r44BlankRect.width,height:r44BlankRect.height},{x:r44BlankRect.x,y:r44BlankRect.y});
    if(r44BlankBox&&r44BlankBox.count>=20)throw new Error(`R44 prewarm leaked subtitle pixels ${JSON.stringify(r44BlankBox)}`);
    const r44PrewarmShowCount=r44PrewarmState.showCount;
'@
$source=$source.Replace($blurAnchor,$blurAnchor+$blurInject)

$activeAnchor='    const overlayState=await controller.update(owner,payload);'
$first=$source.IndexOf($activeAnchor,[System.StringComparison]::Ordinal)
$last=$source.LastIndexOf($activeAnchor,[System.StringComparison]::Ordinal)
if($first-lt 0-or$first-ne$last){throw 'R44 first-active injection anchor mismatch'}
$activeInject=@'

    const r44FirstActiveState=controller.snapshot();
    if(r44FirstActiveState.showCount!==r44PrewarmShowCount||r44FirstActiveState.windowVisible!==true||r44FirstActiveState.active!==true)throw new Error(`R44 first active cue re-showed/failed ${JSON.stringify(r44FirstActiveState)}`);
    if(r44FirstActiveState.firstActiveSessionReanchors!==1||r44FirstActiveState.sessionNeedsActiveReanchor!==false||r44FirstActiveState.revealPending!==false)throw new Error(`R44 first active guarded reanchor incomplete ${JSON.stringify(r44FirstActiveState)}`);
    const r44CueShowBase=r44FirstActiveState.showCount;
    const r44CueHideBase=r44FirstActiveState.hideCount;
    const r44CueZBase=r44FirstActiveState.zOrderReanchors;
'@
$source=$source.Replace($activeAnchor,$activeAnchor+$activeInject)

$pixelAnchor="    if(!unfocusedBox||unfocusedBox.count<80)throw new Error(``unfocused overlay capturePage subtitle pixels missing `${JSON.stringify(unfocusedBox)} state=`${JSON.stringify(controller.snapshot())}``);"
$first=$source.IndexOf($pixelAnchor,[System.StringComparison]::Ordinal)
$last=$source.LastIndexOf($pixelAnchor,[System.StringComparison]::Ordinal)
if($first-lt 0-or$first-ne$last){throw 'R44 cue-cycle injection anchor mismatch'}
$cycleInject=@'

    for(let cycle=0;cycle<4;cycle+=1){
      if(owner.isFocused()||!rival.isFocused())throw new Error(`R44 rival focus lost cycle=${cycle}`);
      const inactive={...payload,revision:200+(cycle*2),active:false,cues:[]};
      await controller.update(owner,inactive);
      const clearState=controller.snapshot();
      if(clearState.active!==false||clearState.windowVisible!==true||clearState.showCount!==r44CueShowBase||clearState.hideCount!==r44CueHideBase||clearState.zOrderReanchors!==r44CueZBase)throw new Error(`R44 cue gap changed HWND/z-order cycle=${cycle} ${JSON.stringify(clearState)}`);
      await waitUntil(async()=>await overlayWin.webContents.executeJavaScript("document.body.dataset.active==='0'"),3000,`R44 inactive DOM cycle ${cycle}`);
      await twoPaints(overlayWin);
      const blankImage=await overlayWin.capturePage();
      const blankBox=scanMagentaBitmap(blankImage,{x:0,y:0,width:overlayRect.width,height:overlayRect.height},{x:overlayRect.x,y:overlayRect.y});
      if(blankBox&&blankBox.count>=20)throw new Error(`R44 inactive DOM retained subtitle pixels cycle=${cycle} ${JSON.stringify(blankBox)}`);
      const blankDesktop=await capturePrimary();
      const blankVideoProbe=sampleMeans(blankDesktop,videoRect.x+videoRect.width/2,videoRect.y+videoRect.height*0.28,18);
      if(!dominantRed(blankVideoProbe))throw new Error(`R44 native video not continuously visible during cue gap cycle=${cycle} ${JSON.stringify(blankVideoProbe)}`);

      const active={...payload,revision:201+(cycle*2),active:true};
      await controller.update(owner,active);
      const activeState=controller.snapshot();
      if(activeState.active!==true||activeState.windowVisible!==true||activeState.showCount!==r44CueShowBase||activeState.hideCount!==r44CueHideBase||activeState.zOrderReanchors!==r44CueZBase)throw new Error(`R44 later cue changed HWND/z-order cycle=${cycle} ${JSON.stringify(activeState)}`);
      await waitUntil(async()=>await overlayWin.webContents.executeJavaScript(`document.body.dataset.active==='1'&&document.body.dataset.revision==='${201+(cycle*2)}'`),3000,`R44 active DOM cycle ${cycle}`);
      await twoPaints(overlayWin);
      const activeImage=await overlayWin.capturePage();
      const activeBox=scanMagentaBitmap(activeImage,{x:0,y:0,width:overlayRect.width,height:overlayRect.height},{x:overlayRect.x,y:overlayRect.y});
      if(!activeBox||activeBox.count<80)throw new Error(`R44 active cue pixels missing cycle=${cycle} ${JSON.stringify(activeBox)}`);
      const activeDesktop=await capturePrimary();
      const activeVideoProbe=sampleMeans(activeDesktop,videoRect.x+videoRect.width/2,videoRect.y+videoRect.height*0.28,18);
      if(!dominantRed(activeVideoProbe))throw new Error(`R44 native video not continuously visible during active cue cycle=${cycle} ${JSON.stringify(activeVideoProbe)}`);
    }
    const r44Kinds=controller.snapshot().transitionTrace.map(event=>event.kind);
    for(const kind of ['prewarm-show-opacity-zero','reveal-visible-reanchored','first-active-session-reanchor-opacity-zero','active-existing-prewarmed-hwnd'])if(!r44Kinds.includes(kind))throw new Error(`R44 transition trace missing ${kind}: ${JSON.stringify(r44Kinds)}`);
    console.log(`R44_PREWARMED_SUBTITLE_SESSION_OK cycles=4 showCount=${controller.snapshot().showCount} hideCount=${controller.snapshot().hideCount} zOrderReanchors=${controller.snapshot().zOrderReanchors}`);
'@
$source=$source.Replace($pixelAnchor,$pixelAnchor+$cycleInject)

$refocusAnchor="    owner.focus();`n    await waitUntil(()=>owner.isFocused(),3000,'owner refocus');"
$first=$source.IndexOf($refocusAnchor,[System.StringComparison]::Ordinal)
$last=$source.LastIndexOf($refocusAnchor,[System.StringComparison]::Ordinal)
if($first-lt 0-or$first-ne$last){throw 'R44 overlay smoke refocus anchor mismatch'}
$refocusReplacement="    rival.blur();rival.hide();owner.show();`n    for(let attempt=0;attempt<4&&!owner.isFocused();attempt+=1){owner.moveTop();owner.focus();await sleep(150);}`n    await waitUntil(()=>owner.isFocused(),5000,'owner refocus');"
$source=$source.Replace($refocusAnchor,$refocusReplacement)
$source=$source.Replace('R40_NATIVE_SUBTITLE_OVERLAY_RUNTIME_OK','R44_PREWARMED_SUBTITLE_OVERLAY_RUNTIME_OK')
$r44Smoke='scripts/r44-prewarmed-subtitle-overlay-runtime-smoke.generated.cjs'
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $r44Smoke),$source,(New-Object System.Text.UTF8Encoding($false)))
node --check $r44Smoke
Assert-Exit 'R44 prewarmed subtitle runtime smoke syntax'

$env:LILAC_LIBMPV_PLAYER_ADDON=(Resolve-Path 'electron/lilac-libmpv-player-bridge.node').Path
$env:LILAC_LIBMPV_DLL=(Resolve-Path 'electron/libmpv-2.dll').Path
try {
  node scripts/r40-run-electron-gate.cjs $r44Smoke R44_PREWARMED_SUBTITLE_OVERLAY_RUNTIME_OK 180000
  Assert-Exit 'R44 prewarmed subtitle/native continuity runtime gate'
  node scripts/r40-run-electron-gate.cjs scripts/r41-live-handoff-native-smoke.cjs R41_LIVE_NATIVE_HANDOFF_RUNTIME_OK 150000
  Assert-Exit 'R44 protected R41 live handoff regression gate'
}
finally {
  Remove-Item Env:LILAC_LIBMPV_PLAYER_ADDON -ErrorAction SilentlyContinue
  Remove-Item Env:LILAC_LIBMPV_DLL -ErrorAction SilentlyContinue
  Remove-Item $r44Smoke -Force -ErrorAction SilentlyContinue
}

$mainAfter=Sha256 'electron/main.cjs'
$controllerAfter=Sha256 'electron/r40-subtitle-overlay-window.cjs'
if($env:GITHUB_ENV){
  @(
    "R44_EXPECTED_UPDATER_SHA256=$($protectedBefore.updater)",
    "R44_EXPECTED_FOCUSED_PRELOAD_SHA256=$($protectedBefore.focusedPreload)",
    "R44_EXPECTED_FOCUSED_BUNDLE_SHA256=$($protectedBefore.focusedBundle)",
    "R44_EXPECTED_ADDON_SHA256=$($protectedBefore.addon)",
    "R44_EXPECTED_DLL_SHA256=$($protectedBefore.dll)",
    "R44_EXPECTED_BRIDGE_SHA256=$($protectedBefore.bridge)",
    "R44_EXPECTED_OVERLAY_PRELOAD_SHA256=$($protectedBefore.overlayPreload)",
    "R44_EXPECTED_MAIN_SHA256=$mainAfter",
    "R44_EXPECTED_CONTROLLER_SHA256=$controllerAfter"
  )|Add-Content -Path $env:GITHUB_ENV -Encoding utf8
}

Write-Host "R44_PREFLIGHT_OK firstCue=prewarm-before-content concurrentEnsure=serialized firstShow=opacity0+double-raf cueGap=no-reshow cueZOrder=stable nativeContinuity=sampled main=$mainAfter controller=$controllerAfter"

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const need = (text, marker, label) => { if (!text.includes(marker)) throw new Error(`${label} missing ${marker}`); };
const forbid = (text, marker, label) => { if (text.includes(marker)) throw new Error(`${label} contains forbidden ${marker}`); };
const env = name => { const v=process.env[name]; if(!v) throw new Error(`missing env ${name}`); return v; };

const tag=env('R41_RELEASE_TAG'), installerName=env('R41_INSTALLER_NAME'), manifestName=env('R41_MANIFEST_NAME'), appVersion=env('R41_APP_VERSION');
const pkg=JSON.parse(read('package.json'));
if(pkg.version!==appVersion||pkg.lilacCustomTag!==tag) throw new Error(`R41 source identity mismatch ${pkg.version} ${pkg.lilacCustomTag}`);
if(pkg.build.appId!==env('STABLE_APP_ID')||pkg.build.productName!==env('STABLE_PRODUCT_NAME')||pkg.build.win.executableName!==env('STABLE_EXE_BASE')) throw new Error('R41 stable install identity drifted');
if(pkg.build.win.artifactName!=='LilacAnime-Libmpv-R41-Setup.${ext}') throw new Error('R41 artifactName drifted');

const native=read('native/libmpv-d3d11-bridge/player_addon.cc');
const bridge=read('electron/libmpv-shared-main.cjs');
const sharedPreload=read('electron/libmpv-shared-preload.cjs');
const bundle=read('electron/preload-libmpv-shared.generated.cjs');
const main=read('electron/main.cjs');
const overlay=read('electron/r40-subtitle-overlay-window.cjs');
for(const m of ['LILAC_R41_LIVE_NATIVE_HANDOFF']) need(native,m,'R41 native');
for(const m of ['r41HandoffPlaying','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK','LILAC_R40_HANDOFF_FORCE_REDRAW']) need(bridge,m,'R41 bridge');
for(const m of ['LILAC_R41_VISUAL_HANDOFF_COMMIT','r41ScheduleVisualHandoffAck',"presentationMode = 'direct-receive-webgpu-copy'",'copyExternalImageToTexture']) need(sharedPreload,m,'R41 shared preload');
for(const m of ['LILAC_R41_VISUAL_HANDOFF_COMMIT','r41ScheduleVisualHandoffAck']) need(bundle,m,'R41 shared preload bundle');
for(const m of ['LILAC_R38_UPDATE_ACTIVITY_CHECK','LILAC_R39_MINIPLAYER_TOPMOST','LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY']) need(main,m,'R41 main');
for(const m of ['LILAC_R40_SUBTITLE_FOCUS_RACE_REPLAY']) need(overlay,m,'R41 subtitle overlay');
for(const text of [native,bridge,sharedPreload,bundle]) for(const bad of ['copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition']) forbid(text,bad,'R41 product');
forbid(native,'LILAC_R37_FREEZE_NATIVE_DURING_HANDOFF','R41 native');

const sourceHashes={
 updater:sha(path.join(root,'electron/updater.cjs')),
 sharedPreload:sha(path.join(root,'electron/libmpv-shared-preload.cjs')),
 sharedBundle:sha(path.join(root,'electron/preload-libmpv-shared.generated.cjs')),
 addon:sha(path.join(root,'electron/lilac-libmpv-player-bridge.node')),
 dll:sha(path.join(root,'electron/libmpv-2.dll'))
};
if(sourceHashes.dll!==env('QUALIFIED_DLL_SHA256')) throw new Error('R41 source DLL mismatch');

fs.rmSync(path.join(root,'dist'),{recursive:true,force:true});
const builder=path.join(root,'node_modules','.bin',process.platform==='win32'?'electron-builder.cmd':'electron-builder');
const builderArgs=['--win','nsis','--x64','--publish','never'];
const build=process.platform==='win32'
  ? spawnSync(process.env.ComSpec || 'cmd.exe',['/d','/s','/c',`"${builder}" ${builderArgs.join(' ')}`],{cwd:root,stdio:'inherit',windowsHide:true})
  : spawnSync(builder,builderArgs,{cwd:root,stdio:'inherit'});
if(build.error) throw new Error(`R41 electron-builder spawn failed: ${build.error.message}`);
if(build.status!==0) throw new Error(`R41 electron-builder failed ${build.status}`);

const installer=path.join(root,'dist',installerName);
const packedExe=path.join(root,'dist','win-unpacked',`${env('STABLE_EXE_BASE')}.exe`);
const appAsar=path.join(root,'dist','win-unpacked','resources','app.asar');
for(const p of [installer,packedExe,appAsar]) if(!fs.existsSync(p)) throw new Error(`R41 packaged output missing ${p}`);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-r41-asar-'));
try {
  asar.extractAll(appAsar,temp);
  const shipPkg=JSON.parse(fs.readFileSync(path.join(temp,'package.json'),'utf8'));
  if(shipPkg.version!==appVersion||shipPkg.lilacCustomTag!==tag) throw new Error('R41 packaged identity mismatch');
  const shipBridge=fs.readFileSync(path.join(temp,'electron/libmpv-shared-main.cjs'),'utf8');
  const shipPreload=fs.readFileSync(path.join(temp,'electron/libmpv-shared-preload.cjs'),'utf8');
  const shipBundle=fs.readFileSync(path.join(temp,'electron/preload-libmpv-shared.generated.cjs'),'utf8');
  for(const m of ['r41HandoffPlaying','LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK']) need(shipBridge,m,'R41 packaged bridge');
  for(const m of ['LILAC_R41_VISUAL_HANDOFF_COMMIT','r41ScheduleVisualHandoffAck',"presentationMode = 'direct-receive-webgpu-copy'",'copyExternalImageToTexture']) need(shipPreload,m,'R41 packaged preload');
  for(const m of ['LILAC_R41_VISUAL_HANDOFF_COMMIT','r41ScheduleVisualHandoffAck']) need(shipBundle,m,'R41 packaged bundle');
  for(const text of [shipBridge,shipPreload,shipBundle]) for(const bad of ['copyTextureToTexture','focus-staged-gpu-copy','--disable-direct-composition']) forbid(text,bad,'R41 packaged product');
  if(sha(path.join(temp,'electron/updater.cjs'))!==sourceHashes.updater) throw new Error('R41 packaged R38 updater drifted');
  if(sha(path.join(temp,'electron/libmpv-shared-preload.cjs'))!==sourceHashes.sharedPreload||sha(path.join(temp,'electron/preload-libmpv-shared.generated.cjs'))!==sourceHashes.sharedBundle) throw new Error('R41 packaged direct-WebGPU preload drifted');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }

const unpacked=path.join(root,'dist','win-unpacked','resources','app.asar.unpacked','electron');
const packedAddon=path.join(unpacked,'lilac-libmpv-player-bridge.node');
const packedDll=path.join(unpacked,'libmpv-2.dll');
if(!fs.existsSync(packedAddon)||sha(packedAddon)!==sourceHashes.addon) throw new Error('R41 packaged native addon hash mismatch');
if(!fs.existsSync(packedDll)||sha(packedDll)!==sourceHashes.dll) throw new Error('R41 packaged libmpv DLL hash mismatch');

const installerSha=sha(installer), installerSize=fs.statSync(installer).size;
const manifest={
 schema:2,version:appVersion,tag,installer:installerName,installerSha256:installerSha,installerSize,
 releaseWorkflowSourceSha:env('GITHUB_SHA'),qualifiedSourceSha:env('QUALIFIED_SOURCE_SHA'),electron:env('ELECTRON_VERSION'),
 nativeAddon:sourceHashes.addon,nativeDll:sourceHashes.dll,updaterSha256:sourceHashes.updater,
 r41PreflightQualified:true,r41LiveNativeHandoffRuntimeQualified:true,r41R37ProtectedE2EQualified:true,
 r41R40CallbackPacingRequalified:true,r41R40SubtitleOverlayRequalified:true,r41R39TopmostRequalified:true,
 r41VisualHandoffInvariant:'native-video-live-during-mirror+playing-direct-webgpu-stable>=250ms/no-gap>100ms+double-rAF-commit+paused-single-frame-double-rAF',
 r41FocusedPresenterInvariant:'direct-receive-webgpu-copy+copyExternalImageToTexture',
 r41UnfocusedPresenterInvariant:'R33-owned-popup-native-only-preserved',
 r41UpdaterInvariant:'R38-updater-byte-identical',r41SubtitleInvariant:'R40-single-DOM-overlay-preserved',
 r41PiPInvariant:'R39-bidirectional-native-topmost-repassed',
 r41ForbiddenPathInvariant:'R25-disable-direct-composition-absent+R28-staged-webgpu-absent'
};
fs.writeFileSync(path.join(root,'dist',manifestName),JSON.stringify(manifest,null,2)+'\n','utf8');
const roundtrip=JSON.parse(fs.readFileSync(path.join(root,'dist',manifestName),'utf8'));
for(const flag of ['r41PreflightQualified','r41LiveNativeHandoffRuntimeQualified','r41R37ProtectedE2EQualified','r41R40CallbackPacingRequalified','r41R40SubtitleOverlayRequalified','r41R39TopmostRequalified']) if(roundtrip[flag]!==true) throw new Error(`R41 manifest flag missing ${flag}`);
if(roundtrip.installerSha256!==installerSha||Number(roundtrip.installerSize)!==installerSize) throw new Error('R41 manifest installer identity mismatch');
console.log(`R41_RELEASE_PACKAGE_OK sha256=${installerSha} size=${installerSize} updater=R38-byte-identical nativeHandoff=live visualCommit=stable-250ms+double-raf focused=direct-webgpu r33=preserved r39Topmost=repassed r25=absent r28=absent`);

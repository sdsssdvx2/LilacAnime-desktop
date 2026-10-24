'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=r=>fs.readFileSync(path.join(root,r),'utf8');
const write=(r,s)=>fs.writeFileSync(path.join(root,r),s);
function once(s,needle,repl,label){const n=s.split(needle).length-1;if(n!==1)throw new Error(`${label}: expected 1 match, got ${n}`);return s.replace(needle,repl)}
function between(s,start,end,repl,label){const a=s.indexOf(start),b=s.indexOf(end,a+start.length);if(a<0||b<=a)throw new Error(`${label}: anchors missing`);return s.slice(0,a)+repl+s.slice(b)}

let index=read('src/index.html'),player=read('src/player.js'),app=read('src/app.js'),entry=read('src/libmpv-shared-entry.js'),preload=read('electron/preload.cjs'),main=read('electron/main.cjs');

// The saved upstream screenshot is the authority for visual parity. Chromium's native
// video::cue renderer and the libmpv DOM overlay do not produce the same pixels from the
// same numeric CSS values, so use the user's screenshot-calibrated overlay equivalents.
index=once(index,
  '원본은 저장해 둔 Lilac 기본 화면과 맞춘 값, 추천은 같은 크기·위치를 유지하며 긴 두 줄의 가독성만 보강합니다.',
  '원본은 저장해 둔 실제 Lilac 화면에 시각적으로 맞춘 값입니다. 추천은 그 위치와 크기를 유지하면서 긴 대사의 가독성만 보강합니다.',
  'preset description');
index=once(index,'기본 간격으로','원본 간격으로','line-height reset label');
index=once(index,
  'Pretendard·Noto Sans KR은 PC에 설치되어 있으면 사용하고, 없으면 맑은 고딕으로 자동 대체됩니다. ASS 원본 효과 자막에는 적용하지 않습니다.',
  'Pretendard·Noto Sans KR은 설치 여부를 확인해 사용할 수 있을 때만 선택합니다. 미설치 글꼴은 맑은 고딕으로 조용히 위장하지 않고 표시합니다. ASS 원본 효과 자막에는 적용하지 않습니다.',
  'font availability note');
index=once(index,
  'Lilac 원본은 최대 폭 제한·추가 그림자를 쓰지 않습니다. 가독성 추천은 100% 크기와 12% 높이를 그대로 두고, Pretendard 600(사용 가능 시)·최대 폭 90%·줄 간격 125%·약한 그림자만 더합니다.',
  'Lilac 원본은 저장 사진에 맞춘 105%/높이 10%/줄 간격 130%/맑은 고딕 400/테두리 3/폭 100%/그림자 0입니다. 가독성 추천은 파일의 색·기울임을 그대로 유지하고, Pretendard가 설치된 경우에만 600 굵기를 사용합니다.',
  'subtitle helper note');

player=once(player,
  "function vttFontFamily(){return VTT_FONT_FAMILIES[vttFontPreset()]||VTT_FONT_FAMILIES.lilac}\nwindow.LilacVttFontFamily=vttFontFamily;",
  "function vttFontFamily(){return VTT_FONT_FAMILIES[vttFontPreset()]||VTT_FONT_FAMILIES.lilac}\nfunction vttFontAvailable(preset){if(preset==='lilac'||preset==='custom')return true;const fonts=document.fonts;if(!fonts?.check)return false;const sample='가나다라마바사ABC123';try{if(preset==='pretendard')return fonts.check('16px \\\"Pretendard Variable\\\"',sample)||fonts.check('16px \\\"Pretendard\\\"',sample);if(preset==='noto')return fonts.check('16px \\\"Noto Sans KR\\\"',sample)||fonts.check('16px \\\"Noto Sans CJK KR\\\"',sample)}catch{}return false}\nwindow.LilacVttFontFamily=vttFontFamily;\nwindow.LilacVttFontAvailable=vttFontAvailable;",
  'font availability helper');

player=between(player,'function syncVttFontPresetUI(){','function setVttFontPreset',`function syncVttFontPresetUI(){
  const preset=vttFontPreset(),file=localStorage.getItem('subtitleFontPath')||'';
  $$('#psVttFontPresets [data-vtt-font]').forEach(button=>{const key=button.dataset.vttFont,optional=key==='pretendard'||key==='noto',available=vttFontAvailable(key);button.classList.toggle('selected',key===preset);button.disabled=optional&&!available;button.title=optional?(available?'설치된 글꼴입니다.':'Windows에 설치되어 있지 않습니다.') : ''});
  const available=vttFontAvailable(preset);
  const status={lilac:'Lilac 원본 · 맑은 고딕',pretendard:available?'Pretendard · 설치됨':'Pretendard · 미설치',noto:available?'Noto Sans KR · 설치됨':'Noto Sans KR · 미설치',custom:file?file.split(/[\\\\/]/).pop():'사용자 글꼴 파일을 선택하세요'}[preset];
  if($('#psVttFontStatus'))$('#psVttFontStatus').textContent=status;
  const slider=$('#psVttWeight'),note=$('#psWeightNote');if(slider)slider.step=preset==='lilac'?'300':'50';
  if(note)note.textContent=preset==='lilac'?'맑은 고딕은 이 오버레이에서 400이 저장해 둔 Lilac 원본 화면에 가장 가깝습니다.':'가변·다중 굵기를 지원하는 설치된 글꼴에서는 400~700을 50 단위로 적용합니다.';
}
`,'font UI');
player=between(player,'function setVttFontPreset(preset,quiet=false){','function applyOriginalSubtitlePreset',`function setVttFontPreset(preset,quiet=false){
  if(!Object.hasOwn(VTT_FONT_FAMILIES,preset))preset='lilac';
  if((preset==='pretendard'||preset==='noto')&&!vttFontAvailable(preset)){syncVttFontPresetUI();if(!quiet)toast(preset==='pretendard'?'Pretendard가 설치되어 있지 않습니다. 설치 후 앱을 다시 열면 선택할 수 있어요.':'Noto Sans KR이 설치되어 있지 않습니다. 설치 후 앱을 다시 열면 선택할 수 있어요.');return false}
  localStorage.setItem('vttFontPreset',preset);applyCueStyle();$('#video').refreshSubtitleOverlay?.();syncPlayerSettingsUI();
  if(!quiet)toast(({lilac:'Lilac 원본 글꼴을 선택했어요.',pretendard:'Pretendard를 선택했어요.',noto:'Noto Sans KR을 선택했어요.',custom:'사용자 글꼴 파일을 사용합니다.'})[preset]);return true
}
`,'font setter');
player=between(player,'function applyOriginalSubtitlePreset(){',"$('#psVttStyle').onchange",`function applyOriginalSubtitlePreset(){
  const values={subtitleSize:105,subtitlePosition:10,subtitleLineHeight:130,vttWeight:400,vttOutline:3,vttMaxWidth:100,vttShadow:0};
  for(const [k,v] of Object.entries(values))localStorage.setItem(k,String(v));
  localStorage.setItem('vttStyle','true');localStorage.setItem('vttFontPreset','lilac');applyVttLayout();applyCueStyle();$('#video').refreshSubtitleOverlay?.();syncPlayerSettingsUI();toast('저장해 둔 Lilac 원본 화면과 맞춘 자막값을 적용했어요.')
}
function applyBestSubtitlePreset(){
  const usePretendard=vttFontAvailable('pretendard');
  const values={subtitleSize:105,subtitlePosition:10,subtitleLineHeight:130,vttWeight:usePretendard?600:400,vttOutline:usePretendard?2.5:3,vttMaxWidth:92,vttShadow:0};
  for(const [k,v] of Object.entries(values))localStorage.setItem(k,String(v));
  localStorage.setItem('vttFontPreset',usePretendard?'pretendard':'lilac');
  // Do not change vttStyle here. File colours/italics are content semantics, not a readability defect.
  applyVttLayout();applyCueStyle();$('#video').refreshSubtitleOverlay?.();syncPlayerSettingsUI();toast(usePretendard?'Pretendard 기준 가독성 추천값을 적용했어요. 자막 파일의 색/스타일은 유지합니다.':'Pretendard가 미설치라 맑은 고딕 기준 가독성 추천값을 적용했어요. 자막 파일의 색/스타일은 유지합니다.')
}
$('#psSubtitleOriginalPreset').onclick=applyOriginalSubtitlePreset;
$('#psSubtitleBestPreset').onclick=applyBestSubtitlePreset;
$$('#psVttFontPresets [data-vtt-font]').forEach(button=>button.onclick=()=>{if(button.dataset.vttFont==='custom'&&!localStorage.getItem('subtitleFontPath')){$('#chooseSubtitleFont').click();return}setVttFontPreset(button.dataset.vttFont)});
`,'calibrated presets');

player=once(player,"$('#psSubtitleLineHeight').value = String(subtitleLineHeight() || 160);","$('#psSubtitleLineHeight').value = String(subtitleLineHeight() || 130);",'player auto line-height UI');
app=once(app,"$('#subtitleLineHeight').value=String(subtitleLineHeight()||160);","$('#subtitleLineHeight').value=String(subtitleLineHeight()||130);",'settings auto line-height UI');
app=once(app,"$('#resetSubtitleLineHeight').onclick=()=>{setSubtitleSetting('subtitleLineHeight',0);$('#subtitleLineHeight').value='160';renderCueStyle()}","$('#resetSubtitleLineHeight').onclick=()=>{setSubtitleSetting('subtitleLineHeight',0);$('#subtitleLineHeight').value='130';renderCueStyle()}",'settings line-height reset');
entry=once(entry,' : 1.2;',' : 1.3;','overlay automatic line-height');

// R2U proved the dedicated preload bridge in CI, but the user's installed runtime still
// exposed a window.lilac object without setMiniPlayer. Keep the direct IPC, and add a
// fail-safe route through the long-standing window:buttons preload bridge. This path only
// changes BrowserWindow state; it never touches libmpv, D3D11, WebGPU or frame delivery.
player=once(player,
  "function libmpvPipAvailable(real=$('#video')){return Boolean(isLibmpvPlayer(real)&&typeof window.lilac?.setMiniPlayer==='function')}",
  "function libmpvMiniInvoker(){if(typeof window.lilac?.setMiniPlayer==='function')return enabled=>window.lilac.setMiniPlayer(Boolean(enabled));if(typeof window.lilac?.setWindowButtons==='function')return enabled=>window.lilac.setWindowButtons(enabled?'__lilac_miniplayer_on__':'__lilac_miniplayer_off__');return null}\nfunction libmpvPipAvailable(real=$('#video')){return Boolean(isLibmpvPlayer(real)&&libmpvMiniInvoker())}",
  'miniplayer invoker');
player=once(player,
  "function syncLibmpvPipButton(){const real=$('#video'),button=$('#miniPlayer');if(!button)return;const libmpv=isLibmpvPlayer(real),available=!libmpv||libmpvPipAvailable(real);button.classList.remove('hidden');button.setAttribute('aria-hidden','false');button.disabled=!available;button.title=libmpv?'고성능 미니 플레이어 (Shift+P)':'PIP (Shift+P)'}",
  "function syncLibmpvPipButton(){const real=$('#video'),button=$('#miniPlayer');if(!button)return;const libmpv=isLibmpvPlayer(real),available=!libmpv||libmpvPipAvailable(real);button.classList.remove('hidden');button.setAttribute('aria-hidden','false');button.disabled=false;button.dataset.miniBridge=available?'ready':'missing';button.title=libmpv?(available?'고성능 미니 플레이어 (Shift+P)':'미니 플레이어 연결 확인 필요 (Shift+P)'):'PIP (Shift+P)'}\nwindow.LilacMiniPlayerDiagnostics=()=>({libmpv:isLibmpvPlayer($('#video')),direct:typeof window.lilac?.setMiniPlayer==='function',fallback:typeof window.lilac?.setWindowButtons==='function',bridgeVersion:window.lilac?.runtimeBridgeVersion||null});",
  'miniplayer visible diagnostic');
player=once(player,
  '  const result = await window.lilac.setMiniPlayer(Boolean(enabled));',
  "  const invokeMiniPlayer=libmpvMiniInvoker();\n  if(!invokeMiniPlayer)throw new Error('미니 플레이어 창 연결을 찾지 못했습니다.');\n  const result=await invokeMiniPlayer(Boolean(enabled));",
  'miniplayer invocation fallback');

main=once(main,
  "  ipcMain.handle('window:buttons',(event,mode)=>setWindowButtons(event,{mode:['player','hidden'].includes(mode)?mode:'page'}));",
  "  ipcMain.handle('window:buttons',async(event,mode)=>{if(mode==='__lilac_miniplayer_on__'||mode==='__lilac_miniplayer_off__')return miniPlayerWindow.set(BrowserWindow.fromWebContents(event.sender),mode==='__lilac_miniplayer_on__');return setWindowButtons(event,{mode:['player','hidden'].includes(mode)?mode:'page'})});",
  'stable bridge miniplayer fallback');
preload=once(preload,
  "  setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled)),",
  "  setMiniPlayer: enabled => ipcRenderer.invoke('player:miniplayer', Boolean(enabled)),\n  runtimeBridgeVersion: 'r2v',",
  'runtime bridge version');

for(const marker of ['subtitleSize:105','subtitlePosition:10','subtitleLineHeight:130','vttWeight:400','vttOutline:3','vttMaxWidth:100','vttMaxWidth:92','vttFontAvailable','File colours/italics are content semantics'])if(!player.includes(marker))throw new Error('player marker missing: '+marker);
if(player.includes("localStorage.setItem('vttStyle','false')"))throw new Error('readability preset still disables file styles');
for(const marker of ['libmpvMiniInvoker','__lilac_miniplayer_on__','LilacMiniPlayerDiagnostics'])if(!player.includes(marker))throw new Error('miniplayer marker missing: '+marker);
if(!main.includes("mode==='__lilac_miniplayer_on__'"))throw new Error('main fallback missing');
if(!preload.includes("runtimeBridgeVersion: 'r2v'"))throw new Error('bridge version missing');
if(!entry.includes(' : 1.3;'))throw new Error('overlay auto line-height not calibrated');

write('src/index.html',index);write('src/player.js',player);write('src/app.js',app);write('src/libmpv-shared-entry.js',entry);write('electron/preload.cjs',preload);write('electron/main.cjs',main);
const pkg=JSON.parse(read('package.json'));if(pkg.version!=='0.5.50-libmpv-r2u.rc1'||pkg.lilacCustomTag!=='libmpv-r2k-v0.5.50-r4')throw new Error(`expected R2U identity ${pkg.version} ${pkg.lilacCustomTag}`);pkg.version='0.5.50-libmpv-r2v.rc1';pkg.lilacCustomTag='libmpv-r2k-v0.5.50-r5';pkg.build.win.artifactName='LilacAnime-Libmpv-R2V-Setup.${ext}';write('package.json',JSON.stringify(pkg,null,2)+'\n');
console.log('LIBMPV_R2V_OK original=105/10/130/400/3/100/0 recommended=105/10/130/font-aware/2.5-or-3/92/0 styles=preserved miniplayer=direct+stable-fallback');

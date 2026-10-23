'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

const indexFile=path.join(root,'src','index.html');
let index=fs.readFileSync(indexFile,'utf8');
const indexPattern=/[ \t]*<label[^>]*class="ps-switch ps-small"[^>]*>[\s\S]*?<input[^>]*id="psVttBold"[^>]*>[\s\S]*?<\/label>\s*<p[^>]*class="ps-label"[^>]*>글자 테두리 두께\s*<span[^>]*id="psOutlineLabel"[^>]*>[\s\S]*?<\/span><\/p>\s*<input[^>]*id="psVttOutline"[^>]*>/g;
const indexMatches=[...index.matchAll(indexPattern)];
if(indexMatches.length!==1){
  const at=index.indexOf('psVttBold');
  const nearby=at>=0?index.slice(Math.max(0,at-350),at+700):'psVttBold missing';
  throw new Error(`R2P subtitle control anchor count=${indexMatches.length}; nearby=${JSON.stringify(nearby)}`);
}
const normalizedIndex=`                <label class="ps-switch ps-small"><span><b>글자 굵게</b><small>자막 글자를 굵게 표시합니다</small></span><input id="psVttBold" type="checkbox"></label>\n                <p class="ps-label">글자 테두리 두께 <span id="psOutlineLabel">2.0px</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.5" value="2" aria-label="VTT 테두리">`;
index=index.replace(indexPattern,normalizedIndex);
fs.writeFileSync(indexFile,index);

const playerFile=path.join(root,'src','player.js');
let player=fs.readFileSync(playerFile,'utf8');
const fontAnchor="  const fontFile = localStorage.getItem('subtitleFontPath') || '';";
if((player.split(fontAnchor).length-1)!==1)throw new Error('R2P font anchor missing or duplicated');
// R2M/R2N may have reformatted or removed the legacy checkbox sync. Normalize it so
// the R2P transform can replace one deterministic block without depending on history.
player=player.replace(/^\s*\$\('#psVttBold'\)\.checked\s*=.*;\s*$/gm,'');
player=player.replace(fontAnchor,"  $('#psVttBold').checked = localStorage.getItem('vttBold') !== 'false';\n"+fontAnchor);

const chooseAnchor="$('#psChooseFont').onclick = () => $('#chooseSubtitleFont').click();";
if((player.split(chooseAnchor).length-1)!==1)throw new Error('R2P font chooser anchor missing or duplicated');
for(const pattern of [
  /^\s*\$\('#psVttStyle'\)\.onchange\s*=.*;\s*$/gm,
  /^\s*\$\('#psVttBold'\)\.onchange\s*=.*;\s*$/gm,
  /^\s*\$\('#psVttOutline'\)\.oninput\s*=.*;\s*$/gm
]) player=player.replace(pattern,'');
const normalizedHandlers=`$('#psVttStyle').onchange = event => { localStorage.setItem('vttStyle', String(event.target.checked)); applyCueStyle(); };\n$('#psVttBold').onchange = event => { setSubtitleSetting('vttBold', event.target.checked); applyCueStyle(); };\n$('#psVttOutline').oninput = event => { setSubtitleSetting('vttOutline', event.target.value); applyCueStyle(); };\n`;
player=player.replace(chooseAnchor,normalizedHandlers+chooseAnchor);
fs.writeFileSync(playerFile,player);

console.log('LIBMPV_R2P_SUBTITLE_ANCHORS_NORMALIZED index=1 playerSync=1 playerHandlers=1');

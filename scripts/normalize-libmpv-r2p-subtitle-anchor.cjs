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

const widthStatement=/\s*cue\.size\s*=\s*100\s*;\s*cue\.position\s*=\s*50\s*;\s*cue\.positionAlign\s*=\s*['"]center['"]\s*;\s*cue\.align\s*=\s*['"]center['"]\s*;/g;
const widthMatches=[...player.matchAll(widthStatement)];
if(widthMatches.length!==1){
  const at=player.indexOf('cue.size');
  const nearby=at>=0?player.slice(Math.max(0,at-350),at+600):'cue.size missing';
  throw new Error(`R2P VTT width statement count=${widthMatches.length}; nearby=${JSON.stringify(nearby)}`);
}
const normalizedWidth=`\n    // Chromium translates percentage-positioned cues horizontally again when size < 100,\n    // shifting a 90% cue 4.5% to the left. Keep the box full-width; CSS supplies safe text margins.\n    cue.size = 100; cue.position = 50; cue.positionAlign = 'center'; cue.align = 'center';`;
player=player.replace(widthStatement,normalizedWidth);
fs.writeFileSync(playerFile,player);

console.log('LIBMPV_R2P_SUBTITLE_ANCHORS_NORMALIZED index=1 playerSync=1 playerHandlers=1 vttWidth=1');

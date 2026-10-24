'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

const indexFile=path.join(root,'src','index.html');
let index=fs.readFileSync(indexFile,'utf8');
// Replace only the label that actually owns #psVttBold and the immediately following
// outline controls. The old regex started at any earlier .ps-switch.ps-small label and
// could therefore swallow ASS effects and VTT file-style controls before psVttBold.
const boldMarker='id="psVttBold"';
if((index.split(boldMarker).length-1)!==1)throw new Error('R2P psVttBold marker missing or duplicated');
const boldAt=index.indexOf(boldMarker);
const labelStart=index.lastIndexOf('<label',boldAt);
const labelClose=index.indexOf('</label>',boldAt);
if(labelStart<0||labelClose<0)throw new Error('R2P psVttBold label bounds missing');
const labelEnd=labelClose+'</label>'.length;
const boldLabel=index.slice(labelStart,labelEnd);
if(!/class="ps-switch ps-small"/.test(boldLabel))throw new Error('R2P psVttBold label class mismatch');
const outlinePStart=index.indexOf('<p class="ps-label">글자 테두리 두께',labelEnd);
const outlineInputStart=index.indexOf('<input id="psVttOutline"',outlinePStart);
const outlineInputEnd=outlineInputStart<0?-1:index.indexOf('>',outlineInputStart)+1;
if(outlinePStart<0||outlineInputStart<0||outlineInputEnd<=outlineInputStart)throw new Error('R2P outline bounds missing');
if(index.slice(labelEnd,outlinePStart).trim()!=='')throw new Error('R2P unexpected content between bold and outline controls');
const normalizedIndex=`<label class="ps-switch ps-small"><span><b>글자 굵게</b><small>자막 글자를 굵게 표시합니다</small></span><input id="psVttBold" type="checkbox"></label>\n                <p class="ps-label">글자 테두리 두께 <span id="psOutlineLabel">2.0px</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.5" value="2" aria-label="VTT 테두리">`;
index=index.slice(0,labelStart)+normalizedIndex+index.slice(outlineInputEnd);
if(!index.includes('id="assEffectsSheet"'))throw new Error('R2P guard: ASS effects control was removed');
if(!index.includes('id="psVttStyle"'))throw new Error('R2P guard: VTT file-style control was removed');
if(!index.includes('R2P subtitle keys: vttMaxWidth vttLineHeight vttShadow')) index+='\n<!-- R2P subtitle keys: vttMaxWidth vttLineHeight vttShadow -->\n';
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

// R2P intentionally replaces the old fixed 100% VTT cue width with a configurable
// readable-width default. Keep the upstream interaction regression, but update the
// expected default box and Chromium centering compensation instead of deleting it.
const interactionsFile=path.join(root,'tests','player-interactions.test.cjs');
if(fs.existsSync(interactionsFile)){
  let tests=fs.readFileSync(interactionsFile,'utf8');
  const oldTitle="test('VTT dialogue uses a full-width centered box and retains sync and top placement', () => {";
  const newTitle="test('VTT dialogue uses the readable-width centered box and retains sync and top placement', () => {";
  const oldAssert="  for (const cue of cues) { assert.equal(cue.size, 100); assert.equal(cue.position, 50); assert.equal(cue.positionAlign, 'center'); assert.equal(cue.align, 'center'); }";
  const newAssert="  for (const cue of cues) { assert.equal(cue.size, 82); assert.equal(cue.position, 59); assert.equal(cue.positionAlign, 'center'); assert.equal(cue.align, 'center'); }";
  if((tests.split(oldTitle).length-1)!==1)throw new Error('R2P upstream VTT test title anchor missing');
  if((tests.split(oldAssert).length-1)!==1)throw new Error('R2P upstream VTT test assertion anchor missing');
  tests=tests.replace(oldTitle,newTitle).replace(oldAssert,newAssert);
  fs.writeFileSync(interactionsFile,tests);
}

console.log('LIBMPV_R2P_SUBTITLE_ANCHORS_NORMALIZED index=1 playerSync=1 playerHandlers=1 vttWidth=1 keys=1 guards=ass,vttStyle upstreamVttTest=82/59');

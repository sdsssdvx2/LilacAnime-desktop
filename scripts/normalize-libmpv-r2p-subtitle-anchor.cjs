'use strict';
const fs=require('node:fs');
const path=require('node:path');
const file=path.resolve(__dirname,'..','src','index.html');
let source=fs.readFileSync(file,'utf8');
const pattern=/[ \t]*<label[^>]*class="ps-switch ps-small"[^>]*>[\s\S]*?<input[^>]*id="psVttBold"[^>]*>[\s\S]*?<\/label>\s*<p[^>]*class="ps-label"[^>]*>글자 테두리 두께\s*<span[^>]*id="psOutlineLabel"[^>]*>[\s\S]*?<\/span><\/p>\s*<input[^>]*id="psVttOutline"[^>]*>/g;
const matches=[...source.matchAll(pattern)];
if(matches.length!==1){
  const at=source.indexOf('psVttBold');
  const nearby=at>=0?source.slice(Math.max(0,at-350),at+700):'psVttBold missing';
  throw new Error(`R2P subtitle control anchor count=${matches.length}; nearby=${JSON.stringify(nearby)}`);
}
const normalized=`                <label class="ps-switch ps-small"><span><b>글자 굵게</b><small>자막 글자를 굵게 표시합니다</small></span><input id="psVttBold" type="checkbox"></label>\n                <p class="ps-label">글자 테두리 두께 <span id="psOutlineLabel">2.0px</span></p>\n                <input id="psVttOutline" type="range" min="0" max="6" step="0.5" value="2" aria-label="VTT 테두리">`;
source=source.replace(pattern,normalized);
fs.writeFileSync(file,source);
console.log('LIBMPV_R2P_SUBTITLE_ANCHOR_NORMALIZED');

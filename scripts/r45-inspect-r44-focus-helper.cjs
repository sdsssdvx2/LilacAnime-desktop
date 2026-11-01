'use strict';
const fs=require('node:fs');
const path=require('node:path');
const p=path.resolve(__dirname,'..','electron','libmpv-shared-main.cjs');
const s=fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');
const start=s.indexOf('  function r32ApplyNativePresenterFocus(focused) {');
if(start<0) throw new Error('focus helper start missing');
let depth=0,end=-1,seen=false;
for(let i=start;i<s.length;i++){
  const ch=s[i];
  if(ch==='{'){depth++;seen=true;}
  else if(ch==='}'){depth--;if(seen&&depth===0){end=i+1;break;}}
}
if(end<0) throw new Error('focus helper end missing');
console.log('R45_R44_FOCUS_HELPER_BEGIN');
console.log(s.slice(start,end));
console.log('R45_R44_FOCUS_HELPER_END');

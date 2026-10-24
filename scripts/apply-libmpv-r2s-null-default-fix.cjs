'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
function patch(rel,needle,replacement,label){const file=path.join(root,rel);let s=fs.readFileSync(file,'utf8');const n=s.split(needle).length-1;if(n!==1)throw new Error(`${label}: expected 1 anchor, got ${n}`);s=s.replace(needle,replacement);fs.writeFileSync(file,s)}
patch('src/app.js',
"function subtitleStyleNumber(key, fallback, min, max){const value=Number(localStorage.getItem(key));return Math.max(min,Math.min(max,Number.isFinite(value)?value:fallback))}",
"function subtitleStyleNumber(key,fallback,min,max){const raw=localStorage.getItem(key),value=raw===null?NaN:Number(raw);return Math.max(min,Math.min(max,Number.isFinite(value)?value:fallback))}",
'app subtitle numeric default');
patch('src/player.js',
"  const storedWeight = Number(localStorage.getItem('vttWeight'));\n  const weight = storedWeight === 400 || storedWeight === 700 ? storedWeight : (Number.isFinite(storedWeight) ? (storedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700));",
"  const storedWeightRaw = localStorage.getItem('vttWeight'), storedWeight = storedWeightRaw === null ? NaN : Number(storedWeightRaw);\n  const weight = storedWeight === 400 || storedWeight === 700 ? storedWeight : (Number.isFinite(storedWeight) ? (storedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700));",
'player weight default');
patch('src/libmpv-shared-entry.js',
"    const requestedWeight = Number(localStorage.getItem('vttWeight'));\n    const weight = Number.isFinite(requestedWeight) ? (requestedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700);",
"    const requestedWeightRaw = localStorage.getItem('vttWeight');\n    const requestedWeight = requestedWeightRaw === null ? NaN : Number(requestedWeightRaw);\n    const weight = Number.isFinite(requestedWeight) ? (requestedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700);",
'libmpv weight default');
console.log('LIBMPV_R2S_NULL_DEFAULT_FIX_OK freshWeight=700 nullDoesNotBecomeZero=1');

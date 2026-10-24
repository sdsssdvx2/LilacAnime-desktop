'use strict';
const fs=require('node:fs');const path=require('node:path');
const file=path.resolve(__dirname,'..','src','player.js');let source=fs.readFileSync(file,'utf8');
const from="  const storedWeightRaw = localStorage.getItem('vttWeight'), storedWeight = storedWeightRaw === null ? NaN : Number(storedWeightRaw);\n  const weight = storedWeight === 400 || storedWeight === 700 ? storedWeight : (Number.isFinite(storedWeight) ? (storedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700));";
const to="  const storedWeight = Number(localStorage.getItem('vttWeight'));\n  const weight = storedWeight === 400 || storedWeight === 700 ? storedWeight : (Number.isFinite(storedWeight) ? (storedWeight < 550 ? 400 : 700) : (localStorage.getItem('vttBold') === 'false' ? 400 : 700));";
const count=source.split(from).length-1;if(count!==1)throw new Error(`R2U weight anchor expected exactly 1, found ${count}`);source=source.replace(from,to);fs.writeFileSync(file,source);console.log('LIBMPV_R2U_WEIGHT_ANCHOR_NORMALIZED legacyNullGuard=temporary-for-transform');

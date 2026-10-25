'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, 'r32-flix-worker-native-focus-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldExit = "  worker.on('exit',code=>{if(code!==0&&r32Worker===worker)fail(new Error(`Flix worker exited (${code})`));else if(r32Worker===worker)r32Worker=null;});";
const newExit = "  worker.on('exit',code=>{if(code!==0&&r32Worker===worker)fail(new Error('Flix worker exited ('+code+')'));else if(r32Worker===worker)r32Worker=null;});";
const count = source.split(oldExit).length - 1;
if (count !== 1) throw new Error(`R32 nested Flix template anchor expected 1, found ${count}`);
source = source.replace(oldExit, newExit);

fs.writeFileSync(target, source, 'utf8');
console.log('R32_TRANSFORM_SOURCE_SANITIZE_OK nestedFlixTemplate=removed bridgeTemplates=escaped');

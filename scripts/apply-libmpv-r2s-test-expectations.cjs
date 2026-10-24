'use strict';
const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'..','tests','player-interactions.test.cjs');
let s=fs.readFileSync(file,'utf8');
const oldTitle="test('VTT dialogue uses the readable-width centered box and retains sync and top placement', () => {";
const newTitle="test('VTT dialogue uses the upstream full-width centered box by default and retains sync and top placement', () => {";
const oldAssert="  for (const cue of cues) { assert.equal(cue.size, 82); assert.equal(cue.position, 59); assert.equal(cue.positionAlign, 'center'); assert.equal(cue.align, 'center'); }";
const newAssert="  for (const cue of cues) { assert.equal(cue.size, 100); assert.equal(cue.position, 50); assert.equal(cue.positionAlign, 'center'); assert.equal(cue.align, 'center'); }";
for(const [needle,label] of [[oldTitle,'title'],[oldAssert,'assertion']]){const n=s.split(needle).length-1;if(n!==1)throw new Error(`R2S test ${label}: expected 1 anchor, got ${n}`)}
s=s.replace(oldTitle,newTitle).replace(oldAssert,newAssert);
fs.writeFileSync(file,s);
console.log('LIBMPV_R2S_TEST_EXPECTATIONS_OK defaultVttWidth=100 position=50');

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');
const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const lines = source.split('\n');

if (!source.includes('LILAC_R40_FRESH_FRAME_WAKE_GATING')) {
  throw new Error('R40 schedule audit requires transformed pacing bridge');
}
if (!source.includes('LILAC_R40_PRODUCER_CALLBACK_AUTHORITY')) {
  throw new Error('R40 schedule audit requires producer callback-authority correction');
}
if (!source.includes('LILAC_R40_RELEASE_CALLBACK_AUTHORITY')) {
  throw new Error('R40 schedule audit requires release callback-authority correction');
}

const releaseStart = source.indexOf('  function releaseNativeFrame(');
const releaseEnd = source.indexOf('\n\n  function schedulePump(', releaseStart);
if (releaseStart < 0 || releaseEnd <= releaseStart) throw new Error('releaseNativeFrame boundary missing in generated bridge');
const releaseBlock = source.slice(releaseStart, releaseEnd);
if (!releaseBlock.includes('if (!(frameProducerStarted || nativeUpdateCallbackInstalled))')) {
  throw new Error('releaseNativeFrame immediate pump is not callback-authority gated');
}
if ((releaseBlock.split('schedulePump(0);').length - 1) !== 1) {
  throw new Error('releaseNativeFrame must retain exactly one legacy-only immediate pump');
}

const hits = [];
for (let index = 0; index < lines.length; index += 1) {
  if (!lines[index].includes('schedulePump(')) continue;
  let owner = '<top-level>';
  for (let scan = index; scan >= Math.max(0, index - 180); scan -= 1) {
    const match = lines[scan].match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/);
    if (match) {
      owner = match[1];
      break;
    }
  }
  const from = Math.max(0, index - 3);
  const to = Math.min(lines.length - 1, index + 3);
  const context = [];
  for (let lineIndex = from; lineIndex <= to; lineIndex += 1) {
    context.push(`${String(lineIndex + 1).padStart(5, ' ')}${lineIndex === index ? ' > ' : '   '}${lines[lineIndex]}`);
  }
  hits.push({ line: index + 1, owner, text: lines[index].trim(), context });
}

if (hits.length < 2 || hits.length > 16) {
  throw new Error(`unexpected schedulePump occurrence count=${hits.length}`);
}
const definitions = hits.filter(hit => /function\s+schedulePump\s*\(/.test(hit.text));
if (definitions.length !== 1) {
  throw new Error(`expected exactly one schedulePump definition, found ${definitions.length}`);
}
const releaseHits = hits.filter(hit => hit.owner === 'releaseNativeFrame' && hit.text === 'schedulePump(0);');
if (releaseHits.length !== 1) {
  throw new Error(`expected one callback-gated releaseNativeFrame legacy pump, found ${releaseHits.length}`);
}

console.log(`R40_SCHEDULE_CALLSITE_AUDIT_BEGIN count=${hits.length}`);
for (let index = 0; index < hits.length; index += 1) {
  const hit = hits[index];
  console.log(`R40_SCHEDULE_CALLSITE index=${index + 1} line=${hit.line} owner=${hit.owner} text=${JSON.stringify(hit.text)}`);
  for (const line of hit.context) console.log(line);
}
console.log(`R40_SCHEDULE_CALLSITE_AUDIT_OK count=${hits.length} definitionLine=${definitions[0].line} releaseImmediatePump=legacy-only`);

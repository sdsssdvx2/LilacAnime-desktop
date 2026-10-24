'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');
let source = fs.readFileSync(target, 'utf8');
const oldText = 'now - lastPumpStatePollPerfAt < 1000';
const newText = 'now - lastPumpStatePollPerfAt < 250';
const count = source.split(oldText).length - 1;
if (count !== 1) throw new Error(`R3A poll-cadence anchor mismatch: ${count}`);
source = source.replace(oldText, newText);
if (!source.includes('pumpStatePollMaxMs') || !source.includes('async function deliverImportedFrame')) {
  throw new Error('R3A poll-cadence fix requires decoupled delivery diagnostics first');
}
fs.writeFileSync(target, source);
console.log('LIBMPV_R3A_POLL_CADENCE_OK pollMs=250 resumeResponsiveness=retained');

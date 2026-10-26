'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

// The R34 handoff hardening historically wrapped the R33 DWM smoke in a second
// Electron parent. The external Node watchdog now owns timeout/process-tree
// supervision, so that nested Electron parent is both redundant and harmful: it
// keeps the same Electron userData/GPU cache open while the real capture child
// starts, which can perturb the very DWM/GPU behavior being qualified.
const r33Path = file('scripts/r33-owned-popup-visible-focus-smoke.cjs');
let r33 = fs.readFileSync(r33Path, 'utf8').replace(/\r\n/g, '\n');
const childOpen = "if (process.env.LILAC_R34_R33_SMOKE_CHILD === '1') {\n";
const childClose = "\n} else {\n  const { spawn, spawnSync } = require('node:child_process');";
if (r33.includes('LILAC_R34_R33_SMOKE_WATCHDOG')) {
  const start = r33.indexOf(childOpen);
  const end = r33.indexOf(childClose, start + childOpen.length);
  if (start < 0 || end <= start) throw new Error('R34 R33 nested smoke wrapper boundary missing');
  let childBody = r33.slice(start + childOpen.length, end);
  childBody = childBody.replace(
    /process\.exitCode\s*=\s*1;\s*try\s*\{\s*app\.quit\(\);\s*\}\s*catch\s*\{\s*\}/,
    "process.exit(1)"
  );
  if (!childBody.includes('process.exit(1)')) throw new Error('R34 R33 smoke failure exit hardening missing');
  r33 = `'use strict';\n// LILAC_R34_SMOKE_CORRECTNESS_HARDENING\n${childBody.trimStart()}\n`;
} else {
  if (!r33.includes('R33_VISIBLE_FOCUS_SMOKE_OK')) throw new Error('R33 visible smoke baseline missing');
  if (!r33.includes('LILAC_R34_SMOKE_CORRECTNESS_HARDENING')) {
    r33 = r33.replace(/^'use strict';\n/, "'use strict';\n// LILAC_R34_SMOKE_CORRECTNESS_HARDENING\n");
    r33 = r33.replace(
      /process\.exitCode\s*=\s*1;\s*try\s*\{\s*app\.quit\(\);\s*\}\s*catch\s*\{\s*\}/,
      'process.exit(1)'
    );
  }
}
fs.writeFileSync(r33Path, r33, 'utf8');

// The R34 native handoff smoke exercises the same producer API as product code.
// startFrameProducer requires an update callback to be installed first; the first
// version of this smoke omitted that prerequisite and then Electron app.quit()
// converted its failure into an OS exit code 0. Fix both issues explicitly.
const r34Path = file('scripts/r34-focus-handoff-native-smoke.cjs');
let r34 = fs.readFileSync(r34Path, 'utf8').replace(/\r\n/g, '\n');
if (!r34.includes('LILAC_R34_SMOKE_CORRECTNESS_HARDENING')) {
  r34 = replaceOnce(
    r34,
    "'createPlayer','open','pollPlayback','startFrameProducer'",
    "'createPlayer','open','pollPlayback','setUpdateCallback','startFrameProducer'",
    'R34 handoff smoke callback export'
  );
  r34 = replaceOnce(
    r34,
    "const created=addon.createPlayer();id=Number(created.playerId);if(!id)throw new Error('createPlayer failed');\n    addon.configureNativePresenter",
    "const created=addon.createPlayer();id=Number(created.playerId);if(!id)throw new Error('createPlayer failed');\n    if(addon.setUpdateCallback(id,()=>{})!==true)throw new Error('setUpdateCallback failed');\n    addon.configureNativePresenter",
    'R34 handoff smoke callback setup'
  );
  r34 = r34.replace(
    /process\.exitCode\s*=\s*1;\s*try\s*\{\s*app\.quit\(\)\s*\}\s*catch\s*\{\s*\}/,
    'process.exit(1)'
  );
  if (!r34.includes('process.exit(1)')) throw new Error('R34 handoff smoke failure exit hardening missing');
  r34 = r34.replace(/^'use strict';\n/, "'use strict';\n// LILAC_R34_SMOKE_CORRECTNESS_HARDENING\n");
}
fs.writeFileSync(r34Path, r34, 'utf8');

const finalR33 = fs.readFileSync(r33Path, 'utf8');
const finalR34 = fs.readFileSync(r34Path, 'utf8');
if (finalR33.includes('LILAC_R34_R33_SMOKE_WATCHDOG') || finalR33.includes('LILAC_R34_R33_SMOKE_CHILD')) {
  throw new Error('nested Electron R33 smoke wrapper survived correctness hardening');
}
for (const marker of ['LILAC_R34_SMOKE_CORRECTNESS_HARDENING','R33_VISIBLE_FOCUS_SMOKE_OK','process.exit(1)']) {
  if (!finalR33.includes(marker)) throw new Error(`R33 correctness marker missing: ${marker}`);
}
for (const marker of ['LILAC_R34_SMOKE_CORRECTNESS_HARDENING','setUpdateCallback','R34_NATIVE_HANDOFF_SMOKE_OK','process.exit(1)']) {
  if (!finalR34.includes(marker)) throw new Error(`R34 correctness marker missing: ${marker}`);
}
console.log('R34_SMOKE_CORRECTNESS_OK r33NestedElectron=removed r33FailureExit=nonzero r34UpdateCallback=installed r34FailureExit=nonzero');

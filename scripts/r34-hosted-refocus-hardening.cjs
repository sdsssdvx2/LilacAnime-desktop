'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r33-owned-popup-visible-focus-smoke.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('LILAC_R34_HOSTED_VISUAL_PROOF')) {
  throw new Error('R34 hosted visual proof must run before refocus hardening');
}
if (source.includes('LILAC_R34_HOSTED_REFOCUS_HARDENING')) {
  throw new Error('R34 hosted refocus hardening already applied');
}

const oldBlock = `    console.log('R34_R33_SMOKE_STAGE=before-refocus');
    main.focus();
    await waitUntil(() => main.isFocused(), 3000, 'owner refocus');
    console.log('R34_R33_SMOKE_STAGE=refocused');`;

const newBlock = `    console.log('R34_R33_SMOKE_STAGE=before-refocus');
    // LILAC_R34_HOSTED_REFOCUS_HARDENING: Windows hosted runners can refuse
    // focus() while a second visible BrowserWindow still owns foreground focus.
    // Hide only the synthetic rival first, then require the real owner to regain
    // focus. This does not weaken popup/presentation assertions; it makes the
    // artificial focus transition deterministic instead of testing OS focus-steal
    // policy. Product code is unchanged.
    if (rival && !rival.isDestroyed()) {
      rival.hide();
      await waitUntil(() => !rival.isVisible(), 2000, 'rival hide before owner refocus');
    }
    if (!main.isVisible()) main.show();
    try { main.moveTop(); } catch {}
    main.focus();
    await waitUntil(() => main.isFocused(), 5000, 'owner deterministic refocus');
    console.log('R34_R33_SMOKE_STAGE=refocused');`;

const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error(`R34 hosted refocus anchor expected once, found ${count}`);
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(target, source, 'utf8');

const final = fs.readFileSync(target, 'utf8');
for (const marker of [
  'LILAC_R34_HOSTED_REFOCUS_HARDENING',
  "rival.hide()",
  "!rival.isVisible()",
  "main.moveTop()",
  "owner deterministic refocus",
  'R33_VISIBLE_FOCUS_SMOKE_OK'
]) {
  if (!final.includes(marker)) throw new Error(`R34 hosted refocus marker missing: ${marker}`);
}
console.log('R34_HOSTED_REFOCUS_HARDENING_OK rival=hidden-before-focus ownerFocusTimeoutMs=5000 productCode=unchanged visualAndPresentGates=preserved');

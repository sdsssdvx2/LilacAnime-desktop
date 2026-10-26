'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const smokePath = path.join(root, 'scripts', 'r33-owned-popup-visible-focus-smoke.cjs');
let source = fs.readFileSync(smokePath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('LILAC_R34_HOSTED_VISUAL_PROOF')) throw new Error('R35 hosted startup hardening requires final R34 hosted visual proof');
if (!source.includes('LILAC_R34_HOSTED_REFOCUS_HARDENING')) throw new Error('R35 hosted startup hardening requires final R34 refocus hardening');
if (source.includes('LILAC_R35_HOSTED_NATIVE_STARTUP_HARDENING')) throw new Error('R35 hosted startup hardening already applied');

const oldBlock = `    await waitUntil(() => {
      const s = addon.nativePresenterStats(id);
      return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;
    }, 6000, 'owned popup visible/presenting');`;

const newBlock = `    // LILAC_R35_HOSTED_NATIVE_STARTUP_HARDENING
    // A GitHub hosted GPU occasionally needs several seconds to create the first
    // swapchain/present after the VM has just rebuilt the native addon. Preserve
    // the exact same proof (visible HWND + >=4 native presents); only widen the
    // startup observation window. On failure, print enough native/player state to
    // distinguish a renderer/fixture problem from presenter startup latency.
    try {
      await waitUntil(() => {
        const s = addon.nativePresenterStats(id);
        return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;
      }, 15000, 'owned popup visible/presenting');
    } catch (error) {
      let presenter = null, playback = null;
      try { presenter = addon.nativePresenterStats(id); } catch {}
      try { playback = addon.pollPlayback(id); } catch {}
      throw new Error('owned popup visible/presenting hosted startup timeout presenter=' + JSON.stringify(presenter) + ' playback=' + JSON.stringify(playback) + ' cause=' + String(error?.message || error));
    }`;

const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error('R35 hosted startup wait anchor expected once, found ' + count);
source = source.replace(oldBlock, newBlock);

// Do not weaken any of the downstream qualification gates.
for (const required of [
  'presentSOkFrames',
  'presentOccludedFrames',
  'presentOtherStatusFrames',
  'blockMain(900)',
  'autonomousPresented=',
  'focusRecovery=hidden',
  'R33_VISIBLE_FOCUS_SMOKE_OK'
]) {
  if (!source.includes(required)) throw new Error('R35 hosted startup hardening lost proof gate: ' + required);
}
if (!source.includes("15000, 'owned popup visible/presenting'")) throw new Error('R35 hosted startup timeout was not widened');
if (source.includes("6000, 'owned popup visible/presenting'")) throw new Error('R35 old hosted startup timeout survived');

fs.writeFileSync(smokePath, source, 'utf8');
console.log('R35_HOSTED_NATIVE_STARTUP_HARDENING_OK timeoutMs=15000 proof=unchanged exactSOk=required nonSOk=zero mainStallMs=900 timeoutTelemetry=presenter+playback');

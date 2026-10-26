'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const bridge = read('electron/libmpv-shared-main.cjs');
const app = read('src/app.js');

assert(bridge.includes('LILAC_R36_UI_HOLES_ONLY_FASTPATH'), 'R36 UI-hole-only fast path marker missing');
const resizeStart = bridge.indexOf('  function resize(value = {}) {');
const resizeEnd = bridge.indexOf('\n  }', resizeStart);
assert(resizeStart >= 0 && resizeEnd > resizeStart, 'resize function boundary missing');
const resize = bridge.slice(resizeStart, resizeEnd + 4);
const fast = resize.indexOf('if (value?.r36UiHolesOnly === true)');
const sync = resize.indexOf('r36SyncNativePresenterUiHoles();', fast);
const earlyReturn = resize.indexOf('return { width: targetWidth, height: targetHeight, r36UiHolesOnly: true };', sync);
const normalSize = resize.indexOf('const size = setTargetSize(value);');
assert(fast >= 0 && sync > fast && earlyReturn > sync && normalSize > earlyReturn, 'UI-hole fast path must return before normal resize path');
const fastBlock = resize.slice(fast, normalSize);
for (const forbidden of ['addon.resize(', 'startFrameProducer(', 'stopFrameProducer(', 'targetWidth = clampSize(value.width']) {
  assert(!fastBlock.includes(forbidden), 'UI-hole fast path contains video resize/producer work: ' + forbidden);
}

assert(app.includes('R36_NATIVE_UI_HOLE_SELECTORS'), 'renderer UI-hole selector marker missing');
assert(app.includes("'#immersivePlayer.controls-visible #playerSeek'"), 'seek bar precise hole missing');
assert(app.includes("'#immersivePlayer.controls-visible #playerTime'"), 'time precise hole missing');
assert(app.includes("'#immersivePlayer.controls-visible .player-actions'"), 'actions precise hole missing');
assert(!app.includes("'#immersivePlayer.controls-visible .player-bottom'"), 'broad bottom hole survived and may clip native subtitles');
assert(app.includes('libmpvSharedResize({r36UiHolesOnly:true,uiHoles})'), 'renderer does not use UI-hole-only resize IPC payload');
assert(!app.includes('libmpvSharedResize({r36UiHolesOnly:true,uiHoles,width'), 'UI-hole-only payload unexpectedly carries resize dimensions');

console.log('R36_UI_HOLE_FASTPATH_SMOKE_OK ipc=reused-but-resize-bypassed nativeRegionOnly=1 producerResize=0 preciseBottom=seek+time+actions broadBottom=0 subtitleCenterPreserved=1');

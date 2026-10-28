'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', 'native/libmpv-d3d11-bridge/player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldBlock = `      const HWND r39InsertAfter = r39OwnerTopmost ? HWND_TOPMOST : nullptr;
      const UINT r39Flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER |
        (r39OwnerTopmost ? 0 : SWP_NOZORDER) |
        (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);`;
const newBlock = `      // LILAC_R39_TOPMOST_BIDIRECTIONAL: do not merely promote for PiP. If the
      // owner later leaves mini-player mode, explicitly demote the hidden/native
      // popup too so a future ordinary blur cannot inherit stale WS_EX_TOPMOST.
      const HWND r39InsertAfter = r39OwnerTopmost ? HWND_TOPMOST : HWND_NOTOPMOST;
      const UINT r39Flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER |
        (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);`;
const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error(`R39 bidirectional topmost anchor expected once, found ${count}`);
source = source.replace(oldBlock, newBlock);
if (!source.includes('HWND_NOTOPMOST') || !source.includes('LILAC_R39_TOPMOST_BIDIRECTIONAL')) {
  throw new Error('R39 bidirectional topmost repair missing');
}
fs.writeFileSync(target, source, 'utf8');
console.log('R39_TOPMOST_BIDIRECTIONAL_OK ownerTopmost=HWND_TOPMOST ownerNormal=HWND_NOTOPMOST staleTopmost=prevented');

'use strict';

const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { MiniPlayerWindowController } = require('../electron/miniplayer-window.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, timeout = 3000, step = 40) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await wait(step);
  }
  return false;
};
function fail(error) {
  console.error(error?.stack || error);
  try { app.exit(1); } catch { process.exit(1); }
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

function hwndNumber(win) {
  const raw = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(raw) || raw.length < 4) throw new Error('native HWND unavailable');
  return raw.length >= 8 ? raw.readBigUInt64LE(0).toString(10) : String(raw.readUInt32LE(0));
}
function win32Topmost(win) {
  if (process.platform !== 'win32') return null;
  const hwnd = hwndNumber(win);
  const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LilacR39Win32 {
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)]
  public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
}
'@
$h=[IntPtr]::new([Int64]${hwnd})
$ex=[LilacR39Win32]::GetWindowLongPtr($h,-20).ToInt64()
if (($ex -band 0x8) -ne 0) { Write-Output 'TOPMOST=1' } else { Write-Output ('TOPMOST=0 EXSTYLE=0x{0:X}' -f $ex); exit 3 }
`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    return /TOPMOST=1/.test(out);
  } catch (error) {
    console.error(String(error?.stdout || error?.message || error));
    return false;
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const primary = screen.getPrimaryDisplay().workArea;
  const main = new BrowserWindow({ show: true, width: Math.min(1000, primary.width - 80), height: Math.min(700, primary.height - 80), x: primary.x + 20, y: primary.y + 20 });
  const rival = new BrowserWindow({ show: true, width: Math.min(900, primary.width - 100), height: Math.min(650, primary.height - 100), x: primary.x + 60, y: primary.y + 60 });
  await Promise.all([
    main.loadURL('data:text/html,<body style="background:%23111;color:white">R39 main</body>'),
    rival.loadURL('data:text/html,<body style="background:%23333;color:white">R39 rival</body>')
  ]);
  const controller = new MiniPlayerWindowController({ screen });

  // Exercise the hardest normal transition: fullscreen -> mini-player.
  main.setFullScreen(true);
  await waitFor(() => main.isFullScreen(), 2500);
  const entered = await controller.set(main, true);
  assert.equal(entered.active, true, JSON.stringify(entered));
  assert.equal(entered.alwaysOnTop, true, JSON.stringify(entered));
  assert.equal(main.isFullScreen(), false, 'mini-player must leave fullscreen');
  assert.equal(main.isAlwaysOnTop(), true, 'Electron must report topmost after enter');
  assert.equal(win32Topmost(main), true, 'Win32 WS_EX_TOPMOST must be set');
  const bounds = main.getBounds();
  assert.ok(bounds.width >= 320 && bounds.height >= 180, JSON.stringify(bounds));
  assert.ok(Math.abs(bounds.width / bounds.height - 16 / 9) < 0.03, `mini-player aspect drift: ${bounds.width}x${bounds.height}`);

  // Put a real competing BrowserWindow in front and steal focus. The mini-player
  // must remain topmost and the controller's blur repin must not clear the flag.
  rival.show(); rival.focus(); rival.moveTop();
  await wait(250);
  assert.equal(main.isAlwaysOnTop(), true, 'topmost lost after rival focus');
  assert.equal(win32Topmost(main), true, 'Win32 topmost lost after rival focus');
  const afterRival = controller.snapshot(main);
  assert.equal(afterRival.active, true, JSON.stringify(afterRival));
  assert.equal(afterRival.alwaysOnTop, true, JSON.stringify(afterRival));
  assert.ok(afterRival.pinAttempts >= 3, `expected repin attempts, got ${afterRival.pinAttempts}`);
  assert.equal(afterRival.pinFailures, 0, JSON.stringify(afterRival));

  // Hide/show can reset z-order on Windows; R39 re-pins here too.
  main.hide(); await wait(100); main.show(); await wait(150);
  assert.equal(main.isAlwaysOnTop(), true, 'topmost lost after hide/show');
  assert.equal(win32Topmost(main), true, 'Win32 topmost lost after hide/show');

  const left = await controller.set(main, false);
  assert.equal(left.active, false, JSON.stringify(left));
  assert.equal(main.isAlwaysOnTop(), false, 'topmost should restore to original false state');
  if (process.platform === 'win32') assert.equal(win32Topmost(main), false, 'Win32 topmost bit should clear on leave');

  console.log(`R39_MINIPLAYER_ELECTRON_OK platform=${process.platform} realBrowserWindows=2 fullscreenTransition=1 rivalFocus=1 hideShow=1 win32Topmost=1 pinAttempts=${afterRival.pinAttempts} pinFailures=${afterRival.pinFailures}`);
  rival.destroy(); main.destroy(); app.quit();
}).catch(fail);

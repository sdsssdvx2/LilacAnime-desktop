'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { R40SubtitleOverlayWindowController } = require('../electron/r40-subtitle-overlay-window.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R40 fontface overlay diagnostic exceeded 25s hard deadline');
  process.exit(124);
}, 25000);

async function readFontState(win) {
  return win.webContents.executeJavaScript(`(()=>({active:document.body.dataset.active||'',fontReady:document.body.dataset.fontReady||'',fontCustom:document.body.dataset.fontCustom||'',fontStage:document.body.dataset.fontStage||'',fontError:document.body.dataset.fontError||'',fontBytes:document.body.dataset.fontBytes||'',fontDataKind:document.body.dataset.fontDataKind||'',revision:document.body.dataset.revision||''}))()`)
    .catch(error => ({ executeError:String(error?.message || error) }));
}

async function waitFontReady(win, timeoutMs = 7000) {
  let state = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    state = await readFontState(win);
    if (state?.active === '1' && state?.fontReady === '1' && state?.fontCustom === '1') return state;
    await sleep(25);
  }
  return state;
}

async function waitFocus(owner, rival, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!owner.isFocused() && rival.isFocused()) return true;
    await sleep(20);
  }
  return false;
}

(async () => {
  let owner = null;
  let rival = null;
  let controller = null;
  let ipcCalls = 0;
  let handlerBytes = 0;
  let handlerPath = '';
  let handlerError = '';
  try {
    await app.whenReady();
    ipcMain.handle('font:default', (_event, _choice = '기본체', customPath = '') => {
      ipcCalls += 1;
      handlerPath = String(customPath || '');
      try {
        if (!/\.(ttf|otf|ttc)$/i.test(handlerPath) || !fs.existsSync(handlerPath)) {
          handlerError = `invalid-or-missing:${handlerPath}`;
          return null;
        }
        const data = fs.readFileSync(handlerPath);
        handlerBytes = data.length;
        handlerError = '';
        return { name:path.basename(handlerPath), family:'R40DiagnosticFont', data };
      } catch (error) {
        handlerError = String(error?.message || error);
        return null;
      }
    });

    owner = new BrowserWindow({
      show: false,
      width: 900,
      height: 560,
      webPreferences: { contextIsolation:true, nodeIntegration:false, sandbox:true }
    });
    await owner.loadURL('data:text/html,<html><body style="margin:0;background:#1428b4"></body></html>');

    const fontPath = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf');
    if (!fs.existsSync(fontPath)) throw new Error(`diagnostic fixture font missing ${fontPath}`);
    const payload = revision => ({
      revision,
      active: true,
      stackRect: { x:100, y:100, width:600, height:100 },
      stackStyle: {},
      stackGap: '0px',
      stackAlignItems: 'center',
      stackJustifyContent: 'normal',
      fontPath,
      cues: [{
        html: '<b>R40 FONT BYTE DIAGNOSTIC</b>',
        style: {
          fontFamily: 'LilacSubtitle, Arial, sans-serif',
          fontSize: '40px',
          fontWeight: '700',
          lineHeight: '48px',
          color: 'rgb(255,0,255)',
          whiteSpace: 'normal',
          textAlign: 'center',
          maxWidth: '600px'
        }
      }]
    });

    // Baseline: unfocused owner activates directly. This proves IPC/bytes/FontFace.
    controller = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir:path.join(__dirname, '..', 'electron') });
    const direct = await controller.update(owner, payload(1));
    if (!direct?.visible) throw new Error(`diagnostic direct overlay did not activate ${JSON.stringify(direct)}`);
    const directOverlay = controller.window;
    if (!directOverlay || directOverlay.isDestroyed()) throw new Error('diagnostic direct overlay window missing');
    const directState = await waitFontReady(directOverlay);
    const directReport = { state:directState, ipcCalls, handlerPath, handlerBytes, handlerError };
    console.log(`R40_FONTFACE_DIRECT_DIAGNOSTIC_REPORT=${JSON.stringify(directReport)}`);
    if (!(directState?.active === '1' && directState?.fontReady === '1' && directState?.fontCustom === '1')) {
      throw new Error(`R40 direct sandbox custom font did not become ready ${JSON.stringify(directReport)}`);
    }
    controller.destroy('direct-diagnostic-complete');
    controller = null;

    // Exact failing shape from the full smoke: payload arrives while the owner still
    // owns focus, is deferred, then a real rival acquires focus and reconcileDeferred
    // replays the payload exactly once into a newly-created overlay renderer.
    owner.show();
    owner.focus();
    const ownerFocusDeadline = Date.now() + 3000;
    while (!owner.isFocused() && Date.now() < ownerFocusDeadline) await sleep(20);
    if (!owner.isFocused()) throw new Error('diagnostic owner could not acquire focus');

    rival = new BrowserWindow({ show:false, frame:false, width:260, height:180, backgroundColor:'#20b440' });
    await rival.loadURL('data:text/html,<html><body style="margin:0;background:#20b440"></body></html>');
    controller = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir:path.join(__dirname, '..', 'electron') });
    const deferred = await controller.update(owner, payload(2));
    if (deferred?.visible !== false || deferred?.deferredActive !== true) {
      throw new Error(`diagnostic focused payload was not deferred ${JSON.stringify(deferred)}`);
    }

    rival.show();
    rival.moveTop?.();
    rival.focus();
    if (!(await waitFocus(owner, rival))) {
      throw new Error(`diagnostic rival focus failed ownerFocused=${owner.isFocused()} rivalFocused=${rival.isFocused()}`);
    }
    const replay = await controller.reconcileDeferred(owner, 'diagnostic-owner-blur');
    if (replay?.visible !== true || replay?.replayed !== true) {
      throw new Error(`diagnostic deferred payload did not replay ${JSON.stringify(replay)}`);
    }
    const replayOverlay = controller.window;
    if (!replayOverlay || replayOverlay.isDestroyed()) throw new Error('diagnostic replay overlay window missing');
    const replayState = await waitFontReady(replayOverlay);
    const replayReport = {
      state:replayState,
      ipcCalls,
      handlerPath,
      handlerBytes,
      handlerError,
      deferredCount:replay?.deferredCount,
      deferredReplayCount:replay?.deferredReplayCount,
      ownerFocused:owner.isFocused(),
      rivalFocused:rival.isFocused()
    };
    console.log(`R40_FONTFACE_DEFERRED_DIAGNOSTIC_REPORT=${JSON.stringify(replayReport)}`);
    if (!(replayState?.active === '1' && replayState?.fontReady === '1' && replayState?.fontCustom === '1')) {
      throw new Error(`R40 deferred sandbox custom font did not become ready ${JSON.stringify(replayReport)}`);
    }
    if (ipcCalls < 2 || handlerBytes < 1024) throw new Error(`R40 font byte IPC was not exercised in both paths ${JSON.stringify(replayReport)}`);
    if (owner.isFocused() || !rival.isFocused()) throw new Error(`R40 deferred replay stole focus ${JSON.stringify(replayReport)}`);

    console.log(`R40_FONTFACE_OVERLAY_DIAGNOSTIC_OK direct=1 deferredReplay=1 ipcCalls=${ipcCalls} bytes=${handlerBytes} stage=${replayState.fontStage}`);
  } finally {
    clearTimeout(hardDeadline);
    try { ipcMain.removeHandler('font:default'); } catch {}
    try { controller?.destroy('diagnostic-cleanup'); } catch {}
    try { if (rival && !rival.isDestroyed()) rival.destroy(); } catch {}
    try { if (owner && !owner.isDestroyed()) owner.destroy(); } catch {}
    setTimeout(() => app.quit(), 20);
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
  setTimeout(() => app.quit(), 20);
});

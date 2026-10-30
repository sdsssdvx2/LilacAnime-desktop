'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { R40SubtitleOverlayWindowController } = require('../electron/r40-subtitle-overlay-window.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardDeadline = setTimeout(() => {
  console.error('R40 fontface overlay diagnostic exceeded 20s hard deadline');
  process.exit(124);
}, 20000);

(async () => {
  let owner = null;
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
    await owner.loadURL('data:text/html,<html><body></body></html>');
    controller = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir:path.join(__dirname, '..', 'electron') });

    const fontPath = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf');
    if (!fs.existsSync(fontPath)) throw new Error(`diagnostic fixture font missing ${fontPath}`);
    const result = await controller.update(owner, {
      revision: 1,
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
    if (!result?.visible) throw new Error(`diagnostic overlay controller did not activate ${JSON.stringify(result)}`);
    const overlay = controller.window;
    if (!overlay || overlay.isDestroyed()) throw new Error('diagnostic overlay window missing');

    let state = null;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      state = await overlay.webContents.executeJavaScript(`(()=>({active:document.body.dataset.active||'',fontReady:document.body.dataset.fontReady||'',fontCustom:document.body.dataset.fontCustom||'',fontStage:document.body.dataset.fontStage||'',fontError:document.body.dataset.fontError||'',fontBytes:document.body.dataset.fontBytes||'',fontDataKind:document.body.dataset.fontDataKind||'',revision:document.body.dataset.revision||''}))()`).catch(error => ({ executeError:String(error?.message || error) }));
      if (state?.active === '1' && state?.fontReady === '1' && state?.fontCustom === '1') break;
      await sleep(25);
    }

    const report = { state, ipcCalls, handlerPath, handlerBytes, handlerError };
    console.log(`R40_FONTFACE_OVERLAY_DIAGNOSTIC_REPORT=${JSON.stringify(report)}`);
    if (!(state?.active === '1' && state?.fontReady === '1' && state?.fontCustom === '1')) {
      throw new Error(`R40 sandbox custom font did not become ready ${JSON.stringify(report)}`);
    }
    if (ipcCalls < 1 || handlerBytes < 1024) throw new Error(`R40 font byte IPC was not exercised ${JSON.stringify(report)}`);
    console.log(`R40_FONTFACE_OVERLAY_DIAGNOSTIC_OK ipcCalls=${ipcCalls} bytes=${handlerBytes} stage=${state.fontStage}`);
  } finally {
    clearTimeout(hardDeadline);
    try { ipcMain.removeHandler('font:default'); } catch {}
    try { controller?.destroy('diagnostic-cleanup'); } catch {}
    try { if (owner && !owner.isDestroyed()) owner.destroy(); } catch {}
    setTimeout(() => app.quit(), 20);
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
  setTimeout(() => app.quit(), 20);
});

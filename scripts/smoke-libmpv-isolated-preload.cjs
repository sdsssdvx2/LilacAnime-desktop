'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

function waitFor(channel, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, handler);
      reject(new Error(`${channel} timed out`));
    }, timeoutMs);
    const handler = (event, payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      ipcMain.removeListener(channel, handler);
      resolve(payload);
    };
    ipcMain.on(channel, handler);
  });
}

async function main() {
  const preload = path.resolve(__dirname, '..', 'electron', 'preload-libmpv-shared.generated.cjs');
  const ready = waitFor('libmpv-shared:receiver-ready', payload => payload?.ok === true, 8000);
  const resultPromise = waitFor('libmpv-shared:probe-surface-result', () => true, 8000);

  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  try {
    await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
    await ready;
    const created = await win.webContents.executeJavaScript(`(() => {
      const host = document.createElement('lilac-mpv-video');
      host.id = 'video';
      const root = host.attachShadow({mode:'open'});
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      canvas.setAttribute('data-lilac-libmpv-surface','');
      root.append(canvas);
      document.body.append(host);
      return {host:Boolean(document.querySelector('lilac-mpv-video')),canvas:Boolean(host.shadowRoot.querySelector('canvas[data-lilac-libmpv-surface]'))};
    })()`);
    if (!created?.host || !created?.canvas) throw new Error('main-world surface fixture was not created');
    win.webContents.send('libmpv-shared:probe-surface');
    const result = await resultPromise;
    console.log(`ISOLATED_PRELOAD_SURFACE=${JSON.stringify(result)}`);
    if (!result?.host || !result?.shadowRoot || !result?.canvas || !result?.context2d) {
      throw new Error(`isolated preload could not reach shared canvas: ${JSON.stringify(result)}`);
    }
    console.log('LIBMPV_ISOLATED_PRELOAD_SURFACE_OK');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

app.whenReady().then(main).then(() => app.exit(0)).catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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
  const root = path.resolve(__dirname, '..');
  const preload = path.join(root, 'electron', 'preload-libmpv-shared.generated.cjs');
  const bundle = path.join(root, 'src', 'libmpv-shared.generated.js');
  const css = [
    fs.readFileSync(path.join(root, 'src', 'player-port.css'), 'utf8'),
    fs.readFileSync(path.join(root, 'src', 'player-android.css'), 'utf8')
  ].join('\n');
  const fixture = path.join(os.tmpdir(), `lilac-libmpv-surface-${process.pid}.html`);
  fs.writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}${css}</style></head><body class="player-mode"><section id="playerView" class="active"><div id="immersivePlayer" class="immersive-player controls-visible"><div id="videoStage" class="video-stage"><lilac-mpv-video id="video"></lilac-mpv-video></div></div></section><script src="${pathToFileURL(bundle).href}"></script></body></html>`);

  const ready = waitFor('libmpv-shared:receiver-ready', payload => payload?.ok === true, 8000);
  const resultPromise = waitFor('libmpv-shared:probe-surface-result', () => true, 8000);

  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
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
    await win.loadFile(fixture);
    await ready;
    const geometry = await win.webContents.executeJavaScript(`(async () => {
      await customElements.whenDefined('lilac-mpv-video');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const host = document.querySelector('lilac-mpv-video');
      const stage = document.querySelector('#videoStage');
      const canvas = host?.shadowRoot?.querySelector('canvas[data-lilac-libmpv-surface]');
      const hr = host?.getBoundingClientRect?.();
      const sr = stage?.getBoundingClientRect?.();
      const target = typeof host?._surfaceSize === 'function' ? host._surfaceSize() : null;
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
        host: hr ? { width: hr.width, height: hr.height } : null,
        stage: sr ? { width: sr.width, height: sr.height } : null,
        target,
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null
      };
    })()`);
    console.log(`APP_SURFACE_GEOMETRY=${JSON.stringify(geometry)}`);
    if (!geometry?.host || geometry.host.width < 630 || geometry.host.height < 350) {
      throw new Error(`shared host collapsed instead of filling player stage: ${JSON.stringify(geometry)}`);
    }
    if (!geometry?.stage || geometry.stage.width < 630 || geometry.stage.height < 350) {
      throw new Error(`video stage geometry is invalid: ${JSON.stringify(geometry)}`);
    }
    if (!geometry?.target || geometry.target.width < 630 || geometry.target.height < 350) {
      throw new Error(`requested libmpv surface is invalid: ${JSON.stringify(geometry)}`);
    }

    win.webContents.send('libmpv-shared:probe-surface');
    const result = await resultPromise;
    console.log(`ISOLATED_PRELOAD_SURFACE=${JSON.stringify(result)}`);
    if (!result?.host || !result?.shadowRoot || !result?.canvas || !result?.context2d) {
      throw new Error(`isolated preload could not reach shared canvas: ${JSON.stringify(result)}`);
    }
    console.log('LIBMPV_ISOLATED_PRELOAD_SURFACE_AND_GEOMETRY_OK');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try { fs.unlinkSync(fixture); } catch {}
  }
}

app.whenReady().then(main).then(() => app.exit(0)).catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});

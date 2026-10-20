'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  sharedTexture
} = require('electron');

const smokeMode = process.env.LILAC_SHARED_TEXTURE_PROBE_SMOKE === '1' || process.argv.includes('--smoke');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function addonPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'lilac-shared-texture-probe.node');
  }
  return path.join(__dirname, 'lilac-shared-texture-probe.node');
}

function safeError(error) {
  return String(error?.message || error || 'unknown').replace(/[A-Za-z]:\\[^\s"']+/g, '[path]').slice(0, 240);
}

function colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function decodePixel(raw, expected) {
  const bgra = { r: raw[2], g: raw[1], b: raw[0], a: raw[3] };
  const rgba = { r: raw[0], g: raw[1], b: raw[2], a: raw[3] };
  return colorDistance(bgra, expected) <= colorDistance(rgba, expected) ? bgra : rgba;
}

function waitForIpc(channel, predicate = () => true, timeoutMs = 2500) {
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

async function run() {
  const result = {
    schema: 1,
    probe: 'Lilac D3D11 shared texture -> Electron VideoFrame -> DOM',
    smokeMode,
    status: 'fail',
    verdict: 'UNSET',
    electronVersion: process.versions.electron,
    sharedTextureApi: Boolean(sharedTexture),
    phaseA: null,
    phaseB: null,
    phaseC: null,
    phaseD: null,
    error: null
  };

  let addon;
  try {
    addon = require(addonPath());
    result.phaseA = {
      addonLoaded: true,
      importApi: typeof sharedTexture?.importSharedTexture === 'function',
      sendApi: typeof sharedTexture?.sendSharedTexture === 'function'
    };
    if (!result.phaseA.importApi || !result.phaseA.sendApi) {
      result.verdict = 'FAIL-API-MISSING';
      throw new Error('Electron sharedTexture managed API is unavailable.');
    }
    const smokeTexture = addon.createSolidTexture(64, 64, 6, 64, 230, 255);
    result.phaseA.nativeTextureCreated = Boolean(smokeTexture?.id && Buffer.isBuffer(smokeTexture?.ntHandle));
    result.phaseA.ntHandleBytes = smokeTexture?.ntHandle?.length || 0;
    if (!result.phaseA.nativeTextureCreated) {
      result.verdict = 'FAIL-NATIVE-TEXTURE';
      throw new Error('D3D11 shared NT-handle texture creation failed.');
    }
    addon.releaseTexture(smokeTexture.id);
  } catch (error) {
    result.error = safeError(error);
    if (result.verdict === 'UNSET') result.verdict = 'FAIL-NATIVE-ADDON';
    const text = JSON.stringify(result, null, 2);
    console.log(text);
    try { clipboard.writeText(text); } catch {}
    if (smokeMode) return app.exit(1);
  }

  if (smokeMode) {
    result.status = 'pass';
    result.verdict = 'SMOKE-PASS';
    result.error = null;
    const text = JSON.stringify(result, null, 2);
    console.log(text);
    clipboard.writeText(text);
    return app.exit(0);
  }

  const win = new BrowserWindow({
    width: 720,
    height: 480,
    show: true,
    resizable: false,
    backgroundColor: '#b00020',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  const htmlPath = path.join(__dirname, '..', 'src', 'shared-texture-probe.html');
  await win.loadFile(htmlPath);
  await waitForIpc('probe-ready', () => true, 4000).catch(() => null);

  async function sendTexture(label, color) {
    const resource = addon.createSolidTexture(640, 360, color.r, color.g, color.b, 255);
    let released = false;
    const releaseSource = () => {
      if (released) return;
      released = true;
      try { addon.releaseTexture(resource.id); } catch {}
    };
    let imported;
    try {
      imported = sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: 'bgra',
          codedSize: { width: resource.width, height: resource.height },
          visibleRect: { x: 0, y: 0, width: resource.width, height: resource.height },
          timestamp: Date.now() * 1000,
          handle: { ntHandle: resource.ntHandle }
        },
        allReferencesReleased: releaseSource
      });
      const drawn = waitForIpc('probe-frame-drawn', payload => payload?.label === label, 5000);
      await sharedTexture.sendSharedTexture({
        frame: win.webContents.mainFrame,
        importedSharedTexture: imported
      }, { label });
      imported.release();
      imported = null;
      await drawn;
      await sleep(220);
      return true;
    } catch (error) {
      try { imported?.release(); } catch {}
      releaseSource();
      throw error;
    }
  }

  async function capture(expectedCenter) {
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const cssWidth = win.getContentBounds().width;
    const cssHeight = win.getContentBounds().height;
    const scaleX = size.width / cssWidth;
    const scaleY = size.height / cssHeight;
    const sampleRaw = (cssX, cssY) => {
      const x = Math.max(0, Math.min(size.width - 1, Math.round(cssX * scaleX)));
      const y = Math.max(0, Math.min(size.height - 1, Math.round(cssY * scaleY)));
      const i = (y * size.width + x) * 4;
      return [bitmap[i], bitmap[i + 1], bitmap[i + 2], bitmap[i + 3]];
    };
    const green = { r: 32, g: 208, b: 112 };
    const centerRaw = sampleRaw(360, 220);
    const topRaw = sampleRaw(140, 85);
    const bottomRaw = sampleRaw(575, 355);
    const center = decodePixel(centerRaw, expectedCenter);
    const top = decodePixel(topRaw, green);
    const bottom = decodePixel(bottomRaw, green);
    return {
      capturedSize: size,
      center,
      top,
      bottom,
      centerMatches: colorDistance(center, expectedCenter) < 55,
      topControlGreen: colorDistance(top, green) < 65,
      bottomControlGreen: colorDistance(bottom, green) < 65
    };
  }

  try {
    const blue = { r: 6, g: 64, b: 230 };
    const purple = { r: 154, g: 38, b: 220 };

    await sendTexture('blue', blue);
    result.phaseB = await capture(blue);
    if (!result.phaseB.centerMatches) {
      result.verdict = 'FAIL-TEXTURE-IMPORT';
      throw new Error('Imported D3D11 texture was not visible in Chromium.');
    }
    if (!result.phaseB.topControlGreen || !result.phaseB.bottomControlGreen) {
      result.verdict = 'FAIL-DOM-COMPOSITION';
      throw new Error('DOM controls did not composite above the imported GPU frame.');
    }

    await sendTexture('purple', purple);
    result.phaseC = await capture(purple);
    if (!result.phaseC.centerMatches) {
      result.verdict = 'FAIL-SECOND-FRAME';
      throw new Error('A second external D3D11 frame did not replace the first frame.');
    }

    win.focus();
    await sleep(180);
    const content = win.getContentBounds();
    const clickPromise = waitForIpc('probe-os-click', payload => payload?.clicked === true, 2500);
    const sent = Boolean(addon.osClick(content.x + 140, content.y + 85));
    let clicked = false;
    try {
      await clickPromise;
      clicked = true;
    } catch {}
    result.phaseD = { sendInputCalled: sent, domClickObserved: clicked };
    if (!sent || !clicked) {
      result.verdict = 'FAIL-OS-CLICK';
      throw new Error('Real Windows mouse input did not reach the DOM control.');
    }

    result.status = 'pass';
    result.verdict = 'PASS-ZERO-COPY-BRIDGE';
    result.error = null;
  } catch (error) {
    if (result.verdict === 'UNSET') result.verdict = 'FAIL-RUNTIME';
    result.error = safeError(error);
  }

  const text = JSON.stringify(result, null, 2);
  console.log(text);
  clipboard.writeText(text);
  win.webContents.send('probe-result', result);
}

app.whenReady().then(run).catch(error => {
  const result = {
    schema: 1,
    probe: 'Lilac D3D11 shared texture -> Electron VideoFrame -> DOM',
    smokeMode,
    status: 'fail',
    verdict: 'FAIL-BOOT',
    error: safeError(error)
  };
  const text = JSON.stringify(result, null, 2);
  console.error(text);
  try { clipboard.writeText(text); } catch {}
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());

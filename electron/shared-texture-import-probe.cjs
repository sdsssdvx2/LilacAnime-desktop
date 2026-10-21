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
  return String(error?.message || error || 'unknown').replace(/[A-Za-z]:\\[^\s"']+/g, '[path]').slice(0, 320);
}

function colorDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function colorMatches(a, b, tolerance = 55) {
  return colorDistance(a, b) < tolerance;
}

function decodePixel(raw, expected) {
  const bgra = { r: raw[2], g: raw[1], b: raw[0], a: raw[3] };
  const rgba = { r: raw[0], g: raw[1], b: raw[2], a: raw[3] };
  return colorDistance(bgra, expected) <= colorDistance(rgba, expected) ? bgra : rgba;
}

function waitForIpc(channel, predicate = () => true, timeoutMs = 3000) {
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

function textureInfo(resource) {
  return {
    pixelFormat: 'bgra',
    codedSize: { width: resource.width, height: resource.height },
    visibleRect: { x: 0, y: 0, width: resource.width, height: resource.height },
    timestamp: Date.now() * 1000,
    handle: { ntHandle: resource.ntHandle }
  };
}

async function run() {
  const result = {
    schema: 3,
    probe: 'Lilac persistent D3D11 shared texture -> Electron VideoFrame -> DOM dynamic stream',
    smokeMode,
    status: 'fail',
    verdict: 'UNSET',
    electronVersion: process.versions.electron,
    sharedTextureApi: Boolean(sharedTexture),
    phaseA: null,
    phaseB: null,
    phaseC: null,
    phaseD: null,
    phaseE: null,
    error: null
  };

  let addon;
  try {
    addon = require(addonPath());
    result.phaseA = {
      addonLoaded: true,
      importApi: typeof sharedTexture?.importSharedTexture === 'function',
      sendApi: typeof sharedTexture?.sendSharedTexture === 'function',
      rendererReceiverApiExpected: true
    };
    if (!result.phaseA.importApi || !result.phaseA.sendApi) {
      result.verdict = 'FAIL-API-MISSING';
      throw new Error('Electron sharedTexture managed API is unavailable.');
    }

    const smokeTexture = addon.createSolidTexture(64, 64, 6, 64, 230, 255);
    const nativeSample = addon.sampleTexture(smokeTexture.id);
    result.phaseA.nativeTextureCreated = Boolean(smokeTexture?.id && Buffer.isBuffer(smokeTexture?.ntHandle));
    result.phaseA.nativeSourceSample = nativeSample;
    result.phaseA.nativeSourceMatches = colorMatches(nativeSample, { r: 6, g: 64, b: 230 }, 10);
    result.phaseA.ntHandleBytes = smokeTexture?.ntHandle?.length || 0;
    result.phaseA.deviceMode = smokeTexture?.deviceMode || null;
    result.phaseA.featureLevel = smokeTexture?.featureLevel || null;
    result.phaseA.persistentDeviceProducer = true;
    result.phaseA.miscFlags = 'SHARED_NTHANDLE';
    if (!result.phaseA.nativeTextureCreated || !result.phaseA.nativeSourceMatches) {
      result.verdict = 'FAIL-NATIVE-TEXTURE';
      throw new Error('D3D11 shared texture creation or native source readback failed.');
    }

    let sourceReleased = false;
    const releaseSource = () => {
      if (sourceReleased) return;
      sourceReleased = true;
      try { addon.releaseTexture(smokeTexture.id); } catch {}
    };
    let smokeImported;
    try {
      smokeImported = sharedTexture.importSharedTexture({
        textureInfo: textureInfo(smokeTexture),
        allReferencesReleased: releaseSource
      });
      result.phaseA.importedSharedTexture = Boolean(smokeImported && typeof smokeImported.release === 'function');
      if (!result.phaseA.importedSharedTexture) {
        result.verdict = 'FAIL-TEXTURE-IMPORT';
        throw new Error('Electron did not return a SharedTextureImported object.');
      }
      smokeImported.release();
      smokeImported = null;
      for (let i = 0; i < 15 && !sourceReleased; i += 1) await sleep(30);
      result.phaseA.releaseCallbackObserved = sourceReleased;
      if (!sourceReleased) releaseSource();
    } catch (error) {
      try { smokeImported?.release?.(); } catch {}
      releaseSource();
      if (result.verdict === 'UNSET') result.verdict = 'FAIL-TEXTURE-IMPORT';
      throw error;
    }
  } catch (error) {
    result.error = safeError(error);
    if (result.verdict === 'UNSET') result.verdict = 'FAIL-NATIVE-ADDON';
    const text = JSON.stringify(result, null, 2);
    console.log(text);
    try { clipboard.writeText(text); } catch {}
    return app.exit(1);
  }

  if (smokeMode) {
    result.status = 'pass';
    result.verdict = 'SMOKE-IMPORT-PASS';
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
  const ready = waitForIpc('probe-ready', payload => payload?.ready === true, 5000);
  await win.loadFile(htmlPath);
  await ready;

  async function sendTexture(label, color) {
    const diag = {
      label,
      expected: color,
      textureId: null,
      sourceSample: null,
      sourceMatches: false,
      receiverOk: false,
      rendererSample: null,
      rendererMatches: false,
      receiverCount: null,
      renderMs: null,
      mainImportedReleased: false,
      allReferencesReleased: false,
      error: null
    };

    let resource;
    let imported;
    let sourceReleased = false;
    let releaseResolver;
    const releasedPromise = new Promise(resolve => { releaseResolver = resolve; });

    try {
      resource = addon.createSolidTexture(640, 360, color.r, color.g, color.b, 255);
      diag.textureId = resource.id;
      diag.sourceSample = addon.sampleTexture(resource.id);
      diag.sourceMatches = colorMatches(diag.sourceSample, color, 10);

      const releaseSource = () => {
        if (sourceReleased) return;
        sourceReleased = true;
        diag.allReferencesReleased = true;
        try { addon.releaseTexture(resource.id); } catch {}
        releaseResolver?.();
      };

      imported = sharedTexture.importSharedTexture({
        textureInfo: textureInfo(resource),
        allReferencesReleased: releaseSource
      });

      const drawn = waitForIpc('probe-frame-drawn', payload => payload?.label === label, 6000);
      await sharedTexture.sendSharedTexture({
        frame: win.webContents.mainFrame,
        importedSharedTexture: imported
      }, { label });
      imported.release();
      imported = null;
      diag.mainImportedReleased = true;

      const payload = await drawn;
      diag.receiverOk = payload?.ok === true;
      diag.rendererSample = payload?.sample || null;
      diag.rendererMatches = colorMatches(diag.rendererSample, color, 55);
      diag.receiverCount = payload?.receivedCount ?? null;
      diag.renderMs = payload?.renderMs ?? null;
      if (payload?.error) diag.error = String(payload.error).slice(0, 180);

      await Promise.race([releasedPromise, sleep(500)]);
      diag.allReferencesReleased = sourceReleased;
      return diag;
    } catch (error) {
      diag.error = safeError(error);
      try { imported?.release?.(); } catch {}
      if (resource && !sourceReleased) {
        try { addon.releaseTexture(resource.id); } catch {}
        sourceReleased = true;
      }
      diag.allReferencesReleased = sourceReleased;
      return diag;
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
    const center = decodePixel(sampleRaw(360, 220), expectedCenter);
    const top = decodePixel(sampleRaw(140, 85), green);
    const bottom = decodePixel(sampleRaw(575, 355), green);
    return {
      capturedSize: size,
      center,
      top,
      bottom,
      centerMatches: colorMatches(center, expectedCenter, 55),
      topControlGreen: colorMatches(top, green, 65),
      bottomControlGreen: colorMatches(bottom, green, 65)
    };
  }

  const blue = { r: 6, g: 64, b: 230 };
  const purple = { r: 154, g: 38, b: 220 };

  try {
    const transfer = await sendTexture('blue-first', blue);
    const screen = await capture(blue);
    result.phaseB = { transfer, screen };
  } catch (error) {
    result.phaseB = { error: safeError(error) };
  }

  try {
    const transfer = await sendTexture('purple-second', purple);
    const screen = await capture(purple);
    result.phaseC = { transfer, screen };
  } catch (error) {
    result.phaseC = { error: safeError(error) };
  }

  try {
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
  } catch (error) {
    result.phaseD = { sendInputCalled: false, domClickObserved: false, error: safeError(error) };
  }

  try {
    const stressColors = [
      { r: 12, g: 176, b: 96 },
      { r: 230, g: 116, b: 18 },
      { r: 154, g: 38, b: 220 },
      { r: 6, g: 64, b: 230 }
    ];
    const frames = [];
    for (let i = 0; i < 12; i += 1) {
      const color = stressColors[i % stressColors.length];
      frames.push(await sendTexture(`stress-${i + 1}`, color));
    }
    const lastColor = stressColors[(12 - 1) % stressColors.length];
    const finalScreen = await capture(lastColor);
    const sourceMatchCount = frames.filter(f => f.sourceMatches).length;
    const rendererMatchCount = frames.filter(f => f.rendererMatches).length;
    const receiverOkCount = frames.filter(f => f.receiverOk).length;
    const releaseCount = frames.filter(f => f.allReferencesReleased).length;
    const renderTimes = frames.map(f => Number(f.renderMs)).filter(Number.isFinite);
    result.phaseE = {
      frameCount: frames.length,
      sourceMatchCount,
      rendererMatchCount,
      receiverOkCount,
      releaseCallbackCount: releaseCount,
      averageRenderMs: renderTimes.length ? Math.round((renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length) * 10) / 10 : null,
      maxRenderMs: renderTimes.length ? Math.max(...renderTimes) : null,
      finalScreen,
      frameDiagnostics: frames
    };
  } catch (error) {
    result.phaseE = { error: safeError(error) };
  }

  const b = result.phaseB;
  const c = result.phaseC;
  const d = result.phaseD;
  const e = result.phaseE;

  const firstSource = b?.transfer?.sourceMatches === true;
  const firstRenderer = b?.transfer?.rendererMatches === true;
  const firstScreen = b?.screen?.centerMatches === true;
  const domComposite = b?.screen?.topControlGreen === true && b?.screen?.bottomControlGreen === true;
  const secondSource = c?.transfer?.sourceMatches === true;
  const secondRenderer = c?.transfer?.rendererMatches === true;
  const secondScreen = c?.screen?.centerMatches === true;
  const clickOk = d?.sendInputCalled === true && d?.domClickObserved === true;
  const streamOk = e?.frameCount === 12 && e?.sourceMatchCount === 12 && e?.rendererMatchCount === 12 && e?.receiverOkCount === 12 && e?.finalScreen?.centerMatches === true;

  if (!firstSource) {
    result.verdict = 'FAIL-NATIVE-FIRST-SOURCE';
    result.error = 'Native D3D11 first source texture readback did not match.';
  } else if (!firstRenderer || !firstScreen) {
    result.verdict = 'FAIL-FIRST-FRAME-BRIDGE';
    result.error = 'First native texture did not reach Chromium canvas/compositor correctly.';
  } else if (!domComposite) {
    result.verdict = 'FAIL-DOM-COMPOSITION';
    result.error = 'DOM controls did not composite above the imported GPU frame.';
  } else if (!secondSource) {
    result.verdict = 'FAIL-NATIVE-SECOND-SOURCE';
    result.error = 'Second native D3D11 source texture itself was not purple.';
  } else if (!secondRenderer) {
    result.verdict = 'FAIL-SECOND-FRAME-BRIDGE';
    result.error = 'Second native texture was correct, but renderer still sampled a stale frame.';
  } else if (!secondScreen) {
    result.verdict = 'FAIL-SECOND-FRAME-COMPOSITOR';
    result.error = 'Renderer canvas updated, but BrowserWindow compositor capture stayed stale.';
  } else if (!clickOk) {
    result.verdict = 'FAIL-OS-CLICK';
    result.error = 'Real Windows mouse input did not reach the DOM control.';
  } else if (!streamOk) {
    result.verdict = 'FAIL-DYNAMIC-STREAM';
    result.error = 'Single-frame bridge works, but repeated dynamic shared-texture updates were not all correct.';
  } else {
    result.status = 'pass';
    result.verdict = 'PASS-ZERO-COPY-DYNAMIC-BRIDGE';
    result.error = null;
  }

  const text = JSON.stringify(result, null, 2);
  console.log(text);
  clipboard.writeText(text);
  win.webContents.send('probe-result', result);
  setTimeout(() => app.quit(), 2500);
}

app.whenReady().then(run).catch(error => {
  const result = {
    schema: 3,
    probe: 'Lilac persistent D3D11 shared texture -> Electron VideoFrame -> DOM dynamic stream',
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

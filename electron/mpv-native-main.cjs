'use strict';

const path = require('node:path');
const { createMpvRelay } = require('./mpv-relay.cjs');

function createNativeMpvBridge({ app, ipcMain, headersFor, userAgent }) {
  const relay = createMpvRelay();
  let servicePromise = null;
  let service = null;

  function packagedAddonPath() {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'electron-mpv-video',
      'native',
      'mpv-addon',
      'build',
      'Release',
      'mpv_addon.node'
    );
  }

  async function ensure() {
    if (!servicePromise) {
      servicePromise = (async () => {
        const { createMpvMain } = await import('electron-mpv-video/main');
        service = createMpvMain(app.isPackaged ? { addonPath: packagedAddonPath() } : {});
        return service;
      })();
    }
    return servicePromise;
  }

  async function attachWindow(win) {
    const active = await ensure();
    if (!win.isDestroyed()) active.attachWindow(win);
  }

  ipcMain.handle('native-mpv:prepare', async (_event, mediaUrl, suppliedHeaders = {}, hls = false) => {
    const parsed = new URL(String(mediaUrl || ''));
    if (parsed.protocol === 'file:' || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return { url: parsed.href, relayed: false };
    }
    if (parsed.protocol !== 'https:') throw new Error(`native mpv rejected protocol: ${parsed.protocol}`);
    const effective = typeof headersFor === 'function'
      ? headersFor(parsed, suppliedHeaders || {})
      : suppliedHeaders || {};
    return relay.prepare(parsed.href, effective, { hls: Boolean(hls), userAgent });
  });

  async function dispose() {
    await relay.close().catch(() => {});
    if (service) await service.dispose().catch(() => {});
    service = null;
    servicePromise = null;
  }

  return { ensure, attachWindow, dispose };
}

module.exports = { createNativeMpvBridge };

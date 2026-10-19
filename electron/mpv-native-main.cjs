'use strict';

const path = require('node:path');
const { createMpvRelay } = require('./mpv-relay.cjs');

function createNativeMpvBridge({ app, ipcMain, headersFor, userAgent }) {
  const relay = createMpvRelay();
  let servicePromise = null;
  let service = null;
  let disposed = false;
  let lastPrepare = {
    route: 'none',
    sourceScheme: '',
    hls: false,
    suppliedHeaderCount: 0,
    effectiveHeaderCount: 0
  };

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
    if (disposed) throw new Error('native mpv bridge is disposed');
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

  async function detachWindow(win) {
    if (!service || !win || win.isDestroyed()) return;
    await service.detachWindow(win).catch(() => {});
  }

  ipcMain.handle('native-mpv:prepare', async (_event, mediaUrl, suppliedHeaders = {}, hls = false) => {
    const parsed = new URL(String(mediaUrl || ''));
    const suppliedHeaderCount = Object.entries(suppliedHeaders || {})
      .filter(([key, value]) => key && value != null && String(value).length).length;

    if (parsed.protocol === 'file:' || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      lastPrepare = {
        route: parsed.protocol === 'file:' ? 'local-file' : 'local-bypass',
        sourceScheme: parsed.protocol.replace(':', ''),
        hls: Boolean(hls),
        suppliedHeaderCount,
        effectiveHeaderCount: suppliedHeaderCount
      };
      return { url: parsed.href, relayed: false, route: lastPrepare.route };
    }

    if (parsed.protocol !== 'https:') throw new Error(`native mpv rejected protocol: ${parsed.protocol}`);
    const effective = typeof headersFor === 'function'
      ? headersFor(parsed, suppliedHeaders || {})
      : suppliedHeaders || {};
    const effectiveHeaderCount = Object.entries(effective || {})
      .filter(([key, value]) => key && value != null && String(value).length).length;

    lastPrepare = {
      route: 'relay',
      sourceScheme: 'https',
      hls: Boolean(hls),
      suppliedHeaderCount,
      effectiveHeaderCount
    };

    const prepared = await relay.prepare(parsed.href, effective, { hls: Boolean(hls), userAgent });
    return { ...prepared, route: 'relay' };
  });

  ipcMain.handle('native-mpv:diagnostics', async () => ({
    relay: relay.stats(),
    prepare: { ...lastPrepare },
    serviceReady: Boolean(service),
    disposed
  }));

  async function dispose() {
    if (disposed) return;
    disposed = true;
    await relay.close().catch(() => {});
    if (service) await service.dispose().catch(() => {});
    service = null;
    servicePromise = null;
    try { ipcMain.removeHandler('native-mpv:prepare'); } catch {}
    try { ipcMain.removeHandler('native-mpv:diagnostics'); } catch {}
  }

  return { ensure, attachWindow, detachWindow, dispose };
}

module.exports = { createNativeMpvBridge };

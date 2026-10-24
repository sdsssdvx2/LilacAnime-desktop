'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const preload = path.join(root, 'electron', 'preload.cjs');
const index = path.join(root, 'src', 'index.html');
const errors = [];
const log = (...args) => console.log(...args);
const fail = message => { errors.push(String(message)); console.error('LIBMPV_R2R_UI_STARTUP_ERROR', message); };

function valueFor(channel, args) {
  if (channel === 'downloads:list') return [];
  if (channel === 'downloads:root') return '';
  if (channel === 'desktop:settings') return {};
  if (channel === 'update:state') return { status: 'idle' };
  if (channel === 'device-sync:status') return { connected: false };
  if (channel === 'gemini:get') return {};
  if (channel === 'subtitle-cache:usage') return { files: 0, bytes: 0 };
  if (channel === 'catalog-index:state') return { source: 'reanime', status: 'ready', count: 0 };
  if (channel === 'titles:resolve') return [];
  if (channel === 'anime:season' || channel === 'anime:top') return { data: [] };
  if (channel === 'provider:catalog') return { data: [], total: 0, nextOffset: null, done: true };
  if (channel === 'provider:season') return { data: [], label: '이번 시즌 신작' };
  if (channel === 'provider:airing') return { data: [] };
  if (channel === 'linkkf:home') return { data: [] };
  if (channel === 'mpv:status') return { available: false };
  if (channel === 'font:default') return { choice: 'system', customPath: '' };
  if (channel === 'desktop:tray' || channel === 'window:theme' || channel === 'window:buttons' || channel === 'catalog:activate') return true;
  return null;
}

(async () => {
  await app.whenReady();
  const preloadSource = fs.readFileSync(preload, 'utf8');
  const channels = new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]));
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => valueFor(channel, args));

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
  win.webContents.on('preload-error', (_event, filePath, error) => fail(`preload ${filePath}: ${error?.stack || error}`));
  win.webContents.on('render-process-gone', (_event, details) => fail(`render-process-gone ${JSON.stringify(details)}`));
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const text = String(message || '');
    if (/uncaught|referenceerror|typeerror|syntaxerror|failed to load resource/i.test(text)) fail(`console level=${level} ${sourceId || ''}:${line || 0} ${text}`);
  });

  try {
    await win.loadFile(index);
    await new Promise(resolve => setTimeout(resolve, 1800));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const out = { ready: document.readyState, before: document.querySelector('.view.active')?.id || '' };
      const settings = document.querySelector('.nav[data-view="settings"]');
      const home = document.querySelector('.nav[data-view="home"]');
      const search = document.querySelector('#globalSearch');
      out.hasSettings = !!settings; out.hasSearch = !!search;
      settings?.click(); await new Promise(r => setTimeout(r, 80));
      out.settingsActive = document.querySelector('#settingsView')?.classList.contains('active') === true;
      home?.click(); await new Promise(r => setTimeout(r, 80));
      out.homeActive = document.querySelector('#homeView')?.classList.contains('active') === true;
      if (search) { search.value = 'naruto'; search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      await new Promise(r => setTimeout(r, 180));
      out.searchActive = document.querySelector('#searchView')?.classList.contains('active') === true;
      out.searchStatus = document.querySelector('#searchStatus')?.textContent || '';
      out.heroSkeleton = document.querySelector('#hero')?.classList.contains('skeleton') === true;
      return out;
    })()`);
    log('LIBMPV_R2R_UI_STARTUP_REPORT=' + JSON.stringify(result));
    if (!result.hasSettings || !result.hasSearch || !result.settingsActive || !result.homeActive || !result.searchActive) {
      fail('core UI interaction did not bind: ' + JSON.stringify(result));
    }
  } catch (error) {
    fail(error?.stack || error);
  } finally {
    for (const channel of channels) ipcMain.removeHandler(channel);
    if (!win.isDestroyed()) win.destroy();
    if (errors.length) {
      console.error('LIBMPV_R2R_UI_STARTUP_FAIL count=' + errors.length);
      app.exit(1);
    } else {
      console.log('LIBMPV_R2R_UI_STARTUP_PASS nav=1 settings=1 search=1');
      app.exit(0);
    }
  }
})().catch(error => { console.error(error?.stack || error); app.exit(1); });

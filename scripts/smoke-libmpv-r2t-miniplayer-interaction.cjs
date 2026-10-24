'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const preload = path.join(root, 'electron', 'preload.cjs');
const index = path.join(root, 'src', 'index.html');
const errors = [];
const calls = [];
let miniActive = false;
const fail = message => { errors.push(String(message)); console.error('LIBMPV_R2T_MINI_INTERACTION_ERROR', message); };

function valueFor(channel) {
  if (channel === 'player:miniplayer') return null;
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
  for (const channel of channels) {
    if (channel === 'player:miniplayer') {
      ipcMain.handle(channel, (_event, enabled) => {
        miniActive = Boolean(enabled);
        calls.push(miniActive);
        return { active: miniActive };
      });
    } else ipcMain.handle(channel, () => valueFor(channel));
  }

  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
  win.webContents.on('preload-error', (_event, filePath, error) => fail(`preload ${filePath}: ${error?.stack || error}`));
  win.webContents.on('render-process-gone', (_event, details) => fail(`render-process-gone ${JSON.stringify(details)}`));
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const text = String(message || '');
    if (/uncaught|referenceerror|typeerror|syntaxerror/i.test(text)) fail(`console level=${level} ${sourceId || ''}:${line || 0} ${text}`);
  });

  try {
    await win.loadFile(index);
    await new Promise(resolve => setTimeout(resolve, 1600));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const real = document.querySelector('#video');
      const button = document.querySelector('#miniPlayer');
      const playerView = document.querySelector('#playerView');
      if (!real || !button || !playerView) return { missing: true };
      playerView.classList.add('active');
      document.body.classList.add('player-mode');
      try { Object.defineProperty(real, 'readyState', { configurable: true, get: () => 4 }); } catch {}
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const snap = label => ({ label, active: button.classList.contains('active'), body: document.body.classList.contains('libmpv-mini-player') });
      const states = [];
      states.push(snap('before'));
      button.click(); await sleep(80); states.push(snap('button-open'));
      button.click(); await sleep(80); states.push(snap('button-close'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', shiftKey: true, bubbles: true, cancelable: true })); await sleep(80); states.push(snap('key-open'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', shiftKey: true, bubbles: true, cancelable: true })); await sleep(80); states.push(snap('key-close'));
      return { tag: real.tagName, hidden: button.classList.contains('hidden'), states };
    })()`);
    console.log('LIBMPV_R2T_MINI_INTERACTION_REPORT=' + JSON.stringify({ result, calls }));
    const states = result?.states || [];
    const expectedStates = [false, true, false, true, false];
    if (result?.missing || result?.tag !== 'LILAC-MPV-VIDEO' || result.hidden) fail('libmpv mini-player controls unavailable: ' + JSON.stringify(result));
    if (states.length !== expectedStates.length || states.some((state, i) => state.active !== expectedStates[i] || state.body !== expectedStates[i])) fail('button/shortcut visual states mismatch: ' + JSON.stringify(states));
    if (JSON.stringify(calls) !== JSON.stringify([true, false, true, false])) fail('IPC toggle order mismatch: ' + JSON.stringify(calls));
  } catch (error) { fail(error?.stack || error); }
  finally {
    for (const channel of channels) ipcMain.removeHandler(channel);
    if (!win.isDestroyed()) win.destroy();
    if (errors.length) { console.error('LIBMPV_R2T_MINI_INTERACTION_FAIL count=' + errors.length); app.exit(1); }
    else { console.log('LIBMPV_R2T_MINI_INTERACTION_PASS button=2 ShiftP=2 ipc=true-false-true-false'); app.exit(0); }
  }
})().catch(error => { console.error(error?.stack || error); app.exit(1); });

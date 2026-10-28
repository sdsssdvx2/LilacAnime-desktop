'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(process.argv[2] || path.join(__dirname, 'r40-single-dom-subtitle-overlay-fix.cjs'));
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldLifecycle = String.raw`main = once(main,
  \`  mainWindow = win;\n  desktopState.attach(win);\`,
  \`  mainWindow = win;\n  desktopState.attach(win);\n  const r40SyncSubtitleOverlay = reason => { try { r40SubtitleOverlay?.sync(win, reason); } catch {} };\n  win.on('move', () => r40SyncSubtitleOverlay('owner-move'));\n  win.on('resize', () => r40SyncSubtitleOverlay('owner-resize'));\n  win.on('restore', () => r40SyncSubtitleOverlay('owner-restore'));\n  win.on('show', () => r40SyncSubtitleOverlay('owner-show'));\n  win.on('always-on-top-changed', () => r40SyncSubtitleOverlay('owner-topmost'));\n  win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'));\n  win.on('hide', () => r40SubtitleOverlay?.hide('owner-hidden'));\n  win.on('minimize', () => r40SubtitleOverlay?.hide('owner-minimized'));\`,
  'R40 subtitle overlay owner lifecycle');
main = once(main,
  \`  win.on('closed', () => { if (mainWindow === win) { mainWindow = null; miruroRequest.close(); } });\`,
  \`  win.on('closed', () => { if (mainWindow === win) { r40SubtitleOverlay?.destroy('owner-closed'); mainWindow = null; miruroRequest.close(); } });\`,
  'R40 subtitle overlay owner close');`;

const newLifecycle = String.raw`{
  const createStart = main.indexOf('function createWindow() {');
  const createEnd = main.indexOf('\n}\n\napp.whenReady()', createStart + 1);
  if (createStart < 0 || createEnd <= createStart || main.indexOf('function createWindow() {', createStart + 1) >= 0) {
    throw new Error('R40 subtitle overlay createWindow boundary invalid');
  }
  let createBlock = main.slice(createStart, createEnd);
  const attachMatches = [...createBlock.matchAll(/^[ \t]*desktopState\.attach\(win\);[ \t]*$/gm)];
  if (attachMatches.length !== 1) throw new Error(\`R40 subtitle overlay owner attach: expected exactly one createWindow attach, found \${attachMatches.length}\`);
  const attachLine = attachMatches[0][0];
  const lifecycle = \`\${attachLine}\n  const r40SyncSubtitleOverlay = reason => { try { r40SubtitleOverlay?.sync(win, reason); } catch {} };\n  win.on('move', () => r40SyncSubtitleOverlay('owner-move'));\n  win.on('resize', () => r40SyncSubtitleOverlay('owner-resize'));\n  win.on('restore', () => r40SyncSubtitleOverlay('owner-restore'));\n  win.on('show', () => r40SyncSubtitleOverlay('owner-show'));\n  win.on('always-on-top-changed', () => r40SyncSubtitleOverlay('owner-topmost'));\n  win.on('focus', () => r40SubtitleOverlay?.hide('owner-focused'));\n  win.on('hide', () => r40SubtitleOverlay?.hide('owner-hidden'));\n  win.on('minimize', () => r40SubtitleOverlay?.hide('owner-minimized'));\n  win.on('closed', () => { if (mainWindow === win) r40SubtitleOverlay?.destroy('owner-closed'); });\`;
  createBlock = createBlock.replace(attachLine, lifecycle);
  main = main.slice(0, createStart) + createBlock + main.slice(createEnd);
}`;

const oldIpc = String.raw`main = once(main,
  \`  ipcMain.handle('desktop:settings',()=>desktopState.settings());\`,
  \`  r40SubtitleOverlay = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir: __dirname });\n  ipcMain.handle('player:native-subtitle-overlay', async (event, payload = {}) => {\n    const win = BrowserWindow.fromWebContents(event.sender);\n    if (!win || win !== mainWindow || win.isDestroyed()) return { ok:false, reason:'not-main-window', marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY' };\n    return r40SubtitleOverlay.update(win, payload);\n  });\n  ipcMain.handle('player:native-subtitle-overlay-state', event => {\n    const win = BrowserWindow.fromWebContents(event.sender);\n    if (!win || win !== mainWindow) return { marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', active:false, reason:'not-main-window' };\n    return r40SubtitleOverlay.snapshot();\n  });\n  ipcMain.handle('desktop:settings',()=>desktopState.settings());\`,
  'R40 subtitle overlay IPC');`;

const newIpc = String.raw`{
  const settingsMatches = [...main.matchAll(/^[ \t]*ipcMain\.handle\(\s*['\"]desktop:settings['\"]\s*,[^\n]*\);[ \t]*$/gm)];
  if (settingsMatches.length !== 1) throw new Error(\`R40 subtitle overlay IPC: expected exactly one desktop:settings handler, found \${settingsMatches.length}\`);
  const settingsLine = settingsMatches[0][0];
  const indent = settingsLine.match(/^[ \t]*/)?.[0] || '  ';
  const overlayIpc = \`\${indent}r40SubtitleOverlay = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir: __dirname });\n\${indent}ipcMain.handle('player:native-subtitle-overlay', async (event, payload = {}) => {\n\${indent}  const win = BrowserWindow.fromWebContents(event.sender);\n\${indent}  if (!win || win !== mainWindow || win.isDestroyed()) return { ok:false, reason:'not-main-window', marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY' };\n\${indent}  return r40SubtitleOverlay.update(win, payload);\n\${indent}});\n\${indent}ipcMain.handle('player:native-subtitle-overlay-state', event => {\n\${indent}  const win = BrowserWindow.fromWebContents(event.sender);\n\${indent}  if (!win || win !== mainWindow) return { marker:'LILAC_R40_SINGLE_DOM_SUBTITLE_AUTHORITY', active:false, reason:'not-main-window' };\n\${indent}  return r40SubtitleOverlay.snapshot();\n\${indent}});\n\${settingsLine}\`;
  main = main.replace(settingsLine, overlayIpc);
}`;

function replaceExact(oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one transform block, found ${count}`);
  source = source.replace(oldText, newText);
}

replaceExact(oldLifecycle, newLifecycle, 'R40 lifecycle transform compat');
replaceExact(oldIpc, newIpc, 'R40 IPC transform compat');

if (!source.includes('R40 subtitle overlay createWindow boundary invalid')) throw new Error('R40 structural lifecycle replacement missing');
if (!source.includes('settingsMatches = [...main.matchAll')) throw new Error('R40 structural IPC replacement missing');
if (source.includes("'R40 subtitle overlay owner close'")) throw new Error('R40 stale owner-close exact anchor survived');

fs.writeFileSync(target, source, 'utf8');
console.log(`R40_SUBTITLE_ANCHOR_COMPAT_OK target=${path.basename(target)} lifecycle=createWindow-structural ipc=desktop-settings-regex close=independent-listener`);

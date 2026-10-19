'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { BrowserWindow } = require('electron');
const { createMpvRelay } = require('./mpv-relay.cjs');

function createNativeMpvBridge({ app, ipcMain, headersFor, userAgent }) {
  const relay = createMpvRelay();
  let attachedWindow = null;
  let child = null;
  let hostHelper = null;
  let hostMode = 'idle';
  let hostHwnd = null;
  let pipeName = null;
  let disposed = false;
  let lastRelativeBounds = null;
  let requestId = 0;
  let generation = 0;
  let route = 'idle';
  let suppliedHeaderCount = 0;
  let lastPid = null;
  let listeners = [];
  let overlayWindow = null;
  let overlayLoaded = false;
  let overlayWantedVisible = false;

  function mpvExecutable() {
    const candidates = [];
    if (process.platform === 'win32') {
      candidates.push(
        path.join(process.env.PROGRAMFILES || '', 'MPV Player', 'mpv.exe'),
        path.join(process.env.PROGRAMFILES || '', 'mpv', 'mpv.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
        path.join(process.resourcesPath || '', 'mpv', 'mpv.exe'),
        path.join(app.getAppPath(), 'bin', 'mpv.exe')
      );
    }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, process.platform === 'win32' ? 'mpv.exe' : 'mpv'));
    }
    if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/mpv', '/usr/local/bin/mpv');
    return candidates.find(file => file && fs.existsSync(file)) || null;
  }

  function helperExecutable() {
    if (process.platform !== 'win32') return null;
    const candidates = [
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'win32-mpv-host.exe'),
      path.join(app.getAppPath(), 'electron', 'win32-mpv-host.exe'),
      path.join(__dirname, 'win32-mpv-host.exe')
    ];
    return candidates.find(file => file && fs.existsSync(file)) || null;
  }

  function nativeHandleDecimal(win) {
    const raw = win.getNativeWindowHandle();
    if (raw.length >= 8 && process.arch === 'x64') return raw.readBigUInt64LE(0).toString();
    return String(raw.readUInt32LE(0));
  }

  function normalizeHole(value, width, height) {
    const x = Math.max(0, Math.min(width, Math.round(Number(value?.x) || 0)));
    const y = Math.max(0, Math.min(height, Math.round(Number(value?.y) || 0)));
    const w = Math.max(0, Math.min(width - x, Math.round(Number(value?.width) || 0)));
    const h = Math.max(0, Math.min(height - y, Math.round(Number(value?.height) || 0)));
    return { x, y, width: w, height: h };
  }

  function normalizeBounds(value = {}) {
    const n = key => Number(value?.[key]);
    const width = Math.max(1, Number.isFinite(n('width')) ? Math.round(n('width')) : 1);
    const height = Math.max(1, Number.isFinite(n('height')) ? Math.round(n('height')) : 1);
    const holes = Array.isArray(value?.holes)
      ? value.holes.slice(0, 16).map(hole => normalizeHole(hole, width, height)).filter(hole => hole.width > 0 && hole.height > 0)
      : [];
    return {
      x: Number.isFinite(n('x')) ? Math.round(n('x')) : 0,
      y: Number.isFinite(n('y')) ? Math.round(n('y')) : 0,
      width,
      height,
      visible: value?.visible !== false,
      holes
    };
  }

  function helperBoundsLine(bounds) {
    const normalized = normalizeBounds(bounds);
    const fields = [
      'B', normalized.x, normalized.y, normalized.width, normalized.height,
      normalized.visible ? 1 : 0, normalized.holes.length
    ];
    for (const hole of normalized.holes) fields.push(hole.x, hole.y, hole.width, hole.height);
    return fields.join(' ') + '\n';
  }

  function syncHostBounds() {
    if (!hostHelper || hostHelper.exitCode != null || !hostHelper.stdin || !lastRelativeBounds) return;
    try { hostHelper.stdin.write(helperBoundsLine(lastRelativeBounds)); } catch {}
  }

  function overlaySend(channel, payload) {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayLoaded) return;
    try { overlayWindow.webContents.send(channel, payload); } catch {}
  }

  function syncOverlayBounds(forceVisible = null) {
    if (!overlayWindow || overlayWindow.isDestroyed() || !attachedWindow || attachedWindow.isDestroyed()) return;
    const visible = forceVisible == null ? Boolean(lastRelativeBounds?.visible) : Boolean(forceVisible);
    overlayWantedVisible = visible;
    try {
      const bounds = attachedWindow.getBounds();
      overlayWindow.setBounds(bounds, false);
      if (!visible || attachedWindow.isMinimized() || !attachedWindow.isVisible()) {
        overlayWindow.hide();
        return;
      }
      if (overlayLoaded) overlayWindow.showInactive();
    } catch {}
  }

  function ensureOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
    if (!attachedWindow || attachedWindow.isDestroyed()) return null;
    overlayLoaded = false;
    overlayWindow = new BrowserWindow({
      parent: attachedWindow,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'mpv-overlay-preload.cjs'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    overlayWindow.setMenuBarVisibility(false);
    overlayWindow.webContents.once('did-finish-load', () => {
      overlayLoaded = true;
      syncOverlayBounds(overlayWantedVisible);
    });
    overlayWindow.on('closed', () => {
      overlayWindow = null;
      overlayLoaded = false;
      overlayWantedVisible = false;
    });
    overlayWindow.loadFile(path.join(__dirname, 'mpv-overlay.html')).catch(() => {});
    syncOverlayBounds(false);
    return overlayWindow;
  }

  function connectAndBatch(commands, timeout = 900) {
    return new Promise((resolve, reject) => {
      if (!pipeName) return reject(new Error('mpv IPC unavailable'));
      const ids = commands.map(() => ++requestId);
      const replies = new Map();
      let buffer = '';
      let settled = false;
      let socket = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket?.destroy(); } catch {}
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('mpv IPC timeout')), timeout);
      socket = net.createConnection(pipeName);
      socket.once('connect', () => {
        commands.forEach((command, index) => socket.write(JSON.stringify({ command, request_id: ids[index] }) + '\n'));
      });
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const at = buffer.indexOf('\n');
          if (at < 0) break;
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line);
            if (ids.includes(message.request_id)) replies.set(message.request_id, message);
          } catch {}
          if (replies.size === ids.length) finish(null, ids.map(id => replies.get(id)));
        }
      });
      socket.once('error', error => finish(error));
      socket.once('close', () => {
        if (!settled && replies.size !== ids.length) finish(new Error('mpv IPC closed'));
      });
    });
  }

  async function waitForIpc(timeout = 7000) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const [reply] = await connectAndBatch([['get_property', 'mpv-version']], 350);
        if (reply?.error === 'success') return true;
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw lastError || new Error('mpv IPC did not become ready');
  }

  function startHostHelper(bounds) {
    return new Promise((resolve, reject) => {
      const helper = helperExecutable();
      if (!helper) return reject(new Error('Win32 mpv host helper was not found'));
      if (!attachedWindow || attachedWindow.isDestroyed()) return reject(new Error('native mpv parent window is unavailable'));
      const parentHwnd = nativeHandleDecimal(attachedWindow);
      const proc = spawn(helper, [parentHwnd], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      hostHelper = proc;
      let buffer = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Win32 raw host helper timed out')), 7000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const at = buffer.indexOf('\n');
          if (at < 0) break;
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          const ready = /^READY\s+host\s+(\d+)$/.exec(line);
          if (ready) {
            hostMode = 'raw-child';
            hostHwnd = ready[1];
            lastRelativeBounds = normalizeBounds(bounds || lastRelativeBounds || {});
            syncHostBounds();
            finish(null, { mode: hostMode, hwnd: hostHwnd });
            continue;
          }
          if (line.startsWith('ERR ')) finish(new Error(`Win32 raw host helper: ${line.slice(4)}`));
        }
      });
      proc.once('error', error => finish(error));
      proc.once('exit', code => {
        if (hostHelper === proc) hostHelper = null;
        if (!settled) finish(new Error(`Win32 raw host helper exited (${code ?? 'unknown'})`));
      });
    });
  }

  async function prepare(mediaUrl, suppliedHeaders = {}, hls = false) {
    const parsed = new URL(String(mediaUrl || ''));
    suppliedHeaderCount = Object.entries(suppliedHeaders || {}).filter(([, value]) => value != null && String(value).length).length;
    if (parsed.protocol === 'file:') { route = 'file-bypass'; return { url: parsed.href, relayed: false }; }
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') { route = 'local-bypass'; return { url: parsed.href, relayed: false }; }
    if (parsed.protocol !== 'https:') throw new Error(`native mpv rejected protocol: ${parsed.protocol}`);
    const effective = typeof headersFor === 'function' ? headersFor(parsed, suppliedHeaders || {}) : suppliedHeaders || {};
    route = 'relay';
    return relay.prepare(parsed.href, effective, { hls: Boolean(hls), userAgent });
  }

  async function closePlayer() {
    overlayWantedVisible = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlaySend('native-overlay:reset');
      try { overlayWindow.hide(); } catch {}
    }
    const oldChild = child;
    child = null;
    pipeName = null;
    lastPid = null;
    generation++;
    if (oldChild && oldChild.exitCode == null) { try { oldChild.kill(); } catch {} }
    const oldHelper = hostHelper;
    hostHelper = null;
    hostMode = 'idle';
    hostHwnd = null;
    if (oldHelper && oldHelper.exitCode == null) {
      try { oldHelper.stdin?.write('Q\n'); } catch {}
      setTimeout(() => { try { if (oldHelper.exitCode == null) oldHelper.kill(); } catch {} }, 150).unref?.();
    }
  }

  async function openPlayer(mediaUrl, suppliedHeaders, hls, bounds) {
    if (disposed) throw new Error('native mpv bridge is disposed');
    if (process.platform !== 'win32') throw new Error('raw HWND mpv prototype currently supports Windows only');
    const executable = mpvExecutable();
    if (!executable) throw new Error('mpv executable was not found');
    if (!helperExecutable()) throw new Error('Win32 mpv host helper was not found');
    ensureOverlay();
    const prepared = await prepare(mediaUrl, suppliedHeaders, hls);
    await closePlayer();
    lastRelativeBounds = normalizeBounds(bounds);
    lastRelativeBounds.holes = [];
    const host = await startHostHelper(lastRelativeBounds);
    if (!host?.hwnd) throw new Error('Win32 raw host HWND was not created');
    const myGeneration = generation;
    const safeId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pipeName = `\\\\.\\pipe\\LilacAnime-host-${safeId}`;
    const args = [
      '--no-config','--force-window=yes','--no-border',`--wid=${host.hwnd}`,`--input-ipc-server=${pipeName}`,
      '--hwdec=auto-safe','--vo=gpu-next','--gpu-api=d3d11','--osc=no','--input-default-bindings=no',
      '--keep-open=no','--idle=yes','--osd-level=0','--cursor-autohide=always'
    ];
    child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
    lastPid = child.pid || null;
    if (!lastPid) { await closePlayer(); throw new Error('mpv process did not start'); }
    child.once('exit', () => {
      if (generation !== myGeneration) return;
      const helper = hostHelper;
      hostHelper = null;
      if (helper && helper.exitCode == null) { try { helper.stdin?.write('Q\n'); } catch {} try { helper.kill(); } catch {} }
      hostMode = 'idle'; hostHwnd = null; child = null; pipeName = null; lastPid = null;
      overlayWantedVisible = false;
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    });
    try {
      await waitForIpc();
      syncHostBounds();
      const [loadReply] = await connectAndBatch([['loadfile', prepared.url, 'replace']], 2500);
      if (loadReply?.error !== 'success') throw new Error(`mpv loadfile failed: ${loadReply?.error || 'unknown'}`);
      await connectAndBatch([['set_property', 'pause', false]], 900).catch(() => {});
      syncOverlayBounds(lastRelativeBounds.visible);
    } catch (error) { await closePlayer(); throw error; }
    return { ok: true, pid: lastPid, route, relayed: Boolean(prepared.relayed), hostMode };
  }

  async function state() {
    const active = Boolean(child && child.exitCode == null && pipeName);
    if (!active) return { active: false, pid: lastPid, route, hostMode };
    try {
      const replies = await connectAndBatch([
        ['get_property', 'time-pos'],['get_property', 'duration'],['get_property', 'pause'],['get_property', 'volume'],
        ['get_property', 'video-params/w'],['get_property', 'video-params/h'],['get_property', 'video-codec'],
        ['get_property', 'container-fps'],['get_property', 'vid'],['get_property', 'aid'],['get_property', 'mute']
      ], 700);
      const value = index => replies[index]?.error === 'success' ? replies[index].data : null;
      const numeric = index => { const number = Number(value(index)); return Number.isFinite(number) ? number : null; };
      return {
        active: true, pid: lastPid, route, hostMode,
        time: numeric(0), duration: numeric(1), paused: Boolean(value(2)), volume: numeric(3),
        width: numeric(4), height: numeric(5), codec: typeof value(6) === 'string' ? value(6) : null,
        fps: numeric(7), vid: value(8), aid: value(9), muted: Boolean(value(10))
      };
    } catch {
      return { active: true, pid: lastPid, route, hostMode, time: null, duration: null, paused: null, width: null, height: null, codec: null, fps: null, muted: null };
    }
  }

  async function overlayMeta() {
    if (!attachedWindow || attachedWindow.isDestroyed()) return null;
    try {
      return await attachedWindow.webContents.executeJavaScript(`({title:document.querySelector('#playerTitle')?.textContent||'LilacAnime',meta:document.querySelector('#playerMeta')?.textContent||''})`, true);
    } catch { return null; }
  }

  async function overlayAction(action) {
    if (!attachedWindow || attachedWindow.isDestroyed()) return false;
    if (action === 'back') {
      try { await attachedWindow.webContents.executeJavaScript(`document.querySelector('#playerBack')?.click(); true`, true); } catch {}
      await closePlayer();
      return true;
    }
    if (action === 'settings') {
      try { hostHelper?.stdin?.write('H\n'); } catch {}
      overlayWantedVisible = false;
      try { overlayWindow?.hide(); } catch {}
      try { await attachedWindow.webContents.executeJavaScript(`document.querySelector('#playerSettingsButton')?.click(); true`, true); } catch {}
      return true;
    }
    return false;
  }

  function attachWindow(win) {
    attachedWindow = win;
    const add = (event, handler) => { win.on(event, handler); listeners.push(() => { try { win.off(event, handler); } catch {} }); };
    const syncAll = () => { syncHostBounds(); syncOverlayBounds(); };
    add('resize', syncAll); add('move', syncAll); add('restore', syncAll); add('show', syncAll);
    add('minimize', () => { try { hostHelper?.stdin?.write('H\n'); } catch {} try { overlayWindow?.hide(); } catch {} });
    add('hide', () => { try { hostHelper?.stdin?.write('H\n'); } catch {} try { overlayWindow?.hide(); } catch {} });
    add('closed', () => { void closePlayer(); attachedWindow = null; try { overlayWindow?.destroy(); } catch {} overlayWindow = null; });
  }

  async function detachWindow(win) {
    if (attachedWindow !== win) return;
    listeners.splice(0).forEach(dispose => dispose());
    await closePlayer();
    try { overlayWindow?.destroy(); } catch {}
    overlayWindow = null;
    attachedWindow = null;
  }

  async function ensure() {
    if (disposed) throw new Error('native mpv bridge is disposed');
    return { available: Boolean(mpvExecutable()), helperAvailable: Boolean(helperExecutable()) };
  }

  async function allowedCommand(command) {
    if (!Array.isArray(command) || !command.length) throw new Error('invalid mpv command');
    const allowed = new Set(['set_property', 'seek', 'cycle', 'sub-add', 'sub-remove', 'stop']);
    if (!allowed.has(String(command[0]))) throw new Error('mpv command not allowed');
    try {
      const [reply] = await connectAndBatch([command], 900);
      return { ok: reply?.error === 'success', error: reply?.error || null, data: reply?.data ?? null };
    } catch (error) { return { ok: false, error: error?.message || String(error) }; }
  }

  ipcMain.handle('native-mpv:prepare', async (_event, mediaUrl, suppliedHeaders = {}, hls = false) => prepare(mediaUrl, suppliedHeaders, hls));
  ipcMain.handle('native-mpv:open', async (_event, mediaUrl, suppliedHeaders = {}, hls = false, bounds = {}) => openPlayer(mediaUrl, suppliedHeaders, Boolean(hls), bounds));
  ipcMain.handle('native-mpv:state', async () => state());
  ipcMain.handle('native-mpv:bounds', async (_event, bounds = {}) => {
    lastRelativeBounds = normalizeBounds(bounds);
    lastRelativeBounds.holes = [];
    syncHostBounds();
    syncOverlayBounds(lastRelativeBounds.visible);
    return true;
  });
  ipcMain.handle('native-mpv:command', async (_event, command) => allowedCommand(command));
  ipcMain.handle('native-mpv:close', async () => { await closePlayer(); return true; });
  ipcMain.handle('native-mpv:diagnostics', async () => ({
    relay: relay.stats(), route, suppliedHeaderCount,
    mpvAvailable: Boolean(mpvExecutable()), helperAvailable: Boolean(helperExecutable()),
    pid: lastPid, active: Boolean(child && child.exitCode == null), hostMode,
    hostReady: Boolean(hostHelper && hostHelper.exitCode == null && hostHwnd),
    overlayReady: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayLoaded),
    overlayVisible: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),
    disposed
  }));

  ipcMain.handle('native-overlay:state', async () => state());
  ipcMain.handle('native-overlay:command', async (_event, command) => allowedCommand(command));
  ipcMain.handle('native-overlay:action', async (_event, action) => overlayAction(String(action || '')));
  ipcMain.handle('native-overlay:meta', async () => overlayMeta());
  ipcMain.handle('native-overlay:diagnostics', async () => ({
    diagnosticVersion: 'V12-overlay',
    state: await state(),
    route,
    suppliedHeaderCount,
    hostMode,
    hostReady: Boolean(hostHelper && hostHelper.exitCode == null && hostHwnd),
    overlayReady: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayLoaded),
    overlayVisible: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible())
  }));

  const subtitleListener = (event, value) => {
    if (!attachedWindow || attachedWindow.isDestroyed() || event.sender !== attachedWindow.webContents) return;
    const text = String(value?.text || '').slice(0, 12000);
    const style = value?.style && typeof value.style === 'object' ? value.style : {};
    overlaySend('native-overlay:subtitle', { text, style });
  };
  const reportListener = (event, value) => {
    if (!attachedWindow || attachedWindow.isDestroyed() || event.sender !== attachedWindow.webContents) return;
    overlaySend('native-overlay:report', value && typeof value === 'object' ? value : {});
  };
  ipcMain.on('native-overlay:subtitle', subtitleListener);
  ipcMain.on('native-overlay:report', reportListener);

  async function dispose() {
    if (disposed) return;
    disposed = true;
    listeners.splice(0).forEach(disposeListener => disposeListener());
    await closePlayer();
    await relay.close().catch(() => {});
    ipcMain.removeListener('native-overlay:subtitle', subtitleListener);
    ipcMain.removeListener('native-overlay:report', reportListener);
    for (const name of [
      'native-mpv:prepare','native-mpv:open','native-mpv:state','native-mpv:bounds','native-mpv:command','native-mpv:close','native-mpv:diagnostics',
      'native-overlay:state','native-overlay:command','native-overlay:action','native-overlay:meta','native-overlay:diagnostics'
    ]) { try { ipcMain.removeHandler(name); } catch {} }
    try { overlayWindow?.destroy(); } catch {}
    overlayWindow = null;
  }

  return { ensure, attachWindow, detachWindow, dispose };
}

module.exports = { createNativeMpvBridge };

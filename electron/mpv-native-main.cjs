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
  let hostWindow = null;
  let child = null;
  let pipeName = null;
  let disposed = false;
  let lastRelativeBounds = null;
  let requestId = 0;
  let generation = 0;
  let route = 'idle';
  let suppliedHeaderCount = 0;
  let lastPid = null;
  let listeners = [];

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

  function nativeHandleDecimal(win) {
    const raw = win.getNativeWindowHandle();
    if (raw.length >= 8 && process.arch === 'x64') return raw.readBigUInt64LE(0).toString();
    return String(raw.readUInt32LE(0));
  }

  function normalizeBounds(value = {}) {
    const n = key => Number(value?.[key]);
    return {
      x: Number.isFinite(n('x')) ? Math.round(n('x')) : 0,
      y: Number.isFinite(n('y')) ? Math.round(n('y')) : 0,
      width: Math.max(1, Number.isFinite(n('width')) ? Math.round(n('width')) : 1),
      height: Math.max(1, Number.isFinite(n('height')) ? Math.round(n('height')) : 1),
      visible: value?.visible !== false
    };
  }

  function screenBounds(relative) {
    if (!attachedWindow || attachedWindow.isDestroyed()) return null;
    const content = attachedWindow.getContentBounds();
    return {
      x: Math.round(content.x + relative.x),
      y: Math.round(content.y + relative.y),
      width: relative.width,
      height: relative.height
    };
  }

  function syncHostBounds() {
    if (!hostWindow || hostWindow.isDestroyed() || !lastRelativeBounds) return;
    const bounds = screenBounds(lastRelativeBounds);
    if (!bounds) return;
    try { hostWindow.setBounds(bounds, false); } catch {}
    const parentVisible = attachedWindow && !attachedWindow.isDestroyed() && attachedWindow.isVisible() && !attachedWindow.isMinimized();
    if (lastRelativeBounds.visible && parentVisible) {
      try { hostWindow.showInactive(); } catch { try { hostWindow.show(); } catch {} }
    } else {
      try { hostWindow.hide(); } catch {}
    }
  }

  function ensureHost(bounds) {
    if (!attachedWindow || attachedWindow.isDestroyed()) throw new Error('native mpv parent window is unavailable');
    lastRelativeBounds = normalizeBounds(bounds);
    if (!hostWindow || hostWindow.isDestroyed()) {
      hostWindow = new BrowserWindow({
        parent: attachedWindow,
        modal: false,
        show: false,
        frame: false,
        transparent: false,
        backgroundColor: '#000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: true,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      });
      hostWindow.setMenuBarVisibility(false);
      void hostWindow.loadURL('data:text/html,<meta charset="utf-8"><body style="margin:0;background:#000;overflow:hidden"></body>').catch(() => {});
      hostWindow.on('closed', () => { hostWindow = null; });
    }
    syncHostBounds();
    return hostWindow;
  }

  async function prepare(mediaUrl, suppliedHeaders = {}, hls = false) {
    const parsed = new URL(String(mediaUrl || ''));
    suppliedHeaderCount = Object.entries(suppliedHeaders || {}).filter(([, value]) => value != null && String(value).length).length;
    if (parsed.protocol === 'file:') {
      route = 'file-bypass';
      return { url: parsed.href, relayed: false };
    }
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      route = 'local-bypass';
      return { url: parsed.href, relayed: false };
    }
    if (parsed.protocol !== 'https:') throw new Error(`native mpv rejected protocol: ${parsed.protocol}`);
    const effective = typeof headersFor === 'function'
      ? headersFor(parsed, suppliedHeaders || {})
      : suppliedHeaders || {};
    route = 'relay';
    return relay.prepare(parsed.href, effective, { hls: Boolean(hls), userAgent });
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
        commands.forEach((command, index) => {
          socket.write(JSON.stringify({ command, request_id: ids[index] }) + '\n');
        });
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

  async function closePlayer({ destroyHost = false } = {}) {
    const oldChild = child;
    child = null;
    pipeName = null;
    lastPid = null;
    generation++;
    if (oldChild && oldChild.exitCode == null) {
      try { oldChild.kill(); } catch {}
    }
    if (hostWindow && !hostWindow.isDestroyed()) {
      try { hostWindow.hide(); } catch {}
      if (destroyHost) {
        try { hostWindow.destroy(); } catch {}
        hostWindow = null;
      }
    }
  }

  async function openPlayer(mediaUrl, suppliedHeaders, hls, bounds) {
    if (disposed) throw new Error('native mpv bridge is disposed');
    const executable = mpvExecutable();
    if (!executable) throw new Error('mpv executable was not found');
    const prepared = await prepare(mediaUrl, suppliedHeaders, hls);
    await closePlayer({ destroyHost: false });
    const host = ensureHost(bounds);
    const hwnd = nativeHandleDecimal(host);
    const myGeneration = generation;
    const safeId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pipeName = `\\\\.\\pipe\\LilacAnime-host-${safeId}`;
    const args = [
      '--no-config',
      '--force-window=yes',
      `--wid=${hwnd}`,
      `--input-ipc-server=${pipeName}`,
      '--hwdec=auto-safe',
      '--vo=gpu-next',
      '--gpu-api=d3d11',
      '--osc=yes',
      '--input-default-bindings=yes',
      '--keep-open=no',
      '--idle=yes',
      '--osd-level=1',
      '--cursor-autohide=1000',
      prepared.url
    ];
    child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
    lastPid = child.pid || null;
    child.once('exit', () => {
      if (generation !== myGeneration) return;
      child = null;
      pipeName = null;
      lastPid = null;
      if (hostWindow && !hostWindow.isDestroyed()) {
        try { hostWindow.hide(); } catch {}
      }
    });
    syncHostBounds();
    return { ok: true, pid: lastPid, route, relayed: Boolean(prepared.relayed) };
  }

  async function state() {
    const active = Boolean(child && child.exitCode == null && pipeName);
    if (!active) return { active: false, pid: lastPid, route };
    try {
      const replies = await connectAndBatch([
        ['get_property', 'time-pos'],
        ['get_property', 'duration'],
        ['get_property', 'pause'],
        ['get_property', 'volume'],
        ['get_property', 'video-params/w'],
        ['get_property', 'video-params/h'],
        ['get_property', 'video-codec'],
        ['get_property', 'container-fps'],
        ['get_property', 'vid'],
        ['get_property', 'aid']
      ], 700);
      const value = index => replies[index]?.error === 'success' ? replies[index].data : null;
      const numeric = index => {
        const number = Number(value(index));
        return Number.isFinite(number) ? number : null;
      };
      return {
        active: true,
        pid: lastPid,
        route,
        time: numeric(0),
        duration: numeric(1),
        paused: Boolean(value(2)),
        volume: numeric(3),
        width: numeric(4),
        height: numeric(5),
        codec: typeof value(6) === 'string' ? value(6) : null,
        fps: numeric(7),
        vid: value(8),
        aid: value(9)
      };
    } catch {
      return { active: true, pid: lastPid, route, time: null, duration: null, paused: null, width: null, height: null, codec: null, fps: null };
    }
  }

  function attachWindow(win) {
    attachedWindow = win;
    const add = (event, handler) => {
      win.on(event, handler);
      listeners.push(() => { try { win.off(event, handler); } catch {} });
    };
    add('move', syncHostBounds);
    add('resize', syncHostBounds);
    add('restore', syncHostBounds);
    add('show', syncHostBounds);
    add('minimize', () => { try { hostWindow?.hide(); } catch {} });
    add('hide', () => { try { hostWindow?.hide(); } catch {} });
    add('closed', () => { void closePlayer({ destroyHost: true }); attachedWindow = null; });
  }

  async function detachWindow(win) {
    if (attachedWindow !== win) return;
    listeners.splice(0).forEach(dispose => dispose());
    await closePlayer({ destroyHost: true });
    attachedWindow = null;
  }

  async function ensure() {
    if (disposed) throw new Error('native mpv bridge is disposed');
    return { available: Boolean(mpvExecutable()) };
  }

  ipcMain.handle('native-mpv:prepare', async (_event, mediaUrl, suppliedHeaders = {}, hls = false) => prepare(mediaUrl, suppliedHeaders, hls));
  ipcMain.handle('native-mpv:open', async (_event, mediaUrl, suppliedHeaders = {}, hls = false, bounds = {}) => openPlayer(mediaUrl, suppliedHeaders, Boolean(hls), bounds));
  ipcMain.handle('native-mpv:state', async () => state());
  ipcMain.handle('native-mpv:bounds', async (_event, bounds = {}) => { lastRelativeBounds = normalizeBounds(bounds); syncHostBounds(); return true; });
  ipcMain.handle('native-mpv:command', async (_event, command) => {
    if (!Array.isArray(command) || !command.length) throw new Error('invalid mpv command');
    const allowed = new Set(['set_property', 'seek', 'cycle', 'sub-add', 'sub-remove', 'stop']);
    if (!allowed.has(String(command[0]))) throw new Error('mpv command not allowed');
    try {
      const [reply] = await connectAndBatch([command], 900);
      return { ok: reply?.error === 'success', error: reply?.error || null, data: reply?.data ?? null };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle('native-mpv:close', async () => { await closePlayer({ destroyHost: false }); return true; });
  ipcMain.handle('native-mpv:diagnostics', async () => ({
    relay: relay.stats(),
    route,
    suppliedHeaderCount,
    mpvAvailable: Boolean(mpvExecutable()),
    pid: lastPid,
    active: Boolean(child && child.exitCode == null),
    hostVisible: Boolean(hostWindow && !hostWindow.isDestroyed() && hostWindow.isVisible()),
    disposed
  }));

  async function dispose() {
    if (disposed) return;
    disposed = true;
    listeners.splice(0).forEach(disposeListener => disposeListener());
    await closePlayer({ destroyHost: true });
    await relay.close().catch(() => {});
    for (const name of ['native-mpv:prepare','native-mpv:open','native-mpv:state','native-mpv:bounds','native-mpv:command','native-mpv:close','native-mpv:diagnostics']) {
      try { ipcMain.removeHandler(name); } catch {}
    }
  }

  return { ensure, attachWindow, detachWindow, dispose };
}

module.exports = { createNativeMpvBridge };

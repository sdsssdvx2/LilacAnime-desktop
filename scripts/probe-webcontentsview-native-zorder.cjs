'use strict';

const { app, BrowserWindow, WebContentsView, desktopCapturer } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const WIDTH = 640;
const HEIGHT = 360;
const TITLE = `LilacNativeLayerProbe-${process.pid}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nativeHandleDecimal(win) {
  const raw = win.getNativeWindowHandle();
  let value = 0n;
  for (let i = raw.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(raw[i]);
  return value.toString(10);
}

async function startHelper(win) {
  const helper = path.join(__dirname, '..', 'electron', 'win32-mpv-host.exe');
  const proc = spawn(helper, [nativeHandleDecimal(win)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('helper ready timeout')), 7000);
    proc.once('error', reject);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (/^READY host \d+$/.test(line.trim())) {
          clearTimeout(timer);
          resolve();
        }
        if (/^ERR /.test(line.trim())) {
          clearTimeout(timer);
          reject(new Error(line.trim()));
        }
      }
    });
  });
  proc.stdin.write(`B 0 0 ${WIDTH} ${HEIGHT} 1 0\n`);
  return proc;
}

function rgbAt(image, x, y) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const px = Math.max(0, Math.min(size.width - 1, x));
  const py = Math.max(0, Math.min(size.height - 1, y));
  const at = (py * size.width + px) * 4;
  return { b: bitmap[at], g: bitmap[at + 1], r: bitmap[at + 2], a: bitmap[at + 3] };
}

function isGreen(pixel) {
  return pixel.g > 150 && pixel.g > pixel.r * 1.7 && pixel.g > pixel.b * 1.7;
}
function isDark(pixel) {
  return pixel.r < 40 && pixel.g < 40 && pixel.b < 40;
}

async function captureWindow() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: WIDTH, height: HEIGHT },
    fetchWindowIcons: false
  });
  const source = sources.find(item => item.name === TITLE || item.name.includes(TITLE));
  if (!source || source.thumbnail.isEmpty()) throw new Error('desktopCapturer could not capture probe window');
  return source.thumbnail.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('probe is Windows-only');
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    frame: false,
    show: true,
    title: TITLE,
    backgroundColor: '#b00020',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL('data:text/html,<html><body style="margin:0;background:%23b00020;width:100vw;height:100vh"></body></html>');
  win.setTitle(TITLE);

  const overlay = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
  overlay.setBackgroundColor('#00000000');
  overlay.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  await overlay.webContents.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"><div style="position:absolute;left:24px;top:24px;width:120px;height:70px;background:#00e060"></div><div style="position:absolute;right:24px;bottom:24px;width:90px;height:50px;background:#00e060"></div></body></html>`));
  win.contentView.addChildView(overlay);

  const helper = await startHelper(win);
  // The raw helper deliberately calls SetWindowPos(HWND_TOP), matching the current mpv host behavior.
  // Re-add the WebContentsView afterwards as the strongest same-window layering attempt.
  win.contentView.removeChildView(overlay);
  win.contentView.addChildView(overlay);
  await sleep(1000);

  const capture = await captureWindow();
  const topControl = rgbAt(capture, 70, 55);
  const centerVideo = rgbAt(capture, 320, 180);
  const bottomControl = rgbAt(capture, 570, 310);
  const result = {
    topControlGreen: isGreen(topControl),
    centerNativeDark: isDark(centerVideo),
    bottomControlGreen: isGreen(bottomControl),
    topControl, centerVideo, bottomControl
  };
  console.log(`NATIVE_LAYER_PROBE ${JSON.stringify(result)}`);

  try { helper.stdin.write('Q\n'); } catch {}
  await sleep(100);
  try { helper.kill(); } catch {}
  overlay.webContents.close();
  win.destroy();

  if (!result.topControlGreen || !result.bottomControlGreen || !result.centerNativeDark) {
    throw new Error('WebContentsView did not compose above the full raw native child HWND');
  }
  console.log('NATIVE_LAYER_PROBE_OK same-window transparent WebContentsView composes above native child');
}

app.whenReady().then(main).then(() => app.quit()).catch(error => {
  console.error(`NATIVE_LAYER_PROBE_FAIL ${String(error?.message || error).replace(/https?:\/\/\S+/gi, '[url]')}`);
  process.exitCode = 1;
  app.quit();
});

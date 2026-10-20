'use strict';

const { app, BrowserWindow, WebContentsView } = require('electron');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 640;
const HEIGHT = 360;
const TITLE = `LilacD3D11LayerProbe-${process.pid}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidenceDir = path.resolve(process.env.LILAC_NATIVE_PROBE_OUTDIR || path.join(process.cwd(), 'native-layer-probe-evidence'));
const resultPath = path.join(evidenceDir, 'result.json');
const logPath = path.join(evidenceDir, 'probe.log');

fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(logPath, '', 'utf8');

const result = {
  schema: 4,
  probe: 'same-window-webcontentsview-d3d11-child',
  platform: process.platform,
  status: 'running',
  phaseA: null,
  phaseB: null,
  screenshots: {},
  screenshotErrors: [],
  error: null
};

function emit(line, isError = false) {
  const safe = String(line).replace(/https?:\/\/\S+/gi, '[url]');
  fs.appendFileSync(logPath, `${safe}\n`, 'utf8');
  (isError ? console.error : console.log)(safe);
}

function saveResult() {
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function nativeHandleDecimal(win) {
  const raw = win.getNativeWindowHandle();
  let value = 0n;
  for (let i = raw.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(raw[i]);
  return value.toString(10);
}

async function startD3DHelper(win) {
  const helper = path.join(__dirname, '..', 'electron', 'win32-d3d11-layer-probe.exe');
  const proc = spawn(helper, [nativeHandleDecimal(win)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => {
    const text = String(chunk).trim();
    if (text) emit(`D3D_HELPER_STDERR ${text}`, true);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('D3D11 helper ready timeout')), 10000);
    proc.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^READY host \d+$/.test(trimmed)) {
          clearTimeout(timer);
          resolve();
        } else if (/^ERR /.test(trimmed)) {
          clearTimeout(timer);
          reject(new Error(trimmed));
        }
      }
    });
  });
  return proc;
}

function sampleScreen(x, y) {
  const sampler = path.join(__dirname, '..', 'electron', 'win32-screen-pixel.exe');
  const output = execFileSync(sampler, [String(Math.round(x)), String(Math.round(y))], {
    windowsHide: true,
    encoding: 'utf8'
  }).trim();
  const match = /^PIXEL\s+(\d+)\s+(\d+)\s+(\d+)$/.exec(output);
  if (!match) throw new Error(`pixel sampler returned unexpected output: ${output.slice(0, 80)}`);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function captureDesktop(bounds, filename) {
  const outputPath = path.join(evidenceDir, filename);
  const quotedPath = outputPath.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$bmp = New-Object System.Drawing.Bitmap(${Math.round(bounds.width)}, ${Math.round(bounds.height)})`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    `$g.CopyFromScreen(${Math.round(bounds.x)}, ${Math.round(bounds.y)}, 0, 0, $bmp.Size)`,
    `$bmp.Save('${quotedPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose()',
    '$bmp.Dispose()'
  ].join('; ');
  const proc = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8'
  });
  if (proc.status !== 0 || !fs.existsSync(outputPath)) {
    const detail = String(proc.stderr || proc.stdout || `exit ${proc.status}`).trim().replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`desktop screenshot failed: ${detail}`);
  }
  return filename;
}

function tryCapture(bounds, key, filename) {
  try {
    result.screenshots[key] = captureDesktop(bounds, filename);
    emit(`NATIVE_LAYER_SCREENSHOT ${key} ${filename}`);
  } catch (error) {
    const message = String(error?.message || error);
    result.screenshotErrors.push({ phase: key, message });
    emit(`NATIVE_LAYER_SCREENSHOT_FAIL ${key} ${message}`, true);
  }
  saveResult();
}

function isBlue(pixel) {
  return pixel.b > 150 && pixel.b > pixel.r * 2.5 && pixel.b > pixel.g * 2.5;
}

function isGreen(pixel) {
  return pixel.g > 150 && pixel.g > pixel.r * 1.7 && pixel.g > pixel.b * 1.7;
}

function isRed(pixel) {
  return pixel.r > 120 && pixel.r > pixel.g * 2 && pixel.r > pixel.b * 2;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('probe is Windows-only');

  let win = null;
  let helper = null;
  let overlay = null;
  try {
    win = new BrowserWindow({
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
    win.show();
    win.focus();
    await sleep(300);

    helper = await startD3DHelper(win);
    await sleep(900);
    const bounds = win.getContentBounds();
    const point = (x, y) => [bounds.x + x, bounds.y + y];
    const [cx, cy] = point(WIDTH / 2, HEIGHT / 2);
    const [rx, ry] = point(10, 10);

    const nativeCenter = sampleScreen(cx, cy);
    const nativeCorner = sampleScreen(rx, ry);
    const phaseA = {
      centerNativeBlue: isBlue(nativeCenter),
      cornerNativeBlue: isBlue(nativeCorner),
      center: nativeCenter,
      corner: nativeCorner,
      centerRed: isRed(nativeCenter)
    };
    result.phaseA = phaseA;
    emit(`NATIVE_LAYER_PROBE_PHASE_A ${JSON.stringify(phaseA)}`);
    tryCapture(bounds, 'phaseA', 'phase-a.png');
    if (!phaseA.centerNativeBlue || !phaseA.cornerNativeBlue) {
      throw new Error(`real desktop did not observe D3D11 native child; centerRed=${phaseA.centerRed}`);
    }

    overlay = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
    overlay.setBackgroundColor('#00000000');
    overlay.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    await overlay.webContents.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"><div id="top" style="position:absolute;left:24px;top:24px;width:120px;height:70px;background:#00e060"></div><div id="bottom" style="position:absolute;right:24px;bottom:24px;width:90px;height:50px;background:#00e060"></div></body></html>`));
    win.contentView.addChildView(overlay);
    await sleep(900);

    const [tx, ty] = point(70, 55);
    const [bx, by] = point(570, 310);
    const topControl = sampleScreen(tx, ty);
    const centerVideo = sampleScreen(cx, cy);
    const bottomControl = sampleScreen(bx, by);
    const phaseB = {
      topControlGreen: isGreen(topControl),
      centerNativeBlue: isBlue(centerVideo),
      bottomControlGreen: isGreen(bottomControl),
      topControl,
      centerVideo,
      bottomControl
    };
    result.phaseB = phaseB;
    emit(`NATIVE_LAYER_PROBE_PHASE_B ${JSON.stringify(phaseB)}`);
    tryCapture(bounds, 'phaseB', 'phase-b.png');

    if (!phaseB.topControlGreen || !phaseB.bottomControlGreen || !phaseB.centerNativeBlue) {
      throw new Error('WebContentsView controls did not compose above a live D3D11 child while preserving native video pixels');
    }

    result.status = 'pass';
    saveResult();
    emit('NATIVE_LAYER_PROBE_OK D3D11 native child plus transparent WebContentsView controls composed on the real desktop');
  } finally {
    if (helper) {
      try { helper.stdin.write('Q\n'); } catch {}
      await sleep(120);
      try { helper.kill(); } catch {}
    }
    if (overlay) {
      try { overlay.webContents.close(); } catch {}
    }
    if (win && !win.isDestroyed()) win.destroy();
  }
}

saveResult();
app.whenReady().then(main).then(() => {
  saveResult();
  app.quit();
}).catch(error => {
  result.status = 'fail';
  result.error = String(error?.message || error).replace(/https?:\/\/\S+/gi, '[url]');
  saveResult();
  emit(`NATIVE_LAYER_PROBE_FAIL ${result.error}`, true);
  process.exitCode = 1;
  app.quit();
});

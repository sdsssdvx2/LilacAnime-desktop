'use strict';

const { app, BrowserWindow, WebContentsView, clipboard, dialog, screen } = require('electron');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WIDTH = 640;
const HEIGHT = 360;
const SMOKE = process.env.LILAC_NATIVE_LAYER_PROBE_SMOKE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nativeHandleDecimal(win) {
  const raw = win.getNativeWindowHandle();
  if (raw.length >= 8 && process.arch === 'x64') return raw.readBigUInt64LE(0).toString();
  return String(raw.readUInt32LE(0));
}

function findExisting(candidates) {
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function hostHelperPath() {
  return findExisting([
    path.join(process.resourcesPath || '', 'probe-native', 'win32-mpv-host.exe'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'win32-mpv-host.exe'),
    path.join(app.getAppPath(), 'electron', 'win32-mpv-host.exe'),
    path.join(__dirname, 'win32-mpv-host.exe')
  ]);
}

function pixelSamplerPath() {
  return findExisting([
    path.join(process.resourcesPath || '', 'probe-native', 'win32-screen-pixel.exe'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'win32-screen-pixel.exe'),
    path.join(app.getAppPath(), 'electron', 'win32-screen-pixel.exe'),
    path.join(__dirname, 'win32-screen-pixel.exe')
  ]);
}

function mpvExecutable() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'MPV Player', 'mpv.exe'),
    path.join(process.env.PROGRAMFILES || '', 'mpv', 'mpv.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
    path.join(process.resourcesPath || '', 'mpv', 'mpv.exe'),
    path.join(app.getAppPath(), 'bin', 'mpv.exe')
  ];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'mpv.exe'));
  }
  return findExisting(candidates);
}

function writeSolidBmp(file, width, height, r, g, b) {
  const rowBytes = width * 3;
  const stride = (rowBytes + 3) & ~3;
  const imageSize = stride * height;
  const buffer = Buffer.alloc(54 + imageSize);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(imageSize, 34);
  for (let y = 0; y < height; y++) {
    const row = 54 + y * stride;
    for (let x = 0; x < width; x++) {
      const at = row + x * 3;
      buffer[at] = b;
      buffer[at + 1] = g;
      buffer[at + 2] = r;
    }
  }
  fs.writeFileSync(file, buffer);
}

function isBlue(pixel) {
  return pixel && pixel.b > 120 && pixel.b > pixel.r * 1.6 && pixel.b > pixel.g * 1.6;
}

function isGreen(pixel) {
  return pixel && pixel.g > 140 && pixel.g > pixel.r * 1.5 && pixel.g > pixel.b * 1.5;
}

function isMagenta(pixel) {
  return pixel && pixel.r > 130 && pixel.b > 130 && pixel.g < Math.min(pixel.r, pixel.b) * 0.7;
}

function samplePixel(sampler, point) {
  const output = execFileSync(sampler, [String(Math.round(point.x)), String(Math.round(point.y))], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 3000
  }).trim();
  const match = /^PIXEL\s+(\d+)\s+(\d+)\s+(\d+)$/.exec(output);
  if (!match) throw new Error(`pixel sampler returned unexpected output: ${output.slice(0, 80)}`);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function screenPointFor(win, xDip, yDip) {
  const bounds = win.getContentBounds();
  const dip = { x: Math.round(bounds.x + xDip), y: Math.round(bounds.y + yDip) };
  try {
    return screen.dipToScreenPoint(dip);
  } catch {
    return dip;
  }
}

async function waitForHostReady(proc, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Win32 mpv host timeout${stderr ? `: ${stderr.slice(-160)}` : ''}`)), timeout);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        const match = /^READY\s+host\s+(\d+)$/.exec(line);
        if (match) return finish(null, match[1]);
        if (line.startsWith('ERR ')) return finish(new Error(`Win32 mpv host: ${line.slice(4)}`));
      }
    });
    proc.once('error', finish);
    proc.once('exit', code => finish(new Error(`Win32 mpv host exited (${code ?? 'unknown'})`)));
  });
}

function sendHostBounds(proc, widthPx, heightPx) {
  if (!proc?.stdin || proc.stdin.destroyed) return;
  proc.stdin.write(`B 0 0 ${widthPx} ${heightPx} 1 0\n`);
}

async function waitForBlue(sampler, win, timeout = 6500) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = samplePixel(sampler, screenPointFor(win, 320, 190));
    if (isBlue(last)) return last;
    await sleep(120);
  }
  return last;
}

function sendPhysicalClick(parentHwnd, point) {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  const script = [
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class LilacProbeInput {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);',
    '}',
    "'@",
    `[LilacProbeInput]::SetForegroundWindow([IntPtr]::new([Int64]${parentHwnd})) | Out-Null`,
    `[LilacProbeInput]::SetCursorPos(${x}, ${y}) | Out-Null`,
    'Start-Sleep -Milliseconds 100',
    '[LilacProbeInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero)',
    '[LilacProbeInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)'
  ].join("`n");
  const proc = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000
  });
  return { ok: proc.status === 0, exitCode: proc.status };
}

async function runSmoke() {
  let win = null;
  let overlay = null;
  try {
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      frame: false,
      show: false,
      backgroundColor: '#b00020',
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body style="margin:0;background:#b00020"></body></html>'));
    overlay = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
    if (typeof overlay.setBackgroundColor === 'function') overlay.setBackgroundColor('#00000000');
    overlay.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    await overlay.webContents.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><button id="b">x</button><script>window.n=0;b.onclick=()=>window.n++<\/script>'));
    win.contentView.addChildView(overlay);
    overlay.webContents.focus();
    overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8, movementX: 0, movementY: 0 });
    overlay.webContents.sendInputEvent({ type: 'mouseDown', x: 8, y: 8, button: 'left', clickCount: 1 });
    overlay.webContents.sendInputEvent({ type: 'mouseUp', x: 8, y: 8, button: 'left', clickCount: 1 });
    await sleep(100);
    const clicks = Number(await overlay.webContents.executeJavaScript('window.n', true)) || 0;
    return {
      schema: 4,
      probe: 'Lilac exact mpv host + WebContentsView local probe',
      smokeMode: true,
      status: clicks > 0 ? 'pass' : 'fail',
      verdict: clicks > 0 ? 'SMOKE-PASS' : 'SMOKE-FAIL',
      phaseSmoke: { webContentsViewClickHandler: clicks > 0 },
      error: clicks > 0 ? null : 'WebContentsView smoke input did not reach the click handler.'
    };
  } finally {
    if (overlay) { try { overlay.webContents.close(); } catch {} }
    if (win && !win.isDestroyed()) win.destroy();
  }
}

async function runProbe() {
  if (SMOKE) return runSmoke();
  if (process.platform !== 'win32') throw new Error('Windows 전용 진단입니다.');

  const helper = hostHelperPath();
  const sampler = pixelSamplerPath();
  const mpv = mpvExecutable();
  const result = {
    schema: 4,
    probe: 'Lilac exact mpv --wid host + WebContentsView + OS click',
    smokeMode: false,
    status: 'running',
    verdict: null,
    scaleFactor: null,
    mpvFound: Boolean(mpv),
    phaseA: null,
    phaseB: null,
    phaseBRefresh: null,
    phaseC: null,
    error: null
  };

  if (!helper) throw new Error('Win32 mpv host helper를 찾지 못했습니다.');
  if (!sampler) throw new Error('Win32 screen pixel helper를 찾지 못했습니다.');
  if (!mpv) {
    result.status = 'error';
    result.verdict = 'ERROR-MPV-NOT-FOUND';
    result.error = 'Lilac과 동일한 탐색 규칙으로 mpv.exe를 찾지 못했습니다.';
    return result;
  }

  let win = null;
  let overlay = null;
  let hostProc = null;
  let mpvProc = null;
  let refresh = null;
  const bmpPath = path.join(os.tmpdir(), `LilacNativeMpvProbe-${process.pid}.bmp`);

  try {
    writeSolidBmp(bmpPath, WIDTH, HEIGHT, 6, 64, 230);
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      frame: false,
      show: true,
      backgroundColor: '#b00020',
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body style="margin:0;background:#b00020;width:100vw;height:100vh;overflow:hidden"></body></html>'));
    win.show();
    win.focus();
    await sleep(350);

    const display = screen.getDisplayMatching(win.getBounds());
    const scale = Number(display?.scaleFactor) || 1;
    result.scaleFactor = scale;
    const widthPx = Math.max(1, Math.round(WIDTH * scale));
    const heightPx = Math.max(1, Math.round(HEIGHT * scale));

    hostProc = spawn(helper, [nativeHandleDecimal(win)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const hostHwnd = await waitForHostReady(hostProc, 10000);
    sendHostBounds(hostProc, widthPx, heightPx);

    const args = [
      '--no-config', '--force-window=yes', '--no-border', `--wid=${hostHwnd}`,
      '--hwdec=no', '--vo=gpu-next', '--gpu-api=d3d11', '--osc=no', '--input-default-bindings=no',
      '--keep-open=yes', '--idle=no', '--osd-level=0', '--cursor-autohide=always',
      '--loop-file=inf', '--image-display-duration=3600', '--really-quiet', bmpPath
    ];
    mpvProc = spawn(mpv, args, { windowsHide: true, stdio: 'ignore' });
    if (!mpvProc.pid) throw new Error('mpv process did not start.');

    const centerA = await waitForBlue(sampler, win, 7000);
    const cornerA = samplePixel(sampler, screenPointFor(win, 24, 64));
    result.phaseA = {
      center: centerA,
      corner: cornerA,
      centerMpvBlue: isBlue(centerA),
      cornerMpvBlue: isBlue(cornerA),
      mpvAlive: mpvProc.exitCode == null
    };
    if (!result.phaseA.centerMpvBlue || !result.phaseA.cornerMpvBlue) {
      result.status = 'fail';
      result.verdict = 'FAIL-A-MPV';
      result.error = '실제 Lilac 방식의 mpv --wid 렌더링이 probe 창의 실제 화면 픽셀에 나타나지 않았습니다.';
      return result;
    }

    overlay = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
    if (typeof overlay.setBackgroundColor === 'function') overlay.setBackgroundColor('#00000000');
    overlay.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden;font-family:Segoe UI,sans-serif">
      <button id="hit" style="position:absolute;left:60px;top:80px;width:140px;height:80px;border:0;border-radius:12px;background:#00e060;color:#001b0b;font-size:18px;font-weight:700">CLICK TEST</button>
      <div style="position:absolute;left:430px;top:240px;width:150px;height:70px;border-radius:12px;background:#00e060"></div>
      <script>window.__probeClicks=0;document.getElementById('hit').addEventListener('click',()=>{window.__probeClicks++;document.getElementById('hit').style.background='#e000e0';});<\/script>
    </body></html>`;
    await overlay.webContents.loadURL('data:text/html,' + encodeURIComponent(html));
    win.contentView.addChildView(overlay);
    await sleep(700);

    const readVisual = () => {
      const top = samplePixel(sampler, screenPointFor(win, 130, 120));
      const center = samplePixel(sampler, screenPointFor(win, 320, 190));
      const bottom = samplePixel(sampler, screenPointFor(win, 505, 275));
      return {
        top,
        center,
        bottom,
        topControlGreen: isGreen(top),
        centerMpvBlue: isBlue(center),
        bottomControlGreen: isGreen(bottom)
      };
    };

    result.phaseB = readVisual();
    if (!result.phaseB.topControlGreen || !result.phaseB.bottomControlGreen || !result.phaseB.centerMpvBlue) {
      result.status = 'fail';
      result.verdict = 'FAIL-B-COMPOSITION';
      result.error = 'mpv 영상층과 WebContentsView 컨트롤이 같은 창에서 동시에 보이지 않았습니다.';
      return result;
    }

    refresh = setInterval(() => {
      try { sendHostBounds(hostProc, widthPx, heightPx); } catch {}
    }, 200);
    await sleep(1100);
    result.phaseBRefresh = readVisual();
    clearInterval(refresh);
    refresh = null;
    if (!result.phaseBRefresh.topControlGreen || !result.phaseBRefresh.bottomControlGreen || !result.phaseBRefresh.centerMpvBlue) {
      result.status = 'fail';
      result.verdict = 'FAIL-B-ZORDER';
      result.error = '초기 합성은 됐지만 production식 HWND bounds/z-order 재적용 후 WebContentsView가 유지되지 않았습니다.';
      return result;
    }

    const target = screenPointFor(win, 130, 120);
    const clickAttempt = sendPhysicalClick(nativeHandleDecimal(win), target);
    await sleep(450);
    const clicks = Number(await overlay.webContents.executeJavaScript('window.__probeClicks', true)) || 0;
    const clickedPixel = samplePixel(sampler, target);
    result.phaseC = {
      clickInjectionProcessOk: clickAttempt.ok,
      osChromiumClickCount: clicks,
      clickedPixel,
      clickedControlMagenta: isMagenta(clickedPixel),
      osClickDelivered: clicks > 0
    };
    if (!clickAttempt.ok || clicks < 1) {
      result.status = 'fail';
      result.verdict = 'FAIL-C-INPUT';
      result.error = '화면 합성은 성공했지만 실제 Windows 마우스 클릭이 WebContentsView 버튼에 전달되지 않았습니다.';
      return result;
    }

    result.status = 'pass';
    result.verdict = 'PASS';
    return result;
  } catch (error) {
    result.status = 'error';
    result.verdict = 'ERROR';
    result.error = String(error?.message || error).replace(/https?:\/\/\S+/gi, '[url]');
    return result;
  } finally {
    if (refresh) clearInterval(refresh);
    if (mpvProc && mpvProc.exitCode == null) { try { mpvProc.kill(); } catch {} }
    if (hostProc) {
      try { hostProc.stdin?.write('Q\n'); } catch {}
      await sleep(100);
      try { if (hostProc.exitCode == null) hostProc.kill(); } catch {}
    }
    if (overlay) { try { overlay.webContents.close(); } catch {} }
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.unlinkSync(bmpPath); } catch {}
  }
}

function resultPath() {
  return process.env.LILAC_NATIVE_LAYER_PROBE_RESULT || path.join(os.tmpdir(), 'LilacNativeMpvLayerProbe-result.json');
}

app.whenReady().then(async () => {
  const result = await runProbe();
  const text = JSON.stringify(result, null, 2);
  try { fs.writeFileSync(resultPath(), `${text}\n`, 'utf8'); } catch {}

  if (SMOKE) {
    console.log(`LILAC_LOCAL_MPV_PROBE_SMOKE ${text}`);
    app.exit(result.verdict === 'SMOKE-PASS' ? 0 : 1);
    return;
  }

  clipboard.writeText(text);
  const messages = {
    PASS: 'PASS — 실제 mpv --wid 영상층 + WebContentsView 컨트롤 + 실제 Windows 클릭이 모두 성립했습니다.',
    'FAIL-A-MPV': 'FAIL-A-MPV — 실제 Lilac 방식의 mpv --wid 영상층이 이 probe 창에 나타나지 않았습니다.',
    'FAIL-B-COMPOSITION': 'FAIL-B-COMPOSITION — mpv는 보였지만 WebContentsView 컨트롤을 그 위에 함께 합성하지 못했습니다.',
    'FAIL-B-ZORDER': 'FAIL-B-ZORDER — 처음엔 합성됐지만 HWND z-order/bounds 재적용 후 컨트롤이 유지되지 않았습니다.',
    'FAIL-C-INPUT': 'FAIL-C-INPUT — 화면 합성은 됐지만 실제 Windows 클릭이 WebContentsView로 전달되지 않았습니다.',
    'ERROR-MPV-NOT-FOUND': 'ERROR-MPV-NOT-FOUND — Lilac과 같은 규칙으로 mpv.exe를 찾지 못했습니다.',
    ERROR: `ERROR — ${result.error || '알 수 없는 오류'}`
  };
  await dialog.showMessageBox({
    type: result.verdict === 'PASS' ? 'info' : 'warning',
    title: 'Lilac Native mpv Layer Probe',
    message: messages[result.verdict] || messages.ERROR,
    detail: '진단 JSON은 클립보드에 자동 복사되었습니다. 이 창을 닫은 뒤 ChatGPT 채팅에 그대로 붙여넣으면 됩니다.',
    buttons: ['확인'],
    defaultId: 0,
    noLink: true
  });
  app.quit();
}).catch(async error => {
  const fallback = JSON.stringify({ schema: 4, status: 'error', verdict: 'ERROR', error: String(error?.message || error) }, null, 2);
  try { fs.writeFileSync(resultPath(), `${fallback}\n`, 'utf8'); } catch {}
  if (SMOKE) {
    console.error(`LILAC_LOCAL_MPV_PROBE_SMOKE_ERROR ${fallback}`);
    app.exit(1);
    return;
  }
  clipboard.writeText(fallback);
  try { await dialog.showMessageBox({ type: 'error', title: 'Lilac Native mpv Layer Probe', message: '진단 실행 오류', detail: fallback, buttons: ['확인'] }); } catch {}
  app.quit();
});

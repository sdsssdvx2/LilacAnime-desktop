'use strict';

const { app, BrowserWindow, WebContentsView, clipboard, dialog, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WIDTH = 640;
const HEIGHT = 360;
const SMOKE = process.env.LILAC_NATIVE_LAYER_PROBE_SMOKE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isBlue(pixel) {
  return pixel && pixel.b > 150 && pixel.b > pixel.r * 2.3 && pixel.b > pixel.g * 2.3;
}

function isGreen(pixel) {
  return pixel && pixel.g > 150 && pixel.g > pixel.r * 1.7 && pixel.g > pixel.b * 1.7;
}

function nativeHandleDecimal(win) {
  const raw = win.getNativeWindowHandle();
  if (raw.length >= 8 && process.arch === 'x64') return raw.readBigUInt64LE(0).toString();
  return String(raw.readUInt32LE(0));
}

function probeHelperPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'probe-native', 'win32-d3d11-layer-probe.exe'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'win32-d3d11-layer-probe.exe'),
    path.join(app.getAppPath(), 'electron', 'win32-d3d11-layer-probe.exe'),
    path.join(__dirname, 'win32-d3d11-layer-probe.exe')
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function createLineProcess(executable, args) {
  const proc = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const waiters = [];
  const bufferedLines = [];

  function dispatch(line) {
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(line)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(line);
        return;
      }
    }
    bufferedLines.push(line);
    if (bufferedLines.length > 40) bufferedLines.shift();
  }

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (line) dispatch(line);
    }
  });

  proc.stderr.setEncoding('utf8');
  let stderr = '';
  proc.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  function waitFor(predicate, timeout = 6000) {
    const existingIndex = bufferedLines.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(bufferedLines.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        reject(new Error(`native helper response timeout${stderr ? `: ${stderr.trim().slice(0, 160)}` : ''}`));
      }, timeout);
      waiters.push(waiter);
    });
  }

  return { proc, waitFor };
}

function parseClickLine(line) {
  const sent = /^CLICK 1(?:\s|$)/.test(line);
  const value = key => {
    const match = new RegExp(`(?:^|\\s)${key} (-?\\d+)`).exec(line);
    return match ? Number(match[1]) : null;
  };
  const cursorMatch = /(?:^|\s)CUR (-?\d+) (-?\d+)/.exec(line);
  const targetMatch = /(?:^|\s)TARGET (-?\d+) (-?\d+)/.exec(line);
  return {
    rawAccepted: sent,
    foregroundRequestAccepted: value('FGREQ'),
    parentForeground: value('FG'),
    cursorSet: value('CURSET'),
    cursorRead: value('CURREAD'),
    cursor: cursorMatch ? { x: Number(cursorMatch[1]), y: Number(cursorMatch[2]) } : null,
    target: targetMatch ? { x: Number(targetMatch[1]), y: Number(targetMatch[2]) } : null
  };
}

async function runProbe() {
  if (process.platform !== 'win32') throw new Error('Windows 전용 진단입니다.');
  const helperPath = probeHelperPath();
  if (!helperPath) throw new Error('D3D11 probe helper를 찾지 못했습니다.');

  let win = null;
  let overlay = null;
  let native = null;
  const result = {
    schema: 3,
    probe: 'Lilac local same-window D3D11 + WebContentsView + OS click',
    smokeMode: SMOKE,
    status: 'running',
    verdict: null,
    scaleFactor: null,
    phaseA: null,
    phaseB: null,
    phaseC: null,
    error: null
  };

  try {
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      show: true,
      backgroundColor: '#b00020',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#121212', symbolColor: '#d0cdd6', height: 42 },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body style="margin:0;background:#b00020;width:100vw;height:100vh;overflow:hidden"></body></html>'));
    win.show();
    win.focus();
    await sleep(450);

    const display = screen.getDisplayMatching(win.getBounds());
    const scale = Number(display?.scaleFactor) || 1;
    result.scaleFactor = scale;
    const px = value => Math.round(value * scale);
    const widthPx = px(WIDTH);
    const heightPx = px(HEIGHT);

    native = createLineProcess(helperPath, [nativeHandleDecimal(win), String(widthPx), String(heightPx)]);
    await native.waitFor(line => /^READY host \d+(?: \d+ \d+)?$/.test(line), 10000);
    await sleep(700);

    const command = async (line, predicate, timeout = 5000) => {
      const pending = native.waitFor(predicate, timeout);
      native.proc.stdin.write(`${line}\n`);
      return pending;
    };
    const readPixel = async (xDip, yDip) => {
      const line = await command(`P ${px(xDip)} ${px(yDip)}`, value => /^PIXEL(?: |_)\S*/.test(value));
      const match = /^PIXEL (\d+) (\d+) (\d+)$/.exec(line);
      if (!match) throw new Error(`픽셀 판독 실패: ${line.slice(0, 80)}`);
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    };

    const centerA = await readPixel(320, 190);
    const cornerA = await readPixel(24, 64);
    result.phaseA = {
      center: centerA,
      corner: cornerA,
      centerNativeBlue: isBlue(centerA),
      cornerNativeBlue: isBlue(cornerA)
    };
    if (!SMOKE && (!result.phaseA.centerNativeBlue || !result.phaseA.cornerNativeBlue)) {
      result.status = 'fail';
      result.verdict = 'FAIL-A';
      result.error = '실제 화면에서 D3D11 native child를 확인하지 못했습니다.';
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
    await sleep(850);

    const topB = await readPixel(130, 120);
    const centerB = await readPixel(320, 190);
    const bottomB = await readPixel(505, 275);
    result.phaseB = {
      top: topB,
      center: centerB,
      bottom: bottomB,
      topControlGreen: isGreen(topB),
      centerNativeBlue: isBlue(centerB),
      bottomControlGreen: isGreen(bottomB)
    };
    const visualOk = result.phaseB.topControlGreen && result.phaseB.bottomControlGreen && (SMOKE || result.phaseB.centerNativeBlue);
    if (!visualOk) {
      result.status = 'fail';
      result.verdict = SMOKE ? 'SMOKE-FAIL-B' : 'FAIL-B';
      result.error = SMOKE
        ? 'CI smoke에서 WebContentsView 컨트롤 렌더링을 확인하지 못했습니다.'
        : 'native D3D11 화면과 WebContentsView 컨트롤이 같은 창에서 동시에 합성되지 않았습니다.';
      return result;
    }

    const clickLine = await command(`C ${px(130)} ${px(120)}`, value => /^CLICK [01](?:\s|$)/.test(value));
    await sleep(450);
    const osClickCount = Number(await overlay.webContents.executeJavaScript('window.__probeClicks', true)) || 0;
    const clickNative = parseClickLine(clickLine);
    const osClickDelivered = clickNative.rawAccepted && osClickCount > 0;

    let smokeInjectedCount = null;
    let smokeInputDelivered = null;
    if (SMOKE && !osClickDelivered) {
      try {
        overlay.webContents.focus();
        overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 130, y: 120, movementX: 0, movementY: 0 });
        overlay.webContents.sendInputEvent({ type: 'mouseDown', x: 130, y: 120, button: 'left', clickCount: 1 });
        overlay.webContents.sendInputEvent({ type: 'mouseUp', x: 130, y: 120, button: 'left', clickCount: 1 });
        await sleep(250);
        smokeInjectedCount = Number(await overlay.webContents.executeJavaScript('window.__probeClicks', true)) || 0;
        smokeInputDelivered = smokeInjectedCount > osClickCount;
      } catch {
        smokeInjectedCount = osClickCount;
        smokeInputDelivered = false;
      }
    }

    result.phaseC = {
      native: clickNative,
      osChromiumClickCount: osClickCount,
      osClickDelivered,
      smokeInjectedCount,
      smokeInputDelivered
    };

    if ((!SMOKE && !osClickDelivered) || (SMOKE && !osClickDelivered && !smokeInputDelivered)) {
      result.status = 'fail';
      result.verdict = SMOKE ? 'SMOKE-FAIL-C' : 'FAIL-C';
      result.error = SMOKE
        ? 'CI smoke에서 WebContentsView 클릭 핸들러까지 검증하지 못했습니다.'
        : '화면 합성은 성공했지만 실제 Windows 마우스 클릭이 WebContentsView에 전달되지 않았습니다.';
      return result;
    }

    result.status = 'pass';
    result.verdict = SMOKE ? 'SMOKE-PASS' : 'PASS';
    return result;
  } catch (error) {
    result.status = 'error';
    result.verdict = 'ERROR';
    result.error = String(error?.message || error).replace(/https?:\/\/\S+/gi, '[url]');
    return result;
  } finally {
    if (native?.proc) {
      try { native.proc.stdin.write('Q\n'); } catch {}
      await sleep(100);
      try { native.proc.kill(); } catch {}
    }
    if (overlay) {
      try { overlay.webContents.close(); } catch {}
    }
    if (win && !win.isDestroyed()) win.destroy();
  }
}

function resultPath() {
  return process.env.LILAC_NATIVE_LAYER_PROBE_RESULT || path.join(os.tmpdir(), 'LilacNativeLayerProbe-result.json');
}

app.whenReady().then(async () => {
  const result = await runProbe();
  const text = JSON.stringify(result, null, 2);
  try { fs.writeFileSync(resultPath(), `${text}\n`, 'utf8'); } catch {}

  if (SMOKE) {
    console.log(`LILAC_LOCAL_PROBE_SMOKE ${text}`);
    app.exit(result.verdict === 'SMOKE-PASS' ? 0 : 1);
    return;
  }

  clipboard.writeText(text);
  const messages = {
    PASS: 'PASS — native D3D11 영상층 + WebContentsView 컨트롤 + 실제 OS 클릭 전달이 모두 성립했습니다.',
    'FAIL-A': 'FAIL-A — 이 PC에서 probe의 native D3D11 child가 Electron 표면 위에 나타나지 않았습니다.',
    'FAIL-B': 'FAIL-B — native D3D11은 보였지만 WebContentsView 컨트롤을 그 위에 함께 합성하지 못했습니다.',
    'FAIL-C': 'FAIL-C — 화면 합성은 됐지만 실제 Windows 클릭이 WebContentsView로 전달되지 않았습니다.',
    ERROR: `ERROR — ${result.error || '알 수 없는 오류'}`
  };

  await dialog.showMessageBox({
    type: result.verdict === 'PASS' ? 'info' : 'warning',
    title: 'Lilac Native Layer Probe',
    message: messages[result.verdict] || messages.ERROR,
    detail: '진단 JSON은 클립보드에 자동 복사되었습니다. 이 창을 닫은 뒤 ChatGPT 채팅에 그대로 붙여넣으면 됩니다.',
    buttons: ['확인'],
    defaultId: 0,
    noLink: true
  });
  app.quit();
}).catch(async error => {
  const fallback = JSON.stringify({ schema: 3, status: 'error', verdict: 'ERROR', error: String(error?.message || error) }, null, 2);
  try { fs.writeFileSync(resultPath(), `${fallback}\n`, 'utf8'); } catch {}
  if (SMOKE) {
    console.error(`LILAC_LOCAL_PROBE_SMOKE_ERROR ${fallback}`);
    app.exit(1);
    return;
  }
  clipboard.writeText(fallback);
  try { await dialog.showMessageBox({ type: 'error', title: 'Lilac Native Layer Probe', message: '진단 실행 오류', detail: fallback, buttons: ['확인'] }); } catch {}
  app.quit();
});

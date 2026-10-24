const PARTITION = 'persist:lilac-miruro';
const ORIGINS = new Set(['https://www.miruro.to', 'https://www.miruro.tv', 'https://www.miruro.cx', 'https://www.miruro.bz']);

// A session.fetch request does not have the document context of Miruro's own
// requests. Keep a document in the same session and fetch from that origin.
function createMiruroBrowser({ BrowserWindow }) {
  const pages = new Map(), windows = new Set();
  async function page(origin) {
    if (pages.has(origin)) return pages.get(origin);
    const win = new BrowserWindow({ show: false, webPreferences: {
      partition: PARTITION, contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false
    } });
    windows.add(win);
    win.once('closed', () => windows.delete(win));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, address) => {
      if (new URL(address).origin !== origin) event.preventDefault();
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Miruro 페이지 연결 시간이 초과되었습니다.')), 25000);
      const cleanup = () => { clearTimeout(timer); win.webContents.removeListener('dom-ready', done); win.webContents.removeListener('did-fail-load', failed); win.removeListener('closed', closed); };
      const fail = error => { cleanup(); reject(error); };
      const done = () => { cleanup(); resolve(win); };
      const failed = (_, code, description, address, main) => { if (main && code !== -3) fail(new Error(`Miruro 페이지 연결 실패: ${description}`)); };
      const closed = () => fail(new Error('Miruro 요청 창이 닫혔습니다.'));
      win.webContents.once('dom-ready', done);
      win.webContents.on('did-fail-load', failed);
      win.once('closed', closed);
      win.loadURL(`${origin}/`).catch(fail);
    });
    pages.set(origin, ready);
    win.once('closed', () => { if (pages.get(origin) === ready) pages.delete(origin); });
    try { return await ready; }
    catch (error) { if (pages.get(origin) === ready) pages.delete(origin); if (!win.isDestroyed()) win.destroy(); throw error; }
  }
  async function request(address) {
    const url = new URL(address);
    if (!ORIGINS.has(url.origin) || !url.pathname.startsWith('/api/v1/')) throw new Error('허용되지 않은 Miruro API 주소입니다.');
    const win = await page(url.origin);
    const script = `(async()=>{
      if(location.origin!==${JSON.stringify(url.origin)})throw new Error('Miruro 페이지 주소가 변경되었습니다.');
      const r=await fetch(${JSON.stringify(url.href)},{credentials:'include',signal:AbortSignal.timeout(15000)});
      const bytes=new Uint8Array(await r.arrayBuffer());let text='';
      for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));
      return {status:r.status,headers:Array.from(r.headers.entries()),body:btoa(text)};
    })()`;
    let timer;
    try {
      const result = await Promise.race([
        win.webContents.mainFrame.executeJavaScript(script, true),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Miruro API 응답 시간이 초과되었습니다.')), 20000); })
      ]);
      return { response: { status: result.status, ok: result.status >= 200 && result.status < 300, headers: new Headers(result.headers) }, body: Buffer.from(result.body, 'base64') };
    } finally { clearTimeout(timer); }
  }
  request.close = () => { pages.clear(); for (const win of windows) if (!win.isDestroyed()) win.destroy(); windows.clear(); };
  return request;
}

module.exports = { createMiruroBrowser };

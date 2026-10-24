const PARTITION = 'persist:lilac-miruro';
const { createMiruroBrowser } = require('./miruro-browser.cjs');

function isChallenge(response, body) {
  return response.headers.get('cf-mitigated') === 'challenge' ||
    (/text\/html/i.test(response.headers.get('content-type') || '') &&
      /\/cdn-cgi\/challenge-platform\/|cf-chl-|Just a moment/i.test(body.toString('utf8')));
}

function isBlocked(response, body) {
  return response.status === 403 && /text\/html/i.test(response.headers.get('content-type') || '') &&
    /Sorry, you have been blocked|You are unable to access/i.test(body.toString('utf8'));
}

function createMiruroSession({ session, BrowserWindow, parent = () => null, requestTransport }) {
  let browserSession;
  const pending = new Map(), cooldowns = new Map();
  const stopped = message => Object.assign(new Error(message), { permanent: true });
  const blockedError = () => stopped('Miruro가 현재 접속을 Cloudflare로 차단했습니다. 인증으로 해제할 수 있는 화면이 아니므로 다른 소스를 선택하거나 잠시 후 다시 시도해 주세요.');
  const getSession = () => browserSession ||= session.fromPartition(PARTITION);
  const request = requestTransport || createMiruroBrowser({ BrowserWindow });
  function authenticate(url) {
    const origin = new URL(url).origin;
    if (pending.has(origin)) return pending.get(origin);
    const job = new Promise((resolve, reject) => {
      const owner = parent();
      const win = new BrowserWindow({
        title: 'Miruro — Cloudflare 인증을 완료해 주세요', width: 1000, height: 760,
        ...(owner && !owner.isDestroyed() ? { parent: owner } : {}),
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      let finished = false, checking = false;
      const finish = error => {
        if (finished) return;
        finished = true; clearInterval(timer); clearTimeout(deadline); clearTimeout(loadDeadline);
        getSession().removeListener('will-download', download);
        cooldowns.set(origin, Date.now() + 30000);
        if (!win.isDestroyed()) win.destroy();
        error ? reject(error) : resolve();
      };
      const check = async () => {
        if (finished || checking) return;
        checking = true;
        try {
          const result = await request(url);
          if (isBlocked(result.response, result.body)) { finish(blockedError()); return; }
          if (result.response.ok && !isChallenge(result.response, result.body)) finish();
        } catch {} finally { checking = false; }
      };
      const timer = setInterval(check, 5000);
      const deadline = setTimeout(() => finish(stopped('Miruro 인증 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.')), 180000);
      const loadDeadline = setTimeout(() => finish(stopped('Miruro 인증 페이지가 열리지 않습니다. 네트워크 연결을 확인하거나 다른 소스를 선택해 주세요.')), 30000);
      // Once verification succeeds the API may become a binary download. Do not
      // save it or leave an empty browser tab; verify it through the session instead.
      const download = (event, item, contents) => {
        if (contents !== win.webContents) return;
        event.preventDefault(); clearTimeout(loadDeadline); check();
      };
      getSession().on('will-download', download);
      win.on('closed', () => finish(stopped('Miruro 인증 창을 닫았습니다. 다시 시도해 주세요.')));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, target) => {
        if (new URL(target).origin !== origin) event.preventDefault();
      });
      win.webContents.on('did-finish-load', () => { clearTimeout(loadDeadline); check(); });
      win.webContents.on('did-fail-load', (_, code, description, address, isMainFrame) => {
        if (isMainFrame && code !== -3) finish(stopped(`Miruro 인증 페이지를 열지 못했습니다 (${description}). 다른 소스를 선택하거나 잠시 후 다시 시도해 주세요.`));
      });
      // The homepage can be accessible while only /api is challenged. Navigate
      // to the exact blocked request so the user sees the relevant challenge.
      win.loadURL(String(url)).catch(error => {
        if (!/ERR_ABORTED/.test(error.message)) finish(stopped(`Miruro 인증 페이지를 열지 못했습니다: ${error.message}`));
      });
    }).finally(() => pending.delete(origin));
    pending.set(origin, job);
    return job;
  }
  async function miruroRequest(url) {
    const origin = new URL(url).origin;
    if (pending.has(origin)) await pending.get(origin);
    let result = await request(url);
    if (isBlocked(result.response, result.body)) throw blockedError();
    if (isChallenge(result.response, result.body)) {
      if ((cooldowns.get(origin) || 0) > Date.now()) throw stopped('Miruro 인증이 아직 유효하지 않습니다. 잠시 후 다시 시도하거나 다른 소스를 선택해 주세요.');
      await authenticate(url);
      result = await request(url);
      if (isBlocked(result.response, result.body)) throw blockedError();
      if (isChallenge(result.response, result.body)) throw stopped('Miruro 보안 인증이 계속 요구됩니다. 다른 소스를 선택해 주세요.');
    }
    return result;
  }
  miruroRequest.close = () => request.close?.();
  return miruroRequest;
}

module.exports = { createMiruroSession, isChallenge, isBlocked };

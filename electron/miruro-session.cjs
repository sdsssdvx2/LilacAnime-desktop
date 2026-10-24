const PARTITION = 'persist:lilac-miruro';

function isChallenge(response, body) {
  return response.headers.get('cf-mitigated') === 'challenge' ||
    (/text\/html/i.test(response.headers.get('content-type') || '') &&
      /\/cdn-cgi\/challenge-platform\/|cf-chl-|Just a moment/i.test(body.toString('utf8')));
}

function createMiruroSession({ session, BrowserWindow, parent = () => null }) {
  let browserSession;
  const pending = new Map(), cooldowns = new Map();
  const stopped = message => Object.assign(new Error(message), { permanent: true });
  const getSession = () => browserSession ||= session.fromPartition(PARTITION);
  async function request(url) {
    const response = await getSession().fetch(String(url), {
      credentials: 'include', signal: AbortSignal.timeout(15000),
      headers: { Accept: '*/*', Referer: `${new URL(url).origin}/` }
    });
    return { response, body: Buffer.from(await response.arrayBuffer()) };
  }
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
        finished = true; clearInterval(timer); clearTimeout(deadline);
        cooldowns.set(origin, Date.now() + 30000);
        if (!win.isDestroyed()) win.destroy();
        error ? reject(error) : resolve();
      };
      const check = async () => {
        if (finished || checking) return;
        checking = true;
        try {
          const result = await request(url);
          if (result.response.ok && !isChallenge(result.response, result.body)) finish();
        } catch {} finally { checking = false; }
      };
      const timer = setInterval(check, 5000);
      const deadline = setTimeout(() => finish(stopped('Miruro 인증 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.')), 180000);
      win.on('closed', () => finish(stopped('Miruro 인증 창을 닫았습니다. 다시 시도해 주세요.')));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, target) => {
        if (new URL(target).origin !== origin) event.preventDefault();
      });
      win.webContents.on('did-finish-load', check);
      win.loadURL(`${origin}/`).catch(() => {});
    }).finally(() => pending.delete(origin));
    pending.set(origin, job);
    return job;
  }
  return async function miruroRequest(url) {
    const origin = new URL(url).origin;
    if (pending.has(origin)) await pending.get(origin);
    let result = await request(url);
    if (isChallenge(result.response, result.body)) {
      if ((cooldowns.get(origin) || 0) > Date.now()) throw stopped('Miruro 인증이 아직 유효하지 않습니다. 잠시 후 다시 시도하거나 다른 소스를 선택해 주세요.');
      await authenticate(url);
      result = await request(url);
      if (isChallenge(result.response, result.body)) throw stopped('Miruro 보안 인증이 계속 요구됩니다. 다른 소스를 선택해 주세요.');
    }
    return result;
  };
}

module.exports = { createMiruroSession, isChallenge };

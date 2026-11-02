export class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect({ timeoutMs = 2500, enableRuntime = true } = {}) {
    if (this.socket?.readyState === WebSocket.OPEN) return this;
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onOpen = () => finish(resolve);
      const onError = event => finish(reject, event?.error || new Error('CDP WebSocket connection failed'));
      const timer = setTimeout(() => {
        try { socket.close(); } catch {}
        finish(reject, new Error(`CDP WebSocket connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
    socket.addEventListener('message', event => this.#message(event.data));
    socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      this.listeners.clear();
    });
    if (enableRuntime) await this.send('Runtime.enable');
    return this;
  }

  #message(raw) {
    let message;
    try { message = JSON.parse(String(raw)); }
    catch { return; }
    if (!message.id) {
      const listeners = this.listeners.get(message.method);
      if (listeners) for (const listener of [...listeners]) {
        try { listener(message.params || {}); } catch {}
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'));
    else pending.resolve(message.result);
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => {
      const listeners = this.listeners.get(method);
      listeners?.delete(listener);
      if (listeners && !listeners.size) this.listeners.delete(method);
    };
  }

  send(method, params = {}, { timeoutMs = 4000 } = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = 4000 } = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: false
    }, { timeoutMs });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Runtime.evaluate failed';
      throw new Error(description);
    }
    return response.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

function headerEntries(original = {}, additions = {}, userAgent = '') {
  const merged = new Map();
  for (const [name, value] of Object.entries(original || {})) merged.set(name.toLowerCase(), { name, value: String(value) });
  for (const [name, value] of Object.entries(additions || {})) merged.set(name.toLowerCase(), { name, value: String(value) });
  if (userAgent) merged.set('user-agent', { name: 'User-Agent', value: String(userAgent) });
  return [...merged.values()];
}

function fetchPatternFor(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return url;
  }
}

export async function loadCdpNetworkResource(session, url, {
  headers = {},
  userAgent = '',
  timeoutMs = 8000,
  text = false
} = {}) {
  const protectedHeaders = { ...(headers || {}) };
  let removePaused = null;
  let fetchEnabled = false;
  if (Object.keys(protectedHeaders).length || userAgent) {
    removePaused = session.on('Fetch.requestPaused', params => {
      const requestUrl = String(params.request?.url || '');
      const matches = requestUrl === url;
      const nextHeaders = matches
        ? headerEntries(params.request?.headers, protectedHeaders, userAgent)
        : headerEntries(params.request?.headers);
      session.send('Fetch.continueRequest', { requestId: params.requestId, headers: nextHeaders }, { timeoutMs: 1500 }).catch(() => {});
    });
    await session.send('Fetch.enable', {
      patterns: [{ urlPattern: fetchPatternFor(url), requestStage: 'Request' }]
    }, { timeoutMs: 2000 });
    fetchEnabled = true;
  }

  const expression = `(async()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),${Math.max(1000, Number(timeoutMs) || 8000)});
    const started=performance.now();
    try{
      const response=await fetch(${JSON.stringify(url)},{cache:'no-store',credentials:'omit',signal:controller.signal});
      const headers=Object.fromEntries(response.headers.entries());
      if(!response.ok)return {ok:false,status:response.status,headers,totalMs:performance.now()-started};
      ${text
        ? "const body=await response.text();return {ok:true,status:response.status,headers,body,bytes:new TextEncoder().encode(body).byteLength,totalMs:performance.now()-started};"
        : "const body=await response.arrayBuffer();return {ok:true,status:response.status,headers,bytes:body.byteLength,totalMs:performance.now()-started};"}
    }catch(error){return {ok:false,status:0,error:String(error?.name||'Error')+': '+String(error?.message||error),totalMs:performance.now()-started}}
    finally{clearTimeout(timer)}
  })()`;

  try {
    const result = await session.evaluate(expression, { timeoutMs: timeoutMs + 1500 });
    const status = Number(result?.status || 0);
    if (!result?.ok) throw new Error(status ? `HTTP ${status}` : (result?.error || 'CDP renderer fetch failed'));
    const bytes = Number(result.bytes || 0);
    const totalMs = Number(result.totalMs || 0);
    return {
      body: text ? Buffer.from(String(result.body || ''), 'utf8') : Buffer.alloc(0),
      status,
      headers: result.headers || {},
      bytes,
      totalMs,
      mbps: bytes > 0 && totalMs > 0 ? (bytes * 8) / (totalMs / 1000) / 1_000_000 : 0
    };
  } finally {
    removePaused?.();
    if (fetchEnabled) await session.send('Fetch.disable', {}, { timeoutMs: 1500 }).catch(() => {});
  }
}

export async function discoverLilacTarget({ host = '127.0.0.1', port = 9223 } = {}) {
  const response = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`CDP discovery HTTP ${response.status}`);
  const targets = await response.json();
  const pages = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
  const lilac = pages.find(target => /lilac/i.test(`${target.title || ''} ${target.url || ''}`)) || pages[0];
  if (!lilac) throw new Error('No debuggable Lilac renderer found');
  return lilac;
}

export async function connectLilacCdp(options = {}) {
  const target = await discoverLilacTarget(options);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  return { session, target };
}

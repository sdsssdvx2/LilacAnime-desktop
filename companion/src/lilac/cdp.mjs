export class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return this;
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = event => { cleanup(); reject(event?.error || new Error('CDP WebSocket connection failed')); };
      const cleanup = () => { socket.removeEventListener('open', onOpen); socket.removeEventListener('error', onError); };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
    socket.addEventListener('message', event => this.#message(event.data));
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
    await this.send('Runtime.enable');
    return this;
  }

  #message(raw) {
    let message;
    try { message = JSON.parse(String(raw)); }
    catch { return; }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'));
    else pending.resolve(message.result);
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: false
    });
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

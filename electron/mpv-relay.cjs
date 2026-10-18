'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

function createMpvRelay() {
  let server = null;
  let port = 0;
  const resources = new Map();
  const tokens = new Map();

  function validate(value, base = null) {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== 'https:') throw new Error(`native mpv relay rejected protocol: ${url.protocol}`);
    if (url.username || url.password) throw new Error('native mpv relay rejected credential URL');
    return url;
  }

  function kindFor(url, fallback = 'resource') {
    return /\.m3u8(?:$|\?)/i.test(url.pathname + url.search) ? 'playlist' : fallback;
  }

  function register(value, kind, base, headers) {
    const url = validate(value, base);
    const actualKind = kindFor(url, kind);
    const headerKey = Object.keys(headers || {}).sort().join(',');
    const key = `${actualKind}:${url.href}:${headerKey}`;
    const known = tokens.get(key);
    if (known) return known;
    if (resources.size > 20000) {
      resources.clear();
      tokens.clear();
    }
    const token = crypto.randomBytes(18).toString('hex');
    resources.set(token, { url, kind: actualKind, headers: { ...(headers || {}) } });
    tokens.set(key, token);
    return token;
  }

  const localUrl = token => `http://127.0.0.1:${port}/r/${token}`;

  function stripPngTsWrapper(buffer) {
    const signature = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) return { buffer, stripped: false };
    const limit = Math.min(buffer.length, 64 * 1024);
    for (let offset = 8; offset + 376 < limit; offset++) {
      if (buffer[offset] === 0x47 && buffer[offset + 188] === 0x47 && buffer[offset + 376] === 0x47) {
        return { buffer: buffer.subarray(offset), stripped: true };
      }
    }
    return { buffer, stripped: false };
  }

  function rewritePlaylist(text, sourceUrl, headers) {
    return text.split(/\r?\n/).map(line => {
      if (!line) return line;
      if (!line.startsWith('#')) {
        const token = register(line, 'segment', sourceUrl, headers);
        return localUrl(token);
      }
      return line.replace(/URI=("([^"]+)"|'([^']+)')/g, (_all, quoted, doubleValue, singleValue) => {
        const value = doubleValue || singleValue || '';
        const kind = /\.m3u8(?:$|\?)/i.test(value) ? 'playlist' : 'resource';
        const token = register(value, kind, sourceUrl, headers);
        return `URI="${localUrl(token)}"`;
      });
    }).join('\n');
  }

  async function proxy(request, response) {
    try {
      if (!['GET','HEAD'].includes(request.method || '')) {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('method not allowed');
        return;
      }
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const match = requestUrl.pathname.match(/^\/r\/([a-f0-9]{36})$/);
      if (!match) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      const item = resources.get(match[1]);
      if (!item) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('invalid token');
        return;
      }

      const upstreamHeaders = { ...item.headers };
      if (request.headers.range && item.kind !== 'segment') upstreamHeaders.Range = request.headers.range;
      const upstream = await fetch(item.url.href, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: 'follow'
      });
      if (new URL(upstream.url).protocol !== 'https:') throw new Error('relay redirect left HTTPS');

      if (item.kind === 'playlist') {
        const source = await upstream.text();
        const body = rewritePlaylist(source, upstream.url || item.url.href, item.headers);
        response.writeHead(upstream.status, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store'
        });
        if (request.method === 'HEAD') response.end();
        else response.end(body);
        return;
      }

      if (item.kind === 'segment') {
        const raw = Buffer.from(await upstream.arrayBuffer());
        const normalized = stripPngTsWrapper(raw);
        const upstreamType = upstream.headers.get('content-type') || '';
        const type = normalized.stripped || /^image\//i.test(upstreamType) ? 'video/mp2t' : (upstreamType || 'application/octet-stream');
        response.writeHead(upstream.status, {
          'Content-Type': type,
          'Content-Length': normalized.buffer.length,
          'Cache-Control': 'no-store'
        });
        if (request.method === 'HEAD') response.end();
        else response.end(normalized.buffer);
        return;
      }

      const headers = {};
      for (const name of ['content-type','content-length','content-range','accept-ranges','last-modified','etag']) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      response.writeHead(upstream.status, headers);
      if (request.method === 'HEAD' || !upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('upstream relay error');
    }
  }

  async function ensureServer() {
    if (server && port) return;
    server = http.createServer(proxy);
    await new Promise((resolve, reject) => {
      const fail = error => { server?.off('listening', done); reject(error); };
      const done = () => { server?.off('error', fail); resolve(); };
      server.once('error', fail);
      server.once('listening', done);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('native mpv relay failed to bind loopback');
    port = address.port;
  }

  async function prepare(mediaUrl, headers = {}, options = {}) {
    const parsed = validate(mediaUrl);
    await ensureServer();
    const cleanHeaders = Object.fromEntries(Object.entries(headers || {}).filter(([key, value]) => key && value != null && String(value).length));
    if (options.userAgent && !Object.keys(cleanHeaders).some(key => key.toLowerCase() === 'user-agent')) {
      cleanHeaders['User-Agent'] = String(options.userAgent);
    }
    const kind = options.hls || /\.m3u8(?:$|\?)/i.test(parsed.pathname + parsed.search) ? 'playlist' : 'resource';
    const token = register(parsed.href, kind, null, cleanHeaders);
    return { url: localUrl(token), relayed: true };
  }

  async function close() {
    const active = server;
    server = null;
    port = 0;
    resources.clear();
    tokens.clear();
    if (!active) return;
    await new Promise(resolve => active.close(() => resolve()));
  }

  return { prepare, close };
}

module.exports = { createMpvRelay };

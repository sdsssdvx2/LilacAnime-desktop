'use strict';

const http = require('node:http');
const flix = require('../electron/flix-proxy.cjs');

const XOR_KEY = Buffer.from([157,42,241,71,179,142,92,112,166,25,228,59,216,98,15,197]);
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);

function encodedTsFixture() {
  const plain = Buffer.alloc(188 * 4);
  for (let i = 0; i < plain.length; i += 188) plain[i] = 0x47;
  const encoded = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) encoded[i] = plain[i] ^ XOR_KEY[i % XOR_KEY.length];
  return { plain, wrapped: Buffer.concat([PNG, encoded]) };
}

(async () => {
  const fixture = encodedTsFixture();
  let requests = 0;
  const upstream = http.createServer((req, res) => {
    requests += 1;
    if (req.url !== '/segment.webp') { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': fixture.wrapped.length,
      'cache-control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : fixture.wrapped);
  });
  await new Promise((resolve, reject) => upstream.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    const address = upstream.address();
    const target = `http://127.0.0.1:${address.port}/segment.webp`;
    const proxied = await flix.createFlixProxyUrl(target, Buffer.from('unused-key').toString('base64'), {});
    const parsed = new URL(proxied);
    if (parsed.hostname !== '127.0.0.1' || !parsed.pathname.startsWith('/__flix/')) throw new Error(`unexpected worker proxy URL ${proxied}`);

    const response = await fetch(proxied);
    if (!response.ok) throw new Error(`worker proxy HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.equals(fixture.plain)) throw new Error(`worker decoded payload mismatch got=${body.length} expected=${fixture.plain.length}`);
    if (body[0] !== 0x47 || body[188] !== 0x47 || body[376] !== 0x47) throw new Error('decoded MPEG-TS sync bytes missing');
    if (requests < 1) throw new Error('worker did not fetch upstream segment');

    const primed = await flix.primeFlix([]);
    if (Number(primed) !== 0) throw new Error(`unexpected empty prime result ${primed}`);
    console.log(`R32_FLIX_WORKER_SMOKE_OK rpc=real-loopback-segment decode=xor-webp-to-mpegts bytes=${body.length} upstreamRequests=${requests} primeEmpty=0`);
  } finally {
    try { flix.closeFlixProxy(); } catch {}
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

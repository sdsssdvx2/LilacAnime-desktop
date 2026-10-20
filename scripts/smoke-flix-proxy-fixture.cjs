'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { createFlixProxyUrl, closeFlixProxy } = require('../electron/flix-proxy.cjs');

function xorEncryptBase64(text, keyBytes) {
  const source = Buffer.from(text, 'utf8');
  const encrypted = Buffer.alloc(source.length);
  for (let i = 0; i < source.length; i++) encrypted[i] = source[i] ^ keyBytes[i % keyBytes.length];
  return encrypted.toString('base64');
}

function makeTsFixture() {
  const packetCount = 4;
  const ts = Buffer.alloc(188 * packetCount, 0xff);
  for (let packet = 0; packet < packetCount; packet++) {
    const at = packet * 188;
    ts[at] = 0x47;
    ts[at + 1] = 0x40;
    ts[at + 2] = packet & 0x1f;
    ts[at + 3] = 0x10;
  }
  return Buffer.concat([Buffer.from('RIFF0000WEBP', 'ascii'), ts]);
}

function rangeReply(req, res, body, contentType) {
  const value = String(req.headers.range || '');
  const match = /^bytes=(\d+)-(\d+)$/.exec(value);
  if (!match) {
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'accept-ranges': 'bytes'
    });
    res.end(body);
    return;
  }
  const start = Math.max(0, Math.min(body.length, Number(match[1]) || 0));
  const requestedEnd = Number(match[2]);
  const end = Math.max(start, Math.min(body.length - 1, Number.isFinite(requestedEnd) ? requestedEnd : body.length - 1));
  const slice = start < body.length ? body.subarray(start, end + 1) : Buffer.alloc(0);
  res.writeHead(206, {
    'content-type': contentType,
    'content-length': slice.length,
    'content-range': `bytes ${start}-${Math.max(start, end)}/${body.length}`,
    'accept-ranges': 'bytes'
  });
  res.end(slice);
}

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function main() {
  const key = Buffer.from('lilac-fixture-key', 'utf8');
  const pk = key.toString('base64');
  const segment = makeTsFixture();
  let manifestBody = null;

  const upstream = http.createServer((req, res) => {
    if (req.url === '/playlist.m3u8') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': manifestBody.length });
      res.end(manifestBody);
      return;
    }
    if (req.url === '/seg.webp') {
      rangeReply(req, res, segment, 'image/webp');
      return;
    }
    res.writeHead(404).end();
  });

  const upstreamPort = await listen(upstream);
  const manifestText = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:10.0,',
    `http://127.0.0.1:${upstreamPort}/seg.webp`,
    '#EXT-X-ENDLIST',
    ''
  ].join('\n');
  manifestBody = Buffer.from(xorEncryptBase64(manifestText, key), 'utf8');

  try {
    const proxyManifestUrl = await createFlixProxyUrl(`http://127.0.0.1:${upstreamPort}/playlist.m3u8`, pk, {});
    const manifestResponse = await fetch(proxyManifestUrl);
    assert.equal(manifestResponse.status, 200, 'proxy manifest status');
    const rewritten = await manifestResponse.text();
    assert.ok(rewritten.startsWith('#EXTM3U'), 'manifest decrypted');
    assert.ok(rewritten.includes('/__flix/'), 'manifest segment URL rewritten through proxy');
    assert.ok(!rewritten.includes(`127.0.0.1:${upstreamPort}/seg.webp`), 'raw upstream segment URL not left in manifest');

    const segmentUrl = rewritten.split(/\r?\n/).find(line => line && !line.startsWith('#'));
    assert.ok(segmentUrl, 'rewritten segment URL exists');
    const segmentResponse = await fetch(segmentUrl);
    assert.equal(segmentResponse.status, 200, 'proxy segment status');
    const decoded = Buffer.from(await segmentResponse.arrayBuffer());
    assert.equal(decoded.length, 188 * 4, 'wrapped image header removed');
    assert.equal(decoded[0], 0x47, 'first MPEG-TS sync byte');
    assert.equal(decoded[188], 0x47, 'second MPEG-TS sync byte');
    assert.equal(decoded[376], 0x47, 'third MPEG-TS sync byte');

    console.log('FLIX_FIXTURE_SMOKE_OK encrypted-manifest=decoded rewritten-segment=decoded-ts');
  } finally {
    closeFlixProxy();
    await new Promise(resolve => upstream.close(resolve));
  }
}

main().catch(error => {
  console.error(`FLIX_FIXTURE_SMOKE_FAIL ${String(error?.message || error).replace(/https?:\/\/\S+/gi, '[url]')}`);
  try { closeFlixProxy(); } catch {}
  process.exitCode = 1;
});

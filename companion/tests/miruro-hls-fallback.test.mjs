import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probeResolved } from '../src/source/scout.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('blocked HLS probe falls back to live playback evidence for the current source', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  const address = await listen(server);
  try {
    const value = await probeResolved({
      provider: 'miruro',
      mapping: 'current',
      mappingConfidence: 'high',
      stream: { url: `http://127.0.0.1:${address.port}/protected.m3u8` },
      live: {
        width: 1920,
        height: 1080,
        duration: 1400,
        bufferedAhead: 8,
        droppedVideoFrames: 0,
        totalVideoFrames: 1200
      }
    }, 1);

    assert.equal(value.kind, 'live');
    assert.equal(value.probe.liveFallback, true);
    assert.equal(value.probe.quality.height, 1080);
    assert.equal(value.probe.metrics.failureRate, 0);
    assert.match(value.note, /HLS probe blocked; using live playback \(HTTP 403\)/);
  } finally {
    await close(server);
  }
});

test('blocked HLS candidate without live playback evidence still fails', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  const address = await listen(server);
  try {
    await assert.rejects(
      () => probeResolved({
        provider: 'miruro',
        mapping: 'matched',
        mappingConfidence: 'high',
        stream: { url: `http://127.0.0.1:${address.port}/protected.m3u8` },
        live: null
      }, 1),
      /HTTP 403/
    );
  } finally {
    await close(server);
  }
});

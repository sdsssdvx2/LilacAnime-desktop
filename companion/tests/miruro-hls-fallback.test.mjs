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

test('blocked Miruro candidate is measured by the isolated browser fallback', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  const address = await listen(server);
  let browserCalls = 0;
  try {
    const value = await probeResolved({
      provider: 'miruro',
      mapping: 'matched',
      mappingConfidence: 'high',
      stream: { url: `http://127.0.0.1:${address.port}/protected.m3u8`, headers: { Referer: 'https://example.invalid/' } },
      live: null
    }, 1, {
      browserSession: { webSocketUrl: 'ws://127.0.0.1:9223/devtools/page/test' },
      browserHlsProbe: async (_session, url, options) => {
        browserCalls++;
        assert.match(url, /protected\.m3u8$/);
        assert.equal(options.headers.Referer, 'https://example.invalid/');
        return {
          quality: { width: 1920, height: 1080, codecs: 'avc1', bandwidth: 2_000_000, averageBandwidth: 1_800_000 },
          metrics: { expectedMbps: 1.8, minMbps: 20, avgMbps: 25, p95TtfbMs: null, failureRate: 0, stability: 100 },
          browserProbe: true
        };
      }
    });

    assert.equal(browserCalls, 1);
    assert.equal(value.kind, 'hls-browser');
    assert.equal(value.probe.browserProbe, true);
    assert.equal(value.probe.quality.height, 1080);
    assert.match(value.note, /Node HLS probe blocked; browser probe succeeded \(HTTP 403\)/);
  } finally {
    await close(server);
  }
});

test('blocked HLS candidate without live or browser playback evidence still fails', async () => {
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

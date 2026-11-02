import { inspectMedia } from './ffmpeg-media.mjs';

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function totalLength(headers) {
  const range = String(headers.get('content-range') || '').match(/\/(\d+)$/);
  if (range) return Number(range[1]) || null;
  const length = Number(headers.get('content-length') || 0);
  return length > 0 ? length : null;
}

async function sampleRange(url, { headers = {}, start = 0, bytes = 1024 * 1024, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestHeaders = { ...headers, Range: `bytes=${Math.max(0, Math.floor(start))}-${Math.max(0, Math.floor(start)) + bytes - 1}` };
  const started = performance.now();
  try {
    const response = await fetch(url, { headers: requestHeaders, signal: controller.signal, cache: 'no-store' });
    const headersAt = performance.now();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('response body unavailable');
    let received = 0;
    while (received < bytes) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value?.byteLength || 0;
      if (received >= bytes) {
        try { await reader.cancel(); } catch {}
        break;
      }
    }
    const ended = performance.now();
    return {
      ok: true,
      status: response.status,
      bytes: received,
      ttfbMs: headersAt - started,
      totalMs: ended - started,
      mbps: received > 0 && ended > headersAt ? (received * 8) / ((ended - headersAt) / 1000) / 1_000_000 : 0,
      totalLength: totalLength(response.headers),
      acceptRanges: /bytes/i.test(String(response.headers.get('accept-ranges') || '')) || response.status === 206
    };
  } finally { clearTimeout(timer); }
}

function positions(length, count, bytes) {
  if (!length || count <= 1) return [0];
  if (count === 2) return [0, Math.max(0, Math.floor(length * 0.55) - Math.floor(bytes / 2))];
  return [0, Math.max(0, Math.floor(length * 0.5) - Math.floor(bytes / 2)), Math.max(0, length - bytes - 1)].slice(0, count);
}

export async function probeDirect(url, {
  headers = {}, timeoutMs = 8000, sampleCount = 3, sampleBytes = 1024 * 1024,
  live = null
} = {}) {
  const samples = [];
  let length = null;
  try {
    const first = await sampleRange(url, { headers, start: 0, bytes: sampleBytes, timeoutMs });
    samples.push({ index: 0, start: 0, ...first });
    length = first.totalLength;
    const rest = positions(length, sampleCount, sampleBytes).slice(1);
    for (let i = 0; i < rest.length; i++) {
      try {
        const probe = await sampleRange(url, { headers, start: rest[i], bytes: sampleBytes, timeoutMs });
        samples.push({ index: i + 1, start: rest[i], ...probe });
      } catch (error) {
        samples.push({ index: i + 1, start: rest[i], ok: false, error: error?.message || String(error) });
      }
    }
  } catch (error) {
    samples.push({ index: 0, start: 0, ok: false, error: error?.message || String(error) });
  }

  let media = null;
  try { media = await inspectMedia(url, { headers, timeoutMs: Math.max(timeoutMs, 9000) }); } catch {}
  const success = samples.filter(sample => sample.ok);
  const throughputs = success.map(sample => sample.mbps).filter(Number.isFinite);
  const ttfb = success.map(sample => sample.ttfbMs).filter(Number.isFinite);
  const minMbps = throughputs.length ? Math.min(...throughputs) : null;
  const avgMbps = throughputs.length ? throughputs.reduce((sum, value) => sum + value, 0) / throughputs.length : null;
  const failureRate = samples.length ? (samples.length - success.length) / samples.length : 1;
  const duration = Number(media?.duration || live?.duration || 0) || null;
  const contentLength = length || success.find(sample => sample.totalLength)?.totalLength || null;
  const inferredBitrate = contentLength && duration ? Math.round(contentLength * 8 / duration) : null;
  const expectedMbps = Number(media?.bitrate || inferredBitrate || 0) / 1_000_000;
  let stability = 100;
  stability -= Math.round(failureRate * 65);
  const p95Ttfb = percentile(ttfb, 0.95);
  if (p95Ttfb != null) stability -= p95Ttfb > 3000 ? 25 : p95Ttfb > 1500 ? 15 : p95Ttfb > 700 ? 6 : 0;
  if (expectedMbps > 0 && minMbps != null) {
    const headroom = minMbps / expectedMbps;
    stability -= headroom < 1 ? 35 : headroom < 1.5 ? 20 : headroom < 2 ? 8 : 0;
  }
  if (Number(live?.bufferedAhead || 0) < 1.5 && Number(live?.readyState || 0) > 0) stability -= 8;
  const totalFrames = Number(live?.totalVideoFrames || 0);
  const droppedFrames = Number(live?.droppedVideoFrames || 0);
  if (totalFrames > 300 && droppedFrames / totalFrames > 0.02) stability -= 12;
  stability = Math.max(0, Math.min(100, stability));

  return {
    url,
    quality: {
      width: Number(media?.width || live?.width || 0) || null,
      height: Number(media?.height || live?.height || 0) || null,
      codecs: media?.codec || '',
      frameRate: Number(media?.frameRate || 0) || null,
      bandwidth: Number(media?.bitrate || inferredBitrate || 0) || null,
      averageBandwidth: Number(inferredBitrate || media?.bitrate || 0) || null,
      duration
    },
    samples,
    metrics: {
      expectedMbps: expectedMbps || null,
      minMbps,
      avgMbps,
      p95TtfbMs: p95Ttfb,
      failureRate,
      stability,
      contentLength,
      droppedVideoFrames: droppedFrames || null,
      totalVideoFrames: totalFrames || null
    }
  };
}

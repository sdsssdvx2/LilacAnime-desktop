function parseAttributes(text = '') {
  const out = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of text.matchAll(regex)) out[match[1]] = match[2].replace(/^"|"$/g, '');
  return out;
}

export function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(line => line.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributes(lines[i].slice('#EXT-X-STREAM-INF:'.length));
    const uri = lines.slice(i + 1).find(line => line && !line.startsWith('#'));
    if (!uri) continue;
    const resolution = String(attrs.RESOLUTION || '').match(/(\d+)x(\d+)/i);
    variants.push({
      url: new URL(uri, baseUrl).href,
      bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0),
      averageBandwidth: Number(attrs['AVERAGE-BANDWIDTH'] || 0),
      width: resolution ? Number(resolution[1]) : null,
      height: resolution ? Number(resolution[2]) : null,
      codecs: attrs.CODECS || '',
      frameRate: Number(attrs['FRAME-RATE'] || 0) || null
    });
  }
  return variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
}

export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(line => line.trim());
  const segments = [];
  let duration = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) { duration = Number(line.slice(8).split(',')[0]) || null; continue; }
    if (!line || line.startsWith('#')) continue;
    segments.push({ url: new URL(line, baseUrl).href, duration });
    duration = null;
  }
  return segments;
}

async function timedFetch(url, { headers = {}, timeoutMs = 8000, text = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
    const headersAt = performance.now();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = text ? await response.text() : Buffer.from(await response.arrayBuffer());
    const ended = performance.now();
    const bytes = text ? Buffer.byteLength(body) : body.length;
    return {
      body,
      status: response.status,
      bytes,
      ttfbMs: headersAt - started,
      totalMs: ended - started,
      mbps: bytes > 0 && ended > headersAt ? (bytes * 8) / ((ended - headersAt) / 1000) / 1_000_000 : 0
    };
  } finally { clearTimeout(timer); }
}

function sampleIndices(length, count) {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, i) => i);
  if (count <= 1) return [0];
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * (length - 1) / (count - 1))))];
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export async function probeHls(url, { headers = {}, timeoutMs = 8000, sampleCount = 3 } = {}) {
  const first = await timedFetch(url, { headers, timeoutMs, text: true });
  let playlistUrl = url, mediaText = first.body;
  const variants = parseMasterPlaylist(first.body, url);
  const chosen = variants[0] || null;
  let mediaProbe = first;
  if (chosen) {
    playlistUrl = chosen.url;
    mediaProbe = await timedFetch(chosen.url, { headers, timeoutMs, text: true });
    mediaText = mediaProbe.body;
  }
  const segments = parseMediaPlaylist(mediaText, playlistUrl);
  const duration = segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) || null;
  const samples = [];
  for (const index of sampleIndices(segments.length, sampleCount)) {
    const segment = segments[index];
    try {
      const probe = await timedFetch(segment.url, { headers, timeoutMs, text: false });
      samples.push({ index, duration: segment.duration, ok: true, ...probe, body: undefined });
    } catch (error) {
      samples.push({ index, duration: segment.duration, ok: false, error: error?.message || String(error) });
    }
  }
  const success = samples.filter(sample => sample.ok);
  const throughputs = success.map(sample => sample.mbps).filter(Number.isFinite);
  const ttfb = success.map(sample => sample.ttfbMs).filter(Number.isFinite);
  const expectedMbps = (chosen?.averageBandwidth || chosen?.bandwidth || 0) / 1_000_000;
  const minMbps = throughputs.length ? Math.min(...throughputs) : null;
  const avgMbps = throughputs.length ? throughputs.reduce((a, b) => a + b, 0) / throughputs.length : null;
  const failureRate = samples.length ? (samples.length - success.length) / samples.length : 1;
  let stability = 100;
  stability -= Math.round(failureRate * 65);
  const p95Ttfb = percentile(ttfb, 0.95);
  if (p95Ttfb != null) stability -= p95Ttfb > 3000 ? 25 : p95Ttfb > 1500 ? 15 : p95Ttfb > 700 ? 6 : 0;
  if (expectedMbps > 0 && minMbps != null) {
    const headroom = minMbps / expectedMbps;
    stability -= headroom < 1 ? 35 : headroom < 1.5 ? 20 : headroom < 2 ? 8 : 0;
  }
  stability = Math.max(0, Math.min(100, stability));
  return {
    url,
    playlistUrl,
    quality: {
      width: chosen?.width || null,
      height: chosen?.height || null,
      codecs: chosen?.codecs || '',
      frameRate: chosen?.frameRate || null,
      bandwidth: chosen?.bandwidth || null,
      averageBandwidth: chosen?.averageBandwidth || null,
      duration
    },
    manifest: { ttfbMs: first.ttfbMs, totalMs: first.totalMs },
    segmentCount: segments.length,
    samples,
    metrics: {
      expectedMbps: expectedMbps || null,
      minMbps,
      avgMbps,
      p95TtfbMs: p95Ttfb,
      failureRate,
      stability
    }
  };
}

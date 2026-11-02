import { loadCdpNetworkResource } from '../lilac/cdp.mjs';
import { parseMasterPlaylist, parseMediaPlaylist } from './hls-probe.mjs';

function sampleIndices(length, count) {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, index) => index);
  if (count <= 1) return [0];
  return [...new Set(Array.from({ length: count }, (_, index) => Math.round(index * (length - 1) / (count - 1))))];
}

function cleanHeaders(headers = {}) {
  const output = {};
  let userAgent = '';
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'user-agent') { userAgent = String(value); continue; }
    if (['host', 'content-length', 'connection'].includes(lower)) continue;
    output[key] = String(value);
  }
  return { headers: output, userAgent };
}

export async function probeHlsViaCdp(session, url, {
  headers = {},
  timeoutMs = 8000,
  sampleCount = 3
} = {}) {
  if (!session?.webSocketUrl) throw new Error('browser HLS probe requires a Lilac CDP session');
  const request = cleanHeaders(headers);
  const loadText = address => loadCdpNetworkResource(session, address, {
    ...request,
    timeoutMs,
    text: true
  });
  const loadBinary = address => loadCdpNetworkResource(session, address, {
    ...request,
    timeoutMs,
    text: false
  });

  const first = await loadText(url);
  const masterText = first.body.toString('utf8');
  const variants = parseMasterPlaylist(masterText, url);
  const chosen = variants[0] || null;
  let playlistUrl = url;
  let mediaText = masterText;
  if (chosen) {
    playlistUrl = chosen.url;
    const media = await loadText(chosen.url);
    mediaText = media.body.toString('utf8');
  }

  const segments = parseMediaPlaylist(mediaText, playlistUrl);
  if (!segments.length) throw new Error('browser HLS probe found no media segments');
  const duration = segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) || null;
  const samples = [];
  for (const index of sampleIndices(segments.length, sampleCount)) {
    const segment = segments[index];
    try {
      const loaded = await loadBinary(segment.url);
      samples.push({
        index,
        duration: segment.duration,
        ok: true,
        status: loaded.status,
        bytes: loaded.bytes,
        totalMs: loaded.totalMs,
        mbps: loaded.mbps
      });
    } catch (error) {
      samples.push({ index, duration: segment.duration, ok: false, error: error?.message || String(error) });
    }
  }

  const success = samples.filter(sample => sample.ok);
  const throughputs = success.map(sample => sample.mbps).filter(Number.isFinite);
  const expectedMbps = (chosen?.averageBandwidth || chosen?.bandwidth || 0) / 1_000_000;
  const minMbps = throughputs.length ? Math.min(...throughputs) : null;
  const avgMbps = throughputs.length ? throughputs.reduce((sum, value) => sum + value, 0) / throughputs.length : null;
  const failureRate = samples.length ? (samples.length - success.length) / samples.length : 1;
  let stability = 100 - Math.round(failureRate * 65);
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
    manifest: { ttfbMs: null, totalMs: first.totalMs },
    segmentCount: segments.length,
    samples,
    metrics: {
      expectedMbps: expectedMbps || null,
      minMbps,
      avgMbps,
      p95TtfbMs: null,
      failureRate,
      stability
    },
    browserProbe: true
  };
}

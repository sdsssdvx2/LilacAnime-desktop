import { animeAliases } from '../subtitles/matcher.mjs';
import { PROVIDERS, pickAnimeCandidate, pickEpisode } from './provider-map.mjs';
import { probeHls } from './hls-probe.mjs';
import { probeDirect } from './direct-probe.mjs';
import { compareVisualSources } from './visual-quality.mjs';

function streamHeaders(stream = {}) {
  const raw = stream.headers;
  const headers = (!raw || typeof raw !== 'object' || Array.isArray(raw))
    ? {}
    : Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
  if (stream.referer && !Object.keys(headers).some(key => key.toLowerCase() === 'referer')) headers.Referer = String(stream.referer);
  return headers;
}

async function resolveProviderEpisode(bridge, provider, context, aliases) {
  const wanted = context.episode.number;
  if (provider === context.episode.provider) {
    const stream = await bridge.prepareEpisodeStream(context.episode);
    return {
      provider,
      anime: context.anime,
      episode: context.episode,
      seriesEpisodes: Array.isArray(context.seriesEpisodes) ? context.seriesEpisodes : [],
      stream,
      live: context.playback || null,
      mapping: 'current',
      mappingConfidence: 'high'
    };
  }

  const queries = [...new Set([context.anime.title, context.anime.title_english, context.anime.romaji, ...aliases].filter(Boolean))].slice(0, 5);
  let candidates = [];
  for (const query of queries) {
    try {
      candidates = await bridge.searchProvider(provider, query);
      if (candidates.length) break;
    } catch {}
  }
  const picked = pickAnimeCandidate(animeAliases(context.anime, aliases), candidates, context.anime);
  if (!picked.selected) throw new Error(`anime mapping ${picked.confidence}`);
  const episodes = await bridge.providerEpisodes(provider, picked.selected);
  const episode = pickEpisode(episodes, wanted);
  if (!episode) throw new Error(`episode ${wanted} not found`);
  const stream = await bridge.prepareEpisodeStream(episode);
  if (!stream?.url) throw new Error('stream URL missing');
  return {
    provider,
    anime: picked.selected,
    episode,
    seriesEpisodes: episodes,
    stream,
    live: null,
    mapping: 'matched',
    mappingConfidence: picked.confidence
  };
}

function liveFallbackProbe(resolved) {
  const live = resolved.live || {};
  const height = Number(live.height || 0);
  if (!height) return null;
  const dropped = Number(live.droppedVideoFrames || 0);
  const total = Number(live.totalVideoFrames || 0);
  let stability = 82;
  if (Number(live.bufferedAhead || 0) >= 5) stability += 10;
  else if (Number(live.bufferedAhead || 0) < 1.5) stability -= 12;
  if (total > 300 && dropped / total > 0.02) stability -= 15;
  stability = Math.max(0, Math.min(100, stability));
  return {
    url: resolved.stream?.url || '',
    quality: {
      width: Number(live.width || 0) || null,
      height,
      codecs: '',
      frameRate: null,
      bandwidth: null,
      averageBandwidth: null,
      duration: Number(live.duration || 0) || null
    },
    samples: [],
    metrics: {
      expectedMbps: null,
      minMbps: null,
      avgMbps: null,
      p95TtfbMs: null,
      failureRate: 0,
      stability,
      droppedVideoFrames: dropped || null,
      totalVideoFrames: total || null
    },
    liveFallback: true
  };
}

async function probeResolved(resolved, sampleCount) {
  const url = resolved.stream?.url || '';
  if (!/^https?:\/\//i.test(url)) {
    const fallback = liveFallbackProbe(resolved);
    if (fallback) return { ...resolved, probe: fallback, kind: 'live' };
    throw new Error('unsupported stream URL');
  }
  const headers = streamHeaders(resolved.stream);
  if (/\.m3u8(?:$|\?)/i.test(url)) {
    const probe = await probeHls(url, { headers, sampleCount });
    if (!probe.quality?.height && resolved.live?.height) {
      probe.quality.width = resolved.live.width || probe.quality.width;
      probe.quality.height = resolved.live.height;
      probe.quality.duration = probe.quality.duration || resolved.live.duration || null;
    }
    return { ...resolved, probe, kind: 'hls' };
  }
  try {
    const probe = await probeDirect(url, { headers, sampleCount, live: resolved.live });
    if (!probe.quality?.height && resolved.live?.height) {
      probe.quality.width = resolved.live.width || probe.quality.width;
      probe.quality.height = resolved.live.height;
      probe.quality.duration = probe.quality.duration || resolved.live.duration || null;
    }
    return { ...resolved, probe, kind: 'direct' };
  } catch (error) {
    const fallback = liveFallbackProbe(resolved);
    if (fallback) return { ...resolved, probe: fallback, kind: 'live', note: `direct probe fallback: ${error?.message || error}` };
    throw error;
  }
}

export function rankSourceResults(results = []) {
  return results.map(item => {
    if (!item?.ok || !item.value) return { ...item, rankScore: -Infinity, stable: false };
    const probe = item.value.probe;
    if (!probe) return { ...item, rankScore: 0, stable: false };
    const metrics = probe.metrics || {}, quality = probe.quality || {};
    const stable = (metrics.stability ?? 0) >= 70 && (metrics.failureRate ?? 1) <= 0.34;
    const height = Number(quality.height || 0);
    const bandwidthMbps = Number(quality.averageBandwidth || quality.bandwidth || 0) / 1_000_000;
    const rankScore = (stable ? 1_000_000 : 0) + height * 1000 + bandwidthMbps * 10 + Number(metrics.stability || 0);
    return { ...item, rankScore, stable };
  }).sort((a, b) => b.rankScore - a.rankScore);
}

export function chooseBestSource(results = []) {
  const ranked = rankSourceResults(results);
  const usable = ranked.filter(item => item.ok && item.value?.probe);
  if (!usable.length) return { selected: null, reason: 'no-source', ranked };
  const stable = usable.filter(item => item.stable);
  const pool = stable.length ? [...stable] : [...usable];
  const best = pool[0];
  const next = pool[1];
  if (!best) return { selected: null, reason: 'no-source', ranked };

  const bq = best.value.probe?.quality || {}, nq = next?.value?.probe?.quality || {};
  const sameResolution = next && Number(bq.height || 0) === Number(nq.height || 0);
  const bBitrate = Number(bq.averageBandwidth || bq.bandwidth || 0);
  const nBitrate = Number(nq.averageBandwidth || nq.bandwidth || 0);
  const bitrateClose = sameResolution && bBitrate && nBitrate && Math.abs(bBitrate - nBitrate) / Math.max(bBitrate, nBitrate) < 0.08;
  if (bitrateClose) {
    pool.sort((a, b) => Number(b.value.probe?.metrics?.stability || 0) - Number(a.value.probe?.metrics?.stability || 0));
  }
  return { selected: pool[0]?.value || null, reason: stable.length ? 'stable-quality-first' : 'fallback-no-stable-source', ranked };
}

export function safeAutoSwitchDecision(scan, currentProvider) {
  const selected = scan?.decision?.selected || null;
  if (!selected) return { switch: false, reason: 'no-selection', selected: null };
  if (!selected.provider || selected.provider === currentProvider) return { switch: false, reason: 'already-best', selected };
  if (selected.mappingConfidence !== 'high') return { switch: false, reason: 'mapping-not-high-confidence', selected };

  const ranked = scan.decision?.ranked || rankSourceResults(scan.results || []);
  const bestItem = ranked.find(item => item.ok && item.value?.provider === selected.provider);
  const currentItem = ranked.find(item => item.ok && item.value?.provider === currentProvider);
  const bestProbe = bestItem?.value?.probe;
  const currentProbe = currentItem?.value?.probe;
  if (!bestProbe) return { switch: false, reason: 'selected-not-probed', selected };
  if (!currentProbe) return { switch: false, reason: 'current-not-probed', selected };

  const bestHeight = Number(bestProbe.quality?.height || 0);
  const currentHeight = Number(currentProbe.quality?.height || 0);
  const bestStable = Boolean(bestItem?.stable);
  const currentStable = Boolean(currentItem?.stable);
  const bestStability = Number(bestProbe.metrics?.stability || 0);

  if (!bestStable || bestStability < 80) return { switch: false, reason: 'winner-not-stable-enough', selected };

  if (bestHeight >= 720 && bestHeight >= currentHeight + 180) {
    return { switch: true, reason: 'clear-resolution-win', selected };
  }
  if (!currentStable && bestHeight >= currentHeight) {
    return { switch: true, reason: 'current-unstable', selected };
  }
  if (scan.visual?.confidence === 'high' && scan.visual?.selectedProvider === selected.provider && bestHeight === currentHeight) {
    return { switch: true, reason: 'visual-quality-win', selected };
  }
  return { switch: false, reason: scan.visual?.reason || 'same-resolution-needs-visual-compare', selected };
}

export async function scanSources(bridge, context, { sampleCount = 1, providers = PROVIDERS } = {}) {
  const aliases = await bridge.titleVariants(context.anime.title || context.anime.title_english || '').catch(() => []);
  const settled = await Promise.all(providers.map(async provider => {
    try {
      const resolved = await resolveProviderEpisode(bridge, provider, context, aliases);
      const value = await probeResolved(resolved, sampleCount);
      return { provider, ok: true, value };
    } catch (error) {
      return { provider, ok: false, error: error?.message || String(error) };
    }
  }));
  return { context, aliases, results: settled, decision: chooseBestSource(settled), visual: null };
}

export async function deepScanTop(bridge, quick, { count = 3, sampleCount = 3, visual = true } = {}) {
  const rankedQuick = rankSourceResults(quick.results).filter(item => item.ok && item.value);
  const providers = rankedQuick.slice(0, count).map(item => item.provider);
  const currentProvider = quick.context?.episode?.provider || '';
  if (currentProvider && !providers.includes(currentProvider)) providers.push(currentProvider);
  if (!providers.length) return quick;
  const context = quick.context;
  if (!context) throw new Error('quick scan context is required');
  const deep = await scanSources(bridge, context, { sampleCount, providers });

  let visualResult = null;
  let decision = deep.decision;
  if (visual) {
    const ranked = rankSourceResults(deep.results);
    const stable = ranked.filter(item => item.ok && item.stable && item.value?.probe);
    const bestHeight = Number(stable[0]?.value?.probe?.quality?.height || 0);
    const comparable = stable
      .filter(item => Number(item.value?.probe?.quality?.height || 0) === bestHeight)
      .slice(0, 3)
      .map(item => item.value);
    if (bestHeight > 0 && comparable.length >= 2) {
      try {
        visualResult = await compareVisualSources(comparable, { context, currentProvider, maxSources: 3 });
        if (visualResult?.confidence === 'high' && visualResult.selectedProvider) {
          const winner = ranked.find(item => item.ok && item.stable && item.value?.provider === visualResult.selectedProvider);
          if (winner?.value) decision = { ...deep.decision, selected: winner.value, reason: 'visual-quality-high-confidence' };
        }
      } catch (error) {
        visualResult = { available: false, confidence: 'none', reason: `visual-error:${error?.message || error}` };
      }
    }
  }
  return { ...deep, context, decision, visual: visualResult };
}

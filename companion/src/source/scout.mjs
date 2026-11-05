import { animeAliases } from '../subtitles/matcher.mjs';
import { PROVIDERS, pickAnimeCandidate, pickEpisode } from './provider-map.mjs';
import { probeHls } from './hls-probe.mjs';
import { probeHlsViaCdp } from './browser-hls-probe.mjs';
import { probeDirect } from './direct-probe.mjs';
import { compareVisualSources } from './visual-quality.mjs';
import {
  clearResolutionAdvantage,
  compareProbeQuality,
  decisiveBitrateQualityAdvantage,
  descriptiveQualityScore,
  visuallyComparableResolutions
} from './quality-policy.mjs';

const providerMappingCache = new Map();
const providerMappingCacheMs = 30 * 60 * 1000;
const providerMissCacheMs = 10 * 60 * 1000;

function compactIdentity(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\-_:·.,!?'"()[\]~]+/g, '');
}

function seriesMappingKey(provider, anime = {}) {
  const externalIdentity = Number(anime.anilistId || 0)
    ? `anilist:${Number(anime.anilistId)}`
    : Number(anime.malId || 0)
      ? `mal:${Number(anime.malId)}`
      : /^\d+$/.test(String(anime.mal_id || ''))
        ? `mal:${anime.mal_id}`
        : '';
  const fallbackIdentity = compactIdentity(anime.title_english || anime.romaji || anime.title || '');
  const identity = externalIdentity || (fallbackIdentity
    ? `${fallbackIdentity}|season:${String(anime.season || '')}|year:${String(anime.year || '')}`
    : '');
  return identity ? `${provider}|${identity}` : '';
}

function cachedProviderMapping(provider, anime) {
  const key = seriesMappingKey(provider, anime);
  if (!key) return null;
  const cached = providerMappingCache.get(key);
  if (!cached) return null;
  const ttl = cached.miss ? providerMissCacheMs : providerMappingCacheMs;
  if (Date.now() - Number(cached.at || 0) >= ttl) {
    providerMappingCache.delete(key);
    return null;
  }
  return cached;
}

function rememberProviderMapping(provider, anime, value) {
  const key = seriesMappingKey(provider, anime);
  if (!key) return;
  providerMappingCache.set(key, { at: Date.now(), ...value });
}

export function resetSourceMappingCacheForTests() {
  providerMappingCache.clear();
}

function streamHeaders(stream = {}) {
  const raw = stream.headers;
  const headers = (!raw || typeof raw !== 'object' || Array.isArray(raw))
    ? {}
    : Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
  if (stream.referer && !Object.keys(headers).some(key => key.toLowerCase() === 'referer')) headers.Referer = String(stream.referer);
  return headers;
}

async function searchProviderCandidates(bridge, provider, queries) {
  const groups = [];
  for (const batch of [queries.slice(0, 4), queries.slice(4, 6)]) {
    if (!batch.length) continue;
    const found = await Promise.all(batch.map(query => bridge.searchProvider(provider, query, { timeoutMs: 6000 }).catch(() => [])));
    for (const list of found) if (Array.isArray(list)) groups.push(...list);
    if (groups.length) break;
  }
  const unique = new Map();
  for (const item of groups) {
    const key = String(item?.id ?? item?.mal_id ?? item?.url ?? item?.title ?? JSON.stringify(item));
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

export async function resolveProviderEpisode(bridge, provider, context, aliases) {
  const wanted = context.episode.number;
  if (provider === context.episode.provider) {
    let stream = context.stream || {};
    const hasLiveEvidence = Boolean(stream.url || context.playback?.height || context.playback?.readyState >= 2);
    if (!hasLiveEvidence) stream = await bridge.prepareEpisodeStream(context.episode);
    const seriesEpisodes = Array.isArray(context.seriesEpisodes) ? context.seriesEpisodes : [];
    if (seriesEpisodes.length) rememberProviderMapping(provider, context.anime, {
      selected: context.anime,
      episodes: seriesEpisodes,
      confidence: 'high'
    });
    return {
      provider,
      anime: context.anime,
      episode: context.episode,
      seriesEpisodes,
      stream,
      live: context.playback || null,
      mapping: 'current',
      mappingConfidence: 'high'
    };
  }

  let picked = null;
  let episodes = null;
  const cached = cachedProviderMapping(provider, context.anime);
  if (cached?.miss) throw new Error(`anime mapping cached-${cached.confidence || 'none'}`);
  if (cached?.selected && Array.isArray(cached.episodes)) {
    picked = { selected: cached.selected, confidence: cached.confidence || 'high' };
    episodes = cached.episodes;
  } else {
    const queries = animeAliases(context.anime, aliases).slice(0, 10);
    const candidates = await searchProviderCandidates(bridge, provider, queries);
    picked = pickAnimeCandidate(animeAliases(context.anime, aliases), candidates, context.anime);
    if (!picked.selected) {
      rememberProviderMapping(provider, context.anime, { miss: true, confidence: picked.confidence || 'none' });
      throw new Error(`anime mapping ${picked.confidence}`);
    }
    episodes = await bridge.providerEpisodes(provider, picked.selected);
    rememberProviderMapping(provider, context.anime, {
      selected: picked.selected,
      episodes,
      confidence: picked.confidence
    });
  }

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
    mapping: cached ? 'cached' : 'matched',
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

export async function probeResolved(resolved, sampleCount, {
  browserSession = null,
  browserHlsProbe = probeHlsViaCdp
} = {}) {
  const url = resolved.stream?.url || '';
  if (!/^https?:\/\//i.test(url)) {
    const fallback = liveFallbackProbe(resolved);
    if (fallback) return { ...resolved, probe: fallback, kind: 'live', note: `live playback fallback for ${url ? 'non-http stream' : 'missing stream URL'}` };
    throw new Error('unsupported stream URL');
  }
  const headers = streamHeaders(resolved.stream);
  if (/\.m3u8(?:$|\?)/i.test(url)) {
    try {
      const probe = await probeHls(url, { headers, sampleCount });
      if (!probe.quality?.height && resolved.live?.height) {
        probe.quality.width = resolved.live.width || probe.quality.width;
        probe.quality.height = resolved.live.height;
        probe.quality.duration = probe.quality.duration || resolved.live.duration || null;
      }
      return { ...resolved, probe, kind: 'hls' };
    } catch (error) {
      if (resolved.provider === 'miruro' && browserSession && typeof browserHlsProbe === 'function') {
        try {
          const probe = await browserHlsProbe(browserSession, url, { headers, sampleCount });
          if (!probe.quality?.height && resolved.live?.height) {
            probe.quality.width = resolved.live.width || probe.quality.width;
            probe.quality.height = resolved.live.height;
            probe.quality.duration = probe.quality.duration || resolved.live.duration || null;
          }
          return { ...resolved, probe, kind: 'hls-browser', note: `Node HLS probe blocked; browser probe succeeded (${error?.message || error})` };
        } catch (browserError) {
          const fallback = liveFallbackProbe(resolved);
          if (fallback) return { ...resolved, probe: fallback, kind: 'live', note: `HLS probes blocked; using live playback (${error?.message || error}; browser: ${browserError?.message || browserError})` };
          throw browserError;
        }
      }
      const fallback = liveFallbackProbe(resolved);
      if (fallback) return { ...resolved, probe: fallback, kind: 'live', note: `HLS probe blocked; using live playback (${error?.message || error})` };
      throw error;
    }
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
  const ranked = results.map(item => {
    if (!item?.ok || !item.value) return { ...item, rankScore: -Infinity, stable: false };
    const probe = item.value.probe;
    if (!probe) return { ...item, rankScore: 0, stable: false };
    const metrics = probe.metrics || {};
    const stable = (metrics.stability ?? 0) >= 70 && (metrics.failureRate ?? 1) <= 0.34;
    const qualityScore = descriptiveQualityScore(probe);
    const rankScore = (stable ? 1_000_000 : 0) + qualityScore + Number(metrics.stability || 0);
    return { ...item, rankScore, stable, qualityScore };
  });

  return ranked.sort((a, b) => {
    if (a.stable !== b.stable) return a.stable ? -1 : 1;
    if (!a?.value?.probe && !b?.value?.probe) return 0;
    if (!a?.value?.probe) return 1;
    if (!b?.value?.probe) return -1;
    const quality = compareProbeQuality(a.value.probe, b.value.probe);
    if (quality) return quality;
    const stability = Number(b.value.probe?.metrics?.stability || 0) - Number(a.value.probe?.metrics?.stability || 0);
    if (Math.abs(stability) >= 3) return stability;
    return Number(b.rankScore || 0) - Number(a.rankScore || 0);
  });
}

export function chooseBestSource(results = []) {
  const ranked = rankSourceResults(results);
  const usable = ranked.filter(item => item.ok && item.value?.probe);
  if (!usable.length) return { selected: null, reason: 'no-source', ranked };
  const stable = usable.filter(item => item.stable);
  const pool = stable.length ? stable : usable;
  const best = pool[0];
  if (!best) return { selected: null, reason: 'no-source', ranked };
  return {
    selected: best.value || null,
    reason: stable.length ? 'stable-resolution-bitrate-quality' : 'fallback-no-stable-source',
    ranked
  };
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
  const currentStability = Number(currentProbe.metrics?.stability || 0);

  if (!bestStable || bestStability < 80) return { switch: false, reason: 'winner-not-stable-enough', selected };

  if (!currentStable && (!currentHeight || !bestHeight || bestHeight >= currentHeight)) {
    return { switch: true, reason: 'current-unstable', selected };
  }

  if (!bestHeight || !currentHeight) {
    return { switch: false, reason: 'quality-evidence-incomplete', selected };
  }

  if (clearResolutionAdvantage(bestProbe, currentProbe)) {
    return { switch: true, reason: 'clear-resolution-win', selected };
  }

  if (decisiveBitrateQualityAdvantage(bestProbe, currentProbe)) {
    return { switch: true, reason: 'decisive-bitrate-quality-win', selected };
  }

  const comparable = visuallyComparableResolutions(bestHeight, currentHeight);
  const currentHasDecisiveQualityEdge = clearResolutionAdvantage(currentProbe, bestProbe)
    || decisiveBitrateQualityAdvantage(currentProbe, bestProbe);
  if (comparable && !currentHasDecisiveQualityEdge
      && bestStability >= 95 && currentStability <= 85
      && bestStability - currentStability >= 12) {
    return { switch: true, reason: 'decisive-stability-win', selected };
  }

  if (scan.visual?.confidence === 'high'
      && scan.visual?.selectedProvider === selected.provider
      && comparable) {
    return { switch: true, reason: 'visual-quality-win', selected };
  }

  return {
    switch: false,
    reason: scan.visual?.reason || (comparable
      ? 'near-resolution-needs-visual-evidence'
      : 'quality-win-not-large-enough'),
    selected
  };
}

async function collectSourceAliases(bridge, anime = {}) {
  const seeds = animeAliases(anime, []).slice(0, 6);
  const output = new Set(seeds);
  const [variantGroups, resolved] = await Promise.all([
    Promise.all(seeds.slice(0, 4).map(seed => bridge.titleVariants(seed).catch(() => []))),
    bridge.resolveTitles([anime]).catch(() => [])
  ]);
  for (const group of variantGroups) for (const value of (Array.isArray(group) ? group : [])) output.add(value);
  for (const item of (Array.isArray(resolved) ? resolved : [])) {
    if (item?.ko) output.add(item.ko);
    if (item?.en) output.add(item.en);
  }
  return [...output].filter(Boolean);
}

async function mapLimit(values, limit, worker) {
  const list = [...values];
  const output = new Array(list.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      output[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length || 1) }, run));
  return output;
}

export async function scanSources(bridge, context, { sampleCount = 1, providers = PROVIDERS, concurrency = 2, aliases = null, includeCurrent = true } = {}) {
  const effectiveAliases = Array.isArray(aliases) && aliases.length ? aliases : await collectSourceAliases(bridge, context.anime);
  const currentProvider = String(context.episode?.provider || '');
  const ordered = [...new Set([...(includeCurrent ? [currentProvider] : []), ...providers].filter(Boolean))];
  const settledOrdered = await mapLimit(ordered, concurrency, async provider => {
    try {
      const resolved = await resolveProviderEpisode(bridge, provider, context, effectiveAliases);
      const value = await probeResolved(resolved, sampleCount, { browserSession: bridge.session || null });
      return { provider, ok: true, value };
    } catch (error) {
      return { provider, ok: false, error: error?.message || String(error) };
    }
  });
  const byProvider = new Map(settledOrdered.map(item => [item.provider, item]));
  const settled = [...new Set([...providers, ...(includeCurrent ? [currentProvider] : [])].filter(Boolean))]
    .map(provider => byProvider.get(provider))
    .filter(Boolean);
  return { context, aliases: effectiveAliases, results: settled, decision: chooseBestSource(settled), visual: null };
}

export function chooseDeepSourceProviders(quick, { count = 3, intensiveProviders = [], preferredProvider = '' } = {}) {
  const ranked = rankSourceResults(quick?.results || []).filter(item => item.ok && item.value);
  if (!ranked.length) return [];
  const bestHeight = Number(ranked[0].value?.probe?.quality?.height || 0);
  const intensive = new Set(intensiveProviders);
  // Focused sources get deep-scan preference only when quick evidence is reasonably
  // comparable to the best candidate. Never demote a clearly better normal source.
  const eligible = ranked.filter(item => intensive.has(item.provider) && item.stable &&
    (!bestHeight || Number(item.value?.probe?.quality?.height || 0) >= bestHeight * 0.90));
  const selected = [...new Set([...ranked.slice(0, 1), ...eligible, ...ranked].map(item => item.provider))]
    .slice(0, Math.max(1, count));
  // Respect an explicitly chosen anime provider even when its resolution is
  // lower. This is a deep *measurement*, not a forced quality verdict.
  if (preferredProvider && !selected.includes(preferredProvider) &&
      quick.results.some(item => item.provider === preferredProvider && item.ok && item.value?.probe)) {
    if (selected.length >= Math.max(1, count)) selected.pop();
    selected.push(preferredProvider);
  }
  return selected;
}

export async function deepScanTop(bridge, quick, { count = 3, sampleCount = 3, visual = true, intensiveProviders = [], preferredProvider = '', includeCurrent = true } = {}) {
  const providers = chooseDeepSourceProviders(quick, { count, intensiveProviders, preferredProvider });
  const currentProvider = quick.context?.episode?.provider || '';
  if (includeCurrent && currentProvider && !providers.includes(currentProvider)) providers.push(currentProvider);
  if (!providers.length) return quick;
  const context = quick.context;
  if (!context) throw new Error('quick scan context is required');
  const deep = await scanSources(bridge, context, { sampleCount, providers, concurrency: 2, aliases: quick.aliases, includeCurrent });

  let visualResult = null;
  let decision = deep.decision;
  if (visual) {
    const ranked = rankSourceResults(deep.results);
    const stable = ranked.filter(item => item.ok && item.stable && item.value?.probe);
    const anchorHeight = Number(stable[0]?.value?.probe?.quality?.height || 0);
    const comparable = stable
      .filter(item => {
        const height = Number(item.value?.probe?.quality?.height || 0);
        return anchorHeight > 0 && height > 0 && visuallyComparableResolutions(anchorHeight, height);
      })
      .slice(0, 3)
      .map(item => item.value);
    if (comparable.length >= 2) {
      try {
        visualResult = await compareVisualSources(comparable, { context, currentProvider, maxSources: 3, maxResolutionRatio: 1.18 });
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

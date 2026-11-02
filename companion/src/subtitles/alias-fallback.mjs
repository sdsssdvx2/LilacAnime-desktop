import path from 'node:path';
import { normalizeTitle, extractSeason, extractEpisodeKind } from '../normalize.mjs';
import { animeAliases } from './matcher.mjs';

const uniq = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
const GENERIC_DIRS = new Set([
  '자막', 'subtitle', 'subtitles', 'subs', 'download', 'downloads',
  'utility', 'program files', 'program files (x86)', 'programdata', 'users', 'temp', '팬자막'
]);

// Emergency offline fallback only. Normal resolution now asks Lilac's own catalog/search logic first.
const KNOWN_ALIAS_GROUPS = [
  ['Sword of Coming', 'Jian Lai', '剑来', '劍來', '검래']
];

function cleanGroupTitle(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/(?:^|\s)(?:19|20)\d{2}(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)(?:season|s)\s*0?\d{1,2}(?=\s|$)/ig, ' ')
    .replace(/(?:^|\s)\d{1,2}\s*기(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)(?:part|pt|파트)\s*0?\d{1,2}(?=\s|$)/ig, ' ')
    .replace(/(?:^|\s)(?:specials?|sp|ova|oad|스페셜|특별편|특별판|외전|번외편)(?=\s|$)/ig, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawGroupTitlesForFile(file = {}) {
  const dirname = path.dirname(String(file.path || ''));
  const pieces = dirname.split(/[\\/]+/).filter(Boolean).slice(-5).reverse();
  const raw = uniq([file.parent, file.grandparent, ...pieces]);
  return raw.filter(value => {
    const cleaned = cleanGroupTitle(value);
    const key = normalizeTitle(cleaned);
    if (!key || key.length < 2 || /^\d{1,3}$/.test(key)) return false;
    return !GENERIC_DIRS.has(String(value).toLowerCase()) && !GENERIC_DIRS.has(cleaned.toLowerCase());
  });
}

function groupTitlesForFile(file = {}) {
  return uniq(rawGroupTitlesForFile(file).map(cleanGroupTitle));
}

function contextFilters(anime = {}, episodeMeta = {}) {
  return {
    targetYear: Number(anime.year || 0) || null,
    targetSeason: Number(anime.companionSeasonNumber || 0) || extractSeason([anime.title, anime.title_english, anime.romaji, anime.title_japanese].filter(Boolean).join(' ')),
    targetKind: extractEpisodeKind([anime.title, anime.title_english, anime.romaji, anime.title_japanese, episodeMeta.name, episodeMeta.title, episodeMeta.kind, episodeMeta.type].filter(Boolean).join(' '))
  };
}

function fileCompatible(file, { targetYear, targetSeason, targetKind }) {
  if (targetYear && file.year && Number(file.year) !== targetYear) return false;
  if (targetSeason && file.season && Number(file.season) !== targetSeason) return false;
  if (targetKind !== 'main' && file.episodeKind && file.episodeKind !== 'main') {
    const special = new Set(['special', 'ova', 'oad']);
    if (!(special.has(targetKind) && special.has(file.episodeKind)) && file.episodeKind !== targetKind) return false;
  }
  return true;
}

function localGroupCandidates({ anime = {}, episode, episodeMeta = {}, files = [], limit = 10 } = {}) {
  const targetEpisode = Number(episode) || null;
  const filters = contextFilters(anime, episodeMeta);
  const groups = new Map();

  for (const file of files) {
    if (targetEpisode && file.episode != null && Number(file.episode) !== targetEpisode) continue;
    if (!fileCompatible(file, filters)) continue;

    for (const query of groupTitlesForFile(file)) {
      const key = normalizeTitle(query);
      const current = groups.get(key) || { query, parent: query, files: 0, score: 0 };
      current.files++;
      if (targetEpisode && Number(file.episode) === targetEpisode) current.score += 12;
      if (filters.targetYear && Number(file.year) === filters.targetYear) current.score += 18;
      if (filters.targetSeason && Number(file.season) === filters.targetSeason) current.score += 12;
      if (file.episodeKind && file.episodeKind !== 'main') current.score += filters.targetKind === 'main' ? -10 : 10;
      current.score += Math.min(12, current.files * 2);
      groups.set(key, current);
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.score - a.score || b.files - a.files || a.query.localeCompare(b.query, 'ko'))
    .slice(0, limit);
}

function localStructureGroups({ anime = {}, episodeMeta = {}, files = [], limit = 60 } = {}) {
  const filters = contextFilters(anime, episodeMeta);
  const groups = new Map();
  for (const file of files) {
    if (!fileCompatible(file, filters)) continue;
    for (const query of groupTitlesForFile(file)) {
      const key = normalizeTitle(query);
      const current = groups.get(key) || { query, files: 0, episodes: new Set(), seasons: new Set(), years: new Set() };
      current.files++;
      if (Number.isFinite(Number(file.episode)) && Number(file.episode) > 0) current.episodes.add(Number(file.episode));
      if (Number.isFinite(Number(file.season)) && Number(file.season) > 0) current.seasons.add(Number(file.season));
      if (Number.isFinite(Number(file.year)) && Number(file.year) >= 1900) current.years.add(Number(file.year));
      groups.set(key, current);
    }
  }
  return [...groups.values()]
    .map(item => ({ ...item, episodes: [...item.episodes].sort((a, b) => a - b), seasons: [...item.seasons], years: [...item.years] }))
    .sort((a, b) => b.files - a.files || a.query.localeCompare(b.query, 'ko'))
    .slice(0, limit);
}

function aliasesMatch(currentAliases, variants) {
  const current = new Set(currentAliases.map(normalizeTitle).filter(Boolean));
  return variants.some(value => current.has(normalizeTitle(value)));
}

function candidateAliases(candidate = {}) {
  const synonyms = Array.isArray(candidate.synonyms) ? candidate.synonyms : String(candidate.synonyms || '').split(/[,|]/);
  return uniq([candidate.title, candidate.title_english, candidate.title_japanese, candidate.romaji, ...synonyms]);
}

function candidateSeason(candidate = {}) {
  const direct = Number(candidate.seasonNumber || candidate.season_number || candidate.seasonIndex || 0);
  if (direct > 0) return direct;
  return extractSeason(candidateAliases(candidate).join(' '));
}

function sameIdentity(anime = {}, candidate = {}, currentAliases = []) {
  const currentAni = Number(anime.anilistId || 0) || null;
  const currentMal = Number(anime.malId || anime.mal_id || 0) || null;
  const candidateAni = Number(candidate.anilistId || candidate.anilist_id || 0) || null;
  const candidateMal = Number(candidate.malId || candidate.mal_id || 0) || null;
  if (currentAni && candidateAni && currentAni === candidateAni) return true;
  if (currentMal && candidateMal && currentMal === candidateMal) return true;
  return aliasesMatch(currentAliases, candidateAliases(candidate));
}

function knownAliasHit(currentAliases, query) {
  const current = new Set(currentAliases.map(normalizeTitle).filter(Boolean));
  const q = normalizeTitle(query);
  for (const group of KNOWN_ALIAS_GROUPS) {
    const normalized = group.map(normalizeTitle);
    if (!normalized.some(value => current.has(value))) continue;
    if (!normalized.includes(q)) continue;
    return group;
  }
  return [];
}

function episodeNumber(item = {}) {
  const direct = Number(item.number ?? item.episodeNumber ?? item.episode ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = [item.name, item.title, item.label].filter(Boolean).join(' ');
  const match = text.match(/(?:^|[^0-9])([0-9]{1,3})(?:[.]([0-9]+))?\s*(?:화|회|episode|ep\.?|$)/i);
  if (!match) return null;
  const value = Number(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function inferStructuralLocalAlias({ anime = {}, episode, episodeMeta = {}, files = [] } = {}) {
  const series = Array.isArray(anime.companionSeriesEpisodes) ? anime.companionSeriesEpisodes : [];
  const targetEpisodes = [...new Set(series.map(episodeNumber).filter(value => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
  if (targetEpisodes.length < 8) return null;
  const target = new Set(targetEpisodes);
  const currentEpisode = Number(episode) || null;
  const groups = localStructureGroups({ anime, episodeMeta, files, limit: 60 });
  const scored = groups.map(group => {
    const local = new Set(group.episodes || []);
    if (currentEpisode && !local.has(currentEpisode)) return null;
    if (local.size < 5) return null;
    const overlap = [...local].filter(value => target.has(value)).length;
    const coverage = overlap / target.size;
    const precision = overlap / local.size;
    const sizeDelta = Math.abs(local.size - target.size);
    const score = overlap * 5 + coverage * 140 + precision * 140 - sizeDelta * 3 + Math.min(20, group.files);
    return { ...group, overlap, coverage, precision, sizeDelta, structureScore: score };
  }).filter(Boolean).sort((a, b) => b.structureScore - a.structureScore || b.files - a.files);

  const best = scored[0] || null, second = scored[1] || null;
  if (!best) return null;
  const enough = best.overlap >= Math.min(8, target.size) && best.coverage >= 0.9 && best.precision >= 0.9;
  const unique = !second || best.structureScore - second.structureScore >= 30 || (best.coverage >= 0.98 && best.precision >= 0.98 && (second.coverage < 0.9 || second.precision < 0.9));
  if (!enough || !unique) return null;
  return {
    query: best.query,
    confidence: 'high',
    overlap: best.overlap,
    targetCount: target.size,
    localCount: best.episodes.length,
    coverage: best.coverage,
    precision: best.precision
  };
}

function seasonDirectoryCandidates({ anime = {}, episode, aliases = [], files = [], limit = 6 } = {}) {
  const currentAliases = animeAliases(anime, aliases);
  const current = new Set(currentAliases.map(normalizeTitle).filter(Boolean));
  const targetEpisode = Number(episode) || null;
  const groups = new Map();

  for (const file of files) {
    const season = Number(file.season || 0);
    if (!season) continue;
    if (targetEpisode && file.episode != null && Number(file.episode) !== targetEpisode) continue;
    for (const raw of rawGroupTitlesForFile(file)) {
      const rawSeason = extractSeason(raw);
      if (!rawSeason || Number(rawSeason) !== season) continue;
      const clean = cleanGroupTitle(raw);
      const cleanKey = normalizeTitle(clean);
      const known = knownAliasHit(currentAliases, clean);
      if (!current.has(cleanKey) && !known.length) continue;
      const key = `${cleanKey}|${season}|${normalizeTitle(raw)}`;
      const item = groups.get(key) || { query: raw, clean, season, files: 0, score: 0 };
      item.files++;
      if (targetEpisode && Number(file.episode) === targetEpisode) item.score += 20;
      item.score += Math.min(20, item.files * 2);
      groups.set(key, item);
    }
  }

  return [...groups.values()].sort((a, b) => b.score - a.score || a.season - b.season).slice(0, limit);
}

export async function inferLocalSeasonFromLilacSearch(bridge, {
  anime = {}, episode, episodeMeta = {}, aliases = [], files = []
} = {}) {
  const explicit = Number(anime.companionSeasonNumber || anime.seasonNumber || anime.season_number || anime.seasonIndex || 0)
    || extractSeason([anime.title, anime.title_english, anime.romaji, anime.title_japanese].filter(Boolean).join(' '));
  if (explicit) return explicit;

  const candidates = seasonDirectoryCandidates({ anime, episode, aliases, files });
  if (!candidates.length) return null;
  const currentAliases = animeAliases(anime, aliases);
  const provider = String(episodeMeta.provider || anime.provider || '').trim();
  if (!provider) return null;

  const hits = await Promise.all(candidates.map(async local => {
    try {
      const found = await bridge.searchProvider(provider, local.query, { timeoutMs: 5000 });
      for (const candidate of (Array.isArray(found) ? found : []).slice(0, 12)) {
        if (!sameIdentity(anime, candidate, currentAliases)) continue;
        const remoteSeason = candidateSeason(candidate);
        if (local.season > 1 && remoteSeason !== local.season) continue;
        if (remoteSeason && remoteSeason !== local.season) continue;
        return local.season;
      }
    } catch {}
    return null;
  }));

  const seasons = [...new Set(hits.filter(value => Number(value) > 0).map(Number))];
  if (seasons.length !== 1) return null;
  anime.companionSeasonNumber = seasons[0];
  return seasons[0];
}

async function providerSearchResolves(bridge, query, anime, currentAliases, providers = null, timeoutMs = 12000) {
  const providerList = providers || uniq([anime.provider, 'reanime', 'miruro', 'ohli24', 'linkani', 'animenosub', 'linkkf']).filter(Boolean).slice(0, 5);
  const batches = await Promise.all(providerList.map(async provider => {
    try { return await bridge.searchProvider(provider, query, { timeoutMs }); } catch { return []; }
  }));
  for (const found of batches) {
    for (const candidate of (Array.isArray(found) ? found : []).slice(0, 10)) {
      if (!sameIdentity(anime, candidate, currentAliases)) continue;
      return candidateAliases(candidate);
    }
  }
  return [];
}

export async function reverseResolveLocalAliases(bridge, {
  anime = {}, episode, episodeMeta = {}, aliases = [], files = [], maxQueries = 10
} = {}) {
  const currentAliases = animeAliases(anime, aliases);
  const candidates = localGroupCandidates({ anime, episode, episodeMeta, files, limit: maxQueries });

  const finalize = async values => {
    const resolved = uniq(values);
    if (!resolved.length) return resolved;
    await inferLocalSeasonFromLilacSearch(bridge, {
      anime,
      episode,
      episodeMeta,
      aliases: [...aliases, ...resolved],
      files
    }).catch(() => null);
    return resolved;
  };

  const currentProvider = String(episodeMeta.provider || anime.provider || '').trim();
  if (currentProvider) {
    const primaryHits = await Promise.all(candidates.slice(0, 4).map(async candidate => {
      const variants = await providerSearchResolves(bridge, candidate.query, anime, currentAliases, [currentProvider], 5000);
      return variants.length ? [candidate.query, ...variants] : [];
    }));
    const primaryResolved = uniq(primaryHits.flat());
    if (primaryResolved.length) return finalize(primaryResolved);
  }

  const structural = inferStructuralLocalAlias({ anime, episode, episodeMeta, files });
  if (structural?.query) return finalize([structural.query]);

  const variantHits = await Promise.all(candidates.map(async candidate => {
    try {
      const variants = await bridge.titleVariants(candidate.query);
      return Array.isArray(variants) && aliasesMatch(currentAliases, variants) ? [candidate.query, ...variants] : [];
    } catch { return []; }
  }));
  const variantResolved = uniq(variantHits.flat());
  if (variantResolved.length) return finalize(variantResolved);

  try {
    const requests = candidates.map((candidate, index) => ({
      provider: 'companion',
      id: `local-alias-${index}-${normalizeTitle(candidate.query)}`,
      title: candidate.query
    }));
    const results = await bridge.resolveTitles(requests);
    const resolved = [];
    for (const item of (Array.isArray(results) ? results : [])) {
      const values = uniq([item?.ko, item?.en]);
      if (!values.length || !aliasesMatch(currentAliases, values)) continue;
      const key = String(item?.key || '');
      const request = requests.find(entry => key.includes(String(entry.id)));
      if (request) resolved.push(request.title, ...values);
    }
    if (resolved.length) return finalize(resolved);
  } catch {}

  const known = [];
  for (const candidate of candidates) {
    const group = knownAliasHit(currentAliases, candidate.query);
    if (group.length) known.push(candidate.query, ...group);
  }
  if (known.length) return finalize(known);

  const providerHits = await Promise.all(candidates.slice(0, 3).map(async candidate => {
    const variants = await providerSearchResolves(bridge, candidate.query, anime, currentAliases);
    return variants.length ? [candidate.query, ...variants] : [];
  }));
  return finalize(providerHits.flat());
}

export function localAliasCandidates(input = {}) {
  return localGroupCandidates(input);
}

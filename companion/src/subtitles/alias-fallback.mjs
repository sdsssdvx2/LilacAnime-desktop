import path from 'node:path';
import { normalizeTitle, extractSeason, extractEpisodeKind } from '../normalize.mjs';
import { animeAliases } from './matcher.mjs';

const uniq = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
const GENERIC_DIRS = new Set(['자막', 'subtitle', 'subtitles', 'subs', 'download', 'downloads']);

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

function groupTitlesForFile(file = {}) {
  const dirname = path.dirname(String(file.path || ''));
  const pieces = dirname.split(/[\\/]+/).filter(Boolean).slice(-5).reverse();
  const raw = uniq([file.parent, file.grandparent, ...pieces]);
  return uniq(raw.map(cleanGroupTitle).filter(value => {
    const key = normalizeTitle(value);
    if (!key || key.length < 2 || /^\d{1,3}$/.test(key)) return false;
    return !GENERIC_DIRS.has(value.toLowerCase());
  }));
}

function localGroupCandidates({ anime = {}, episode, episodeMeta = {}, files = [], limit = 10 } = {}) {
  const targetEpisode = Number(episode) || null;
  const targetYear = Number(anime.year || 0) || null;
  const targetSeason = extractSeason([anime.title, anime.title_english, anime.romaji, anime.title_japanese].filter(Boolean).join(' '));
  const targetKind = extractEpisodeKind([anime.title, anime.title_english, anime.romaji, anime.title_japanese, episodeMeta.name, episodeMeta.title, episodeMeta.kind, episodeMeta.type].filter(Boolean).join(' '));
  const groups = new Map();

  for (const file of files) {
    if (targetEpisode && file.episode != null && Number(file.episode) !== targetEpisode) continue;
    if (targetYear && file.year && Number(file.year) !== targetYear) continue;
    if (targetSeason && file.season && Number(file.season) !== targetSeason) continue;
    if (targetKind !== 'main' && file.episodeKind && file.episodeKind !== 'main') {
      const special = new Set(['special', 'ova', 'oad']);
      if (!(special.has(targetKind) && special.has(file.episodeKind)) && file.episodeKind !== targetKind) continue;
    }

    for (const query of groupTitlesForFile(file)) {
      const key = normalizeTitle(query);
      const current = groups.get(key) || { query, parent: query, files: 0, score: 0 };
      current.files++;
      if (targetEpisode && Number(file.episode) === targetEpisode) current.score += 12;
      if (targetYear && Number(file.year) === targetYear) current.score += 18;
      if (targetSeason && Number(file.season) === targetSeason) current.score += 12;
      if (file.episodeKind && file.episodeKind !== 'main') current.score += targetKind === 'main' ? -10 : 10;
      current.score += Math.min(12, current.files * 2);
      groups.set(key, current);
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.score - a.score || b.files - a.files || a.query.localeCompare(b.query, 'ko'))
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

function sameIdentity(anime = {}, candidate = {}, currentAliases = []) {
  const currentAni = Number(anime.anilistId || 0) || null;
  const currentMal = Number(anime.malId || anime.mal_id || 0) || null;
  const candidateAni = Number(candidate.anilistId || candidate.anilist_id || 0) || null;
  const candidateMal = Number(candidate.malId || candidate.mal_id || 0) || null;
  if (currentAni && candidateAni && currentAni === candidateAni) return true;
  if (currentMal && candidateMal && currentMal === candidateMal) return true;
  return aliasesMatch(currentAliases, candidateAliases(candidate));
}

async function lilacResolvedAliases(bridge, query, currentAliases) {
  try {
    const id = `companion:${normalizeTitle(query)}`;
    const resolved = await bridge.resolveTitles([{ provider: 'companion', id, title: query }]);
    const values = uniq((Array.isArray(resolved) ? resolved : []).flatMap(item => [item?.ko, item?.en]));
    return aliasesMatch(currentAliases, values) ? values : [];
  } catch {
    return [];
  }
}

async function providerSearchResolves(bridge, query, anime, currentAliases) {
  const providers = uniq([anime.provider, 'reanime', 'miruro', 'linkkf', 'ohli24', 'linkani', 'animenosub']).filter(Boolean).slice(0, 7);
  for (const provider of providers) {
    let found = [];
    try { found = await bridge.searchProvider(provider, query); } catch {}
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
  const resolved = [];

  for (const candidate of candidates) {
    let variants = [];
    try { variants = await bridge.titleVariants(candidate.query); } catch {}
    if (Array.isArray(variants) && aliasesMatch(currentAliases, variants)) {
      resolved.push(candidate.query, ...variants);
      continue;
    }

    const displayAliases = await lilacResolvedAliases(bridge, candidate.query, currentAliases);
    if (displayAliases.length) {
      resolved.push(candidate.query, ...displayAliases);
      continue;
    }

    const providerAliases = await providerSearchResolves(bridge, candidate.query, anime, currentAliases);
    if (providerAliases.length) resolved.push(candidate.query, ...providerAliases);
  }

  return uniq(resolved);
}

export function localAliasCandidates(input = {}) {
  return localGroupCandidates(input);
}

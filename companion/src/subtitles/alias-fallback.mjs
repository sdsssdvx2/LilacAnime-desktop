import path from 'node:path';
import { normalizeTitle, extractSeason, extractYear, extractEpisodeKind } from '../normalize.mjs';
import { animeAliases } from './matcher.mjs';

const uniq = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];

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

function localGroupCandidates({ anime = {}, episode, episodeMeta = {}, files = [], limit = 8 } = {}) {
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

    const parent = String(file.parent || path.basename(path.dirname(file.path || '')) || '').trim();
    const query = cleanGroupTitle(parent);
    if (!query || query.length < 2) continue;
    const key = normalizeTitle(query);
    if (!key) continue;
    const current = groups.get(key) || { query, parent, files: 0, score: 0 };
    current.files++;
    if (targetEpisode && Number(file.episode) === targetEpisode) current.score += 12;
    if (targetYear && Number(file.year) === targetYear) current.score += 18;
    if (targetSeason && Number(file.season) === targetSeason) current.score += 12;
    if (file.episodeKind && file.episodeKind !== 'main') current.score += targetKind === 'main' ? -10 : 10;
    current.score += Math.min(12, current.files * 2);
    groups.set(key, current);
  }

  return [...groups.values()]
    .sort((a, b) => b.score - a.score || b.files - a.files || a.query.localeCompare(b.query, 'ko'))
    .slice(0, limit);
}

function aliasesMatch(currentAliases, variants) {
  const current = new Set(currentAliases.map(normalizeTitle).filter(Boolean));
  return variants.some(value => current.has(normalizeTitle(value)));
}

export async function reverseResolveLocalAliases(bridge, {
  anime = {}, episode, episodeMeta = {}, aliases = [], files = [], maxQueries = 8
} = {}) {
  const currentAliases = animeAliases(anime, aliases);
  const candidates = localGroupCandidates({ anime, episode, episodeMeta, files, limit: maxQueries });
  const resolved = [];

  for (const candidate of candidates) {
    let variants = [];
    try { variants = await bridge.titleVariants(candidate.query); } catch {}
    if (!Array.isArray(variants) || !variants.length) continue;
    if (!aliasesMatch(currentAliases, variants)) continue;
    resolved.push(candidate.query, candidate.parent, ...variants);
  }

  return uniq(resolved);
}

export function localAliasCandidates(input = {}) {
  return localGroupCandidates(input);
}

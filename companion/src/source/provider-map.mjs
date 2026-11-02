import { normalizeTitle, diceSimilarity, extractEpisode } from '../normalize.mjs';

export const PROVIDERS = ['linkkf', 'ohli24', 'linkani', 'animenosub', 'reanime', 'miruro'];

function values(candidate = {}) {
  const synonyms = Array.isArray(candidate.synonyms) ? candidate.synonyms : String(candidate.synonyms || '').split(/[,|]/);
  return [...new Set([
    candidate.title,
    candidate.title_english,
    candidate.title_japanese,
    candidate.romaji,
    candidate.name,
    ...synonyms
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

export function scoreAnimeCandidate(aliases = [], candidate = {}, target = {}) {
  let best = 0;
  for (const alias of aliases) {
    const a = normalizeTitle(alias);
    if (!a) continue;
    for (const name of values(candidate)) {
      const b = normalizeTitle(name);
      if (!b) continue;
      let score = 0;
      if (a === b) score = 300;
      else if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) {
        score = 185 + Math.round(70 * Math.min(a.length, b.length) / Math.max(a.length, b.length));
      } else {
        const similarity = diceSimilarity(a, b);
        if (similarity >= 0.94) score = 205;
        else if (similarity >= 0.88) score = 165;
        else if (similarity >= 0.80) score = 105;
      }
      best = Math.max(best, score);
    }
  }
  const targetYear = Number(target.year || 0), candidateYear = Number(candidate.year || candidate.season_year || 0);
  if (targetYear && candidateYear) best += targetYear === candidateYear ? 35 : -70;
  const targetType = String(target.type || '').toLowerCase(), candidateType = String(candidate.type || candidate.format || '').toLowerCase();
  if (targetType && candidateType && targetType === candidateType) best += 15;
  return best;
}

export function pickAnimeCandidate(aliases, candidates, target = {}) {
  const ranked = (candidates || []).map(candidate => ({ candidate, score: scoreAnimeCandidate(aliases, candidate, target) }))
    .sort((a, b) => b.score - a.score);
  const first = ranked[0] || null, second = ranked[1] || null;
  if (!first || first.score < 160) return { selected: null, confidence: 'none', ranked };
  const gap = first.score - (second?.score ?? -Infinity);
  const confidence = first.score >= 280 && gap >= 40 ? 'high' : first.score >= 210 && gap >= 20 ? 'medium' : 'low';
  return { selected: ['high', 'medium'].includes(confidence) ? first.candidate : null, confidence, ranked };
}

export function episodeNumber(episode = {}) {
  const direct = Number(episode.number || episode.episode || episode.ep || 0);
  if (direct > 0) return direct;
  return extractEpisode([episode.name, episode.title, episode.slug, episode.url].filter(Boolean).join(' '));
}

export function pickEpisode(episodes, wanted) {
  const number = Number(wanted);
  if (!number) return null;
  return (episodes || []).find(episode => episodeNumber(episode) === number) || null;
}

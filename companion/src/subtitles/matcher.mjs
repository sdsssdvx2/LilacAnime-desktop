import path from 'node:path';
import { normalizeTitle, diceSimilarity, extractSeason, extractPart } from '../normalize.mjs';

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

export function animeAliases(anime = {}, variants = []) {
  const synonyms = Array.isArray(anime.synonyms) ? anime.synonyms : String(anime.synonyms || '').split(/[,|]/);
  return unique([
    anime.title,
    anime.title_english,
    anime.title_japanese,
    anime.romaji,
    ...synonyms,
    ...variants
  ]);
}

function titleScore(aliases, hints) {
  let best = { score: 0, alias: '', hint: '', similarity: 0 };
  for (const alias of aliases) {
    const a = normalizeTitle(alias);
    if (!a) continue;
    for (const hint of hints) {
      const h = normalizeTitle(hint);
      if (!h) continue;
      let score = 0, similarity = 0;
      if (a === h) score = 250;
      else if (a.length >= 5 && h.length >= 5 && (a.includes(h) || h.includes(a))) {
        const ratio = Math.min(a.length, h.length) / Math.max(a.length, h.length);
        score = 150 + Math.round(ratio * 55);
      } else {
        similarity = diceSimilarity(a, h);
        if (similarity >= 0.92) score = 145;
        else if (similarity >= 0.86) score = 110;
        else if (similarity >= 0.78) score = 70;
      }
      if (score > best.score) best = { score, alias, hint, similarity };
    }
  }
  return best;
}

function inferCurrentSeason(anime = {}) {
  const explicit = Number(anime.seasonNumber || anime.season_number || anime.seasonIndex || 0);
  if (explicit > 0) return explicit;
  return extractSeason([anime.title, anime.title_english, anime.romaji, anime.title_japanese].filter(Boolean).join(' '));
}

function inferCurrentPart(anime = {}) {
  const explicit = Number(anime.part || anime.partNumber || 0);
  if (explicit > 0) return explicit;
  return extractPart([anime.title, anime.title_english, anime.romaji, anime.title_japanese].filter(Boolean).join(' '));
}

export function rankSubtitleFiles({ anime = {}, episode, aliases = [], files = [], manual = null } = {}) {
  const targetEpisode = Number(episode) || null;
  const targetSeason = inferCurrentSeason(anime);
  const targetPart = inferCurrentPart(anime);
  const names = animeAliases(anime, aliases);

  return files.map(file => {
    let score = 0;
    const reasons = [];
    const title = titleScore(names, file.titleHints || []);
    score += title.score;
    if (title.score) reasons.push(`title:${title.score}`);

    if (targetEpisode != null) {
      if (file.episode === targetEpisode) { score += 180; reasons.push('episode:exact'); }
      else if (file.episode == null) { score -= 35; reasons.push('episode:missing'); }
      else { score -= 420; reasons.push(`episode:mismatch:${file.episode}`); }
    }

    if (targetSeason != null) {
      if (file.season === targetSeason) { score += 70; reasons.push('season:exact'); }
      else if (file.season != null) { score -= 260; reasons.push(`season:mismatch:${file.season}`); }
    }

    if (targetPart != null) {
      if (file.part === targetPart) { score += 35; reasons.push('part:exact'); }
      else if (file.part != null) { score -= 120; reasons.push(`part:mismatch:${file.part}`); }
    }

    if (manual?.path && path.resolve(manual.path) === path.resolve(file.path)) {
      score += 2000;
      reasons.push('manual:exact');
    } else if (manual?.root && path.resolve(file.path).startsWith(path.resolve(manual.root) + path.sep)) {
      score += 450;
      reasons.push('manual:root');
    }

    return { file, score, reasons, title };
  }).sort((a, b) => b.score - a.score || b.file.mtimeMs - a.file.mtimeMs);
}

export function chooseSubtitleMatch(input = {}) {
  const ranked = rankSubtitleFiles(input);
  const first = ranked[0] || null, second = ranked[1] || null;
  if (!first) return { selected: null, confidence: 'none', ranked };

  const exactEpisode = !input.episode || first.file.episode === Number(input.episode);
  const manual = first.reasons.some(reason => reason.startsWith('manual:'));
  const titleStrong = first.title.score >= 145;
  const gap = first.score - (second?.score ?? -Infinity);

  let confidence = 'low';
  if (manual) confidence = 'user';
  else if (exactEpisode && titleStrong && first.score >= 360 && gap >= 70) confidence = 'high';
  else if (exactEpisode && titleStrong && first.score >= 300 && gap >= 25) confidence = 'medium';

  const selected = ['user', 'high'].includes(confidence) ? first.file : null;
  return { selected, confidence, best: first, second, ranked };
}

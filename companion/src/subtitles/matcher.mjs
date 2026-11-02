import path from 'node:path';
import { normalizeTitle, diceSimilarity, extractSeason, extractPart, extractYear, extractEpisodeKind } from '../normalize.mjs';

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

function inferSeasonFromLocalStructure(anime = {}, aliases = [], files = []) {
  const series = Array.isArray(anime.companionSeriesEpisodes) ? anime.companionSeriesEpisodes : [];
  const targetEpisodes = new Set(series.map(item => Number(item?.number || 0)).filter(value => Number.isFinite(value) && value > 0));
  if (targetEpisodes.size < 8) return null;

  const names = animeAliases(anime, aliases);
  const groups = new Map();
  for (const file of files) {
    const season = Number(file?.season || 0);
    const episode = Number(file?.episode || 0);
    if (!season || !episode) continue;
    if (titleScore(names, file.titleHints || []).score < 145) continue;
    const current = groups.get(season) || new Set();
    current.add(episode);
    groups.set(season, current);
  }

  const scored = [...groups.entries()].map(([season, episodes]) => {
    const overlap = [...episodes].filter(value => targetEpisodes.has(value)).length;
    const coverage = overlap / targetEpisodes.size;
    const precision = overlap / episodes.size;
    const sizeDelta = Math.abs(episodes.size - targetEpisodes.size);
    return { season, overlap, coverage, precision, sizeDelta };
  }).filter(item => item.overlap >= Math.min(8, targetEpisodes.size) && item.coverage >= 0.9 && item.precision >= 0.9)
    .sort((a, b) => b.coverage - a.coverage || b.precision - a.precision || a.sizeDelta - b.sizeDelta);

  const best = scored[0], second = scored[1];
  if (!best) return null;
  if (second && best.coverage === second.coverage && best.precision === second.precision && best.sizeDelta === second.sizeDelta) return null;
  return best.season;
}

function inferCurrentSeason(anime = {}, aliases = [], files = []) {
  const companion = Number(anime.companionSeasonNumber || 0);
  if (companion > 0) return companion;
  const explicit = Number(anime.seasonNumber || anime.season_number || anime.seasonIndex || 0);
  if (explicit > 0) return explicit;
  const parsed = extractSeason([anime.title, anime.title_english, anime.romaji, anime.title_japanese].filter(Boolean).join(' '));
  if (parsed) return parsed;
  return inferSeasonFromLocalStructure(anime, aliases, files);
}

function inferCurrentPart(anime = {}) {
  const explicit = Number(anime.part || anime.partNumber || 0);
  if (explicit > 0) return explicit;
  return extractPart([anime.title, anime.title_english, anime.romaji, anime.title_japanese].filter(Boolean).join(' '));
}

function inferCurrentYear(anime = {}) {
  const direct = Number(anime.year || anime.seasonYear || anime.season_year || anime.startDate?.year || 0);
  if (direct >= 1900 && direct <= 2099) return direct;
  return extractYear([anime.title, anime.title_english, anime.romaji, anime.title_japanese].filter(Boolean).join(' '));
}

function inferCurrentKind(anime = {}, episodeMeta = {}, aliases = []) {
  if (/movie/i.test(String(anime.type || ''))) return 'movie';
  const values = [
    anime.title, anime.title_english, anime.title_japanese, anime.romaji,
    ...(Array.isArray(anime.synonyms) ? anime.synonyms : [anime.synonyms]),
    ...aliases,
    episodeMeta.name, episodeMeta.title, episodeMeta.slug, episodeMeta.url,
    episodeMeta.kind, episodeMeta.type, episodeMeta.resolveKind
  ].filter(Boolean);
  for (const value of values) {
    const kind = extractEpisodeKind(value);
    if (kind !== 'main') return kind;
  }
  return null;
}

function kindFamily(kind) {
  if (['special', 'ova', 'oad'].includes(kind)) return 'special';
  return kind || 'main';
}

export function rankSubtitleFiles({ anime = {}, episode, episodeMeta = {}, aliases = [], files = [], manual = null } = {}) {
  const targetEpisode = Number(episode) || null;
  const targetSeason = inferCurrentSeason(anime, aliases, files);
  const targetPart = inferCurrentPart(anime);
  const targetYear = inferCurrentYear(anime);
  const targetKind = inferCurrentKind(anime, episodeMeta, aliases);
  const names = animeAliases(anime, aliases);

  return files.map(file => {
    let score = 0;
    const reasons = [];
    const title = titleScore(names, file.titleHints || []);
    const manualExact = Boolean(manual?.path && path.resolve(manual.path) === path.resolve(file.path));
    const manualRoot = Boolean(manual?.root && path.resolve(file.path).startsWith(path.resolve(manual.root) + path.sep));
    const fileKind = file.episodeKind || 'main';
    const specialFamilyMatch = Boolean(targetKind && kindFamily(targetKind) === 'special' && kindFamily(fileKind) === 'special');

    if (!title.score && !manualExact && !manualRoot) return null;
    score += title.score;
    if (title.score) reasons.push(`title:${title.score}`);

    if (targetEpisode != null) {
      if (file.episode === targetEpisode) {
        score += 180;
        reasons.push('episode:exact');
      } else if (file.episode == null && specialFamilyMatch) {
        score += 60;
        reasons.push('episode:special-unnumbered');
      } else if (file.episode == null) {
        score -= 35;
        reasons.push('episode:missing');
      } else {
        score -= 420;
        reasons.push(`episode:mismatch:${file.episode}`);
      }
    }

    if (targetSeason != null) {
      if (file.season === targetSeason) { score += 80; reasons.push('season:exact'); }
      else if (file.season != null) { score -= 360; reasons.push(`season:mismatch:${file.season}`); }
    }

    if (targetPart != null) {
      if (file.part === targetPart) { score += 35; reasons.push('part:exact'); }
      else if (file.part != null) { score -= 160; reasons.push(`part:mismatch:${file.part}`); }
    }

    if (targetYear != null && file.year != null) {
      if (file.year === targetYear) { score += 80; reasons.push('year:exact'); }
      else { score -= 360; reasons.push(`year:mismatch:${file.year}`); }
    }

    if (targetKind) {
      if (fileKind === targetKind) {
        score += 140;
        reasons.push(`kind:exact:${targetKind}`);
      } else if (specialFamilyMatch) {
        score += 120;
        reasons.push(`kind:equivalent:${fileKind}->${targetKind}`);
      } else {
        score -= 650;
        reasons.push(`kind:mismatch:${fileKind}->${targetKind}`);
      }
    } else if (kindFamily(fileKind) === 'special') {
      score -= 120;
      reasons.push(`kind:unconfirmed:${fileKind}`);
    }

    if (manualExact) {
      score += 2000;
      reasons.push('manual:exact');
    } else if (manualRoot) {
      score += 450;
      reasons.push('manual:root');
    }

    return { file, score, reasons, title, targetKind, targetYear, targetSeason };
  }).filter(Boolean).sort((a, b) => b.score - a.score || b.file.mtimeMs - a.file.mtimeMs);
}

export function chooseSubtitleMatch(input = {}) {
  const ranked = rankSubtitleFiles(input);
  const first = ranked[0] || null, second = ranked[1] || null;
  if (!first) return { selected: null, confidence: 'none', ranked };

  const exactEpisode = !input.episode || first.file.episode === Number(input.episode);
  const specialUnnumbered = first.reasons.includes('episode:special-unnumbered');
  const episodeCompatible = exactEpisode || specialUnnumbered;
  const manual = first.reasons.some(reason => reason.startsWith('manual:'));
  const titleStrong = first.title.score >= 145;
  const hardMismatch = first.reasons.some(reason => /^(season|year|kind):mismatch/.test(reason));
  const specialUnconfirmed = first.reasons.some(reason => reason.startsWith('kind:unconfirmed:'));
  const gap = first.score - (second?.score ?? -Infinity);

  let confidence = 'low';
  if (manual) confidence = 'user';
  else if (!hardMismatch && !specialUnconfirmed && episodeCompatible && titleStrong && first.score >= 360 && gap >= 70) confidence = 'high';
  else if (!hardMismatch && !specialUnconfirmed && episodeCompatible && titleStrong && first.score >= 300 && gap >= 25) confidence = 'medium';

  const selected = ['user', 'high'].includes(confidence) ? first.file : null;
  return { selected, confidence, best: first, second, ranked };
}

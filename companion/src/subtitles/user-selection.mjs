import path from 'node:path';
import { extractEpisode } from '../normalize.mjs';

export function userSubtitleEpisodeHint(subtitlePath = '') {
  const basename = path.basename(String(subtitlePath || ''));
  return extractEpisode(basename);
}

export function isUserSubtitleCompatibleWithEpisode(subtitlePath, currentEpisode) {
  const hinted = userSubtitleEpisodeHint(subtitlePath);
  const current = Number(currentEpisode) || null;
  if (hinted == null || current == null) return { compatible: true, hintedEpisode: hinted };
  return { compatible: Number(hinted) === current, hintedEpisode: Number(hinted) };
}

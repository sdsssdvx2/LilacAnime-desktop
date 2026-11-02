import fs from 'node:fs/promises';
import path from 'node:path';
import { extractEpisode, extractSeason, extractPart, extractYear, extractEpisodeKind, stripEpisodeNoise } from '../normalize.mjs';

export const SUBTITLE_EXTENSIONS = new Set(['.smi', '.sami', '.srt', '.ass', '.ssa', '.vtt']);

async function walk(root, output) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return; }
  await Promise.all(entries.map(async entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return walk(full, output);
    if (!entry.isFile()) return;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(ext)) return;
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) return;
    const parent = path.basename(path.dirname(full));
    const grandparent = path.basename(path.dirname(path.dirname(full)));
    const stem = path.basename(entry.name, ext);
    const contextText = `${grandparent} ${parent} ${stem}`;
    const episode = extractEpisode(stem);
    const season = extractSeason(`${parent} ${stem}`);
    const part = extractPart(`${parent} ${stem}`);
    const year = extractYear(contextText);
    const episodeKind = extractEpisodeKind(contextText);
    const titleHints = [...new Set([
      stripEpisodeNoise(parent),
      stripEpisodeNoise(grandparent),
      stripEpisodeNoise(stem)
    ].filter(value => value && value.length >= 2))];
    output.push({
      path: full,
      name: entry.name,
      ext,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      parent,
      grandparent,
      episode,
      season,
      part,
      year,
      episodeKind,
      titleHints
    });
  }));
}

export async function indexSubtitleRoot(root) {
  const files = [];
  await walk(root, files);
  files.sort((a, b) => a.path.localeCompare(b.path, 'ko'));
  return { root, scannedAt: Date.now(), files };
}

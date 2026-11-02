import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function defaultStatePath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'LilacCompanion', 'state.json');
}

export class StateStore {
  constructor(file = defaultStatePath()) {
    this.file = file;
    this.data = { version: 1, subtitlePreferences: {}, recent: {} };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = { ...this.data, ...parsed };
    } catch {}
    return this;
  }

  animeKey(anime = {}) {
    if (Number(anime.anilistId)) return `anilist:${Number(anime.anilistId)}`;
    if (Number(anime.malId)) return `mal:${Number(anime.malId)}`;
    if (/^\d+$/.test(String(anime.mal_id ?? ''))) return `mal:${anime.mal_id}`;
    return `${anime.provider || 'unknown'}:${anime.id ?? anime.mal_id ?? anime.title ?? 'unknown'}`;
  }

  subtitlePreference(anime, episode) {
    const key = this.animeKey(anime);
    return this.data.subtitlePreferences?.[key]?.[String(Number(episode) || episode)] || null;
  }

  async rememberSubtitle(anime, episode, value) {
    const key = this.animeKey(anime), ep = String(Number(episode) || episode);
    this.data.subtitlePreferences ||= {};
    this.data.subtitlePreferences[key] ||= {};
    this.data.subtitlePreferences[key][ep] = { ...value, updatedAt: Date.now() };
    await this.save();
  }

  async touchRecent(anime, episode) {
    const key = this.animeKey(anime);
    this.data.recent ||= {};
    this.data.recent[key] = { episode: Number(episode) || null, touchedAt: Date.now(), title: anime.title || anime.title_english || '' };
    await this.save();
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(temporary, this.file);
  }
}

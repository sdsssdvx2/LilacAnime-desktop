import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeTitle } from '../normalize.mjs';
import { validProviderId } from './source-registry.mjs';

export function animeSourcePolicyPath() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'LilacCompanion', 'anime-source-policies.json');
}

// Provider-independent when Lilac has a catalog ID. Otherwise use exact
// normalized title + available season/year/type, never fuzzy-match series.
export function animeSourceIdentity(context = {}) {
  const anime = context.anime || context;
  const anilist = Number(anime?.anilistId || 0);
  if (Number.isSafeInteger(anilist) && anilist > 0) return 'anilist:' + anilist;
  const mal = Number(anime?.malId || anime?.mal_id || 0);
  if (Number.isSafeInteger(mal) && mal > 0) return 'mal:' + mal;
  const title = normalizeTitle(anime?.title_english || anime?.romaji || anime?.title || '');
  if (title.length < 3) return '';
  const season = String(anime?.season || '').normalize('NFKC').toLowerCase().trim();
  const year = Number(anime?.year || 0);
  const type = String(anime?.type || '').normalize('NFKC').toLowerCase().trim();
  return 'title:' + title + '|season:' + season + '|year:' + (year || '') + '|type:' + type;
}

const emptyRule = () => ({ preferred: '', locked: false, excluded: [] });
function sanitizeRule(record) {
  const preferred = validProviderId(record?.preferred) ? record.preferred : '';
  const excluded = [...new Set((Array.isArray(record?.excluded) ? record.excluded : [])
    .filter(validProviderId))].slice(0, 50);
  return {
    preferred: excluded.includes(preferred) ? '' : preferred,
    locked: Boolean(record?.locked && preferred && !excluded.includes(preferred)),
    excluded
  };
}
function hasRule(rule) { return Boolean(rule.preferred || rule.excluded.length); }
function validKey(key) { return typeof key === 'string' && key.length > 4 && key.length <= 450 && !/[\u0000-\u001f]/.test(key); }
function episodeKey(number) {
  const n = Number(number);
  return Number.isSafeInteger(n) && n > 0 && n < 100000 ? String(n) : '';
}

export class AnimeSourcePolicies {
  constructor(file = animeSourcePolicyPath()) {
    this.file = file;
    this.data = { version: 1, entries: {} };
  }
  async load() {
    let raw;
    try { raw = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        this.data = { version: 1, entries: {} };
        return this;
      }
      throw new Error('Anime source policies could not be read; preserving file: ' + error.message);
    }
    if (!raw || raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object' ||
        Array.isArray(raw.entries)) {
      throw new Error('Anime source policies are invalid; preserving file');
    }
    const entries = Object.create(null);
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!validKey(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const episodes = Object.create(null);
      if (value.episodes && typeof value.episodes === 'object' && !Array.isArray(value.episodes)) {
        for (const [ep, rule] of Object.entries(value.episodes)) {
          if (episodeKey(ep) === ep) {
            const safe = sanitizeRule(rule);
            if (hasRule(safe)) episodes[ep] = safe;
          }
        }
      }
      const series = sanitizeRule(value.series);
      if (hasRule(series) || Object.keys(episodes).length) {
        entries[key] = {
          title: String(value.title || key).slice(0, 200),
          series, episodes,
          updatedAt: Number(value.updatedAt || 0)
        };
      }
    }
    this.data = { version: 1, entries };
    return this;
  }
  signature() { return JSON.stringify(this.data.entries); }
  list() {
    return Object.entries(this.data.entries).map(([key, item]) => ({
      key, title: item.title, series: item.series, episodes: item.episodes, updatedAt: item.updatedAt
    })).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  resolve(context) {
    const key = animeSourceIdentity(context);
    const record = key && this.data.entries[key];
    if (!record) return null;
    const ep = episodeKey(context?.episode?.number);
    const series = record.series;
    const specific = ep ? record.episodes[ep] : null;
    const excluded = [...new Set([...series.excluded, ...(specific?.excluded || [])])];
    let preferred = specific?.preferred || series.preferred || '';
    if (excluded.includes(preferred)) preferred = '';
    const locked = Boolean(preferred && (specific?.preferred ? specific.locked : series.locked));
    if (!preferred && !excluded.length) return null;
    return { key, title: record.title, preferred, locked, excluded, scope: specific ? 'episode+series' : 'series' };
  }
  async set(context, scope, operation, provider = '') {
    const key = animeSourceIdentity(context);
    if (!key) throw new Error('No reliable anime identity. Open a recognized anime in Lilac.');
    if (!['series', 'episode'].includes(scope)) throw new Error('Scope must be series or episode');
    const ep = scope === 'episode' ? episodeKey(context?.episode?.number) : '';
    if (scope === 'episode' && !ep) throw new Error('Open a numbered episode first.');
    if (!['prefer', 'lock', 'exclude', 'allow', 'clear'].includes(operation)) throw new Error('Unknown policy change');
    if (operation !== 'clear' && !validProviderId(provider)) throw new Error('Invalid provider ID');
    await this.load();
    const entry = this.data.entries[key] || {
      title: '', series: emptyRule(), episodes: {}, updatedAt: 0
    };
    const original = scope === 'series' ? entry.series : (entry.episodes[ep] || emptyRule());
    const rule = sanitizeRule(original);
    if (operation === 'prefer' || operation === 'lock') {
      rule.preferred = provider;
      rule.locked = operation === 'lock';
      rule.excluded = rule.excluded.filter(id => id !== provider);
    } else if (operation === 'exclude') {
      rule.excluded = [...new Set([...rule.excluded, provider])];
      if (rule.preferred === provider) { rule.preferred = ''; rule.locked = false; }
    } else if (operation === 'allow') {
      rule.excluded = rule.excluded.filter(id => id !== provider);
    } else {
      rule.preferred = ''; rule.locked = false; rule.excluded = [];
    }
    if (scope === 'series') entry.series = rule;
    else if (hasRule(rule)) entry.episodes[ep] = rule;
    else delete entry.episodes[ep];
    if (hasRule(entry.series) || Object.keys(entry.episodes).length) {
      entry.title = String(context?.anime?.title || context?.anime?.title_english || entry.title || key).slice(0, 200);
      entry.updatedAt = Date.now();
      this.data.entries[key] = entry;
    } else delete this.data.entries[key];
    await this.save();
    return this.resolve(context);
  }
  async clearKey(key) {
    if (!validKey(key)) throw new Error('Invalid anime rule key');
    await this.load();
    if (this.data.entries[key]) { delete this.data.entries[key]; await this.save(); return true; }
    return false;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    try {
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      await fs.rename(tmp, this.file);
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
}

export function managedSourcePlan(plan, policy) {
  if (!policy) return plan;
  const excluded = new Set(policy.excluded);
  return {
    ...plan,
    providers: plan.providers.filter(id => !excluded.has(id)),
    intensive: plan.intensive.filter(id => !excluded.has(id)),
    signature: plan.signature + '|' + policy.key + '|' + policy.preferred + '|' + policy.locked + '|' + policy.excluded.join(',')
  };
}

// Ranking overrides never bypass validated stream resolution or stability.
export function choosePolicySource(scan, policy, { chooseBestSource, rankSourceResults } = {}) {
  if (!policy) return scan;
  const allowed = scan.results.filter(item => !policy.excluded.includes(item.provider));
  const base = chooseBestSource(allowed);
  const preferred = policy.preferred
    ? allowed.find(item => item.provider === policy.preferred && item.ok && item.value?.probe &&
      item.value.mappingConfidence === 'high' && item.value.probe.metrics?.stability >= 80 &&
      (item.value.probe.metrics?.failureRate ?? 1) <= 0.34)
    : null;
  const chosen = preferred?.value || (policy.locked ? null : base.selected);
  return {
    ...scan,
    decision: {
      ...base,
      selected: chosen,
      ranked: rankSourceResults([...scan.results]),
      reason: preferred ? 'anime-preferred-source' : policy.locked
        ? 'anime-locked-source-unavailable' : 'anime-filtered-quality'
    }
  };
}

export function policySwitchDecision(scan, currentProvider, policy, safeAutoSwitchDecision) {
  const baseline = safeAutoSwitchDecision(scan, currentProvider);
  if (!policy) return baseline;
  const selected = scan?.decision?.selected;
  if (!selected?.provider || selected.provider === currentProvider) {
    return { switch: false, reason: selected ? 'already-best' : 'anime-locked-source-unavailable', selected };
  }
  const item = scan.results.find(row => row.ok && row.value?.provider === selected.provider);
  const stable = item?.value?.probe?.metrics;
  const trusted = selected.mappingConfidence === 'high' && stable &&
    stable.stability >= 80 && (stable.failureRate ?? 1) <= 0.34;
  if (trusted && ((policy.preferred === selected.provider) || policy.excluded.includes(currentProvider))) {
    return { switch: true, reason: 'anime-explicit-source-policy', selected };
  }
  return baseline;
}

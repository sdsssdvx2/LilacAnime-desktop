import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const IDENTIFIER = /^[a-z][a-z0-9_-]{1,47}$/;
const MODES = new Set(['normal', 'intensive', 'off']);
const DEFAULT_INTENSIVE = new Set(['reanime', 'miruro', 'ohli24']);
const RETRY_AFTER_FAILURES = 3;
const RETRY_DELAY_MS = 30 * 60_000;

export function sourceRegistryPath() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'LilacCompanion', 'source-registry.json');
}
export function validProviderId(id) {
  return typeof id === 'string' && IDENTIFIER.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);
}
export function normaliseSourceSnapshot(snapshot) {
  if (snapshot?.reliable !== true || !Array.isArray(snapshot.providers)) return null;
  const providers = [], ids = new Set();
  for (const item of snapshot.providers) {
    const id = typeof item?.id === 'string' ? item.id.trim().toLowerCase() : '';
    if (!validProviderId(id) || ids.has(id)) continue;
    ids.add(id);
    providers.push({ id, label: String(item.label || id).trim().slice(0, 80) || id });
  }
  // Incomplete UI must not make the last known source inventory disappear.
  return providers.length >= 2 ? providers : null;
}
function defaultData() { return { version: 1, initialised: false, checkedAt: 0, providers: {} }; }
function defaultMode(id) { return DEFAULT_INTENSIVE.has(id) ? 'intensive' : 'normal'; }
function safeRecord(id, value) {
  return {
    label: String(value?.label || id).slice(0, 80),
    present: Boolean(value?.present),
    firstSeenAt: Number(value?.firstSeenAt || 0),
    lastSeenAt: Number(value?.lastSeenAt || 0),
    missingSince: Number(value?.missingSince || 0),
    ...(MODES.has(value?.mode) ? { mode: value.mode } : {}),
    failures: Math.max(0, Math.min(10, Number(value?.failures || 0) || 0)),
    retryAfter: Number(value?.retryAfter || 0),
    lastDiagnosis: ['ok', 'failed', 'unknown'].includes(value?.lastDiagnosis) ? value.lastDiagnosis : 'unknown',
    lastDiagnosedAt: Number(value?.lastDiagnosedAt || 0)
  };
}
export class SourceRegistry {
  constructor(file = sourceRegistryPath(), { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = defaultData();
  }
  async load() {
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') { this.data = defaultData(); return this; }
      throw new Error(`Source registry could not be read; keeping it unchanged: ${error.message}`);
    }
    if (!parsed || parsed.version !== 1 || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers) || !parsed.providers) {
      throw new Error('Source registry schema is invalid; keeping it unchanged');
    }
    const providers = Object.create(null);
    for (const [id, record] of Object.entries(parsed.providers)) {
      if (validProviderId(id)) providers[id] = safeRecord(id, record);
    }
    this.data = { version: 1, initialised: parsed.initialised === true, checkedAt: Number(parsed.checkedAt || 0), providers };
    return this;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  mode(id) { return this.data.providers[id]?.mode || defaultMode(id); }
  async refreshFromBridge(bridge) {
    const snapshot = await bridge.listProviders();
    return this.reconcile(snapshot);
  }
  async reconcile(snapshot) {
    const incoming = normaliseSourceSnapshot(snapshot);
    if (!incoming) return { reliable: false, changes: [], reason: snapshot?.reason || 'source UI unavailable or incomplete' };
    await this.load();
    const at = this.now(), first = !this.data.initialised, changes = [];
    const incomingIds = new Set(incoming.map(item => item.id));
    for (const item of incoming) {
      const old = this.data.providers[item.id];
      if (!old) {
        this.data.providers[item.id] = safeRecord(item.id, { label: item.label, present: true, firstSeenAt: at, lastSeenAt: at });
        if (!first) changes.push({ type: 'added', id: item.id, label: item.label });
      } else {
        if (old.present === false && old.firstSeenAt) changes.push({ type: 'restored', id: item.id, label: item.label });
        if (old.label !== item.label) changes.push({ type: 'renamed', id: item.id, from: old.label, label: item.label });
        old.label = item.label; old.present = true; old.missingSince = 0; old.lastSeenAt = at;
        if (!old.firstSeenAt) old.firstSeenAt = at;
      }
    }
    for (const [id, old] of Object.entries(this.data.providers)) {
      if (old.present && !incomingIds.has(id)) {
        old.present = false; old.missingSince = at;
        changes.push({ type: 'removed', id, label: old.label });
      }
    }
    this.data.initialised = true; this.data.checkedAt = at;
    // Low frequency inventory refresh, not a per-frame write.
    await this.save();
    return { reliable: true, initial: first, count: incoming.length, changes };
  }
  plan(currentProvider = '') {
    const now = this.now();
    const disabledCurrent = this.mode(currentProvider) === 'off' ||
      Boolean(this.data.initialised && this.data.providers[currentProvider]?.present === false);
    const entries = Object.entries(this.data.providers);
    const providers = entries.filter(([id, item]) => item.present && this.mode(id) !== 'off' &&
      (id === currentProvider || Number(item.retryAfter || 0) <= now)).map(([id]) => id);
    return {
      providers,
      intensive: providers.filter(id => this.mode(id) === 'intensive'),
      disabledCurrent,
      signature: JSON.stringify(entries.map(([id, item]) => [id, item.present, this.mode(id), Number(item.retryAfter || 0) > now]))
    };
  }
  async setMode(id, mode) {
    if (!validProviderId(id)) throw new Error('Invalid source ID');
    if (!MODES.has(mode)) throw new Error('Mode must be normal, intensive or off');
    await this.load();
    if (!this.data.providers[id]) throw new Error(`Unknown source ID: ${id}. Run sources sync after Lilac updates.`);
    if (this.mode(id) === mode && this.data.providers[id].mode === mode) return false;
    await this.backup(); this.data.providers[id].mode = mode;
    await this.save(); return true;
  }
  async resetMode(id) {
    if (!validProviderId(id)) throw new Error('Invalid source ID');
    await this.load();
    if (!this.data.providers[id]) throw new Error(`Unknown source ID: ${id}`);
    if (!this.data.providers[id].mode) return false;
    await this.backup(); delete this.data.providers[id].mode;
    await this.save(); return true;
  }
  async backup() {
    try { await fs.copyFile(this.file, `${this.file}.bak`); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  async undo() {
    const backup = `${this.file}.bak`;
    const saved = await fs.readFile(backup, 'utf8');
    const current = await fs.readFile(this.file, 'utf8').catch(() => null);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.undo-${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, saved, 'utf8');
      await fs.rename(temporary, this.file);
      if (current !== null) await fs.writeFile(backup, current, 'utf8');
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    await this.load();
  }
  async reportScan(results = []) {
    await this.load();
    const at = this.now();
    let changed = false;
    for (const result of results) {
      const record = this.data.providers[String(result?.provider || '')];
      if (!record || this.mode(result.provider) === 'off') continue;
      const status = result.ok && result.value?.probe ? 'ok' : result.ok ? 'unknown' : 'failed';
      if (status === 'unknown') continue;
      record.lastDiagnosis = status; record.lastDiagnosedAt = at;
      record.failures = status === 'ok' ? 0 : Math.min(RETRY_AFTER_FAILURES, record.failures + 1);
      record.retryAfter = status === 'failed' && record.failures >= RETRY_AFTER_FAILURES ? at + RETRY_DELAY_MS : 0;
      changed = true;
    }
    if (changed) await this.save();
  }
}

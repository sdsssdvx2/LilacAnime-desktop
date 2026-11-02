export class SourceDecisionCache {
  constructor({ ttlMs = 15 * 60 * 1000, retryMs = 5 * 60 * 1000 } = {}) {
    this.ttlMs = Math.max(1000, Number(ttlMs) || 15 * 60 * 1000);
    this.retryMs = Math.max(1000, Number(retryMs) || 5 * 60 * 1000);
    this.decisions = new Map();
    this.retryAfter = new Map();
  }

  get(key, now = Date.now()) {
    const entry = this.decisions.get(key);
    if (!entry) return null;
    const ttl = Math.max(1000, Number(entry.ttlMs || this.ttlMs));
    if (now - Number(entry.at || 0) >= ttl) {
      this.decisions.delete(key);
      return null;
    }
    return entry;
  }

  remember(key, scan, now = Date.now(), ttlMs = this.ttlMs) {
    const selected = scan?.decision?.selected || null;
    if (!key || !selected?.provider) return null;
    const entry = { at: now, ttlMs: Math.max(1000, Number(ttlMs) || this.ttlMs), scan };
    this.decisions.set(key, entry);
    this.retryAfter.delete(key);
    return entry;
  }

  defer(key, now = Date.now()) {
    if (key) this.retryAfter.set(key, now + this.retryMs);
  }

  canScan(key, now = Date.now()) {
    return !key || Number(this.retryAfter.get(key) || 0) <= now;
  }

  clear(key) {
    if (key) {
      this.decisions.delete(key);
      this.retryAfter.delete(key);
    } else {
      this.decisions.clear();
      this.retryAfter.clear();
    }
  }
}

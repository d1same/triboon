'use strict';
// Stdlib JSON persistence (zero deps). One JSON document per "table", written atomically
// (write .tmp then rename) so a crash mid-write never corrupts the live file. In-memory cache
// with debounced flush keeps reads fast. Swap to node:sqlite (Node 22+) behind this interface.

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir = process.env.TRIBOON_DATA || path.join(__dirname, '..', 'data')) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();   // table -> object
    this.dirty = new Set();
    this.timer = null;
  }

  _file(table) { return path.join(this.dir, `${table}.json`); }

  read(table, fallback = {}) {
    if (this.cache.has(table)) return this.cache.get(table);
    let val = fallback;
    try {
      const raw = fs.readFileSync(this._file(table), 'utf8');
      val = JSON.parse(raw);
    } catch { /* missing/corrupt → fallback */ }
    this.cache.set(table, val);
    return val;
  }

  write(table, value) {
    this.cache.set(table, value);
    this.dirty.add(table);
    this._flushSoon();
    return value;
  }

  // Mutate-in-place helper: mutator receives the current doc, return value is persisted.
  update(table, fallback, mutator) {
    const cur = this.read(table, fallback);
    const next = mutator(cur) ?? cur;
    return this.write(table, next);
  }

  _flushSoon(delay = 50) {
    if (this.timer) return;
    // The timer path must NEVER throw — an EPERM here once crashed the whole server.
    this.timer = setTimeout(() => { try { this.flush(); } catch { /* retried below */ } }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  // Persistence must never take the server down. Renames can transiently fail on Windows
  // (file briefly locked by AV/another reader): fall back to an in-place write (loses
  // atomicity for that one write only), and keep the table dirty for a retry if even that
  // fails. In-memory state stays authoritative throughout.
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const failed = new Set();
    for (const table of this.dirty) {
      const json = JSON.stringify(this.cache.get(table), null, 0);
      const file = this._file(table);
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, file);
      } catch {
        try { fs.writeFileSync(file, json); }
        catch (e2) { failed.add(table); this.lastFlushError = e2; }
      }
    }
    this.dirty = failed;
    if (failed.size) this._flushSoon(1000);
  }

  close() { this.flush(); }
}

// A TTL verdict/health cache keyed by nzb url AND normalized title (two-tier per architecture).
class VerdictCache {
  constructor(store, ttlMs = 6 * 3600 * 1000) { this.store = store; this.ttl = ttlMs; }
  _now() { return Date.now(); }
  get(key) {
    const all = this.store.read('verdicts', {});
    const v = all[key];
    if (!v) return null;
    if (this._now() - v.checkedAt > this.ttl) return null;
    return v;
  }
  set(key, verdict, detail = {}) {
    this.store.update('verdicts', {}, (all) => {
      all[key] = { verdict, detail, checkedAt: this._now() };
      return all;
    });
  }
}

module.exports = { Store, VerdictCache };

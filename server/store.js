'use strict';
// Stdlib JSON persistence (zero deps). One JSON document per "table", written atomically
// (write .tmp then rename) so a crash mid-write never corrupts the live file. In-memory cache
// with debounced flush keeps reads fast. Swap to node:sqlite (Node 22+) behind this interface.

const fs = require('fs');
const path = require('path');

// Synchronous short sleep for boot-time read retries. Only ever runs when a file is momentarily
// locked (AV/installer); reads are cached after the first success, so this never hits the hot path.
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin fallback */ } }
}

// Tables that hold the user's real, hard-to-recreate state. In "safe mode" (secret unreadable at
// boot) writes to these are frozen so a temporary-key session can't overwrite the intact data on disk.
const CRITICAL_TABLES = new Set(['secret', 'users', 'settings']);

class Store {
  constructor(dir = process.env.TRIBOON_DATA || path.join(__dirname, '..', 'data')) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    this.cache = new Map();   // table -> object
    this.dirty = new Set();
    this.timer = null;
    // Debounced-path flush throttle: table -> minimum ms between BACKGROUND flushes. High-frequency
    // writers (watch beacons every 10s/viewer, per-browse tmdb-cache misses, multi-MB EPG/channel/
    // library payloads) used to re-serialize + rewrite the whole table ~every 50ms of activity — on
    // the same event loop serving Range bytes and NNTP data. Explicit flush()/close() IGNORE these
    // (durability on demand); the loss window on crash is at most the interval, and every throttled
    // table is either rebuildable (caches) or loses only seconds of progress (watch).
    this.flushIntervals = {};
    this._lastFlushAt = new Map();
    this._flushingAsync = false;
    this._tmpSeq = 0;
  }

  _file(table) { return path.join(this.dir, `${table}.json`); }

  read(table, fallback = {}) {
    if (this.cache.has(table)) return this.cache.get(table);
    const file = this._file(table);
    // A genuinely MISSING file → fallback (normal). But a file that EXISTS yet can't be read/parsed
    // right now (an AV lock or an ACL change immediately after a Windows installer runs, or a
    // half-written file mid-flush) must NOT be treated as "absent" — callers like the secret, users,
    // and settings loaders would then overwrite real data with defaults (the "settings/users wiped on
    // update" bug). Retry briefly; after that, return the fallback but DON'T cache it, so a later read
    // re-attempts the real file instead of serving empty for the whole process lifetime.
    for (let attempt = 0; ; attempt++) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (e) {
        if (e && e.code === 'ENOENT') { this.cache.set(table, fallback); return fallback; } // truly absent
        if (attempt < 5) { sleepMs(120); continue; }                                          // exists but locked
        return fallback;                                                                       // give up (uncached)
      }
      try { const val = JSON.parse(raw); this.cache.set(table, val); return val; }
      catch { if (attempt < 5) { sleepMs(120); continue; } return fallback; }                 // corrupt/partial (uncached)
    }
  }

  write(table, value) {
    // Safe mode: when the secret couldn't be read at boot (data is transiently unreadable), the server
    // runs with a temporary key. Persisting the critical tables now would OVERWRITE the real (intact)
    // data on disk with junk encrypted under the wrong key — the exact wipe we're preventing. So drop
    // those writes; the real data stays on disk and recovers on the next clean boot. Everything else
    // (caches, watch) may still write harmlessly.
    if (this.freezeCriticalWrites && CRITICAL_TABLES.has(table)) {
      if (!this._frozeWarned) { this._frozeWarned = true; try { console.error(`[store] safe mode: not writing '${table}' (secret unavailable) — protecting existing data on disk.`); } catch {} }
      this.cache.set(table, value); // keep the in-memory view consistent for this session only
      return value;
    }
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
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flushAsync().catch(() => { /* per-table failures already handled inside */ });
    }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  _noteFlushFailure(tables) {
    // A persistent flush failure risks silent data loss (settings/watch state stay only in RAM).
    // Surface it to the operator — log the first failure and then sparingly to avoid spam.
    this._flushFails = (this._flushFails || 0) + 1;
    if (this._flushFails === 1 || this._flushFails % 30 === 0) {
      try { console.error(`[store] flush failed for [${[...tables].join(',')}] (attempt ${this._flushFails})${this.lastFlushError ? ': ' + this.lastFlushError.message : ''}`); } catch {}
    }
  }
  _noteFlushRecovered() {
    if (!this._flushFails) return;
    try { console.error(`[store] flush recovered after ${this._flushFails} failed attempt(s)`); } catch {}
    this._flushFails = 0;
  }
  // Each writer renames its OWN tmp file: the sync flush() and the async path can overlap on the
  // same table (e.g. a settings save during a background watch flush), and a shared `.tmp` name
  // would let one writer's fd keep appending into the file another writer just renamed live.
  _tmpFile(file) { return `${file}.tmp${++this._tmpSeq}`; }

  // Background (debounced) flush: async fs so multi-MB tables (19K-item libraries, 8000-channel
  // IPTV lineups, EPG payloads) don't stall the event loop that is serving video bytes; honors
  // flushIntervals so hot tables coalesce. JSON.stringify still runs on the loop (unavoidable
  // without a worker), so the interval throttle is what keeps big tables OFF the hot path.
  async _flushAsync() {
    if (this._flushingAsync) return;
    this._flushingAsync = true;
    try {
      const now = Date.now();
      let retryIn = 0;
      const due = [];
      for (const table of this.dirty) {
        const wait = (this.flushIntervals[table] || 0) - (now - (this._lastFlushAt.get(table) || 0));
        if (wait > 0) retryIn = retryIn ? Math.min(retryIn, wait) : wait;
        else due.push(table);
      }
      for (const table of due) {
        this.dirty.delete(table); // a write() during the awaits below re-marks it
        const json = JSON.stringify(this.cache.get(table), null, 0);
        const file = this._file(table);
        let ok = false;
        try {
          const tmp = this._tmpFile(file);
          await fs.promises.writeFile(tmp, json, { mode: 0o600 });
          await fs.promises.rename(tmp, file);
          fs.promises.chmod(file, 0o600).catch(() => {});
          ok = true;
        } catch {
          try {
            await fs.promises.writeFile(file, json, { mode: 0o600 });
            fs.promises.chmod(file, 0o600).catch(() => {});
            ok = true;
          } catch (e2) {
            this.dirty.add(table);
            this.lastFlushError = e2;
            this._noteFlushFailure([table]);
          }
        }
        if (ok) { this._lastFlushAt.set(table, Date.now()); this._noteFlushRecovered(); }
      }
      if (this.dirty.size) this._flushSoon(Math.max(retryIn, this._flushFails ? 1000 : 250));
    } finally {
      this._flushingAsync = false;
    }
  }

  // Explicit/synchronous flush: durability on demand (settings saves, token writes, shutdown).
  // Ignores flushIntervals and writes EVERYTHING dirty before returning. Persistence must never
  // take the server down: renames can transiently fail on Windows (file briefly locked by AV/
  // another reader) — fall back to an in-place write (loses atomicity for that one write only),
  // and keep the table dirty for a retry if even that fails. In-memory state stays authoritative.
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const failed = new Set();
    for (const table of this.dirty) {
      const json = JSON.stringify(this.cache.get(table), null, 0);
      const file = this._file(table);
      try {
        const tmp = this._tmpFile(file);
        fs.writeFileSync(tmp, json, { mode: 0o600 });
        fs.renameSync(tmp, file);
        try { fs.chmodSync(file, 0o600); } catch {}
        this._lastFlushAt.set(table, Date.now());
      } catch {
        try {
          fs.writeFileSync(file, json, { mode: 0o600 });
          try { fs.chmodSync(file, 0o600); } catch {}
          this._lastFlushAt.set(table, Date.now());
        }
        catch (e2) { failed.add(table); this.lastFlushError = e2; }
      }
    }
    this.dirty = failed;
    if (failed.size) {
      this._noteFlushFailure(failed);
      this._flushSoon(1000);
    } else this._noteFlushRecovered();
  }

  close() { this.flush(); }
}

// A TTL verdict/health cache keyed by sanitized NZB hash AND normalized title.
class VerdictCache {
  constructor(store, ttlMs = 6 * 3600 * 1000, maxEntries = 20000) {
    this.store = store; this.ttl = ttlMs; this.maxEntries = maxEntries;
    this._scrubUnsafeKeys();
  }
  _now() { return Date.now(); }
  _prune(all) {
    const now = this._now();
    for (const [k, v] of Object.entries(all || {})) {
      if (!v || !v.checkedAt || now - v.checkedAt > this.ttl) delete all[k];
    }
    const keys = Object.keys(all || {});
    if (keys.length > this.maxEntries) {
      keys.sort((a, b) => ((all[a] && all[a].checkedAt) || 0) - ((all[b] && all[b].checkedAt) || 0));
      for (const k of keys.slice(0, keys.length - this.maxEntries)) delete all[k];
    }
    return all;
  }
  _scrubUnsafeKeys() {
    const all = this.store.read('verdicts', {});
    let changed = false;
    for (const k of Object.keys(all)) {
      if (/^https?:\/\//i.test(k) || /[?&](apikey|api_key|key|token|access_token|auth|password)=/i.test(k)) {
        delete all[k];
        changed = true;
      }
    }
    if (changed) this.store.write('verdicts', all);
  }
  get(key) {
    const all = this.store.read('verdicts', {});
    const v = all[key];
    if (!v) return null;
    if (this._now() - v.checkedAt > this.ttl) return null;
    return v;
  }
  set(key, verdict, detail = {}) {
    this.store.update('verdicts', {}, (all) => {
      // Prune LAZILY: a full Object.entries scan (+ sort when over cap) of a 20K-entry table on
      // EVERY write is pure hot-path waste — one hard press-play walk records ~2 verdicts per
      // candidate across up to 18 candidates while the user watches the spinner. get() already
      // TTL-filters reads, so expired entries between prunes are invisible; the table can only
      // drift ~100 entries past the cap before the next sweep.
      this._sets = (this._sets || 0) + 1;
      if (this._sets % 50 === 0) all = this._prune(all);
      all[key] = { verdict, detail, checkedAt: this._now() };
      return all;
    });
  }
}

module.exports = { Store, VerdictCache };

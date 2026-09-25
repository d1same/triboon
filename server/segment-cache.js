'use strict';
// Disk copy of decoded articles. RAM still serves the next seconds.
// This store is for "I already downloaded this." Default off.
// Play never waits on a write. A full closet deletes the oldest pieces.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FLUSH_BYTES = 16 * 1024 * 1024;
const QUEUE_CAP_BYTES = 64 * 1024 * 1024;

function articleKey(messageId) {
  const id = String(messageId || '').replace(/[<>]/g, '').trim();
  if (!id) return '';
  return crypto.createHash('sha256').update(id).digest('hex');
}

class SegmentDiskCache {
  constructor(opts = {}) {
    this.dir = opts.dir || '';
    this.maxBytes = opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : 10 * 1024 * 1024 * 1024;
    this.enabled = opts.enabled === true && !!this.dir;
    this.index = new Map();
    this.bytes = 0;
    this.queue = [];
    this.queuedBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.evictions = 0;
    this._loaded = false;
    this._loading = null;
    this._flushing = null;
    this._timer = null;
    this._indexTimer = null;
  }

  configure({ dir, enabled, maxBytes } = {}) {
    if (dir) this.dir = dir;
    if (maxBytes > 0) this.maxBytes = Math.floor(maxBytes);
    this.enabled = enabled === true && !!this.dir;
    if (!this.enabled) this._clearTimers();
  }

  stats() {
    return {
      enabled: this.enabled,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      entries: this.index.size,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      evictions: this.evictions,
      queuedBytes: this.queuedBytes,
    };
  }

  async get(messageId) {
    if (!this.enabled) return null;
    const key = articleKey(messageId);
    if (!key) return null;
    await this._ensureLoaded();
    const rec = this.index.get(key);
    if (!rec) {
      this.misses++;
      return null;
    }
    try {
      const data = await fs.promises.readFile(this._blobPath(key));
      if (data.length !== rec.bytes) {
        await this._drop(key);
        this.misses++;
        return null;
      }
      rec.at = Date.now();
      this.hits++;
      this._scheduleIndex();
      return { data, size: rec.size, partSize: rec.partSize };
    } catch {
      await this._drop(key);
      this.misses++;
      return null;
    }
  }

  put(messageId, buf, meta = {}) {
    if (!this.enabled || !buf || !buf.length) return;
    if (buf.length > this.maxBytes) return;
    if (this.queuedBytes + buf.length > QUEUE_CAP_BYTES) return;
    const key = articleKey(messageId);
    if (!key) return;
    const prior = this.queue.find((job) => job.key === key);
    if (prior) {
      this.queuedBytes -= prior.buf.length;
      prior.buf = buf;
      prior.size = meta.size;
      prior.partSize = meta.partSize;
      this.queuedBytes += buf.length;
    } else {
      this.queue.push({
        key,
        buf,
        size: Number.isFinite(meta.size) ? meta.size : null,
        partSize: Number.isFinite(meta.partSize) ? meta.partSize : null,
      });
      this.queuedBytes += buf.length;
    }
    if (this.queuedBytes >= FLUSH_BYTES) this.flush();
    else this._scheduleFlush();
  }

  flush() {
    if (this._flushing) return this._flushing;
    this._clearFlushTimer();
    this._flushing = this._flushNow().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  async clear() {
    this._clearTimers();
    this.queue = [];
    this.queuedBytes = 0;
    this.index.clear();
    this.bytes = 0;
    this._loaded = true;
    if (!this.dir) return;
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    if (!this._loading) this._loading = this._load().finally(() => { this._loading = null; });
    await this._loading;
  }

  async _load() {
    this.index.clear();
    this.bytes = 0;
    if (!this.dir) {
      this._loaded = true;
      return;
    }
    try {
      const raw = await fs.promises.readFile(path.join(this.dir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw);
      const entries = parsed && parsed.entries ? parsed.entries : {};
      for (const [key, rec] of Object.entries(entries)) {
        if (!rec || !(rec.bytes > 0)) continue;
        this.index.set(key, {
          bytes: rec.bytes,
          size: rec.size ?? null,
          partSize: rec.partSize ?? null,
          at: rec.at || 0,
        });
        this.bytes += rec.bytes;
      }
    } catch {
      // Missing index is a cold closet.
    }
    this._loaded = true;
  }

  async _flushNow() {
    if (!this.enabled || !this.dir) {
      this.queue = [];
      this.queuedBytes = 0;
      return;
    }
    await this._ensureLoaded();
    const jobs = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    await fs.promises.mkdir(this.dir, { recursive: true });
    for (const job of jobs) {
      try {
        const dest = this._blobPath(job.key);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        const tmp = dest + '.tmp';
        await fs.promises.writeFile(tmp, job.buf);
        await fs.promises.rename(tmp, dest);
        const prior = this.index.get(job.key);
        if (prior) this.bytes -= prior.bytes;
        this.index.set(job.key, {
          bytes: job.buf.length,
          size: job.size,
          partSize: job.partSize,
          at: Date.now(),
        });
        this.bytes += job.buf.length;
        this.writes++;
      } catch {
        // A failed copy must not stall Play. The article stays in RAM.
      }
    }
    await this._evict();
    await this._saveIndex();
  }

  async _evict() {
    if (this.bytes <= this.maxBytes) return;
    const ordered = [...this.index.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (const [key] of ordered) {
      if (this.bytes <= this.maxBytes) break;
      if (this.index.size <= 1) break;
      await this._drop(key);
      this.evictions++;
    }
  }

  async _drop(key) {
    const rec = this.index.get(key);
    if (!rec) return;
    this.index.delete(key);
    this.bytes = Math.max(0, this.bytes - rec.bytes);
    try { await fs.promises.rm(this._blobPath(key), { force: true }); } catch {}
  }

  async _saveIndex() {
    if (!this.dir) return;
    const entries = {};
    for (const [key, rec] of this.index) entries[key] = rec;
    const dest = path.join(this.dir, 'index.json');
    const tmp = dest + '.tmp';
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify({ v: 1, entries }));
      await fs.promises.rename(tmp, dest);
    } catch {}
  }

  _blobPath(key) {
    return path.join(this.dir, key.slice(0, 2), key);
  }

  _scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 50);
    if (this._timer.unref) this._timer.unref();
  }

  _scheduleIndex() {
    if (this._indexTimer) return;
    this._indexTimer = setTimeout(() => {
      this._indexTimer = null;
      this._saveIndex();
    }, 1000);
    if (this._indexTimer.unref) this._indexTimer.unref();
  }

  _clearFlushTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _clearTimers() {
    this._clearFlushTimer();
    if (this._indexTimer) clearTimeout(this._indexTimer);
    this._indexTimer = null;
  }
}

let active = null;

function getSegmentDisk() {
  return active;
}

function configureSegmentDisk(opts) {
  if (!opts || !opts.dir) {
    if (active) active.configure({ enabled: false });
    return active;
  }
  if (!active) active = new SegmentDiskCache(opts);
  else active.configure(opts);
  return active;
}

module.exports = {
  SegmentDiskCache, articleKey, getSegmentDisk, configureSegmentDisk, FLUSH_BYTES,
};

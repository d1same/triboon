'use strict';
// NzbFileStream: one usenet-posted file as a seekable byte stream (segment map + read-ahead).
// VirtualFile: Phase 0 wrapper — an NZB's primary file mounted directly (non-archived posts).
// Offsets come from yEnc =ypart headers; we learn the uniform part size from segment 1 (true
// for virtually all posts) and verify per-fetch.

const { decode } = require('./yenc');
const { parseNzb, pickPrimaryFile, fileNameFromSubject } = require('./nzb');
const crypto = require('crypto');

const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;
const READ_WAIT_BOOST_MS = 250;
const READ_AHEAD_BOOST_SEGMENTS = 2;
const READ_AHEAD_BOOST_TTL_MS = 30000;
const READ_AHEAD_BOOST_COOLDOWN_MS = 5000;

// A multi-volume archive is one playback mount, so its decoded-article budget must also be one
// budget. Giving every volume the full cacheMaxBytes allowance multiplies retained memory by the
// number of RAR parts. This coordinator keeps the existing per-file caches/read API, but evicts the
// oldest decoded article across every participating volume when the mount-wide byte cap is crossed.
class SharedCacheBudget {
  constructor(maxBytes = DEFAULT_CACHE_BYTES) {
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_CACHE_BYTES;
    this.bytes = 0;
    this.entries = 0;
    this.byOwner = new Map();
    this.order = [];
  }

  setMaxBytes(maxBytes) {
    if (Number.isFinite(maxBytes) && maxBytes > 0) this.maxBytes = Math.floor(maxBytes);
    this.trim();
  }

  add(owner, index, bytes) {
    let owned = this.byOwner.get(owner);
    if (!owned) { owned = new Map(); this.byOwner.set(owner, owned); }
    const prior = owned.get(index);
    if (prior) this._removeRecord(prior);
    const rec = { owner, index, bytes: Math.max(0, Number(bytes) || 0), active: true };
    owned.set(index, rec);
    this.order.push(rec);
    this.bytes += rec.bytes;
    this.entries++;
    this.trim();
  }

  remove(owner, index) {
    const owned = this.byOwner.get(owner);
    const rec = owned && owned.get(index);
    if (rec) this._removeRecord(rec);
  }

  _removeRecord(rec) {
    if (!rec || !rec.active) return;
    rec.active = false;
    this.bytes = Math.max(0, this.bytes - rec.bytes);
    this.entries = Math.max(0, this.entries - 1);
    const owned = this.byOwner.get(rec.owner);
    if (owned && owned.get(rec.index) === rec) {
      owned.delete(rec.index);
      if (!owned.size) this.byOwner.delete(rec.owner);
    }
  }

  trim() {
    // Preserve the newest decoded article if a provider uses articles larger than the configured
    // cap; the caller still needs that one Buffer to complete its current read. Otherwise the
    // aggregate remains strictly within the mount-wide byte allowance.
    while (this.bytes > this.maxBytes && this.entries > 1) {
      let rec = null;
      while (this.order.length && !(rec = this.order.shift()).active) rec = null;
      if (!rec) break;
      this._removeRecord(rec);
      if (rec.owner && typeof rec.owner._cacheDrop === 'function') {
        rec.owner._cacheDrop(rec.index, { fromSharedBudget: true });
      }
    }
    if (this.order.length > this.entries * 2 + 32) this.order = this.order.filter((rec) => rec.active);
  }
}

function abortError() {
  const e = new Error('read aborted');
  e.code = 'ABORT_ERR';
  return e;
}

function signalAborted(signal) {
  return !!(signal && signal.aborted);
}

function addAbortListener(signal, fn) {
  if (!signal || typeof signal.addEventListener !== 'function') return () => {};
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

function priorityRank(priority) {
  return ({ startup: 0, seek: 0, playback: 1, health: 2, readAhead: 3, background: 4 })[priority] ?? 1;
}

class NzbFileStream {
  constructor(pool, fileEntry, {
    readAhead = 4, cacheSegments = 24, cacheBytes = DEFAULT_CACHE_BYTES, signal = null,
  } = {}) {
    this.pool = pool;
    this.file = fileEntry;
    this.name = fileNameFromSubject(fileEntry.subject);
    this.id = crypto.randomBytes(6).toString('hex');
    this.segments = fileEntry.segments;
    this.size = null;       // learned from =ybegin size=
    this.partSize = null;   // learned from segment 1 (=ypart end - begin)
    this.readAhead = readAhead;
    this.baseReadAhead = readAhead;
    this.maxReadAhead = readAhead;
    this.adaptiveReadAheadUntil = 0;
    this.lastReadAheadBoostAt = 0;
    this.readWaitBoostMs = READ_WAIT_BOOST_MS;
    this.cache = new Map(); // segIndex -> Buffer (decoded)
    this.cacheOrder = [];
    this.cacheMax = cacheSegments;
    this.cacheMaxBytes = Number.isFinite(cacheBytes) && cacheBytes > 0 ? cacheBytes : DEFAULT_CACHE_BYTES;
    this.cacheBytes = 0;
    this.sharedCacheBudget = null;
    this.inflight = new Map(); // segIndex -> Promise<Buffer>
    // Scoped to fetches needed to establish this mount. A hedged source-race loser aborts it so a
    // stalled startup BODY cannot keep an NNTP connection at startup priority until the 30s mount
    // deadline. Normal playback reads deliberately do not inherit this signal.
    this.mountSignal = signal;
    this.readAheadEpoch = 0;
    this.health = { verdict: 'unverified', checkedAt: null, missing: 0, sampled: 0 };
    this.playbackStats = {
      reads: 0,
      segmentsServed: 0,
      cacheHits: 0,
      segmentWaits: 0,
      segmentWaitMs: 0,
      maxSegmentWaitMs: 0,
      readBytes: 0,
      adaptiveBoosts: 0,
      lastBoostAt: null,
    };
  }

  applyPlaybackWindow(win = {}) {
    const readAhead = Math.max(0, Math.floor(win.readAhead ?? this.readAhead ?? 0));
    const maxReadAhead = Math.max(readAhead, Math.floor(win.maxReadAhead ?? readAhead));
    const now = Date.now();
    this.baseReadAhead = readAhead;
    this.maxReadAhead = maxReadAhead;
    if (!this.adaptiveReadAheadUntil || this.adaptiveReadAheadUntil <= now || this.readAhead < readAhead) {
      this.readAhead = readAhead;
      this.adaptiveReadAheadUntil = 0;
    } else {
      this.readAhead = Math.min(this.readAhead, this.maxReadAhead);
    }
    if (Number.isFinite(win.cacheMax) && win.cacheMax > 0) this.cacheMax = Math.floor(win.cacheMax);
    if (Number.isFinite(win.cacheMaxBytes) && win.cacheMaxBytes > 0) this.cacheMaxBytes = Math.floor(win.cacheMaxBytes);
    if (this.sharedCacheBudget) this.sharedCacheBudget.setMaxBytes(this.cacheMaxBytes);
    this.trimCache();
  }

  setSharedCacheBudget(sharedCacheBudget) {
    if (this.sharedCacheBudget === sharedCacheBudget) return;
    if (this.sharedCacheBudget) {
      for (const index of this.cache.keys()) this.sharedCacheBudget.remove(this, index);
    }
    this.sharedCacheBudget = sharedCacheBudget || null;
    if (this.sharedCacheBudget) {
      for (const [index, buf] of this.cache) this.sharedCacheBudget.add(this, index, buf.length);
    }
  }

  _resetExpiredAdaptiveReadAhead(now = Date.now()) {
    if (this.adaptiveReadAheadUntil && this.adaptiveReadAheadUntil <= now) {
      this.readAhead = this.baseReadAhead;
      this.adaptiveReadAheadUntil = 0;
    }
  }

  _maybeBoostReadAhead(waitMs, now = Date.now()) {
    if (waitMs < this.readWaitBoostMs) return;
    if (this.readAhead >= this.maxReadAhead) return;
    if (now - this.lastReadAheadBoostAt < READ_AHEAD_BOOST_COOLDOWN_MS) return;
    this.readAhead = Math.min(this.maxReadAhead, Math.max(this.readAhead + READ_AHEAD_BOOST_SEGMENTS, this.baseReadAhead + READ_AHEAD_BOOST_SEGMENTS));
    this.adaptiveReadAheadUntil = now + READ_AHEAD_BOOST_TTL_MS;
    this.lastReadAheadBoostAt = now;
    this.playbackStats.adaptiveBoosts++;
    this.playbackStats.lastBoostAt = new Date(now).toISOString();
  }

  playbackSnapshot() {
    this._resetExpiredAdaptiveReadAhead();
    return {
      readAhead: this.readAhead,
      baseReadAhead: this.baseReadAhead,
      maxReadAhead: this.maxReadAhead,
      adaptiveUntil: this.adaptiveReadAheadUntil ? new Date(this.adaptiveReadAheadUntil).toISOString() : null,
      cacheSegments: this.cache.size,
      cacheBytes: this.cacheBytes,
      inflightSegments: this.inflight.size,
      ...this.playbackStats,
    };
  }

  async mount(priority = 'startup', opts = {}) {
    if (this.size !== null && this.partSize !== null) return this;
    if (typeof opts !== 'object' || opts === null) opts = {};
    const signal = opts.signal || this.mountSignal || null;
    const t0 = Date.now();
    const first = await this._fetchSegment(0, priority || 'startup', { signal });
    if (this.partSize === null) this.partSize = first.length; // single-part post without =ypart
    if (this.size === null) this.size = first.length * this.segments.length; // worst-case fallback
    this.mountMs = Date.now() - t0;
    return this;
  }

  _segForOffset(offset) {
    return Math.min(Math.floor(offset / this.partSize), this.segments.length - 1);
  }

  _cachePut(i, buf) {
    if (this.cache.has(i)) return;
    if (this.cache.size === 0 && this.cacheOrder.length === 0 && this.cacheBytes !== 0) {
      this.cacheBytes = 0;
    }
    this.cache.set(i, buf);
    this.cacheBytes += buf.length;
    this.cacheOrder.push(i);
    if (this.sharedCacheBudget) this.sharedCacheBudget.add(this, i, buf.length);
    this.trimCache();
  }

  _cacheDrop(i, { fromSharedBudget = false } = {}) {
    const old = this.cache.get(i);
    if (!old) return;
    this.cache.delete(i);
    this.cacheBytes = Math.max(0, this.cacheBytes - old.length);
    if (this.sharedCacheBudget && !fromSharedBudget) this.sharedCacheBudget.remove(this, i);
    if (fromSharedBudget) {
      const orderIndex = this.cacheOrder.indexOf(i);
      if (orderIndex >= 0) this.cacheOrder.splice(orderIndex, 1);
    }
    if (this.cacheOrder.length > this.cache.size * 2 + 32) {
      this.cacheOrder = this.cacheOrder.filter((index) => this.cache.has(index));
    }
  }

  trimCache() {
    while (this.cache.size > 1
        && (this.cache.size > this.cacheMax || this.cacheBytes > this.cacheMaxBytes)) {
      const index = this.cacheOrder.shift();
      if (index === undefined) break;
      this._cacheDrop(index);
    }
  }

  _fetchSegment(i, priority = 'playback', opts = {}) {
    if (this.cache.has(i)) return Promise.resolve(this.cache.get(i));
    const signal = opts.signal || null;
    if (signalAborted(signal)) return Promise.reject(abortError());
    const decodeAndCache = (raw) => {
      const dec = decode(raw);
      if (!dec.crcOk) throw new Error(`segment ${i} CRC mismatch`);
      if (dec.size !== null) this.size = dec.size;
      // A malformed =ypart (begin without a valid end) would yield NaN here and poison ALL
      // offset→segment math (NaN segment indices). Only learn partSize from a sane header.
      if (dec.part && i === 0) {
        const ps = dec.part.end - dec.part.begin;
        if (Number.isFinite(ps) && ps > 0) this.partSize = ps;
      }
      this._cachePut(i, dec.data);
      return dec.data;
    };
    let rec = this.inflight.get(i);
    if (rec && priorityRank(priority) < priorityRank(rec.priority) && priorityRank(priority) <= priorityRank('playback')) {
      return this.pool.body(this.segments[i].msgId, priority, { signal })
        .then(decodeAndCache)
        .catch((e) => {
          if (signalAborted(signal) || e.code === 'ABORT_ERR') throw e;
          return rec.promise;
        });
    }
    if (!rec) {
      const controller = new AbortController();
      rec = { consumers: 0, controller, priority, promise: null };
      rec.promise = this.pool.body(this.segments[i].msgId, priority, { signal: controller.signal }).then((raw) => {
        this.inflight.delete(i);
        return decodeAndCache(raw);
      }).catch((e) => { this.inflight.delete(i); throw e; });
      this.inflight.set(i, rec);
    }
    rec.consumers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      rec.consumers = Math.max(0, rec.consumers - 1);
      if (typeof removeAbort === 'function') removeAbort();
      if (rec.consumers === 0 && this.inflight.get(i) === rec
          && !rec.controller.signal.aborted && signalAborted(signal)) {
        rec.controller.abort();
      }
    };
    let removeAbort = addAbortListener(signal, release);
    return rec.promise.finally(release);
  }

  cancelReadAhead() {
    this.readAheadEpoch++;
  }

  // Read [start, end) — returns an async generator of Buffers, with read-ahead.
  async *read(start, end, opts = {}) {
    if (typeof opts === 'string') opts = { priority: opts };
    const priority = opts.priority || 'playback';
    let activePriority = priority;
    const signal = opts.signal || null;
    // Multiple readers may legitimately touch the same mount at once: the active
    // player, playback warmup, probes, subtitle extraction, or sequential HTTP
    // ranges. Starting one read must not silently disable another reader's
    // future read-ahead; only a true interrupted request/seek calls
    // cancelReadAhead() and advances this epoch.
    const readAheadEpoch = this.readAheadEpoch;
    const aborted = () => !!(signal && signal.aborted);
    if (this.partSize === null) await this.mount(priority);
    end = Math.min(end, this.size);
    let offset = start;
    this.playbackStats.reads++;
    while (offset < end) {
      if (aborted()) return;
      this._resetExpiredAdaptiveReadAhead();
      const segIdx = this._segForOffset(offset);
      // Kick read-ahead (fire and forget).
      if (priority !== 'background' && priority !== 'health' && readAheadEpoch === this.readAheadEpoch && !aborted()) {
        for (let a = 1; a <= this.readAhead; a++) {
          const n = segIdx + a;
          if (n < this.segments.length && !this.cache.has(n) && !this.inflight.has(n)) {
            this._fetchSegment(n, 'readAhead', { signal }).catch(() => {});
          }
        }
      }
      let data;
      const wasCached = this.cache.has(segIdx);
      const waitStart = Date.now();
      try {
        data = await this._fetchSegment(segIdx, activePriority, { signal });
      } catch (e) {
        if (aborted() || e.code === 'ABORT_ERR') return;
        throw e;
      }
      const waitMs = Date.now() - waitStart;
      if (wasCached) this.playbackStats.cacheHits++;
      else {
        this.playbackStats.segmentWaits++;
        this.playbackStats.segmentWaitMs += waitMs;
        this.playbackStats.maxSegmentWaitMs = Math.max(this.playbackStats.maxSegmentWaitMs, waitMs);
        if (activePriority === 'playback') this._maybeBoostReadAhead(waitMs);
      }
      if (activePriority === 'startup' || activePriority === 'seek') activePriority = 'playback';
      if (aborted()) return;
      const segStart = segIdx * this.partSize;
      const from = offset - segStart;
      const to = Math.min(data.length, end - segStart);
      if (from >= to) throw new Error(`read out of range: seg ${segIdx} off ${offset}`);
      this.playbackStats.segmentsServed++;
      this.playbackStats.readBytes += to - from;
      yield data.subarray(from, to);
      offset = segStart + to;
    }
  }

  // Random-access for header parsing: fetches ONLY the segments covering [start, start+len),
  // in parallel, with no read-ahead — header peeks must not flood the pool with prefetch.
  async readAt(start, len, opts = {}) {
    if (typeof opts === 'string') opts = { priority: opts };
    const priority = opts.priority || 'startup';
    const signal = opts.signal || (priority === 'startup' ? this.mountSignal : null);
    if (this.partSize === null) await this.mount(priority, { signal });
    const end = Math.min(start + len, this.size);
    if (start >= end) return Buffer.alloc(0);
    const first = this._segForOffset(start);
    const last = this._segForOffset(end - 1);
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, k) => this._fetchSegment(first + k, priority, { signal }))
    );
    const base = first * this.partSize;
    return Buffer.concat(parts).subarray(start - base, end - base);
  }

  // Health triage: STAT first, last, and N random middle segments in parallel.
  async triage(sampleCount = 6) {
    const idxs = new Set([0, this.segments.length - 1]);
    while (idxs.size < Math.min(sampleCount, this.segments.length)) {
      idxs.add(Math.floor(Math.random() * this.segments.length));
    }
    const results = await Promise.all(
      [...idxs].map((i) => this.pool.stat(this.segments[i].msgId, 'health').catch(() => false))
    );
    const missing = results.filter((ok) => !ok).length;
    this.health = {
      verdict: missing === 0 ? 'verified' : missing >= results.length / 2 ? 'blocked' : 'degraded',
      missing,
      sampled: results.length,
      checkedAt: new Date().toISOString(),
    };
    return this.health;
  }
}

class VirtualFile extends NzbFileStream {
  constructor(pool, nzbXml, opts) {
    const nzb = parseNzb(nzbXml);
    super(pool, pickPrimaryFile(nzb), opts);
  }
}

module.exports = { VirtualFile, NzbFileStream, SharedCacheBudget };

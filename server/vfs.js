'use strict';
// NzbFileStream: one usenet-posted file as a seekable byte stream (segment map + read-ahead).
// VirtualFile: Phase 0 wrapper — an NZB's primary file mounted directly (non-archived posts).
// Offsets come from yEnc =ypart headers; we learn the uniform part size from segment 1 (true
// for virtually all posts) and verify per-fetch.

const { decode } = require('./yenc');
const { parseNzb, pickPrimaryFile, fileNameFromSubject } = require('./nzb');
const crypto = require('crypto');

const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;
// How long an ABORTED in-flight segment BODY may keep draining before its connection is killed.
// NNTP can't cancel a command — killing is the only true abort, and it costs the whole connection
// (TCP+TLS+AUTH to rebuild) plus the partial transfer. A typical article finishes in well under a
// second, lands in the cache (useful on pause/seek-back), and keeps the connection alive for the
// very next seek; only a slow-but-alive trickle runs into this bound (a true stall is killed
// earlier by the per-chunk inactivity timer). See docs-streaming-performance.md.
const ABORT_DRAIN_MS = 4000;
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
    abortDrainMs = ABORT_DRAIN_MS,
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
    this.sliceCache = new Map(); // segIndex -> { from, buf } suffix-only (mid-seek, not a full article)
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
    this.abortDrainMs = abortDrainMs;
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
    this.sliceCache.delete(i);
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

  _rememberSlice(i, from, buf) {
    this.sliceCache.set(i, { from, buf });
    while (this.sliceCache.size > 4) {
      const oldest = this.sliceCache.keys().next().value;
      if (oldest === undefined) break;
      this.sliceCache.delete(oldest);
    }
  }

  _fetchSegment(i, priority = 'playback', opts = {}) {
    if (this.cache.has(i)) return Promise.resolve(this.cache.get(i));
    const signal = opts.signal || null;
    if (signalAborted(signal)) return Promise.reject(abortError());
    const skipDecoded = Math.max(0, Math.floor(Number(opts.skipDecoded) || 0));
    if (skipDecoded > 0) {
      const sl = this.sliceCache.get(i);
      if (sl && sl.from <= skipDecoded) return Promise.resolve(sl.buf.subarray(skipDecoded - sl.from));
    }
    const decodeAndCache = (raw, skip) => {
      const dec = decode(raw, skip > 0 ? { skipDecoded: skip } : undefined);
      if (!dec.crcOk) throw new Error(`segment ${i} CRC mismatch`);
      if (dec.size !== null) this.size = dec.size;
      // A malformed =ypart (begin without a valid end) would yield NaN here and poison ALL
      // offset→segment math (NaN segment indices). Only learn partSize from a sane header.
      if (dec.part && i === 0) {
        const ps = dec.part.end - dec.part.begin;
        if (Number.isFinite(ps) && ps > 0) this.partSize = ps;
      }
      if (skip > 0) {
        this._rememberSlice(i, skip, dec.data);
        return dec.data;
      }
      this._cachePut(i, dec.data);
      return dec.data;
    };
    let rec = this.inflight.get(i);
    if (rec && priorityRank(priority) < priorityRank(rec.priority) && priorityRank(priority) <= priorityRank('playback')) {
      return this.pool.body(this.segments[i].msgId, priority, { signal, drainMs: this.abortDrainMs })
        .then((raw) => decodeAndCache(raw, 0))
        .catch((e) => {
          if (signalAborted(signal) || e.code === 'ABORT_ERR') throw e;
          return rec.promise;
        });
    }
    if (rec && (rec.skipDecoded || 0) > skipDecoded) rec = null;
    if (!rec) {
      const controller = new AbortController();
      rec = { consumers: 0, controller, priority, promise: null, skipDecoded };
      // drainMs: an abort of this fetch while it's ON THE WIRE lets the article finish (into the
      // cache, connection preserved) instead of destroying the connection; a still-queued fetch is
      // dequeued immediately either way. This is what keeps a 4K pause/skip storm from killing the
      // whole pool's connections and lagging the next seek behind a reconnect storm.
      rec.promise = this.pool.body(this.segments[i].msgId, priority, { signal: controller.signal, drainMs: this.abortDrainMs }).then((raw) => {
        this.inflight.delete(i);
        return decodeAndCache(raw, skipDecoded);
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
    // A shared fetch can die with ABORT_ERR through no fault of THIS consumer: it joined a rec
    // whose last previous consumer had already aborted (the drain grace widens that window from
    // milliseconds to seconds). Swallowing that as "aborted" would silently TRUNCATE a live
    // reader's stream mid-file — instead, a consumer whose own signal is still live retries with
    // a fresh fetch (the settled rec has already left this.inflight).
    return rec.promise.then((data) => {
      if (this.cache.has(i)) return data;
      const startedAt = rec.skipDecoded || 0;
      if (startedAt > 0 && skipDecoded > startedAt) return data.subarray(skipDecoded - startedAt);
      return data;
    }).catch((e) => {
      if (e && e.code === 'ABORT_ERR' && !signalAborted(signal)) {
        return this._fetchSegment(i, priority, opts);
      }
      throw e;
    }).finally(release);
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
      const segStart = segIdx * this.partSize;
      const from = offset - segStart;
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
        data = await this._fetchSegment(segIdx, activePriority, {
          signal, skipDecoded: wasCached ? 0 : from,
        });
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
      const startInBuf = this.cache.has(segIdx) ? from : 0;
      const want = Math.min(data.length - startInBuf, end - offset);
      if (want <= 0) throw new Error(`read out of range: seg ${segIdx} off ${offset}`);
      this.playbackStats.segmentsServed++;
      this.playbackStats.readBytes += want;
      yield data.subarray(startInBuf, startInBuf + want);
      offset += want;
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

  // Health triage: STAT `sampleCount` segments in parallel and verdict the sample.
  // Retry-only-missing (SABnzbd 5.1's semantic, adapted to sampling): the probe budget is spent by
  // PRIORITY — known failures first (a 430 can heal via another provider or late propagation),
  // then segments never sampled, then the least-recently-proven. Repeat triages therefore retry
  // the real failures and GROW coverage instead of re-proving the same random picks, while the
  // budget itself is never shrunk — a wide sweep (sampleCount >= segments) still samples
  // everything, so new mid-session rot (takedowns during playback) is found exactly as before.
  async triage(sampleCount = 6) {
    const now = Date.now();
    this._statOkAt = this._statOkAt || new Map(); // segment index -> last proved-at
    this._statMissing = this._statMissing || new Set();
    const want = Math.min(sampleCount, this.segments.length);
    const idxs = new Set();
    for (const i of [0, this.segments.length - 1]) if (!this._statOkAt.has(i)) idxs.add(i);
    for (const i of this._statMissing) { if (idxs.size >= want) break; idxs.add(i); }
    // Random sample WITHOUT replacement: guarded random draws could under-fill the budget on an
    // unlucky run (a triage that probes 3 of its 4 slots skews the verdict math and flakes).
    if (idxs.size < want) {
      const unproven = [];
      for (let i = 0; i < this.segments.length; i++) {
        if (!this._statOkAt.has(i) && !this._statMissing.has(i) && !idxs.has(i)) unproven.push(i);
      }
      while (idxs.size < want && unproven.length) {
        idxs.add(unproven.splice(Math.floor(Math.random() * unproven.length), 1)[0]);
      }
    }
    if (idxs.size < want) {
      const byAge = [...this._statOkAt.entries()].filter(([i]) => !idxs.has(i)).sort((a, b) => a[1] - b[1]);
      for (const [i] of byAge) { if (idxs.size >= want) break; idxs.add(i); }
    }
    const list = [...idxs];
    const results = await Promise.all(
      list.map((i) => this.pool.stat(this.segments[i].msgId, 'health').catch(() => false))
    );
    results.forEach((ok, k) => {
      if (ok) { this._statOkAt.set(list[k], now); this._statMissing.delete(list[k]); }
      else { this._statMissing.add(list[k]); this._statOkAt.delete(list[k]); }
    });
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

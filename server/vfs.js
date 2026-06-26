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
  constructor(pool, fileEntry, { readAhead = 4, cacheSegments = 24, cacheBytes = DEFAULT_CACHE_BYTES } = {}) {
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
    this.inflight = new Map(); // segIndex -> Promise<Buffer>
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
    this.trimCache();
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

  async mount(priority = 'startup') {
    if (this.size !== null && this.partSize !== null) return this;
    const t0 = Date.now();
    const first = await this._fetchSegment(0, priority || 'startup');
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
    this.trimCache();
  }

  _cacheDrop(i) {
    const old = this.cache.get(i);
    if (!old) return;
    this.cache.delete(i);
    this.cacheBytes = Math.max(0, this.cacheBytes - old.length);
  }

  trimCache() {
    while (this.cacheOrder.length > 1
        && (this.cacheOrder.length > this.cacheMax || this.cacheBytes > this.cacheMaxBytes)) {
      this._cacheDrop(this.cacheOrder.shift());
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
      if (dec.part && i === 0) this.partSize = dec.part.end - dec.part.begin;
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
    if (this.partSize === null) await this.mount(priority);
    const end = Math.min(start + len, this.size);
    if (start >= end) return Buffer.alloc(0);
    const first = this._segForOffset(start);
    const last = this._segForOffset(end - 1);
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, k) => this._fetchSegment(first + k, priority))
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

module.exports = { VirtualFile, NzbFileStream };

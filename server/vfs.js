'use strict';
// NzbFileStream: one usenet-posted file as a seekable byte stream (segment map + read-ahead).
// VirtualFile: Phase 0 wrapper — an NZB's primary file mounted directly (non-archived posts).
// Offsets come from yEnc =ypart headers; we learn the uniform part size from segment 1 (true
// for virtually all posts) and verify per-fetch.

const { decode } = require('./yenc');
const { parseNzb, pickPrimaryFile, fileNameFromSubject } = require('./nzb');
const crypto = require('crypto');

class NzbFileStream {
  constructor(pool, fileEntry, { readAhead = 4, cacheSegments = 24 } = {}) {
    this.pool = pool;
    this.file = fileEntry;
    this.name = fileNameFromSubject(fileEntry.subject);
    this.id = crypto.randomBytes(6).toString('hex');
    this.segments = fileEntry.segments;
    this.size = null;       // learned from =ybegin size=
    this.partSize = null;   // learned from segment 1 (=ypart end - begin)
    this.readAhead = readAhead;
    this.cache = new Map(); // segIndex -> Buffer (decoded)
    this.cacheOrder = [];
    this.cacheMax = cacheSegments;
    this.inflight = new Map(); // segIndex -> Promise<Buffer>
    this.readAheadEpoch = 0;
    this.health = { verdict: 'unverified', checkedAt: null, missing: 0, sampled: 0 };
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
    this.cache.set(i, buf);
    this.cacheOrder.push(i);
    while (this.cacheOrder.length > this.cacheMax) {
      const evict = this.cacheOrder.shift();
      this.cache.delete(evict);
    }
  }

  _fetchSegment(i, priority = 'playback') {
    if (this.cache.has(i)) return Promise.resolve(this.cache.get(i));
    if (this.inflight.has(i)) return this.inflight.get(i);
    const p = this.pool.body(this.segments[i].msgId, priority).then((raw) => {
      const dec = decode(raw);
      if (!dec.crcOk) throw new Error(`segment ${i} CRC mismatch`);
      if (dec.size !== null) this.size = dec.size;
      if (dec.part && i === 0) this.partSize = dec.part.end - dec.part.begin;
      this.inflight.delete(i);
      this._cachePut(i, dec.data);
      return dec.data;
    }).catch((e) => { this.inflight.delete(i); throw e; });
    this.inflight.set(i, p);
    return p;
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
    const readAheadEpoch = ++this.readAheadEpoch;
    const aborted = () => !!(signal && signal.aborted);
    if (this.partSize === null) await this.mount(priority);
    end = Math.min(end, this.size);
    let offset = start;
    while (offset < end) {
      if (aborted()) return;
      const segIdx = this._segForOffset(offset);
      // Kick read-ahead (fire and forget).
      if (readAheadEpoch === this.readAheadEpoch && !aborted()) {
        for (let a = 1; a <= this.readAhead; a++) {
          const n = segIdx + a;
          if (n < this.segments.length && !this.cache.has(n) && !this.inflight.has(n)) {
            this._fetchSegment(n, 'readAhead').catch(() => {});
          }
        }
      }
      const data = await this._fetchSegment(segIdx, activePriority);
      if (activePriority === 'startup' || activePriority === 'seek') activePriority = 'playback';
      if (aborted()) return;
      const segStart = segIdx * this.partSize;
      const from = offset - segStart;
      const to = Math.min(data.length, end - segStart);
      if (from >= to) throw new Error(`read out of range: seg ${segIdx} off ${offset}`);
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

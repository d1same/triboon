'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { NzbFileStream } = require('../server/vfs');
const { parseRarVolumes } = require('../server/rar');
const { MkvSubtitleTap } = require('../server/mkvsubs');
const { SegmentDiskCache } = require('../server/segment-cache');
const { Pipeline } = require('../server/pipeline');
const { encodePart } = require('../server/yenc');

test('wave1: vfs.read starts active segment before read-ahead so read-ahead is not self-aborted', async () => {
  let abortedCount = 0;
  const segSize = 1024;
  const rawById = new Map();
  for (let n = 1; n <= 4; n++) {
    const begin = (n - 1) * segSize;
    rawById.set(`seg${n}@test`, encodePart(Buffer.alloc(segSize, 0x40 + n), {
      name: 'test.mkv', totalSize: segSize * 4, part: n, totalParts: 4, begin,
    }));
  }
  const fakePool = {
    body(msgId, _priority, opts = {}) {
      const k = String(msgId || '').replace(/[<>]/g, '');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(rawById.get(k)), 15);
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            abortedCount++;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }
      });
    },
  };
  const nzbFile = {
    subject: 'test.mkv',
    filename: 'test.mkv',
    segments: [1, 2, 3, 4].map((n) => ({ number: n, bytes: segSize, msgId: `seg${n}@test` })),
  };
  const vf = new NzbFileStream(fakePool, nzbFile, { readAhead: 2 });
  vf.size = segSize * 4;
  vf.partSize = segSize;
  const callOrder = [];
  const origFetch = vf._fetchSegment.bind(vf);
  vf._fetchSegment = (idx, prio, opts) => {
    callOrder.push({ idx, prio });
    return origFetch(idx, prio, opts);
  };
  let got = 0;
  for await (const chunk of vf.read(0, segSize, { priority: 'playback' })) {
    got += chunk.length;
  }
  assert.equal(got, segSize);
  assert.equal(callOrder[0].idx, 0, 'segment 0 must start before read-ahead segments');
  assert.equal(callOrder[0].prio, 'playback');
  assert.ok(callOrder.slice(1).some((c) => c.idx === 1 && c.prio === 'readAhead'), 'read-ahead for seg 1 kicked after seg 0');
  assert.equal(abortedCount, 0, 'read-ahead queued by read() must not be self-aborted');
});

test('wave1: rar4 stops reading after splitAfter file header (no tail fetch on non-final volumes)', async () => {
  const fname = Buffer.from('movie.mkv');
  const fileHdrSize = 32 + fname.length;
  const packSize = 500000;
  const rar4 = Buffer.alloc(7 + 13 + fileHdrSize);
  Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]).copy(rar4, 0);
  rar4[7 + 2] = 0x73;
  rar4.writeUInt16LE(13, 7 + 5);
  const fOff = 20;
  rar4[fOff + 2] = 0x74;
  rar4.writeUInt16LE(0x8002, fOff + 3); // LONG_BLOCK | SPLIT_AFTER
  rar4.writeUInt16LE(fileHdrSize, fOff + 5);
  rar4.writeUInt32LE(packSize, fOff + 7);
  rar4.writeUInt32LE(packSize * 3, fOff + 11);
  rar4[fOff + 25] = 0x30; // store
  rar4.writeUInt16LE(fname.length, fOff + 26);
  fname.copy(rar4, fOff + 32);

  let readCalls = 0;
  const starts = [];
  const fakeVol = {
    size: 7 + 13 + fileHdrSize + packSize + 64,
    async readAt(start, len) {
      readCalls++;
      starts.push(start);
      const out = Buffer.alloc(len);
      if (start < rar4.length) rar4.copy(out, 0, start, Math.min(rar4.length, start + len));
      return out;
    },
  };
  const parsed = await parseRarVolumes([fakeVol]);
  assert.equal(parsed.version, 4);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].name, 'movie.mkv');
  assert.ok(starts.every((s) => s < 1024), `no seek past packSize to volume tail (got starts=${starts.join(',')})`);
});

test('wave1: mkvsubs marks noTextSubs when header has no text subtitle tracks', () => {
  const tap = new MkvSubtitleTap({ onCue() {} });
  const trackBody = Buffer.from([0xD7, 0x81, 0x01, 0x83, 0x81, 0x01]);
  const trackEntry = Buffer.concat([Buffer.from([0xAE, 0x80 | trackBody.length]), trackBody]);
  const tracks = Buffer.concat([Buffer.from([0x16, 0x54, 0xAE, 0x6B, 0x80 | trackEntry.length]), trackEntry]);
  const cluster = Buffer.from([0x1F, 0x43, 0xB6, 0x75, 0x81, 0x00]);
  const header = Buffer.concat([
    Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    tracks,
    cluster,
  ]);
  tap.feed(0, header);
  assert.equal(tap.noTextSubs, true, 'MKV with no text subtitle tracks must set noTextSubs = true');
  assert.equal(tap.cursors.length, 0, 'cursors must be cleared when noTextSubs is set');
});

test('wave1: segment disk cache updates LRU order on get() hits so hot entries survive eviction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-w1-cache-'));
  try {
    const cache = new SegmentDiskCache({ dir, maxBytes: 1024 * 1024, enabled: true });
    const bufA = Buffer.alloc(400 * 1024, 0x11);
    const bufB = Buffer.alloc(400 * 1024, 0x22);
    const bufC = Buffer.alloc(400 * 1024, 0x33);
    cache.put('a@test', bufA);
    cache.put('b@test', bufB);
    await cache.flush();
    const hitA = await cache.get('a@test');
    assert.ok(hitA && hitA.data && hitA.data.length === bufA.length, 'entry A must be readable');
    cache.put('c@test', bufC);
    await cache.flush();
    const keys = [...cache.index.keys()];
    assert.equal(keys.length, 2, 'eviction must keep only 2 entries within 1MB cap');
    const hitA2 = await cache.get('a@test');
    const hitB2 = await cache.get('b@test');
    assert.ok(hitA2 && hitA2.data.length === bufA.length, 'hot entry A must survive LRU eviction');
    assert.equal(hitB2, null, 'cold entry B must be evicted first');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wave1: 4K prepare on 1080p-only title reuses warmed mount on Play without destroying it', () => {
  const mounts = new Map();
  const pipeline = new Pipeline({
    pool: () => null,
    verdicts: { get: () => null, set: () => {} },
    mounts,
  });
  const hd = { id: 'house-1080', size: 2e9, streamable: true, tags: [] };
  mounts.set(hd.id, hd);
  const params = { q: 'House S04E06', tvdbid: '73255', season: 4, ep: 6 };
  const policy4 = { exactResolutionRank: 4, preferResolutionRank: 4, maxResolutionRank: 4 };
  const cand = { name: 'House.S04E06.1080p.WEB-DL.DDP5.1-NTb', pickKey: 'h4' };
  const remPolicy = pipeline._rememberPolicyForCandidate(policy4, cand);
  pipeline._rememberTitlePrepared(params, remPolicy, hd, cand);
  pipeline._rememberTitlePrepared(params, policy4, hd, cand, { noHigherRank: true });
  const dropped = pipeline.forgetMismatchedPrepared(params, policy4);
  assert.equal(dropped, 0, 'forgetMismatchedPrepared must not destroy its own widened 1080p mount');
  assert.ok(mounts.has(hd.id), 'warmed mount must still exist');
  const ready = pipeline._findTitlePreparedReady(params, policy4);
  assert.ok(ready && ready.vf === hd, '4K Play must join the widened 1080p prepared mount immediately');
});

test('wave1: _parseNzbCached memoizes parsed NZB and invalidates when XML changes', () => {
  const pipeline = new Pipeline({
    pool: () => null,
    verdicts: { get: () => null, set: () => {} },
    mounts: new Map(),
  });
  const xml1 = '<?xml version="1.0"?><nzb><file poster="p" date="1" subject="a.mkv (1/1)"><groups><group>alt.bin</group></groups><segments><segment bytes="100" number="1">m1@t</segment></segments></file></nzb>';
  const p1 = pipeline._parseNzbCached('http://ix/1.nzb', xml1);
  const p2 = pipeline._parseNzbCached('http://ix/1.nzb', xml1);
  assert.strictEqual(p1, p2, 'identical XML must return memoized parsed NZB');
  const xml2 = xml1.replace('m1@t', 'm2@t');
  const p3 = pipeline._parseNzbCached('http://ix/1.nzb', xml2);
  assert.notStrictEqual(p1, p3, 'changed XML must re-parse');
});

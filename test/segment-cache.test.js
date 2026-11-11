'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodePart } = require('../server/yenc');
const { NzbFileStream } = require('../server/vfs');
const { NntpPool } = require('../server/nntp');
const { mountNzb } = require('../server/archive');
const { createMockNntp } = require('./mock-nntp');
const { seededPayload, writeRar4Store } = require('./archive-fixtures');
const {
  SegmentDiskCache, configureSegmentDisk, getSegmentDisk,
} = require('../server/segment-cache');
const { NzbStore, configureNzbStore } = require('../server/nzb-store');
const { MountMapStore, configureMountMap } = require('../server/mount-map');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-seg-'));
}

function makeFlatNzb(name, data, partSize) {
  const articles = new Map();
  const totalParts = Math.ceil(data.length / partSize) || 1;
  const segs = [];
  for (let p = 0; p < totalParts; p++) {
    const begin = p * partSize;
    const end = Math.min(data.length, begin + partSize);
    const body = encodePart(data, {
      name, partNum: p + 1, totalParts, begin, end, totalSize: data.length,
    });
    const msgId = `flat${p + 1}@triboon.test`;
    articles.set(msgId, body);
    segs.push(`<segment bytes="${body.length}" number="${p + 1}">${msgId}</segment>`);
  }
  const nzb = `<?xml version="1.0"?>\n<nzb><file poster="t" date="1" subject="[r] &quot;${name}&quot; yEnc (1/${totalParts})"><groups><group>alt.binaries.test</group></groups><segments>${segs.join('')}</segments></file></nzb>`;
  return { articles, nzb };
}

function makeArchiveNzb(volumes, partSize) {
  const articles = new Map();
  const fileXml = [];
  let fileNo = 0;
  for (const v of volumes) {
    fileNo++;
    const totalParts = Math.ceil(v.data.length / partSize) || 1;
    const segs = [];
    for (let p = 0; p < totalParts; p++) {
      const begin = p * partSize;
      const end = Math.min(v.data.length, begin + partSize);
      const body = encodePart(v.data, {
        name: v.name, partNum: p + 1, totalParts, begin, end, totalSize: v.data.length,
      });
      const msgId = `arc${fileNo}s${p + 1}@triboon.test`;
      articles.set(msgId, body);
      segs.push(`<segment bytes="${body.length}" number="${p + 1}">${msgId}</segment>`);
    }
    fileXml.push(`<file poster="t" date="1" subject="[r] &quot;${v.name}&quot; yEnc (1/${totalParts})"><groups><group>alt.binaries.test</group></groups><segments>${segs.join('')}</segments></file>`);
  }
  return { articles, nzb: `<?xml version="1.0"?>\n<nzb>\n${fileXml.join('\n')}\n</nzb>` };
}

function bodyTotal(mock, articles) {
  let n = 0;
  for (const id of articles.keys()) n += mock.bodyCount(id);
  return n;
}

test('segment cache stays quiet when it is off', async () => {
  const dir = tmpDir();
  const cache = new SegmentDiskCache({ dir, enabled: false, maxBytes: 1024 });
  cache.put('off@test', Buffer.from('nope'));
  await cache.flush();
  assert.equal(await cache.get('off@test'), null);
  assert.equal(fs.existsSync(path.join(dir, 'index.json')), false);
  await cache.clear();
});

test('segment cache returns a decoded article and drops the oldest when the lid is full', async () => {
  const dir = tmpDir();
  const cache = new SegmentDiskCache({ dir, enabled: true, maxBytes: 100 });
  const a = Buffer.alloc(60, 1);
  const b = Buffer.alloc(60, 2);
  const c = Buffer.alloc(60, 3);
  cache.put('<one@test>', a, { size: 60, partSize: 60 });
  cache.put('two@test', b, { size: 60, partSize: 60 });
  cache.put('three@test', c, { size: 60, partSize: 60 });
  await cache.flush();
  const stats = cache.stats();
  assert.ok(stats.bytes <= 100, `kept ${stats.bytes} bytes over a 100 byte lid`);
  assert.ok(stats.evictions >= 1);
  const hit = await cache.get('three@test');
  assert.ok(hit && hit.data.equals(c));
  assert.equal(hit.partSize, 60);
  await cache.clear();
  assert.equal(await cache.get('three@test'), null);
  assert.equal(cache.stats().bytes, 0);
});

test('segment cache keeps a pinned spot when the lid drops older pieces', async () => {
  const dir = tmpDir();
  const cache = new SegmentDiskCache({ dir, enabled: true, maxBytes: 500 });
  const old = Buffer.alloc(80, 1);
  const pinned = Buffer.alloc(80, 2);
  const newer = Buffer.alloc(80, 3);
  const newest = Buffer.alloc(280, 4);
  cache.put('old@test', old);
  cache.put('spot@test', pinned, { pin: true });
  cache.put('new@test', newer);
  cache.put('big@test', newest);
  await cache.flush();
  assert.ok(await cache.get('spot@test'), 'the place you stopped stays');
  assert.equal(await cache.get('old@test'), null, 'an older unpinned piece is the one that goes');
  await cache.clear();
});

test('nzb xml is saved without putting the grab url in the filename', async () => {
  const dir = tmpDir();
  const store = new NzbStore(dir);
  const url = 'https://indexer.example/get?t=get&apikey=SECRET&id=1';
  const xml = '<?xml version="1.0"?><nzb><file subject="a"><segments><segment>a@b</segment></segments></file></nzb>';
  store.put(url, xml);
  let got = null;
  for (let i = 0; i < 20 && !got; i++) {
    got = await store.get(url);
    if (!got) await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(got, xml);
  const names = fs.readdirSync(dir);
  assert.ok(names.every((name) => !name.includes('SECRET') && !name.includes('http')));
});

test('a second mount of the same rar does not ask usenet for the headers again', async () => {
  const dir = tmpDir();
  const payload = seededPayload(80 * 1024);
  const volumes = writeRar4Store([{ name: 'Movie.mkv', data: payload }]);
  const { articles, nzb } = makeArchiveNzb(volumes, 32 * 1024);
  configureMountMap(path.join(dir, 'maps'));
  configureSegmentDisk({ dir: path.join(dir, 'segs'), enabled: true, maxBytes: 50 * 1024 * 1024 });
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 4);
  try {
    const first = await mountNzb(pool, nzb);
    const once = [];
    for await (const chunk of first.read(0, first.size)) once.push(chunk);
    const movie = Buffer.concat(once);
    assert.ok(movie.equals(payload));
    await getSegmentDisk().flush();
    const fetched = bodyTotal(mock, articles);
    assert.ok(fetched > 0);

    const second = await mountNzb(pool, nzb);
    const again = [];
    for await (const chunk of second.read(0, second.size)) again.push(chunk);
    assert.ok(Buffer.concat(again).equals(payload));
    assert.equal(bodyTotal(mock, articles), fetched, 'the repeat play asked Usenet for articles it already had');

    const saved = fs.readdirSync(path.join(dir, 'maps')).find((name) => /^[a-f0-9]{64}$/.test(name));
    const raw = fs.readFileSync(path.join(dir, 'maps', saved), 'utf8');
    assert.equal(raw.includes('password'), false);
  } finally {
    pool.close();
    await mock.close();
    configureMountMap(null);
    configureSegmentDisk({ enabled: false });
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// Review R7: a post that counts =ypart offsets from 0 learns that origin from piece 1's header. A
// replay from the saved archive map never reads that header, so the map carries the origin too.
test('a replay from the saved archive map still reads a post whose =ypart offsets count from 0', async () => {
  const dir = tmpDir();
  const payload = seededPayload(150 * 1024, 0x2e70);
  const volumes = writeRar4Store([{ name: 'Zero.Movie.mkv', data: payload }], { volSize: 60 * 1024, naming: 'part', base: 'zero' });
  const { articles, nzb } = makeArchiveNzb(volumes, 16 * 1024);
  for (const [id, body] of articles) {
    articles.set(id, Buffer.from(body.toString('latin1').replace(/=ypart begin=(\d+) end=(\d+)/,
      (_, b, e) => `=ypart begin=${+b - 1} end=${+e - 1}`), 'latin1'));
  }
  configureMountMap(path.join(dir, 'maps'));
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 4);
  const readAll = async (vf) => { const out = []; for await (const c of vf.read(0, vf.size)) out.push(c); return Buffer.concat(out); };
  try {
    const first = await mountNzb(pool, nzb);
    assert.ok((await readAll(first)).equals(payload), 'the first mount reads identical bytes');
    await new Promise((r) => setTimeout(r, 50));
    const before = bodyTotal(mock, articles);
    const second = await mountNzb(pool, nzb);
    assert.strictEqual(bodyTotal(mock, articles), before, 'precondition: the second mount came from the saved map');
    assert.ok((await readAll(second)).equals(payload), 'the replay from the saved map reads identical bytes');
    assert.strictEqual(second.deadPieceCount(), 0, 'and nothing is marked dead');
  } finally {
    pool.close();
    await mock.close();
    configureMountMap(null);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// B06B-01 (E2-2): the saved map was keyed by the NZB text only, so a season pack in ONE archive
// set replayed the first episode ever played from it for every later episode (also after a restart).
test('the saved archive map is scoped by episode: a season pack mounts the asked episode, also after a restart', async () => {
  const { writeZipStore } = require('./archive-fixtures');
  const e1 = seededPayload(70 * 1024, 0x1111);
  const e2 = seededPayload(70 * 1024, 0x2222);
  const files = [{ name: 'Show.S01E01.mkv', data: e1 }, { name: 'Show.S01E02.mkv', data: e2 }];
  const sets = {
    rar4: writeRar4Store(files),
    zip: [{ name: 'Show.S01.zip', data: writeZipStore(files) }],
  };
  for (const [kind, volumes] of Object.entries(sets)) {
    const dir = tmpDir();
    const mapsDir = path.join(dir, 'maps');
    const { articles, nzb } = makeArchiveNzb(volumes, 32 * 1024);
    configureMountMap(mapsDir);
    const mock = createMockNntp({ articles });
    const port = await mock.listen();
    const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 4);
    const readAll = async (vf) => { const out = []; for await (const c of vf.read(0, vf.size)) out.push(c); return Buffer.concat(out); };
    try {
      const first = await mountNzb(pool, nzb, { wantedEpisode: { s: 1, e: 1 } });
      assert.match(first.name, /S01E01/, `${kind}: precondition`);
      assert.ok((await readAll(first)).equals(e1));
      const second = await mountNzb(pool, nzb, { wantedEpisode: { s: 1, e: 2 } });
      assert.match(second.name, /S01E02/, `${kind}: the second episode mounts E02, not the saved E01`);
      assert.ok((await readAll(second)).equals(e2), `${kind}: E02 bytes`);
      // A fresh store over the same folder is the restart case.
      await new Promise((r) => setTimeout(r, 50));
      configureMountMap(mapsDir);
      const restarted = await mountNzb(pool, nzb, { wantedEpisode: { s: 1, e: 2 } });
      assert.match(restarted.name, /S01E02/, `${kind}: after a restart E02 still mounts E02`);
      assert.ok((await readAll(restarted)).equals(e2), `${kind}: E02 bytes after a restart`);
      const again = await mountNzb(pool, nzb, { wantedEpisode: { s: 1, e: 1 } });
      assert.match(again.name, /S01E01/, `${kind}: E01 still mounts E01`);
    } finally {
      pool.close();
      await mock.close();
      configureMountMap(null);
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
});

test('a cold file stream reads a decoded article from disk instead of usenet', async () => {
  const dir = tmpDir();
  configureSegmentDisk({ dir, enabled: true, maxBytes: 8 * 1024 * 1024 });
  const data = seededPayload(48 * 1024);
  const { articles } = makeFlatNzb('Plain.mkv', data, 24 * 1024);
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 2);
  const file = {
    subject: '"Plain.mkv" yEnc (1/2)',
    segments: [...articles.keys()].map((msgId) => ({ msgId, bytes: articles.get(msgId).length })),
  };
  try {
    const first = new NzbFileStream(pool, file, { readAhead: 0, cacheSegments: 8, cacheBytes: 1024 * 1024 });
    await first.mount();
    const chunks = [];
    for await (const chunk of first.read(0, first.size)) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).equals(data));
    await getSegmentDisk().flush();
    const fetched = bodyTotal(mock, articles);

    const second = new NzbFileStream(pool, file, { readAhead: 0, cacheSegments: 8, cacheBytes: 1024 * 1024 });
    await second.mount();
    const again = [];
    for await (const chunk of second.read(0, second.size)) again.push(chunk);
    assert.ok(Buffer.concat(again).equals(data));
    assert.equal(bodyTotal(mock, articles), fetched);
    assert.ok((second.playbackStats.diskHits || 0) > 0);
  } finally {
    pool.close();
    await mock.close();
    configureSegmentDisk({ enabled: false });
    configureNzbStore(null);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// Review R7: a post that counts =ypart offsets from 0 learns that origin from piece 1's header. When
// piece 1 comes back from the disk closet on a later mount, the header is gone, so the closet keeps
// the origin next to partSize; otherwise the next network piece is refused as misplaced.
test('a cold mount whose first article comes from disk still reads a post that counts offsets from 0', async () => {
  const dir = tmpDir();
  configureSegmentDisk({ dir, enabled: true, maxBytes: 8 * 1024 * 1024 });
  const data = seededPayload(72 * 1024, 0x2e71);
  const { articles } = makeFlatNzb('Zero.mkv', data, 24 * 1024);
  for (const [id, body] of articles) {
    articles.set(id, Buffer.from(body.toString('latin1').replace(/=ypart begin=(\d+) end=(\d+)/,
      (_, b, e) => `=ypart begin=${+b - 1} end=${+e - 1}`), 'latin1'));
  }
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 2);
  const file = {
    subject: '"Zero.mkv" yEnc (1/3)',
    segments: [...articles.keys()].map((msgId) => ({ msgId, bytes: articles.get(msgId).length })),
  };
  try {
    const first = new NzbFileStream(pool, file, { readAhead: 0, cacheSegments: 8, cacheBytes: 1024 * 1024 });
    await first.mount(); // piece 1 only: it goes to the disk closet
    await getSegmentDisk().flush();
    const before = bodyTotal(mock, articles);
    const second = new NzbFileStream(pool, file, { readAhead: 0, cacheSegments: 8, cacheBytes: 1024 * 1024 });
    await second.mount();
    assert.strictEqual(bodyTotal(mock, articles), before, 'precondition: piece 1 came from disk');
    const again = [];
    for await (const chunk of second.read(0, second.size)) again.push(chunk);
    assert.ok(Buffer.concat(again).equals(data), 'pieces 2 and 3 from usenet read identical bytes');
    assert.strictEqual(second.deadPieceCount(), 0);
  } finally {
    pool.close();
    await mock.close();
    configureSegmentDisk({ enabled: false });
    configureNzbStore(null);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// Review R8: records written by an older version carry no partOrigin. A missing field must leave the
// grid open (the first later piece decides), never lock "counts from 1": an older version played a
// 0-based post and saved its record, and the replay after the upgrade must still play it.
function zeroBase(articles, { extraShiftId = null } = {}) {
  for (const [id, body] of articles) {
    const more = id === extraShiftId ? 1 : 0;
    articles.set(id, Buffer.from(body.toString('latin1').replace(/=ypart begin=(\d+) end=(\d+)/,
      (_, b, e) => `=ypart begin=${+b - 1 - more} end=${+e - 1 - more}`), 'latin1'));
  }
  return articles;
}
// The closet's loaded index, as an older version wrote it (no partOrigin field on any record).
function stripDiskOrigins() {
  for (const rec of getSegmentDisk().index.values()) delete rec.partOrigin;
}
test('R8: an old disk record without partOrigin replays 0-based and 1-based posts, and still refuses a misplaced piece', async () => {
  const run = async (shape) => {
    const dir = tmpDir();
    configureSegmentDisk({ dir, enabled: true, maxBytes: 8 * 1024 * 1024 });
    const data = seededPayload(72 * 1024, 0x2e72);
    // Own message ids: the closet is one process-wide store, and makeFlatNzb reuses its ids.
    const articles = new Map([...makeFlatNzb(`Old${shape}.mkv`, data, 24 * 1024).articles].map(([id, b]) => [`r8${shape}-${id}`, b]));
    if (shape !== 'one') zeroBase(articles, { extraShiftId: shape === 'misplaced' ? `r8${shape}-flat3@triboon.test` : null });
    const mock = createMockNntp({ articles });
    const port = await mock.listen();
    const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 2);
    const file = {
      subject: `"Old${shape}.mkv" yEnc (1/3)`,
      segments: [...articles.keys()].map((msgId) => ({ msgId, bytes: articles.get(msgId).length })),
    };
    try {
      const first = new NzbFileStream(pool, file, { readAhead: 0, cacheSegments: 8, cacheBytes: 1024 * 1024 });
      await first.mount();
      await getSegmentDisk().flush();
      assert.ok([...getSegmentDisk().index.values()].length >= 1, `${shape}: precondition: piece 1 is in the closet`);
      stripDiskOrigins(); // what an older version wrote
      const before = bodyTotal(mock, articles);
      const second = new NzbFileStream(pool, file, { readAhead: 0, cacheSegments: 8, cacheBytes: 1024 * 1024 });
      await second.mount();
      assert.strictEqual(bodyTotal(mock, articles), before, `${shape}: precondition: piece 1 came from the old disk record`);
      try {
        const out = [];
        for await (const chunk of second.read(0, second.size)) out.push(chunk);
        return { bytes: Buffer.concat(out), data, dead: second.deadPieceCount() };
      } catch (err) { return { err, data, dead: second.deadPieceCount() }; }
    } finally {
      pool.close();
      await mock.close();
      configureSegmentDisk({ enabled: false });
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  };
  const zero = await run('zero');
  assert.ok(zero.bytes && zero.bytes.equals(zero.data), `0-based post: identical bytes (${zero.err && zero.err.message})`);
  assert.strictEqual(zero.dead, 0);
  const one = await run('one');
  assert.ok(one.bytes && one.bytes.equals(one.data), `1-based post: unchanged (${one.err && one.err.message})`);
  assert.strictEqual(one.dead, 0);
  const bad = await run('misplaced');
  assert.strictEqual(bad.err && bad.err.code, 'MISPLACED', 'a really misplaced piece is still refused');
});

test('R8: an old saved archive map without partOrigin still replays a 0-based post', async () => {
  for (const shape of ['zero', 'one']) {
    const dir = tmpDir();
    const mapsDir = path.join(dir, 'maps');
    const payload = seededPayload(150 * 1024, 0x2e73);
    const volumes = writeRar4Store([{ name: `OldMap.${shape}.mkv`, data: payload }], { volSize: 60 * 1024, naming: 'part', base: `oldmap${shape}` });
    const { articles, nzb } = makeArchiveNzb(volumes, 16 * 1024);
    if (shape === 'zero') zeroBase(articles);
    configureMountMap(mapsDir);
    const mock = createMockNntp({ articles });
    const port = await mock.listen();
    const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 4);
    const readAll = async (vf) => { const out = []; for await (const c of vf.read(0, vf.size)) out.push(c); return Buffer.concat(out); };
    try {
      await mountNzb(pool, nzb);
      await new Promise((r) => setTimeout(r, 50));
      const saved = fs.readdirSync(mapsDir).filter((n) => /^[a-f0-9]{64}$/.test(n));
      assert.ok(saved.length >= 1, 'precondition: a map was saved');
      for (const n of saved) {
        const rec = JSON.parse(fs.readFileSync(path.join(mapsDir, n), 'utf8'));
        for (const v of rec.volumes || []) delete v.partOrigin; // what an older version wrote
        fs.writeFileSync(path.join(mapsDir, n), JSON.stringify(rec));
      }
      configureMountMap(mapsDir); // restart: no in-memory copy
      const before = bodyTotal(mock, articles);
      const replay = await mountNzb(pool, nzb);
      assert.strictEqual(bodyTotal(mock, articles), before, `${shape}: precondition: the replay came from the old map`);
      assert.ok((await readAll(replay)).equals(payload), `${shape}: identical bytes from an old map`);
      assert.strictEqual(replay.deadPieceCount(), 0, `${shape}: nothing marked dead`);
    } finally {
      pool.close();
      await mock.close();
      configureMountMap(null);
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
});

test('the same movie shape is remembered without probing again', () => {
  const { recallProbe, rememberProbe, probeCacheKey } = require('../server/transcode');
  const key = probeCacheKey('Pin.Probe.Movie.mkv', 123456789);
  const probe = { duration: 90, audio: [{ index: 0 }] };
  rememberProbe(key, probe);
  assert.deepEqual(recallProbe(key), probe);
  assert.equal(recallProbe(probeCacheKey('', 1)), null);
});

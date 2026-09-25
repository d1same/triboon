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

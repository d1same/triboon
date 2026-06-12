'use strict';
// Phase 1 golden corpus: streaming RAR/ZIP with seeking, archive detection verdicts,
// multi-provider failover. Written BEFORE the implementation (CLAUDE.md working process).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { encodePart } = require('../server/yenc');
const { seededPayload, writeRar4Store, writeRar5Store, writeZipStore } = require('./archive-fixtures');
const { parseRarVolumes } = require('../server/rar');
const { parseZip } = require('../server/zip');
const { detectContainer, orderVolumes, mountNzb } = require('../server/archive');
const { parseNzb, nzbPassword } = require('../server/nzb');
const { NntpPool } = require('../server/nntp');
const { createMockNntp } = require('./mock-nntp');

const PAYLOAD = seededPayload(300 * 1024);
const loadFix = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'real', name));
const memVol = (buf, name = 'mem.rar') => ({
  name, size: buf.length,
  readAt: async (off, len) => buf.subarray(off, Math.min(off + len, buf.length)),
});

async function reassemble(parsedFile, volBufs) {
  const parts = [];
  for (const e of parsedFile.extents) parts.push(volBufs[e.vol].subarray(e.offset, e.offset + e.length));
  return Buffer.concat(parts);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Build an NZB + mock articles from archive volumes (one usenet "file" per volume), with
// par2/nfo junk thrown in to prove the volume-set collector ignores them.
function makeArchiveNzb(volumes, partSize, { junk = true } = {}) {
  const articles = new Map();
  const fileXml = [];
  let fileNo = 0;
  const addFile = (name, data) => {
    fileNo++;
    const totalParts = Math.ceil(data.length / partSize) || 1;
    const segs = [];
    for (let p = 0; p < totalParts; p++) {
      const begin = p * partSize;
      const end = Math.min(data.length, begin + partSize);
      const body = encodePart(data, { name, partNum: p + 1, totalParts, begin, end, totalSize: data.length });
      const msgId = `f${fileNo}s${p + 1}@triboon.test`;
      articles.set(msgId, body);
      segs.push(`<segment bytes="${body.length}" number="${p + 1}">${msgId}</segment>`);
    }
    fileXml.push(`<file poster="t" date="1700000000" subject="[release] &quot;${name}&quot; yEnc (1/${totalParts})">
  <groups><group>alt.binaries.triboon</group></groups>
  <segments>${segs.join('')}</segments></file>`);
  };
  for (const v of volumes) addFile(v.name, v.data);
  if (junk) {
    addFile('release.par2', Buffer.from('PAR2\0junkjunkjunk'));
    addFile('release.nfo', Buffer.from('nfo nfo nfo'));
  }
  const nzb = `<?xml version="1.0"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n${fileXml.join('\n')}\n</nzb>`;
  return { articles, nzb };
}

async function withMockMount(volumes, fn, { partSize = 30000, poolSize = 8, latencyMs = 0, mockOpts = {} } = {}) {
  const { articles, nzb } = makeArchiveNzb(volumes, partSize);
  const mock = createMockNntp({ articles, latencyMs, ...mockOpts });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, poolSize);
  try {
    const vf = await mountNzb(pool, nzb);
    await fn(vf, { mock, pool, nzb, articles });
  } finally {
    pool.close();
    await mock.close();
  }
}

async function readAll(vf, start, end) {
  const chunks = [];
  for await (const c of vf.read(start, end)) chunks.push(c);
  return Buffer.concat(chunks);
}

// ---------- parser: real-tool fixtures ----------
test('rar: real RAR4 store archive parses and reassembles byte-exact', async () => {
  const buf = loadFix('real4store.rar');
  const parsed = await parseRarVolumes([memVol(buf)]);
  assert.strictEqual(parsed.version, 4);
  assert.strictEqual(parsed.headersEncrypted, false);
  assert.strictEqual(parsed.files.length, 1);
  const f = parsed.files[0];
  assert.strictEqual(f.name, 'inner.mkv');
  assert.strictEqual(f.size, PAYLOAD.length);
  assert.strictEqual(f.method, 'store');
  assert.strictEqual(f.encrypted, false);
  assert.strictEqual(sha(await reassemble(f, [buf])), sha(PAYLOAD));
});

test('rar: real RAR5 store archive parses and reassembles byte-exact', async () => {
  const buf = loadFix('real5store.rar');
  const parsed = await parseRarVolumes([memVol(buf)]);
  assert.strictEqual(parsed.version, 5);
  const f = parsed.files[0];
  assert.strictEqual(f.name, 'inner.mkv');
  assert.strictEqual(f.size, PAYLOAD.length);
  assert.strictEqual(f.method, 'store');
  assert.strictEqual(sha(await reassemble(f, [buf])), sha(PAYLOAD));
});

test('rar: real multi-volume RAR5 (rar-generated) spans volumes byte-exact', async () => {
  const bufs = [1, 2, 3, 4].map((i) => loadFix(`real5multi.part${i}.rar`));
  const parsed = await parseRarVolumes(bufs.map((b, i) => memVol(b, `real5multi.part${i + 1}.rar`)));
  const f = parsed.files[0];
  assert.strictEqual(f.size, PAYLOAD.length);
  assert.ok(f.extents.length >= 4, 'data spread over all four volumes');
  assert.strictEqual(sha(await reassemble(f, bufs)), sha(PAYLOAD));
});

test('rar: JS multi-volume RAR4 (old naming) and RAR5 (part naming) reassemble byte-exact', async () => {
  for (const write of [writeRar4Store, writeRar5Store]) {
    const naming = write === writeRar4Store ? 'old' : 'part';
    const vols = write([{ name: 'inner.mkv', data: PAYLOAD }], { volSize: 80 * 1024, naming });
    assert.ok(vols.length >= 4);
    const parsed = await parseRarVolumes(vols.map((v) => memVol(v.data, v.name)));
    const f = parsed.files[0];
    assert.strictEqual(f.size, PAYLOAD.length);
    assert.strictEqual(sha(await reassemble(f, vols.map((v) => v.data))), sha(PAYLOAD));
  }
});

test('rar: compressed archives are detected and never claimed streamable', async () => {
  for (const fix of ['comp4.rar', 'comp5.rar']) {
    const parsed = await parseRarVolumes([memVol(loadFix(fix))]);
    assert.strictEqual(parsed.files[0].method, 'compressed', fix);
  }
});

test('rar: password-protected variants are detected', async () => {
  const dataEnc = await parseRarVolumes([memVol(loadFix('pass5.rar'))]);
  assert.strictEqual(dataEnc.headersEncrypted, false);
  assert.strictEqual(dataEnc.files[0].name, 'inner.mkv', 'data-encrypted is still listable');
  assert.strictEqual(dataEnc.files[0].encrypted, true);

  const hdrEnc = await parseRarVolumes([memVol(loadFix('passhdr5.rar'))]);
  assert.strictEqual(hdrEnc.headersEncrypted, true);
  assert.strictEqual(hdrEnc.files.length, 0, 'header-encrypted cannot be listed');
});

// ---------- zip / 7z / detection ----------
test('zip: store zip parses, picks across multiple inner files, reassembles byte-exact', async () => {
  const nfo = Buffer.from('junk info file');
  const buf = writeZipStore([{ name: 'release.nfo', data: nfo }, { name: 'inner.mkv', data: PAYLOAD }]);
  const parsed = await parseZip(memVol(buf, 'a.zip'));
  assert.strictEqual(parsed.files.length, 2);
  const mkv = parsed.files.find((f) => f.name === 'inner.mkv');
  assert.strictEqual(mkv.size, PAYLOAD.length);
  assert.strictEqual(mkv.method, 'store');
  assert.strictEqual(sha(await reassemble(mkv, [buf])), sha(PAYLOAD));
});

test('detect: container signatures', () => {
  assert.strictEqual(detectContainer(loadFix('real4store.rar')), 'rar4');
  assert.strictEqual(detectContainer(loadFix('real5store.rar')), 'rar5');
  assert.strictEqual(detectContainer(loadFix('store7z.7z')), '7z');
  assert.strictEqual(detectContainer(loadFix('lzma7z.7z')), '7z');
  assert.strictEqual(detectContainer(writeZipStore([{ name: 'a', data: Buffer.from('x') }])), 'zip');
  assert.strictEqual(detectContainer(Buffer.from('definitely not an archive')), null);
});

test('volumes: ordering handles shuffles, .r99→.r100, part2 < part10, and junk exclusion', () => {
  const old = ['x.r01', 'x.rar', 'x.r00', 'x.r10', 'x.r02'].map((name) => ({ name }));
  assert.deepStrictEqual(orderVolumes(old).map((f) => f.name), ['x.rar', 'x.r00', 'x.r01', 'x.r02', 'x.r10']);
  const parts = ['y.part10.rar', 'y.part2.rar', 'y.part1.rar'].map((name) => ({ name }));
  assert.deepStrictEqual(orderVolumes(parts).map((f) => f.name), ['y.part1.rar', 'y.part2.rar', 'y.part10.rar']);
  const mixed = [{ name: 'z.par2' }, { name: 'z.nfo' }, { name: 'z.rar' }, { name: 'z.r00' }];
  assert.deepStrictEqual(orderVolumes(mixed).map((f) => f.name), ['z.rar', 'z.r00']);

  // Old-scheme rollover past .r99 → .s00 → .t00 (real scene RAR sets exceed 100 volumes).
  const rollover = ['w.rar', 'w.r99', 'w.s00', 'w.s01', 'w.r98'].map((name) => ({ name }));
  assert.deepStrictEqual(orderVolumes(rollover).map((f) => f.name), ['w.rar', 'w.r98', 'w.r99', 'w.s00', 'w.s01']);
});

test('nzb: password meta is extracted from the head block', () => {
  const xml = `<?xml version="1.0"?><nzb><head><meta type="title">X</meta>
    <meta type="password">s3cret!</meta></head>
    <file subject='"a.rar" yEnc (1/1)'><groups><group>g</group></groups>
    <segments><segment bytes="10" number="1">a@b</segment></segments></file></nzb>`;
  assert.strictEqual(nzbPassword(xml), 's3cret!');
  assert.strictEqual(nzbPassword('<nzb><file subject="x"><segments><segment>a@b</segment></segments></file></nzb>'), null);
  parseNzb(xml); // password meta must not break normal parsing
});

// ---------- e2e: archive mounts over mock NNTP ----------
test('e2e: multi-volume store RAR4 mounts, streams, and survives 30 fuzzed seeks', async () => {
  const vols = writeRar4Store([{ name: 'Movie.2024.mkv', data: PAYLOAD }], { volSize: 70 * 1024, naming: 'old' });
  await withMockMount(vols, async (vf) => {
    assert.strictEqual(vf.container, 'rar');
    assert.strictEqual(vf.method, 'store');
    assert.strictEqual(vf.streamable, true);
    assert.strictEqual(vf.name, 'Movie.2024.mkv');
    assert.strictEqual(vf.size, PAYLOAD.length);

    const full = await readAll(vf, 0, vf.size);
    assert.strictEqual(sha(full), sha(PAYLOAD), 'full stream byte-exact');

    let seed = 1234;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 30; i++) {
      const start = Math.floor(rnd() * (vf.size - 1));
      const len = 1 + Math.floor(rnd() * Math.min(vf.size - start, 120000));
      const win = await readAll(vf, start, start + len);
      assert.ok(win.equals(PAYLOAD.subarray(start, start + len)), `fuzz ${i}: [${start}, +${len})`);
    }
  });
});

test('e2e: multi-volume RAR5 with part naming streams byte-exact across boundaries', async () => {
  const vols = writeRar5Store([{ name: 'Show.S01E01.mkv', data: PAYLOAD }], { volSize: 64 * 1024 });
  await withMockMount(vols, async (vf) => {
    assert.strictEqual(vf.size, PAYLOAD.length);
    // Read windows straddling every volume boundary (64K data per volume).
    for (let b = 64 * 1024; b < PAYLOAD.length; b += 64 * 1024) {
      const win = await readAll(vf, b - 5000, b + 5000);
      assert.ok(win.equals(PAYLOAD.subarray(b - 5000, b + 5000)), `boundary at ${b}`);
    }
  });
});

test('e2e: zip mount streams byte-exact and picks the video among inner files', async () => {
  const zip = writeZipStore([{ name: 'info.nfo', data: Buffer.from('junk') }, { name: 'Movie.mkv', data: PAYLOAD }]);
  await withMockMount([{ name: 'release.zip', data: zip }], async (vf) => {
    assert.strictEqual(vf.container, 'zip');
    assert.strictEqual(vf.name, 'Movie.mkv');
    const got = await readAll(vf, 100000, 200000);
    assert.ok(got.equals(PAYLOAD.subarray(100000, 200000)));
  });
});

test('e2e: compressed, encrypted, and 7z mounts are honest about not streaming (yet)', async () => {
  const cases = [
    { vols: [{ name: 'c.rar', data: loadFix('comp5.rar') }], tags: ['compressed', '🐢'] },
    { vols: [{ name: 'p.rar', data: loadFix('pass5.rar') }], tags: ['encrypted'] },
    { vols: [{ name: 'h.rar', data: loadFix('passhdr5.rar') }], tags: ['encrypted', 'headers-encrypted'] },
    { vols: [{ name: 's.7z', data: loadFix('store7z.7z') }], tags: ['unsupported-container'] },
  ];
  for (const c of cases) {
    await withMockMount(c.vols, async (vf) => {
      assert.strictEqual(vf.streamable, false, c.vols[0].name);
      for (const t of c.tags) assert.ok(vf.tags.includes(t), `${c.vols[0].name} tags ${vf.tags} ⊇ ${t}`);
    });
  }
});

test('e2e: flat (non-archive) NZB still mounts exactly like Phase 0', async () => {
  await withMockMount([{ name: 'Plain.File.mkv', data: PAYLOAD }], async (vf) => {
    assert.strictEqual(vf.container, 'flat');
    assert.strictEqual(vf.streamable, true);
    const full = await readAll(vf, 0, vf.size);
    assert.strictEqual(sha(full), sha(PAYLOAD));
  });
});

test('e2e: obfuscated inner name still picks the largest file and sniffs nothing weird', async () => {
  const vols = writeRar5Store([
    { name: 'a8f3b2.bin', data: PAYLOAD },
    { name: 'readme.txt', data: Buffer.from('obfuscated release') },
  ], { volSize: 200 * 1024 });
  await withMockMount(vols, async (vf) => {
    assert.strictEqual(vf.name, 'a8f3b2.bin');
    assert.strictEqual(vf.size, PAYLOAD.length);
  });
});

// ---------- HTTP API ----------
test('e2e: HTTP mount of a multi-volume RAR serves Range requests byte-exact', async () => {
  const vols = writeRar4Store([{ name: 'Http.Test.mkv', data: PAYLOAD }], { volSize: 90 * 1024, naming: 'old' });
  const { articles, nzb } = makeArchiveNzb(vols, 30000);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();

  const { bootServer, setupAdmin, httpJson } = require('./helpers');
  const { shutdown, port } = await bootServer({
    NNTP_HOST: '127.0.0.1', NNTP_PORT: nntpPort, NNTP_TLS: 'false', NNTP_USER: null,
  });
  const token = await setupAdmin(port);
  const post = (p, body) => httpJson(port, 'POST', p, body, token);
  const get = (p, range) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: range ? { Range: range } : {} }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    }).on('error', reject);
  });

  const m = await post('/api/mount', nzb);
  assert.strictEqual(m.status, 200);
  assert.strictEqual(m.json.container, 'rar');
  assert.strictEqual(m.json.method, 'store');
  assert.strictEqual(m.json.streamable, true);
  assert.strictEqual(m.json.name, 'Http.Test.mkv');
  assert.strictEqual(m.json.size, PAYLOAD.length);

  // Range crossing the first volume boundary (90K data per volume)
  const cross = await get(m.json.streamUrl, 'bytes=88000-95999');
  assert.strictEqual(cross.status, 206);
  assert.strictEqual(cross.headers['content-range'], `bytes 88000-95999/${PAYLOAD.length}`);
  assert.ok(cross.body.equals(PAYLOAD.subarray(88000, 96000)));

  const suffix = await get(m.json.streamUrl, 'bytes=-4096');
  assert.strictEqual(suffix.status, 206);
  assert.ok(suffix.body.equals(PAYLOAD.subarray(PAYLOAD.length - 4096)));

  const bad = await get(m.json.streamUrl, `bytes=${PAYLOAD.length + 5}-`);
  assert.strictEqual(bad.status, 416);

  // Mounting a compressed rar over HTTP is honest: 200 + streamable:false, stream → 409
  const { nzb: compNzb, articles: compArticles } = makeArchiveNzb([{ name: 'c.rar', data: loadFix('comp5.rar') }], 30000);
  for (const [k, v] of compArticles) articles.set(k, v);
  const cm = await post('/api/mount', compNzb);
  assert.strictEqual(cm.status, 200);
  assert.strictEqual(cm.json.streamable, false);
  assert.ok(cm.json.tags.includes('🐢'));
  const denied = await get(cm.json.streamUrl);
  assert.strictEqual(denied.status, 409);

  await shutdown();
  await mock.close();
});

// ---------- multi-provider failover ----------
test('failover: pool fetches from the second provider when the first is missing articles', async () => {
  const data = seededPayload(120000, 0xfa11);
  const { articles, nzb } = makeArchiveNzb([{ name: 'Failover.mkv', data }], 30000, { junk: false });

  // Provider A is missing two segments; provider B has everything.
  const articlesA = new Map(articles);
  const mockA = createMockNntp({ articles: articlesA });
  const mockB = createMockNntp({ articles });
  const portA = await mockA.listen();
  const portB = await mockB.listen();
  mockA.markMissing('f1s2@triboon.test');
  mockA.markMissing('f1s4@triboon.test');

  const pool = new NntpPool([
    { host: '127.0.0.1', port: portA, tls: false },
    { host: '127.0.0.1', port: portB, tls: false },
  ], 4);

  // stat: true when ANY provider has the article
  assert.strictEqual(await pool.stat('f1s2@triboon.test'), true);
  assert.strictEqual(await pool.stat('nope@triboon.test'), false);

  const vf = await mountNzb(pool, nzb);
  const full = await readAll(vf, 0, vf.size);
  assert.strictEqual(sha(full), sha(data), 'stream healed by provider B is byte-exact');

  pool.close();
  await mockA.close();
  await mockB.close();
});

test('failover: single-provider pool still fails cleanly on a truly missing article', async () => {
  const data = seededPayload(60000, 0xdead);
  const { articles, nzb } = makeArchiveNzb([{ name: 'Dead.mkv', data }], 30000, { junk: false });
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 2);
  const vf = await mountNzb(pool, nzb);
  mock.markMissing('f1s2@triboon.test');
  await assert.rejects(() => readAll(vf, 0, vf.size), /430|BODY/);
  pool.close();
  await mock.close();
});

// ---------- speed gate ----------
test('speed budget: cold seek inside a multi-volume archive < 250ms (20ms RTT mock)', async () => {
  const big = seededPayload(2 * 1024 * 1024, 0x5eed);
  const vols = writeRar5Store([{ name: 'Speed.mkv', data: big }], { volSize: 512 * 1024 });
  await withMockMount(vols, async (vf) => {
    const off = 1500000; // third volume
    const t0 = process.hrtime.bigint();
    const it = vf.read(off, off + 1024);
    await it.next();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 250, `first byte after cold archive seek took ${ms.toFixed(1)}ms`);
  }, { partSize: 96 * 1024, latencyMs: 20 });
});

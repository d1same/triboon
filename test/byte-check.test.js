'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runByteCheck, walkMkv, byteCheckVerdict, firstDifference, longestZeroRun, zeroRunOutside, WINDOW_BYTES } = require('../server/byte-check');
const { VirtualFile } = require('../server/vfs');
const { encodePart } = require('../server/yenc');

// EBML helpers: 4-byte sizes keep the fixtures readable.
const size4 = (n) => Buffer.from([0x10 | (n >>> 24), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const block = (bytes) => Buffer.concat([Buffer.from([0xa3]), size4(bytes), Buffer.alloc(bytes, 0x41)]);
function cluster(blocks) {
  const body = Buffer.concat([Buffer.from([0xe7, 0x81, 0x00]), ...blocks.map(block)]);
  return Buffer.concat([Buffer.from([0x1f, 0x43, 0xb6, 0x75]), size4(body.length), body]);
}

test('byte check: a clean MKV walks through, and a window ending mid-element is not damage', () => {
  const clean = Buffer.concat([Buffer.alloc(50, 0x55), cluster([1000, 2000]), cluster([500])]);
  assert.deepStrictEqual(walkMkv(clean, 100), { checked: true, clusters: 2, broken: null });
  assert.strictEqual(walkMkv(clean.subarray(0, clean.length - 200), 100).broken, null);
  assert.strictEqual(walkMkv(Buffer.alloc(100, 0x55)).checked, false, 'no cluster in view means nothing was proven');
});

test('byte check: a zero byte at an element start is found at its real file offset', () => {
  const a = cluster([1000]);
  const b = cluster([1000]);
  const buf = Buffer.concat([a, b]);
  buf.fill(0, a.length, a.length + 4);
  const out = walkMkv(buf, 5000);
  assert.strictEqual(out.broken, 5000 + a.length);
  assert.strictEqual(out.bytes.slice(0, 8), '00000000');
  const inner = Buffer.concat([cluster([100, 100])]);
  const at = 8 + 3 + 5 + 100;
  inner[at] = 0x00;
  assert.strictEqual(walkMkv(inner).broken, at, 'a bad block header inside a cluster is caught too');
});

test('byte check: the verdict names the file or Triboon only on real evidence', () => {
  const pieces = [{ crcOk: true, intact: true }, { crcOk: true, intact: true }];
  const same = Buffer.from('abcd');
  const clean = { checked: true, clusters: 1, broken: null };
  assert.strictEqual(byteCheckVerdict({ served: Buffer.from('abXd'), fresh: same, pieces, mkv: clean, edges: [] }).fault, 'triboon');
  const brokenAt = { checked: true, clusters: 1, broken: 900, bytes: '00' };
  assert.strictEqual(byteCheckVerdict({ served: same, fresh: same, pieces, mkv: brokenAt, edges: [] }).fault, 'file');
  assert.strictEqual(byteCheckVerdict({ served: same, fresh: same, pieces, mkv: brokenAt, edges: [905] }).fault, 'triboon',
    'a break right at a RAR volume edge points at the extent map, not the release');
  assert.strictEqual(byteCheckVerdict({ served: same, fresh: same, pieces, mkv: clean, edges: [] }).fault, 'unknown');
  assert.strictEqual(byteCheckVerdict({ served: same, fresh: same, pieces: [{ error: '430' }], mkv: clean, edges: [] }).fault, 'unknown',
    'a piece it could not re-read proves nothing');
  assert.strictEqual(byteCheckVerdict({ served: same, fresh: same, pieces: [{ crcOk: false, intact: true }], mkv: clean, edges: [] }).fault, 'file');
  assert.strictEqual(firstDifference(Buffer.from('ab'), Buffer.from('abc')), 2, 'a short read counts as different');
  assert.strictEqual(longestZeroRun(Buffer.from([1, 0, 0, 2, 0])), 2);
});

function stream(data, partSize, { mangleSlot = null } = {}) {
  const totalParts = Math.ceil(data.length / partSize);
  const articles = new Map();
  const segments = [];
  for (let p = 0; p < totalParts; p++) {
    const begin = p * partSize;
    const end = Math.min(data.length, begin + partSize);
    const id = `p${p}@t`;
    articles.set(id, encodePart(data, { name: 'x.mkv', partNum: p + 1, totalParts, begin, end, totalSize: data.length }));
    segments.push(`<segment bytes="${end - begin}" number="${p + 1}">${id}</segment>`);
  }
  const pool = { body: async (id) => { const a = articles.get(id); if (!a) throw new Error('430'); return a; } };
  const nzb = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="q" date="1" subject="&quot;x.mkv&quot; yEnc (1/${totalParts})"><groups><group>a</group></groups><segments>${segments.join('')}</segments></file></nzb>`;
  const vf = new VirtualFile(pool, nzb, {});
  if (mangleSlot !== null) {
    const real = vf.read.bind(vf);
    vf.read = async function* (s, e, o) {
      for await (const c of real(s, e, o)) { const b = Buffer.from(c); if (b.length > mangleSlot) b[mangleSlot] ^= 0xff; yield b; }
    };
  }
  return vf;
}

test('byte check: end to end, identical bytes with broken MKV blames the file and served garbage blames Triboon', async () => {
  const a = cluster(new Array(40).fill(20000));
  const b = cluster(new Array(40).fill(20000));
  const data = Buffer.concat([a, b]);
  data.fill(0, a.length, a.length + 4);
  const lines = [];
  const log = (l) => lines.push(l);

  const damaged = stream(data, 256 * 1024);
  await damaged.mount('startup');
  damaged._lastServedEnd = data.length;
  assert.strictEqual((await runByteCheck(damaged, { log, name: 'Show.S01E01' })).fault, 'file');
  assert.match(lines[0], /^byte check — "Show\.S01E01": FILE damaged: bytes match the articles and the MKV breaks at offset \d+ \(00000000/);
  assert.strictEqual(await runByteCheck(damaged, { log }), null, 'one check per mount, however many drops report it');
  assert.strictEqual(lines.length, 1);

  const clean = Buffer.concat([cluster(new Array(40).fill(20000))]);
  const misread = stream(clean, 256 * 1024, { mangleSlot: 77 });
  await misread.mount('startup');
  misread._lastServedEnd = clean.length;
  assert.strictEqual((await runByteCheck(misread, { log })).fault, 'triboon');
  assert.match(lines[1], /TRIBOON served different bytes/);

  const unused = stream(clean, 256 * 1024);
  await unused.mount('startup');
  assert.strictEqual(await runByteCheck(unused, { log }), null, 'nothing served yet means nothing to check');
  assert.strictEqual(await runByteCheck(null, { log }), null);
  assert.ok(WINDOW_BYTES >= 8 * 1024 * 1024, 'the window must cover what sits in the socket past the bad byte');
});

// One made-up file served from memory. `fail(id, n)` makes the n-th request for an article throw.
function memoryStream(data, partSize, { name = 'x.bin', articleFor = null, fail = () => false } = {}) {
  const totalParts = Math.ceil(data.length / partSize);
  const articles = new Map();
  const segments = [];
  for (let p = 0; p < totalParts; p++) {
    const begin = p * partSize;
    const end = Math.min(data.length, begin + partSize);
    const id = `q${p}@t`;
    articles.set(id, (articleFor && articleFor(p)) || encodePart(data, { name, partNum: p + 1, totalParts, begin, end, totalSize: data.length }));
    segments.push(`<segment bytes="${end - begin}" number="${p + 1}">${id}</segment>`);
  }
  const asked = new Map();
  const pool = {
    body: async (id) => {
      const n = (asked.get(id) || 0) + 1;
      asked.set(id, n);
      if (fail(id, n)) throw new Error('NNTP command aborted');
      return articles.get(id);
    },
  };
  const nzb = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="q" date="1" subject="&quot;${name}&quot; yEnc (1/${totalParts})"><groups><group>a</group></groups><segments>${segments.join('')}</segments></file></nzb>`;
  return new VirtualFile(pool, nzb, {});
}

test('byte check: pieces it could not re-read are not counted as a zero run in the file', async () => {
  // No zero byte anywhere in the file. The served read gets every piece; the fresh re-read loses
  // three neighbours (the 90 s limit aborting them). Their bytes stay zero in the re-read buffer,
  // and the old line logged them as a 768 KB "longest zero run" the player never got.
  const partSize = 256 * 1024;
  const data = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = 1 + (i % 251);
  const lost = new Set(['q5@t', 'q6@t', 'q7@t']);
  const vf = memoryStream(data, partSize, { fail: (id, n) => n > 1 && lost.has(id) });
  await vf.mount('startup');
  vf._lastServedEnd = data.length;
  const lines = [];
  const verdict = await runByteCheck(vf, { log: (l) => lines.push(l), name: 'Lost.Pieces' });
  assert.strictEqual(verdict.fault, 'unknown');
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /could not re-read 3 of 16 pieces \(NNTP command aborted\)/);
  const run = Number((lines[0].match(/longest zero run (\d+)/) || [])[1]);
  assert.strictEqual(run, 0, `the zeros left where a piece was not re-read are not the file's bytes: ${lines[0]}`);
  assert.match(lines[0], new RegExp(`${3 * partSize} bytes not re-read, not counted`));

  // Runs are still found everywhere else, and a slot not re-read breaks a run instead of joining it.
  assert.strictEqual(zeroRunOutside(Buffer.from([1, 0, 0, 0, 0, 2]), []), 4);
  assert.strictEqual(zeroRunOutside(Buffer.from([1, 0, 0, 0, 0, 2]), [[2, 4]]), 1);
  assert.strictEqual(zeroRunOutside(Buffer.from([0, 0, 1, 0, 0, 0]), [[0, 1]]), 3);
  assert.strictEqual(zeroRunOutside(Buffer.from([0, 0, 1]), undefined), 2, 'no ranges given: the whole buffer counts, as before');
});

test('byte check: a short article still counts its padded zeros and is named, never "not re-read"', async () => {
  // The one path that does hand the player zeros (vfs read(), pinned by e2e "short yEnc part"): an
  // article whose own header and checksum say it is shorter than its slot. The rest of the slot is
  // padded with zeros on play, so the byte check must count that run and say why.
  const partSize = 96 * 1024;
  const data = Buffer.alloc(12 * partSize);
  for (let i = 0; i < data.length; i++) data[i] = 1 + (i % 251);
  const hole = 6;
  const vf = memoryStream(data, partSize, {
    articleFor: (p) => (p === hole ? encodePart(data, { name: 'x.bin', partNum: p + 1, totalParts: 12, begin: p * partSize, end: p * partSize + 1000, totalSize: data.length }) : null),
  });
  await vf.mount('startup');
  vf._lastServedEnd = data.length;
  const lines = [];
  await runByteCheck(vf, { log: (l) => lines.push(l), name: 'Short.Piece' });
  assert.strictEqual(lines.length, 1);
  const run = Number((lines[0].match(/longest zero run (\d+)/) || [])[1]);
  assert.strictEqual(run, partSize - 1000, `the padded hole is counted: ${lines[0]}`);
  assert.doesNotMatch(lines[0], /not re-read/);
  assert.match(lines[0], new RegExp(`1 pieces shorter than their slot \\(${partSize - 1000} bytes padded with zeros on play\\)`));
});

test('byte check: an article that decodes to zeros with its own valid checksum is the file; a wrong checksum is refused', async () => {
  // The "article decoded to zeros" explanation: a poster's piece that really is zeros passes its
  // CRC, is served as posted, and the check blames the file. The same zeros under the original CRC
  // fail it: the stream refuses the piece and the check says so, it never serves them as good.
  const partSize = 64 * 1024;
  const c1 = cluster(new Array(30).fill(4000));
  const c2 = cluster(new Array(30).fill(4000));
  const data = Buffer.concat([c1, c2]);
  const zeroAt = 1;
  const zeroed = Buffer.from(data);
  zeroed.fill(0, zeroAt * partSize, (zeroAt + 1) * partSize);
  const total = Math.ceil(data.length / partSize);
  const posted = memoryStream(data, partSize, {
    name: 'x.mkv',
    articleFor: (p) => (p === zeroAt ? encodePart(zeroed, { name: 'x.mkv', partNum: p + 1, totalParts: total, begin: p * partSize, end: (p + 1) * partSize, totalSize: data.length }) : null),
  });
  await posted.mount('startup');
  const served = [];
  for await (const c of posted.read(0, data.length)) served.push(c);
  assert.ok(Buffer.concat(served).equals(zeroed), 'a valid zero article is served as posted');
  posted._lastServedEnd = data.length;
  const lines = [];
  assert.strictEqual((await runByteCheck(posted, { log: (l) => lines.push(l) })).fault, 'file');
  assert.match(lines[0], /FILE damaged: bytes match the articles and the MKV breaks/);

  // Same zeros, but the article keeps the CRC of the real bytes.
  const good = encodePart(data, { name: 'x.mkv', partNum: zeroAt + 1, totalParts: total, begin: zeroAt * partSize, end: (zeroAt + 1) * partSize, totalSize: data.length }).toString('latin1');
  const bad = encodePart(zeroed, { name: 'x.mkv', partNum: zeroAt + 1, totalParts: total, begin: zeroAt * partSize, end: (zeroAt + 1) * partSize, totalSize: data.length }).toString('latin1');
  const crcOf = (t) => (t.match(/ pcrc32=([0-9a-f]+)/i) || [])[1];
  assert.ok(crcOf(good) && crcOf(bad) && crcOf(good) !== crcOf(bad));
  const lying = Buffer.from(bad.replace(` pcrc32=${crcOf(bad)}`, ` pcrc32=${crcOf(good)}`), 'latin1');
  const refused = memoryStream(data, partSize, { name: 'x.mkv', articleFor: (p) => (p === zeroAt ? lying : null) });
  await refused.mount('startup');
  const got = [];
  await assert.rejects(async () => { for await (const c of refused.read(0, data.length)) got.push(c); });
  assert.ok(Buffer.concat(got).length <= zeroAt * partSize, 'nothing from the bad piece or past it reached the reader');
  assert.ok(!Buffer.concat(got).includes(Buffer.alloc(64)), 'no zeros reached the reader');
});

test('byte check: through a store-RAR, a slot not re-read sits at the right window offset across volume edges', async () => {
  const { seededPayload, writeRar4Store } = require('./archive-fixtures');
  const { mountNzb } = require('../server/archive');
  const payload = seededPayload(300 * 1024, 0x3c1d);
  const vols = writeRar4Store([{ name: 'Edge.Check.mkv', data: payload }], { base: 'edge.check', naming: 'part', volSize: 64 * 1024 });
  assert.ok(vols.length >= 4, 'several volumes');
  const partSize = 16 * 1024;
  const articles = new Map();
  const files = [];
  vols.forEach((v, n) => {
    const total = Math.ceil(v.data.length / partSize);
    const segs = [];
    for (let p = 0; p < total; p++) {
      const begin = p * partSize;
      const id = `e${n + 1}p${p + 1}@t`;
      articles.set(id, encodePart(v.data, { name: v.name, partNum: p + 1, totalParts: total, begin, end: Math.min(v.data.length, begin + partSize), totalSize: v.data.length }));
      segs.push(`<segment bytes="${partSize}" number="${p + 1}">${id}</segment>`);
    }
    files.push(`<file poster="t" date="1700000000" subject="[r] &quot;${v.name}&quot; yEnc (1/${total})"><groups><group>a.b.t</group></groups><segments>${segs.join('')}</segments></file>`);
  });
  const nzb = `<?xml version="1.0"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n${files.join('\n')}\n</nzb>`;
  let failing = false;
  const pool = { body: async (id) => { if (failing && id === 'e3p2@t') throw new Error('NNTP command aborted'); return articles.get(id); } };
  const vf = await mountNzb(pool, nzb, { releaseName: 'Edge.Check' });
  assert.strictEqual(vf.container, 'rar');
  const edges = vf.extents.map((e) => e.innerStart).filter((x) => x > 0);
  const start = Math.max(0, edges[0] - 5000);
  const end = Math.min(payload.length, edges[edges.length - 1] + 5000);

  const clean = await vf.freshBytes(start, end);
  assert.ok(clean.buf.equals(payload.subarray(start, end)));
  assert.deepStrictEqual(clean.unread, []);

  failing = true;
  const lost = await vf.freshBytes(start, end);
  assert.strictEqual(lost.pieces.filter((p) => p.error).length, 1);
  const mask = new Uint8Array(end - start);
  for (const [a, b] of lost.unread) mask.fill(1, a, b);
  const holes = mask.reduce((n, x) => n + x, 0);
  assert.ok(holes > 0 && holes <= partSize, `one slot not re-read: ${holes} bytes`);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) assert.strictEqual(lost.buf[i], 0);
    else assert.strictEqual(lost.buf[i], payload[start + i], `a byte outside the unread slot at window +${i} must be the file's byte`);
  }
});

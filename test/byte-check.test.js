'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runByteCheck, walkMkv, byteCheckVerdict, firstDifference, longestZeroRun, WINDOW_BYTES } = require('../server/byte-check');
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

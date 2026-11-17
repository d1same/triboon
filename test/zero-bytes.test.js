'use strict';

// A playing stream must never receive bytes the server did not decode from a complete, verified
// article. Each case plays a whole made-up file through the real pool and VFS against the mock
// NNTP server while one fault is injected, and compares EVERY byte the reader got with the source:
// either the stream is byte-exact, or it ends with an error (the HTTP route then ends the response
// short and the page recovers). Zeros, filler or shifted bytes fail the case.

const { test } = require('node:test');
const assert = require('node:assert');
const { encodePart } = require('../server/yenc');
const { NntpPool } = require('../server/nntp');
const { VirtualFile } = require('../server/vfs');
const { createMockNntp } = require('./mock-nntp');

const PART = 48 * 1024;

function makeRelease(name, parts, tag) {
  const size = parts * PART;
  const data = Buffer.allocUnsafe(size);
  let seed = 0x2b0d;
  for (let i = 0; i < size; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = (seed >> 8) & 0xff; }
  // No byte of the source is zero, so any zero the reader gets is filler.
  for (let i = 0; i < size; i++) if (data[i] === 0) data[i] = 1;
  const articles = new Map();
  const segs = [];
  for (let p = 0; p < parts; p++) {
    const begin = p * PART;
    const body = encodePart(data, { name, partNum: p + 1, totalParts: parts, begin, end: begin + PART, totalSize: size });
    const id = `z${p + 1}@${tag}`;
    articles.set(id, body);
    segs.push(`<segment bytes="${body.length}" number="${p + 1}">${id}</segment>`);
  }
  const nzb = `<?xml version="1.0"?><nzb><file poster="t" date="1" subject="&quot;${name}&quot; yEnc (1/${parts})"><groups><group>a.b.t</group></groups><segments>${segs.join('')}</segments></file></nzb>`;
  return { data, articles, nzb, size };
}

// Reads [0, size) like the stream route does and calls `fault(n)` after the n-th chunk.
async function play(vf, size, { priority = 'playback', signal = null, fault = null } = {}) {
  const got = [];
  let n = 0;
  let err = null;
  try {
    for await (const chunk of vf.read(0, size, { priority, signal })) {
      got.push(Buffer.from(chunk));
      n++;
      if (fault) await fault(n);
    }
  } catch (e) { err = e; }
  return { bytes: Buffer.concat(got), err };
}

function assertNoFiller(label, out, data) {
  const served = out.bytes;
  assert.ok(served.length <= data.length, `${label}: no extra bytes`);
  const want = data.subarray(0, served.length);
  if (!served.equals(want)) {
    let at = 0;
    while (at < served.length && served[at] === want[at]) at++;
    let zeros = 0;
    for (let i = at; i < served.length && served[i] === 0; i++) zeros++;
    assert.fail(`${label}: served bytes differ from the source at ${at} (${zeros} zero bytes there)`);
  }
  if (!out.err) assert.strictEqual(served.length, data.length, `${label}: a stream with no error is complete`);
}

async function setup(parts = 24, poolSize = 2, extra = {}) {
  const rel = makeRelease('Zero.Test.mkv', parts, `zt${Math.random().toString(36).slice(2, 8)}`);
  const mock = createMockNntp({ articles: rel.articles, latencyMs: extra.latencyMs || 0 });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, commandTimeoutMs: 300 }, poolSize);
  const vf = new VirtualFile(pool, rel.nzb, { readAhead: 4 });
  await vf.mount();
  const done = async () => { pool.close(); await mock.close(); };
  return { rel, mock, pool, vf, done };
}

test('zero bytes: a wedged socket mid-stream retries; the reader gets the exact bytes', async () => {
  const { rel, mock, vf, done } = await setup();
  try {
    const out = await play(vf, rel.size, { fault: (n) => { if (n === 6) mock.stallNext(2); } });
    assertNoFiller('stall', out, rel.data);
    assert.strictEqual(mock.pendingStalls(), 0, 'both stalls fired');
  } finally { await done(); }
});

test('zero bytes: every line dropped mid-stream is redialled; the reader gets the exact bytes', async () => {
  const { rel, mock, vf, done } = await setup();
  try {
    const out = await play(vf, rel.size, { fault: (n) => { if (n === 5 || n === 12) mock.dropConnections(); } });
    assertNoFiller('drop', out, rel.data);
  } finally { await done(); }
});

test('zero bytes: a short body that NNTP sees as complete is refused, never served', async () => {
  for (const keepBytes of [10, 2000, 30000]) {
    const { rel, mock, vf, done } = await setup();
    try {
      // Cut the next body requested after chunk 4 (a read-ahead or the player's own piece).
      const out = await play(vf, rel.size, { fault: (n) => { if (n === 4) mock.cutNextBody({ keepBytes, then: 'end' }); } });
      assertNoFiller(`short body ${keepBytes}`, out, rel.data);
      assert.strictEqual(mock.pendingCuts(), 0, 'the cut fired');
    } finally { await done(); }
  }
});

test('zero bytes: a body cut mid-transfer by a dying socket is fetched again, never served', async () => {
  for (const keepBytes of [100, 20000]) {
    const { rel, mock, vf, done } = await setup();
    try {
      const out = await play(vf, rel.size, { fault: (n) => { if (n === 7) mock.cutNextBody({ keepBytes, then: 'destroy' }); } });
      assertNoFiller(`cut ${keepBytes}`, out, rel.data);
      assert.strictEqual(mock.pendingCuts(), 0, 'the cut fired');
    } finally { await done(); }
  }
});

test('zero bytes: the same piece cut on every try ends the stream with an error, never filler', async () => {
  const { rel, mock, vf, done } = await setup();
  try {
    const target = 'z10@';
    const id = [...rel.articles.keys()].find((k) => k.startsWith(target));
    for (let i = 0; i < 8; i++) mock.cutNextBody({ keepBytes: 3000, then: 'end', id });
    const out = await play(vf, rel.size);
    assert.ok(out.err, 'a piece that never arrives whole ends the stream with an error');
    assertNoFiller('always cut', out, rel.data);
    assert.ok(out.bytes.length <= 9 * PART, 'nothing is served past the piece that could not be read');
  } finally { await done(); }
});

test('zero bytes: with every line busy for another title, read-ahead cancels and a sharing reader that leaves', async () => {
  const { rel, mock, pool, vf, done } = await setup(32, 2, { latencyMs: 2 });
  try {
    // Another title on the same two lines, read slowly in the background.
    const other = makeRelease('Other.Title.mkv', 16, `ot${Math.random().toString(36).slice(2, 8)}`);
    for (const [k, v] of other.articles) rel.articles.set(k, v);
    const vf2 = new VirtualFile(pool, other.nzb, { readAhead: 4 });
    await vf2.mount();
    const bg = play(vf2, other.size, { priority: 'background' });
    // A second reader of the same file that leaves part-way (a warm-up or an old Range).
    const leave = new AbortController();
    const sharing = play(vf, rel.size, { priority: 'readAhead', signal: leave.signal, fault: (n) => { if (n === 3) leave.abort(); } });
    const out = await play(vf, rel.size, {
      fault: async (n) => {
        if (n % 3 === 0) vf.cancelReadAhead();
        if (n === 9) mock.trickleNext(6, 15);
        if (n === 14) mock.cutNextBody({ keepBytes: 5000, then: 'destroy' });
      },
    });
    assertNoFiller('busy + cancels', out, rel.data);
    const otherOut = await bg;
    assertNoFiller('other title', otherOut, other.data);
    await sharing;
  } finally { await done(); }
});

test('zero bytes: a provider whose copy is cut fails over to the next provider with the exact bytes', async () => {
  const rel = makeRelease('Failover.Test.mkv', 20, `fo${Math.random().toString(36).slice(2, 8)}`);
  const a = createMockNntp({ articles: rel.articles });
  const b = createMockNntp({ articles: rel.articles });
  const pa = await a.listen();
  const pb = await b.listen();
  const pool = new NntpPool([
    { host: '127.0.0.1', port: pa, tls: false, commandTimeoutMs: 300, connections: 2 },
    { host: '127.0.0.1', port: pb, tls: false, commandTimeoutMs: 300, connections: 2 },
  ], 4);
  try {
    const vf = new VirtualFile(pool, rel.nzb, { readAhead: 3 });
    await vf.mount();
    for (let i = 0; i < 6; i++) a.cutNextBody({ keepBytes: 4000, then: 'end' });
    const out = await play(vf, rel.size);
    assertNoFiller('failover', out, rel.data);
    assert.strictEqual(a.pendingCuts(), 0, 'every cut copy was served by provider A and refused');
  } finally { pool.close(); await a.close(); await b.close(); }
});

test('zero bytes: a player that reconnects mid-piece at the next byte, again and again, under faults, gets the exact file', async () => {
  for (const seed0 of [7, 101, 4242]) {
    const { rel, mock, vf, done } = await setup(40, 2, { latencyMs: 1 });
    try {
      let seed = seed0;
      const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
      const parts = [];
      let pos = 0;
      let round = 0;
      while (pos < rel.size) {
        round++;
        if (round % 4 === 0) mock.trickleNext(5, 10);
        if (round % 5 === 0) mock.cutNextBody({ keepBytes: 2000 + Math.floor(rnd() * 20000), then: 'destroy' }); // a short complete copy is refused for good on a lone provider (tested above)
        if (round % 7 === 0) mock.stallNext(1);
        // Stop this response after a random number of bytes, mid-piece, like a player read timeout.
        const stopAfter = 1 + Math.floor(rnd() * PART * 2.5);
        const ctl = new AbortController();
        let got = 0;
        const priority = pos === 0 ? 'startup' : (rnd() < 0.3 ? 'seek' : 'playback');
        try {
          for await (const chunk of vf.read(pos, rel.size, { priority, signal: ctl.signal })) {
            const take = Math.min(chunk.length, stopAfter - got);
            parts.push(Buffer.from(chunk.subarray(0, take)));
            got += take;
            if (got >= stopAfter) { ctl.abort(); vf.cancelReadAhead(); break; }
          }
        } catch (e) {
          if (!ctl.signal.aborted) throw e;
        }
        pos += got;
        if (round > 400) throw new Error('too many rounds');
      }
      assertNoFiller(`reconnects seed ${seed0}`, { bytes: Buffer.concat(parts), err: null }, rel.data);
    } finally { await done(); }
  }
});

// ---- store-RAR: inner offsets map onto volumes; reconnects at and around volume edges ----
const { seededPayload, writeRar4Store } = require('./archive-fixtures');
const { mountNzb } = require('../server/archive');

function archiveNzb(volumes, partSize, tag) {
  const articles = new Map();
  const files = [];
  volumes.forEach((v, n) => {
    const total = Math.ceil(v.data.length / partSize) || 1;
    const segs = [];
    for (let p = 0; p < total; p++) {
      const begin = p * partSize;
      const body = encodePart(v.data, { name: v.name, partNum: p + 1, totalParts: total, begin, end: Math.min(v.data.length, begin + partSize), totalSize: v.data.length });
      const id = `v${n + 1}p${p + 1}@${tag}`;
      articles.set(id, body);
      segs.push(`<segment bytes="${body.length}" number="${p + 1}">${id}</segment>`);
    }
    files.push(`<file poster="t" date="1700000000" subject="[r] &quot;${v.name}&quot; yEnc (1/${total})"><groups><group>a.b.t</group></groups><segments>${segs.join('')}</segments></file>`);
  });
  return { articles, nzb: `<?xml version="1.0"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n${files.join('\n')}\n</nzb>` };
}

test('zero bytes: a store-RAR stream that reconnects at and around every volume edge, under faults, gets the exact file', async () => {
  const payload = seededPayload(640 * 1024, 0x51ab);
  const vols = writeRar4Store([{ name: 'Edge.Test.2026.1080p.mkv', data: payload }], { base: 'edge.test.2026.1080p', naming: 'part', volSize: 70 * 1024 });
  assert.ok(vols.length >= 6, 'several volumes');
  const { articles, nzb } = archiveNzb(vols, 17 * 1024, `rar${Math.random().toString(36).slice(2, 8)}`);
  const mock = createMockNntp({ articles, latencyMs: 1 });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, commandTimeoutMs: 300 }, 3);
  try {
    const vf = await mountNzb(pool, nzb, { releaseName: 'Edge.Test.2026.1080p' });
    assert.strictEqual(vf.container, 'rar');
    assert.strictEqual(vf.size, payload.length);
    // Stops: every volume edge of the inner file, a few bytes either side, plus random ones.
    const edges = vf.extents.map((e) => e.innerStart).filter((x) => x > 0);
    const stops = new Set();
    for (const e of edges) for (const d of [-3, -1, 0, 1, 2, 7]) if (e + d > 0 && e + d < payload.length) stops.add(e + d);
    let seed = 99;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    while (stops.size < edges.length * 6 + 30) stops.add(1 + Math.floor(rnd() * (payload.length - 2)));
    const order = [...stops].sort((a, b) => a - b);
    const parts = [];
    let pos = 0;
    let round = 0;
    for (const stop of [...order, payload.length]) {
      if (stop <= pos) continue;
      round++;
      if (round % 6 === 0) mock.trickleNext(4, 8);
      if (round % 9 === 0) mock.cutNextBody({ keepBytes: 3000, then: 'destroy' });
      if (round % 13 === 0) mock.stallNext(1);
      const ctl = new AbortController();
      let got = 0;
      const want = stop - pos;
      const priority = pos === 0 ? 'startup' : (round % 3 === 0 ? 'seek' : 'playback');
      for await (const chunk of vf.read(pos, payload.length, { priority, signal: ctl.signal })) {
        const take = Math.min(chunk.length, want - got);
        parts.push(Buffer.from(chunk.subarray(0, take)));
        got += take;
        if (got >= want) { ctl.abort(); if (typeof vf.cancelReadAhead === 'function') vf.cancelReadAhead(); break; }
      }
      pos += got;
    }
    const served = Buffer.concat(parts);
    assert.strictEqual(served.length, payload.length, 'the whole inner file was read');
    let at = 0;
    while (at < served.length && served[at] === payload[at]) at++;
    assert.strictEqual(at, payload.length, `store-RAR bytes differ from the source at ${at}`);
  } finally { pool.close(); await mock.close(); }
});

// ---- the segment disk cache hands bytes back with no network read ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const { configureSegmentDisk, getSegmentDisk } = require('../server/segment-cache');

test('zero bytes: a disk-cached piece that was zeroed or cut on disk is read again from the network, never served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-zb-disk-'));
  configureSegmentDisk({ dir, enabled: true, maxBytes: 256 * 1024 * 1024 });
  const rel = makeRelease('Disk.Test.mkv', 16, `dk${Math.random().toString(36).slice(2, 8)}`);
  const mock = createMockNntp({ articles: rel.articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, commandTimeoutMs: 300 }, 2);
  try {
    const first = new VirtualFile(pool, rel.nzb, { readAhead: 2 });
    await first.mount();
    assertNoFiller('first play (fills the disk cache)', await play(first, rel.size), rel.data);
    await getSegmentDisk().flush();
    const blobs = fs.readdirSync(dir, { recursive: true }).map(String)
      .filter((f) => !/index\.json/.test(f) && fs.statSync(path.join(dir, f)).isFile());
    assert.ok(blobs.length >= 10, `pieces were written to disk (${blobs.length})`);
    // One blob zeroed at its full length (a crash between write and flush), one cut short.
    const zeroed = path.join(dir, blobs[3]);
    fs.writeFileSync(zeroed, Buffer.alloc(fs.statSync(zeroed).size));
    const cut = path.join(dir, blobs[7]);
    fs.writeFileSync(cut, fs.readFileSync(cut).subarray(0, 1000));
    const again = new VirtualFile(pool, rel.nzb, { readAhead: 2 });
    await again.mount();
    assertNoFiller('second play from the disk cache', await play(again, rel.size), rel.data);
  } finally {
    configureSegmentDisk({ enabled: false });
    pool.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

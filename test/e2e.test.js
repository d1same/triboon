'use strict';
// Golden test suite (node:test). Builds a fake release, posts it to a mock NNTP server,
// then verifies the full Triboon pipeline: parse → mount → stream → seek → triage → latency.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { encodePart, decode, crc32 } = require('../server/yenc');
const { parseNzb, pickPrimaryFile } = require('../server/nzb');
const { NntpPool, ProviderPool } = require('../server/nntp');
const { VirtualFile } = require('../server/vfs');
const { createMockNntp } = require('./mock-nntp');

// ---------- helpers ----------
test('nntp: startup work outranks queued read-ahead when a provider is saturated', async () => {
  const pool = new ProviderPool({}, 1);
  pool.conns.push({ alive: true, lastUsed: Date.now(), close() {} });
  let releaseFirst;
  const first = pool.run(() => new Promise((resolve) => { releaseFirst = resolve; }), 'readAhead');
  const order = [];
  const low = pool.run(async () => { order.push('readAhead'); }, 'readAhead');
  const high = pool.run(async () => { order.push('startup'); }, 'startup');
  releaseFirst();
  await Promise.all([first, low, high]);
  assert.deepStrictEqual(order, ['startup', 'readAhead']);
});

test('nntp: aborted queued work is removed before it reaches a provider lane', async () => {
  const pool = new ProviderPool({}, 1);
  pool.conns.push({ alive: true, lastUsed: Date.now(), close() {} });
  let releaseFirst;
  const first = pool.run(() => new Promise((resolve) => { releaseFirst = resolve; }), 'playback');
  const ac = new AbortController();
  let ran = false;
  const cancelled = pool.run(async () => { ran = true; }, 'readAhead', { signal: ac.signal }).catch((e) => e);

  ac.abort();
  releaseFirst();
  await first;
  const err = await cancelled;
  assert.strictEqual(ran, false, 'aborted read-ahead work should never consume the lane');
  assert.strictEqual(err.code, 'ABORT_ERR');
});

test('nntp: generic run falls through to the next provider', async () => {
  const pool = new NntpPool([{}, {}], 1);
  pool.providers = [
    { busy: new Set(), queue: [], size: 1, down: () => true, run: async () => { throw new Error('primary down'); }, close() {} },
    { busy: new Set(), queue: [], size: 1, down: () => false, run: async () => 'ok', close() {} },
  ];
  assert.strictEqual(await pool.run(async () => 'unused', 'startup'), 'ok');
});

test('vfs: caller priority reaches article reads and aborted reads do not fetch', async () => {
  const { articles, nzb } = makeRelease('Priority.Test.mkv', 160000, 40000);
  const calls = [];
  const pool = {
    body: async (msgId, priority = 'playback') => {
      calls.push({ msgId, priority });
      return articles.get(msgId);
    },
    stat: async () => true,
  };
  const vf = new VirtualFile(pool, nzb, { readAhead: 2 });
  await vf.mount();
  assert.strictEqual(calls[0].priority, 'startup', 'mount should fetch the first segment on the startup lane');
  calls.length = 0;
  vf.cache.clear();
  vf.cacheOrder = [];
  vf.inflight.clear();

  const startup = [];
  for await (const chunk of vf.read(0, 20000, { priority: 'startup' })) startup.push(chunk);
  assert.ok(Buffer.concat(startup).length > 0);
  assert.strictEqual(calls.find((c) => c.msgId === 'seg1@triboon.test').priority, 'startup');
  assert.ok(calls.some((c) => c.priority === 'readAhead'), 'reader should still prefetch later segments at readAhead priority');

  calls.length = 0;
  vf.cache.clear();
  vf.cacheOrder = [];
  vf.inflight.clear();
  const bg = [];
  for await (const chunk of vf.read(0, 20000, { priority: 'background' })) bg.push(chunk);
  assert.ok(Buffer.concat(bg).length > 0);
  assert.deepStrictEqual(
    calls.map((c) => c.priority),
    ['background'],
    'background subtitle reads should not trigger read-ahead or outrank playback work',
  );

  const vfSeek = new VirtualFile(pool, nzb, { readAhead: 0 });
  await vfSeek.mount();
  calls.length = 0;
  vfSeek.cache.clear();
  vfSeek.cacheOrder = [];
  vfSeek.inflight.clear();
  const seek = [];
  for await (const chunk of vfSeek.read(0, 60000, { priority: 'seek' })) seek.push(chunk);
  assert.ok(Buffer.concat(seek).length > 40000);
  assert.deepStrictEqual(
    calls.filter((c) => c.msgId === 'seg1@triboon.test' || c.msgId === 'seg2@triboon.test').map((c) => c.priority),
    ['seek', 'playback'],
    'urgent startup/seek priority should boost the first needed segment, then return to normal playback',
  );

  calls.length = 0;
  vfSeek.cache.clear();
  vfSeek.cacheOrder = [];
  vfSeek.inflight.clear();
  await vfSeek.readAt(40000, 1000);
  assert.strictEqual(
    calls.find((c) => c.msgId === 'seg2@triboon.test').priority,
    'startup',
    'header/random access reads used during mount should stay ahead of read-ahead work',
  );

  calls.length = 0;
  vf.cache.clear();
  vf.cacheOrder = [];
  vf.inflight.clear();
  const aborted = { aborted: true };
  const got = [];
  for await (const chunk of vf.read(0, 20000, { priority: 'seek', signal: aborted })) got.push(chunk);
  assert.strictEqual(got.length, 0);
  assert.deepStrictEqual(calls, [], 'aborted reads should stop before queueing article work');

  const vfInflight = new VirtualFile(pool, nzb, { readAhead: 0 });
  await vfInflight.mount();
  calls.length = 0;
  vfInflight.cache.clear();
  vfInflight.cacheOrder = [];
  vfInflight.inflight.clear();
  const ac = new AbortController();
  let bodyStarted;
  let bodyAborted = false;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  vfInflight.pool = {
    body: (msgId, priority, opts = {}) => {
      calls.push({ msgId, priority });
      bodyStarted();
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          bodyAborted = true;
          const e = new Error('aborted');
          e.code = 'ABORT_ERR';
          reject(e);
        }, { once: true });
      });
    },
    stat: async () => true,
  };
  const iter = vfInflight.read(0, 20000, { priority: 'seek', signal: ac.signal });
  const pending = iter.next();
  await started;
  ac.abort();
  assert.deepStrictEqual(await pending, { value: undefined, done: true });
  assert.strictEqual(bodyAborted, true, 'aborting the last reader should abort the in-flight article BODY');
});

test('vfs: playback upgrades a segment already queued by read-ahead', async () => {
  const { articles, nzb } = makeRelease('Priority.Upgrade.Test.mkv', 160000, 40000);
  const calls = [];
  let releaseReadAhead;
  const readAheadStarted = new Promise((resolve) => { releaseReadAhead = resolve; });
  let finishReadAhead;
  const holdReadAhead = new Promise((resolve) => { finishReadAhead = resolve; });
  const pool = {
    body: async (msgId, priority = 'playback') => {
      calls.push({ msgId, priority });
      if (priority === 'readAhead') {
        releaseReadAhead();
        await holdReadAhead;
      }
      return articles.get(msgId);
    },
    stat: async () => true,
  };
  const vf = new VirtualFile(pool, nzb, { readAhead: 0 });
  await vf.mount();
  calls.length = 0;
  vf.cache.clear();
  vf.cacheOrder = [];
  vf.inflight.clear();

  const low = vf._fetchSegment(1, 'readAhead');
  await readAheadStarted;
  const upgraded = await vf._fetchSegment(1, 'playback');
  finishReadAhead();
  await low;

  assert.ok(upgraded.length > 0, 'urgent playback fetch should return the article bytes');
  assert.deepStrictEqual(
    calls.filter((c) => c.msgId === 'seg2@triboon.test').map((c) => c.priority),
    ['readAhead', 'playback'],
    'playback must not wait behind an already-queued low-priority read-ahead fetch',
  );
});

test('vfs: background warmup does not cancel active player read-ahead', async () => {
  const { data, articles, nzb } = makeRelease('Pause.Warm.Test.mkv', 150000, 30000);
  const calls = [];
  const pool = {
    body: async (msgId, priority = 'playback') => {
      calls.push({ msgId, priority });
      return articles.get(msgId);
    },
    stat: async () => true,
  };
  const vf = new VirtualFile(pool, nzb, { readAhead: 1, cacheSegments: 20, cacheBytes: 1024 * 1024 });
  await vf.mount();
  calls.length = 0;
  vf.cache.clear();
  vf.cacheOrder = [];
  vf.cacheBytes = 0;
  vf.inflight.clear();

  const active = vf.read(0, data.length, { priority: 'startup' })[Symbol.asyncIterator]();
  const first = await active.next();
  assert.strictEqual(first.done, false, 'active player should receive the first segment');

  const warmup = (async () => {
    for await (const _chunk of vf.read(0, 30000, { priority: 'readAhead' })) {
      // Drain like playback warmup does.
    }
  })();

  const activeChunks = [first.value];
  for (;;) {
    const next = await active.next();
    if (next.done) break;
    activeChunks.push(next.value);
  }
  await warmup;

  assert.ok(Buffer.concat(activeChunks).equals(data), 'active playback remains byte-exact while warmup overlaps');
  assert.ok(
    calls.some((c) => c.msgId === 'seg3@triboon.test' && c.priority === 'readAhead'),
    'active playback should keep kicking later read-ahead after background warmup starts',
  );
});

test('vfs: decoded segment cache is capped by bytes, not only segment count', async () => {
  const { articles, nzb } = makeRelease('Cache.Bytes.Test.mkv', 180000, 45000);
  const pool = {
    body: async (msgId) => articles.get(msgId),
    stat: async () => true,
  };
  const vf = new VirtualFile(pool, nzb, { readAhead: 0, cacheSegments: 24, cacheBytes: 90000 });
  await vf.mount();
  const chunks = [];
  for await (const chunk of vf.read(0, 180000)) chunks.push(chunk);
  assert.strictEqual(Buffer.concat(chunks).length, 180000);
  assert.ok(vf.cacheBytes <= vf.cacheMaxBytes, `cache kept ${vf.cacheBytes} bytes over ${vf.cacheMaxBytes}`);
  assert.ok(vf.cache.size <= 2, 'byte cap should evict older decoded segments even when segment cap is high');
});

test('vfs: playback waits temporarily widen read-ahead within the stream cap', async () => {
  const { data, articles, nzb } = makeRelease('Drain.Test.mkv', 120000, 20000);
  const pool = {
    body: async (msgId) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return articles.get(msgId);
    },
    stat: async () => true,
  };
  const vf = new VirtualFile(pool, nzb, { readAhead: 1, cacheSegments: 12, cacheBytes: 1024 * 1024 });
  vf.readWaitBoostMs = 5;
  vf.applyPlaybackWindow({ readAhead: 1, maxReadAhead: 3, cacheMax: 12, cacheMaxBytes: 1024 * 1024 });
  await vf.mount();

  const chunks = [];
  for await (const chunk of vf.read(0, data.length, { priority: 'startup' })) chunks.push(chunk);
  assert.ok(Buffer.concat(chunks).equals(data), 'adaptive read-ahead still streams byte-exact data');

  const stats = vf.playbackSnapshot();
  assert.ok(stats.adaptiveBoosts >= 1, 'playback wait should trigger a temporary boost');
  assert.ok(stats.readAhead > stats.baseReadAhead, 'boost should widen beyond the fair-share base');
  assert.ok(stats.readAhead <= stats.maxReadAhead, 'boost should stay capped by the playback window');
  assert.ok(stats.maxSegmentWaitMs >= 5, 'wait telemetry should record the slow segment');
});

function makeRelease(name, size, partSize) {
  // Deterministic pseudo-random payload (seeded) so failures are reproducible.
  const data = Buffer.allocUnsafe(size);
  let seed = 0x5eed;
  for (let i = 0; i < size; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = seed & 0xff; }
  // Sprinkle bytes that force yEnc escapes at boundaries.
  for (let i = 0; i < size; i += 997) data[i] = [0xd6, 0xe8, 0xd3, 0xf3][i % 4]; // -> 0x00,0x0a,0x0d,0x3d after +42

  const totalParts = Math.ceil(size / partSize);
  const articles = new Map();
  const segs = [];
  for (let p = 0; p < totalParts; p++) {
    const begin = p * partSize;
    const end = Math.min(size, begin + partSize);
    const body = encodePart(data, { name, partNum: p + 1, totalParts, begin, end, totalSize: size });
    const msgId = `seg${p + 1}@triboon.test`;
    articles.set(msgId, body);
    segs.push(`    <segment bytes="${body.length}" number="${p + 1}">${msgId}</segment>`);
  }
  const nzb = `<?xml version="1.0" encoding="utf-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="tester" date="1700000000" subject="Sintel.2010.Test &quot;${name}&quot; yEnc (1/${totalParts})">
    <groups><group>alt.binaries.triboon</group></groups>
    <segments>
${segs.join('\n')}
    </segments>
  </file>
  <file poster="tester" date="1700000000" subject="repair &quot;${name}.par2&quot; yEnc (1/1)">
    <groups><group>alt.binaries.triboon</group></groups>
    <segments><segment bytes="100" number="1">par@triboon.test</segment></segments>
  </file>
</nzb>`;
  return { data, articles, nzb, totalParts };
}

function fetchRange(port, path, range) {
  return new Promise((resolve, reject) => {
    const headers = range ? { Range: range } : {};
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// ---------- unit: yEnc ----------
test('yEnc roundtrip is byte-exact, including escape-heavy data', () => {
  const data = Buffer.allocUnsafe(50000);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff; // covers every byte value
  const enc = encodePart(data, { name: 'x.bin', partNum: 1, totalParts: 1, begin: 0, end: data.length, totalSize: data.length });
  const dec = decode(enc);
  assert.ok(dec.crcOk, 'CRC must validate');
  assert.strictEqual(dec.size, data.length);
  assert.deepStrictEqual(dec.part, { begin: 0, end: data.length });
  assert.ok(dec.data.equals(data), 'decoded bytes must equal source');
});

test('yEnc CRC catches corruption', () => {
  const data = crypto.randomBytes(4096);
  const enc = encodePart(data, { name: 'x', partNum: 1, totalParts: 1, begin: 0, end: 4096, totalSize: 4096 });
  // Flip a byte inside the body (skip the header lines)
  const idx = enc.indexOf('\r\n', enc.indexOf('=ypart')) + 10;
  enc[idx] = enc[idx] === 0x41 ? 0x42 : 0x41;
  const dec = decode(enc);
  assert.strictEqual(dec.crcOk, false);
});

test('yEnc decoder ignores a dangling escape byte instead of reading past the line', () => {
  const body = Buffer.from('=ybegin line=128 size=1 name=x\r\n=\r\n=yend size=0 pcrc32=00000000\r\n', 'latin1');
  const dec = decode(body);
  assert.strictEqual(dec.data.length, 0);
});

// ---------- unit: NZB ----------
test('NZB parser extracts files/segments and primary-file picker skips par2', () => {
  const { nzb } = makeRelease('Movie.mkv', 100000, 10000);
  const parsed = parseNzb(nzb);
  assert.strictEqual(parsed.files.length, 2);
  const primary = pickPrimaryFile(parsed);
  assert.match(primary.subject, /Movie\.mkv/);
  assert.strictEqual(primary.segments.length, 10);
  assert.strictEqual(primary.segments[0].number, 1);
});

// ---------- e2e: the pipeline ----------
test('e2e: mount, full stream, and 30 fuzzed range reads are byte-exact', async () => {
  const SIZE = 2 * 1024 * 1024 + 137; // odd size to exercise last-partial-segment
  const PART = 96 * 1024;
  const { data, articles, nzb } = makeRelease('Sintel.Test.mkv', SIZE, PART);

  const mock = createMockNntp({ articles, requireAuth: true });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, user: 'u', pass: 'p' }, 6);

  const vf = new VirtualFile(pool, nzb, { readAhead: 3 });
  await vf.mount();
  assert.strictEqual(vf.size, SIZE, 'size learned from =ybegin');
  assert.strictEqual(vf.partSize, PART, 'part size learned from segment 1');

  // Full sequential read
  const chunks = [];
  for await (const c of vf.read(0, vf.size)) chunks.push(c);
  const full = Buffer.concat(chunks);
  assert.strictEqual(full.length, SIZE);
  assert.strictEqual(crypto.createHash('sha256').update(full).digest('hex'),
                     crypto.createHash('sha256').update(data).digest('hex'), 'full stream sha256');

  // Seek fuzzing: 30 random [start, end) windows, including cross-segment and tail reads
  let seed = 42;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 30; i++) {
    const start = Math.floor(rnd() * (SIZE - 1));
    const len = 1 + Math.floor(rnd() * Math.min(SIZE - start, 300000));
    const got = [];
    for await (const c of vf.read(start, start + len)) got.push(c);
    const win = Buffer.concat(got);
    assert.ok(win.equals(data.subarray(start, start + len)), `fuzz ${i}: [${start}, +${len})`);
  }

  pool.close();
  await mock.close();
});

test('e2e: HTTP Range endpoint serves 206 with correct bytes and headers', async () => {
  const SIZE = 512 * 1024;
  const PART = 64 * 1024;
  const { data, articles, nzb } = makeRelease('Range.Test.mp4', SIZE, PART);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();

  const { bootServer, setupAdmin, httpJson } = require('./helpers');
  const { server, shutdown, port } = await bootServer({
    NNTP_HOST: '127.0.0.1', NNTP_PORT: nntpPort, NNTP_TLS: 'false', NNTP_USER: null,
  });
  const token = await setupAdmin(port);

  // Mount via API (admin-authenticated under the Phase 3 security model)
  const mountRes = (await httpJson(port, 'POST', '/api/mount', nzb, token)).json;
  assert.strictEqual(mountRes.size, SIZE);
  assert.ok(mountRes.mountMs < 2000, `mount under 2s (was ${mountRes.mountMs}ms)`);

  const full = await fetchRange(port, mountRes.streamUrl);
  assert.strictEqual(full.status, 200);
  assert.ok(full.body.equals(data));

  const mid = await fetchRange(port, mountRes.streamUrl, 'bytes=100000-199999');
  assert.strictEqual(mid.status, 206);
  assert.strictEqual(mid.headers['content-range'], `bytes 100000-199999/${SIZE}`);
  assert.ok(mid.body.equals(data.subarray(100000, 200000)));

  const open = await fetchRange(port, mountRes.streamUrl, `bytes=${SIZE - 5000}-`);
  assert.strictEqual(open.status, 206);
  assert.ok(open.body.equals(data.subarray(SIZE - 5000)));

  const suf = await fetchRange(port, mountRes.streamUrl, 'bytes=-5000');
  assert.strictEqual(suf.status, 206);
  assert.ok(suf.body.equals(data.subarray(SIZE - 5000)), 'suffix range = last N bytes');

  const bad = await fetchRange(port, mountRes.streamUrl, `bytes=${SIZE + 10}-`);
  assert.strictEqual(bad.status, 416);

  await shutdown();
  await mock.close();
});

test('triage: verdicts for healthy, degraded, and dead releases', async () => {
  const { articles, nzb } = makeRelease('Health.Test.mkv', 600000, 60000);
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 4);

  const vf = new VirtualFile(pool, nzb);
  await vf.mount();
  let h = await vf.triage(8);
  assert.strictEqual(h.verdict, 'verified');

  mock.markMissing('seg5@triboon.test');
  // Force the sample to include seg5 by sampling all
  h = await vf.triage(100);
  assert.strictEqual(h.verdict, 'degraded');
  assert.strictEqual(h.missing, 1);

  for (let i = 1; i <= 10; i++) mock.markMissing(`seg${i}@triboon.test`);
  h = await vf.triage(100);
  assert.strictEqual(h.verdict, 'blocked');

  pool.close();
  await mock.close();
});

// ---------- nntp reliability: dead/wedged connections must never hang playback ----------
// The real-world failure: NAT/provider silently kills pooled connections while the user
// browses; the next BODY is written into a dead socket. Without timeouts the mount's
// Promise.all never settles and /api/play hangs forever ("Checking health & buffering…").
test('nntp: a wedged socket times out and the command retries on a fresh connection', async () => {
  const { data, articles, nzb } = makeRelease('Stall.Test.mkv', 256 * 1024, 64 * 1024);
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, commandTimeoutMs: 250 }, 2);

  const vf = new VirtualFile(pool, nzb);
  await vf.mount();
  mock.stallNext(1); // one command vanishes into a NAT-dropped socket
  const t0 = Date.now();
  const got = [];
  for await (const c of vf.read(0, vf.size)) got.push(c);
  assert.ok(Buffer.concat(got).equals(data), 'stream still byte-exact after a wedged socket');
  assert.ok(Date.now() - t0 < 5000, 'recovered via timeout+retry, not a hang');

  pool.close();
  await mock.close();
});

// The command timeout must be a STALL (inactivity) timeout, not a hard deadline from send: a big
// 4K-segment BODY or a healthy-but-slow provider (remote user on a thin uplink) legitimately takes
// longer than commandTimeoutMs to transfer in full. A hard deadline destroyed that connection
// mid-transfer → retry churn → "plays fine then stalls" on every client. As long as bytes keep
// arriving, the transfer must complete.
test('nntp: a slow-but-alive BODY transfer completes instead of being killed mid-flight', async () => {
  const { articles } = makeRelease('Slow.Transfer.mkv', 64 * 1024, 64 * 1024);
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  // 120ms timeout, but the BODY dribbles in 8 pieces 60ms apart (~420ms total). Each gap (60ms) is
  // under the timeout; the TOTAL transfer (420ms) is well over it. Old hard-deadline-from-send code
  // killed the socket at 120ms; the stall timer re-arms on every inbound chunk, so an alive-but-slow
  // transfer must ride through to a byte-exact success.
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, commandTimeoutMs: 120 }, 2);
  const msgId = [...articles.keys()][0];
  mock.trickleNext(8, 60);
  const t0 = Date.now();
  const body = await pool.body(msgId, 'playback');
  const elapsed = Date.now() - t0;
  assert.ok(body && body.length > 0, 'the slow BODY transfer completed');
  assert.ok(elapsed >= 300, `the transfer outlasted the timeout window (${elapsed}ms) — proves the stall timer re-armed on progress`);

  pool.close();
  await mock.close();
});

test('nntp: a fully stalled provider fails within the timeout budget instead of hanging', async () => {
  const { articles, nzb } = makeRelease('Dead.Test.mkv', 128 * 1024, 64 * 1024);
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, commandTimeoutMs: 200 }, 2);

  mock.stallNext(99); // provider answers NOTHING from here on
  const vf = new VirtualFile(pool, nzb);
  const t0 = Date.now();
  await assert.rejects(() => vf.mount(), /timeout/i);
  assert.ok(Date.now() - t0 < 3000, 'failed fast (one timeout + one retry), not forever');

  pool.close();
  await mock.close();
});

test('nntp: read-ahead never takes the last connection — the active player always gets one (no head-of-line stall)', async () => {
  // Regression for "plays fine, then buffers every couple minutes": read-ahead (up to
  // maxConnPerStream segments) used to be able to occupy EVERY connection, so the next-needed
  // PLAYBACK segment had to wait for a read-ahead fetch to finish to get a socket — a multi-second
  // head-of-line stall once the startup/seek burst buffer drained.
  const { articles } = makeRelease('Reserve.Test.mkv', 512 * 1024, 64 * 1024); // 8 segments
  const ids = [...articles.keys()];
  const RTT = 400;
  const mock = createMockNntp({ articles, latencyMs: RTT }); // each BODY answers after ~400ms
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 3); // size 3 -> reserve 1
  pool.warm(3);
  await new Promise((r) => setTimeout(r, RTT + 150)); // let all 3 connections establish

  // Saturate with read-ahead. With the reserve, only 2 occupy connections; 1 is held free.
  const ra = [pool.body(ids[0], 'readAhead'), pool.body(ids[1], 'readAhead'), pool.body(ids[2], 'readAhead')];
  await new Promise((r) => setTimeout(r, 80)); // let 2 dispatch + the 3rd queue behind the reserve

  // The player needs its next segment NOW. It must land on the reserved connection immediately,
  // not queue behind an in-flight read-ahead fetch (which would take ~2× RTT).
  const t0 = Date.now();
  await pool.body(ids[3], 'playback');
  const playbackMs = Date.now() - t0;
  assert.ok(playbackMs < RTT + 200, `playback got a reserved connection (~1 RTT): ${playbackMs}ms (a head-of-line stall would be ~${2 * RTT}ms)`);

  await Promise.all(ra); // read-ahead still completes — the reserve doesn't starve it
  pool.close();
  await mock.close();
});

test('nntp: connections dropped while idle are replaced transparently on the next read', async () => {
  const { data, articles, nzb } = makeRelease('Idle.Test.mkv', 128 * 1024, 64 * 1024);
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 2);

  const vf = new VirtualFile(pool, nzb);
  await vf.mount();
  mock.dropConnections(); // provider idle-kills every pooled connection between plays
  await new Promise((r) => setTimeout(r, 50));
  const got = [];
  for await (const c of vf.read(64 * 1024, vf.size)) got.push(c); // segment 1 isn't cached
  assert.ok(Buffer.concat(got).equals(data.subarray(64 * 1024)), 'reconnected and streamed');

  pool.close();
  await mock.close();
});

test('nntp: sockets idle past the recycle window are reconnected, not reused', async () => {
  const { data, articles, nzb } = makeRelease('Recycle.Test.mkv', 128 * 1024, 64 * 1024);
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, idleRecycleMs: 30 }, 1);

  const vf = new VirtualFile(pool, nzb);
  await vf.mount();
  const before = mock.connCount();
  await new Promise((r) => setTimeout(r, 120)); // idle long enough to be presumed NAT-dropped
  const got = [];
  for await (const c of vf.read(64 * 1024, vf.size)) got.push(c);
  assert.ok(Buffer.concat(got).equals(data.subarray(64 * 1024)), 'read still works after recycle');
  assert.ok(mock.connCount() > before, 'stale idle socket was replaced with a fresh connection');

  pool.close();
  await mock.close();
});

test('speed budget: time-to-first-byte after seek < 250ms on local mock', async () => {
  const SIZE = 4 * 1024 * 1024;
  const PART = 128 * 1024;
  const { articles, nzb } = makeRelease('Speed.Test.mkv', SIZE, PART);
  const mock = createMockNntp({ articles, latencyMs: 20 }); // simulate 20ms provider RTT
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 8);
  const vf = new VirtualFile(pool, nzb, { readAhead: 4 });
  await vf.mount();

  // Cold seek deep into the file
  const t0 = process.hrtime.bigint();
  const it = vf.read(3 * 1024 * 1024 + 777, 3 * 1024 * 1024 + 777 + 1024);
  await it.next();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 250, `first byte after cold seek took ${ms.toFixed(1)}ms`);

  pool.close();
  await mock.close();
});

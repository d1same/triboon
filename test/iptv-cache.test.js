'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { httpJson, httpRaw, bootServer, setupAdmin } = require('./helpers');
const { liveVideoArgs } = require('../server/transcode');
const { getXmltvWorkerState } = require('../server/xmltv');

test('iptv web: video is stream-copied for H.264, transcoded to capped H.264 otherwise', () => {
  // Browser Live TV: H.264 channels copy (fast, full quality); HEVC/MPEG-2 (browser can't decode)
  // transcode to H.264 capped at 1080p with a low-latency preset. Native keeps copy (transcodeVideo=false).
  const copy = liveVideoArgs(false);
  assert.deepStrictEqual(copy, ['-c:v', 'copy'], 'H.264 / native path must stream-copy the video');

  const tx = liveVideoArgs(true).join(' ');
  assert.match(tx, /-c:v libx264/, 'non-H.264 browser path must transcode to H.264');
  assert.match(tx, /-tune zerolatency/, 'live transcode must use a low-latency tune for fast start');
  assert.match(tx, /scale=-2:'min\(1080,ih\)'/, 'browser live transcode must cap at 1080p (4K stays native on the Shield)');
  assert.match(tx, /-pix_fmt yuv420p/, 'output must be 8-bit 4:2:0 so any browser can decode it');
  assert.ok(!/\bcopy\b/.test(tx), 'transcode path must not also copy the video');
});

test('iptv: guide warm targets the next 12-hour boundary', async () => {
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    assert.strictEqual(srv.msUntilNextIptvWarm(new Date(2026, 0, 2, 0, 0, 0, 0).getTime()), 12 * 3600000);
    assert.strictEqual(srv.msUntilNextIptvWarm(new Date(2026, 0, 2, 11, 59, 59, 500).getTime()), 500);
    assert.strictEqual(srv.msUntilNextIptvWarm(new Date(2026, 0, 2, 12, 0, 0, 0).getTime()), 12 * 3600000);
    assert.strictEqual(srv.msUntilNextIptvWarm(new Date(2026, 0, 2, 23, 59, 59, 500).getTime()), 500);
  } finally {
    await srv.shutdown();
  }
});

test('server: repeated isolated boots do not stack process exit listeners', async () => {
  const before = process.listenerCount('exit');
  let max = before;
  for (let i = 0; i < 12; i++) {
    const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
    try {
      max = Math.max(max, process.listenerCount('exit'));
    } finally {
      await srv.shutdown();
    }
  }
  const after = process.listenerCount('exit');
  assert.ok(max <= before + 1, `expected at most one shared cleanup listener, saw ${max - before}`);
  assert.ok(after <= before + 1, `shutdown should not leave per-boot exit listeners behind, saw ${after - before}`);
});

test('iptv: private and loopback playlist URLs are blocked unless explicitly allowed', async () => {
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null, TRIBOON_ALLOW_PRIVATE_IPTV: '0' });
  try {
    const admin = await setupAdmin(srv.port);
    const blocked = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Loopback', iptvMode: 'm3u', iptvUrl: 'http://127.0.0.1:9/list.m3u' }, admin);
    assert.strictEqual(blocked.status, 400);
    assert.match(blocked.json.error, /private|loopback|blocked/i);

    const personal = await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
      { name: 'Mine', iptvMode: 'm3u', iptvUrl: 'http://localhost/list.m3u' }, admin);
    assert.strictEqual(personal.status, 400);
    assert.match(personal.json.error, /private|loopback|blocked/i);

    const legacy = await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: 'http://169.254.169.254/latest/meta-data' }, admin);
    assert.strictEqual(legacy.status, 400);
    assert.match(legacy.json.error, /private|loopback|blocked/i);

    const mapped = [
      'http://[::ffff:169.254.169.254]/latest/meta-data',
      'http://[::ffff:127.0.0.1]/list.m3u',
      'http://[::ffff:10.0.0.5]/list.m3u',
      'http://[64:ff9b::7f00:1]/list.m3u',
      'http://[::7f00:1]/list.m3u',
      'http://[2002:7f00:1::]/list.m3u',
      'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/list.m3u',
    ];
    for (const iptvUrl of mapped) {
      const r = await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
        { name: 'Mapped', iptvMode: 'm3u', iptvUrl }, admin);
      assert.strictEqual(r.status, 400, `${iptvUrl} should be blocked`);
      assert.match(r.json.error, /private|loopback|blocked/i);
    }

    const localIpv6 = [
      'fe80::1',
      'fe80:0000:0000:0000:0000:0000:0000:0001',
      'FEBF::1',
      'ff02::1',
      'FF00:0000:0000:0000:0000:0000:0000:0001',
      'fec0::1',
      'FEFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF',
    ];
    for (const address of localIpv6) {
      assert.strictEqual(srv.isPrivateIp(address), true, `${address} should be classified as non-public`);
      const r = await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
        { name: 'IPv6 local', iptvMode: 'm3u', iptvUrl: `http://[${address}]/list.m3u` }, admin);
      assert.strictEqual(r.status, 400, `${address} should be blocked from IPTV fetches`);
      assert.match(r.json.error, /private|loopback|blocked/i);
    }

    for (const address of [
      '2001:4860:4860::8888',
      '2001:4860:4860:0000:0000:0000:0000:8888',
      '2606:4700:4700:0:0:0:0:1111',
      '2620:FE::FE',
    ]) {
      assert.strictEqual(srv.isPrivateIp(address), false, `${address} is a public IPv6 control`);
    }
  } finally {
    await srv.shutdown();
  }
});

test('iptv: parsed XMLTV guide survives server restart without refetching the guide', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-cache-'));
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 10 * 60000);
  const t1 = new Date(Date.now() + 50 * 60000);
  let guideHits = 0;
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="cache.news" group-title="News",Cache News
http://upstream.example/cache-news.m3u8
`;
  const xmltv = `<?xml version="1.0"?><tv>
<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="cache.news"><title>Cached Morning</title></programme>
</tv>`;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200);
    if (req.url.includes('guide')) {
      guideHits++;
      return res.end(xmltv);
    }
    res.end(m3u);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;

  let first;
  let second;
  try {
    first = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(first.port);
    await httpJson(first.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml` }, admin);
    const warmed = await first.warmIptvCaches('test');
    assert.strictEqual(warmed.configured, true);
    assert.strictEqual(warmed.xmltv, true, 'server-side warm should parse XMLTV before a client opens Live TV');
    const ch = await httpJson(first.port, 'GET', '/api/iptv/channels', null, admin);
    const guide = await httpJson(first.port, 'GET', `/api/iptv/guide?chs=${ch.json.channels[0].idx}&cids=${encodeURIComponent(ch.json.channels[0].id)}`, null, admin);
    assert.strictEqual(guide.json.channels[0].programmes[0].title, 'Cached Morning');
    const staleGuide = await httpJson(first.port, 'GET', `/api/iptv/guide?chs=${ch.json.channels[0].idx}&cids=stale-channel-id`, null, admin);
    assert.strictEqual(staleGuide.status, 409, 'guide requests bind channel indexes to stable ids');
    assert.strictEqual(guideHits, 1, 'guide endpoint used the server-warmed XMLTV cache');
    first.store.flush();
    await first.shutdown();
    first = null;

    second = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const login = await httpJson(second.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    const token = login.json.token;
    const guide2 = await httpJson(second.port, 'GET', '/api/iptv/guide?chs=0', null, token);
    assert.strictEqual(guide2.json.channels[0].programmes[0].title, 'Cached Morning');
    assert.strictEqual(guideHits, 1, 'restart served the persisted parsed guide without refetching XMLTV');
  } finally {
    if (first) await first.shutdown();
    if (second) await second.shutdown();
    upstream.close();
  }
});

test('iptv: one cold guide fanout downloads and parses a source XMLTV only once', async () => {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 10 * 60000);
  const t1 = new Date(Date.now() + 50 * 60000);
  let guideHits = 0;
  const channelRows = Array.from({ length: 8 }, (_, i) =>
    `#EXTINF:-1 tvg-id="fan.${i}" group-title="News",Fan ${i}\nhttp://stream.example/fan-${i}.ts`).join('\n');
  const programmeRows = Array.from({ length: 8 }, (_, i) =>
    `<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="fan.${i}"><title>Fan Show ${i}</title></programme>`).join('');
  const upstream = http.createServer((req, res) => {
    res.writeHead(200);
    if (req.url === '/guide.xml') {
      guideHits++;
      return setTimeout(() => res.end(`<?xml version="1.0"?><tv>${programmeRows}</tv>`), 180);
    }
    res.end(`#EXTM3U\n${channelRows}\n`);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml` }, admin);
    const channels = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.channels;
    assert.strictEqual(channels.length, 8);
    const chs = channels.map((channel) => channel.idx).join(',');
    const cids = channels.map((channel) => encodeURIComponent(channel.id)).join(',');
    const guide = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${chs}&cids=${cids}`, null, admin);
    assert.strictEqual(guide.status, 200);
    assert.strictEqual(guide.json.channels.length, 8);
    assert.strictEqual(guideHits, 1,
      'same-source channel fanout must join one large XMLTV download/worker instead of multiplying it');
  } finally {
    await srv.shutdown();
    upstream.close();
  }
});

test('iptv: a headerless gzip XMLTV guide is decoded and served', async () => {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 10 * 60000);
  const t1 = new Date(Date.now() + 50 * 60000);
  let guideHits = 0;
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="gzip.news",Gzip News\nhttp://stream.example/gzip.ts\n';
  const guideBody = zlib.gzipSync(Buffer.from(`<?xml version="1.0"?><tv>
<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="gzip.news"><title>Compressed News</title></programme>
</tv>`));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/guide.xml.gz') {
      guideHits++;
      res.writeHead(200, { 'Content-Type': 'application/xml' }); // intentionally no Content-Encoding
      return res.end(guideBody);
    }
    res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });
    res.end(m3u);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml.gz` }, admin);
    const channels = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.channels;
    const guide = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${channels[0].idx}&cids=${encodeURIComponent(channels[0].id)}`, null, admin);
    assert.strictEqual(guide.status, 200);
    assert.strictEqual(guide.json.channels[0].programmes[0].title, 'Compressed News');
    assert.strictEqual(guideHits, 1);
  } finally {
    await srv.shutdown();
    upstream.close();
  }
});

test('iptv: a non-2xx XMLTV response fails the refresh and is never cached as an empty guide', async () => {
  let guideHits = 0;
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="auth.news",Auth News\nhttp://stream.example/auth.ts\n';
  const upstream = http.createServer((req, res) => {
    if (req.url === '/guide.xml') {
      guideHits++;
      res.writeHead(401, { 'Content-Type': 'application/xml' });
      return res.end('<error>bad credentials</error>');
    }
    res.end(m3u);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml` }, admin);
    const result = await srv.warmIptvCaches('non-2xx-guide', { force: true });
    assert.strictEqual(result.xmltv, false);
    assert.strictEqual(guideHits, 1);
    assert.ok(result.sourceErrors.some((entry) => /XMLTV guide HTTP 401/.test(entry.error)),
      'the operator sees the upstream HTTP failure instead of a false successful empty cache');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(srv.store.read('epgcaches', {}), 'default'), false);
  } finally {
    await srv.shutdown();
    upstream.close();
  }
});

test('iptv: deleting a source cancels its in-flight XMLTV and cannot resurrect its disk cache', async () => {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 10 * 60000);
  const t1 = new Date(Date.now() + 50 * 60000);
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="delete.news",Delete News\nhttp://stream.example/delete.ts\n';
  const xml = `<tv><programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="delete.news"><title>Deleted Guide</title></programme></tv>`;
  let releaseGuide;
  const guideGate = new Promise((resolve) => { releaseGuide = resolve; });
  let guideStarted;
  const started = new Promise((resolve) => { guideStarted = resolve; });
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/guide.xml') {
      guideStarted();
      await guideGate;
      return res.end(xml);
    }
    res.end(m3u);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    const created = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Delete race', iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml` }, admin);
    const sourceId = created.json.source.id;
    const warm = srv.warmIptvCaches('delete-race', { force: true });
    await started;
    const removed = await httpJson(srv.port, 'DELETE', `/api/iptv/sources/${sourceId}`, null, admin);
    assert.strictEqual(removed.status, 200);
    releaseGuide();
    await warm;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(srv.store.read('epgcaches', {}), sourceId), false,
      'a late network/worker completion cannot repopulate a deleted source cache');
  } finally {
    releaseGuide();
    await srv.shutdown();
    upstream.close();
  }
});

test('iptv: editing a source invalidates an old in-flight XMLTV generation before cache publish', async () => {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 10 * 60000);
  const t1 = new Date(Date.now() + 50 * 60000);
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="edit.news",Edit News\nhttp://stream.example/edit.ts\n';
  const oldXml = `<tv><programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="edit.news"><title>Stale Guide</title></programme></tv>`;
  const newXml = `<tv><programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="edit.news"><title>Current Guide</title></programme></tv>`;
  let releaseOldGuide;
  const oldGuideGate = new Promise((resolve) => { releaseOldGuide = resolve; });
  let oldGuideStarted;
  const started = new Promise((resolve) => { oldGuideStarted = resolve; });
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/old-guide.xml') {
      oldGuideStarted();
      await oldGuideGate;
      return res.end(oldXml);
    }
    if (req.url === '/new-guide.xml') return res.end(newXml);
    res.end(m3u);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    const created = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Edit race', iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/old-guide.xml` }, admin);
    const sourceId = created.json.source.id;
    const staleWarm = srv.warmIptvCaches('edit-race-old', { force: true });
    await started;
    const edited = await httpJson(srv.port, 'PATCH', `/api/iptv/sources/${sourceId}`,
      { epgUrl: `${base}/new-guide.xml` }, admin);
    assert.strictEqual(edited.status, 200);
    releaseOldGuide();
    await staleWarm;
    assert.strictEqual(Object.prototype.hasOwnProperty.call(srv.store.read('epgcaches', {}), sourceId), false,
      'the old generation cannot publish after source edit cleanup');

    const currentWarm = await srv.warmIptvCaches('edit-race-current', { force: true });
    assert.strictEqual(currentWarm.xmltv, true);
    const cached = srv.store.read('epgcaches', {})[sourceId];
    assert.match(JSON.stringify(cached), /Current Guide/);
    assert.doesNotMatch(JSON.stringify(cached), /Stale Guide/);
  } finally {
    releaseOldGuide();
    await srv.shutdown();
    upstream.close();
  }
});

test('server shutdown aborts in-flight XMLTV downloads and prevents post-shutdown workers or writes', async () => {
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="shutdown.news",Shutdown News\nhttp://stream.example/shutdown.ts\n';
  let releaseGuide;
  const guideGate = new Promise((resolve) => { releaseGuide = resolve; });
  let guideStarted;
  const started = new Promise((resolve) => { guideStarted = resolve; });
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/guide.xml') {
      guideStarted();
      await guideGate;
      return res.end('<tv></tv>');
    }
    res.end(m3u);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml` }, admin);
    const warm = srv.warmIptvCaches('shutdown-race', { force: true });
    await started;
    let timeout;
    const before = Date.now();
    try {
      await Promise.race([
        srv.shutdown(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('shutdown waited on XMLTV deadline')), 2000); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.ok(Date.now() - before < 1800, 'shutdown aborts the guide request instead of waiting for its 90s deadline');
    await warm;
    releaseGuide();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(srv.store.read('epgcaches', {}), 'default'), false);
    assert.deepStrictEqual(getXmltvWorkerState(), { active: 0, queued: 0, limit: 2, shuttingDown: false });
    srv = null;
  } finally {
    releaseGuide();
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: guide self-heals a drifted channel index by resolving the stable id', async () => {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 10 * 60000);
  const t1 = new Date(Date.now() + 50 * 60000);
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="news.one" group-title="News",News One
http://upstream.example/news-one.m3u8
#EXTINF:-1 tvg-id="sports.two" group-title="Sports",Sports Two
http://upstream.example/sports-two.m3u8
`;
  const xmltv = `<?xml version="1.0"?><tv>
<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="news.one"><title>Morning News</title></programme>
<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="sports.two"><title>Match Day</title></programme>
</tv>`;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(req.url.includes('guide') ? xmltv : m3u);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml` }, admin);
    await srv.warmIptvCaches('test');
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const chans = ch.json.channels;
    assert.ok(chans.length >= 2, 'need two channels for the drift case');
    // Ask for index 1 but supply channel 0's STABLE id — the classic drifted-index race after a
    // source add/remove reorders the cache. The server must resolve by id (not 409) and echo the
    // programmes back under the REQUESTED idx so the client can still key them to its own row.
    const requestedIdx = chans[1].idx;
    const drifted = await httpJson(srv.port, 'GET',
      `/api/iptv/guide?chs=${requestedIdx}&cids=${encodeURIComponent(chans[0].id)}`, null, admin);
    assert.strictEqual(drifted.status, 200, 'a resolvable stable id must not 409');
    assert.strictEqual(drifted.json.channels[0].idx, requestedIdx, 'programmes echo back under the requested idx');
    assert.strictEqual(drifted.json.channels[0].programmes[0].title, 'Morning News', 'resolved by channel 0 stable id');
    const driftedNowNext = await httpJson(srv.port, 'GET',
      `/api/iptv/epg/${requestedIdx}?cid=${encodeURIComponent(chans[0].id)}`, null, admin);
    assert.strictEqual(driftedNowNext.status, 200, 'now/next must also self-heal a resolvable drifted index');
    assert.strictEqual(driftedNowNext.json.now.title, 'Morning News', 'now/next resolves the requested stable channel id');
    // A cid that matches NO channel is a genuine list change and must still 409.
    const gone = await httpJson(srv.port, 'GET',
      `/api/iptv/guide?chs=${requestedIdx}&cids=this-channel-is-gone`, null, admin);
    assert.strictEqual(gone.status, 409, 'an unresolvable stable id still signals reopen Live TV');
    const goneNowNext = await httpJson(srv.port, 'GET',
      `/api/iptv/epg/${requestedIdx}?cid=this-channel-is-gone`, null, admin);
    assert.strictEqual(goneNowNext.status, 409, 'now/next also rejects an unresolvable stable id');
  } finally {
    await srv.shutdown();
    upstream.close();
  }
});

test('iptv: admin sync status and refresh report channel and guide cache health', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-sync-status-'));
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 10 * 60000);
  const t1 = new Date(Date.now() + 50 * 60000);
  let playlistHits = 0;
  let guideHits = 0;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200);
    if (req.url === '/list.m3u') {
      playlistHits++;
      return res.end(`#EXTM3U
#EXTINF:-1 tvg-id="sync.news" group-title="News",Sync News
http://stream.example/sync-news.ts
`);
    }
    if (req.url === '/guide.xml') {
      guideHits++;
      return res.end(`<?xml version="1.0"?><tv>
<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="sync.news"><title>Sync Morning</title></programme>
</tv>`);
    }
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Sync TV', iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml` }, admin);

    const refresh = await httpJson(srv.port, 'POST', '/api/iptv/refresh', { force: true }, admin);
    assert.strictEqual(refresh.status, 200);
    assert.strictEqual(refresh.json.result.channels, 1);
    assert.strictEqual(refresh.json.result.xmltv, true);
    assert.strictEqual(refresh.json.status.configured, true);
    assert.strictEqual(refresh.json.status.channelCount, 1);
    assert.strictEqual(refresh.json.status.guideSourceCount, 1);
    assert.strictEqual(refresh.json.status.sources[0].sourceName, 'Sync TV');
    assert.strictEqual(refresh.json.status.sources[0].guideKind, 'xmltv');
    assert.strictEqual(refresh.json.status.sources[0].guideChannels, 1);
    assert.ok(refresh.json.status.finishedAt >= refresh.json.status.startedAt);
    assert.ok(playlistHits >= 1, 'manual refresh should fetch the playlist at least once');
    assert.ok(guideHits >= 1, 'manual refresh should fetch the guide at least once');

    const status = await httpJson(srv.port, 'GET', '/api/iptv/status', null, admin);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.json.channelCount, 1);
    assert.strictEqual(status.json.sourceErrors.length, 0);
    assert.strictEqual(status.json.lastResult.channels, 1);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: huge M3U playlists stream-parse to the channel cap without waiting for EOF', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-huge-m3u-'));
  let sourceClosed = false;
  let sourceHit = 0;
  const upstream = http.createServer((req, res) => {
    sourceHit++;
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    for (let i = 0; i < 21000; i++) {
      res.write(`#EXTINF:-1 tvg-id="huge.${i}" group-title="Huge",Huge ${i}\n`);
      res.write(`http://stream.example/huge-${i}.m3u8\n`);
    }
    res.on('close', () => { sourceClosed = true; });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/huge.m3u`, epgUrl: null }, admin);
    const started = Date.now();
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.channels.length, 20000);
    assert.strictEqual(ch.json.channels[19999].name, 'Huge 19999');
    assert.strictEqual(sourceHit, 1);
    assert.ok(Date.now() - started < 5000, 'playlist should resolve at the cap instead of waiting for provider EOF');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(sourceClosed, true, 'server should close the upstream playlist request after reaching the cap');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: an M3U body with no line breaks is refused early and the upstream is closed (S2-8)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-no-newline-'));
  let flatClosed = false;
  let flatBytes = 0;
  const longMeta = `#EXTINF:-1 tvg-id="long.1" group-title="Long" x-pad="${'p'.repeat(200 * 1024)}",Long Line Channel`;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/flat.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.on('close', () => { flatClosed = true; });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const tick = () => {
        if (flatClosed || flatBytes >= 4 * 1024 * 1024) return; // hold the body open, never end it
        flatBytes += chunk.length;
        res.write(chunk);
        setTimeout(tick, 5);
      };
      tick();
      return;
    }
    if (req.url === '/long.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n${longMeta}\nhttp://stream.example/long-1.ts\n`);
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Flat TV', iptvMode: 'm3u', iptvUrl: `${base}/flat.m3u` }, admin);
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Long TV', iptvMode: 'm3u', iptvUrl: `${base}/long.m3u` }, admin);
    const started = Date.now();
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const took = Date.now() - started;
    assert.strictEqual(ch.status, 200);
    const flatErr = (ch.json.sourceErrors || []).find((e) => e.sourceName === 'Flat TV');
    assert.ok(flatErr, 'the flat source must report a source error');
    assert.match(flatErr.error, /no line breaks/);
    assert.ok(took < 5000, `the flat body must be refused well before the deadline (took ${took} ms)`);
    assert.ok(flatBytes < 4 * 1024 * 1024, `the server must stop reading near the 1 MB cap (mock wrote ${flatBytes} bytes)`);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(flatClosed, true, 'the upstream request must be closed after the refusal');
    const longCh = ch.json.channels.filter((c) => c.sourceName === 'Long TV');
    assert.strictEqual(longCh.length, 1, 'a valid playlist with one 200 KB #EXTINF line still parses');
    assert.strictEqual(longCh[0].name, 'Long Line Channel');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: a refresh that returns 0 channels keeps the last good list in memory and on disk (S2-3)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-empty-refresh-'));
  let xtMode = 'good';
  let m3uMode = 'good';
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/player_api.php') {
      const action = u.searchParams.get('action');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
      if (action === 'get_live_streams') {
        if (xtMode === 'emptyArray') return res.end('[]');
        if (xtMode === 'emptyBody') return res.end('');
        return res.end(JSON.stringify([
          { stream_id: 801, name: 'Keep One', category_id: '1' },
          { stream_id: 802, name: 'Keep Two', category_id: '1' },
        ]));
      }
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    if (u.pathname === '/get.php') { res.writeHead(200); return res.end('#EXTM3U\n'); }
    if (u.pathname === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      if (m3uMode === 'headerOnly') return res.end('#EXTM3U\n');
      return res.end('#EXTM3U\n#EXTINF:-1 group-title="Films",Keep Film\nhttp://stream.example/keep-film.ts\n');
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const xt = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Keep XT', iptvMode: 'xtream', xtHost: host, xtUser: 'u1', xtPass: 'p1' }, admin);
    assert.strictEqual(xt.status, 200, JSON.stringify(xt.json));
    const m3u = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Keep M3U', iptvMode: 'm3u', iptvUrl: `${host}/list.m3u` }, admin);
    assert.strictEqual(m3u.status, 200, JSON.stringify(m3u.json));
    const names = (json) => (json.channels || []).map((c) => c.name).sort();
    const first = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.deepStrictEqual(names(first.json), ['Keep Film', 'Keep One', 'Keep Two']);
    const xtId = first.json.channels.find((c) => c.name === 'Keep One').sourceId;
    srv.store.flush();
    const diskBefore = (srv.store.read('iptvcaches', {}) || {})[xtId];
    assert.ok(diskBefore && diskBefore.channels.length === 2, 'the good Xtream list is persisted');

    for (const mode of ['emptyArray', 'emptyBody']) {
      xtMode = mode;
      m3uMode = 'headerOnly';
      const refresh = await httpJson(srv.port, 'POST', '/api/iptv/refresh', { force: true }, admin);
      assert.strictEqual(refresh.status, 200);
      const errs = (refresh.json.result && refresh.json.result.sourceErrors) || [];
      const xtErr = errs.find((e) => e.sourceName === 'Keep XT');
      const m3uErr = errs.find((e) => e.sourceName === 'Keep M3U');
      assert.ok(xtErr && /keeping 2 cached/.test(xtErr.error), `${mode}: Xtream warning names the kept count: ${JSON.stringify(errs)}`);
      assert.ok(m3uErr && /keeping 1 cached/.test(m3uErr.error), `${mode}: M3U warning names the kept count: ${JSON.stringify(errs)}`);
      const after = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
      assert.deepStrictEqual(names(after.json), ['Keep Film', 'Keep One', 'Keep Two'], `${mode}: channels kept`);
      srv.store.flush();
      const disk = (srv.store.read('iptvcaches', {}) || {})[xtId];
      assert.ok(disk && disk.channels.length === 2, `${mode}: the persisted Xtream list is not overwritten`);
      const status = await httpJson(srv.port, 'GET', '/api/iptv/status', null, admin);
      assert.ok((status.json.sourceErrors || []).some((e) => /keeping 2 cached/.test(e.error)),
        `${mode}: the kept-cache warning stays visible in sync status`);
    }
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: playlists are source-scoped and deleting one removes its channels and favorites', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-sources-'));
  const playlist = (name, group, url) => `#EXTM3U
#EXTINF:-1 group-title="${group}",${name}
${url}
`;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    if (req.url === '/alpha.m3u') return res.end(playlist('Shared News', 'News', 'http://stream.example/shared.ts'));
    if (req.url === '/beta.m3u') return res.end(playlist('Shared News', 'News', 'http://stream.example/shared.ts'));
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const alpha = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Alpha TV', iptvMode: 'm3u', iptvUrl: `${base}/alpha.m3u` }, admin);
    const beta = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Beta TV', iptvMode: 'm3u', iptvUrl: `${base}/beta.m3u` }, admin);
    assert.strictEqual(alpha.status, 200);
    assert.strictEqual(beta.status, 200);

    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.channels.length, 2);
    assert.deepStrictEqual(ch.json.channels.map((c) => c.sourceName).sort(), ['Alpha TV', 'Beta TV']);
    assert.strictEqual(new Set(ch.json.channels.map((c) => c.id)).size, 2,
      'same upstream stream URL in two playlists still gets two source-scoped channel ids');
    assert.ok(ch.json.channels.every((c) => /^Alpha TV · News$|^Beta TV · News$/.test(c.group)),
      'duplicate provider groups are source-prefixed only when multiple playlists are active');

    const alphaChannel = ch.json.channels.find((c) => c.sourceName === 'Alpha TV');
    await httpJson(srv.port, 'POST', '/api/iptv/fav', { id: alphaChannel.id }, admin);
    const fav = await httpJson(srv.port, 'GET', '/api/iptv/channels?fav=1', null, admin);
    assert.deepStrictEqual(fav.json.channels.map((c) => c.sourceName), ['Alpha TV']);
    const limited = await httpJson(srv.port, 'GET', '/api/iptv/channels?lean=1&limit=1', null, admin);
    assert.strictEqual(limited.status, 200);
    assert.strictEqual(limited.json.configured, true);
    assert.strictEqual(limited.json.channels.length, 1);
    assert.strictEqual(limited.json.channels[0].streamUrl, undefined);

    const del = await httpJson(srv.port, 'DELETE', `/api/iptv/sources/${alpha.json.source.id}`, null, admin);
    assert.strictEqual(del.status, 200);
    const after = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(after.json.channels.length, 1);
    assert.strictEqual(after.json.channels[0].sourceName, 'Beta TV');
    assert.strictEqual(after.json.channels[0].group, 'News', 'single remaining playlist returns normal group labels');
    const favAfter = await httpJson(srv.port, 'GET', '/api/iptv/channels?fav=1', null, admin);
    assert.strictEqual(favAfter.json.channels.length, 0, 'deleted playlist favorites are removed with the source');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: sync status ignores source errors for deleted playlists', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-deleted-source-status-'));
  const srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    srv.store.write('iptvsync', {
      sourceErrors: [{
        sourceId: 'src_deleted',
        sourceName: 'apollo',
        mode: 'xtream',
        error: 'Xtream channel load action=get_live_streams host=provider.example failed: HTTP 403',
      }],
    });

    const empty = await httpJson(srv.port, 'GET', '/api/iptv/status', null, admin);
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.json.configured, false);
    assert.deepStrictEqual(empty.json.sourceErrors, [], 'deleted playlist errors must not show when no playlist is saved');

    const created = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Fresh TV', iptvMode: 'm3u', iptvUrl: 'http://example.invalid/list.m3u' }, admin);
    assert.strictEqual(created.status, 200);
    const activeId = created.json.source.id;
    srv.store.write('iptvsync', {
      sourceErrors: [
        {
          sourceId: 'src_deleted',
          sourceName: 'apollo',
          mode: 'xtream',
          error: 'old Xtream HTTP 403',
        },
        {
          sourceId: activeId,
          sourceName: 'Fresh TV',
          mode: 'm3u',
          error: 'm3u playlist HTTP 404',
        },
      ],
    });

    const active = await httpJson(srv.port, 'GET', '/api/iptv/status', null, admin);
    assert.strictEqual(active.json.sourceErrors.length, 1);
    assert.strictEqual(active.json.sourceErrors[0].sourceName, 'Fresh TV');
    assert.match(active.json.sourceErrors[0].error, /m3u playlist HTTP 404/);

    const del = await httpJson(srv.port, 'DELETE', `/api/iptv/sources/${activeId}`, null, admin);
    assert.strictEqual(del.status, 200);
    const afterDelete = await httpJson(srv.port, 'GET', '/api/iptv/status', null, admin);
    assert.strictEqual(afterDelete.json.configured, false);
    assert.deepStrictEqual(afterDelete.json.sourceErrors, [], 'removing the playlist clears its visible sync issue');
  } finally {
    await srv.shutdown();
  }
});

test('iptv: one bad source reports diagnostics without hiding healthy channels', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-partial-source-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/good.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 group-title="News",Working News
http://stream.example/working-news.ts
`);
    }
    if (req.url === '/bad.m3u') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('missing');
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Good TV', iptvMode: 'm3u', iptvUrl: `${base}/good.m3u` }, admin);
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Bad TV', iptvMode: 'm3u', iptvUrl: `${base}/bad.m3u` }, admin);

    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.channels.length, 1);
    assert.strictEqual(ch.json.channels[0].sourceName, 'Good TV');
    assert.strictEqual(ch.json.sourceErrors.length, 1);
    assert.strictEqual(ch.json.sourceErrors[0].sourceName, 'Bad TV');
    assert.match(ch.json.sourceErrors[0].error, /m3u playlist HTTP 404/);
    assert.ok(!JSON.stringify(ch.json.sourceErrors).includes(String(upstream.address().port)),
      'source diagnostics must not leak provider URLs or credentials');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: non-live playlists return empty-state diagnostics instead of a hard failure', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-non-live-source-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/series.m3u') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ series: [{ title: 'Episode playlist, not live TV' }] }));
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Show Playlist', iptvMode: 'm3u', iptvUrl: `${base}/series.m3u` }, admin);

    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.configured, true);
    assert.strictEqual(ch.json.channels.length, 0);
    assert.strictEqual(ch.json.sourceErrors.length, 1);
    assert.strictEqual(ch.json.sourceErrors[0].sourceName, 'Show Playlist');
    assert.match(ch.json.sourceErrors[0].error, /no live channels found/);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: deleting and re-adding a source starts from a clean playlist cache', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-source-clean-'));
  let version = 'old';
  let listHits = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      listHits++;
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 group-title="News",${version === 'old' ? 'Old News' : 'Fresh News'}
http://stream.example/${version}.ts
`);
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const first = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Reload TV', iptvMode: 'm3u', iptvUrl: `${base}/list.m3u` }, admin);
    const oldChannels = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(oldChannels.json.channels[0].name, 'Old News');
    assert.strictEqual(listHits, 1);

    await httpJson(srv.port, 'DELETE', `/api/iptv/sources/${first.json.source.id}`, null, admin);
    version = 'fresh';
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Reload TV', iptvMode: 'm3u', iptvUrl: `${base}/list.m3u` }, admin);
    const fresh = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(fresh.json.channels.length, 1);
    assert.strictEqual(fresh.json.channels[0].name, 'Fresh News');
    assert.strictEqual(listHits, 2, 're-added playlist must fetch fresh instead of reusing the deleted source cache');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: users can add personal server playlists from Preferences without leaking sources', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-user-iptv-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/alice.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 tvg-id="alice.news" group-title="News",Alice News
http://${req.headers.host}/alice.ts
`);
    }
    if (req.url === '/bob.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 tvg-id="bob.news" group-title="News",Bob News
http://${req.headers.host}/bob.ts
`);
    }
    if (req.url === '/alice.ts') {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('alice-ts');
    }
    if (req.url === '/bob.ts') {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('bob-ts');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const inviteA = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
    const aliceJoin = await httpJson(srv.port, 'POST', '/api/invite/accept',
      { token: inviteA.json.token, name: 'alice', password: 'alice-pass' });
    const inviteB = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
    const bobJoin = await httpJson(srv.port, 'POST', '/api/invite/accept',
      { token: inviteB.json.token, name: 'bob', password: 'bob-pass' });
    const alice = aliceJoin.json.token;
    const bob = bobJoin.json.token;

    const created = await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
      { name: 'Alice IPTV', iptvMode: 'm3u', iptvUrl: `${base}/alice.m3u` }, alice);
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.json.source.personal, true);
    assert.strictEqual(created.json.source.iptvUrl, `127.0.0.1:${upstream.address().port}`, 'personal source details are redacted to host');

    const aliceSources = await httpJson(srv.port, 'GET', '/api/me/iptv/sources', null, alice);
    assert.strictEqual(aliceSources.json.sources.length, 1);
    const bobSources = await httpJson(srv.port, 'GET', '/api/me/iptv/sources', null, bob);
    assert.strictEqual(bobSources.json.sources.length, 0, 'other users cannot list a personal source');
    const forbiddenEdit = await httpJson(srv.port, 'PATCH', `/api/me/iptv/sources/${created.json.source.id}`,
      { name: 'Bob should not edit this' }, bob);
    assert.strictEqual(forbiddenEdit.status, 403, 'users cannot edit someone else personal source');
    const edited = await httpJson(srv.port, 'PATCH', `/api/me/iptv/sources/${created.json.source.id}`,
      { name: 'Alice IPTV Fixed', iptvMode: 'm3u' }, alice);
    assert.strictEqual(edited.status, 200);
    assert.strictEqual(edited.json.source.id, created.json.source.id, 'personal edit should keep the source id stable');
    assert.strictEqual(edited.json.source.name, 'Alice IPTV Fixed');
    assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, alice)).json.iptvAllowed, true);
    assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, bob)).json.iptvAllowed, false);

    const aliceView = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, alice);
    assert.strictEqual(aliceView.json.configured, true);
    assert.deepStrictEqual(aliceView.json.channels.map((c) => c.name), ['Alice News']);
    assert.match(aliceView.json.channels[0].nativeUrl, /cid=/, 'stream URLs should bind the token to the channel id');
    const bobViewBefore = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, bob);
    assert.strictEqual(bobViewBefore.json.configured, false);

    await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
      { name: 'Bob IPTV', iptvMode: 'm3u', iptvUrl: `${base}/bob.m3u` }, bob);
    const bobView = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, bob);
    assert.deepStrictEqual(bobView.json.channels.map((c) => c.name), ['Bob News']);

    const aliceNative = await httpRaw(srv.port, aliceView.json.channels[0].nativeUrl);
    assert.strictEqual(aliceNative.status, 200);
    assert.strictEqual(aliceNative.body.toString('utf8'), 'alice-ts', 'stream lookup reloads the cache for the token owner');

    const forbidden = await httpJson(srv.port, 'DELETE', `/api/me/iptv/sources/${created.json.source.id}`, null, bob);
    assert.strictEqual(forbidden.status, 403, 'users cannot remove someone else personal source');
    const removed = await httpJson(srv.port, 'DELETE', `/api/me/iptv/sources/${created.json.source.id}`, null, alice);
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.json.removed, true);
    assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me/iptv/sources', null, alice)).json.sources.length, 0);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: deleting or renaming a personal playlist never edits the admin hide list or other users\' hides (S2-2)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-hide-scope-'));
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
    res.end(`#EXTM3U\n#EXTINF:-1 group-title="News",News ${req.url}\nhttp://stream.example${req.url}/n.ts\n#EXTINF:-1 group-title="Adult",Adult ${req.url}\nhttp://stream.example${req.url}/a.ts\n`);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const join = async (name) => {
      const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
      const acc = await httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name, password: `${name}-pass` });
      assert.strictEqual(acc.status, 200);
      return { token: acc.json.token, id: acc.json.user.id };
    };
    const alice = await join('alice');
    const bob = await join('bob');
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'A', iptvMode: 'm3u', iptvUrl: `${base}/admin-a` }, admin)).status, 200);
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'B', iptvMode: 'm3u', iptvUrl: `${base}/admin-b` }, admin)).status, 200);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvHiddenGroups: ['A · Adult'] }, admin);
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/iptv/groups', { hidden: ['A · News'] }, bob.token)).status, 200);
    const groupsOf = (uid) => (srv.store.read('iptvgroups', {}) || {})[uid] || [];
    const adminHidden = async () => (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.globalHidden;

    // Delete: alice makes a personal playlist with the admin source's name, hides one of its
    // groups for herself, then deletes it.
    const mine = await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
      { name: 'A', iptvMode: 'm3u', iptvUrl: `${base}/alice-a` }, alice.token);
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.json));
    await httpJson(srv.port, 'POST', '/api/iptv/groups', { hidden: ['A · Adult'] }, alice.token);
    const del = await httpJson(srv.port, 'DELETE', `/api/me/iptv/sources/${mine.json.source.id}`, null, alice.token);
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await adminHidden(), ['A · Adult'], 'a personal delete must not touch the admin hide list');
    assert.deepStrictEqual(groupsOf(bob.id), ['A · News'], 'a personal delete must not touch another user\'s hides');
    assert.deepStrictEqual(groupsOf(alice.id), [], 'the deleting user\'s own hides for that playlist are cleaned');

    // Rename: same set-up, alice renames her personal "A".
    const again = await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
      { name: 'A', iptvMode: 'm3u', iptvUrl: `${base}/alice-a2` }, alice.token);
    assert.strictEqual(again.status, 200);
    await httpJson(srv.port, 'POST', '/api/iptv/groups', { hidden: ['A · Adult'] }, alice.token);
    const renamed = await httpJson(srv.port, 'PATCH', `/api/me/iptv/sources/${again.json.source.id}`,
      { name: 'A2', iptvMode: 'm3u' }, alice.token);
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.json));
    assert.deepStrictEqual(await adminHidden(), ['A · Adult'], 'a personal rename must not touch the admin hide list');
    assert.deepStrictEqual(groupsOf(bob.id), ['A · News'], 'a personal rename must not touch another user\'s hides');
    assert.deepStrictEqual(groupsOf(alice.id), [], 'the renaming user\'s own stale hides are cleaned');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: admin-hidden categories match by source and group, whatever label the caller sees (S2-1)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-hide-label-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/dead') { res.writeHead(404); return res.end('gone'); }
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
    if (req.url === '/p') return res.end('#EXTM3U\n#EXTINF:-1 group-title="Mine",Mine One\nhttp://stream.example/p/1.ts\n');
    if (req.url === '/b') return res.end('#EXTM3U\n#EXTINF:-1 group-title="News",News B\nhttp://stream.example/b/n.ts\n');
    return res.end('#EXTM3U\n#EXTINF:-1 group-title="News",News A\nhttp://stream.example/a/n.ts\n#EXTINF:-1 group-title="Adult",Adult A\nhttp://stream.example/a/x.ts\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
    const acc = await httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name: 'alice', password: 'alice-pass' });
    const alice = acc.json.token;
    const userNames = async () => (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, alice)).json.channels.map((c) => c.name).sort();
    const adultFromAdmin = async () => (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.channels.find((c) => c.name === 'Adult A');
    const assertBlocked = async (label) => {
      const ch = await adultFromAdmin();
      assert.ok(ch, `${label}: admin still sees the hidden channel`);
      const idx = ch.sourceIdx; // alice's view in these steps holds source A alone, in source order
      const cid = encodeURIComponent(ch.id);
      assert.strictEqual((await httpJson(srv.port, 'GET', `/api/iptv/play/${idx}?cid=${cid}`, null, alice)).status, 404, `${label}: play`);
      assert.strictEqual((await httpRaw(srv.port, `/api/iptv/native/${idx}?cid=${cid}`, { token: alice })).status, 404, `${label}: native`);
      assert.strictEqual((await httpRaw(srv.port, `/api/iptv/stream/${idx}?cid=${cid}`, { token: alice })).status, 404, `${label}: stream`);
      const guide = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${idx}&cids=${cid}`, null, alice);
      assert.deepStrictEqual(guide.json.channels, [], `${label}: guide omits the hidden channel`);
      assert.strictEqual((await httpJson(srv.port, 'GET', `/api/iptv/epg/${idx}?cid=${cid}`, null, alice)).status, 404, `${label}: epg`);
    };

    // (b) one admin source, bare hide, then the user adds one personal playlist.
    const a = await httpJson(srv.port, 'POST', '/api/iptv/sources', { name: 'A', iptvMode: 'm3u', iptvUrl: `${base}/a` }, admin);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvHiddenGroups: ['Adult'] }, admin);
    assert.deepStrictEqual(await userNames(), ['News A'], '(b) one source: bare hide works');
    const mine = await httpJson(srv.port, 'POST', '/api/me/iptv/sources', { name: 'P', iptvMode: 'm3u', iptvUrl: `${base}/p` }, alice);
    assert.strictEqual(mine.status, 200);
    assert.deepStrictEqual(await userNames(), ['Mine One', 'News A'], '(b) a personal playlist must not lift the bare hide');
    await httpJson(srv.port, 'DELETE', `/api/me/iptv/sources/${mine.json.source.id}`, null, alice);

    // (a) two admin sources, prefixed hide, the user sees source A only.
    const b = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'B', iptvMode: 'm3u', iptvUrl: `${base}/b`, users: ['someone-else'] }, admin);
    assert.strictEqual(b.status, 200);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvHiddenGroups: ['A · Adult'] }, admin);
    assert.deepStrictEqual(await userNames(), ['News A'], '(a) a user who sees fewer sources keeps the hide');
    await assertBlocked('(a)');

    // (c) both sources open to everyone, but source B is down.
    await httpJson(srv.port, 'PATCH', `/api/iptv/sources/${b.json.source.id}`, { iptvUrl: `${base}/dead`, users: [] }, admin);
    assert.deepStrictEqual(await userNames(), ['News A'], '(c) a source outage must not lift the hide');
    await assertBlocked('(c)');

    // (d) B back up; the admin renames A to A2.
    await httpJson(srv.port, 'PATCH', `/api/iptv/sources/${b.json.source.id}`, { iptvUrl: `${base}/b` }, admin);
    assert.deepStrictEqual(await userNames(), ['News A', 'News B']);
    const renamed = await httpJson(srv.port, 'PATCH', `/api/iptv/sources/${a.json.source.id}`, { name: 'A2' }, admin);
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.json));
    assert.deepStrictEqual(await userNames(), ['News A', 'News B'], '(d) an admin rename keeps the hide');
    assert.deepStrictEqual((await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.globalHidden, ['A2 · Adult']);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: admin playlist edit updates the source in place and clears stale channels', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-edit-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/one.m3u') {
      res.writeHead(200);
      return res.end(`#EXTM3U
#EXTINF:-1 tvg-id="one.news" group-title="News",One News
http://${req.headers.host}/one.ts
`);
    }
    if (req.url === '/two.m3u') {
      res.writeHead(200);
      return res.end(`#EXTM3U
#EXTINF:-1 tvg-id="two.news" group-title="News",Two News
http://${req.headers.host}/two.ts
`);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const created = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'First playlist', iptvMode: 'm3u', iptvUrl: `${base}/one.m3u` }, admin);
    assert.strictEqual(created.status, 200);
    const firstChannels = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.deepStrictEqual(firstChannels.json.channels.map((c) => c.name), ['One News']);

    const edited = await httpJson(srv.port, 'PATCH', `/api/iptv/sources/${created.json.source.id}`,
      { name: 'Second playlist', iptvMode: 'm3u', iptvUrl: `${base}/two.m3u` }, admin);
    assert.strictEqual(edited.status, 200);
    assert.strictEqual(edited.json.source.id, created.json.source.id, 'admin edit should keep the source id stable');
    assert.strictEqual(edited.json.source.name, 'Second playlist');
    const afterEdit = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.deepStrictEqual(afterEdit.json.channels.map((c) => c.name), ['Two News']);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: rapid channel changes close the previous upstream stream before opening the next', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-retune-'));
  let activeStreams = 0;
  let maxActiveStreams = 0;
  let closedStreams = 0;
  const timers = new Set();
  const playlist = ['#EXTM3U'];
  for (let i = 0; i < 6; i++) {
    playlist.push(`#EXTINF:-1 group-title="Test",Zap ${i}`);
    playlist.push(`http://127.0.0.1:PORT/live/${i}.ts`);
  }
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(upstream.address().port)));
    }
    if (req.url.startsWith('/live/')) {
      activeStreams++;
      maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      const t = setInterval(() => {
        if (!res.destroyed) res.write(Buffer.alloc(188, 0x47));
      }, 25);
      timers.add(t);
      res.on('close', () => {
        clearInterval(t);
        timers.delete(t);
        activeStreams--;
        closedStreams++;
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const openStream = (port, p) => new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: p,
      headers: { 'user-agent': 'TriboonTV-test' },
    }, (res) => {
      res.once('data', () => resolve({ req, res }));
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
  const waitFor = async (fn, ms = 2500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  let srv;
  const clients = [];
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    for (let i = 0; i < 6; i++) {
      clients.push(await openStream(srv.port, ch.json.channels[i].nativeUrl));
    }
    assert.ok(await waitFor(() => activeStreams === 1 && closedStreams >= 5),
      `expected only the newest channel upstream to remain open; active=${activeStreams} closed=${closedStreams}`);
    assert.strictEqual(maxActiveStreams, 1, 'retuning should not stack provider stream connections');
  } finally {
    for (const c of clients) {
      try { c.res.destroy(); } catch {}
      try { c.req.destroy(); } catch {}
    }
    if (srv) await srv.shutdown();
    timers.forEach((t) => clearInterval(t));
    upstream.close();
  }
});

test('iptv: multiview surfaces keep separate live slots (panes do not evict each other)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-surface-'));
  let activeStreams = 0;
  const timers = new Set();
  const playlist = ['#EXTM3U'];
  for (let i = 0; i < 4; i++) {
    playlist.push(`#EXTINF:-1 group-title="Test",Pane ${i}`);
    playlist.push(`http://127.0.0.1:PORT/live/${i}.ts`);
  }
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(upstream.address().port)));
    }
    if (req.url.startsWith('/live/')) {
      activeStreams++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      const t = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(188, 0x47)); }, 25);
      timers.add(t);
      res.on('close', () => { clearInterval(t); timers.delete(t); activeStreams--; });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const openStream = (port, p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': 'TriboonTV-test' } },
      (res) => { res.once('data', () => resolve({ req, res })); res.on('error', () => {}); });
    req.on('error', reject);
  });
  const waitFor = async (fn, ms = 2500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };
  const withSurface = (u, s) => u + (u.includes('?') ? '&' : '?') + 'surface=' + s;
  let srv;
  const clients = [];
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    // Two different multiview panes (mv0, mv1) must BOTH stay open — the bug was that opening the
    // second pane evicted ("retuned") the first because they shared one slot key.
    clients.push(await openStream(srv.port, withSurface(ch.json.channels[0].nativeUrl, 'mv0')));
    clients.push(await openStream(srv.port, withSurface(ch.json.channels[1].nativeUrl, 'mv1')));
    assert.ok(await waitFor(() => activeStreams === 2),
      `both multiview panes should stream concurrently; active=${activeStreams}`);
    // Retuning the SAME pane (mv0) still closes only that pane's old upstream — mv1 keeps playing.
    clients.push(await openStream(srv.port, withSurface(ch.json.channels[2].nativeUrl, 'mv0')));
    assert.ok(await waitFor(() => activeStreams === 2),
      `retuning one pane must not drop the other; active=${activeStreams}`);
  } finally {
    for (const c of clients) { try { c.res.destroy(); } catch {} try { c.req.destroy(); } catch {} }
    if (srv) await srv.shutdown();
    timers.forEach((t) => clearInterval(t));
    upstream.close();
  }
});

test('iptv: same-channel native viewers SHARE one upstream connection (fan-out); zaps still close it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-share-'));
  let activeStreams = 0;
  let totalConnections = 0;
  const timers = new Set();
  const playlist = ['#EXTM3U'];
  for (let i = 0; i < 2; i++) {
    playlist.push(`#EXTINF:-1 group-title="Test",Share ${i}`);
    playlist.push(`http://127.0.0.1:PORT/live/${i}.ts`);
  }
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(upstream.address().port)));
    }
    if (req.url.startsWith('/live/')) {
      activeStreams++;
      totalConnections++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      const t = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(188, 0x47)); }, 25);
      timers.add(t);
      res.on('close', () => { clearInterval(t); timers.delete(t); activeStreams--; });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const openStream = (port, p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': 'TriboonTV-test' } },
      (res) => { res.once('data', () => resolve({ req, res })); res.on('error', () => {}); });
    req.on('error', reject);
  });
  const waitFor = async (fn, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };
  const chunksOf = (res) => new Promise((resolve) => {
    let n = 0;
    const onData = () => { if (++n >= 2) { res.off('data', onData); resolve(n); } };
    res.on('data', onData);
  });
  const withSurface = (u, s) => u + (u.includes('?') ? '&' : '?') + 'surface=' + s;
  let srv;
  const clients = [];
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);

    // (1) SHARE: two surfaces on the SAME channel = both receive bytes, ONE provider connection.
    const a = await openStream(srv.port, withSurface(ch.json.channels[0].nativeUrl, 'mv0'));
    clients.push(a);
    const b = await openStream(srv.port, withSurface(ch.json.channels[0].nativeUrl, 'mv1'));
    clients.push(b);
    await chunksOf(b.res); // the joiner keeps receiving live bytes, not just the backfill
    assert.strictEqual(totalConnections, 1, `same channel must share one upstream (got ${totalConnections})`);
    assert.strictEqual(activeStreams, 1, 'exactly one provider connection is active');

    // (2) One viewer leaving must not disturb the other (and must not close the upstream).
    b.res.destroy(); b.req.destroy();
    await chunksOf(a.res); // still flowing
    assert.strictEqual(activeStreams, 1, 'the survivor keeps the shared upstream');

    // (3) A late viewer joins the LIVE hub — still no new provider connection.
    const c = await openStream(srv.port, withSurface(ch.json.channels[0].nativeUrl, 'mv2'));
    clients.push(c);
    await chunksOf(c.res);
    assert.strictEqual(totalConnections, 1, `late join must reuse the live upstream (got ${totalConnections})`);

    // (4) A retune with OTHER viewers remaining keeps the old channel's upstream alive.
    const a2 = await openStream(srv.port, withSurface(ch.json.channels[1].nativeUrl, 'mv0'));
    clients.push(a2);
    assert.ok(await waitFor(() => activeStreams === 2),
      `channel 0 (still watched by mv2) + channel 1 = two upstreams; active=${activeStreams}`);
    assert.strictEqual(totalConnections, 2);

    // (5) The LAST viewer retuning away closes the old upstream IMMEDIATELY (the 1-connection
    // zap contract) — and joins the destination channel's live hub with no new connection.
    const c2 = await openStream(srv.port, withSurface(ch.json.channels[1].nativeUrl, 'mv2'));
    clients.push(c2);
    await chunksOf(c2.res);
    assert.ok(await waitFor(() => activeStreams === 1),
      `channel 0's upstream must close when its last viewer retunes; active=${activeStreams}`);
    assert.strictEqual(totalConnections, 2, 'the retuned viewer joined channel 1\'s existing upstream');
  } finally {
    for (const cl of clients) { try { cl.res.destroy(); } catch {} try { cl.req.destroy(); } catch {} }
    if (srv) await srv.shutdown();
    timers.forEach((t) => clearInterval(t));
    upstream.close();
  }
});

test('iptv: two logins of one account on one address and User-Agent keep separate live slots (S1-2)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-two-devices-'));
  let activeStreams = 0;
  const timers = new Set();
  const playlist = ['#EXTM3U'];
  for (let i = 0; i < 2; i++) {
    playlist.push(`#EXTINF:-1 group-title="Test",Dev ${i}`);
    playlist.push(`http://127.0.0.1:PORT/live/${i}.ts`);
  }
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(upstream.address().port)));
    }
    if (req.url.startsWith('/live/')) {
      activeStreams++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      const t = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(188, 0x47)); }, 25);
      timers.add(t);
      res.on('close', () => { clearInterval(t); timers.delete(t); activeStreams--; });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const openStream = (port, p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': 'TriboonTV/9.9.9' } }, (res) => {
      const cl = { req, res, closed: false };
      res.on('close', () => { cl.closed = true; });
      res.on('end', () => { cl.closed = true; });
      res.on('error', () => { cl.closed = true; });
      res.once('data', () => resolve(cl));
    });
    req.on('error', reject);
  });
  const keepsFlowing = (cl, ms = 1000) => new Promise((resolve) => {
    let n = 0;
    const onData = () => { n++; };
    cl.res.on('data', onData);
    setTimeout(() => { cl.res.off('data', onData); resolve(!cl.closed && n >= 2); }, ms);
  });
  const waitFor = async (fn, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };
  const logs = [];
  const origLog = console.log;
  let srv;
  const clients = [];
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    await setupAdmin(srv.port);
    const login1 = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    await new Promise((r) => setTimeout(r, 5));
    const login2 = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    const dev1 = login1.json.token;
    const dev2 = login2.json.token;
    assert.notStrictEqual(dev1, dev2);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: null }, dev1);
    const list = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, dev1);
    assert.strictEqual(list.status, 200);
    const play = async (token, i) => {
      const c = list.json.channels[i];
      const r = await httpJson(srv.port, 'GET', `/api/iptv/play/${c.idx}?cid=${encodeURIComponent(c.id)}`, null, token);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      return r.json.nativeUrl;
    };
    console.log = (...args) => { logs.push(args.join(' ')); origLog.apply(console, args); };

    const a = await openStream(srv.port, await play(dev1, 0));
    clients.push(a);
    const b = await openStream(srv.port, await play(dev2, 0));
    clients.push(b);
    const [aOk, bOk] = await Promise.all([keepsFlowing(a), keepsFlowing(b)]);
    assert.ok(aOk, 'device 1 keeps receiving bytes after device 2 tunes the same channel');
    assert.ok(bOk, 'device 2 receives bytes');
    assert.ok(!logs.some((l) => /closed previous stream/.test(l)), `no eviction between two devices: ${logs.join(' | ')}`);

    // Device 1 zaps: its own channel-0 stream closes (1-connection zap contract per device),
    // device 2's channel-0 stream keeps going.
    const a2 = await openStream(srv.port, await play(dev1, 1));
    clients.push(a2);
    assert.ok(await waitFor(() => a.closed), 'device 1\'s old stream closes on its own retune');
    assert.ok(await keepsFlowing(b), 'device 2 is not disturbed by device 1\'s zap');
    assert.ok(await keepsFlowing(a2), 'device 1 receives the new channel');
    assert.ok(logs.some((l) => /closed previous stream Dev 0|closed previous stream .*Dev 0/.test(l)),
      `the retune log names the closed channel: ${logs.join(' | ')}`);
    assert.ok(!logs.some((l) => l.includes(dev1) || l.includes(dev2)), 'no token in the log');
    assert.ok(await waitFor(() => activeStreams === 2), `channel 0 (device 2) + channel 1 (device 1); active=${activeStreams}`);
  } finally {
    console.log = origLog;
    for (const cl of clients) { try { cl.res.destroy(); } catch {} try { cl.req.destroy(); } catch {} }
    if (srv) await srv.shutdown();
    timers.forEach((t) => clearInterval(t));
    upstream.close();
  }
});

test('iptv: browser remux viewers SHARE the same upstream as native (tee into ffmpeg)', async () => {
  // Two browsers + one native on the same channel must cost ONE provider connection. The hub
  // fans TS to native HTTP subscribers and tees the same bytes into each remux ffmpeg stdin.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-remux-share-'));
  let activeStreams = 0;
  let totalConnections = 0;
  const timers = new Set();
  const playlist = ['#EXTM3U'];
  playlist.push('#EXTINF:-1 group-title="Test",Share Remux');
  playlist.push('http://127.0.0.1:PORT/live/0.ts');
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(upstream.address().port)));
    }
    if (req.url.startsWith('/live/')) {
      activeStreams++;
      totalConnections++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      const t = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(188, 0x47)); }, 25);
      timers.add(t);
      res.on('close', () => { clearInterval(t); timers.delete(t); activeStreams--; });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const transcode = require('../server/transcode');
  const originalDetect = transcode.detectFfmpeg;
  const originalSpawn = transcode.spawnLiveRemux;
  const originalStdin = transcode.spawnLiveRemuxStdin;
  transcode.detectFfmpeg = () => ({ path: 'ffmpeg' });
  transcode.spawnLiveRemux = () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => c.emit('close', 1); process.nextTick(() => c.emit('close', 1)); return c;
  };
  transcode.spawnLiveRemuxStdin = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', () => { if (!child.stdout.writableEnded) child.stdout.write(Buffer.from('fmp4')); });
    child.kill = () => { try { child.stdout.end(); } catch {} if (!child.closed) { child.closed = true; child.emit('close', 0); } };
    return child;
  };
  const openStream = (port, p, ua) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': ua } },
      (res) => { res.once('data', () => resolve({ req, res })); res.on('error', () => {}); });
    req.on('error', reject);
  });
  const waitFor = async (fn, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };
  const chunksOf = (res) => new Promise((resolve) => {
    let n = 0;
    const onData = () => { if (++n >= 2) { res.off('data', onData); resolve(n); } };
    res.on('data', onData);
  });
  const withSurface = (u, s) => u + (u.includes('?') ? '&' : '?') + 'surface=' + s;
  let srv;
  const clients = [];
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    const streamUrl = ch.json.channels[0].streamUrl;
    const nativeUrl = ch.json.channels[0].nativeUrl;

    const a = await openStream(srv.port, withSurface(streamUrl, 'web0'), 'Mozilla/5.0 Chrome/120');
    clients.push(a);
    assert.strictEqual(a.res.headers['content-type'], 'video/mp4', 'browser remux returns fMP4');
    const b = await openStream(srv.port, withSurface(streamUrl, 'web1'), 'Mozilla/5.0 Chrome/120');
    clients.push(b);
    await chunksOf(b.res);
    assert.strictEqual(totalConnections, 1, `two browsers must share one upstream (got ${totalConnections})`);
    assert.strictEqual(activeStreams, 1, 'exactly one provider connection is active for two remux viewers');

    const c = await openStream(srv.port, withSurface(nativeUrl, 'tv0'), 'TriboonTV-test');
    clients.push(c);
    await chunksOf(c.res);
    assert.ok(await waitFor(() => totalConnections === 1),
      `native must join the remux hub, not open a second upstream (got ${totalConnections})`);
    assert.match(String(c.res.headers['content-type'] || ''), /mp2t|octet-stream/,
      'native still receives TS off the shared hub');
  } finally {
    for (const cl of clients) { try { cl.res.destroy(); } catch {} try { cl.req.destroy(); } catch {} }
    if (srv) await srv.shutdown();
    transcode.detectFfmpeg = originalDetect;
    transcode.spawnLiveRemux = originalSpawn;
    transcode.spawnLiveRemuxStdin = originalStdin;
    timers.forEach((t) => clearInterval(t));
    upstream.close();
  }
});

// The automated version of the VERIFY.md "20 rapid zaps" live smoke: one viewer zapping down a
// playlist must honor the 1-connection zap contract the whole way — every retune closes the old
// upstream promptly (never more than one brief handoff overlap), no upstream leaks behind the
// storm, no reconnect churn, and the final channel still delivers live bytes.
test('iptv: a rapid zap storm holds the 1-connection contract and leaks no upstreams', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-zapstorm-'));
  const CHANNELS = 12;
  let activeStreams = 0;
  let peakActive = 0;
  let totalConnections = 0;
  const timers = new Set();
  const playlist = ['#EXTM3U'];
  for (let i = 0; i < CHANNELS; i++) {
    playlist.push(`#EXTINF:-1 group-title="Test",Zap ${i}`);
    playlist.push(`http://127.0.0.1:PORT/live/${i}.ts`);
  }
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(upstream.address().port)));
    }
    if (req.url.startsWith('/live/')) {
      activeStreams++;
      totalConnections++;
      peakActive = Math.max(peakActive, activeStreams);
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      const t = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(188, 0x47)); }, 25);
      timers.add(t);
      res.on('close', () => { clearInterval(t); timers.delete(t); activeStreams--; });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const openStream = (port, p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': 'TriboonTV-test' } },
      (res) => { res.once('data', () => resolve({ req, res })); res.on('error', () => {}); });
    req.on('error', reject);
  });
  const waitFor = async (fn, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };
  const withSurface = (u, s) => u + (u.includes('?') ? '&' : '?') + 'surface=' + s;
  let srv;
  let prev = null;
  let last = null;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.channels.length, CHANNELS);

    for (let i = 0; i < CHANNELS; i++) {
      // Same surface id = the SAME TV retuning — the server must treat each open as a retune.
      const next = await openStream(srv.port, withSurface(ch.json.channels[i].nativeUrl, 'zap0'));
      if (prev) { try { prev.res.destroy(); prev.req.destroy(); } catch {} } // ExoPlayer drops the old stream
      prev = next;
      await new Promise((r) => setTimeout(r, 25)); // a fast human zap cadence
    }
    last = prev;
    prev = null;
    assert.ok(await waitFor(() => activeStreams === 1),
      `after the storm only the final channel's upstream remains (active=${activeStreams})`);
    assert.ok(peakActive <= 2,
      `retunes closed the old upstream promptly — never more than one handoff overlap (peak=${peakActive})`);
    assert.strictEqual(totalConnections, CHANNELS,
      `each zap opened exactly one upstream — no leaks, no reconnect churn (${totalConnections} for ${CHANNELS} zaps)`);
    await new Promise((resolve) => {
      let n = 0;
      const onData = () => { if (++n >= 2) { last.res.off('data', onData); resolve(); } };
      last.res.on('data', onData);
    });
  } finally {
    for (const cl of [prev, last]) {
      if (cl) { try { cl.res.destroy(); } catch {} try { cl.req.destroy(); } catch {} }
    }
    if (srv) await srv.shutdown();
    timers.forEach((t) => clearInterval(t));
    upstream.close();
  }
});

test('iptv: dropping the old request before opening the next still releases the previous channel', async () => {
  // ExoPlayer zap: stop ESPN, THEN start CNN. The old leave is "client closed" (linger),
  // not an overlapping retune. One surface must still hold only one provider connection.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-dropfirst-'));
  let activeStreams = 0;
  let totalConnections = 0;
  const timers = new Set();
  const playlist = ['#EXTM3U'];
  for (let i = 0; i < 2; i++) {
    playlist.push(`#EXTINF:-1 group-title="Test",Drop ${i}`);
    playlist.push(`http://127.0.0.1:PORT/live/${i}.ts`);
  }
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(upstream.address().port)));
    }
    if (req.url.startsWith('/live/')) {
      activeStreams++;
      totalConnections++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      const t = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(188, 0x47)); }, 25);
      timers.add(t);
      res.on('close', () => { clearInterval(t); timers.delete(t); activeStreams--; });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const openStream = (port, p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': 'TriboonTV-test' } },
      (res) => { res.once('data', () => resolve({ req, res })); res.on('error', () => {}); });
    req.on('error', reject);
  });
  const waitFor = async (fn, ms = 2500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };
  const withSurface = (u, s) => u + (u.includes('?') ? '&' : '?') + 'surface=' + s;
  let srv;
  let first;
  let second;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    first = await openStream(srv.port, withSurface(ch.json.channels[0].nativeUrl, 'main'));
    assert.ok(await waitFor(() => activeStreams === 1), `first channel should be live; active=${activeStreams}`);
    try { first.res.destroy(); first.req.destroy(); } catch {}
    assert.ok(await waitFor(() => activeStreams === 1 || activeStreams === 0),
      'old client close may linger the hub, but must not open a second upstream');
    second = await openStream(srv.port, withSurface(ch.json.channels[1].nativeUrl, 'main'));
    assert.ok(await waitFor(() => activeStreams === 1),
      `opening a different channel must close the lingering hub immediately; active=${activeStreams}`);
    assert.strictEqual(totalConnections, 2, `one connection per channel, no leftover (${totalConnections})`);
  } finally {
    for (const cl of [first, second]) {
      if (cl) { try { cl.res.destroy(); } catch {} try { cl.req.destroy(); } catch {} }
    }
    if (srv) await srv.shutdown();
    timers.forEach((t) => clearInterval(t));
    upstream.close();
  }
});

test('iptv: same-channel reconnect within linger reuses the upstream', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-linger-rejoin-'));
  let activeStreams = 0;
  let totalConnections = 0;
  const timers = new Set();
  const playlist = ['#EXTM3U'];
  playlist.push('#EXTINF:-1 group-title="Test",Linger Rejoin');
  playlist.push('http://127.0.0.1:PORT/live/0.ts');
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(upstream.address().port)));
    }
    if (req.url.startsWith('/live/')) {
      activeStreams++;
      totalConnections++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      const t = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(188, 0x47)); }, 25);
      timers.add(t);
      res.on('close', () => { clearInterval(t); timers.delete(t); activeStreams--; });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const openStream = (port, p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': 'TriboonTV-test' } },
      (res) => { res.once('data', () => resolve({ req, res })); res.on('error', () => {}); });
    req.on('error', reject);
  });
  const waitFor = async (fn, ms = 2500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };
  const withSurface = (u, s) => u + (u.includes('?') ? '&' : '?') + 'surface=' + s;
  let srv;
  let first;
  let second;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    first = await openStream(srv.port, withSurface(ch.json.channels[0].nativeUrl, 'main'));
    assert.ok(await waitFor(() => activeStreams === 1));
    try { first.res.destroy(); first.req.destroy(); } catch {}
    await new Promise((r) => setTimeout(r, 80));
    second = await openStream(srv.port, withSurface(ch.json.channels[0].nativeUrl, 'main'));
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(totalConnections, 1, `zap-back must reuse the lingering hub (got ${totalConnections})`);
    assert.strictEqual(activeStreams, 1, 'exactly one provider connection after same-channel rejoin');
  } finally {
    for (const cl of [first, second]) {
      if (cl) { try { cl.res.destroy(); } catch {} try { cl.req.destroy(); } catch {} }
    }
    if (srv) await srv.shutdown();
    timers.forEach((t) => clearInterval(t));
    upstream.close();
  }
});

test('iptv: provider protection failures are dampened but recover after the configured window', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-bot-cache-'));
  let liveHits = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 group-title="Test",Protected News
http://127.0.0.1:${upstream.address().port}/live/protected.ts
`);
    }
    if (req.url === '/live/protected.ts') {
      liveHits++;
      if (liveHits === 1) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('provider bot-protection');
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      return setTimeout(() => res.end(Buffer.alloc(188, 0x47)), 20);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const readNative = (port, p) => new Promise((resolve, reject) => {
    let done = false;
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: p,
      headers: { 'user-agent': 'TriboonTV-test' },
    }, (res) => {
      const chunks = [];
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      };
      res.on('data', (c) => {
        chunks.push(c);
        if ((res.statusCode || 0) < 400) {
          try { res.destroy(); } catch {}
          try { req.destroy(); } catch {}
          finish();
        }
      });
      res.on('end', finish);
      res.on('error', () => finish());
    });
    req.on('error', (e) => { if (!done) reject(e); });
  });

  let srv;
  try {
    srv = await bootServer({
      TRIBOON_DATA: dataDir,
      NNTP_HOST: null,
      TMDB_BASE: null,
      TRIBOON_IPTV_PROVIDER_PROTECTION_TTL_MS: '1000',
    });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const first = await readNative(srv.port, ch.json.channels[0].nativeUrl);
    assert.strictEqual(first.status, 404);
    assert.match(first.body, /provider bot-protection/);
    const cached = await readNative(srv.port, ch.json.channels[0].nativeUrl);
    assert.strictEqual(cached.status, 404);
    assert.strictEqual(liveHits, 1, 'immediate repeat should be dampened by the short protection cache');
    await new Promise((resolve) => setTimeout(resolve, 1150));
    const recovered = await readNative(srv.port, ch.json.channels[0].nativeUrl);
    assert.strictEqual(recovered.status, 200);
    assert.strictEqual(liveHits, 2, 'provider-protection cache should expire quickly enough for a retune retry');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: native proxy retries an alternate player identity on provider bot-protection', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-bot-ua-retry-'));
  const liveUas = [];
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 group-title="Test",Protected News
http://127.0.0.1:${upstream.address().port}/live/protected.ts
`);
    }
    if (req.url === '/live/protected.ts') {
      const ua = req.headers['user-agent'] || '';
      liveUas.push(ua);
      if (!/VLC/i.test(ua)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('provider bot-protection');
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.alloc(188, 0x47));
      return setTimeout(() => res.end(Buffer.alloc(188, 0x47)), 20);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const readNative = (port, p) => new Promise((resolve, reject) => {
    let done = false;
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: p,
      headers: { 'user-agent': 'TriboonTV-test' },
    }, (res) => {
      const chunks = [];
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      };
      res.on('data', (c) => {
        chunks.push(c);
        if ((res.statusCode || 0) < 400) {
          try { res.destroy(); } catch {}
          try { req.destroy(); } catch {}
          finish();
        }
      });
      res.on('end', finish);
      res.on('error', () => finish());
    });
    req.on('error', (e) => { if (!done) reject(e); });
  });

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const played = await readNative(srv.port, ch.json.channels[0].nativeUrl);
    assert.strictEqual(played.status, 200);
    assert.strictEqual(liveUas.length, 2, 'bot-protection should retry the same URL with one alternate player identity');
    assert.match(liveUas[0], /TriboonTV/);
    assert.match(liveUas[1], /VLC/);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: Xtream channels serve persisted cache immediately after restart and refresh in background', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-channel-cache-'));
  let streamHits = 0;
  let streamName = 'Cached News';
  let streamDelay = 0;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    if (action === 'get_live_streams') {
      streamHits++;
      const body = JSON.stringify([{ stream_id: 901, name: streamName, category_id: '1', epg_channel_id: 'news.cache' }]);
      if (streamDelay) return setTimeout(() => res.end(body), streamDelay);
      return res.end(body);
    }
    res.end(JSON.stringify({ epg_listings: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let first;
  let second;
  try {
    first = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(first.port);
    await httpJson(first.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const warmed = await httpJson(first.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(warmed.json.channels[0].name, 'Cached News');
    assert.strictEqual(streamHits, 1, 'first load should fetch and persist the Xtream channel list');
    const persisted = first.store.read('iptvcache', null);
    const persistedJson = JSON.stringify(persisted);
    assert.ok(/:xt:/.test(persisted.key), 'persisted Xtream cache key keeps source type');
    assert.ok(!persistedJson.includes(host), 'persisted Xtream cache must not store provider host in plain text');
    assert.ok(!persistedJson.includes('xtuser'), 'persisted Xtream cache must not store username in plain text');
    assert.ok(!persistedJson.includes('xtpass'), 'persisted Xtream cache must not store password in plain text');
    first.store.flush();
    await first.shutdown();
    first = null;

    streamName = 'Fresh News';
    streamDelay = 1200;
    second = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const login = await httpJson(second.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    const started = Date.now();
    const cached = await httpJson(second.port, 'GET', '/api/iptv/channels', null, login.json.token);
    assert.strictEqual(cached.status, 200);
    assert.strictEqual(cached.json.channels[0].name, 'Cached News');
    assert.ok(Date.now() - started < 500, 'restart should serve persisted Xtream channels without waiting on the provider API');

    await new Promise((resolve) => setTimeout(resolve, streamDelay + 350));
    const fresh = await httpJson(second.port, 'GET', '/api/iptv/channels', null, login.json.token);
    assert.strictEqual(fresh.json.channels[0].name, 'Fresh News', 'background refresh should replace the stale disk channel list');
    assert.ok(streamHits >= 2, 'background refresh should still ask Xtream for the current channel list');
  } finally {
    if (first) await first.shutdown();
    if (second) await second.shutdown();
    upstream.close();
  }
});

test('iptv: Xtream stream list still loads when optional categories are rejected', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-category-403-'));
  let streamsHit = 0;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action === 'get_live_categories') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('provider rejected categories');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_live_streams') {
      streamsHit++;
      return res.end(JSON.stringify([{ stream_id: 902, name: 'Categoryless News', category_id: 'blocked', epg_channel_id: 'cat.news' }]));
    }
    res.end(JSON.stringify({ epg_listings: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.channels.length, 1);
    assert.strictEqual(ch.json.channels[0].name, 'Categoryless News');
    assert.strictEqual(ch.json.channels[0].group, 'Other', 'category 403 should fall back to a generic group');
    assert.strictEqual(ch.json.sourceErrors.length, 0, 'optional category failures should not mark the source failed');
    assert.strictEqual(streamsHit, 1, 'stream list should still be fetched');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: Xtream channel refresh retries alternate player identity on provider bot-protection', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-panel-ua-retry-'));
  const streamUas = [];
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action === 'get_live_categories') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    }
    if (action === 'get_live_streams') {
      streamUas.push(req.headers['user-agent'] || '');
      if (!/VLC/i.test(req.headers['user-agent'] || '')) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('provider bot-protection');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ stream_id: 777, name: 'Recovered News', category_id: '1' }]));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ epg_listings: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Retry Panel', iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.channels.length, 1);
    assert.strictEqual(ch.json.channels[0].name, 'Recovered News');
    assert.strictEqual(streamUas.length, 2, 'panel fetch should retry once with an alternate player identity');
    assert.match(streamUas[0], /TriboonTV/);
    assert.match(streamUas[1], /VLC/);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: Xtream channel list falls back to M3U when panel stream API is rejected', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-m3u-channel-fallback-'));
  let streamsHit = 0;
  let playlistHit = 0;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/player_api.php') {
      const action = u.searchParams.get('action');
      if (action === 'get_live_categories') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
      }
      if (action === 'get_live_streams') {
        streamsHit++;
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('provider rejected panel stream list');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    if (u.pathname === '/get.php') {
      playlistHit++;
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end([
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="fallback.news" tvg-name="Fallback News" group-title="News",Fallback News',
        `http://${req.headers.host}/live/xtuser/xtpass/991.ts`,
        '',
      ].join('\n'));
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end('ts');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const hostNoScheme = `127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const created = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Apollo', iptvMode: 'xtream', xtHost: hostNoScheme, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const sourceId = created.json.source.id;
    assert.strictEqual(created.json.source.xtHost, hostNoScheme, 'public settings should only expose the provider host');

    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.channels.length, 1);
    assert.strictEqual(ch.json.channels[0].name, 'Fallback News');
    assert.strictEqual(ch.json.channels[0].group, 'News');
    assert.strictEqual(String(ch.json.channels[0].xtreamId), '991');
    assert.strictEqual(ch.json.sourceErrors.length, 0, 'M3U fallback should make the source healthy');
    assert.strictEqual(streamsHit, 1, 'panel stream list should be tried once');
    assert.strictEqual(playlistHit, 1, 'M3U playlist should be used after the panel stream list rejection');

    const persisted = (srv.store.read('iptvcaches', {}) || {})[sourceId];
    const persistedJson = JSON.stringify(persisted);
    assert.ok(persisted && persisted.channels && persisted.channels.length === 1, 'fallback playlist should be persisted for restart');
    assert.ok(!persistedJson.includes(hostNoScheme), 'persisted fallback cache must not store provider host in plain text');
    assert.ok(!persistedJson.includes('xtuser'), 'persisted fallback cache must not store username in plain text');
    assert.ok(!persistedJson.includes('xtpass'), 'persisted fallback cache must not store password in plain text');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: sync status clears stale Xtream category errors after streams load', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-status-stale-category-'));
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action === 'get_live_categories') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('provider rejected categories');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_live_streams') {
      return res.end(JSON.stringify([{ stream_id: 911, name: 'Recovered News', category_id: 'blocked', epg_channel_id: 'recovered.news' }]));
    }
    res.end(JSON.stringify({ epg_listings: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const created = await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Apollo', iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const sourceId = created.json.source.id;
    srv.store.write('iptvsync', {
      sourceErrors: [{
        sourceId,
        sourceName: 'Apollo',
        mode: 'xtream',
        error: 'Xtream channel load action=get_live_categories host=example-xtream.invalid failed: HTTP 403 (provider rejected this channel)',
      }],
      lastResult: { channels: 0, sourceErrors: [] },
    });

    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.json.channels.length, 1);
    assert.strictEqual(ch.json.sourceErrors.length, 0);

    const status = await httpJson(srv.port, 'GET', '/api/iptv/status', null, admin);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.json.channelCount, 1);
    assert.strictEqual(status.json.loadedSourceCount, 1);
    assert.strictEqual(status.json.sourceErrors.length, 0, 'healthy channels should hide stale channel-load errors');
    assert.strictEqual(status.json.sources[0].error, null);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: Xtream browser remux opens the TS stream via the Node pipe (matches native) and follows provider redirects', async () => {
  // The browser remux now prefers the single-stream TS that Node opens (following the provider's 302
  // to its edge CDN, IPv4-pinned, browser UA) and pipes into a stdin-fed ffmpeg — the same robust
  // source the Android native player uses. This is what closed the web "live stream unavailable" gap;
  // the legacy ffmpeg-opens-the-URL remux remains the fallback (covered by the tests below).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-remux-tspipe-'));
  const tsHits = [];
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
      if (action === 'get_live_streams') return res.end(JSON.stringify([{ stream_id: 777, name: 'TS Pipe News', category_id: '1' }]));
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    if (u.pathname.includes('/live/') && u.pathname.endsWith('/777.ts')) { res.writeHead(302, { location: '/edge/777.ts' }); return res.end(); }
    if (u.pathname === '/edge/777.ts') { tsHits.push(u.pathname); res.writeHead(200, { 'content-type': 'video/mp2t' }); res.write('tsbytes'); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;
  const transcode = require('../server/transcode');
  const originalDetect = transcode.detectFfmpeg;
  const originalSpawn = transcode.spawnLiveRemux;
  const originalStdin = transcode.spawnLiveRemuxStdin;
  const urlCalls = [];
  let pipeFed = '';
  transcode.detectFfmpeg = () => ({ path: 'ffmpeg' });
  transcode.spawnLiveRemux = (url) => { // legacy URL path — should NOT be used when the pipe works
    urlCalls.push(url);
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => c.emit('close', 1); process.nextTick(() => c.emit('close', 1)); return c;
  };
  transcode.spawnLiveRemuxStdin = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', (d) => { pipeFed += d.toString(); });
    // Model real ffmpeg: emit the remuxed bytes, then exit only once the piped input ends (so the
    // test doesn't race the upstream→stdin pipe).
    child.stdin.on('finish', () => { if (!child.closed) { child.closed = true; child.emit('close', 0); } });
    child.kill = () => { if (!child.closed) { child.closed = true; child.emit('close', 0); } };
    process.nextTick(() => { child.stdout.write(Buffer.from('fmp4')); child.stdout.end(); });
    return child;
  };

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.match(ch.json.channels[0].nativeUrl, /\/native\//, 'native clients still receive the direct TS proxy URL');
    assert.match(ch.json.channels[0].nativeMime, /video\/mp2t/);
    const out = await httpRaw(srv.port, ch.json.channels[0].streamUrl);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.headers['content-type'], 'video/mp4');
    assert.strictEqual(out.body.toString('utf8'), 'fmp4', 'browser receives the stdin-remuxed fMP4');
    assert.ok(tsHits.length >= 1, 'the TS pipe followed the provider 302 to the edge TS URL');
    assert.strictEqual(pipeFed, 'tsbytes', 'Node piped the opened TS bytes into ffmpeg stdin');
    assert.strictEqual(urlCalls.length, 0, 'the robust TS pipe served the channel, so the legacy URL-opening remux was never used');
  } finally {
    if (srv) await srv.shutdown();
    transcode.detectFfmpeg = originalDetect;
    transcode.spawnLiveRemux = originalSpawn;
    transcode.spawnLiveRemuxStdin = originalStdin;
    upstream.close();
  }
});

test('iptv: browser remux retries the preferred HLS URL once before opening alternate IPTV URLs', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-remux-hls-retry-'));
  const upstreamHits = [];
  const upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url);
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
      if (action === 'get_live_streams') {
        return res.end(JSON.stringify([{ stream_id: 777, name: 'Redirect News', category_id: '1' }]));
      }
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    if (u.pathname === '/edge/777.ts') {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('edge stream');
    }
    if (u.pathname.endsWith('/777.ts')) {
      res.writeHead(302, { location: '/edge/777.ts' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end('edge stream');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;
  const transcode = require('../server/transcode');
  const originalDetect = transcode.detectFfmpeg;
  const originalSpawn = transcode.spawnLiveRemux;
  const calls = [];
  transcode.detectFfmpeg = () => ({ path: 'ffmpeg' });
  transcode.spawnLiveRemux = (url, opts = {}) => {
    calls.push({ url, hlsFriendly: !!opts.hlsFriendly, headers: opts.headers || null });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1);
    process.nextTick(() => {
      if (calls.length === 1) {
        child.stderr.write(Buffer.from('Error opening input: I/O error'));
        child.stderr.end();
        child.emit('close', 1);
        return;
      }
      child.stdout.write(Buffer.from('fmp4'));
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    // nopipe=1 exercises the legacy ffmpeg-opens-the-URL remux directly (the fallback path); the
    // Node TS-pipe is covered by the dedicated test above.
    const out = await httpRaw(srv.port, ch.json.channels[0].streamUrl + '&nopipe=1');
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.toString('utf8'), 'fmp4');
    assert.strictEqual(calls.length, 2, 'ffmpeg should retry the preferred HLS URL once before opening alternate IPTV URLs');
    assert.match(calls[0].url, /\/live\/xtuser\/xtpass\/777\.m3u8$/);
    assert.strictEqual(calls[0].hlsFriendly, true);
    assert.match(calls[1].url, /\/live\/xtuser\/xtpass\/777\.m3u8$/);
    // A transient I/O error must KEEP the HLS-friendly flags on the retry: dropping them on a real
    // HLS stream just trips ffmpeg's "not in allowed_segment_extensions" check and fails the channel.
    // The flags are only dropped when ffmpeg rejected the OPTIONS themselves (old build / non-HLS).
    assert.strictEqual(calls[1].hlsFriendly, true, 'a network-error retry keeps the HLS demuxer flags');
    assert.ok(!upstreamHits.some((url) => /\/live\/xtuser\/xtpass\/777\.ts$/.test(url)),
      'successful HLS retry should not consume a TS provider connection');
  } finally {
    if (srv) await srv.shutdown();
    transcode.detectFfmpeg = originalDetect;
    transcode.spawnLiveRemux = originalSpawn;
    upstream.close();
  }
});

test('iptv: remux drops to plain ONLY when ffmpeg rejects the HLS options themselves', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-remux-optreject-'));
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
      if (action === 'get_live_streams') return res.end(JSON.stringify([{ stream_id: 777, name: 'Opt News', category_id: '1' }]));
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end('edge stream');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;
  const transcode = require('../server/transcode');
  const originalDetect = transcode.detectFfmpeg;
  const originalSpawn = transcode.spawnLiveRemux;
  const calls = [];
  transcode.detectFfmpeg = () => ({ path: 'ffmpeg' });
  transcode.spawnLiveRemux = (url, opts = {}) => {
    calls.push({ url, hlsFriendly: !!opts.hlsFriendly });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1);
    process.nextTick(() => {
      if (calls.length === 1) {
        // ffmpeg too old / non-HLS input: it aborts on the HLS-private option itself.
        child.stderr.write(Buffer.from('Option extension_picky not found'));
        child.stderr.end();
        child.emit('close', 1);
        return;
      }
      child.stdout.write(Buffer.from('fmp4'));
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const out = await httpRaw(srv.port, ch.json.channels[0].streamUrl + '&nopipe=1'); // exercise the legacy URL remux path
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.toString('utf8'), 'fmp4');
    assert.strictEqual(calls.length, 2, 'an option-rejection should retry the same URL once');
    assert.strictEqual(calls[0].hlsFriendly, true);
    assert.strictEqual(calls[1].hlsFriendly, false, 'when ffmpeg rejects the HLS options, the retry drops them (old build / non-HLS)');
  } finally {
    if (srv) await srv.shutdown();
    transcode.detectFfmpeg = originalDetect;
    transcode.spawnLiveRemux = originalSpawn;
    upstream.close();
  }
});

test('iptv: redirected HLS remux keeps HLS-friendly ffmpeg flags', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-hls-remux-redirect-flags-'));
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/playlist.m3u') {
      const self = `http://127.0.0.1:${upstream.address().port}`;
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U\n#EXTINF:-1 group-title="News",Redirect HLS\n${self}/hls/start.m3u8\n`);
    }
    if (u.pathname === '/hls/start.m3u8') {
      res.writeHead(302, { location: '/edge/play' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;
  const transcode = require('../server/transcode');
  const originalDetect = transcode.detectFfmpeg;
  const originalSpawn = transcode.spawnLiveRemux;
  const calls = [];
  transcode.detectFfmpeg = () => ({ path: 'ffmpeg' });
  transcode.spawnLiveRemux = (url, opts = {}) => {
    calls.push({ url, hlsFriendly: !!opts.hlsFriendly });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (calls.length === 1) {
        child.stderr.write(Buffer.from('Error opening input: I/O error'));
        child.stderr.end();
        child.emit('close', 1);
        return;
      }
      child.stdout.write(Buffer.from('fmp4'));
      child.stdout.end();
      child.emit('close', 0);
    });
    child.kill = () => child.emit('close', 1);
    return child;
  };

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'm3u', iptvUrl: `${host}/playlist.m3u`, epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const out = await httpRaw(srv.port, ch.json.channels[0].streamUrl);
    assert.strictEqual(out.status, 200);
    assert.match(calls[0].url, /\/hls\/start\.m3u8$/);
    assert.strictEqual(calls[0].hlsFriendly, true);
    assert.match(calls[1].url, /\/edge\/play$/);
    assert.strictEqual(calls[1].hlsFriendly, true, 'redirected extensionless HLS URLs still need the HLS demuxer flags');
  } finally {
    if (srv) await srv.shutdown();
    transcode.detectFfmpeg = originalDetect;
    transcode.spawnLiveRemux = originalSpawn;
    upstream.close();
  }
});

test('iptv: live remux bad-channel probes stay bounded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /const LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS = 12000;/,
    'browser live-remux first-byte waits should fail fast enough for channel zapping');
  assert.match(src, /const IPTV_NATIVE_FIRST_BYTE_TIMEOUT_MS = 10000;/,
    'native IPTV proxy should also fail fast when a provider accepts but sends no media');
  assert.match(src, /const overallDeadline = Date\.now\(\) \+ LIVE_REMUX_TOTAL_STARTUP_BUDGET_MS;[\s\S]+const overallRemaining = \(\) => overallDeadline - Date\.now\(\);/,
    'browser remux startup is bounded by one overall cap so retries cannot chain indefinitely');
  assert.match(src, /if \(overallRemaining\(\) <= 0\) return finishLiveStartupTimeout\(target\);/,
    'the overall startup cap (not a per-attempt budget) is what ends startup with a 504');
  assert.match(src, /req\.setTimeout\(2500, \(\) => req\.destroy\(new Error\('live remux redirect probe timeout'\)\)\)/,
    'redirect detection should not stall a dead IPTV stream for many seconds');
  assert.match(src, /!target\.redirectProbeFailed[\s\S]+target\.redirectProbeFailed = true;/,
    'each remux target should run at most one redirect probe before falling through');
  assert.doesNotMatch(src, /refreshXtreamChannelForPlayback\(ch, `(?:cached )?remux HTTP/,
    'browser remux failures should not refresh huge Xtream playlists inside the player request');
  assert.match(src, /const stopForClientClose = \(\) => \{[\s\S]+ctx\.req\.socket[\s\S]+socket\.destroy\(\)[\s\S]+ff\.kill\('SIGKILL'\)[\s\S]+ctx\.res\.destroy\(\)[\s\S]+liveSlot\.done\('client closed'\)/,
    'aborted web-player remuxes should close the server response instead of leaving CloseWait sockets');
});

test('iptv: a live-stream retry/timeout never crashes the whole server', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  // The crash: retryPinnedAddress stripped the old request's 'error' listener and then destroyed it
  // WITH an error — Node emits that 'error' async with no listener → unhandled → the whole process
  // dies and every channel 502s. The aborted request must be destroyed WITHOUT forcing an error,
  // with a no-op 'error' handler to swallow the async abort error.
  assert.match(src, /old\.removeAllListeners\('error'\);[\s\S]*?old\.on\('error', \(\) => \{\}\);[\s\S]*?old\.destroy\(\);/,
    'retryPinnedAddress must swallow the aborted request error (no-op handler) and destroy() without an error');
  assert.doesNotMatch(src, /old\.removeAllListeners\('error'\);\s*old\.destroy\(new Error/,
    'the old crash pattern (remove error listener then destroy WITH an error) must not return');
  // Blast-radius net: a stray stream/socket error must not take down every user. Production-only
  // (inside require.main) so tests still surface real errors.
  assert.match(src, /if \(require\.main === module\) \{[\s\S]{0,2600}?process\.on\('uncaughtException',[\s\S]{0,200}?process\.on\('unhandledRejection',/,
    'the running server must install uncaughtException/unhandledRejection nets so one stream error cannot 502 everyone');
  // The net must not be able to hang itself: a dead log pipe (EPIPE on stderr) once looped
  // uncaughtException → console.error → EPIPE → uncaughtException at 100% CPU, starving every POST.
  assert.match(src, /for \(const stream of \[process\.stdout, process\.stderr\]\) \{\s*if \(stream && typeof stream\.on === 'function'\) stream\.on\('error', \(\) => \{\}\);/,
    'stdout/stderr write errors (EPIPE) are swallowed so a lost log pipe cannot become an uncaught exception');
  assert.match(src, /const guardLog = \(\(\) => \{[\s\S]+if \(inLog\) return;[\s\S]+if \(\+\+count > 20\) return;[\s\S]+try \{ console\.error\(tag, \(e && e\.stack\) \|\| e\); \} catch \{\} finally \{ inLog = false; \}/,
    'the crash-guard logger is re-entrancy safe and flood-limited');
  assert.match(src, /process\.on\('uncaughtException', \(e\) => guardLog\('\[uncaught\]', e\)\);\s*process\.on\('unhandledRejection', \(e\) => guardLog\('\[unhandledRejection\]', e\)\);/,
    'both nets log through the guarded logger, never a bare console.error');
});

test('server: a dead stderr pipe cannot spin the process (EPIPE loop regression)', async () => {
  // Boot the real entry point as a child with stderr piped, close our end of the pipe so the
  // child's writes fail with EPIPE, then provoke an uncaught exception path via a request that
  // logs. A healthy server keeps answering POSTs quickly; the old code spun at 100% CPU and every
  // POST body starved past the 10s body timer.
  const { spawn } = require('child_process');
  const http = require('http');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-epipe-'));
  const port = 17600 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), TRIBOON_DATA: dataDir, TRIBOON_SECRET: 'epipe-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const request = (method, p, body, token) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = data ? { 'content-type': 'application/json', 'content-length': data.length } : {};
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: res.statusCode, json, ms: Date.now() - t0 }); });
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
  try {
    const deadline = Date.now() + 25000;
    let up = false;
    while (Date.now() < deadline) {
      try { if ((await request('GET', '/api/server')).status === 200) { up = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(up, 'server boots');
    const setup = await request('POST', '/api/setup', { name: 'owner', password: 'hunter22' });
    assert.strictEqual(setup.status, 200);
    const token = setup.json.token;
    // Kill the log pipes from OUR side: the child's next console.* write gets EPIPE.
    child.stdout.destroy(); child.stderr.destroy();
    // A Play with no indexers configured fails and logs "[play] fail …" unconditionally — that
    // console.log now hits the dead pipe. The old code turned that into the uncaughtException →
    // console.error → EPIPE loop; the process spun and every later POST body starved.
    for (let i = 0; i < 4; i++) await request('POST', '/api/play', { q: `Nothing ${i} 2024` }, token).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    const r = await request('POST', '/api/login', { name: 'nobody', password: 'x' });
    assert.ok([401, 429].includes(r.status), `POST still answers after the log pipe died (got ${r.status})`);
    assert.ok(Date.now() - t0 < 3000, `POST answers promptly, not at the 10s body timer (${Date.now() - t0}ms)`);
    const again = await request('POST', '/api/play', { q: 'Nothing again 2024' }, token);
    assert.ok([502, 409].includes(again.status), `Play still gets a real answer with a dead logger (got ${again.status})`);
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      try { child.kill(); } catch { resolve(); }
      setTimeout(resolve, 3000).unref();
    });
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} // Windows may still hold the store file briefly
  }
});

test('iptv: stale Xtream stream ids refresh and retry native playback', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-stale-stream-id-'));
  let liveStreams = [{ stream_id: 100, name: '|US| NEWS PLUS HD', category_id: '1', epg_channel_id: 'news.plus' }];
  let oldHits = 0;
  let freshHits = 0;
  let streamListHits = 0;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
      if (action === 'get_live_streams') {
        streamListHits++;
        return res.end(JSON.stringify(liveStreams));
      }
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    if (u.pathname.endsWith('/100.ts')) {
      oldHits++;
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('old stream id');
    }
    if (u.pathname.endsWith('/200.ts')) {
      freshHits++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('FRESH-TS');
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const stale = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(stale.json.channels[0].name, '|US| NEWS PLUS HD');
    assert.strictEqual(streamListHits, 1);

    liveStreams = [{ stream_id: 200, name: 'USA: News Plus [1080p]', category_id: '1', epg_channel_id: 'news.plus' }];
    const native = await httpRaw(srv.port, stale.json.channels[0].nativeUrl);
    assert.strictEqual(native.status, 200, 'native playback should recover after refreshing stale Xtream ids');
    assert.strictEqual(native.body.toString('utf8'), 'FRESH-TS');
    assert.strictEqual(oldHits, 1, 'first attempt proves the persisted stream id was stale');
    assert.strictEqual(freshHits, 1, 'retry should use the refreshed stream id');
    assert.strictEqual(streamListHits, 2, 'provider list should be force-refreshed after the playback 403');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: cached stale Xtream 403 still refreshes and retries native playback', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-cached-stale-403-'));
  let liveStreams = [{ stream_id: 100, name: '|UK| CNN HD', category_id: '1', epg_channel_id: 'cnn.uk' }];
  let oldHits = 0;
  let freshHits = 0;
  let streamListHits = 0;
  const panelRequests = [];
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action) {
      panelRequests.push({
        action,
        bust: u.searchParams.has('_'),
        cacheControl: req.headers['cache-control'] || '',
        pragma: req.headers.pragma || '',
        ua: req.headers['user-agent'] || '',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
      if (action === 'get_live_streams') {
        streamListHits++;
        return res.end(JSON.stringify(liveStreams));
      }
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    if (u.pathname.endsWith('/100.ts')) {
      oldHits++;
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('old stream id');
    }
    if (u.pathname.endsWith('/200.ts')) {
      freshHits++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('FRESH-CNN');
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const stale = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(stale.json.channels[0].xtreamId, 100);

    const first = await httpRaw(srv.port, stale.json.channels[0].nativeUrl);
    assert.strictEqual(first.status, 403, 'first playback proves the cached stream id is stale');

    liveStreams = [{ stream_id: 200, name: 'USA: CNN [1080p]', category_id: '1', epg_channel_id: 'cnn.usa' }];
    const second = await httpRaw(srv.port, stale.json.channels[0].nativeUrl);
    assert.strictEqual(second.status, 200, 'cached 403 must still trigger a forced Xtream refresh');
    assert.strictEqual(second.body.toString('utf8'), 'FRESH-CNN');
    assert.strictEqual(oldHits, 1, 'cached failure path should not hit the old stream id again');
    assert.strictEqual(freshHits, 1, 'retry should use the refreshed stream id');
    assert.strictEqual(streamListHits, 3, 'initial list, failed-refresh list, and cached-failure refresh list should run');
    assert(panelRequests.every((p) => p.bust), 'Xtream panel requests should cache-bust provider/CDN responses');
    assert(panelRequests.every((p) => /no-cache/i.test(p.cacheControl)), 'Xtream panel requests should ask the provider not to serve cached lists');
    assert(panelRequests.every((p) => /TriboonTV/i.test(p.ua)), 'Xtream panel requests should use the IPTV smart-TV user agent');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: stale Xtream API can recover from the provider M3U playlist', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-m3u-stale-recovery-'));
  const apiStreams = [{ stream_id: 100, name: '|UK| CNN HD', category_id: '1', epg_channel_id: 'cnn.uk' }];
  let playlistStreams = [{ stream_id: 100, name: '|UK| CNN HD' }];
  let oldHits = 0;
  let freshHits = 0;
  let m3uHits = 0;
  let host = '';
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
      if (action === 'get_live_streams') return res.end(JSON.stringify(apiStreams));
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    if (u.pathname.endsWith('/get.php')) {
      m3uHits++;
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.write('#EXTM3U\n');
      for (const s of playlistStreams) {
        res.write(`#EXTINF:-1 tvg-id="cnn" group-title="News",${s.name}\n`);
        res.write(`${host}/live/xtuser/xtpass/${s.stream_id}.ts\n`);
      }
      return res.end();
    }
    if (u.pathname.endsWith('/100.ts')) {
      oldHits++;
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('old stream id');
    }
    if (u.pathname.endsWith('/200.ts')) {
      freshHits++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('FRESH-M3U-CNN');
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const stale = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(stale.json.channels[0].xtreamId, 100);

    playlistStreams = [{ stream_id: 200, name: 'USA: CNN [1080p]' }];
    const native = await httpRaw(srv.port, stale.json.channels[0].nativeUrl);
    assert.strictEqual(native.status, 200, 'native playback should recover through Xtream M3U when player_api stays stale');
    assert.strictEqual(native.body.toString('utf8'), 'FRESH-M3U-CNN');
    assert.strictEqual(oldHits, 1, 'the stale API id should fail once');
    assert.strictEqual(freshHits, 1, 'the M3U-discovered id should be retried');
    assert.strictEqual(m3uHits, 1, 'stale API refresh should fall back to one M3U playlist fetch');

    const refreshed = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(refreshed.json.channels[0].xtreamId, '200', 'M3U fallback should replace the persisted Xtream cache');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: empty Xtream guide misses are not persisted across restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-epg-cache-'));
  const b64 = (s) => Buffer.from(s).toString('base64');
  const nowS = Math.floor(Date.now() / 1000);
  let hasGuide = false;
  let epgHits = 0;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    if (action === 'get_live_streams') {
      return res.end(JSON.stringify([{ stream_id: 501, name: 'Guide News', category_id: '1' }]));
    }
    if (action === 'get_short_epg') {
      epgHits++;
      return res.end(JSON.stringify({ epg_listings: hasGuide ? [
        { title: b64('Recovered Guide'), start_timestamp: nowS - 60, stop_timestamp: nowS + 3600 },
      ] : [] }));
    }
    res.end('[]');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let first;
  let second;
  try {
    first = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(first.port);
    await httpJson(first.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(first.port, 'GET', '/api/iptv/channels', null, admin);
    const guide = await httpJson(first.port, 'GET', `/api/iptv/guide?chs=${ch.json.channels[0].idx}`, null, admin);
    assert.strictEqual(guide.json.channels[0].programmes[0].synthetic, true);
    assert.strictEqual(epgHits, 1);
    first.store.flush();
    await first.shutdown();
    first = null;

    hasGuide = true;
    second = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const login = await httpJson(second.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    const guide2 = await httpJson(second.port, 'GET', '/api/iptv/guide?chs=0', null, login.json.token);
    assert.strictEqual(guide2.json.channels[0].programmes[0].title, 'Recovered Guide');
    assert.strictEqual(epgHits, 2, 'restart should retry an empty Xtream guide miss instead of serving a persisted blank');
  } finally {
    if (first) await first.shutdown();
    if (second) await second.shutdown();
    upstream.close();
  }
});

test('iptv: Xtream guide falls back to simple data table when short EPG is empty', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-simple-guide-'));
  // A zone-less Xtream stamp parses as local time, so write local time, not UTC.
  const localStamp = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const t0 = localStamp(Date.now() - 10 * 60000);
  const t1 = localStamp(Date.now() + 50 * 60000);
  let shortHits = 0;
  let simpleHits = 0;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    if (action === 'get_live_streams') {
      return res.end(JSON.stringify([{ stream_id: 601, name: 'Simple Guide News', category_id: '1' }]));
    }
    if (action === 'get_short_epg') {
      shortHits++;
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    if (action === 'get_simple_data_table') {
      simpleHits++;
      return res.end(JSON.stringify({ epg_listings: [
        { title: 'Simple Data Bulletin', start: t0, end: t1 },
      ] }));
    }
    res.end('[]');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const guide = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${ch.json.channels[0].idx}`, null, admin);
    assert.strictEqual(guide.json.channels[0].programmes[0].title, 'Simple Data Bulletin');
    assert.strictEqual(guide.json.channels[0].programmes[0].synthetic, undefined);
    assert.strictEqual(shortHits, 1);
    assert.strictEqual(simpleHits, 1);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: Xtream guide provider rejection backs off per source instead of hammering channels', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-guide-backoff-'));
  let epgHits = 0;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    if (action === 'get_live_categories') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    }
    if (action === 'get_live_streams') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([
        { stream_id: 101, name: 'Backoff News 1', category_id: '1', epg_channel_id: 'backoff.1' },
        { stream_id: 102, name: 'Backoff News 2', category_id: '1', epg_channel_id: 'backoff.2' },
        { stream_id: 103, name: 'Backoff News 3', category_id: '1', epg_channel_id: 'backoff.3' },
      ]));
    }
    if (action === 'get_short_epg' || action === 'get_simple_data_table') {
      epgHits++;
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('[Bot-Protection]: guide requests rejected');
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/iptv/sources',
      { name: 'Backoff TV', iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass' }, admin);

    const first = await srv.warmIptvCaches('test-backoff', { force: true });
    assert.strictEqual(first.configured, true);
    assert.strictEqual(first.channels, 3);
    assert.ok(epgHits <= 2, `provider rejection should stop after the first channel fallback, saw ${epgHits} guide calls`);
    const hitsAfterFirstWarm = epgHits;

    const second = await srv.warmIptvCaches('test-backoff-again');
    assert.strictEqual(second.configured, true);
    assert.strictEqual(epgHits, hitsAfterFirstWarm, 'source-level backoff should skip guide calls on the next warm');
    assert.strictEqual(second.xtreamGuideBackoff, true);
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: stale Xtream guide refresh failures do not crash the process', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-stale-guide-refresh-'));
  const b64 = (s) => Buffer.from(s).toString('base64');
  const nowS = Math.floor(Date.now() / 1000);
  let failGuide = false;
  let epgHits = 0;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    res.setHeader('content-type', 'application/json');
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    if (action === 'get_live_streams') {
      return res.end(JSON.stringify([{ stream_id: 901, name: 'Stale Guide News', category_id: '1' }]));
    }
    if (action === 'get_short_epg') {
      epgHits++;
      if (failGuide) return req.socket.destroy();
      return res.end(JSON.stringify({ epg_listings: [
        { title: b64('Stale But Usable'), start_timestamp: nowS - 60, stop_timestamp: nowS + 3600 },
      ] }));
    }
    res.end('[]');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let first;
  let second;
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  const logs = [];
  const prevErr = console.error;
  try {
    first = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(first.port);
    await httpJson(first.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(first.port, 'GET', '/api/iptv/channels', null, admin);
    const guide = await httpJson(first.port, 'GET', `/api/iptv/guide?chs=${ch.json.channels[0].idx}`, null, admin);
    assert.strictEqual(guide.json.channels[0].programmes[0].title, 'Stale But Usable');
    // Source-scoped caches are canonical; the singular key is only the legacy compatibility mirror.
    // Age both copies so the restart genuinely hydrates stale data and exercises background refresh.
    const scopedCaches = first.store.read('xtreamepgcaches', {});
    const cached = scopedCaches && scopedCaches.default;
    assert.ok(cached && cached.streams && cached.streams.length, 'Xtream guide cache persisted');
    const staleAt = Date.now() - (2 * 24 * 3600000);
    cached.at = staleAt;
    cached.streams = cached.streams.map(([id, e]) => [id, { ...e, at: staleAt }]);
    first.store.write('xtreamepgcaches', { ...scopedCaches, default: cached });
    first.store.write('xtreamepgcache', cached);
    first.store.flush();
    await first.shutdown();
    first = null;

    failGuide = true;
    console.error = (...args) => logs.push(args.map(String).join(' '));
    process.on('unhandledRejection', onUnhandled);
    second = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const login = await httpJson(second.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    const stale = await httpJson(second.port, 'GET', '/api/iptv/guide?chs=0', null, login.json.token);
    assert.strictEqual(stale.json.channels[0].programmes[0].title, 'Stale But Usable');
    for (let waited = 0; waited < 3000 && !(epgHits >= 2 && logs.some((line) => /serving stale cache/.test(line))); waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepStrictEqual(unhandled, [], 'stale background refresh failure should be swallowed, not crash Node');
    assert.ok(epgHits >= 2, 'stale cache should still try to refresh in the background');
    const joined = logs.join('\n');
    assert.match(joined, /\[iptv xtream guide\].*#0 "Stale Guide News" stream=901.*serving stale cache.*action=get_short_epg.*failed/,
      'stale refresh failures should explain channel, stream id, cache fallback, and Xtream action');
    assert.doesNotMatch(joined, /xtuser|xtpass|player_api\.php\?/,
      'Xtream guide failure logs must not leak credentials or full provider API URLs');
  } finally {
    console.error = prevErr;
    process.off('unhandledRejection', onUnhandled);
    if (first) await first.shutdown();
    if (second) await second.shutdown();
    upstream.close();
  }
});

test('iptv: Xtream built-in XMLTV guide fills the timeline when per-channel EPG is empty', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-xmltv-guide-'));
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 10 * 60000);
  const t1 = new Date(Date.now() + 50 * 60000);
  let xmltvHits = 0;
  let shortHits = 0;
  const xmltv = `<?xml version="1.0"?><tv>
<channel id="bbc.world"><display-name>USA: BBC WORLD NEWS [1080p]</display-name></channel>
<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="bbc.world"><title>World News Live</title></programme>
</tv>`;
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/xmltv.php') {
      xmltvHits++;
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(xmltv);
    }
    const action = u.searchParams.get('action');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    if (action === 'get_live_streams') {
      return res.end(JSON.stringify([{ stream_id: 701, name: 'USA: BBC WORLD NEWS [1080p]', category_id: '1', epg_channel_id: 'bbc.world' }]));
    }
    if (action === 'get_short_epg') {
      shortHits++;
      return res.end(JSON.stringify({ epg_listings: [] }));
    }
    res.end('[]');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${upstream.address().port}`;

  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings',
      { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const guide = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${ch.json.channels[0].idx}`, null, admin);
    assert.strictEqual(guide.json.channels[0].programmes[0].title, 'World News Live');
    assert.strictEqual(guide.json.channels[0].programmes[0].synthetic, undefined);
    assert.strictEqual(xmltvHits, 1);
    assert.strictEqual(shortHits, 1, 'per-channel EPG is still attempted, but XMLTV fills the real guide');
    const epg = await httpJson(srv.port, 'GET', `/api/iptv/epg/${ch.json.channels[0].idx}`, null, admin);
    assert.strictEqual(epg.json.now.title, 'World News Live');
    assert.strictEqual(xmltvHits, 1, 'now/next reuses cached Xtream XMLTV');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: native HLS proxy rewrites relative playlist URIs against the upstream URL', async () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:5',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8",GROUP-ID="audio",LANGUAGE="fa",NAME="Persian",DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,AUDIO="audio"',
    'video.m3u8',
    '',
  ].join('\n');
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="iran",Iran International\nhttp://127.0.0.1:${upstream.address().port}/live/IRAN.m3u8\n`);
    }
    if (u.pathname === '/live/IRAN.m3u8') {
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': Buffer.byteLength(master),
      });
      return res.end(master);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    assert.ok(srv.rewriteIptvHlsPlaylist('#EXT-X-MEDIA:URI="audio.m3u8"\nvideo.m3u8\n', `${base}/live/IRAN.m3u8`).includes(`${base}/live/video.m3u8`));
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u` }, admin);
    await srv.warmIptvCaches('test');
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const iran = (ch.json.channels || []).find((c) => /Iran International/.test(c.name));
    assert.ok(iran && iran.nativeUrl, 'Iran International native URL is present');
    const out = await httpRaw(srv.port, iran.nativeUrl);
    assert.strictEqual(out.status, 200, out.body.toString('utf8').slice(0, 200));
    const body = out.body.toString('utf8');
    assert.match(body, /#EXTM3U/);
    assert.ok(body.includes(`${base}/live/video.m3u8`), body);
    assert.ok(body.includes(`${base}/live/audio.m3u8`), body);
    assert.doesNotMatch(body, /^video\.m3u8$/m);
  } finally {
    await srv.shutdown();
    upstream.close();
  }
});

test('iptv: only media types pass from an upstream', () => {
  const { safeMediaType } = require('../server/media-type');
  for (const ok of ['video/mp2t', 'video/mp4', 'audio/aac', 'application/vnd.apple.mpegurl', 'application/x-mpegURL', 'audio/mpegurl; charset=utf-8', 'application/octet-stream']) {
    assert.strictEqual(safeMediaType(ok), ok);
  }
  for (const bad of ['text/html', 'TEXT/HTML; charset=utf-8', 'text/html; x=mpegurl', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/javascript', 'video/mp4/../html', 'video/<script>', '']) {
    assert.strictEqual(safeMediaType(bad), 'application/octet-stream', bad);
  }
});

test('iptv: an upstream that answers HTML cannot become a page on the Triboon origin', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-html-'));
  const page = '<script>document.title="RAN"</script>';
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 tvg-id="a",Plain HTML
http://${req.headers.host}/page
#EXTINF:-1 tvg-id="b",Disguised HTML
http://${req.headers.host}/disguised
#EXTINF:-1 tvg-id="c",Real TS
http://${req.headers.host}/real.ts
`);
    }
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
    if (req.url === '/disguised') { res.writeHead(200, { 'content-type': 'text/html; x=mpegurl' }); return res.end(page); }
    if (req.url === '/real.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end('ts-bytes'); }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    const made = await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
      { name: 'Hostile', iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u` }, admin);
    assert.strictEqual(made.status, 200);
    const list = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    const byName = Object.fromEntries(list.json.channels.map((c) => [c.name, c]));
    for (const name of ['Plain HTML', 'Disguised HTML']) {
      const r = await httpRaw(srv.port, byName[name].nativeUrl);
      assert.strictEqual(r.headers['content-type'], 'application/octet-stream', name + ' is not served as a page');
      assert.match(String(r.headers['content-security-policy']), /^sandbox/, name + ' is sandboxed');
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    }
    const real = await httpRaw(srv.port, byName['Real TS'].nativeUrl);
    assert.strictEqual(real.status, 200);
    assert.strictEqual(real.headers['content-type'], 'video/mp2t', 'a real stream keeps its type');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: the DNS pin survives a full cache, and no pin means no request', async () => {
  const net = require('net');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const from = src.indexOf('async function validateAndPinIptvUrl');
  const to = src.indexOf('async function assertIptvUrlAllowed');
  assert.ok(from > 0 && to > from);
  const iptvUrlSafetyCache = new Map();
  const pickCachedIptvAddress = (host) => { const hit = iptvUrlSafetyCache.get(host); return hit ? hit.addrs[0] : null; };
  const validate = new Function('net', 'iptvUrlSafetyCache', 'pickCachedIptvAddress', 'resolveIptvHost', 'allowPrivateIptvTargets', 'cleanUrlHostForPolicy',
    'isPrivateIptvHost', 'iptvPolicyError', 'pinnedIptvHref', 'iptvHostHeader', 'pinnedIptvLookup', 'markIptvPinnedAddressFailure', 'IPTV_PRIVATE_URL_CACHE_MS',
    `${src.slice(from, to)}\nreturn validateAndPinIptvUrl;`)(net, iptvUrlSafetyCache, pickCachedIptvAddress,
    async () => [{ address: '93.184.216.34', family: 4 }], () => false, (h) => h, () => false, (label, why) => new Error(why),
    () => 'pinned', () => '', () => () => {}, () => {}, 60000);
  for (let i = 0; i < 1500; i++) {
    const pin = await validate(`http://h${i}.example/live.ts`);
    assert.strictEqual(pin.address, '93.184.216.34', `host ${i} kept its pin`);
    assert.strictEqual(typeof pin.lookup, 'function');
  }
  assert.ok(iptvUrlSafetyCache.size <= 1000);
  assert.ok(iptvUrlSafetyCache.has('h1499.example'), 'the newest entry stays');
  assert.ok(!iptvUrlSafetyCache.has('h0.example'), 'the oldest goes first');
});

test('iptv: ffmpeg opens only web addresses from a playlist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'transcode.js'), 'utf8');
  assert.match(src, /'-protocol_whitelist', 'http,https,tcp,tls,crypto',/);
  assert.doesNotMatch(src, /protocol_whitelist', '[^']*(file|udp|rtp|httpproxy)/);
});

test('iptv: a non-admin gets opaque playlist items, the admin path is unchanged, and hidden groups stay hidden', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-media-'));
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    const base = '/live/FIXUSER/FIXPASS';
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 tvg-id="a" group-title="News",Shared HLS
http://${req.headers.host}${base}/chan.m3u8
#EXTINF:-1 tvg-id="b" group-title="Adult",Hidden HLS
http://${req.headers.host}${base}/hidden.m3u8
`);
    }
    if (req.url.endsWith('/chan.m3u8') || req.url.endsWith('/hidden.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nseg_0.ts\n#EXTINF:2,\nmoved.ts\n');
    }
    if (req.url.endsWith('/moved.ts')) { res.writeHead(302, { location: `${base}/seg_0.ts` }); return res.end(); }
    if (req.url.endsWith('/key.bin')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('0123456789abcdef'); }
    if (req.url.endsWith('/seg_0.ts')) { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end('segment-bytes'); }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u` }, admin);
    const join = async (name) => {
      const invite = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
      return (await httpJson(srv.port, 'POST', '/api/invite/accept', { token: invite.json.token, name, password: 'pass1234' })).json.token;
    };
    const alice = await join('alice');
    const bob = await join('bob');
    await httpJson(srv.port, 'GET', '/api/iptv/channels', null, alice);
    const adminList = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.channels;
    const shared = adminList.find((c) => c.name === 'Shared HLS');
    const hidden = adminList.find((c) => c.name === 'Hidden HLS');
    const playAs = async (token, c) => (await httpJson(srv.port, 'GET', `/api/iptv/play/${c.idx}?cid=${encodeURIComponent(c.id)}`, null, token)).json;

    const adminPlay = await playAs(admin, shared);
    const adminBody = (await httpRaw(srv.port, adminPlay.nativeUrl)).body.toString();
    assert.match(adminBody, /FIXPASS\/seg_0\.ts/, 'an admin keeps the provider addresses');

    const hiddenPlay = await playAs(alice, hidden);
    const alicePlay = await playAs(alice, shared);
    const body = (await httpRaw(srv.port, alicePlay.nativeUrl)).body.toString();
    assert.doesNotMatch(body, /FIXUSER|FIXPASS|127\.0\.0\.1/, 'no provider address reaches a user');
    const items = body.split('\n').filter((l) => l.startsWith('/api/iptv/media/'));
    assert.strictEqual(items.length, 2);
    assert.match(items[0], /\.ts\?cid=.*&t=/);
    const keyUri = /URI="([^"]+)"/.exec(body)[1];
    assert.match(keyUri, /^\/api\/iptv\/media\//, 'the key goes through the server too');

    const seg = await httpRaw(srv.port, items[0]);
    assert.strictEqual(seg.status, 200);
    assert.strictEqual(seg.headers['content-type'], 'video/mp2t');
    assert.strictEqual(seg.body.toString(), 'segment-bytes');
    assert.strictEqual((await httpRaw(srv.port, items[1])).body.toString(), 'segment-bytes', 'a redirect is followed on the server');
    const key = await httpRaw(srv.port, keyUri);
    assert.strictEqual(key.headers['content-type'], 'application/octet-stream', 'an item cannot be served as a page');
    assert.match(String(key.headers['content-security-policy']), /^sandbox/);

    assert.strictEqual((await httpRaw(srv.port, items[0].replace(/[?].*$/, ''))).status, 401, 'no token, no item');
    const bobPlay = await playAs(bob, shared);
    const bobToken = new URL(bobPlay.nativeUrl, 'http://x').searchParams.get('t');
    assert.strictEqual((await httpRaw(srv.port, items[0].replace(/([?&]t=)[^&]+/, `$1${bobToken}`))).status, 404, 'an item belongs to the viewer it was made for');

    await httpJson(srv.port, 'POST', '/api/settings', { iptvHiddenGroups: ['Adult'] }, admin);
    assert.strictEqual((await httpRaw(srv.port, hiddenPlay.nativeUrl)).status, 404, 'native refuses a hidden group');
    assert.strictEqual((await httpRaw(srv.port, hiddenPlay.streamUrl)).status, 404, 'remux refuses a hidden group');
    assert.strictEqual((await httpRaw(srv.port, adminPlay.nativeUrl)).status, 200, 'a shared group still plays');
    await httpJson(srv.port, 'POST', '/api/settings', { iptvHiddenGroups: ['News'] }, admin);
    assert.strictEqual((await httpRaw(srv.port, items[0])).status, 404, 'an item from a group hidden later stops too');

    await httpJson(srv.port, 'POST', '/api/settings', { iptvHiddenGroups: [] }, admin);
    const own = await httpJson(srv.port, 'POST', '/api/me/iptv/sources', { name: 'Mine', iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u` }, alice);
    assert.strictEqual(own.status, 200);
    const mine = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, alice)).json.channels.find((c) => c.name === 'Shared HLS' && c.sourceId === own.json.source.id);
    assert.ok(mine, 'the viewer has their own copy of the channel');
    const minePlay = await playAs(alice, mine);
    assert.match((await httpRaw(srv.port, minePlay.nativeUrl)).body.toString(), /FIXPASS\/seg_0\.ts/, 'their own playlist goes straight to its provider');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: viewers who share one starting HLS answer each get their own rewrite (admin and user, both orders)', async () => {
  // Audit S1-1 (B02-01): a second viewer queued on a starting hub used to get the OPENER's
  // rewritten playlist. Admin first: the user got raw provider addresses (login in the path).
  // User first: the admin got relay links bound to the user, which 404 for the admin.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-share-'));
  let playlistHits = 0;
  const upstream = http.createServer((req, res) => {
    const base = '/live/FIXUSER/FIXPASS';
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U
#EXTINF:-1 tvg-id="a" group-title="News",Slow HLS
http://${req.headers.host}${base}/chan.m3u8
`);
    }
    if (req.url.endsWith('/chan.m3u8')) {
      playlistHits++;
      // Slow answer: the second viewer arrives while the first one's hub is still starting.
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg_0.ts\n#EXTINF:2,\nseg_1.ts\n');
      }, 300);
    }
    if (/\/seg_\d\.ts$/.test(req.url)) { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end('segment-bytes'); }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u` }, admin);
    const invite = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
    const alice = (await httpJson(srv.port, 'POST', '/api/invite/accept', { token: invite.json.token, name: 'alice', password: 'pass1234' })).json.token;
    await httpJson(srv.port, 'GET', '/api/iptv/channels', null, alice);
    const chan = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.channels.find((c) => c.name === 'Slow HLS');
    assert.ok(chan, 'the channel is listed');
    const playAs = async (token) => (await httpJson(srv.port, 'GET', `/api/iptv/play/${chan.idx}?cid=${encodeURIComponent(chan.id)}`, null, token)).json;
    const adminPlay = await playAs(admin);
    const alicePlay = await playAs(alice);
    const checkUser = (body, why) => {
      assert.doesNotMatch(body, /FIXUSER|FIXPASS|127\.0\.0\.1/, `${why}: no provider address reaches the user`);
      const items = body.split('\n').filter((l) => l && !l.startsWith('#'));
      assert.strictEqual(items.length, 2, `${why}: both segments listed`);
      for (const l of items) assert.match(l, /^\/api\/iptv\/media\//, `${why}: every item goes through the relay`);
    };
    const checkAdmin = (body, why) => {
      assert.match(body, /FIXPASS\/seg_0\.ts/, `${why}: the admin keeps the provider addresses`);
      assert.doesNotMatch(body, /\/api\/iptv\/media\//, `${why}: the admin gets no relay links bound to someone else`);
    };
    const overlap = async (firstUrl, secondUrl) => {
      const before = playlistHits;
      const first = httpRaw(srv.port, firstUrl);
      await new Promise((r) => setTimeout(r, 50));
      const second = httpRaw(srv.port, secondUrl);
      const [a, b] = await Promise.all([first, second]);
      assert.strictEqual(a.status, 200);
      assert.strictEqual(b.status, 200);
      return { first: a.body.toString(), second: b.body.toString(), upstreamHits: playlistHits - before };
    };

    // Admin opens, the user queues on the starting hub.
    let r = await overlap(adminPlay.nativeUrl, alicePlay.nativeUrl);
    assert.strictEqual(r.upstreamHits, 1, 'the two overlapping polls still share one provider request');
    checkAdmin(r.first, 'admin first');
    checkUser(r.second, 'admin first');

    // The user opens, the admin queues.
    r = await overlap(alicePlay.nativeUrl, adminPlay.nativeUrl);
    assert.strictEqual(r.upstreamHits, 1, 'the two overlapping polls still share one provider request');
    checkUser(r.first, 'user first');
    checkAdmin(r.second, 'user first');

    // The user's relay links play for the user.
    const item = r.first.split('\n').find((l) => l.startsWith('/api/iptv/media/'));
    const seg = await httpRaw(srv.port, item);
    assert.strictEqual(seg.status, 200);
    assert.strictEqual(seg.body.toString(), 'segment-bytes');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('iptv: a finished playlist hub never removes the newer starting hub that took its share key', async () => {
  // Audit S1-8: hub A (finite, already out of the share map) used to delete the map entry by key
  // when it closed, even though that entry was now hub B, still starting for another viewer. A
  // third viewer then opened a THIRD provider request instead of joining B.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-sharekey-'));
  let hits = 0;
  const body = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg_0.ts\n';
  const upstream = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="k" group-title="News",Key HLS\nhttp://${req.headers.host}/live/chan.m3u8\n`);
    }
    if (req.url.endsWith('/chan.m3u8')) {
      const n = ++hits;
      if (n === 1) {
        // Hub A: headers at once (A goes finite and leaves the map), body ends ~300 ms later.
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.write(body.slice(0, 8));
        return setTimeout(() => res.end(body.slice(8)), 300);
      }
      // Hub B (and any later one): no headers for ~450 ms, so B is still starting when A closes.
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(body);
      }, 450);
    }
    if (req.url.endsWith('/seg_0.ts')) { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end('x'); }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u` }, admin);
    // Three different accounts, so no Live TV slot is evicted between the requests.
    const join = async (name) => {
      const invite = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
      return (await httpJson(srv.port, 'POST', '/api/invite/accept', { token: invite.json.token, name, password: 'pass1234' })).json.token;
    };
    const alice = await join('alice');
    const bob = await join('bob');
    const chan = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.channels.find((c) => c.name === 'Key HLS');
    assert.ok(chan);
    const playAs = async (token) => (await httpJson(srv.port, 'GET', `/api/iptv/play/${chan.idx}?cid=${encodeURIComponent(chan.id)}`, null, token)).json;
    const urls = [await playAs(admin), await playAs(alice), await playAs(bob)].map((p) => p.nativeUrl);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const a = httpRaw(srv.port, urls[0]);           // opens hub A
    await wait(150);
    const b = httpRaw(srv.port, urls[1]);           // A is finite and out of the map: opens hub B
    await wait(250);                                 // A has ended and closed by now; B still starting
    const c = httpRaw(srv.port, urls[2]);           // must join B, not open a third request
    const res = await Promise.all([a, b, c]);
    for (const r of res) {
      assert.strictEqual(r.status, 200);
      assert.match(r.body.toString(), /#EXTM3U/);
    }
    assert.strictEqual(hits, 2, 'the third viewer joined the starting hub B (2 provider requests, not 3)');
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('setup: a held request cannot make a second admin, and an unreadable users file is not a fresh install', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-setup-'));
  let srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
  try {
    const held = await new Promise((resolve, reject) => {
      const req = http.request({ port: srv.port, host: '127.0.0.1', method: 'POST', path: '/api/setup', headers: { 'content-type': 'application/json', 'content-length': 44 } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.write('{"name":"latecomer",');
      setTimeout(async () => {
        try {
          await setupAdmin(srv.port);
          req.end(`"password":"pass1234"}`.padEnd(24, ' '));
        } catch (e) { reject(e); }
      }, 50);
    });
    assert.strictEqual(held, 403);
    const real = fs.existsSync(path.join(dataDir, 'users.json')) ? null : 'missing';
    assert.strictEqual(real, null);
    await srv.shutdown();
    srv = null;
    const good = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
    assert.strictEqual(JSON.parse(good).list.length, 1, 'only the owner exists');
    fs.writeFileSync(path.join(dataDir, 'users.json'), good.slice(0, 40));
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    assert.strictEqual((await httpJson(srv.port, 'GET', '/api/server')).json.needsSetup, false, 'not offered as a fresh install');
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/setup', { name: 'intruder', password: 'pass1234' })).status, 503);
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/invite/accept', { token: 'x', name: 'a', password: 'pass1234' })).status, 503);
    fs.writeFileSync(path.join(dataDir, 'users.json'), good);
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' })).status, 200, 'the next good read recovers with no restart');
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/setup', { name: 'intruder', password: 'pass1234' })).status, 403);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8')).list.length, 1);
  } finally {
    if (srv) await srv.shutdown();
  }
});

test('accounts: first-run setup refuses a name over the sign-in cap with 400; a 128-character name works', async () => {
  // Follow-up to B03-01: account creation uses the sign-in cap, so no account can be made that
  // can never sign in. Before this, setup made the account and a sign-in with its name got 400.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-setup-name-'));
  let srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
  try {
    const long = await httpJson(srv.port, 'POST', '/api/setup', { name: 'o'.repeat(129), password: 'hunter22' });
    assert.strictEqual(long.status, 400, 'a 129-character name is refused, not a 500');
    assert.match(long.json.error, /at most 128 characters/);
    assert.strictEqual((await httpJson(srv.port, 'GET', '/api/server')).json.needsSetup, true, 'no account was made');
    const edge = 'e'.repeat(128);
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/setup', { name: edge, password: 'hunter22' })).status, 200,
      'a 128-character name can still be created');
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/login', { name: edge, password: 'hunter22' })).status, 200,
      'and it can sign in');
    assert.strictEqual(require('../server/auth').SIGN_IN_NAME_MAX, 128, 'creation and sign-in share one cap');
  } finally {
    if (srv) await srv.shutdown();
  }
});

test('profiles: leaving out or naming a profile cannot beat a PIN, and an account with no PIN is unchanged', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-profile-'));
  const srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    const play = async (body, headers) => {
      const r = await new Promise((resolve) => {
        const data = JSON.stringify({ q: 'Some Title 2024', ...body });
        const req = http.request({ port: srv.port, host: '127.0.0.1', method: 'POST', path: '/api/play', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.end(data);
      });
      return r;
    };
    const restricted = (status) => status === 403;
    const me = (await httpJson(srv.port, 'GET', '/api/me', null, admin)).json;
    const main = me.profiles[0];
    assert.ok(!restricted(await play({})), 'no id, no PIN: past the gate as before');
    const kid = (await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'Kid', level: 0 }, admin)).json;
    assert.ok(!restricted(await play({})), 'an open adult profile is one click away, so no id still passes');
    assert.ok(restricted(await play({ profileId: kid.id })), 'the kid profile is held');

    const pinned = (await httpJson(srv.port, 'POST', `/api/me/profiles/${main.id}/pin`, { password: 'hunter22', pin: '1234' }, admin)).json;
    assert.ok(pinned.proof, 'setting a PIN gives this device its proof');
    assert.ok(restricted(await play({})), 'once the adult profile has a PIN, leaving the id out is held');
    assert.ok(restricted(await play({ profileId: main.id })), 'naming the PIN profile without proof is held');
    assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${main.id}/verify`, { pin: '9999' }, admin)).json.proof, undefined);
    const proof = (await httpJson(srv.port, 'POST', `/api/me/profiles/${main.id}/verify`, { pin: '1234' }, admin)).json.proof;
    assert.ok(!restricted(await play({ profileId: main.id }, { 'x-triboon-profile': proof })), 'the proof opens that profile');
    assert.ok(restricted(await play({ profileId: main.id }, { 'x-triboon-profile': `${proof}x` })), 'a changed proof does not');
    assert.ok(restricted(await play({ profileId: kid.id }, { 'x-triboon-profile': proof })), 'a proof never lifts another profile');
    await httpJson(srv.port, 'POST', `/api/me/profiles/${main.id}/pin`, { password: 'hunter22', pin: '5678' }, admin);
    assert.ok(restricted(await play({ profileId: main.id }, { 'x-triboon-profile': proof })), 'a new PIN ends the old proof');
    assert.strictEqual((await httpJson(srv.port, 'GET', `/api/me`, null, proof)).status, 401, 'a proof is not a session');
  } finally {
    await srv.shutdown();
  }
});

test('settings: the admin can hide the side-copy notice; never while settings do not open, never as a user; it survives a restart', async () => {
  // Follow-up to B01-02 (review L1): the notice used to stay until someone deleted the .keep file
  // from the data folder, which on Docker or Unraid needs shell or share access.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-notice-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{ damaged settings');
  let srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
  const keeps = () => fs.readdirSync(dataDir).filter((n) => /^settings\.json\.unreadable-.*\.keep$/.test(n)).sort();
  try {
    const admin = await setupAdmin(srv.port);
    let s = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json;
    assert.strictEqual(s.settingsUnreadable, true, 'damaged settings are flagged');
    assert.strictEqual(s.settingsSideCopyDismissed, false);
    const early = await httpJson(srv.port, 'POST', '/api/settings/side-copy/dismiss', { name: 'x' }, admin);
    assert.strictEqual(early.status, 409, 'cannot be hidden while settings do not open');
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/settings', { libAutoScanMin: 30 }, admin)).status, 200);
    const [copy] = keeps();
    assert.ok(copy, 'the first save kept a side copy');
    const bytes = fs.readFileSync(path.join(dataDir, copy));
    s = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json;
    assert.strictEqual(s.settingsUnreadable, false);
    assert.strictEqual(s.settingsSideCopy, copy);
    assert.strictEqual(s.settingsSideCopyDismissed, false, 'the notice shows');
    const invite = await httpJson(srv.port, 'POST', '/api/invites', {}, admin);
    const user = (await httpJson(srv.port, 'POST', '/api/invite/accept', { token: invite.json.token, name: 'viewer', password: 'pass1234' })).json.token;
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/settings/side-copy/dismiss', { name: copy }, user)).status, 403, 'a user is refused');
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/settings/side-copy/dismiss', { name: 'settings.json.unreadable-old.keep' }, admin)).status, 409,
      'a name that is not the newest copy is refused');
    const ok = await httpJson(srv.port, 'POST', '/api/settings/side-copy/dismiss', { name: copy }, admin);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.settingsSideCopyDismissed, true, 'hidden');
    assert.deepStrictEqual(keeps(), [copy], 'the kept file is not deleted');
    assert.ok(bytes.equals(fs.readFileSync(path.join(dataDir, copy))), 'the kept file is byte-identical');
    await srv.shutdown();
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin2 = (await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' })).json.token;
    s = (await httpJson(srv.port, 'GET', '/api/settings', null, admin2)).json;
    assert.strictEqual(s.settingsSideCopy, copy);
    assert.strictEqual(s.settingsSideCopyDismissed, true, 'still hidden after a restart');
  } finally {
    if (srv) await srv.shutdown();
  }
});

test('login: one address is stopped after its failure budget, a good login does not reset it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-loginip-'));
  const srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null, TRIBOON_LOGIN_IP_MAX: 20 });
  try {
    await setupAdmin(srv.port);
    let stopped = 0;
    for (let i = 0; i < 21 && !stopped; i++) {
      if (i === 10) assert.strictEqual((await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' })).status, 200);
      const r = await httpJson(srv.port, 'POST', '/api/login', { name: `junk${i}`, password: 'x' });
      if (r.status === 429) stopped = i;
    }
    const after = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    assert.strictEqual(after.status, 429, 'the budget ran out across names');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'jellyfin-api.js'), 'utf8');
    assert.match(src, /if \(deps\.loginIpLocked\(ctx\)\) return;/, 'the Jellyfin login shares the budget');
    assert.match(src, /deps\.noteLoginFailure\(ctx\); return send\(ctx\.res, 401/);
  } finally {
    await srv.shutdown();
    delete process.env.TRIBOON_LOGIN_IP_MAX;
  }
});

test('iptv: a real ffmpeg plays a non-admin HLS channel through the server, and a file: segment gives nothing', async (t) => {
  const { detectFfmpeg } = require('../server/transcode');
  const ff = detectFfmpeg();
  if (!ff) return t.skip('ffmpeg not installed');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-ff-'));
  const seg = path.join(dataDir, 'seg.ts');
  require('child_process').execFileSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', seg]);
  const bytes = fs.readFileSync(seg);
  const asked = [];
  const upstream = http.createServer((req, res) => {
    asked.push(req.url);
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="a",Good\nhttp://${req.headers.host}/live/U/P/good.m3u8\n#EXTINF:-1 tvg-id="b",Bad\nhttp://${req.headers.host}/live/U/P/bad.m3u8\n`);
    }
    if (req.url.endsWith('/good.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n');
    }
    if (req.url.endsWith('/bad.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nfile:${seg.replace(/\\/g, '/')}\n#EXT-X-ENDLIST\n`);
    }
    if (req.url.endsWith('/seg.ts')) { res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': bytes.length }); return res.end(bytes); }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let srv;
  try {
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u` }, admin);
    const invite = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
    const user = (await httpJson(srv.port, 'POST', '/api/invite/accept', { token: invite.json.token, name: 'viewer', password: 'pass1234' })).json.token;
    const list = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json.channels;
    const playOf = async (name, token) => {
      const c = list.find((x) => x.name === name);
      return (await httpJson(srv.port, 'GET', `/api/iptv/play/${c.idx}?cid=${encodeURIComponent(c.id)}`, null, token)).json;
    };
    await httpJson(srv.port, 'GET', '/api/iptv/channels', null, user);
    const good = await httpRaw(srv.port, (await playOf('Good', user)).streamUrl);
    assert.strictEqual(good.status, 200);
    assert.ok(good.body.length > 1000, `a non-admin gets a picture (${good.body.length} bytes)`);
    assert.ok(good.body.includes(Buffer.from('ftyp')), 'it is fMP4');
    for (const who of [admin, user]) {
      const bad = await httpRaw(srv.port, (await playOf('Bad', who)).streamUrl);
      assert.ok(bad.status >= 400 || !bad.body.includes(Buffer.from('mdat')), 'a playlist cannot make ffmpeg read a local file');
    }
  } finally {
    if (srv) await srv.shutdown();
    upstream.close();
  }
});

test('store: a background write that started first cannot land over a newer sync flush', async () => {
  const { Store } = require('../server/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-store-'));
  const store = new Store(dir);
  const realRename = fs.promises.rename;
  let release;
  const gate = new Promise((r) => { release = r; });
  fs.promises.rename = async (...a) => { await gate; return realRename(...a); };
  try {
    store.write('users', { list: [] });
    store._asyncFlush = store._flushAsync();
    await new Promise((r) => setTimeout(r, 30));
    store.write('users', { list: ['owner'] });
    store.close();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')).list, ['owner']);
    release();
    await store.settled();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')).list, ['owner'], 'the newer copy is what stays on disk');
  } finally {
    fs.promises.rename = realRename;
  }
});

// Audit F1-02 (B01-01): a full disk fails the TEMP write. The old fallback then opened the live
// table for an in-place write, which truncates it first, so a second ENOSPC left users.json or
// settings.json empty (nobody can sign in, or every setting looks blank after a restart).
function fullDiskError() { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; return e; }
function storeTmpLeft(dir) { return fs.readdirSync(dir).filter((n) => /\.json\.tmp\d+$/.test(n)); }

test('store: a failed temp write (disk full) never truncates the live table (sync flush)', () => {
  const { Store } = require('../server/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-store-'));
  const store = new Store(dir);
  const live = path.join(dir, 't.json');
  store.write('t', { v: 1 });
  store.flush();
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...rest) => {
    // Mimic a full disk: the open succeeds (truncating), a few bytes land, then ENOSPC.
    realWrite(file, String(data).slice(0, 3), ...rest);
    throw fullDiskError();
  };
  try {
    store.write('t', { v: 2 });
    store.flush();
  } finally {
    fs.writeFileSync = realWrite;
    if (store.timer) { clearTimeout(store.timer); store.timer = null; }
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(live, 'utf8')), { v: 1 }, 'the live file keeps its last good copy');
  assert.deepStrictEqual(storeTmpLeft(dir), [], 'the partial temp file is removed');
  assert.ok(store.dirty.has('t'), 'the table stays dirty for a retry');
  assert.strictEqual(store.lastFlushError && store.lastFlushError.code, 'ENOSPC');
});

test('store: a failed temp write (disk full) never truncates the live table (background flush)', async () => {
  const { Store } = require('../server/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-store-'));
  const store = new Store(dir);
  const live = path.join(dir, 't.json');
  store.write('t', { v: 1 });
  store.flush();
  const realWrite = fs.promises.writeFile;
  fs.promises.writeFile = async (file, data, ...rest) => {
    await realWrite(file, String(data).slice(0, 3), ...rest);
    throw fullDiskError();
  };
  try {
    store.write('t', { v: 2 });
    if (store.timer) { clearTimeout(store.timer); store.timer = null; }
    await store._flushAsync();
  } finally {
    fs.promises.writeFile = realWrite;
    if (store.timer) { clearTimeout(store.timer); store.timer = null; }
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(live, 'utf8')), { v: 1 }, 'the live file keeps its last good copy');
  assert.deepStrictEqual(storeTmpLeft(dir), [], 'the partial temp file is removed');
  assert.ok(store.dirty.has('t'), 'the table stays dirty for a retry');
  assert.strictEqual(store.lastFlushError && store.lastFlushError.code, 'ENOSPC');
});

test('store: a rename blocked by a lock (EPERM/EBUSY/EACCES) still falls back to the in-place write', async () => {
  const { Store } = require('../server/store');
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-store-'));
    const store = new Store(dir);
    const live = path.join(dir, 't.json');
    store.write('t', { v: 1 });
    store.flush();
    const realRename = fs.renameSync;
    let blocked = 0;
    fs.renameSync = (...a) => {
      if (!blocked++) { const e = new Error(`${code}: locked`); e.code = code; throw e; }
      return realRename(...a);
    };
    try {
      store.write('t', { v: 2 });
      store.flush();
    } finally {
      fs.renameSync = realRename;
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(live, 'utf8')), { v: 2 }, `${code}: the in-place write landed`);
    assert.deepStrictEqual(storeTmpLeft(dir), [], `${code}: no temp file left`);
    assert.ok(!store.dirty.has('t'), `${code}: nothing left to retry`);
    // Same for the background path.
    const realARename = fs.promises.rename;
    let ablocked = 0;
    fs.promises.rename = async (...a) => {
      if (!ablocked++) { const e = new Error(`${code}: locked`); e.code = code; throw e; }
      return realARename(...a);
    };
    try {
      store.write('t', { v: 3 });
      if (store.timer) { clearTimeout(store.timer); store.timer = null; }
      await store._flushAsync();
    } finally {
      fs.promises.rename = realARename;
      if (store.timer) { clearTimeout(store.timer); store.timer = null; }
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(live, 'utf8')), { v: 3 }, `${code}: background in-place write landed`);
    assert.deepStrictEqual(storeTmpLeft(dir), [], `${code}: no background temp file left`);
  }
});

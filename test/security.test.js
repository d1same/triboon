'use strict';
// Security + Phase 3/4 API corpus: deny-by-default route coverage, auth flows (setup, login,
// invites, quick connect), per-user caps from invite policy, settings encryption at rest,
// TMDB proxy + cache, watch state, and the HTTP play/advance endpoints.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { httpJson, httpRaw, bootServer, setupAdmin } = require('./helpers');
const { createMockNntp } = require('./mock-nntp');
const { encodePart } = require('../server/yenc');
const { seededPayload, writeRar4Store } = require('./archive-fixtures');

// One server for the whole file — routes are stateless enough and this keeps the suite fast.
let srv, admin, mockNntp, nntpPort;

// Scans run in the background (202) — kick one off and wait for its summary.
async function runScan(libId) {
  const r = await httpJson(srv.port, 'POST', `/api/libraries/${libId}/scan`, {}, admin);
  if (r.status >= 400) return r;
  for (let i = 0; i < 200; i++) {
    const st = await httpJson(srv.port, 'GET', `/api/libraries/${libId}/scanstatus`, null, admin);
    if (!st.json.running) return { status: st.json.error ? 400 : 200, json: st.json };
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('scan never finished');
}

function nzbFor(volumes, partSize, prefix) {
  const articles = new Map();
  const fileXml = volumes.map((v, fi) => {
    const totalParts = Math.ceil(v.data.length / partSize) || 1;
    const segs = [];
    for (let p = 0; p < totalParts; p++) {
      const begin = p * partSize, end = Math.min(v.data.length, begin + partSize);
      const body = encodePart(v.data, { name: v.name, partNum: p + 1, totalParts, begin, end, totalSize: v.data.length });
      const msgId = `${prefix}f${fi}s${p}@t.test`;
      articles.set(msgId, body);
      segs.push(`<segment bytes="${body.length}" number="${p + 1}">${msgId}</segment>`);
    }
    return `<file poster="t" date="1" subject="[r] &quot;${v.name}&quot; yEnc (1/${totalParts})"><groups><group>a.b</group></groups><segments>${segs.join('')}</segments></file>`;
  }).join('');
  return { nzb: `<?xml version="1.0"?><nzb>${fileXml}</nzb>`, articles };
}

const PAYLOAD = seededPayload(120 * 1024, 0x5ec);
const RELEASE = nzbFor(writeRar4Store([{ name: 'Sec.Test.mkv', data: PAYLOAD }], { base: 'sec' }), 30000, 'sec');

// Mock TMDB upstream.
let tmdbHits = 0;
const tmdbMock = http.createServer((req, res) => {
  tmdbHits++;
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/3/tv/424242') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      id: 424242, name: 'Next Up Show', first_air_date: '2026-01-01', overview: 'A show that keeps going.',
      backdrop_path: '/show-backdrop.jpg', poster_path: '/show-poster.jpg',
      seasons: [{ season_number: 1, episode_count: 3 }],
    }));
  }
  if (u.pathname === '/3/tv/424242/season/1') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ episodes: [
      { episode_number: 1, name: 'Pilot', air_date: '2026-01-01', overview: 'Seen.' },
      { episode_number: 2, name: 'Aired Next', air_date: '2026-01-02', overview: 'Ready.', vote_average: 8.2, still_path: '/ep2.jpg' },
      { episode_number: 3, name: 'Future Next', air_date: '2099-01-01', overview: 'Not yet.' },
    ] }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    path: req.url,
    results: [{ id: 1, media_type: 'movie', title: 'Mock Movie', backdrop_path: '/mock-backdrop.jpg', poster_path: '/mock-poster.jpg' }],
  }));
});

// Mock indexer for HTTP play tests.
let ixServer;
function startIndexer() {
  ixServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const port = ixServer.address().port; // real listening port for the enclosure URL
    if (u.pathname === '/api') {
      res.writeHead(200);
      return res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://x"><channel><item>
        <title>Sec.Test.2024.1080p.WEB-DL.H.264-NTb</title>
        <enclosure url="http://127.0.0.1:${port}/nzb" length="4000000000" type="application/x-nzb"/><!-- claims 4GB: tiny declared sizes are now disqualified as sample stubs -->
        </item></channel></rss>`);
    }
    if (u.pathname === '/nzb') { res.writeHead(200); return res.end(RELEASE.nzb); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => ixServer.listen(0, '127.0.0.1', () => r(ixServer.address().port)));
}

test('boot: fresh server requires setup, then issues a working admin token', async () => {
  mockNntp = createMockNntp({ articles: RELEASE.articles });
  nntpPort = await mockNntp.listen();
  await new Promise((r) => tmdbMock.listen(0, '127.0.0.1', r));
  srv = await bootServer({
    NNTP_HOST: '127.0.0.1', NNTP_PORT: nntpPort, NNTP_TLS: 'false', NNTP_USER: null,
    TMDB_BASE: `http://127.0.0.1:${tmdbMock.address().port}/3`,
  });

  const s = await httpJson(srv.port, 'GET', '/api/server');
  assert.strictEqual(s.status, 200);
  assert.match(s.json.version, /^\d+\.\d+\.\d+/, 'server info should expose the running version for Unraid/update checks');
  assert.strictEqual(s.json.needsSetup, true);

  admin = await setupAdmin(srv.port);
  const me = await httpJson(srv.port, 'GET', '/api/me', null, admin);
  assert.strictEqual(me.json.role, 'admin');

  // Second setup attempt is rejected — no admin takeover.
  const again = await httpJson(srv.port, 'POST', '/api/setup', { name: 'evil', password: 'xxxx' });
  assert.strictEqual(again.status, 403);

  // Bad login rejected.
  const bad = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'wrong' });
  assert.strictEqual(bad.status, 401);
});

test('security: deny-by-default — every route declares auth; unknown routes 404; no anon access', async () => {
  // 1. Static declaration: every route in the table has a valid auth level.
  for (const r of srv.ROUTES) {
    assert.ok(['public', 'user', 'admin', 'stream'].includes(r.auth),
      `route ${r.re} must declare auth (got ${r.auth})`);
    assert.strictEqual(typeof r.h, 'function');
  }
  // 2. Unknown API path → 404 even unauthenticated (deny by default).
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/not-a-route')).status, 404);
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/stream/abc')).status, 404, 'wrong method = no route');

  // 3. Every non-public route rejects anonymous and garbage-token requests.
  const probes = [
    ['GET', '/api/me'], ['GET', '/api/status'], ['GET', '/api/search?q=x'],
    ['POST', '/api/play'], ['POST', '/api/advance/abc'], ['GET', '/api/tmdb/trending/all/week'],
    ['GET', '/api/watch'], ['GET', '/api/watch/next'], ['POST', '/api/watch'], ['GET', '/api/mounts'],
    ['GET', '/api/health/abc'], ['POST', '/api/mount'], ['GET', '/api/settings'],
    ['GET', '/api/me/iptv/sources'], ['POST', '/api/me/iptv/sources'], ['PATCH', '/api/me/iptv/sources/abc'], ['DELETE', '/api/me/iptv/sources/abc'],
    ['POST', '/api/settings'], ['POST', '/api/streaming/recommend'], ['POST', '/api/invites'], ['GET', '/api/invites'],
    ['GET', '/api/users'], ['GET', '/api/stream/abc'], ['GET', '/api/remux/abc'],
    ['GET', '/api/iptv/status'], ['POST', '/api/iptv/refresh'], ['GET', '/api/iptv/sources'], ['POST', '/api/iptv/sources'], ['PATCH', '/api/iptv/sources/abc'], ['DELETE', '/api/iptv/sources/abc'],
    ['POST', '/api/quickconnect/123456/approve'], ['GET', '/api/music/charts'], ['GET', '/api/music/search?q=x'],
  ];
  for (const [m, p] of probes) {
    assert.strictEqual((await httpJson(srv.port, m, p)).status, 401, `anon ${m} ${p}`);
    assert.strictEqual((await httpJson(srv.port, m, p, null, 'garbage.token')).status, 401, `garbage ${m} ${p}`);
  }
});

test('security: role separation — user tokens cannot reach admin routes', async () => {
  const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: { maxResolutionRank: 3 } }, admin);
  assert.strictEqual(inv.status, 200);

  const joined = await httpJson(srv.port, 'POST', '/api/invite/accept',
    { token: inv.json.token, name: 'fam', password: 'fam-pass' });
  assert.strictEqual(joined.status, 200);
  const user = joined.json.token;
  assert.strictEqual(joined.json.user.policy.maxResolutionRank, 3, 'invite policy applied (1080p cap)');

  // Invite is single-use.
  const reuse = await httpJson(srv.port, 'POST', '/api/invite/accept',
    { token: inv.json.token, name: 'fam2', password: 'xxxx' });
  assert.strictEqual(reuse.status, 400);

  for (const [m, p] of [['GET', '/api/settings'], ['POST', '/api/settings'], ['POST', '/api/invites'],
    ['GET', '/api/invites'], ['GET', '/api/users'], ['POST', '/api/mount'],
    ['POST', '/api/libraries'], ['DELETE', '/api/libraries/abc'], ['POST', '/api/streaming/recommend'],
    ['GET', '/api/iptv/status'], ['POST', '/api/iptv/refresh']]) {
    assert.strictEqual((await httpJson(srv.port, m, p, {}, user)).status, 403, `user → ${m} ${p}`);
  }
  // …but user routes work.
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/status', null, user)).status, 200);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/libraries', null, user)).status, 200, 'users can READ libraries');
});

test('watchlist: per-user toggle add/remove, isolation', async () => {
  const add = await httpJson(srv.port, 'POST', '/api/watchlist', { key: 'tmdb:tv:1399', meta: { title: 'GoT' } }, admin);
  assert.strictEqual(add.status, 200); assert.strictEqual(add.json.on, true);
  let list = await httpJson(srv.port, 'GET', '/api/watchlist', null, admin);
  assert.ok(list.json.some((w) => w.key === 'tmdb:tv:1399' && w.meta.title === 'GoT'));
  // toggle off
  const off = await httpJson(srv.port, 'POST', '/api/watchlist', { key: 'tmdb:tv:1399' }, admin);
  assert.strictEqual(off.json.on, false);
  list = await httpJson(srv.port, 'GET', '/api/watchlist', null, admin);
  assert.ok(!list.json.some((w) => w.key === 'tmdb:tv:1399'));
  // isolation: another user's watchlist is independent
  const u = await httpJson(srv.port, 'POST', '/api/login', { name: 'fam', password: 'fam-pass' });
  await httpJson(srv.port, 'POST', '/api/watchlist', { key: 'tmdb:movie:603' }, u.json.token);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/watchlist', null, admin)).json.length, 0, 'admin list unaffected');
});

test('settings ops: add/remove multiple providers and indexers, secrets never round-trip', async () => {
  // add two providers with different connection limits via ops
  await httpJson(srv.port, 'POST', '/api/settings', { addProvider: { host: 'news.a.com', port: 563, user: 'u1', pass: 'p-one-secret', connections: 30 } }, admin);
  await httpJson(srv.port, 'POST', '/api/settings', { addProvider: { host: 'news.b.com', port: 119, tls: false, user: 'u2', pass: 'p-two-secret', connections: 8 } }, admin);
  await httpJson(srv.port, 'POST', '/api/settings', { addIndexer: { name: 'geek2', url: 'https://api2.example/api', apikey: 'k-secret-2' } }, admin);
  let s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.ok(s.json.providers.length >= 2, 'both ops-added providers present');
  const a = s.json.providers.find((p) => p.host === 'news.a.com');
  const b = s.json.providers.find((p) => p.host === 'news.b.com');
  assert.strictEqual(a.connections, 30); assert.strictEqual(b.connections, 8);
  assert.strictEqual(a.user, '•••', 'secrets redacted in responses');
  assert.ok(s.json.indexers.some((i) => i.name === 'geek2'), 'ops-added indexer present');
  const raw = fs.readFileSync(path.join(process.env.TRIBOON_DATA, 'settings.json'), 'utf8');
  for (const sec of ['p-one-secret', 'p-two-secret', 'k-secret-2']) assert.ok(!raw.includes(sec), sec + ' encrypted at rest');
  // remove by index
  const idxB = s.json.providers.findIndex((p) => p.host === 'news.b.com');
  await httpJson(srv.port, 'POST', '/api/settings', { removeProvider: idxB }, admin);
  s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.ok(!s.json.providers.some((p) => p.host === 'news.b.com'), 'provider removed');
  // restore single test provider for later tests
  await httpJson(srv.port, 'POST', '/api/settings', { providers: [{ host: '127.0.0.1', port: nntpPort, tls: false, user: 'u', pass: 'super-secret-pass', connections: 4 }] }, admin);
});

test('settings: streaming performance handles high-connection providers and recommendations', async () => {
  await httpJson(srv.port, 'POST', '/api/settings', {
    providers: [{ host: 'news.big.example', port: 563, tls: true, user: 'u', pass: 'pw', connections: 100 }],
    streamingPerformance: {
      expectedUsers: 8, remoteUsers: 3, streamMix: 'mixed',
      serverDownloadMbps: 1000, serverUploadMbps: 200,
      buffer1080Sec: 180, buffer4kSec: 90,
    },
  }, admin);
  const s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(s.json.providers[0].connections, 100, '100-connection usenet plans are preserved');
  assert.strictEqual(s.json.maxProviderConnections, 150);
  assert.strictEqual(s.json.streamingPerformance.expectedUsers, 8);

  const rec = await httpJson(srv.port, 'POST', '/api/streaming/recommend', {
    expectedUsers: 10, remoteUsers: 4, streamMix: 'mixed',
    serverDownloadMbps: 1000, serverUploadMbps: 200,
  }, admin);
  assert.strictEqual(rec.status, 200);
  assert.strictEqual(rec.json.capacity.totalConnections, 100);
  assert.ok(rec.json.capacity.reserveConnections > 0, 'start/seek reserve is modeled');
  assert.ok(rec.json.recommendation.maxConnPerStream1080 >= 4, 'recommendation includes per-stream budget');
  assert.ok(rec.json.recommendation.buffer1080Sec >= 30, 'recommendation includes buffer target');

  await httpJson(srv.port, 'POST', '/api/settings', {
    providers: [{ host: '127.0.0.1', port: nntpPort, tls: false, user: 'u', pass: 'super-secret-pass', connections: 4 }],
  }, admin);
});

test('libraries: admin CRUD, users read-only, validation', async () => {
  const bad = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'x', mediaType: 'bogus' }, admin);
  assert.strictEqual(bad.status, 400);
  const made = await httpJson(srv.port, 'POST', '/api/libraries',
    { name: 'Anime Movies', mediaType: 'movie', genreId: 16, sort: 'vote_average.desc', path: '/mnt/anime', icon: 'fire' }, admin);
  assert.strictEqual(made.status, 200);
  assert.match(made.json.id, /^[a-f0-9]{10}$/);
  assert.strictEqual(made.json.path, '/mnt/anime', 'optional library path stored');
  assert.strictEqual(made.json.icon, 'fire', 'custom library icon stored');
  const badIcon = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'X', mediaType: 'tv', icon: 'evil' }, admin);
  assert.strictEqual(badIcon.json.icon, 'auto', 'unknown icon falls back to auto');
  const list = await httpJson(srv.port, 'GET', '/api/libraries', null, admin);
  assert.ok(list.json.some((l) => l.id === made.json.id && l.name === 'Anime Movies' && l.genreId === '16'));
  const del = await httpJson(srv.port, 'DELETE', `/api/libraries/${made.json.id}`, null, admin);
  assert.strictEqual(del.status, 200);
  assert.ok(!(await httpJson(srv.port, 'GET', '/api/libraries', null, admin)).json.some((l) => l.id === made.json.id));
});

test('settings: encrypted at rest — secrets never appear in plaintext on disk', async () => {
  const r = await httpJson(srv.port, 'POST', '/api/settings', {
    tmdbKey: 'super-secret-tmdb-key',
    indexers: [{ name: 'geek', url: 'http://127.0.0.1:1/api', apikey: 'super-secret-api-key' }],
    providers: [{ host: '127.0.0.1', port: nntpPort, tls: false, user: 'u', pass: 'super-secret-pass', connections: 4 }],
  }, admin);
  assert.strictEqual(r.status, 200);

  const raw = fs.readFileSync(path.join(process.env.TRIBOON_DATA, 'settings.json'), 'utf8');
  for (const secret of ['super-secret-tmdb-key', 'super-secret-api-key', 'super-secret-pass']) {
    assert.ok(!raw.includes(secret), `${secret} must not be stored in plaintext`);
  }

  const got = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(got.json.tmdbKey, '•••', 'API redacts secrets');
  assert.strictEqual(got.json.providers[0].host, '127.0.0.1');
});

test('tmdb: proxy injects the server key and caches responses', async () => {
  tmdbHits = 0;
  const a = await httpJson(srv.port, 'GET', '/api/tmdb/trending/all/week', null, admin);
  assert.strictEqual(a.status, 200);
  assert.match(a.json.path, /api_key=super-secret-tmdb-key/, 'key added server-side');
  const b = await httpJson(srv.port, 'GET', '/api/tmdb/trending/all/week', null, admin);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(tmdbHits, 1, 'second request served from cache');
  // Traversal attempts are rejected — by URL normalization (→404) or the path guard (→400).
  assert.ok((await httpJson(srv.port, 'GET', '/api/tmdb/%2e%2e/evil', null, admin)).status >= 400, 'encoded traversal rejected');
});

test('tmdb: login artwork is public but only exposes safe art metadata', async () => {
  const art = await httpJson(srv.port, 'GET', '/api/auth-art');
  assert.strictEqual(art.status, 200);
  assert.strictEqual(art.json.configured, true);
  assert.ok(Array.isArray(art.json.items));
  assert.ok(art.json.items.length >= 1, 'auth gate receives artwork when TMDB is configured');
  const first = art.json.items[0];
  assert.strictEqual(first.title, 'Mock Movie');
  assert.strictEqual(first.kind, 'movie');
  assert.strictEqual(first.backdrop, 'https://image.tmdb.org/t/p/w1280/mock-backdrop.jpg');
  assert.strictEqual(first.poster, 'https://image.tmdb.org/t/p/w342/mock-poster.jpg');
  assert.ok(!Object.prototype.hasOwnProperty.call(first, 'path'), 'upstream request path is not exposed');
  assert.ok(!art.raw.includes('super-secret-tmdb-key'), 'server TMDB key never leaves the API');
});

test('tmdb: detail, discover, genre, video, and search paths all pass proxy validation', async () => {
  for (const p of [
    '/api/tmdb/movie/603?append_to_response=credits,videos',  // detail + cast + trailers
    '/api/tmdb/tv/1399?append_to_response=credits,videos',
    '/api/tmdb/tv/1399/season/2',                             // episode drill-down
    '/api/tmdb/discover/movie?sort_by=popularity.desc&vote_count.gte=50&with_genres=28&page=1', // Movies page
    '/api/tmdb/discover/tv?sort_by=vote_average.desc&first_air_date.desc&page=1',                // TV page
    '/api/tmdb/genre/movie/list', '/api/tmdb/genre/tv/list',  // filter chips
    '/api/tmdb/movie/top_rated', '/api/tmdb/movie/now_playing', '/api/tmdb/tv/on_the_air', // Discover rows
    '/api/tmdb/movie/603/videos',                             // trailers row
    '/api/tmdb/movie/603?append_to_response=recommendations,similar', // related row
    '/api/tmdb/discover/movie?certification_country=US&certification.lte=PG-13&include_adult=false&page=1', // maturity filter
    '/api/tmdb/search/multi?query=matrix',                    // global search
  ]) {
    const r = await httpJson(srv.port, 'GET', p, null, admin);
    assert.strictEqual(r.status, 200, p);
    assert.match(r.json.path, /api_key=/, `${p} proxied upstream with the server key`);
  }
});

test('watch state: per-user, per-profile, ordered by recency', async () => {
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:1', position: 120, duration: 7200, meta: { title: 'A' } }, admin);
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:2', position: 30, duration: 1800, meta: { title: 'B' } }, admin);
  const list = await httpJson(srv.port, 'GET', '/api/watch', null, admin);
  assert.strictEqual(list.json.length, 2);
  assert.strictEqual(list.json[0].key, 'tmdb:2', 'most recent first');

  // Another user sees nothing (isolation).
  const u2 = await httpJson(srv.port, 'POST', '/api/login', { name: 'fam', password: 'fam-pass' });
  const other = await httpJson(srv.port, 'GET', '/api/watch', null, u2.json.token);
  assert.strictEqual(other.json.length, 0);
});

test('watch next: finished episodes keep the next aired episode in Continue Watching', async () => {
  await httpJson(srv.port, 'POST', '/api/watch', {
    key: 'tmdb:tv:424242:s1e1', watched: true, position: 0, duration: 1800,
    meta: { title: 'Next Up Show — S01E01', type: 'episode', tmdbId: 424242, qualityRank: 4 },
  }, admin);
  let next = await httpJson(srv.port, 'GET', '/api/watch/next', null, admin);
  assert.strictEqual(next.status, 200);
  const nextEp = next.json.find((x) => x.key === 'tmdb:tv:424242:s1e2' && x._nextEp);
  assert.ok(nextEp, 'aired S01E02 appears as next episode');
  assert.ok(nextEp.updatedAt > 0, 'next episode carries the watched timestamp that should order Continue Watching');
  assert.strictEqual(nextEp.qualityRank, 4, 'next episode inherits the saved show quality class');
  assert.ok(!next.json.some((x) => x.key === 'tmdb:tv:424242:s1e3'), 'future S01E03 is held until it airs');

  await httpJson(srv.port, 'POST', '/api/watch', {
    key: 'tmdb:tv:424242:s1e2', position: 300, duration: 1800,
    meta: { title: 'Next Up Show — S01E02', type: 'episode', tmdbId: 424242 },
  }, admin);
  next = await httpJson(srv.port, 'GET', '/api/watch/next', null, admin);
  assert.ok(!next.json.some((x) => x.key.startsWith('tmdb:tv:424242:')), 'an in-progress episode wins over next-up suggestions');
});

test('e2e: HTTP play pipeline — search, play, stream with token, advance 404 when exhausted', async () => {
  const ixPort = await startIndexer();
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  }, admin);

  // Query the release's full title: title verification anchors the wanted title at the
  // start of the name AND requires a structural token after it, so a bare "sec" against
  // "Sec.Test.2024..." is (correctly) a different-title rejection.
  const sr = await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Sec Test 2024'), null, admin);
  assert.strictEqual(sr.status, 200);
  assert.strictEqual(sr.json.candidates.length, 1);
  assert.ok(sr.json.candidates[0].score > 0);

  const play = await httpJson(srv.port, 'POST', '/api/play', { q: 'Sec Test 2024' }, admin);
  assert.strictEqual(play.status, 200, JSON.stringify(play.json));
  assert.strictEqual(play.json.container, 'rar');
  assert.match(play.json.streamUrl, /\?t=/, 'stream URL carries a token for VLC/video');

  // Stream with the token: byte-exact range read.
  const mid = await httpRaw(srv.port, play.json.streamUrl, { range: 'bytes=50000-59999' });
  assert.strictEqual(mid.status, 206);
  assert.ok(mid.body.equals(PAYLOAD.subarray(50000, 60000)));

  // Stripping the token kills it; a session token does work for streams (browser case).
  const bare = play.json.streamUrl.split('?')[0];
  assert.strictEqual((await httpRaw(srv.port, bare)).status, 401);
  const viaSession = await httpRaw(srv.port, bare, { token: admin, range: 'bytes=0-99' });
  assert.strictEqual(viaSession.status, 206, 'session bearer token also valid for streams (browser case)');

  // Advance: only one candidate → exhausted.
  const adv = await httpJson(srv.port, 'POST', `/api/advance/${play.json.sessionId}`, {}, admin);
  assert.strictEqual(adv.status, 502);
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/advance/zzzz', {}, admin)).status, 404);
});

test('security: a forged token with no exp claim is rejected (immortal-token footgun)', async () => {
  // Craft a token signed with the server secret but WITHOUT an exp field.
  const crypto = require('crypto');
  const secret = srv.auth.secret;
  const payload = Buffer.from(JSON.stringify({ uid: 'x', role: 'admin', scope: 'session' })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const forged = `${payload}.${sig}`;
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, forged)).status, 401);
});

test('security: concurrent accepts of one single-use invite — exactly one wins', async () => {
  const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
  const [a, b] = await Promise.all([
    httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name: 'raceA', password: 'pwpwpw' }),
    httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name: 'raceB', password: 'pwpwpw' }),
  ]);
  const oks = [a, b].filter((r) => r.status === 200).length;
  assert.strictEqual(oks, 1, 'single-use invite consumed exactly once under concurrency');
});

test('security: /api/mounts is admin-only (no enumeration by regular users)', async () => {
  const u = await httpJson(srv.port, 'POST', '/api/login', { name: 'fam', password: 'fam-pass' });
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/mounts', null, u.json.token)).status, 403);
});

test('profiles: leveled + PIN lock; PIN verified server-side and hash never leaks', async () => {
  const add = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'Junior', level: 0, pin: '1234' }, admin);
  assert.strictEqual(add.status, 200);
  assert.strictEqual(add.json.level, 0);
  assert.strictEqual(add.json.kid, true);
  assert.strictEqual(add.json.locked, true);
  assert.strictEqual(add.json.pinHash, undefined, 'PIN hash never sent to client');
  // me() also must not expose the hash
  const me = await httpJson(srv.port, 'GET', '/api/me', null, admin);
  const jr = me.json.profiles.find((p) => p.name === 'Junior');
  assert.ok(jr && jr.locked && jr.pinHash === undefined);
  // wrong PIN rejected, right PIN accepted
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${add.json.id}/verify`, { pin: '0000' }, admin)).json.ok, false);
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${add.json.id}/verify`, { pin: '1234' }, admin)).json.ok, true);
  // raw store has no plaintext PIN
  const raw = fs.readFileSync(path.join(process.env.TRIBOON_DATA, 'users.json'), 'utf8');
  assert.ok(!/"1234"/.test(raw), 'PIN stored only as scrypt hash');
});

test('watch bulk: mark a whole show watched then clear it', async () => {
  const items = [1, 2, 3].map((e) => ({ key: `tmdb:tv:555:s1e${e}`, meta: { title: 'Bulk', type: 'episode' } }));
  await httpJson(srv.port, 'POST', '/api/watch/bulk', { items, watched: true, profile: 'p1' }, admin);
  let list = await httpJson(srv.port, 'GET', '/api/watch?profile=p1', null, admin);
  assert.strictEqual(list.json.filter((w) => w.key.startsWith('tmdb:tv:555:')).length, 3);
  assert.ok(list.json.every((w) => !w.key.startsWith('tmdb:tv:555:') || w.watched));
  await httpJson(srv.port, 'POST', '/api/watch/bulk', { items, watched: false, profile: 'p1' }, admin);
  list = await httpJson(srv.port, 'GET', '/api/watch?profile=p1', null, admin);
  assert.strictEqual(list.json.filter((w) => w.key.startsWith('tmdb:tv:555:')).length, 0, 'bulk unwatch clears them');
});

test('profiles: add a profile; watch state is isolated per profile', async () => {
  const add = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'Kids', level: 0 }, admin);
  assert.strictEqual(add.status, 200);
  assert.match(add.json.id, /^[a-f0-9]{8}$/);
  assert.strictEqual(add.json.kid, true);
  const me = await httpJson(srv.port, 'GET', '/api/me', null, admin);
  assert.ok(me.json.profiles.some((p) => p.name === 'Kids'));
  // watch progress under one profile is invisible to another
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:99', position: 600, duration: 6000, profile: add.json.id }, admin);
  const kidsList = await httpJson(srv.port, 'GET', `/api/watch?profile=${add.json.id}`, null, admin);
  assert.ok(kidsList.json.some((w) => w.key === 'tmdb:movie:99'));
  const defaultList = await httpJson(srv.port, 'GET', '/api/watch', null, admin);
  assert.ok(!defaultList.json.some((w) => w.key === 'tmdb:movie:99'), 'kids progress not in default profile');
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/me/profiles', { name: '' }, admin)).status, 400);
});

test('libraries v2: kinds, edit, folder scan, and Range-served local playback', async () => {
  const os = require('os');
  // Build a fake media folder: one loose file + one movie folder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-lib-'));
  fs.writeFileSync(path.join(dir, 'Some.Movie.(2020).mkv'), Buffer.from('FAKE-VIDEO-BYTES-0123456789'));
  fs.mkdirSync(path.join(dir, 'Another Film (2018)'));
  fs.writeFileSync(path.join(dir, 'Another Film (2018)', 'film.mp4'), Buffer.from('MORE-FAKE-VIDEO'));

  const made = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Local', kind: 'other', path: dir }, admin);
  assert.strictEqual(made.status, 200);
  assert.strictEqual(made.json.kind, 'other');

  // Edit: rename + change kind.
  const edited = await httpJson(srv.port, 'PATCH', `/api/libraries/${made.json.id}`, { name: 'My Films', kind: 'sports' }, admin);
  assert.strictEqual(edited.json.name, 'My Films');
  assert.strictEqual(edited.json.kind, 'sports');
  // Users cannot edit/scan.
  const u = await httpJson(srv.port, 'POST', '/api/login', { name: 'fam', password: 'fam-pass' });
  assert.strictEqual((await httpJson(srv.port, 'PATCH', `/api/libraries/${made.json.id}`, { name: 'x' }, u.json.token)).status, 403);
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/libraries/${made.json.id}/scan`, {}, u.json.token)).status, 403);

  // Scan: parses "Title (Year)" from file + folder names ('sports' kind skips TMDB matching).
  const scan = await runScan(made.json.id);
  assert.strictEqual(scan.status, 200);
  assert.strictEqual(scan.json.count, 2);
  const items = await httpJson(srv.port, 'GET', `/api/libraries/${made.json.id}/items`, null, admin);
  const titles = items.json.items.map((i) => i.title).sort();
  assert.deepStrictEqual(titles, ['Another Film', 'Some Movie']);
  assert.ok(items.json.items.every((i) => i.file === undefined), 'absolute paths never exposed');
  assert.ok(items.json.items.every((i) => /^\/api\/local\//.test(i.streamUrl)), 'tokenized stream URLs');
  assert.ok(items.json.items.every((i) => /^\/api\/local\/\w+\/\d+\/play$/.test(i.playUrl)), 'local items expose full player prep URLs');
  const firstPage = await httpJson(srv.port, 'GET', `/api/libraries/${made.json.id}/items?offset=0&limit=1&sort=title.asc`, null, admin);
  assert.strictEqual(firstPage.status, 200);
  assert.strictEqual(firstPage.json.items.length, 1);
  assert.strictEqual(firstPage.json.total, 2);
  assert.strictEqual(firstPage.json.hasMore, true);
  assert.deepStrictEqual(firstPage.json.items.map((i) => i.title), ['Another Film']);
  assert.ok(firstPage.json.items.every((i) => i.file === undefined), 'paged local items never expose absolute paths');

  // Local playback with Range.
  const it0 = items.json.items.find((i) => i.title === 'Some Movie');
  const full = await httpRaw(srv.port, it0.streamUrl);
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.body.toString(), 'FAKE-VIDEO-BYTES-0123456789');
  const part = await httpRaw(srv.port, it0.streamUrl, { range: 'bytes=5-9' });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.body.toString(), 'VIDEO');
  // Tokenless access denied.
  assert.strictEqual((await httpRaw(srv.port, it0.streamUrl.split('?')[0])).status, 401);

  // Full player prep: added-library files become normal mounts, so they share Movies/TV
  // player features (track probe, subtitles, remux/transcode fallback, native handoff).
  const play = await httpJson(srv.port, 'POST', it0.playUrl, { caps: { mkv: true, ac3: true, eac3: true } }, admin);
  assert.strictEqual(play.status, 200);
  assert.match(play.json.id, /^l[a-f0-9]{12}$/);
  assert.strictEqual(play.json.container, 'local');
  assert.ok(play.json.streamUrl.startsWith(`/api/stream/${play.json.id}?t=`));
  assert.ok(play.json.tracksUrl.endsWith(`/api/tracks/${play.json.id}`));
  assert.strictEqual(play.json.subtitleBase, `/api/subtitle/${play.json.id}`);
  const mounted = await httpRaw(srv.port, play.json.streamUrl, { range: 'bytes=5-9' });
  assert.strictEqual(mounted.status, 206);
  assert.strictEqual(mounted.body.toString(), 'VIDEO');
});

test('library scan v2: Jellyfin layout — shows/episodes, NFO info, local poster art', async () => {
  const os2 = require('os');
  const root = fs.mkdtempSync(path.join(os2.tmpdir(), 'triboon-jelly-'));
  // Movie folder: video + Kodi NFO + poster.jpg (unicode in folder name, like real libraries).
  const mdir = path.join(root, 'My Film (2021) فيلم');
  fs.mkdirSync(mdir);
  fs.writeFileSync(path.join(mdir, 'My Film (2021).mkv'), 'MOVIE-BYTES');
  fs.writeFileSync(path.join(mdir, 'My Film (2021).nfo'),
    '<movie><title>My Film Proper</title><year>2021</year><plot>A test plot.</plot><rating>7.5</rating></movie>');
  const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70]);
  fs.writeFileSync(path.join(mdir, 'poster.jpg'), JPEG);
  // Series: Show (Year)/Season 01/Show - S01E0x - name.mp4 + tvshow.nfo + poster.jpg
  const sdir = path.join(root, 'My Show (2019) سریال');
  fs.mkdirSync(path.join(sdir, 'Season 01'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'tvshow.nfo'), '<tvshow><title>My Show</title><year>2019</year><plot>Show plot.</plot></tvshow>');
  fs.writeFileSync(path.join(sdir, 'poster.jpg'), JPEG);
  fs.writeFileSync(path.join(sdir, 'Season 01', 'My Show - S01E01 - Pilot.mp4'), 'EPISODE-ONE');
  fs.writeFileSync(path.join(sdir, 'Season 01', 'My Show - S01E02 - Two.mp4'), 'EPISODE-TWO');

  const lib = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Jelly', kind: 'movie', path: root }, admin);
  const scan = await runScan(lib.json.id);
  assert.strictEqual(scan.status, 200);
  assert.strictEqual(scan.json.shows, 1, 'series folder detected as a show');
  assert.ok(scan.json.withLocalArt >= 2, 'poster.jpg picked up for movie and show');

  const items = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items;
  const movie = items.find((i) => i.kind === 'movie');
  const show = items.find((i) => i.kind === 'show');
  const eps = items.filter((i) => i.kind === 'episode');
  // Title rule: TMDB display name when matched (mock returns "Mock Movie"); the NFO still
  // supplies year/plot/rating, which beat the filename parse.
  assert.strictEqual(movie.title, 'Mock Movie', 'TMDB display name wins when matched');
  assert.strictEqual(movie.year, '2021', 'NFO year kept');
  assert.strictEqual(movie.overview, 'A test plot.', 'NFO plot kept');
  assert.strictEqual(movie.rating, 7.5, 'NFO rating kept');
  assert.ok(show.title, 'show titled');
  assert.strictEqual(eps.length, 2);
  assert.deepStrictEqual(eps.map((e) => [e.s, e.e]), [[1, 1], [1, 2]], 'episodes ordered');
  assert.ok(eps.every((e) => e.showIdx === show.idx && e.streamUrl), 'episodes playable + linked to the show');
  assert.strictEqual(show.streamUrl, null, 'shows are containers, not directly playable');
  assert.ok(items.every((i) => i.file === undefined && i.artFile === undefined), 'no paths leak');

  // Local art serves with its bound token; the art token can't hit the video route.
  assert.ok(movie.artUrl, 'movie has local art url');
  const art = await httpRaw(srv.port, movie.artUrl);
  assert.strictEqual(art.status, 200);
  assert.strictEqual(art.headers['content-type'], 'image/jpeg');
  assert.deepStrictEqual(art.body, JPEG, 'poster bytes served exactly');
  const artToken = /[?&]t=([^&]+)/.exec(movie.artUrl)[1];
  assert.strictEqual((await httpRaw(srv.port, `/api/local/${lib.json.id}/${eps[0].idx}?t=${artToken}`)).status, 401,
    'art token rejected on the stream route');
  // Episode streams its own bytes.
  const ep1 = await httpRaw(srv.port, eps[0].streamUrl);
  assert.strictEqual(ep1.body.toString(), 'EPISODE-ONE');
});

test('library scan v3: rescans keep addedAt + matches, count new files; stable cover URLs', async () => {
  const os3 = require('os');
  const root = fs.mkdtempSync(path.join(os3.tmpdir(), 'triboon-incr-'));
  const mdir = path.join(root, 'Reuse Film (2020)');
  fs.mkdirSync(mdir);
  fs.writeFileSync(path.join(mdir, 'Reuse Film (2020).mkv'), 'FILM-ONE');
  const sdir = path.join(root, 'Reuse Show (2019)');
  fs.mkdirSync(path.join(sdir, 'Season 01'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'Season 01', 'Reuse Show - S01E01.mp4'), 'EP-ONE');

  const lib = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Incr', kind: 'movie', path: root }, admin);
  const scan1 = await runScan(lib.json.id);
  assert.strictEqual(scan1.json.count, 3); // movie + show + episode
  assert.strictEqual(scan1.json.newItems, 3, 'first scan: everything counts as new');
  const items1 = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items;
  const movie1 = items1.find((i) => i.kind === 'movie');
  const show1 = items1.find((i) => i.kind === 'show');
  const ep1 = items1.find((i) => i.kind === 'episode');
  assert.ok(movie1.addedAt > 0 && ep1.addedAt > 0, 'addedAt recorded for files');
  assert.strictEqual(show1.addedAt, ep1.addedAt, 'a show rides its newest episode\'s addedAt');
  assert.ok(Array.isArray(movie1.genres), 'genres recorded as an array');
  assert.ok(items1.every((i) => i.dir === undefined), 'show folder paths never exposed');

  // Stable cover/stream URLs: the SAME tokens across requests, so the browser HTTP cache
  // can actually hold the artwork (per-request tokens were a permanent cache-buster).
  const again = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items;
  assert.strictEqual(again.find((i) => i.kind === 'movie').streamUrl, movie1.streamUrl, 'stream URL identical across requests');
  assert.strictEqual(again.find((i) => i.kind === 'episode').thumbUrl, ep1.thumbUrl, 'thumb URL identical across requests');

  // TOUCH the movie (mtime changes) + drop a brand-new episode → rescan.
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(path.join(mdir, 'Reuse Film (2020).mkv'), 'FILM-ONE-v2');
  fs.writeFileSync(path.join(sdir, 'Season 01', 'Reuse Show - S01E02.mp4'), 'EP-TWO');
  const scan2 = await runScan(lib.json.id);
  assert.strictEqual(scan2.json.count, 4);
  assert.strictEqual(scan2.json.newItems, 1, 'rescan counts ONLY the new episode');
  const items2 = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items;
  const movie2 = items2.find((i) => i.kind === 'movie');
  const ep2new = items2.find((i) => i.kind === 'episode' && i.e === 2);
  assert.strictEqual(movie2.addedAt, movie1.addedAt,
    'addedAt survives rescans even when the file is touched (recently-added must not reshuffle)');
  assert.ok(ep2new.addedAt > ep1.addedAt, 'the new episode is newer');
  assert.strictEqual(items2.find((i) => i.kind === 'show').addedAt, ep2new.addedAt,
    'new episode floats the show to the top of recently-added');
  assert.strictEqual(movie2.title, movie1.title, 'cached TMDB match reused on rescan');

  // Scan modes: 'metadata' is accepted; bogus modes fall back to the default scan.
  const md = await httpJson(srv.port, 'POST', `/api/libraries/${lib.json.id}/scan`, { mode: 'metadata' }, admin);
  assert.strictEqual(md.status, 202);
  assert.strictEqual(md.json.mode, 'metadata');
  for (let i = 0; i < 200; i++) { // let it finish so later tests see a quiet scanner
    const st = await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/scanstatus`, null, admin);
    if (!st.json.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  // ---- Match override: revert to folder info / force an exact id; survives rescans ----
  const movieIdx = items2.find((i) => i.kind === 'movie').idx;
  assert.strictEqual(items2.find((i) => i.kind === 'movie').title, 'Mock Movie', 'TMDB-matched before the override');
  const rv = await httpJson(srv.port, 'POST', `/api/libraries/${lib.json.id}/match`, { idx: movieIdx, tmdbId: null }, admin);
  assert.strictEqual(rv.status, 202);
  for (let i = 0; i < 200; i++) {
    const st = await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/scanstatus`, null, admin);
    if (!st.json.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  let after = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items;
  let m3 = after.find((i) => i.kind === 'movie');
  assert.strictEqual(m3.tmdbId, null, 'override "none": no TMDB identity');
  assert.strictEqual(m3.title, 'Reuse Film', 'folder title restored');
  assert.strictEqual(m3.matchOverride, 'none', 'override visible to the UI');
  // A plain rescan must NOT re-match it (the override is remembered).
  await runScan(lib.json.id);
  after = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items;
  m3 = after.find((i) => i.kind === 'movie');
  assert.strictEqual(m3.tmdbId, null, 'override survives later scans');
  // Episodes are fixed via their SHOW; bogus targets rejected.
  const epIdx = after.find((i) => i.kind === 'episode').idx;
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/libraries/${lib.json.id}/match`, { idx: epIdx, tmdbId: null }, admin)).status, 400);
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/libraries/${lib.json.id}/match`, { idx: movieIdx, tmdbId: 'evil' }, admin)).status, 400);
  // 'auto' clears the override — the next scan matches normally again.
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/libraries/${lib.json.id}/match`, { idx: movieIdx, tmdbId: 'auto' }, admin)).status, 202);
  for (let i = 0; i < 200; i++) {
    const st = await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/scanstatus`, null, admin);
    if (!st.json.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const m4 = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items.find((i) => i.kind === 'movie');
  assert.strictEqual(m4.title, 'Mock Movie', 'auto: TMDB match restored');
  assert.strictEqual(m4.matchOverride, undefined, 'override cleared');

  // Auto-scan cadence: saves, clamps, and reads back with a real trace.
  const set = await httpJson(srv.port, 'POST', '/api/settings', { libAutoScanMin: 60 }, admin);
  assert.strictEqual(set.status, 200);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.libAutoScanMin, 60);
  await httpJson(srv.port, 'POST', '/api/settings', { libAutoScanMin: 0 }, admin);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.libAutoScanMin, 0, '0 = off is a saveable choice');
  await httpJson(srv.port, 'POST', '/api/settings', { libAutoScanMin: 15 }, admin);
});

test('iptv: M3U parsed into grouped channels; stream URLs tokenized; admin-set url redacted', async () => {
  const http2 = require('http');
  let origin = '';
  let nativeUa = '';
  const m3uSrv = http2.createServer((req, res) => {
    if (req.url === '/secret-user/playlist.m3u') {
      const m3u = `#EXTM3U
#EXTINF:-1 tvg-logo="http://x/l1.png" group-title="News",News One
${origin}/news1.m3u8
#EXTINF:-1 group-title="Sports",Sports Plus
${origin}/sports.ts
`;
      res.writeHead(200);
      res.end(m3u);
      return;
    }
    if (req.url === '/news1.m3u8') {
      nativeUa = req.headers['user-agent'] || '';
      res.writeHead(200, { 'content-type': 'application/x-mpegURL' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n');
      return;
    }
    if (req.url === '/sports.ts') {
      nativeUa = req.headers['user-agent'] || '';
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.end('TS-BYTES');
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => m3uSrv.listen(0, '127.0.0.1', r));
  try {
    origin = `http://127.0.0.1:${m3uSrv.address().port}`;
    const m3uUrl = `${origin}/secret-user/playlist.m3u`;
    await httpJson(srv.port, 'POST', '/api/settings', { iptvUrl: m3uUrl }, admin);

    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.json.configured, true);
    assert.strictEqual(ch.json.channels.length, 2);
    assert.deepStrictEqual(ch.json.channels.map((c) => c.group), ['News', 'Sports']);
    assert.ok(ch.json.channels.every((c) => c.url === undefined), 'upstream URLs never exposed');
    assert.ok(ch.json.channels.every((c) => /^\/api\/iptv\/stream\/\d+\?cid=[^&]+&t=/.test(c.streamUrl)));
    assert.ok(ch.json.channels.every((c) => /^\/api\/iptv\/native\/\d+\?cid=[^&]+&t=/.test(c.nativeUrl)));
    assert.ok(ch.json.channels.every((c) => c.nativeFallbackUrl === undefined), 'plain M3U does not invent a second native source');
    assert.deepStrictEqual(ch.json.channels.map((c) => c.nativeMime), ['application/x-mpegURL', 'video/mp2t']);
    const native = await httpRaw(srv.port, ch.json.channels[0].nativeUrl);
    assert.strictEqual(native.status, 200, 'native URL proxies the upstream stream instead of redirecting Android to it');
    assert.strictEqual(native.headers.location, undefined, 'native proxy must not leak the upstream stream URL');
    assert.strictEqual(native.body.toString('utf8'), '#EXTM3U\n#EXT-X-VERSION:3\n');
    assert.ok(nativeUa.includes('TriboonTV/') && nativeUa.includes('SMART-TV'),
      'native proxy should use the provider-compatible smart-TV server-side user agent');
    const wrongTok = /[?&]t=([^&]+)/.exec(ch.json.channels[0].nativeUrl)[1];
    const wrongNative = await httpRaw(srv.port, ch.json.channels[1].nativeUrl.replace(/([?&])t=[^&]+/, '$1t=' + wrongTok));
    assert.strictEqual(wrongNative.status, 401, 'native stream token is bound to the selected channel');

    // Settings response shows only the playlist HOST (urls often embed credentials).
    const s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
    assert.ok(!String(s.json.iptvUrl).includes('secret-user'), 'playlist path/credentials redacted');
  } finally {
    await httpJson(srv.port, 'POST', '/api/settings', { iptvUrl: null }, admin); // cleanup
    await new Promise((r) => m3uSrv.close(r));
  }
});

test('iptv: native proxy logs upstream errors without leaking provider urls', async () => {
  const http2 = require('http');
  let origin = '';
  let brokenHits = 0;
  const m3uSrv = http2.createServer((req, res) => {
    if (req.url === '/secret-user/playlist.m3u') {
      res.writeHead(200);
      res.end(`#EXTM3U
#EXTINF:-1 group-title="News",Broken News
${origin}/secret-user/broken.ts
`);
      return;
    }
    if (req.url === '/secret-user/broken.ts') {
      brokenHits++;
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('[Bot-Protection]: You are banned for repeated abuse');
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => m3uSrv.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${m3uSrv.address().port}`;
  const prevErr = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `${origin}/secret-user/playlist.m3u` }, admin);
    const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    assert.strictEqual(ch.json.channels.length, 1);
    const native = await httpRaw(srv.port, ch.json.channels[0].nativeUrl);
    assert.strictEqual(native.status, 403, 'native proxy forwards the provider failure status');
    assert.strictEqual(native.headers['x-triboon-iptv-error'], 'provider bot-protection');
    const repeat = await httpRaw(srv.port, ch.json.channels[0].nativeUrl);
    assert.strictEqual(repeat.status, 403, 'cached native failure keeps the same status');
    assert.strictEqual(brokenHits, 1, 'cached provider rejections prevent Exo retry storms from hammering upstream');
    const joined = logs.join('\n');
    assert.match(joined, /\[iptv native\].*"Broken News".*HTTP 403.*provider bot-protection/, 'log identifies the failing channel, status, and sanitized reason');
    assert.doesNotMatch(joined, /secret-user|broken\.ts|playlist\.m3u/, 'log must not leak provider URL paths or credentials');
  } finally {
    console.error = prevErr;
    await httpJson(srv.port, 'POST', '/api/settings', { iptvUrl: null }, admin);
    m3uSrv.close();
  }
});

test('iptv: Xtream API channels + short-EPG now/next + per-user favorites; creds redacted', async () => {
  const http2 = require('http');
  const b64 = (s) => Buffer.from(s).toString('base64');
  const nowS = Math.floor(Date.now() / 1000);
  let epgCalls = 0;
  let liveHits = [];
  const xt = http2.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/live/')) {
      liveHits.push({ path: u.pathname, ua: req.headers['user-agent'] || '' });
      res.writeHead(200, { 'content-type': u.pathname.endsWith('.m3u8') ? 'application/x-mpegURL' : 'video/mp2t' });
      res.end(u.pathname.endsWith('.m3u8') ? '#EXTM3U\n' : 'XTREAM-TS');
      return;
    }
    assert.strictEqual(u.searchParams.get('username'), 'xtuser');
    assert.strictEqual(u.searchParams.get('password'), 'xtpass');
    const action = u.searchParams.get('action');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_live_categories') {
      res.end(JSON.stringify([{ category_id: '7', category_name: 'News' }]));
    } else if (action === 'get_live_streams') {
      res.end(JSON.stringify([
        { stream_id: 101, name: 'News One HD', stream_icon: 'http://x/logo1.png', category_id: '7', epg_channel_id: 'news1.x' },
        { stream_id: 102, name: 'Cinema', stream_icon: '', category_id: '99', epg_channel_id: '' },
      ]));
    } else if (action === 'get_short_epg') {
      if (u.searchParams.get('stream_id') !== '101') {
        res.end(JSON.stringify({ epg_listings: [] }));
        return;
      }
      epgCalls++;
      res.end(JSON.stringify({ epg_listings: [
        { title: b64('Evening Bulletin'), start_timestamp: nowS - 600, stop_timestamp: nowS + 600 },
        { title: b64('Late Show'), start_timestamp: nowS + 600, stop_timestamp: nowS + 1800 },
      ] }));
    } else res.end('[]');
  });
  await new Promise((r) => xt.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${xt.address().port}`;
  await httpJson(srv.port, 'POST', '/api/settings',
    { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass' }, admin);

  try {
  const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
  assert.strictEqual(ch.json.configured, true);
  assert.strictEqual(ch.json.epg, true, 'xtream advertises a guide');
  assert.strictEqual(ch.json.channels.length, 2);
  const news = ch.json.channels.find((c) => c.name === 'News One HD');
  assert.strictEqual(news.group, 'News');
  assert.strictEqual(news.logo, 'http://x/logo1.png');
  assert.strictEqual(ch.json.channels.find((c) => c.name === 'Cinema').group, 'Other', 'unknown category falls back');
  assert.ok(ch.json.channels.every((c) => c.url === undefined), 'upstream URLs (with creds) never exposed');
  assert.ok(/^\/api\/iptv\/native\/\d+\?cid=[^&]+&t=/.test(news.nativeUrl));
  assert.strictEqual(news.nativeMime, 'video/mp2t', 'Xtream native playback should prefer the TS endpoint for fast channel starts');
  assert.ok(/^\/api\/iptv\/native\/\d+\?alt=1&cid=[^&]+&t=/.test(news.nativeFallbackUrl));
  assert.strictEqual(news.nativeFallbackMime, 'application/x-mpegURL', 'Xtream native playback should retain HLS as a fallback');

  // EPG now/next decodes the Xtream base64 listings before playback marks the provider busy.
  const epg = await httpJson(srv.port, 'GET', `/api/iptv/epg/${news.idx}`, null, admin);
  assert.strictEqual(epg.json.now.title, 'Evening Bulletin');
  assert.strictEqual(epg.json.next.title, 'Late Show');
  const epgAgain = await httpJson(srv.port, 'GET', `/api/iptv/epg/${news.idx}`, null, admin);
  assert.strictEqual(epgAgain.json.now.title, 'Evening Bulletin');
  assert.strictEqual(epgCalls, 1, 'same channel now/next is cached');
  const guide = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${news.idx}`, null, admin);
  assert.strictEqual(guide.json.channels[0].programmes[0].title, 'Evening Bulletin');
  assert.strictEqual(epgCalls, 1, 'timeline guide reuses the cached channel EPG');
  const cinema = ch.json.channels.find((c) => c.name === 'Cinema');
  const guideFallback = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${cinema.idx}`, null, admin);
  assert.strictEqual(guideFallback.json.channels[0].programmes[0].title, 'Cinema');
  assert.strictEqual(guideFallback.json.channels[0].programmes[0].synthetic, true, 'channels with no provider EPG still show a channel listing');

  const native = await httpRaw(srv.port, news.nativeUrl);
  assert.strictEqual(native.status, 200);
  assert.strictEqual(native.headers.location, undefined, 'native proxy must not expose Xtream credentials in a redirect');
  assert.strictEqual(native.body.toString('utf8'), 'XTREAM-TS');
  assert.deepStrictEqual(liveHits.at(-1).path, '/live/xtuser/xtpass/101.ts');
  assert.ok(liveHits.at(-1).ua.includes('TriboonTV/'), 'native Xtream proxy should use the server-side smart-TV user agent');
  const fallback = await httpRaw(srv.port, news.nativeFallbackUrl);
  assert.strictEqual(fallback.status, 200);
  assert.strictEqual(fallback.headers.location, undefined, 'native fallback proxy must not expose Xtream credentials in a redirect');
  assert.strictEqual(fallback.body.toString('utf8'), '#EXTM3U\n');
  assert.deepStrictEqual(liveHits.at(-1).path, '/live/xtuser/xtpass/101.m3u8');

  // Favorites: toggle on → reflected per user; off again.
  const on = await httpJson(srv.port, 'POST', '/api/iptv/fav', { id: news.id }, admin);
  assert.strictEqual(on.json.on, true);
  const ch2 = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
  assert.strictEqual(ch2.json.channels.find((c) => c.id === news.id).fav, true);
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/iptv/fav', { id: news.id }, admin)).json.on, false);

  // Settings response exposes only the Xtream HOST — never username/password.
  const s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.ok(!JSON.stringify(s.json).includes('xtpass'), 'xtream password never round-trips');
  assert.strictEqual(s.json.iptvMode, 'xtream');

  } finally {
    await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', xtHost: null, xtUser: null, xtPass: null }, admin);
    xt.close();
  }
});

let sharedUser = null; // second account used by the access-control tests below

test('libraries: user allowlist — restricted libraries are invisible to excluded users', async () => {
  const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: { maxResolutionRank: 3 } }, admin);
  const acc = await httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name: 'libuser', password: 'pw1234' });
  assert.strictEqual(acc.status, 200);
  sharedUser = { token: acc.json.token, id: acc.json.user.id };

  const hidden = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'HiddenLib', kind: 'other', users: ['someoneelse'] }, admin);
  const shared = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'SharedLib', kind: 'other', users: [sharedUser.id] }, admin);

  const seen = (await httpJson(srv.port, 'GET', '/api/libraries', null, sharedUser.token)).json.map((l) => l.name);
  assert.ok(!seen.includes('HiddenLib'), 'excluded user cannot see the restricted library');
  assert.ok(seen.includes('SharedLib'), 'allow-listed user sees the shared library');
  const adminSeen = (await httpJson(srv.port, 'GET', '/api/libraries', null, admin)).json.map((l) => l.name);
  assert.ok(adminSeen.includes('HiddenLib'), 'admin always sees everything');
  // Items endpoint is gated too (it mints the local stream/art tokens).
  assert.strictEqual((await httpJson(srv.port, 'GET', `/api/libraries/${hidden.json.id}/items`, null, sharedUser.token)).status, 404);
  assert.strictEqual((await httpJson(srv.port, 'GET', `/api/libraries/${shared.json.id}/items`, null, sharedUser.token)).status, 200);

  await httpJson(srv.port, 'DELETE', `/api/libraries/${hidden.json.id}`, null, admin);
  await httpJson(srv.port, 'DELETE', `/api/libraries/${shared.json.id}`, null, admin);
});

test('users: admin edits a quality cap after the fact; non-admin cannot', async () => {
  const r = await httpJson(srv.port, 'PATCH', `/api/users/${sharedUser.id}`, { policy: { maxResolutionRank: 2 } }, admin);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.policy.maxResolutionRank, 2);
  const fresh = (await httpJson(srv.port, 'GET', '/api/users', null, admin)).json.find((u) => u.id === sharedUser.id);
  assert.strictEqual(fresh.policy.maxResolutionRank, 2, 'persisted');
  assert.strictEqual((await httpJson(srv.port, 'PATCH', `/api/users/${sharedUser.id}`, { policy: { maxResolutionRank: 4 } }, sharedUser.token)).status, 403);
});

test('users: admin resets a password and deletes a user; admin account protected', async () => {
  // Fresh disposable user via invite.
  const inv = (await httpJson(srv.port, 'POST', '/api/invites', {}, admin)).json;
  const joined = (await httpJson(srv.port, 'POST', '/api/invite/accept',
    { token: inv.token, name: 'temp-del', password: 'first-pass' })).json;

  // Admin resets the password (forgot-password path) — old stops working, new logs in.
  const pw = await httpJson(srv.port, 'PATCH', `/api/users/${joined.user.id}`, { password: 'second-pass' }, admin);
  assert.strictEqual(pw.status, 200);
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/login', { name: 'temp-del', password: 'first-pass' })).status, 401, 'old password dead');
  const relog = await httpJson(srv.port, 'POST', '/api/login', { name: 'temp-del', password: 'second-pass' });
  assert.strictEqual(relog.status, 200, 'new password works');

  // Non-admins cannot reset anyone's password; the admin's own cannot be reset this way.
  assert.strictEqual((await httpJson(srv.port, 'PATCH', `/api/users/${joined.user.id}`, { password: 'hax' }, relog.json.token)).status, 403);
  const adminId = (await httpJson(srv.port, 'GET', '/api/users', null, admin)).json.find((u) => u.role === 'admin').id;
  assert.strictEqual((await httpJson(srv.port, 'PATCH', `/api/users/${adminId}`, { password: 'hax-admin' }, admin)).status, 400, 'admin password not resettable');

  // The user's data dies with them: watchlist entry + delete → token dead, login dead, list clean.
  await httpJson(srv.port, 'POST', '/api/watchlist', { key: 'tmdb:movie:550', meta: { title: 'FC' } }, relog.json.token);
  assert.strictEqual((await httpJson(srv.port, 'DELETE', `/api/users/${adminId}`, null, admin)).status, 400, 'admin not deletable');
  const del = await httpJson(srv.port, 'DELETE', `/api/users/${joined.user.id}`, null, admin);
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/watchlist', null, relog.json.token)).status, 401, 'deleted user token rejected immediately');
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/login', { name: 'temp-del', password: 'second-pass' })).status, 401);
  assert.ok(!(await httpJson(srv.port, 'GET', '/api/users', null, admin)).json.some((u) => u.id === joined.user.id), 'gone from the list');
  assert.strictEqual((await httpJson(srv.port, 'DELETE', `/api/users/${joined.user.id}`, null, admin)).status, 404, 'double delete = 404');
});

test('iptv: admin-enforced global hidden groups are stripped for non-admins', async () => {
  const http2 = require('http');
  const m3u = `#EXTM3U
#EXTINF:-1 group-title="News",Newsy
http://upstream.example/n.m3u8
#EXTINF:-1 group-title="Adult",Naughty
http://upstream.example/a.m3u8
`;
  const up = http2.createServer((req, res) => { res.writeHead(200); res.end(m3u); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${up.address().port}/x.m3u` }, admin);
  await httpJson(srv.port, 'POST', '/api/settings', { iptvHiddenGroups: ['Adult'] }, admin);

  const userView = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, sharedUser.token)).json;
  assert.deepStrictEqual(userView.channels.map((c) => c.group), ['News'], 'global-hidden group stripped for users');
  assert.strictEqual(userView.globalHidden, undefined, 'users do not see the global list');
  const adminView = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json;
  assert.strictEqual(adminView.channels.length, 2, 'admin still sees everything');
  assert.deepStrictEqual(adminView.globalHidden, ['Adult']);

  await httpJson(srv.port, 'POST', '/api/settings', { iptvUrl: null, iptvHiddenGroups: [] }, admin);
  up.close();
});

test('iptv: Live TV can be restricted to specific users, like a library', async () => {
  const http2 = require('http');
  const m3u = '#EXTM3U\n#EXTINF:-1 group-title="News",Newsy\nhttp://upstream.example/n.m3u8\n';
  const up = http2.createServer((req, res) => { res.writeHead(200); res.end(m3u); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  await httpJson(srv.port, 'POST', '/api/settings',
    { iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${up.address().port}/x.m3u`, iptvUsers: ['someoneelse'] }, admin);

  const userView = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, sharedUser.token)).json;
  assert.strictEqual(userView.configured, false, 'excluded user sees Live TV as not set up');
  const me = (await httpJson(srv.port, 'GET', '/api/me', null, sharedUser.token)).json;
  assert.strictEqual(me.iptvAllowed, false, 'me endpoint tells the UI to hide Live TV');
  const adminView = (await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin)).json;
  assert.strictEqual(adminView.configured, true, 'admin always has access');

  // Allow-list the user → access restored.
  await httpJson(srv.port, 'POST', '/api/settings', { iptvUsers: [sharedUser.id] }, admin);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/iptv/channels', null, sharedUser.token)).json.configured, true);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, sharedUser.token)).json.iptvAllowed, true);

  await httpJson(srv.port, 'POST', '/api/settings', { iptvUrl: null, iptvUsers: [] }, admin);
  up.close();
});

test('search: releases that are NOT the wanted title are rejected (wrong-movie bug)', async () => {
  const http2 = require('http');
  const ix = http2.createServer((req, res) => {
    res.writeHead(200);
    // An indexer answering with loosely-related junk alongside the real thing.
    res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://x"><channel>
      <item><title>The.Lost.City.2022.1080p.WEB-DL.H.264-GRP</title><enclosure url="http://x/1" length="9000000000"/></item>
      <item><title>The.Lost.City.of.Z.2016.1080p.BluRay.x264-GRP</title><enclosure url="http://x/2" length="9000000000"/></item>
      <item><title>Lost.2004.S01E01.720p.WEB-DL-GRP</title><enclosure url="http://x/3" length="2000000000"/></item>
      <item><title>Totally.Different.Movie.2016.2160p.WEB-DL-GRP</title><enclosure url="http://x/4" length="9000000000"/></item>
    </channel></rss>`);
  });
  await new Promise((r) => ix.listen(0, '127.0.0.1', r));
  const { Pipeline } = require('../server/pipeline');
  const p = new Pipeline({
    pool: () => null, mounts: new Map(),
    verdicts: { get: () => null, set: () => {} },
    indexers: () => [{ name: 'mix', url: `http://127.0.0.1:${ix.address().port}`, apikey: 'x' }],
  });
  const r1 = await p.search({ q: 'The Lost City of Z 2016' });
  assert.deepStrictEqual(r1.candidates.map((c) => c.name), ['The.Lost.City.of.Z.2016.1080p.BluRay.x264-GRP'],
    'only the actual wanted film survives — not the similarly-named 2022 one');
  const r2 = await p.search({ q: 'The Lost City 2022' });
  assert.deepStrictEqual(r2.candidates.map((c) => c.name), ['The.Lost.City.2022.1080p.WEB-DL.H.264-GRP'],
    'the shorter title matches its own film only (year guard keeps Z out)');
  const r3 = await p.search({ q: 'Lost S01E02' });
  assert.strictEqual(r3.candidates.length, 0, 'wrong EPISODE is rejected even when the show matches');
  ix.close();
});

test('search: indexer queries are sanitized + simplified fallback fires on zero results', async () => {
  const http2 = require('http');
  const seenQ = [];
  const ix = http2.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seenQ.push(u.searchParams.get('q'));
    res.writeHead(200); res.end('<?xml version="1.0"?><rss><channel></channel></rss>');
  });
  await new Promise((r) => ix.listen(0, '127.0.0.1', r));
  const { Pipeline } = require('../server/pipeline');
  const p = new Pipeline({
    pool: () => null, mounts: new Map(),
    verdicts: { get: () => null, set: () => {} },
    indexers: () => [{ name: 'qtest', url: `http://127.0.0.1:${ix.address().port}`, apikey: 'x' }],
  });
  await p.search({ q: "Tom Clancy's Jack Ryan: Ghost War" });
  assert.ok(seenQ.includes('Tom Clancys Jack Ryan Ghost War'),
    `apostrophes/colons stripped for scene-name matching (got ${JSON.stringify(seenQ)})`);
  assert.ok(seenQ.includes('Tom Clancys Jack'),
    'zero results → retried with the shortened brand title');
  ix.close();
});

test('settings: max release size — manual caps hide oversized sources; off restores them', async () => {
  const http2 = require('http');
  const ix = http2.createServer((req, res) => {
    res.writeHead(200);
    res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://x"><channel>
      <item><title>Cap.Test.2024.1080p.BluRay.REMUX.AVC-EbP</title><enclosure url="http://x/1" length="60000000000"/></item>
      <item><title>Cap.Test.2024.1080p.WEB-DL.H.264-NTb</title><enclosure url="http://x/2" length="5000000000"/></item>
    </channel></rss>`);
  });
  await new Promise((r) => ix.listen(0, '127.0.0.1', r));
  const prevIx = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.indexers;
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'cap', url: `http://127.0.0.1:${ix.address().port}`, apikey: 'x' }],
    sizeCapMode: 'manual', sizeCap1080Gb: 20, sizeCap4kGb: 40,
  }, admin);

  const stg = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json;
  assert.strictEqual(stg.sizeCapMode, 'manual');
  assert.deepStrictEqual(stg.effectiveSizeCaps, { maxSizeGb4k: 40, maxSizeGb1080: 20 }, 'effective caps reported to the UI');

  const capped = (await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Cap Test 2024'), null, admin)).json;
  assert.deepStrictEqual(capped.candidates.map((c) => c.name), ['Cap.Test.2024.1080p.WEB-DL.H.264-NTb'],
    '60GB remux above the 20GB cap is hidden from Sources entirely');

  await httpJson(srv.port, 'POST', '/api/settings', { sizeCapMode: 'off' }, admin);
  const open = (await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Cap Test 2024'), null, admin)).json;
  assert.strictEqual(open.candidates.length, 2, 'cap off → both releases show again');

  // restore: auto mode + whatever indexers were configured before this test
  await httpJson(srv.port, 'POST', '/api/settings', { sizeCapMode: 'auto', indexers: prevIx }, admin);
  ix.close();
});

test('search: Sources includes largest allowed releases beyond the best-score window', async () => {
  const http2 = require('http');
  const small = Array.from({ length: 300 }, (_, i) =>
    `<item><title>Big.Visible.2024.1080p.WEB-DL.H.264-NTb.${String(i).padStart(3, '0')}</title><enclosure url="http://x/s${i}" length="${5000000000 + i}"/></item>`);
  const ix = http2.createServer((req, res) => {
    res.writeHead(200);
    res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://x"><channel>
      ${small.join('\n')}
      <item><title>Big.Visible.2024.1080p.BluRay.REMUX.AVC-FraMeSToR</title><enclosure url="http://x/big" length="49000000000"/></item>
      <item><title>Big.Visible.2024.1080p.BluRay.REMUX.AVC-EbP</title><enclosure url="http://x/over" length="51000000000"/></item>
    </channel></rss>`);
  });
  await new Promise((r) => ix.listen(0, '127.0.0.1', r));
  const prevIx = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.indexers;
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'big-visible', url: `http://127.0.0.1:${ix.address().port}`, apikey: 'x' }],
    sizeCapMode: 'manual', sizeCap1080Gb: 50, sizeCap4kGb: 80,
  }, admin);

  const r = (await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Big Visible 2024'), null, admin)).json;
  const names = r.candidates.map((c) => c.name);
  assert.ok(names.includes('Big.Visible.2024.1080p.BluRay.REMUX.AVC-FraMeSToR'),
    '49GB release under the 50GB cap stays visible in Sources even if size shaping ranks it low');
  assert.ok(!names.includes('Big.Visible.2024.1080p.BluRay.REMUX.AVC-EbP'),
    '51GB release over the 50GB cap is still hidden');
  assert.ok(r.candidates.length > 250, 'Sources response includes largest allowed rows in addition to the best rows');

  await httpJson(srv.port, 'POST', '/api/settings', { sizeCapMode: 'auto', indexers: prevIx }, admin);
  ix.close();
});

test('search: quality policy ranks 1080p and 4K consistently and returns stable pick keys', async () => {
  const http2 = require('http');
  const ix = http2.createServer((req, res) => {
    res.writeHead(200);
    res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://x"><channel>
      <item><title>Quality.Policy.2024.2160p.WEB-DL.HEVC-NTb</title><enclosure url="http://x/quality-4k" length="16000000000"/></item>
      <item><title>Quality.Policy.2024.1080p.WEB-DL.H.264-NTb</title><enclosure url="http://x/quality-1080p" length="6000000000"/></item>
    </channel></rss>`);
  });
  await new Promise((r) => ix.listen(0, '127.0.0.1', r));
  const prevIx = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.indexers;
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'quality', url: `http://127.0.0.1:${ix.address().port}`, apikey: 'x' }],
    sizeCapMode: 'off',
  }, admin);

  const base = '/api/search?q=' + encodeURIComponent('Quality Policy 2024');
  const hd = (await httpJson(srv.port, 'GET', base + '&maxResolutionRank=3&preferResolutionRank=3', null, admin)).json;
  assert.ok(hd.candidates[0].name.includes('1080p'), '1080p preference should put the 1080p source first');
  assert.ok(hd.candidates.every((c) => /^[a-f0-9]{16}$/.test(c.pickKey)), 'Sources drawer gets stable opaque pick keys');

  const uhd = (await httpJson(srv.port, 'GET', base + '&maxResolutionRank=4&preferResolutionRank=4', null, admin)).json;
  assert.ok(uhd.candidates[0].name.includes('2160p'), '4K preference should put the 4K source first');
  assert.ok(uhd.candidates.find((c) => c.name.includes('1080p')).score < -5000,
    '4K preference should not silently keep 1080p as a playable fallback');
  assert.notStrictEqual(uhd.candidates[0].pickKey, hd.candidates.find((c) => c.name.includes('1080p')).pickKey,
    '1080p and 4K rows remain distinct even when the names are similar');

  await httpJson(srv.port, 'POST', '/api/settings', { sizeCapMode: 'auto', indexers: prevIx }, admin);
  ix.close();
});

test('admin: connection tests for saved providers/indexers; daily API limit gates the fan-out', async () => {
  // Provider 0 is the env-bootstrapped mock NNTP — test must succeed with a latency figure.
  const okP = (await httpJson(srv.port, 'POST', '/api/test/provider', { index: 0 }, admin)).json;
  assert.strictEqual(okP.ok, true, JSON.stringify(okP));
  assert.ok(Number.isInteger(okP.ms) && okP.ms >= 0, 'reports connect+auth latency');
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/test/provider', { index: 9 }, admin)).status, 400);

  if (ixServer) ixServer.close(); // teardown only closes the LAST one — don't leak the first
  const ixPort = await startIndexer();
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'limited', url: `http://127.0.0.1:${ixPort}`, apikey: 'k', apiDayLimit: 2, grabDayLimit: 50 }],
  }, admin);

  // Indexer test performs a real 1-query search (counted: 1/2).
  const okI = (await httpJson(srv.port, 'POST', '/api/test/indexer', { index: 0 }, admin)).json;
  assert.strictEqual(okI.ok, true, JSON.stringify(okI));
  assert.strictEqual(okI.items, 1, 'test search parsed the indexer response');

  // A real search consumes the second hit (2/2) and usage is visible in settings.
  const s1 = await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Sec Test 2024'), null, admin);
  assert.strictEqual(s1.status, 200);
  const stg = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json;
  assert.strictEqual(stg.indexers[0].usage.api, 2, 'test + search both counted');
  assert.strictEqual(stg.indexers[0].apiDayLimit, 2);

  // Limit reached → the indexer drops out; with no indexer left the API says WHY.
  const s2 = await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Sec Test 2024 encore'), null, admin);
  assert.strictEqual(s2.status, 429, JSON.stringify(s2.json));
  assert.match(s2.json.error, /daily API limit/);

  // Cleanup: unlimited indexer back for any later test.
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  }, admin);
});

test('settings: edit provider/indexer in place — blank secret keeps the saved one', async () => {
  // Indexer: rename + change URL/limits with a BLANK apikey → key must survive the edit.
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'orig', url: 'http://a.example', apikey: 'sekrit', apiDayLimit: 5 }],
  }, admin);
  await httpJson(srv.port, 'POST', '/api/settings', {
    editIndexer: { index: 0, name: 'renamed', url: 'http://b.example', apikey: '', apiDayLimit: 9, grabDayLimit: 3 },
  }, admin);
  const ix = srv.settings.get().indexers[0];
  assert.strictEqual(ix.name, 'renamed');
  assert.strictEqual(ix.url, 'http://b.example');
  assert.strictEqual(ix.apikey, 'sekrit', 'blank apikey keeps the saved secret');
  assert.strictEqual(ix.apiDayLimit, 9);
  assert.strictEqual(ix.grabDayLimit, 3);

  // Provider: change host/connections with a BLANK password → password must survive.
  const idx = srv.settings.get().providers.length; // earlier tests may have left providers behind
  await httpJson(srv.port, 'POST', '/api/settings', {
    addProvider: { host: 'h1.example', port: 563, user: 'u', pass: 'pw', connections: 8 },
  }, admin);
  await httpJson(srv.port, 'POST', '/api/settings', {
    editProvider: { index: idx, host: 'h2.example', pass: '', connections: 12 },
  }, admin);
  const p = srv.settings.get().providers[idx];
  assert.strictEqual(p.host, 'h2.example');
  assert.strictEqual(p.pass, 'pw', 'blank password keeps the saved secret');
  assert.strictEqual(p.connections, 12);
  await httpJson(srv.port, 'POST', '/api/settings', { removeProvider: idx }, admin); // leave others untouched
});

test('subtitles: Wyzie search→file→VTT served per mount (and 503 without a key)', async () => {
  const http2 = require('http');
  let osPort;
  let searchCalls = 0;
  const subtitleDownloads = [];
  const osMock = http2.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/search') {
      searchCalls++;
      // Mirrors the real API: key required as a query param, id = TMDB id.
      if (u.searchParams.get('key') !== 'test-key') { res.writeHead(401); return res.end('{}'); }
      if (u.searchParams.get('id') !== '4242') { res.writeHead(200); return res.end('[]'); }
      assert.strictEqual(u.searchParams.get('season'), '1',
        'episode subtitle searches must preserve season even when the mounted filename is opaque');
      assert.strictEqual(u.searchParams.get('episode'), '3',
        'episode subtitle searches must preserve episode even when the mounted filename is opaque');
      assert.strictEqual(u.searchParams.get('source'), 'all', 'Wyzie searches all enabled sources');
      assert.strictEqual(u.searchParams.get('format'), 'srt,vtt', 'browser-renderable subtitle formats only');
      if (searchCalls === 1) { res.writeHead(502); return res.end(JSON.stringify({ message: 'temporary scrape failure' })); }
      if (u.searchParams.get('language') === 'fr' && u.searchParams.get('refresh') !== 'true') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('[]');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([
        { id: 1, url: `http://127.0.0.1:${osPort}/file.srt`, format: 'srt', display: 'Sec.2024.WEB-DL', language: 'en' },
        { id: 2, url: `http://127.0.0.1:${osPort}/extended.srt`, format: 'srt', display: 'Sec.2024.Extended.Edition.WEB-DL', language: 'en' },
      ]));
    }
    if (u.pathname === '/file.srt') {
      subtitleDownloads.push({ path: u.pathname, headerKey: req.headers['api-key'], queryKey: u.searchParams.get('key') });
      if (req.headers['api-key'] !== 'test-key' && u.searchParams.get('key') !== 'test-key') {
        res.writeHead(401);
        return res.end('missing subtitle file key');
      }
      res.writeHead(200);
      return res.end('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello usenet\r\n');
    }
    if (u.pathname === '/extended.srt') {
      subtitleDownloads.push({ path: u.pathname, headerKey: req.headers['api-key'], queryKey: u.searchParams.get('key') });
      if (req.headers['api-key'] !== 'test-key' && u.searchParams.get('key') !== 'test-key') {
        res.writeHead(401);
        return res.end('missing subtitle file key');
      }
      res.writeHead(200);
      return res.end('1\r\n00:00:03,000 --> 00:00:04,500\r\nExtended cut line\r\n');
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => osMock.listen(0, '127.0.0.1', () => { osPort = osMock.address().port; r(); }));

  try {
  if (ixServer && ixServer.listening) await new Promise((r) => ixServer.close(() => r()));
  const ixPort = await startIndexer();
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }], openSubsKey: null,
  }, admin);
  const play = (await httpJson(srv.port, 'POST', '/api/play', { q: 'Sec Test 2024' }, admin)).json;
  assert.ok(play.id, JSON.stringify(play));
  srv.mounts.get(play.id)._subQuery = 'Sec Test 2024 S01E03';

  // No key configured → honest 503, not a hang or a fake empty file.
  const no = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=en&tmdb=4242&t=${play.streamToken}`);
  assert.strictEqual(no.status, 503);

  process.env.WYZIE_BASE = `http://127.0.0.1:${osPort}`;
  await httpJson(srv.port, 'POST', '/api/settings', { openSubsKey: 'test-key' }, admin);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/server')).json.opensubs, true,
    'Wyzie subtitles are enabled by the key alone');
  // No TMDB id (non-catalog play) → clear 502, not a hang.
  const noId = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=en&t=${play.streamToken}`);
  assert.strictEqual(noId.status, 502, 'no TMDB id fails with guidance');
  assert.match(noId.body.toString(), /TMDB or IMDb id/);
  const sub = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=en&tmdb=4242&t=${play.streamToken}`);
  assert.strictEqual(sub.status, 200, sub.body.toString());
  assert.strictEqual(searchCalls, 2, 'first transient Wyzie 502 was retried once and recovered');
  const vtt = sub.body.toString('utf8');
  assert.ok(vtt.startsWith('WEBVTT'), 'served as WebVTT');
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500/, 'SRT timestamps converted');
  assert.match(vtt, /Hello usenet/);
  assert.ok(subtitleDownloads.some((d) => d.path === '/file.srt' && (d.headerKey === 'test-key' || d.queryKey === 'test-key')),
    'subtitle file download carries the Wyzie key, not just the search request');
  const beforeShift = searchCalls;
  const shiftedSub = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=en&tmdb=4242&shift=0.5&t=${play.streamToken}`);
  assert.strictEqual(shiftedSub.status, 200, shiftedSub.body.toString());
  assert.match(shiftedSub.body.toString('utf8'), /00:00:01\.500 --> 00:00:03\.000/, 'subtitle sync can shift cached VTT without re-downloading it');
  assert.strictEqual(searchCalls, beforeShift, 'subtitle sync used the cached subtitle body');
  const versions = await httpJson(srv.port, 'GET', `/api/ossubs/${play.id}?lang=en&tmdb=4242&list=1&t=${play.streamToken}`, null, admin);
  assert.strictEqual(versions.status, 200, JSON.stringify(versions.json));
  assert.ok((versions.json.variants || []).some((v) => v.id === '2' && /Extended/i.test(v.label)),
    'subtitle versions expose alternate cuts/releases');
  const pickedVersion = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=en&tmdb=4242&variant=2&t=${play.streamToken}`);
  assert.strictEqual(pickedVersion.status, 200, pickedVersion.body.toString());
  assert.match(pickedVersion.body.toString('utf8'), /Extended cut line/, 'selected subtitle version downloads its own file');
  assert.ok(subtitleDownloads.some((d) => d.path === '/extended.srt' && (d.headerKey === 'test-key' || d.queryKey === 'test-key')),
    'manual subtitle version downloads are authenticated too');
  const afterVersions = searchCalls;
  const cached = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=en&tmdb=4242&t=${play.streamToken}`);
  assert.strictEqual(cached.status, 200, cached.body.toString());
  assert.strictEqual(searchCalls, afterVersions, 'second subtitle request used the per-mount cache');
  const beforeConcurrent = searchCalls;
  const [es1, es2] = await Promise.all([
    httpRaw(srv.port, `/api/ossubs/${play.id}?lang=es&tmdb=4242&t=${play.streamToken}`),
    httpRaw(srv.port, `/api/ossubs/${play.id}?lang=es&tmdb=4242&t=${play.streamToken}`),
  ]);
  assert.strictEqual(es1.status, 200, es1.body.toString());
  assert.strictEqual(es2.status, 200, es2.body.toString());
  assert.strictEqual(searchCalls, beforeConcurrent + 1, 'concurrent subtitle requests share one Wyzie lookup');
  const beforeRefresh = searchCalls;
  const fr = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=fr&tmdb=4242&t=${play.streamToken}`);
  assert.strictEqual(fr.status, 200, fr.body.toString());
  assert.strictEqual(searchCalls, beforeRefresh + 2, 'empty Wyzie search gets one refresh fallback');
  const missing = await httpJson(srv.port, 'GET', `/api/ossubs/${play.id}?lang=en&tmdb=999999&list=1&t=${play.streamToken}`, null, admin);
  assert.strictEqual(missing.status, 404, JSON.stringify(missing.json));
  assert.strictEqual(missing.json.code, 'no_subtitles',
    'Wyzie no-results should be a clean title-level miss, not a generic server failure');

  } finally {
    delete process.env.WYZIE_BASE;
    await httpJson(srv.port, 'POST', '/api/settings', { openSubsKey: null }, admin).catch(() => {});
    await new Promise((r) => osMock.close(r));
  }
});

test('settings: custom scoring — trusted-group override flips the auto-pick via the real API', async () => {
  const http2 = require('http');
  const ix = http2.createServer((req, res) => {
    res.writeHead(200);
    res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://x"><channel>
      <item><title>Sc.Test.2024.1080p.WEB-DL.H.264-FLUX</title><enclosure url="http://x/1" length="6000000000"/></item>
      <item><title>Sc.Test.2024.1080p.WEB-DL.H.264-UNDERDOG</title><enclosure url="http://x/2" length="6000000000"/></item>
    </channel></rss>`);
  });
  await new Promise((r) => ix.listen(0, '127.0.0.1', r));
  const prevIx = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.indexers;
  await httpJson(srv.port, 'POST', '/api/settings', {
    indexers: [{ name: 'sc', url: `http://127.0.0.1:${ix.address().port}`, apikey: 'x' }],
  }, admin);

  const def = (await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Sc Test 2024'), null, admin)).json;
  assert.ok(def.candidates[0].name.endsWith('-FLUX'), 'built-in default: trusted FLUX leads');

  await httpJson(srv.port, 'POST', '/api/settings', {
    scoringGroupsTrusted: ['UNDERDOG'], scoringGroupsAvoid: ['FLUX'],
    scoringKeywords: [{ term: 'WEB-DL', score: 10 }],
  }, admin);
  const stg = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json;
  assert.deepStrictEqual(stg.scoringGroupsTrusted, ['UNDERDOG'], 'settings round-trip');
  assert.deepStrictEqual(stg.scoringKeywords, [{ term: 'WEB-DL', score: 10 }]);

  const custom = (await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Sc Test 2024'), null, admin)).json;
  assert.ok(custom.candidates[0].name.endsWith('-UNDERDOG'), 'admin override flips the auto-pick');

  // Reset to defaults restores the built-in ranking; restore prior indexers for later tests.
  await httpJson(srv.port, 'POST', '/api/settings', {
    scoringGroupsTrusted: [], scoringGroupsAvoid: [], scoringKeywords: [],
  }, admin);
  const back = (await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Sc Test 2024'), null, admin)).json;
  assert.ok(back.candidates[0].name.endsWith('-FLUX'), 'reset returns to the recommended defaults');
  await httpJson(srv.port, 'POST', '/api/settings', { indexers: prevIx }, admin);
  ix.close();
});

test('search: hyphenated titles — query loses the hyphen, verification still matches the release', async () => {
  // Real-world failure: "Spider-Noir 2026" found NOTHING. The hyphen reached the indexer
  // (some return zero for it) and, worse, title verification fused the words into
  // "spidernoir", which can never match "Spider-Noir.S01E01…" (punctuation → spaces).
  const http2 = require('http');
  const seenQ = [];
  const ix = http2.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seenQ.push(u.searchParams.get('q'));
    res.writeHead(200);
    res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://x"><channel>
      <item><title>Spider-Noir.S01E01.Step.Into.My.Office.2160p.AMZN.WEB-DL-NTb</title><enclosure url="http://x/1" length="9000000000"/></item>
      <item><title>Spider.Noir.S01E01.1080p.WEB.H264-SuccessfulCrab</title><enclosure url="http://x/2" length="4000000000"/></item>
      <item><title>Spider-Man.2002.1080p.BluRay.x264-GRP</title><enclosure url="http://x/3" length="9000000000"/></item>
    </channel></rss>`);
  });
  await new Promise((r) => ix.listen(0, '127.0.0.1', r));
  const { Pipeline } = require('../server/pipeline');
  const p = new Pipeline({
    pool: () => null, mounts: new Map(),
    verdicts: { get: () => null, set: () => {} },
    indexers: () => [{ name: 'hy', url: `http://127.0.0.1:${ix.address().port}`, apikey: 'x' }],
  });
  const r = await p.search({ q: 'Spider-Noir S01E01' });
  assert.ok(seenQ.includes('Spider Noir S01E01'),
    `hyphen split to a space in the indexer query (got ${JSON.stringify(seenQ)})`);
  assert.deepStrictEqual(r.candidates.map((c) => c.name).sort(), [
    'Spider-Noir.S01E01.Step.Into.My.Office.2160p.AMZN.WEB-DL-NTb',
    'Spider.Noir.S01E01.1080p.WEB.H264-SuccessfulCrab',
  ].sort(), 'both hyphen and dot spellings of the release verify; Spider-Man does not');
  ix.close();
});

test('search: source drawer forwards TVDB season and episode identifiers to indexers', async () => {
  const http2 = require('http');
  let seen;
  const ix = http2.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen = Object.fromEntries(u.searchParams.entries());
    res.writeHead(200);
    res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://x"><channel>
      <item><title>Route.Show.S01E02.1080p.WEB-DL-GRP</title><enclosure url="http://x/route" length="4000000000"/></item>
    </channel></rss>`);
  });
  await new Promise((r) => ix.listen(0, '127.0.0.1', r));
  const prevIx = (await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.indexers;
  try {
    await httpJson(srv.port, 'POST', '/api/settings', {
      indexers: [{ name: 'route', url: `http://127.0.0.1:${ix.address().port}`, apikey: 'x' }],
    }, admin);
    const r = await httpJson(srv.port, 'GET', '/api/search?q=' + encodeURIComponent('Route Show S01E02') + '&tvdbid=777&season=1&ep=2', null, admin);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.candidates[0].name, 'Route.Show.S01E02.1080p.WEB-DL-GRP');
    assert.strictEqual(seen.t, 'tvsearch');
    assert.strictEqual(seen.tvdbid, '777');
    assert.strictEqual(seen.season, '1');
    assert.strictEqual(seen.ep, '2');
  } finally {
    await httpJson(srv.port, 'POST', '/api/settings', { indexers: prevIx }, admin);
    ix.close();
  }
});

test('iptv: per-user hidden categories round-trip via /api/iptv/groups', async () => {
  const r = await httpJson(srv.port, 'POST', '/api/iptv/groups', { hidden: ['Shopping', 'Adult'] }, admin);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.hidden, ['Shopping', 'Adult']);
  // Echoed back with the channel list (no playlist configured here → still returns prefs shape on a configured server).
  const bad = await httpJson(srv.port, 'POST', '/api/iptv/groups', { hidden: 'nope' }, admin);
  assert.strictEqual(bad.status, 400, 'hidden must be an array');
  await httpJson(srv.port, 'POST', '/api/iptv/groups', { hidden: [] }, admin); // cleanup
});

test('iptv: XMLTV guide parsed for now/next on M3U channels', async () => {
  const http2 = require('http');
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const t0 = new Date(Date.now() - 15 * 60000), t1 = new Date(Date.now() + 15 * 60000), t2 = new Date(Date.now() + 45 * 60000);
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="news1.x" group-title="News",News One
http://upstream.example/news1.m3u8
#EXTINF:-1 group-title="News",UK: News Two HD [1080p]
http://upstream.example/news2.m3u8
`;
  const xmltv = `<?xml version="1.0"?><tv>
<channel id="news2.x"><display-name>News Two</display-name></channel>
<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="news1.x"><title>Morning Desk</title></programme>
<programme start="${stamp(t1)}" stop="${stamp(t2)}" channel="news1.x"><title>Midday Report</title></programme>
<programme start="${stamp(t0)}" stop="${stamp(t1)}" channel="news2.x"><title>Second Channel Show</title></programme>
</tv>`;
  const up = http2.createServer((req, res) => {
    res.writeHead(200);
    res.end(req.url.includes('guide') ? xmltv : m3u);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${up.address().port}`;
  await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: `${base}/list.m3u`, epgUrl: `${base}/guide.xml` }, admin);

  const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
  assert.strictEqual(ch.json.epg, true, 'XMLTV url advertises a guide');
  const epg = await httpJson(srv.port, 'GET', `/api/iptv/epg/${ch.json.channels[0].idx}`, null, admin);
  assert.strictEqual(epg.json.now.title, 'Morning Desk');
  assert.strictEqual(epg.json.next.title, 'Midday Report');

  // Channel WITHOUT a tvg-id still gets guide data via normalized display-name matching
  // ("UK: News Two HD [1080p]" ≈ "News Two").
  const two = ch.json.channels.find((c) => /News Two/.test(c.name));
  const epg2 = await httpJson(srv.port, 'GET', `/api/iptv/epg/${two.idx}`, null, admin);
  assert.strictEqual(epg2.json.now && epg2.json.now.title, 'Second Channel Show', 'name-matched guide');

  await httpJson(srv.port, 'POST', '/api/settings', { iptvUrl: null, epgUrl: null }, admin);
  up.close();
});

test('iptv: timeline guide returns a full lazy page and falls back to channel listings', async () => {
  const http2 = require('http');
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 36; i++) {
    lines.push(`#EXTINF:-1 group-title="Bulk",Bulk Channel ${i} [1080p]`);
    lines.push(`http://upstream.example/bulk${i}.m3u8`);
  }
  const m3uSrv = http2.createServer((req, res) => { res.writeHead(200); res.end(lines.join('\n')); });
  await new Promise((r) => m3uSrv.listen(0, '127.0.0.1', r));
  const m3uUrl = `http://127.0.0.1:${m3uSrv.address().port}/bulk.m3u`;
  await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', iptvUrl: m3uUrl, epgUrl: null }, admin);

  const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
  const ids = ch.json.channels.slice(0, 36).map((c) => c.idx).join(',');
  const guide = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${ids}`, null, admin);
  assert.strictEqual(guide.json.channels.length, 36, 'server must not truncate the UI guide batch at 24');
  assert.strictEqual(guide.json.channels[35].programmes[0].title, 'Bulk Channel 36');
  assert.strictEqual(guide.json.channels[35].programmes[0].synthetic, true);

  await httpJson(srv.port, 'POST', '/api/settings', { iptvUrl: null, epgUrl: null }, admin);
  m3uSrv.close();
});

test('iptv: timeline guide caps Xtream EPG fan-out so big categories stay responsive', async () => {
  const http2 = require('http');
  let active = 0, maxActive = 0;
  const xt = http2.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    res.setHeader('content-type', 'application/json');
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'Bulk' }]));
    if (action === 'get_live_streams') {
      return res.end(JSON.stringify(Array.from({ length: 24 }, (_, i) => ({
        stream_id: 2000 + i, name: `Bulk ${i + 1}`, category_id: '1',
      }))));
    }
    if (action === 'get_short_epg') {
      active++; maxActive = Math.max(maxActive, active);
      return setTimeout(() => {
        active--;
        res.end(JSON.stringify({ epg_listings: [] }));
      }, 25);
    }
    res.end('[]');
  });
  await new Promise((r) => xt.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${xt.address().port}`;
  await httpJson(srv.port, 'POST', '/api/settings',
    { iptvMode: 'xtream', xtHost: host, xtUser: 'xtuser', xtPass: 'xtpass', epgUrl: null }, admin);

  const ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
  const ids = ch.json.channels.map((c) => c.idx).join(',');
  const guide = await httpJson(srv.port, 'GET', `/api/iptv/guide?chs=${ids}`, null, admin);
  assert.strictEqual(guide.json.channels.length, 24);
  assert.ok(maxActive <= 8, `expected bounded EPG fan-out, saw ${maxActive}`);
  assert.strictEqual(guide.json.channels[23].programmes[0].title, 'Bulk 24', 'fallback listings still fill the guide');

  await httpJson(srv.port, 'POST', '/api/settings', { iptvMode: 'm3u', xtHost: null, xtUser: null, xtPass: null }, admin);
  xt.close();
});

test('profiles: edit/delete require the ACCOUNT password; deletion removes the watch history', async () => {
  const pr = (await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'Temp', level: 2 }, admin)).json;
  assert.ok(pr.id);

  // Wrong password → rejected (a kid can't rename or self-promote their own profile).
  const bad = await httpJson(srv.port, 'PATCH', `/api/me/profiles/${pr.id}`, { password: 'nope', level: 3 }, admin);
  assert.strictEqual(bad.status, 400);

  const ed = (await httpJson(srv.port, 'PATCH', `/api/me/profiles/${pr.id}`,
    { password: 'hunter22', name: 'Kiddo', level: 0 }, admin)).json;
  assert.strictEqual(ed.name, 'Kiddo');
  assert.strictEqual(ed.level, 0);
  assert.strictEqual(ed.kid, true);

  // Watch state lands under account+profile; removal drops a single entry.
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:42', position: 100, duration: 1000, profile: pr.id, meta: { title: 'X' } }, admin);
  let w = (await httpJson(srv.port, 'GET', `/api/watch?profile=${pr.id}`, null, admin)).json;
  assert.strictEqual(w.length, 1);
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:42', remove: true, profile: pr.id }, admin);
  w = (await httpJson(srv.port, 'GET', `/api/watch?profile=${pr.id}`, null, admin)).json;
  assert.strictEqual(w.length, 0, 'remove drops the Continue Watching entry');

  // Delete needs the password too, and wipes the profile's remaining watch history.
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:43', position: 50, duration: 1000, profile: pr.id, meta: {} }, admin);
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${pr.id}/delete`, { password: 'nope' }, admin)).status, 400);
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${pr.id}/delete`, { password: 'hunter22' }, admin)).status, 200);
  const me = (await httpJson(srv.port, 'GET', '/api/me', null, admin)).json;
  assert.ok(!(me.profiles || []).some((p) => p.id === pr.id), 'profile gone');
  w = (await httpJson(srv.port, 'GET', `/api/watch?profile=${pr.id}`, null, admin)).json;
  assert.strictEqual(w.length, 0, 'orphaned watch history wiped with the profile');
});

test('profiles: PIN set/change/remove requires the ACCOUNT password', async () => {
  const made = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'PinMgmt', level: 0 }, admin);
  const id = made.json.id;
  assert.strictEqual(made.json.locked, false);
  // Wrong account password → rejected (a kid with the session can't lift the lock).
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${id}/pin`, { password: 'wrong', pin: '1234' }, admin)).status, 400);
  // Set with the real password.
  const set = await httpJson(srv.port, 'POST', `/api/me/profiles/${id}/pin`, { password: 'hunter22', pin: '1234' }, admin);
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.json.locked, true);
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${id}/verify`, { pin: '1234' }, admin)).json.ok, true);
  // Remove (pin: null) — profile unlocks.
  const off = await httpJson(srv.port, 'POST', `/api/me/profiles/${id}/pin`, { password: 'hunter22', pin: null }, admin);
  assert.strictEqual(off.json.locked, false);
});

test('security headers: CSP on the app shell, nosniff everywhere', async () => {
  const page = await httpRaw(srv.port, '/');
  assert.strictEqual(page.status, 200);
  const csp = String(page.headers['content-security-policy'] || '');
  assert.ok(csp.includes("object-src 'none'"), 'CSP present and blocks plugins');
  assert.ok(csp.includes("frame-src https://www.youtube.com"), 'trailer iframe still allowed');
  assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');
  const api = await httpJson(srv.port, 'GET', '/api/server');
  assert.strictEqual(api.headers['x-content-type-options'], 'nosniff');
});

test('rate limit: repeated failed logins for one account lock out with 429', async () => {
  let last;
  for (let i = 0; i < 11; i++) {
    last = await httpJson(srv.port, 'POST', '/api/login', { name: 'bruteforce-target', password: 'wrong' + i });
  }
  assert.strictEqual(last.status, 429, 'locked after the window is exhausted');
  assert.ok(last.headers['retry-after'], 'tells the client when to retry');
  // Other accounts use a different limiter key — unaffected:
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/login', { name: 'someone-else', password: 'x' })).status, 401);
});

test('rate limit: a 4-digit profile PIN cannot be brute-forced', async () => {
  const made = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'PinKid', level: 0, pin: '4321' }, admin);
  assert.strictEqual(made.status, 200);
  let last;
  for (let i = 0; i < 6; i++) {
    last = await httpJson(srv.port, 'POST', `/api/me/profiles/${made.json.id}/verify`, { pin: String(1000 + i) }, admin);
  }
  assert.strictEqual(last.status, 429, 'locked after 5 attempts — 10,000-PIN sweep is impossible');
});

test('stream tokens are bound to one resource: a leaked URL cannot stream anything else', async () => {
  const os2 = require('os');
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), 'triboon-bind-'));
  fs.writeFileSync(path.join(dir, 'First (2020).mp4'), 'FIRST-FILE-BYTES');
  fs.writeFileSync(path.join(dir, 'Second (2021).mp4'), 'SECOND-FILE-BYTES');
  const lib = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'BindLib', kind: 'other', path: dir }, admin);
  await runScan(lib.json.id);
  const items = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items;
  assert.strictEqual(items.length, 2);

  // The bound URL streams its own item…
  const ok = await httpRaw(srv.port, items[0].streamUrl);
  assert.strictEqual(ok.status, 200);
  // …but its token must NOT stream a different item (cross-resource reuse).
  const t0 = /[?&]t=([^&]+)/.exec(items[0].streamUrl)[1];
  const base1 = items[1].streamUrl.split('?')[0];
  assert.strictEqual((await httpRaw(srv.port, `${base1}?t=${t0}`)).status, 401, 'token rejected on another resource');
  // A full session token still works everywhere (it is not a leaked-URL artifact).
  assert.strictEqual((await httpRaw(srv.port, base1, { token: admin })).status, 200);
});

test('music: yt-dlp keeps search flat but allows playlist/library enumeration', () => {
  const ytmusic = require('../server/ytmusic');
  assert.ok(ytmusic._searchUrl('daft punk').startsWith('https://music.youtube.com/search?'), 'search stays on YouTube Music');
  assert.strictEqual(ytmusic._optsNoPlaylist(['ytsearch10:test']), true, 'generic YouTube search should not expand playlists');
  assert.strictEqual(ytmusic._optsNoPlaylist([ytmusic._searchUrl('test')]), false,
    'YouTube Music search must be allowed to enumerate music results');
  assert.strictEqual(ytmusic._optsNoPlaylist(['https://music.youtube.com/library/playlists']), false,
    'linked library lookup must be allowed to enumerate playlists');
  assert.strictEqual(ytmusic._optsNoPlaylist(['https://www.youtube.com/feed/playlists']), false,
    'fallback playlist feed must be allowed to enumerate playlists');
  assert.strictEqual(ytmusic._optsNoPlaylist(['--playlist-items', '1:50', 'https://music.youtube.com/playlist?list=LM']), false,
    'playlist track loading must be allowed to enumerate tracks');
  assert.ok(ytmusic._ytArgs(['ytsearch1:test'], null).argv.includes('--no-playlist'));
  assert.ok(!ytmusic._ytArgs(['https://music.youtube.com/library/playlists'], null, { noPlaylist: false }).argv.includes('--no-playlist'));
  assert.strictEqual(ytmusic._playlistItemsRange(0, 50), '1:50');
  assert.strictEqual(ytmusic._playlistItemsRange(50, 51), '51:101');
});

test('music: playlist parsers turn null yt-dlp JSON into useful link errors', () => {
  const ytmusic = require('../server/ytmusic');
  assert.throws(() => ytmusic._parseListPlaylists('null'), /re-export cookies/i);
  assert.throws(() => ytmusic._parsePlaylistTracks('null'), /re-export cookies/i);
  assert.deepStrictEqual(ytmusic._parseListPlaylists('{"entries":null}'), []);
  assert.deepStrictEqual(ytmusic._parseListPlaylists(JSON.stringify({ entries: [
    { id: 'WL', title: 'Watch later' },
    { id: 'LL', title: 'Liked videos' },
    { url: 'https://www.youtube.com/playlist?list=PL123', title: 'Road trip', playlist_count: 12 },
  ] })), [{ id: 'PL123', title: 'Road trip', count: 12 }]);
  assert.deepStrictEqual(ytmusic._parsePlaylistTracks('{"title":"Mine","entries":null}'), {
    title: 'Mine',
    tracks: [],
  });
});

test('music: auth + token scope binding; honest 503 when yt-dlp is absent', async () => {
  const ytmusic = require('../server/ytmusic');
  const present = !!ytmusic.detectYtdlp(); // CI has no yt-dlp; a dev box may.

  // A music stream token is bound to ONE track id — a leaked URL can't fetch another track.
  const tA = srv.auth.streamToken(srv.auth._users().list[0].id, 'music:AAAAAAAAAAA');
  assert.strictEqual((await httpRaw(srv.port, `/api/music/stream/BBBBBBBBBBB?t=${tA}`)).status, 401,
    'music token for track A rejected on track B');
  assert.strictEqual((await httpRaw(srv.port, '/api/music/stream/CCCCCCCCCCC', { token: admin })).status, 401,
    'session tokens cannot directly stream arbitrary YouTube ids');
  // Malformed ids never reach the handler (the route only matches 11-char ids).
  assert.strictEqual((await httpRaw(srv.port, `/api/music/stream/short?t=${tA}`)).status, 404);

  const s = await httpJson(srv.port, 'GET', '/api/music/search?q=test', null, admin);
  if (present) {
    assert.strictEqual(s.status, 200, 'search works when yt-dlp is installed');
    assert.ok(Array.isArray(s.json.results), 'results array');
    if (s.json.results[0]) {
      assert.ok(/^\/api\/music\/stream\//.test(s.json.results[0].streamUrl), 'each result carries a tokenized stream URL');
      assert.ok(s.json.results[0].thumb, 'thumbnail derived from the track id');
    }
  } else {
    assert.strictEqual(s.status, 503, 'no yt-dlp → honest 503, not a hang');
  }
  // The /api/server flag reflects yt-dlp presence so the UI shows/hides the Music tab.
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/server')).json.music, present);

  // ---- Account linking (cookies) — validation + encrypted round-trip, no network ----
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/music/status', null)).status, 401, 'status needs auth');
  const bad = await httpJson(srv.port, 'POST', '/api/music/link', { cookies: 'hello world not a cookie file' }, admin);
  assert.strictEqual(bad.status, 400, 'garbage rejected with guidance');
  const fakeCookies = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tabc123\n';
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/music/link', { cookies: fakeCookies }, admin)).status, 200);
  const st2 = await httpJson(srv.port, 'GET', '/api/music/status', null, admin);
  assert.strictEqual(st2.json.linked, true, 'linked after pasting cookies');
  assert.strictEqual(JSON.stringify(st2.json).includes('abc123'), false, 'cookie text NEVER returns to a client');
  // The credential lands ENCRYPTED in settings, not as a plaintext file in data/.
  assert.ok(!fs.existsSync(path.join(process.env.TRIBOON_DATA, 'yt-cookies.txt')), 'no plaintext cookie file written to data/');
  await httpJson(srv.port, 'POST', '/api/music/unlink', {}, admin);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/music/status', null, admin)).json.linked, false, 'unlink clears it');
});

test('music: playlist endpoint pages tracks and stream proxy forwards yt-dlp headers plus Range', async () => {
  const ytmusic = require('../server/ytmusic');
  const oldDetect = ytmusic.detectYtdlp;
  const oldPlaylist = ytmusic.playlistTracks;
  const oldResolve = ytmusic.resolveStream;
  let playlistArgs = null;
  let upstreamHeaders = null;
  const upstream = http.createServer((req, res) => {
    upstreamHeaders = req.headers;
    assert.strictEqual(req.headers.range, 'bytes=0-3');
    assert.strictEqual(req.headers['user-agent'], 'TriboonTest');
    res.writeHead(206, {
      'content-type': 'audio/mp4',
      'content-range': 'bytes 0-3/8',
      'content-length': '4',
    });
    res.end('MUSI');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  try {
    ytmusic.detectYtdlp = () => ({ cmd: ['mock-ytdlp'], version: 'test' });
    ytmusic.playlistTracks = async (id, opts) => {
      playlistArgs = { id, ...opts };
      return { title: 'Paged', tracks: [
        { id: 'AAAAAAAAAAA', title: 'One', artist: 'A', thumb: 'one.jpg' },
        { id: 'BBBBBBBBBBB', title: 'Two', artist: 'B', thumb: 'two.jpg' },
        { id: 'CCCCCCCCCCC', title: 'Three', artist: 'C', thumb: 'three.jpg' },
      ] };
    };
    const page = await httpJson(srv.port, 'GET', '/api/music/playlist/LM?limit=2&offset=3', null, admin);
    assert.strictEqual(page.status, 200, page.raw);
    assert.deepStrictEqual({ id: playlistArgs.id, limit: playlistArgs.limit, offset: playlistArgs.offset }, { id: 'LM', limit: 3, offset: 3 });
    assert.strictEqual(page.json.title, 'Paged');
    assert.strictEqual(page.json.offset, 3);
    assert.strictEqual(page.json.limit, 2);
    assert.strictEqual(page.json.hasMore, true);
    assert.strictEqual(page.json.nextOffset, 5);
    assert.strictEqual(page.json.results.length, 2);
    assert.ok(/^\/api\/music\/stream\/AAAAAAAAAAA\?t=/.test(page.json.results[0].streamUrl));

    ytmusic.resolveStream = async () => ({
      url: `http://127.0.0.1:${upstream.address().port}/audio`,
      mime: 'audio/mp4',
      headers: { 'User-Agent': 'TriboonTest', Origin: 'https://music.youtube.com' },
    });
    const uid = srv.auth._users().list[0].id;
    const tok = srv.auth.streamToken(uid, 'music:AAAAAAAAAAA');
    const audio = await httpRaw(srv.port, `/api/music/stream/AAAAAAAAAAA?t=${tok}`, { range: 'bytes=0-3' });
    assert.strictEqual(audio.status, 206);
    assert.strictEqual(audio.headers['content-type'], 'audio/mp4');
    assert.strictEqual(audio.headers['content-range'], 'bytes 0-3/8');
    assert.strictEqual(audio.body.toString(), 'MUSI');
    assert.ok(upstreamHeaders, 'upstream was called');
  } finally {
    ytmusic.detectYtdlp = oldDetect;
    ytmusic.playlistTracks = oldPlaylist;
    ytmusic.resolveStream = oldResolve;
    upstream.close();
  }
});

test('music: daily and weekly charts are cached and tokenized', async () => {
  const ytmusic = require('../server/ytmusic');
  const oldDetect = ytmusic.detectYtdlp;
  const oldSearch = ytmusic.search;
  const calls = [];
  try {
    ytmusic.detectYtdlp = () => ({ cmd: ['mock-ytdlp'], version: 'test' });
    ytmusic.search = async (q, opts) => {
      calls.push({ q, limit: opts.limit });
      return [
        { id: q.includes('week') ? 'WWWWWWWWWWW' : 'DDDDDDDDDDD', title: `${q} one`, artist: 'Chart Artist', thumb: 'chart.jpg' },
        { id: q.includes('week') ? 'XXXXXXXXXXX' : 'EEEEEEEEEEE', title: `${q} two`, artist: 'Chart Artist', thumb: 'chart2.jpg' },
      ];
    };
    const first = await httpJson(srv.port, 'GET', '/api/music/charts', null, admin);
    assert.strictEqual(first.status, 200, first.raw);
    assert.deepStrictEqual(first.json.charts.map((c) => c.id), ['daily', 'weekly']);
    assert.strictEqual(first.json.charts[0].results.length, 2);
    assert.ok(/^\/api\/music\/stream\/DDDDDDDDDDD\?t=/.test(first.json.charts[0].results[0].streamUrl));
    assert.ok(/^\/api\/music\/stream\/WWWWWWWWWWW\?t=/.test(first.json.charts[1].results[0].streamUrl));

    const second = await httpJson(srv.port, 'GET', '/api/music/charts', null, admin);
    assert.strictEqual(second.status, 200, second.raw);
    assert.strictEqual(calls.length, 2, 'daily and weekly chart searches are cached after the first request');
    assert.ok(/^\/api\/music\/stream\/DDDDDDDDDDD\?t=/.test(second.json.charts[0].results[0].streamUrl),
      'cached chart tracks still receive tokenized stream URLs in the response');
  } finally {
    ytmusic.detectYtdlp = oldDetect;
    ytmusic.search = oldSearch;
  }
});

test('housekeeping sweep: idle mounts are evicted, active ones survive', async () => {
  const now = Date.now();
  const mk = (id, touched) => ({ id, _touched: touched, name: id, size: 1, streamable: true, tags: [] });
  srv.mounts.set('idle-x', mk('idle-x', now - 60 * 60000));
  srv.mounts.set('fresh-x', mk('fresh-x', now));
  const evicted = srv.sweep(now);
  assert.ok(evicted.includes('idle-x'), 'idle mount evicted');
  assert.ok(!srv.mounts.has('idle-x'));
  assert.ok(srv.mounts.has('fresh-x'), 'recently-touched mount survives');
  srv.mounts.delete('fresh-x');
});

test('fetchUrl: response-size cap aborts oversized bodies instead of buffering them', async () => {
  const { fetchUrl } = require('../server/newznab');
  const big = http.createServer((req, res) => { res.writeHead(200); res.end(Buffer.alloc(2 * 1024 * 1024)); });
  await new Promise((r) => big.listen(0, '127.0.0.1', r));
  await assert.rejects(
    fetchUrl(`http://127.0.0.1:${big.address().port}/`, { maxBytes: 256 * 1024 }),
    /too large/,
  );
  big.close();
});

test('trakt: device link, scrobble forward, watchlist push + import', async () => {
  const http2 = require('http');
  const calls = [];
  let retryScrobbleFailed = false;
  const mock = http2.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      calls.push({ path: req.url, method: req.method, body: parsed, auth: req.headers.authorization });
      if (req.url === '/scrobble/stop' && parsed && parsed.movie && parsed.movie.ids.tmdb === 604 && !retryScrobbleFailed) {
        retryScrobbleFailed = true;
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'temporary' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/oauth/device/code') return res.end(JSON.stringify({ device_code: 'dev123', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', interval: 1, expires_in: 600 }));
      if (req.url === '/oauth/device/token') return res.end(JSON.stringify({ access_token: 'acc1', refresh_token: 'ref1', expires_in: 7776000 }));
      if (req.url === '/users/settings') return res.end(JSON.stringify({ user: { username: 'owner-trakt' } }));
      if (req.url === '/sync/watchlist' && req.method === 'GET') return res.end(JSON.stringify([{ movie: { title: 'Pulled Movie', year: 2020, ids: { tmdb: 4242 } } }]));
      if (req.url === '/sync/watched/movies') return res.end(JSON.stringify([{ movie: { title: 'Seen Movie', year: 2019, ids: { tmdb: 777 } } }]));
      if (req.url === '/sync/watched/shows') return res.end(JSON.stringify([{ show: { title: 'Seen Show', year: 2018, ids: { tmdb: 888 } }, seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }] }]));
      if (req.url === '/sync/playback') return res.end(JSON.stringify([
        { progress: 41.5, paused_at: '2026-06-10T00:00:00.000Z', movie: { title: 'Half Movie', year: 2021, ids: { tmdb: 999 } } },
        { progress: 22.2, paused_at: '2026-06-11T00:00:00.000Z', show: { title: 'Half Show', year: 2022, ids: { tmdb: 1234 } }, episode: { season: 2, number: 3 } },
      ]));
      res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.TRAKT_BASE = `http://127.0.0.1:${mock.address().port}`;

  await httpJson(srv.port, 'POST', '/api/settings', { traktClientId: 'cid', traktClientSecret: 'sec' }, admin);
  // Device-code link flow.
  const link = await httpJson(srv.port, 'POST', '/api/trakt/link', {}, admin);
  assert.strictEqual(link.json.userCode, 'ABCD1234');
  const poll = await httpJson(srv.port, 'POST', '/api/trakt/poll', {}, admin);
  assert.strictEqual(poll.json.state, 'linked');
  const st = await httpJson(srv.port, 'GET', '/api/trakt/status', null, admin);
  assert.strictEqual(st.json.linked, true);
  assert.strictEqual(st.json.user, 'owner-trakt');
  const traktProfile = (await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'Trakt Living Room', level: 3 }, admin)).json;

  // Watch save → scrobble (fire-and-forget, give it a beat).
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:603', position: 300, duration: 600, meta: {} }, admin);
  await new Promise((r) => setTimeout(r, 200));
  const scrob = calls.find((c) => c.path === '/scrobble/stop' && c.body && c.body.movie && c.body.movie.ids.tmdb === 603);
  assert.ok(scrob, 'scrobble forwarded to trakt');
  assert.strictEqual(scrob.body.movie.ids.tmdb, 603);
  assert.strictEqual(scrob.body.progress, 50);
  assert.strictEqual(scrob.auth, 'Bearer acc1');
  assert.ok(!calls.some((c) => c.path === '/scrobble/pause'), 'resume progress uses Trakt stop scrobble, not the removed pause endpoint');

  // A temporary Trakt failure is queued and retried by the next sync.
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:604', position: 120, duration: 600, meta: {} }, admin);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(calls.filter((c) => c.path === '/scrobble/stop' && c.body && c.body.movie && c.body.movie.ids.tmdb === 604).length, 1);

  // Watchlist toggle → push.
  await httpJson(srv.port, 'POST', '/api/watchlist', { key: 'tmdb:tv:1399', on: true, meta: {} }, admin);
  await new Promise((r) => setTimeout(r, 200));
  const wlPush = calls.find((c) => c.path === '/sync/watchlist' && c.method === 'POST');
  assert.ok(wlPush && wlPush.body.shows && wlPush.body.shows[0].ids.tmdb === 1399, 'watchlist add pushed as a show');

  // SYNC-DOWN ran automatically right after linking: Trakt watchlist landed locally,
  // watched history became local watch records (check-marks), in-progress playback became
  // a Continue-Watching entry carrying Trakt's PERCENT (Trakt never stores seconds).
  await new Promise((r) => setTimeout(r, 300));
  let mine = await httpJson(srv.port, 'GET', '/api/watchlist', null, admin);
  assert.ok(mine.json.some((w) => w.key === 'tmdb:movie:4242'), 'pulled movie landed in the local watchlist');
  const watch = (await httpJson(srv.port, 'GET', '/api/watch', null, admin)).json;
  const seenMovie = watch.find((w) => w.key === 'tmdb:movie:777');
  assert.ok(seenMovie && seenMovie.watched, 'Trakt-watched movie imported as watched');
  assert.ok(watch.find((w) => w.key === 'tmdb:tv:888:s1e1' && w.watched), 'show episodes imported per-episode (e1)');
  assert.ok(watch.find((w) => w.key === 'tmdb:tv:888:s1e2' && w.watched), 'show episodes imported per-episode (e2)');
  const half = watch.find((w) => w.key === 'tmdb:movie:999');
  assert.ok(half && !half.watched && half.traktPct === 41.5, 'in-progress playback imported with the Trakt percent');
  assert.strictEqual(half.meta.title, 'Half Movie');
  const halfEp = watch.find((w) => w.key === 'tmdb:tv:1234:s2e3');
  assert.ok(halfEp && !halfEp.watched && halfEp.traktPct === 22.2, 'Trakt in-progress episode imports into Continue Watching');
  assert.strictEqual(halfEp.meta.title, 'Half Show — S02E03');

  const profileWatch = (await httpJson(srv.port, 'GET', `/api/watch?profile=${traktProfile.id}`, null, admin)).json;
  assert.ok(profileWatch.find((w) => w.key === 'tmdb:movie:777' && w.watched), 'Trakt watched history is visible to the active profile');
  assert.ok(profileWatch.find((w) => w.key === 'tmdb:movie:999' && w.traktPct === 41.5), 'Trakt playback progress is visible to the active profile Continue Watching row');
  assert.ok(!profileWatch.some((w) => w.key === 'tmdb:movie:603'), 'local default-profile playback does not leak into another profile');

  // Manual re-sync: idempotent (everything already imported → 0 new) and never downgrades.
  const sync = await httpJson(srv.port, 'POST', '/api/trakt/sync', {}, admin);
  assert.strictEqual(sync.status, 200);
  assert.strictEqual(sync.json.pushed, 1, 'queued Trakt export retried during sync');
  assert.strictEqual(sync.json.watched, 0, 're-sync imports nothing twice');
  assert.strictEqual(sync.json.watchlist, 0, 'watchlist import is idempotent');
  assert.strictEqual(sync.json.totalWatched, 3);
  assert.strictEqual(sync.json.totalWatchlist, 1);

  // Import button remains as a watchlist-only manual fallback and is also idempotent.
  const pull = await httpJson(srv.port, 'POST', '/api/trakt/pull', {}, admin);
  assert.strictEqual(pull.json.imported, 0);
  assert.strictEqual(pull.json.total, 1);

  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:999', remove: true, profile: traktProfile.id }, admin);
  const profileAfterRemove = (await httpJson(srv.port, 'GET', `/api/watch?profile=${traktProfile.id}`, null, admin)).json;
  assert.ok(!profileAfterRemove.some((w) => w.key === 'tmdb:movie:999'), 'removing imported Continue Watching from a profile clears the Trakt fallback');
  const defaultAfterRemove = (await httpJson(srv.port, 'GET', '/api/watch', null, admin)).json;
  assert.ok(!defaultAfterRemove.some((w) => w.key === 'tmdb:movie:999'), 'profile removal also clears the shared imported fallback row');

  // Explicit ✓ (no playback context) → /sync/history; explicit unwatch → history/remove.
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:603', watched: true, position: 0, duration: 0, meta: {} }, admin);
  await new Promise((r) => setTimeout(r, 200));
  const histAdd = calls.find((c) => c.path === '/sync/history' && c.method === 'POST');
  assert.ok(histAdd && histAdd.body.movies && histAdd.body.movies[0].ids.tmdb === 603, 'mark-watched exported to Trakt history');
  await httpJson(srv.port, 'POST', '/api/watch', { key: 'tmdb:movie:603', watched: false, unwatch: true, position: 0, duration: 0, meta: {} }, admin);
  await new Promise((r) => setTimeout(r, 200));
  const histRm = calls.find((c) => c.path === '/sync/history/remove');
  assert.ok(histRm && histRm.body.movies && histRm.body.movies[0].ids.tmdb === 603, 'unwatch exported as history remove');

  // Cleanup (incl. the imported records so later suites see a clean slate).
  await httpJson(srv.port, 'POST', '/api/trakt/unlink', {}, admin);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/trakt/status', null, admin)).json.linked, false);
  await httpJson(srv.port, 'POST', `/api/me/profiles/${traktProfile.id}/delete`, { password: 'hunter22' }, admin);
  await httpJson(srv.port, 'POST', '/api/watchlist', { key: 'tmdb:tv:1399', on: false }, admin);
  await httpJson(srv.port, 'POST', '/api/watchlist', { key: 'tmdb:movie:4242', on: false }, admin);
  for (const k of ['tmdb:movie:777', 'tmdb:tv:888:s1e1', 'tmdb:tv:888:s1e2', 'tmdb:movie:999', 'tmdb:tv:1234:s2e3', 'tmdb:movie:603', 'tmdb:movie:604']) {
    await httpJson(srv.port, 'POST', '/api/watch', { key: k, remove: true }, admin);
  }
  delete process.env.TRAKT_BASE;
  mock.close();
});

test('password change: requires the current password, old one stops working', async () => {
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/me/password',
    { oldPassword: 'wrong', newPassword: 'newpass1' }, admin)).status, 400);
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/me/password',
    { oldPassword: 'hunter22', newPassword: 'newpass1' }, admin)).status, 200);
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' })).status, 401);
  const re = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'newpass1' });
  assert.strictEqual(re.status, 200);
  admin = re.json.token;
});

test('quick connect: TV code approved from an authed phone yields a working token', async () => {
  const code = await httpJson(srv.port, 'POST', '/api/quickconnect', { deviceName: 'Living Room TV' });
  assert.strictEqual(code.status, 200);
  assert.match(code.json.code, /^\d{6}$/);

  let poll = await httpJson(srv.port, 'GET', `/api/quickconnect/${code.json.code}`);
  assert.strictEqual(poll.json.status, 'pending');

  const ap = await httpJson(srv.port, 'POST', `/api/quickconnect/${code.json.code}/approve`, {}, admin);
  assert.strictEqual(ap.status, 200);

  poll = await httpJson(srv.port, 'GET', `/api/quickconnect/${code.json.code}`);
  assert.strictEqual(poll.json.status, 'approved');
  const me = await httpJson(srv.port, 'GET', '/api/me', null, poll.json.token);
  assert.strictEqual(me.json.name, 'owner', 'TV is now the approving user');

  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/quickconnect/000000')).json.status, 'expired');
});

test('teardown', async () => {
  await srv.shutdown();
  await mockNntp.close();
  tmdbMock.close();
  if (ixServer) ixServer.close();
});

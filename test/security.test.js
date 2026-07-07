'use strict';
// Security + Phase 3/4 API corpus: deny-by-default route coverage, auth flows (setup, login,
// invites, quick connect), per-user caps from invite policy, settings encryption at rest,
// TMDB proxy + cache, watch state, and the HTTP play/advance endpoints.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { httpJson, httpRaw, httpBinary, bootServer, setupAdmin } = require('./helpers');
const { totpCode } = require('../server/auth');
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

// Raw request that lets a test set an Origin header and choose any method (incl. OPTIONS) —
// used to assert the media-route CORS contract for a Cast custom receiver.
function httpWithHeaders(port, method, p, { origin, token, range } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (origin) headers.origin = origin;
    if (token) headers.authorization = `Bearer ${token}`;
    if (range) headers.range = range;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function legacySignedToken(auth, claims, ttlMs = 60000) {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', auth.secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function normalizeTestRecovery(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
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
  // Age-gate fixtures: an R-rated movie (blocked below Adult) and a G-rated movie (kids OK).
  if (u.pathname === '/3/movie/990001') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 990001, title: 'Restricted Movie', adult: false,
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] } }));
  }
  if (u.pathname === '/3/movie/990002') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 990002, title: 'Kid Movie', adult: false,
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'G' }] }] } }));
  }
  if (u.pathname === '/3/movie/990003') { // NC-17: above the R tier — only "No limit" may play it
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 990003, title: 'NC17 Movie', adult: false,
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'NC-17' }] }] } }));
  }
  // Key-validation fixture: the settings save pings /configuration with a NEW tmdb key and only a
  // definitive 401 rejects the save.
  if (u.pathname === '/3/configuration' && u.searchParams.get('api_key') === 'bad-tmdb-key') {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status_code: 7, status_message: 'Invalid API key' }));
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
  assert.strictEqual(s.json.builtInSubtitlesEnabled, false,
    'built-in subtitles default to off while online-only testing is enabled');

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
    ['GET', '/api/me'], ['GET', '/api/me/security'], ['GET', '/api/app/latest'], ['POST', '/api/me/totp/setup'], ['POST', '/api/me/totp/enable'],
    ['POST', '/api/me/totp/disable'], ['POST', '/api/me/totp/recovery'], ['GET', '/api/status'], ['GET', '/api/search?q=x'],
    ['POST', '/api/play'], ['POST', '/api/advance/abc'], ['GET', '/api/tmdb/trending/all/week'],
    ['GET', '/api/watch'], ['GET', '/api/watch/next'], ['POST', '/api/watch'], ['GET', '/api/activity'], ['POST', '/api/activity'], ['GET', '/api/mounts'],
    ['GET', '/api/health/abc'], ['POST', '/api/mount'], ['GET', '/api/settings'],
    ['GET', '/api/me/iptv/sources'], ['POST', '/api/me/iptv/sources'], ['PATCH', '/api/me/iptv/sources/abc'], ['DELETE', '/api/me/iptv/sources/abc'],
    ['POST', '/api/settings'], ['POST', '/api/streaming/recommend'], ['POST', '/api/invites'], ['GET', '/api/invites'],
    ['GET', '/api/users'], ['GET', '/api/libraries/local-lookup?key=tmdb:movie:1'], ['GET', '/api/stream/abc'], ['GET', '/api/remux/abc'],
    ['GET', '/api/transcode/abc'], ['GET', '/api/hls/abc'], ['GET', '/api/hls/abc/seg00001.m4s'],
    ['GET', '/api/iptv/status'], ['POST', '/api/iptv/refresh'], ['GET', '/api/iptv/sources'], ['POST', '/api/iptv/sources'], ['PATCH', '/api/iptv/sources/abc'], ['DELETE', '/api/iptv/sources/abc'],
    ['POST', '/api/quickconnect/123456/approve'], ['GET', '/api/music/home'], ['GET', '/api/music/charts'], ['GET', '/api/music/search?q=x'], ['GET', '/api/music/radio/AAAAAAAAAAA'],
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
    ['GET', '/api/iptv/status'], ['POST', '/api/iptv/refresh'],
    ['POST', '/api/me/totp/setup'], ['POST', '/api/me/totp/enable'], ['POST', '/api/me/totp/disable'], ['POST', '/api/me/totp/recovery']]) {
    assert.strictEqual((await httpJson(srv.port, m, p, {}, user)).status, 403, `user → ${m} ${p}`);
  }
  // …but user routes work.
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/status', null, user)).status, 200);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/libraries', null, user)).status, 200, 'users can READ libraries');
});

test('security: ?t= session tokens are rejected on non-stream routes; /api/status fingerprint is admin-only', async () => {
  // (1) A session token authenticates via the Authorization header but NEVER via the ?t= URL
  // query on a user/admin route (where it would leak into logs/referer/history). ?t= is honored
  // only for stream-tier media routes, which scope-check it.
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, admin)).status, 200, 'header token authenticates /api/me');
  assert.strictEqual((await httpRaw(srv.port, `/api/me?t=${admin}`)).status, 401, 'a session token in ?t= is rejected on /api/me');

  // (2) Provider host/port + host OS/Node fingerprint are admin-only operational detail in /api/status.
  const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
  assert.strictEqual(inv.status, 200, 'admin can mint an invite');
  const joined = await httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name: 'sguest', password: 'sguest-pass1' });
  assert.strictEqual(joined.status, 200, 'invite accepted by a regular user');
  const user = joined.json.token;
  const us = await httpJson(srv.port, 'GET', '/api/status', null, user);
  const as = await httpJson(srv.port, 'GET', '/api/status', null, admin);
  assert.strictEqual(us.status, 200);
  assert.strictEqual(as.status, 200);
  assert.ok(!us.json.device || us.json.device.os === undefined, 'regular user does not receive the host OS fingerprint');
  assert.ok(!us.json.nntp || us.json.nntp.host === undefined, 'regular user does not receive the provider host/port');
  assert.ok(as.json.device && typeof as.json.device.node === 'string', 'admin still receives the full device fingerprint');
  assert.ok(as.json.nntp && typeof as.json.nntp.host === 'string', 'admin still receives the provider host');
});

test('activity: users heartbeat playback and only admins see now-watching rows', async () => {
  const login = await httpJson(srv.port, 'POST', '/api/login', { name: 'fam', password: 'fam-pass' });
  assert.strictEqual(login.status, 200);
  const user = login.json.token;
  const sessionId = 'test-session-activity';
  const posted = await httpJson(srv.port, 'POST', '/api/activity', {
    sessionId,
    state: 'watching',
    title: 'The Test Movie',
    subline: '4K Direct Play',
    type: 'movie',
    player: 'exo',
    mode: 'ExoPlayer',
    streamKind: 'transcode',
    streamLabel: 'Transcoding',
    clientVersion: 'Android TV 1.7.26 (126)',
    deviceName: 'NVIDIA SHIELD',
    position: 600,
    duration: 6000,
    size: 42_000_000_000,
  }, user);
  assert.strictEqual(posted.status, 200);

  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/activity', null, user)).status, 403,
    'plain users cannot see other users watching');
  const visible = await httpJson(srv.port, 'GET', '/api/activity', null, admin);
  assert.strictEqual(visible.status, 200);
  assert.ok('connections' in visible.json, 'activity payload carries a usenet-connections slot (null until a pool exists)');
  const row = visible.json.sessions.find((s) => s.sessionId === sessionId);
  assert.ok(row, 'admin sees the active session');
  assert.strictEqual(row.userName, 'fam');
  assert.strictEqual(row.title, 'The Test Movie');
  assert.strictEqual(row.streamKind, 'transcode');
  assert.strictEqual(row.streamLabel, 'Transcoding');
  assert.strictEqual(row.clientVersion, 'Android TV 1.7.26 (126)');
  assert.strictEqual(row.deviceName, 'NVIDIA SHIELD', 'the reported hardware device name round-trips to admins');
  assert.strictEqual(row.percent, 10);
  assert.ok(visible.json.history.some((s) => s.title === 'The Test Movie' && s.userName === 'fam' && s.clientVersion === 'Android TV 1.7.26 (126)'),
    'activity history keeps a compact recent watch row');

  const stopped = await httpJson(srv.port, 'POST', '/api/activity', { sessionId, state: 'stopped' }, user);
  assert.strictEqual(stopped.status, 200);
  const after = await httpJson(srv.port, 'GET', '/api/activity', null, admin);
  assert.ok(!after.json.sessions.some((s) => s.sessionId === sessionId), 'stop heartbeat removes the row');

  const liveId = 'test-live-activity';
  const live = await httpJson(srv.port, 'POST', '/api/activity', {
    sessionId: liveId,
    state: 'watching',
    title: 'Secret Channel Name',
    type: 'live',
    player: 'exo',
    mode: 'ExoPlayer',
    streamKind: 'live',
    streamLabel: 'Live',
    clientVersion: 'Android TV 1.7.26 (126)',
  }, user);
  assert.strictEqual(live.status, 200);
  const liveVisible = await httpJson(srv.port, 'GET', '/api/activity', null, admin);
  const liveRow = liveVisible.json.sessions.find((s) => s.sessionId === liveId);
  assert.ok(liveRow, 'admin sees that Live TV is active');
  assert.strictEqual(liveRow.title, 'Live TV');
  assert.strictEqual(liveRow.subline, 'Live stream');
  assert.ok(!liveVisible.json.history.some((s) => s.type === 'live' || s.streamKind === 'live'),
    'Live TV is current-activity only and is not retained in history');
  assert.ok(!JSON.stringify(liveVisible.json.history).includes('Secret Channel Name'),
    'retained activity does not store Live TV channel names');

  const now = Date.now();
  srv.store.write('activityHistory', { rows: [
    { id: 'old', userName: 'old', title: 'Expired', type: 'movie', updatedAt: now - 4 * 24 * 60 * 60 * 1000 },
    { id: 'live-old', userName: 'fam', title: 'Live TV', type: 'live', streamKind: 'live', updatedAt: now },
    ...Array.from({ length: 70 }, (_, i) => ({
      id: `movie-${i}`,
      userName: 'fam',
      title: `Movie ${i}`,
      type: 'movie',
      updatedAt: now - i,
    })),
  ] });
  const pruned = await httpJson(srv.port, 'GET', '/api/activity', null, admin);
  assert.strictEqual(pruned.json.retentionDays, 3);
  assert.ok(pruned.json.history.length <= 60, 'activity history is capped to a bounded 3-day window');
  assert.ok(!pruned.json.history.some((s) => s.title === 'Expired'), 'activity history is pruned to the last 3 days');
  assert.ok(!pruned.json.history.some((s) => s.type === 'live'), 'activity history prunes retained IPTV/Live TV rows');
  assert.ok(pruned.json.history.some((s) => s.title === 'Movie 0'), 'newest VOD rows remain in history');
  assert.ok(!pruned.json.history.some((s) => s.title === 'Movie 69'), 'rows beyond the bounded window are omitted');
  await httpJson(srv.port, 'POST', '/api/activity', { sessionId: liveId, state: 'stopped' }, user);
});

test('presence: connected devices (browsing or watching) appear in the online list; admin-only', async () => {
  const login = await httpJson(srv.port, 'POST', '/api/login', { name: 'fam', password: 'fam-pass' });
  const user = login.json.token;
  // deviceId is required.
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/presence', { state: 'browsing' }, user)).status, 400,
    'presence requires a deviceId');
  // A user just BROWSING (not playing) is connected and should show online.
  const browse = await httpJson(srv.port, 'POST', '/api/presence', { deviceId: 'dev-tv', state: 'browsing', view: 'home', profile: 'Kids' }, user);
  assert.strictEqual(browse.status, 200);
  // The same account on a second device, watching something.
  await httpJson(srv.port, 'POST', '/api/presence', { deviceId: 'dev-phone', state: 'watching', title: 'The Test Movie', profile: 'Adults' }, user);

  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/activity', null, user)).status, 403,
    'plain users cannot see who is connected');
  const view = await httpJson(srv.port, 'GET', '/api/activity', null, admin);
  assert.strictEqual(view.status, 200);
  const online = view.json.online || [];
  assert.strictEqual(view.json.onlineCount, online.length, 'onlineCount matches the online rows');
  const tv = online.find((o) => o.id === `${login.json.user ? login.json.user.id : ''}:dev-tv`) || online.find((o) => o.state === 'browsing' && o.view === 'home');
  assert.ok(tv, 'a browsing (not-playing) device shows as connected');
  assert.strictEqual(tv.userName, 'fam');
  assert.ok(online.some((o) => o.state === 'watching' && o.title === 'The Test Movie'),
    'a second device of the same account shows separately as watching');
  assert.strictEqual(online.filter((o) => o.userName === 'fam').length, 2, 'two devices = two connected rows (not deduped to one user)');

  // Going offline drops the device.
  await httpJson(srv.port, 'POST', '/api/presence', { deviceId: 'dev-tv', state: 'offline' }, user);
  const after = await httpJson(srv.port, 'GET', '/api/activity', null, admin);
  assert.ok(!(after.json.online || []).some((o) => o.state === 'browsing' && o.view === 'home'),
    'an offline beacon removes the connected device');
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

test('settings save preserves per-user YouTube Music cookies (admin save must not wipe them)', async () => {
  // Link a cookie for the admin user (stored encrypted in settings.ytCookies[uid]).
  const cookieText = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t9999999999\tSID\tregression-cookie-value\n';
  const link = await httpJson(srv.port, 'POST', '/api/music/link', { cookies: cookieText }, admin);
  assert.strictEqual(link.status, 200);
  assert.strictEqual(link.json.linked, true);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/music/status', null, admin)).json.linkSource, 'account',
    'cookie link should report as an account link');
  // An unrelated admin settings save (this endpoint rebuilds the whole settings object) must NOT
  // drop the per-user cookie — regression for "the YouTube Music cookie is lost after an update".
  await httpJson(srv.port, 'POST', '/api/settings', { scoringGroupsTrusted: ['REGGRP'] }, admin);
  const after = await httpJson(srv.port, 'GET', '/api/music/status', null, admin);
  assert.strictEqual(after.json.linkSource, 'account', 'YouTube Music cookie must survive an admin settings save');
  assert.strictEqual(after.json.linked, true);
  // the cookie is still encrypted at rest (never stored in plaintext)
  const raw = fs.readFileSync(path.join(process.env.TRIBOON_DATA, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('regression-cookie-value'), 'cookie encrypted at rest');
  // clean up so later tests start from a known state
  await httpJson(srv.port, 'POST', '/api/music/unlink', null, admin);
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

  // Phase 2: measured provider speed + connection cap + Max release size feed the recommendation.
  await httpJson(srv.port, 'POST', '/api/settings', { sizeCapMode: 'manual', sizeCap4kGb: 40, sizeCap1080Gb: 20 }, admin);
  const rec2 = await httpJson(srv.port, 'POST', '/api/streaming/recommend', {
    expectedUsers: 5, streamMix: 'mixed', measuredMbpsPerConn: 28, measuredConnCap: 20,
  }, admin);
  assert.strictEqual(rec2.status, 200);
  assert.strictEqual(rec2.json.capacity.measuredMbpsPerConn, 28, 'echoes the measured per-connection speed');
  assert.strictEqual(rec2.json.capacity.measuredConnCap, 20, 'echoes the measured connection cap');
  assert.ok(rec2.json.capacity.streamBitrate4k > 0 && rec2.json.capacity.streamBitrate4k < 120, 'derives a 4K bitrate from the 40 GB size cap');
  assert.ok(rec2.json.capacity.maxSimultaneous4k >= 1, 'reports how many simultaneous 4K viewers fit');
  assert.ok(rec2.json.capacity.maxSimultaneous1080 >= rec2.json.capacity.maxSimultaneous4k, '1080p fits at least as many viewers as 4K');
  assert.ok(rec2.json.recommendation.maxConnPerStream4k >= 12,
    '4K per-stream connections are peak-sized (>=12) so a VBR spike + latency dip cannot drain the buffer');
  assert.ok((rec2.json.warnings || []).some((w) => /configured|too many connections/i.test(w)),
    '100 configured connections vs a measured cap of 20 raises an over-subscription warning');
  await httpJson(srv.port, 'POST', '/api/settings', { sizeCapMode: 'auto' }, admin); // restore for later tests

  // Phase 4: the server's internet line speed caps simultaneous viewers, regardless of connections.
  const recSlowLine = await httpJson(srv.port, 'POST', '/api/streaming/recommend', {
    expectedUsers: 5, streamMix: '4k', measuredMbpsPerConn: 28, measuredConnCap: 100, serverDownloadMbps: 100,
  }, admin);
  assert.ok(recSlowLine.json.capacity.deliverableMbps > 0 && recSlowLine.json.capacity.deliverableMbps <= 90,
    'deliverable throughput is bounded by the ~100 Mbps line (×0.8)');
  assert.ok(recSlowLine.json.capacity.maxSimultaneous4k <= 2,
    'a slow line caps 4K viewers even when 100 connections are available');
  // Missing line speed → an explicit prompt to add it (it is required for an accurate estimate).
  const recNoLine = await httpJson(srv.port, 'POST', '/api/streaming/recommend', {
    expectedUsers: 5, measuredMbpsPerConn: 28, serverDownloadMbps: 0,
  }, admin);
  assert.ok((recNoLine.json.warnings || []).some((w) => /download speed/i.test(w)),
    'a missing download speed is flagged so the viewer estimate is not silently connection-only');

  const status = await httpJson(srv.port, 'GET', '/api/status', null, admin);
  assert.ok(status.json.streaming.usableConnections > 0, 'status exposes the active streaming capacity profile');
  assert.ok(status.json.pipeline.search, 'status exposes aggregate source-search telemetry');
  assert.ok(status.json.playback, 'status exposes aggregate playback telemetry');

  await httpJson(srv.port, 'POST', '/api/settings', {
    providers: [{ host: '127.0.0.1', port: nntpPort, tls: false, user: 'u', pass: 'super-secret-pass', connections: 4 }],
  }, admin);
});

test('settings: quality vs concurrency presets scale per-stream from REAL total connections (not hardcoded)', async () => {
  // Add a high-connection provider so the share-based sizing has room to differentiate (4K per-stream
  // floors at 12, which would mask the intent on a tiny connection budget).
  await httpJson(srv.port, 'POST', '/api/settings', { addProvider: { host: 'news.scale.com', port: 563, user: 'u', pass: 'p', connections: 130 } }, admin);
  const s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  const addedIdx = s.json.providers.length - 1;
  try {
    const base = { expectedUsers: 4, streamMix: 'mixed', serverDownloadMbps: 1000, measuredMbpsPerConn: 30 };
    const q = (await httpJson(srv.port, 'POST', '/api/streaming/recommend', { ...base, profile: 'quality' }, admin)).json;
    const c = (await httpJson(srv.port, 'POST', '/api/streaming/recommend', { ...base, profile: 'concurrency' }, admin)).json;
    // Same connections + users, opposite intent → quality = fewer/richer streams (bigger per-stream +
    // deeper buffer); concurrency = more simultaneous viewers. ALL derived from the connection count.
    assert.ok(q.recommendation.maxConnPerStream4k > c.recommendation.maxConnPerStream4k,
      `quality per-stream (${q.recommendation.maxConnPerStream4k}) must exceed concurrency (${c.recommendation.maxConnPerStream4k})`);
    assert.ok(q.recommendation.buffer4kSec > c.recommendation.buffer4kSec,
      `quality buffer (${q.recommendation.buffer4kSec}s) must be deeper than concurrency (${c.recommendation.buffer4kSec}s)`);
    assert.ok(c.capacity.maxSimultaneous4k >= q.capacity.maxSimultaneous4k,
      'concurrency fits at least as many simultaneous 4K viewers as quality');
    assert.strictEqual(q.recommendation.profile, 'quality', 'recommendation echoes the chosen intent');
  } finally {
    await httpJson(srv.port, 'POST', '/api/settings', { removeProvider: addedIdx }, admin);
  }
});

test('settings: built-in subtitle mode round-trips to player server info', async () => {
  await httpJson(srv.port, 'POST', '/api/settings', { builtInSubtitlesEnabled: true }, admin);
  let s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(s.json.builtInSubtitlesEnabled, true, 'admin setting should save built-in subtitle mode');
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/server')).json.builtInSubtitlesEnabled, true,
    'all players should receive the built-in subtitle mode through /api/server');

  await httpJson(srv.port, 'POST', '/api/settings', { builtInSubtitlesEnabled: false }, admin);
  s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(s.json.builtInSubtitlesEnabled, false, 'admin setting should be able to return to online-only mode');
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/server')).json.builtInSubtitlesEnabled, false,
    'player server info should reflect online-only mode');
});

test('settings: subtitle provider policy round-trips; OS API key stays a secret', async () => {
  // Default mode with nothing saved.
  let s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(s.json.subtitleSource, 'wyzie-first', 'default subtitle policy is wyzie-first');
  // Valid mode round-trips; junk is dropped back to the default, never persisted.
  await httpJson(srv.port, 'POST', '/api/settings', { subtitleSource: 'opensubtitles-first' }, admin);
  s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(s.json.subtitleSource, 'opensubtitles-first');
  await httpJson(srv.port, 'POST', '/api/settings', { subtitleSource: 'evil-mode' }, admin);
  s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(s.json.subtitleSource, 'wyzie-first', 'invalid mode falls back to the default');
  // OpenSubtitles API key: saved encrypted, redacted on read, and openSubtitlesActive only flips
  // true when the FULL trio (key + user + pass) is present — LIVE-VERIFIED that /download 401s
  // without a user token (the key alone only searches), so key-only must not list rows.
  await httpJson(srv.port, 'POST', '/api/settings', { osApiKey: 'test-os-consumer-key' }, admin);
  s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(s.json.osApiKey, '•••', 'OS API key never round-trips in plaintext');
  assert.strictEqual(s.json.openSubtitlesActive, false, 'key alone does not activate OpenSubtitles (downloads need the login — verified live)');
  await httpJson(srv.port, 'POST', '/api/settings', { openSubsUser: 'kermit', openSubsPass: 'thefrog' }, admin);
  s = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(s.json.openSubtitlesActive, true, 'dashboard-entered key + login activates OpenSubtitles');
  // Cleanup so later tests see the defaults.
  await httpJson(srv.port, 'POST', '/api/settings', { subtitleSource: null, osApiKey: null, openSubsUser: '', openSubsPass: null }, admin);
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

test('watch state: tokenized local artwork is not persisted into Continue Watching', async () => {
  await httpJson(srv.port, 'POST', '/api/watch', {
    key: 'local:lib1:7', position: 120, duration: 7200,
    meta: {
      title: 'Local Movie',
      poster: '/api/local/lib1/art/7?t=expired-token',
      backdrop: 'http://triboon.local/api/local/lib1/thumb/7?t=expired-token',
    },
  }, admin);
  const list = await httpJson(srv.port, 'GET', '/api/watch', null, admin);
  const row = list.json.find((w) => w.key === 'local:lib1:7');
  assert.ok(row);
  assert.strictEqual(row.meta.poster, undefined);
  assert.strictEqual(row.meta.backdrop, undefined);
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
    key: 'tmdb:tv:424242:s1e2', hidden: true,
    meta: { title: 'Next Up Show — S01E02', type: 'episode', tmdbId: 424242 },
  }, admin);
  next = await httpJson(srv.port, 'GET', '/api/watch/next', null, admin);
  assert.ok(!next.json.some((x) => x.key === 'tmdb:tv:424242:s1e2'), 'dismissed next episode stays out of Continue Watching');
  const visibleRows = await httpJson(srv.port, 'GET', '/api/watch', null, admin);
  assert.ok(!visibleRows.json.some((x) => x.key === 'tmdb:tv:424242:s1e2'), 'hidden dismiss row is not returned as normal watch progress');

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

  // HLS is now a FIRST-CLASS stream-authed output (iOS Safari can't consume the non-rangeable 200
  // remux/transcode pipe, so it plays HLS instead). An authorized request is NO LONGER 404-gated — it
  // proceeds past the old feature flag (then 503 without ffmpeg / 504 until the playlist is ready / 200).
  const hlsOn = await httpRaw(srv.port, `/api/hls/${play.json.id}`, { token: admin });
  assert.notStrictEqual(hlsOn.status, 404, 'HLS is a first-class stream output now, not feature-gated off');
  assert.notStrictEqual(hlsOn.status, 401, 'a valid stream token is accepted on the HLS route');
  // But it stays stream-tier authed: no token → 401 (deny-by-default preserved).
  assert.strictEqual((await httpRaw(srv.port, `/api/hls/${play.json.id}`)).status, 401, 'HLS route rejects an unauthed request');
  // Media CORS still applies to the HLS route path (a Cast receiver / iOS fetches it cross-origin).
  const hlsCors = await httpWithHeaders(srv.port, 'GET', `/api/hls/${play.json.id}`, { origin: 'https://cast.example.com', token: admin });
  assert.strictEqual(hlsCors.headers['access-control-allow-origin'], 'https://cast.example.com', 'HLS route carries media CORS');

  // Stripping the token kills it; a session token does work for streams (browser case).
  const bare = play.json.streamUrl.split('?')[0];
  assert.strictEqual((await httpRaw(srv.port, bare)).status, 401);
  const viaSession = await httpRaw(srv.port, bare, { token: admin, range: 'bytes=0-99' });
  assert.strictEqual(viaSession.status, 206, 'session bearer token also valid for streams (browser case)');
  const otherUser = await httpJson(srv.port, 'POST', '/api/login', { name: 'fam', password: 'fam-pass' });
  assert.strictEqual((await httpRaw(srv.port, bare, { token: otherUser.json.token, range: 'bytes=0-99' })).status, 404,
    'another user session cannot read or probe this mount by guessing the mount id');

  // Advance: only one candidate → exhausted.
  const adv = await httpJson(srv.port, 'POST', `/api/advance/${play.json.sessionId}`, {}, admin);
  assert.strictEqual(adv.status, 502);
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/advance/zzzz', {}, admin)).status, 404);
});

test('security: a forged token with no exp claim is rejected (immortal-token footgun)', async () => {
  // Craft a token signed with the server secret but WITHOUT an exp field.
  const secret = srv.auth.secret;
  const payload = Buffer.from(JSON.stringify({ uid: 'x', role: 'admin', scope: 'session' })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const forged = `${payload}.${sig}`;
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, forged)).status, 401);
});

test('security: legacy raw-secret tokens are session-only compatibility, not stream auth', async () => {
  const claims = srv.auth.verifyToken(admin, 'session');
  const legacySession = legacySignedToken(srv.auth, {
    uid: claims.uid,
    role: claims.role,
    scope: 'session',
    epoch: claims.epoch,
  });
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, legacySession)).status, 200,
    'existing browser sessions signed by older builds keep working until normal expiry');

  const legacyStream = legacySignedToken(srv.auth, {
    uid: claims.uid,
    scope: 'stream',
    sub: 'music:AAAAAAAAAAA',
    epoch: claims.epoch,
  });
  assert.strictEqual((await httpRaw(srv.port, `/api/music/stream/AAAAAAAAAAA?t=${legacyStream}`)).status, 401,
    'old raw-secret stream URLs are not accepted on playback routes');
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

test('profiles: avatars — builtin pick validated, uploads sanitized, serving tokenized + cross-user isolated', async () => {
  // A profile born with a builtin avatar carries it in the public shape.
  const add = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'Foxy', level: 2, avatar: 'av01' }, admin);
  assert.strictEqual(add.status, 200);
  assert.strictEqual(add.json.avatar, 'av01');
  const pid = add.json.id;

  // EVERY profile has a face: one created with no avatar (and any pre-avatar-era profile) gets a
  // stable id-derived builtin — no bare letter tiles anywhere, same face on every device.
  const plain = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'OldTimer', level: 3 }, admin);
  assert.match(plain.json.avatar, /^av(0[1-9]|1\d|20)$/, 'avatar-less profiles derive a stable builtin face');
  const again = (await httpJson(srv.port, 'GET', '/api/me', null, admin)).json.profiles.find((p) => p.id === plain.json.id);
  assert.strictEqual(again.avatar, plain.json.avatar, 'the derived face is stable across reads');
  await httpJson(srv.port, 'POST', `/api/me/profiles/${plain.json.id}/delete`, { password: 'hunter22' }, admin);

  // Builtin pick: valid ids swap, junk is rejected, and 'custom' can NOT be claimed without an
  // upload (otherwise a profile could point at an image that was never stored/sanitized).
  const picked = await httpJson(srv.port, 'POST', `/api/me/profiles/${pid}/avatar`, { avatar: 'av13' }, admin);
  assert.strictEqual(picked.status, 200);
  assert.strictEqual(picked.json.avatar, 'av13');
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${pid}/avatar`, { avatar: 'av99' }, admin)).status, 400);
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${pid}/avatar`, { avatar: 'custom' }, admin)).status, 400);
  assert.strictEqual((await httpJson(srv.port, 'POST', `/api/me/profiles/${pid}/avatar`, { avatar: '../../etc' }, admin)).status, 400);

  // Upload: content type comes from the BYTES. Garbage magic is rejected; a real JPEG header lands.
  const junk = Buffer.alloc(4096, 0x41); // 'AAAA…' — not an image
  assert.strictEqual((await httpBinary(srv.port, 'POST', `/api/me/profiles/${pid}/avatar-image`, junk, admin, 'image/jpeg')).status, 400,
    'declared image/jpeg with non-image bytes is rejected (magic sniff, not client content-type)');
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(500, 0x10)]);
  const up = await httpBinary(srv.port, 'POST', `/api/me/profiles/${pid}/avatar-image`, jpeg, admin, 'image/jpeg');
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.json.avatar, 'custom');
  assert.match(up.json.avatarUrl, /^\/api\/avatar\/\w+\/\w+\?t=/, 'custom avatar gets a tokenized serve URL');
  // Oversize is refused before it hits disk (the app resizes to ~256px client-side; 512KB is the
  // hard cap). readBody deliberately DESTROYS the connection on overflow rather than buffering the
  // flood, so the client sees either an error status or a connection reset — both are a rejection.
  const huge = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(600 * 1024, 0x10)]);
  const big = await httpBinary(srv.port, 'POST', `/api/me/profiles/${pid}/avatar-image`, huge, admin, 'image/jpeg')
    .catch((e) => ({ status: 0, reset: e && e.code === 'ECONNRESET' }));
  assert.ok(big.status >= 400 || big.reset, `oversize upload rejected (status=${big.status} reset=${!!big.reset})`);

  // Serving: the tokenized URL works with NO auth header (an <img> can't send one) and the
  // sniffed content type comes back; the same token cannot be replayed against a different pid.
  const got = await httpRaw(srv.port, up.json.avatarUrl);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.headers['content-type'], 'image/jpeg');
  assert.ok(got.body.equals(jpeg), 'served bytes are exactly the stored upload');
  const tok = up.json.avatarUrl.split('?t=')[1];
  const uid = up.json.avatarUrl.split('/')[3];
  assert.strictEqual((await httpRaw(srv.port, `/api/avatar/${uid}/deadbeef?t=${tok}`)).status, 401,
    'a stream token minted for one avatar is rejected on another');

  // Cross-user: another account's SESSION token cannot browse this user's avatar.
  const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
  const other = await httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name: 'peeper', password: 'peep-pass' });
  assert.strictEqual(other.status, 200);
  const denied = await httpRaw(srv.port, `/api/avatar/${uid}/${pid}?t=${other.json.token}`);
  assert.strictEqual(denied.status, 403, 'another user cannot read my profile picture with their session token');

  // Switching back to a builtin (or deleting the profile) removes the stored image.
  await httpJson(srv.port, 'POST', `/api/me/profiles/${pid}/avatar`, { avatar: 'av05' }, admin);
  assert.strictEqual((await httpRaw(srv.port, up.json.avatarUrl)).status, 404, 'leaving custom drops the stored image');
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
    const lean = await httpJson(srv.port, 'GET', '/api/iptv/channels?lean=1', null, admin);
    assert.strictEqual(lean.json.channels.length, 2);
    assert.ok(lean.json.channels.every((c) => c.streamUrl === undefined && c.nativeUrl === undefined),
      'lean channel payload should not carry per-channel signed playback URLs');
    assert.ok(lean.json.channels.every((c) => c.xtreamId === undefined && c.tvgId === undefined && c.sourceRawId === undefined),
      'lean channel payload should keep provider bookkeeping server-side');
    const gzLean = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: srv.port, path: '/api/iptv/channels?lean=1', method: 'GET',
        headers: { authorization: `Bearer ${admin}`, 'accept-encoding': 'gzip' },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(gzLean.status, 200);
    assert.strictEqual(gzLean.headers['content-encoding'], 'gzip', 'large JSON API responses should gzip when clients accept it');
    assert.strictEqual(JSON.parse(zlib.gunzipSync(gzLean.body).toString('utf8')).channels.length, 2);
    const selected = lean.json.channels[0];
    const play = await httpJson(srv.port, 'GET', `/api/iptv/play/${selected.idx}?cid=${encodeURIComponent(selected.id)}`, null, admin);
    assert.strictEqual(play.status, 200);
    assert.match(play.json.streamUrl, /^\/api\/iptv\/stream\/\d+\?cid=[^&]+&t=/);
    assert.match(play.json.nativeUrl, /^\/api\/iptv\/native\/\d+\?cid=[^&]+&t=/);
    assert.strictEqual(play.json.nativeMime, 'application/x-mpegURL');
    const changed = await httpJson(srv.port, 'GET', `/api/iptv/play/${selected.idx}?cid=wrong-channel`, null, admin);
    assert.strictEqual(changed.status, 404, 'per-channel playback minting should reject stale channel ids');
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
    assert.strictEqual(brokenHits, 3, 'native proxy keeps provider-protection retries bounded to approved player identities');
    const repeat = await httpRaw(srv.port, ch.json.channels[0].nativeUrl);
    assert.strictEqual(repeat.status, 403, 'cached native failure keeps the same status');
    assert.strictEqual(brokenHits, 3, 'cached provider rejections prevent Exo retry storms from hammering upstream again');
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
  const os = require('os');
  const hiddenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-hidden-lib-'));
  const hiddenMovieDir = path.join(hiddenRoot, 'Hidden Film (2026)');
  fs.mkdirSync(hiddenMovieDir, { recursive: true });
  fs.writeFileSync(path.join(hiddenMovieDir, 'hidden.mp4'), 'HIDDEN-BYTES');
  const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70]);
  fs.writeFileSync(path.join(hiddenMovieDir, 'poster.jpg'), JPEG);
  const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: { maxResolutionRank: 3 } }, admin);
  const acc = await httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name: 'libuser', password: 'pw1234' });
  assert.strictEqual(acc.status, 200);
  sharedUser = { token: acc.json.token, id: acc.json.user.id };

  const hidden = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'HiddenLib', kind: 'other', path: hiddenRoot, users: ['someoneelse'] }, admin);
  const shared = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'SharedLib', kind: 'other', users: [sharedUser.id] }, admin);
  assert.strictEqual((await runScan(hidden.json.id)).status, 200);

  const seen = (await httpJson(srv.port, 'GET', '/api/libraries', null, sharedUser.token)).json.map((l) => l.name);
  assert.ok(!seen.includes('HiddenLib'), 'excluded user cannot see the restricted library');
  assert.ok(seen.includes('SharedLib'), 'allow-listed user sees the shared library');
  const adminSeen = (await httpJson(srv.port, 'GET', '/api/libraries', null, admin)).json.map((l) => l.name);
  assert.ok(adminSeen.includes('HiddenLib'), 'admin always sees everything');
  // Items endpoint is gated too (it mints the local stream/art tokens).
  assert.strictEqual((await httpJson(srv.port, 'GET', `/api/libraries/${hidden.json.id}/items`, null, sharedUser.token)).status, 404);
  assert.strictEqual((await httpJson(srv.port, 'GET', `/api/libraries/${shared.json.id}/items`, null, sharedUser.token)).status, 200);
  const hiddenItems = (await httpJson(srv.port, 'GET', `/api/libraries/${hidden.json.id}/items`, null, admin)).json.items;
  const hiddenMovie = hiddenItems.find((i) => i.kind === 'movie');
  assert.ok(hiddenMovie && hiddenMovie.streamUrl && hiddenMovie.artUrl, 'admin can mint local stream/art URLs for the restricted library');
  assert.strictEqual((await httpRaw(srv.port, hiddenMovie.streamUrl, { token: sharedUser.token })).status, 404,
    'excluded user cannot IDOR the local stream route with a session token');
  assert.strictEqual((await httpRaw(srv.port, hiddenMovie.artUrl, { token: sharedUser.token })).status, 404,
    'excluded user cannot IDOR the local art route with a session token');
  assert.strictEqual((await httpJson(srv.port, 'POST', hiddenMovie.playUrl, { caps: {} }, sharedUser.token)).status, 404,
    'excluded user cannot prepare a restricted local file as a player mount');

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
      <item><title>Quality.Policy.2024.Hybrid.1080p.UHD.BluRay.DDP.Atmos.x265-SQS</title><enclosure url="http://x/quality-1080p-uhd-source" length="12000000000"/></item>
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
  const uhdSource1080 = hd.candidates.find((c) => c.name.includes('Hybrid.1080p.UHD'));
  assert.strictEqual(uhdSource1080.attributes.resolution, '1080p',
    'a 1080p encode sourced from UHD must still classify as 1080p');

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

  // Speed + connection-cap probe: connects, opens connections, returns a measurement shape.
  const speed = (await httpJson(srv.port, 'POST', '/api/test/provider-speed', { index: 0, maxConns: 6 }, admin)).json;
  assert.strictEqual(speed.ok, true, JSON.stringify(speed));
  assert.ok(speed.connections >= 1 && speed.connections <= 6, 'opened a bounded number of probe connections');
  assert.ok('connCap' in speed && 'mbpsPerConn' in speed && 'mbpsTotal' in speed && 'configured' in speed,
    'returns configured-count + cap + throughput fields');
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/test/provider-speed', { index: 9 }, admin)).status, 400,
    'out-of-range provider index 400s');

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

test('subtitles: diagnostic URL redaction never leaks the Wyzie API key', () => {
  const opensubs = require('../server/opensubs');
  const redact = opensubs._redactSubUrl;
  const out = redact('https://sub.wyzie.io/search?id=tt1234567&key=SUPERSECRETKEY&language=en');
  assert.ok(!/SUPERSECRETKEY/.test(out), 'redacted URL must not contain the API key');
  assert.match(out, /key=\*\*\*/, 'key param should be masked');
  assert.match(out, /id=tt1234567/, 'non-secret params should remain for debugging');
  // Malformed/relative inputs must still be scrubbed by the regex fallback.
  const messy = redact('search?id=5&key=ANOTHERSECRET&x=1');
  assert.ok(!/ANOTHERSECRET/.test(messy), 'fallback path must also mask the key');
});

test('subtitles: ISO 639-2 B/T codes normalize to the 639-1 code Wyzie expects', () => {
  const opensubs = require('../server/opensubs');
  const to1 = opensubs._toIso6391;
  // The dual-code pairs ffprobe emits as the Bibliographic (B) variant must not be truncated.
  const pairs = { cze: 'cs', ces: 'cs', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr',
    gre: 'el', ell: 'el', per: 'fa', fas: 'fa', chi: 'zh', zho: 'zh', dut: 'nl', nld: 'nl' };
  for (const [code, want] of Object.entries(pairs)) {
    assert.strictEqual(to1(code), want, `${code} must map to ${want}, not a truncated/own code`);
  }
  assert.strictEqual(to1('eng'), 'en', 'common single 639-2 code maps to 639-1');
  assert.strictEqual(to1('en'), 'en', 'existing 639-1 codes pass through');
  assert.strictEqual(to1('pt-BR'), 'pt', 'BCP 47 tags reduce to the primary subtag');
  assert.strictEqual(to1('zh-Hans'), 'zh', 'script-tagged codes reduce to the primary subtag');
  assert.strictEqual(to1('zzz'), '', 'unknown 3-letter codes return empty so callers fall back deliberately');
  assert.strictEqual(to1(''), '', 'blank is empty');
});

test('subtitles: alass auto-sync is gated — absent binary stays inert', () => {
  const transcode = require('../server/transcode');
  // On CI/dev boxes alass is not installed, so detection must be null (feature off) and
  // spawnSubSync must refuse rather than spawn a missing binary — the auto-sync path can never
  // run unless the sidecar is actually present.
  assert.strictEqual(transcode.detectSubSync(), null, 'no alass binary → detection null');
  assert.throws(() => transcode.spawnSubSync('http://x/stream', '/tmp/in.srt', '/tmp/out.srt'),
    /alass not available/, 'spawnSubSync refuses when the binary is absent');
});

test('subtitles: subtitleLooksSynced skips sync for release/hash matches, runs it otherwise', () => {
  const opensubs = require('../server/opensubs');
  const looks = opensubs.subtitleLooksSynced;
  const rel = 'The.Movie.2024.1080p.BluRay.x264-GROUP';
  assert.strictEqual(looks({ moviehashMatch: true }, rel), true, 'hash-exact is in sync');
  assert.strictEqual(looks({ matchedRelease: 'whatever' }, rel), true, 'provider release match is in sync');
  assert.strictEqual(looks({ display: 'The.Movie.2024.1080p.BluRay.x264-GROUP.srt' }, rel), true,
    'matching release key is in sync');
  assert.strictEqual(looks({ display: 'Totally.Different.Release.720p.WEB-Damn' }, rel), false,
    'a non-matching release needs sync correction');
  assert.strictEqual(looks({}, ''), false, 'no signal → not assumed synced');
  // A merely-overlapping name (same lineage, DIFFERENT cut/edit) must NOT be assumed in sync — that
  // loose substring match is exactly what left Wyzie subs a couple seconds off. It must fall through
  // to alass instead of being trusted, so subtitleLooksSynced returns false here.
  assert.strictEqual(looks({ display: 'The.Movie.2024.1080p.BluRay.x264-GROUP.EXTENDED.CUT' }, rel), false,
    'a different cut of the same release lineage is NOT assumed in sync (name overlap ≠ in-sync timing)');
  // Same release key but a different SOURCE class (WEB vs BluRay) is a different encode → not synced.
  assert.strictEqual(looks({ display: 'The.Movie.2024.1080p.WEB-DL.x264-GROUP' }, rel), false,
    'a different source (WEB vs BluRay) of the same title is not assumed in sync');
});

test('subtitles: OpenSubtitles moviehash search → login → download → VTT (mock)', async () => {
  const http2 = require('http');
  const opensubs = require('../server/opensubs');
  const reqs = [];
  const srv = http2.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    reqs.push({ path: u.pathname, apiKey: req.headers['api-key'], auth: req.headers.authorization || '' });
    if (u.pathname === '/subtitles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [
        { id: 'A', attributes: { language: 'en', hearing_impaired: false, download_count: 900, from_trusted: true,
          moviehash_match: u.searchParams.get('moviehash') === 'deadbeefdeadbeef', release: 'Movie.2024.1080p.WEB-DL',
          files: [{ file_id: 555, file_name: 'Movie.2024.1080p.WEB-DL.srt' }] } },
      ] }));
    }
    if (u.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ token: 'JWT123', base_url: '' }));
    }
    if (u.pathname === '/download') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ link: `http://127.0.0.1:${srv.address().port}/file.srt`, file_name: 'x.srt', remaining: 17 }));
    }
    if (u.pathname === '/file.srt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n');
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const data = await opensubs.osSearch({ apiKey: 'K', base, moviehash: 'deadbeefdeadbeef', imdbId: 'tt123', lang: 'eng' });
    assert.strictEqual(data.length, 1, 'search returns the result array');
    const norm = opensubs.osNormalize(data[0]);
    assert.strictEqual(norm.moviehashMatch, true, 'moviehash_match is surfaced for hash-exact ranking');
    assert.strictEqual(norm._osFileId, 555, 'file id is captured for download');
    assert.strictEqual(norm._provider, 'opensubtitles');
    const login = await opensubs.osLogin({ apiKey: 'K', username: 'u', password: 'p', base });
    assert.strictEqual(login.token, 'JWT123', 'login yields a bearer token');
    const dl = await opensubs.osDownloadVtt(norm._osFileId, { apiKey: 'K', token: login.token, base });
    assert.match(dl.vtt, /^WEBVTT/, 'download converts SRT to VTT');
    assert.strictEqual(dl.remaining, 17, 'download reports remaining quota');
    // The search sent languages as 639-1 (eng -> en) and the download carried the bearer token.
    assert.ok(reqs.some((r) => r.path === '/download' && r.auth === 'Bearer JWT123'), 'download authorizes with the JWT');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('subtitles: Wyzie search→file→VTT served per mount (and 503 without a key)', async () => {
  const http2 = require('http');
  let osPort;
  let searchCalls = 0;
  const subtitleDownloads = [];
  const subtitleSearches = [];
  const osMock = http2.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/search') {
      searchCalls++;
      subtitleSearches.push({
        id: u.searchParams.get('id'),
        release: u.searchParams.get('release'),
        origin: u.searchParams.get('origin'),
        fileName: u.searchParams.get('fileName'),
        file: u.searchParams.get('file'),
      });
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
  const pickedRelease = play.candidate && play.candidate.name;
  assert.strictEqual(pickedRelease, 'Sec.Test.2024.1080p.WEB-DL.H.264-NTb');
  const mounted = srv.mounts.get(play.id);
  mounted.name = 'Feature.mkv';
  mounted._subQuery = 'Sec Test 2024 S01E03';
  mounted.releaseSubs = [{
    id: 'r0',
    name: 'Sec.Test.2024.en.srt',
    ext: 'srt',
    lang: 'eng',
    size: 48,
    score: 120,
    source: 'release',
  }];
  mounted.readReleaseSub = async (id) => {
    assert.strictEqual(id, 'r0');
    return Buffer.from('1\r\n00:00:05,000 --> 00:00:06,500\r\nRelease subtitle\r\n');
  };

  const tracks = await httpJson(srv.port, 'GET', `/api/tracks/${play.id}`, null, admin);
  assert.strictEqual(tracks.status, 200, JSON.stringify(tracks.json));
  assert.deepStrictEqual((tracks.json.releaseSubs || []).map((s) => ({ id: s.id, name: s.name, lang: s.lang, source: s.source })),
    [{ id: 'r0', name: 'Sec.Test.2024.en.srt', lang: 'eng', source: 'release' }],
    'tracks exposes same-release subtitles without leaking reader internals');
  assert.strictEqual((await httpRaw(srv.port, `/api/releasesub/${play.id}/r0?t=wrong`)).status, 401,
    'release subtitle route requires a stream token bound to this mount');
  const relSub = await httpRaw(srv.port, `/api/releasesub/${play.id}/r0?shift=0.5&t=${play.streamToken}`);
  assert.strictEqual(relSub.status, 200, relSub.body.toString());
  assert.match(relSub.body.toString('utf8'), /^WEBVTT/);
  assert.match(relSub.body.toString('utf8'), /00:00:05\.500 --> 00:00:07\.000/);
  assert.match(relSub.body.toString('utf8'), /Release subtitle/);

  // No key configured → honest 503, not a hang or a fake empty file.
  const no = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=en&tmdb=4242&t=${play.streamToken}`);
  assert.strictEqual(no.status, 503);

  process.env.WYZIE_BASE = `http://127.0.0.1:${osPort}`;
  process.env.TRIBOON_WYZIE_KEY = 'test-key';
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/server')).json.opensubs, true,
    'Wyzie subtitles are enabled by the server-side key fallback');
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
  // We intentionally send Wyzie NO release/file hints: measured on a live key, the hinted lookup is
  // ~2x slower (~10s) and almost always 400s "no matching release", so it only delayed the broad
  // search. Release/episode/edition matching is done LOCALLY in rankSubs, so no search should carry
  // a release hint — and the opaque mounted filename must certainly never leak.
  assert.ok(subtitleSearches.length && subtitleSearches.every((s) => !s.release && !s.origin && !s.fileName && !s.file),
    'Wyzie searches send no release/file hints (the slow hinted path was removed; matching is local)');
  assert.ok(!subtitleSearches.some((s) => s.release === 'Feature.mkv'),
    'generic mounted filenames never leak to Wyzie');
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

  // End-to-end: the PLAYER's episode is authoritative. Even when the mount's remembered query points
  // at a DIFFERENT episode, explicit season/episode on the request reach Wyzie unchanged. (Regression:
  // play routes that never stamped SxxExx into _subQuery searched the whole show — wrong dialogue + a
  // wall of mixed-episode rows.) The Wyzie mock above asserts it receives season=1/episode=3, so this
  // request overriding a deliberately-wrong _subQuery proves the handler forwards the request params.
  mounted._subQuery = 'Sec Test 2024 S01E07';
  const episodeOverride = await httpRaw(srv.port, `/api/ossubs/${play.id}?lang=en&tmdb=4242&season=1&episode=3&t=${play.streamToken}`);
  assert.strictEqual(episodeOverride.status, 200, episodeOverride.body.toString());

  } finally {
    delete process.env.WYZIE_BASE;
    delete process.env.TRIBOON_WYZIE_KEY;
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
<programme channel="news1.x" stop="${stamp(t1)}" start="${stamp(t0)}"><title>Morning Desk</title></programme>
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

test('http server hardening: aborted request bodies and stale sockets are bounded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /function readBody\(req, limit = 50 \* 1024 \* 1024\) \{[\s\S]+setTimeout\(\(\) => \{[\s\S]+fail\('request body timeout', 408\);[\s\S]+\}, 10000\);[\s\S]+req\.once\('aborted', onAborted\);[\s\S]+req\.once\('close', onClose\);/,
    'request body reads should fail on abort/close and have a hard timeout');
  assert.match(src, /res\.shouldKeepAlive = false;/,
    'the local app server should not reuse sockets after player requests');
  assert.match(src, /const server = http\.createServer\(async \(req, res\) => \{[\s\S]+const closeAbortedRequest = \(\) => \{[\s\S]+req\.socket[\s\S]+socket\.destroy\(\)[\s\S]+req\.destroy\(\);[\s\S]+res\.destroy\(\)[\s\S]+\};[\s\S]+req\.on\('aborted', closeAbortedRequest\);[\s\S]+req\.on\('close', \(\) => \{[\s\S]+closeAbortedRequest\(\);[\s\S]+\}\);[\s\S]+if \(e && e\.status === 499\) \{[\s\S]+req\.socket[\s\S]+socket\.destroy\(\)[\s\S]+req\.destroy\(\);[\s\S]+res\.destroy\(\)[\s\S]+return;[\s\S]+\}/,
    'outer request aborts should destroy both sides and avoid writing an error body to a dead socket');
  assert.match(src, /res\.on\('close', \(\) => \{[\s\S]+!res\.writableEnded[\s\S]+req\.socket[\s\S]+socket\.destroy\(\)[\s\S]+\}\);/,
    'stream responses closed before a clean end should not leave server sockets in CloseWait');
  assert.match(src, /server\.requestTimeout = 30000;[\s\S]+server\.headersTimeout = 10000;[\s\S]+server\.keepAliveTimeout = 5000;[\s\S]+server\.maxRequestsPerSocket = 1;[\s\S]+server\.on\('clientError', \(err, socket\) => \{[\s\S]+socket\.destroy\(\)/,
    'HTTP sockets should have explicit server-level timeouts and client-error cleanup');
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

test('stream tokens: stable cache tokens stay under the 6h validity window', () => {
  const uid = srv.auth.verifyToken(admin, 'session').uid;
  const realNow = Date.now;
  const base = Date.UTC(2026, 0, 1, 3, 10, 0);
  try {
    Date.now = () => base;
    const first = srv.auth.stableStreamToken(uid, 'art:library:7');
    Date.now = () => base + 30 * 60 * 1000;
    const sameBucket = srv.auth.stableStreamToken(uid, 'art:library:7');
    assert.strictEqual(sameBucket, first, 'same URL inside the one-hour cache bucket');

    const claims = JSON.parse(Buffer.from(first.split('.')[0], 'base64url').toString('utf8'));
    assert.ok(claims.exp > base, 'token is usable after minting');
    assert.ok(claims.exp <= base + 6 * 3600 * 1000, 'stable token never exceeds the 6h stream-token TTL');

    Date.now = () => base + 61 * 60 * 1000;
    const nextBucket = srv.auth.stableStreamToken(uid, 'art:library:7');
    assert.notStrictEqual(nextBucket, first, 'cache URL rotates after the stable bucket');
  } finally {
    Date.now = realNow;
  }
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
  assert.match(ytmusic._friendlyYtdlpError('ERROR: HTTP Error 429: Too Many Requests').message, /rate-limited/i);
  assert.match(ytmusic._friendlyYtdlpError('ERROR: Sign in to confirm you are not a bot').message, /bot-protection/i);
  assert.match(ytmusic._friendlyYtdlpError('ERROR: HTTP Error 403: Forbidden').message, /rejected/i);
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

test('music: optional ytmusicapi catalog search is fast-path normalized and bounded', async () => {
  const ytmusic = require('../server/ytmusic');
  const calls = [];
  try {
    ytmusic._setYtMusicApiRunnerForTest(async (action, body) => {
      calls.push({ action, body });
      return {
        rows: [
          {
            videoId: 'AAAAAAAAAAA',
            title: 'Around the World (Official Audio)',
            artists: [{ name: 'Daft Punk' }],
            album: { name: 'Homework' },
            duration: '7:10',
            thumbnails: [
              { url: 'small.jpg', width: 120, height: 90 },
              { url: 'large.jpg', width: 544, height: 544 },
            ],
          },
          { videoId: 'bad', title: 'Bad row' },
        ],
      };
    });
    const rows = await ytmusic.search('  Daft Punk  ', { limit: 5 });
    assert.deepStrictEqual(calls, [{ action: 'search', body: { query: 'Daft Punk', limit: 5 } }]);
    assert.deepStrictEqual(rows, [{
      id: 'AAAAAAAAAAA',
      title: 'Around the World',
      artist: 'Daft Punk',
      duration: 430,
      thumb: 'large.jpg',
      album: 'Homework',
      source: 'ytmusicapi',
    }]);
  } finally {
    ytmusic._setYtMusicApiRunnerForTest(null);
    ytmusic._resetYtMusicApiDetection();
  }
});

test('music: artwork URLs prefer TV-sized covers over tiny YTM thumbnails', () => {
  const ytmusic = require('../server/ytmusic');
  const track = ytmusic._normalizeYtMusicApiTrack({
    videoId: 'AAAAAAAAAAA',
    title: 'Digital Love',
    artists: [{ name: 'Daft Punk' }],
    thumbnails: [
      { url: 'https://lh3.googleusercontent.com/album-art=w60-h60-l90-rj', width: 60, height: 60 },
      { url: 'https://lh3.googleusercontent.com/album-art=w120-h120-l90-rj', width: 120, height: 120 },
    ],
  });
  assert.strictEqual(track.thumb, 'https://lh3.googleusercontent.com/album-art=w640-h640-l90-rj');
  assert.strictEqual(
    ytmusic._upgradeThumbUrl('https://i.ytimg.com/vi/AAAAAAAAAAA/default.jpg'),
    'https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg',
    'flat yt-dlp thumbnail fallbacks should avoid the smallest YouTube still'
  );
  assert.strictEqual(
    ytmusic._upgradeThumbUrl('https://lh3.googleusercontent.com/plain=w120-h120'),
    'https://lh3.googleusercontent.com/plain=w640-h640'
  );
});

test('music: search cleanup dedupes flat yt-dlp rows and pushes obvious non-songs down', () => {
  const ytmusic = require('../server/ytmusic');
  const rows = ytmusic._cleanSearchRows([
    { id: 'AAAAAAAAAAA', title: 'One More Time (Radio Edit)', artist: '', thumb: 'a.jpg' },
    { id: 'BBBBBBBBBBB', title: 'Harder, Better, Faster, Stronger', artist: '', thumb: 'b.jpg' },
    { id: 'CCCCCCCCCCC', title: 'Technologic', artist: '', thumb: 'c.jpg' },
    { id: 'DDDDDDDDDDD', title: 'Technologic (Official Audio)', artist: '', thumb: 'd.jpg' },
    { id: 'EEEEEEEEEEE', title: 'Daft Punk - Veridis Quo', artist: '', thumb: 'e.jpg' },
    { id: 'FFFFFFFFFFF', title: 'How I Played on Thriller and Daft Punk Biggest Hit', artist: '', thumb: 'f.jpg' },
  ], 'Daft Punk', 10);
  assert.deepStrictEqual(rows.map((r) => r.id), ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC', 'EEEEEEEEEEE']);
  assert.strictEqual(rows.find((r) => r.id === 'EEEEEEEEEEE').title, 'Veridis Quo');
  assert.strictEqual(rows.find((r) => r.id === 'EEEEEEEEEEE').artist, 'Daft Punk');
  assert.strictEqual(rows[0].artist, 'Daft Punk', 'artist-looking searches fill missing flat yt-dlp artist metadata');
  assert.ok(!rows.some((r) => r.id === 'FFFFFFFFFFF'), 'obvious non-song rows are dropped once enough song-like results exist');
});

test('music: optional ytmusicapi watch queue returns tokenized radio tracks', async () => {
  const ytmusic = require('../server/ytmusic');
  const oldDetect = ytmusic.detectYtdlp;
  try {
    ytmusic.detectYtdlp = () => ({ cmd: ['mock-ytdlp'], version: 'test' });
    ytmusic._setYtMusicApiRunnerForTest(async (action, body) => {
      assert.strictEqual(action, 'watch');
      assert.deepStrictEqual(body, { id: 'AAAAAAAAAAA', limit: 2 });
      return {
        playlistId: 'RDAMVMAAAAAAAAAAA',
        rows: [
          { videoId: 'BBBBBBBBBBB', title: 'Track B', artists: [{ name: 'Artist B' }], duration: '3:01' },
          { videoId: 'CCCCCCCCCCC', title: 'Track C', artists: [{ name: 'Artist C' }], duration: '4:02' },
        ],
      };
    });
    const r = await httpJson(srv.port, 'GET', '/api/music/radio/AAAAAAAAAAA?limit=2', null, admin);
    assert.strictEqual(r.status, 200, r.raw);
    assert.strictEqual(r.json.playlistId, 'RDAMVMAAAAAAAAAAA');
    assert.deepStrictEqual(r.json.results.map((x) => x.id), ['BBBBBBBBBBB', 'CCCCCCCCCCC']);
    assert.ok(/^\/api\/music\/stream\/BBBBBBBBBBB\?t=/.test(r.json.results[0].streamUrl));
    assert.strictEqual(r.json.results[0].duration, 181);
  } finally {
    ytmusic.detectYtdlp = oldDetect;
    ytmusic._setYtMusicApiRunnerForTest(null);
    ytmusic._resetYtMusicApiDetection();
  }
});

test('music: cookie link loads playlists + personalized home through ytmusicapi browser auth', async () => {
  const ytmusic = require('../server/ytmusic');
  const oldDetect = ytmusic.detectYtdlp;
  const calls = [];
  // An exported music.youtube.com session (Netscape cookies.txt) carrying the __Secure-3PAPISID
  // cookie ytmusicapi signs requests with.
  const cookieText = [
    '# Netscape HTTP Cookie File',
    ['.youtube.com', 'TRUE', '/', 'TRUE', '9999999999', '__Secure-3PAPISID', 'sapisid-value'].join('\t'),
    ['.youtube.com', 'TRUE', '/', 'TRUE', '9999999999', 'SAPISID', 'sapisid-value'].join('\t'),
  ].join('\n') + '\n';
  try {
    ytmusic.detectYtdlp = () => ({ cmd: ['mock-ytdlp'], version: 'test' });
    ytmusic._setYtMusicApiRunnerForTest(async (action, body) => {
      calls.push({ action, body });
      // The library/home calls must be BROWSER-authed from the user's cookies (no OAuth) — the
      // headers must carry the signing cookie so ytmusicapi can read the private library.
      assert.ok(body.browserAuth && /__Secure-3PAPISID=sapisid-value/.test(body.browserAuth.cookie),
        `${action} must pass browser-auth cookies`);
      if (action === 'library_playlists') return { rows: [{ playlistId: 'PLROAD123', title: 'Road Mix', count: 12 }] };
      if (action === 'home') {
        return { rows: [{ title: 'Mixed for you', contents: [
          { videoId: 'EEEEEEEEEEE', title: 'Mine A', artists: [{ name: 'X' }] },
          { videoId: 'FFFFFFFFFFF', title: 'Mine B', artists: [{ name: 'Y' }] },
          { videoId: 'GGGGGGGGGGG', title: 'Mine C', artists: [{ name: 'Z' }] },
        ] }] };
      }
      if (action === 'playlist') {
        assert.strictEqual(body.id, 'PLROAD123');
        return {
          title: 'Road Mix',
          rows: [
            { videoId: 'BBBBBBBBBBB', title: 'First', artists: [{ name: 'One' }], duration: '3:01' },
            { videoId: 'CCCCCCCCCCC', title: 'Second', artists: [{ name: 'Two' }], duration: '4:02' },
            { videoId: 'DDDDDDDDDDD', title: 'Third', artists: [{ name: 'Three' }], duration: '5:03' },
          ],
        };
      }
      throw new Error(`unexpected ytmusicapi action ${action}`);
    });

    const linked = await httpJson(srv.port, 'POST', '/api/music/link', { cookies: cookieText }, admin);
    assert.strictEqual(linked.status, 200, linked.raw);
    const status = await httpJson(srv.port, 'GET', '/api/music/status', null, admin);
    assert.strictEqual(status.json.linkSource, 'account');
    assert.strictEqual(status.json.linked, true);
    // The cookie credential must never round-trip back to a client.
    assert.strictEqual(JSON.stringify(status.json).includes('sapisid-value'), false, 'cookies never return to the client');

    const playlists = await httpJson(srv.port, 'GET', '/api/music/playlists', null, admin);
    assert.strictEqual(playlists.status, 200, playlists.raw);
    assert.strictEqual(playlists.json.linkSource, 'account');
    assert.deepStrictEqual(playlists.json.playlists.map((p) => ({ id: p.id, title: p.title })), [{ id: 'PLROAD123', title: 'Road Mix' }]);
    const playlistsAgain = await httpJson(srv.port, 'GET', '/api/music/playlists', null, admin);
    assert.strictEqual(playlistsAgain.status, 200, playlistsAgain.raw);
    assert.strictEqual(calls.filter((c) => c.action === 'library_playlists').length, 1,
      'linked Music playlist list should be cached across quick re-entries');
    assert.strictEqual(calls.find((c) => c.action === 'library_playlists').body.limit, 36,
      'linked Music playlist list should stay bounded so the Music page opens quickly');

    const page = await httpJson(srv.port, 'GET', '/api/music/playlist/PLROAD123?limit=2&offset=1', null, admin);
    assert.strictEqual(page.status, 200, page.raw);
    assert.strictEqual(page.json.title, 'Road Mix');
    assert.deepStrictEqual(page.json.results.map((x) => x.id), ['CCCCCCCCCCC', 'DDDDDDDDDDD']);
    assert.ok(/^\/api\/music\/stream\/CCCCCCCCCCC\?t=/.test(page.json.results[0].streamUrl));

    await httpJson(srv.port, 'POST', '/api/music/unlink', {}, admin);
  } finally {
    ytmusic.detectYtdlp = oldDetect;
    ytmusic._setYtMusicApiRunnerForTest(null);
    ytmusic._resetYtMusicApiDetection();
  }
});

test('music: search uses ytmusicapi even for linked (cookie) users, returning the full result set', async () => {
  const ytmusic = require('../server/ytmusic');
  try {
    let sawAction = null;
    ytmusic._setYtMusicApiRunnerForTest(async (action) => {
      sawAction = action;
      if (action === 'search') {
        return { rows: Array.from({ length: 30 }, (_, i) => ({ videoId: 'v' + String(i).padStart(10, '0'), title: 'Song ' + i, artists: [{ name: 'Artist ' + i }] })) };
      }
      return { rows: [] };
    });
    // cookiesPath is set (linked user) — search must STILL go through ytmusicapi, not the yt-dlp
    // scrape that topped out ~12 results.
    const rows = await ytmusic.search('anything', { limit: 40, cookiesPath: '/tmp/whatever-cookies.txt' });
    assert.strictEqual(sawAction, 'search', 'linked search should run through ytmusicapi');
    assert.ok(rows.length > 12, `search should return the full result set, got ${rows.length}`);
  } finally {
    ytmusic._setYtMusicApiRunnerForTest(null);
    ytmusic._resetYtMusicApiDetection();
  }
});

test('play/prepare: age gate blocks a restricted profile from over-level titles (server-side)', async () => {
  await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'gate-test-key' }, admin);
  const kid = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'GateKid', level: 0 }, admin);
  const kidId = kid.json.id;
  assert.ok(kidId, 'kid profile created');
  // R-rated (mock movie 990001) for a Kids profile → 403. prepare refuses BEFORE any pipeline work;
  // play runs the cert lookup IN PARALLEL with search+mount but the denial still wins (and never
  // sends a playable payload), whether the pipeline succeeds or fails first.
  for (const path of ['/api/play', '/api/prepare']) {
    const blocked = await httpJson(srv.port, 'POST', path, { q: 'Restricted Movie', tmdbId: 990001, mediaType: 'movie', profileId: kidId }, admin);
    assert.strictEqual(blocked.status, 403, `${path} should block R for kids: ${blocked.raw}`);
    assert.strictEqual(blocked.json.restricted, true, `${path} flags the block as a maturity restriction`);
  }
  // G-rated (mock movie 990002) for the same Kids profile → the gate does NOT block it.
  const okKid = await httpJson(srv.port, 'POST', '/api/prepare', { q: 'Kid Movie', tmdbId: 990002, mediaType: 'movie', profileId: kidId }, admin);
  assert.notStrictEqual(okKid.status, 403, 'G-rated is allowed for a kids profile');
  // R-rated with NO profile context (account/adult) → unrestricted.
  const adultOk = await httpJson(srv.port, 'POST', '/api/prepare', { q: 'Restricted Movie', tmdbId: 990001, mediaType: 'movie' }, admin);
  assert.notStrictEqual(adultOk.status, 403, 'no profile context = unrestricted (adult/account)');
  // A PROVIDED but bogus/spoofed profileId must fail CLOSED (strictest), not silently default to
  // adult — otherwise a tampered client could bypass the gate by sending an id that matches nothing.
  const spoofed = await httpJson(srv.port, 'POST', '/api/prepare', { q: 'Restricted Movie', tmdbId: 990001, mediaType: 'movie', profileId: 'no-such-profile-id' }, admin);
  assert.strictEqual(spoofed.status, 403, 'an unknown profileId fails closed to the strictest level');
  assert.strictEqual(spoofed.json.restricted, true, 'the spoofed-profile block is a maturity restriction');
});

test('settings: a TMDB key the API rejects fails the save with an actionable error (no false "connected")', async () => {
  // A mistyped key used to save fine and read "connected" everywhere (status checks presence only)
  // — the new host discovered it as an inexplicably empty Home page.
  const bad = await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'bad-tmdb-key' }, admin);
  assert.strictEqual(bad.status, 400, `rejected key must fail the save: ${bad.raw}`);
  assert.match(bad.json.error, /TMDB rejected/i, 'the error tells the admin what to fix');
  const good = await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'fresh-valid-key' }, admin);
  assert.strictEqual(good.status, 200, 'a key TMDB accepts saves normally');
  // Restore the shared key later tests rely on.
  await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'gate-test-key' }, admin);
});

test('local libraries: the age gate covers local plays too (a Kids profile cannot mount an R-rated file)', async () => {
  // Local playback used to skip maturity entirely while usenet play/prepare enforced it — a Kids
  // profile could play ANY file in an attached library. The gate reads the item's TMDB identity
  // from the SERVER-side scan record (NFO uniqueid here), never from the client body.
  await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'gate-test-key' }, admin);
  const kid = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'LocalGateKid', level: 0 }, admin);
  const kidId = kid.json.id;
  assert.ok(kidId, 'kid profile created');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-agegate-lib-'));
  const mkMovie = (dirName, fileBase, tmdbId) => {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${fileBase}.mp4`), 'LOCAL-MOVIE-BYTES');
    fs.writeFileSync(path.join(dir, `${fileBase}.nfo`),
      `<movie><uniqueid type="tmdb">${tmdbId}</uniqueid></movie>`);
  };
  mkMovie('Blocked Film (2026)', 'blocked', 990001); // mock TMDB: R-rated
  mkMovie('Fine Film (2026)', 'fine', 990002);       // mock TMDB: G-rated
  mkMovie('Hardcore Film (2026)', 'nc17', 990003);   // mock TMDB: NC-17 (above R)
  const lib = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'AgeGateLib', kind: 'other', path: root }, admin);
  try {
    assert.strictEqual((await runScan(lib.json.id)).status, 200);
    const items = (await httpJson(srv.port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items;
    const rated = (id) => items.find((i) => i.kind === 'movie' && i.tmdbId === id);
    const blocked = rated(990001), fine = rated(990002), nc17 = rated(990003);
    assert.ok(blocked && blocked.playUrl && fine && fine.playUrl && nc17 && nc17.playUrl, 'all three movies scanned with their NFO tmdb ids');
    // Kids (G) profile: R blocked with the same restricted shape as usenet play; G allowed.
    const deny = await httpJson(srv.port, 'POST', blocked.playUrl, { caps: {}, profileId: kidId }, admin);
    assert.strictEqual(deny.status, 403, `kids profile must not mount the R-rated local file: ${deny.raw}`);
    assert.strictEqual(deny.json.restricted, true, 'flagged as a maturity restriction');
    const allow = await httpJson(srv.port, 'POST', fine.playUrl, { caps: {}, profileId: kidId }, admin);
    assert.strictEqual(allow.status, 200, `G-rated local file plays for kids: ${allow.raw}`);
    assert.ok(allow.json.streamUrl, 'allowed mount returns a playable payload');
    // Promote the SAME profile to R (level 3) via PATCH (avoids the 8-profile account cap) and confirm
    // the RESTRICTED-tier local gate: R may play R, but NC-17 (above R) must still be blocked. This is
    // the regression the `level < 4` fix closes — the old `level < 3` let a tier-3 profile skip the gate.
    const toR = await httpJson(srv.port, 'PATCH', `/api/me/profiles/${kidId}`, { password: 'hunter22', level: 3 }, admin);
    assert.strictEqual(toR.json.level, 3, 'profile promoted to the R tier');
    const rPlaysR = await httpJson(srv.port, 'POST', blocked.playUrl, { caps: {}, profileId: kidId }, admin);
    assert.strictEqual(rPlaysR.status, 200, `R profile may play an R local file: ${rPlaysR.raw}`);
    const rDenyNc17 = await httpJson(srv.port, 'POST', nc17.playUrl, { caps: {}, profileId: kidId }, admin);
    assert.strictEqual(rDenyNc17.status, 403, `R profile must NOT mount an NC-17 local file (localPlay gate covers restricted tiers, not just Kids): ${rDenyNc17.raw}`);
    assert.strictEqual(rDenyNc17.json.restricted, true, 'NC-17 block flagged as a maturity restriction');
    // No profile context (account owner) stays unrestricted; a spoofed profileId fails closed.
    const owner = await httpJson(srv.port, 'POST', blocked.playUrl, { caps: {} }, admin);
    assert.strictEqual(owner.status, 200, 'owner (no profile) is unrestricted for local plays');
    const spoofedLocal = await httpJson(srv.port, 'POST', blocked.playUrl, { caps: {}, profileId: 'bogus-profile' }, admin);
    assert.strictEqual(spoofedLocal.status, 403, 'unknown profileId fails closed on local plays too');
  } finally {
    await httpJson(srv.port, 'DELETE', `/api/libraries/${lib.json.id}`, null, admin);
  }
});

test('music: yt-dlp work is globally queued so home/search reloads cannot fan out unbounded processes', async () => {
  const ytmusic = require('../server/ytmusic');
  const seen = [];
  const jobs = Array.from({ length: ytmusic._queueStats().concurrency + 4 }, (_, i) => ytmusic._withYtdlpSlot(async () => {
    seen.push(ytmusic._queueStats().active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return i;
  }));
  await Promise.all(jobs);
  assert.ok(seen.length >= 4, 'test should exercise queued work');
  assert.ok(Math.max(...seen) <= ytmusic._queueStats().concurrency, 'active yt-dlp jobs stay capped');
  assert.strictEqual(ytmusic._queueStats().active, 0, 'queue releases every slot after work completes');

  const releases = [];
  let started = 0;
  let startedResolve;
  const startedAll = new Promise((resolve) => { startedResolve = resolve; });
  const blockers = Array.from({ length: ytmusic._queueStats().concurrency }, () => ytmusic._withYtdlpSlot(() => new Promise((resolve) => {
    releases.push(resolve);
    started++;
    if (started >= ytmusic._queueStats().concurrency) startedResolve();
  })));
  await startedAll;
  const order = [];
  const lowA = ytmusic._withYtdlpSlot(async () => { order.push('low-a'); });
  const lowB = ytmusic._withYtdlpSlot(async () => { order.push('low-b'); });
  const high = ytmusic._withYtdlpSlot(async () => { order.push('high-play'); }, { priority: 10 });
  releases.forEach((release) => release());
  await Promise.all([...blockers, lowA, lowB, high]);
  assert.strictEqual(order[0], 'high-play', 'active playback resolve should start before queued background searches');
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
  assert.strictEqual(st2.json.linkSource, 'account', 'status distinguishes account cookies from server fallback');
  assert.strictEqual(st2.json.needsRelink, false, 'freshly linked cookies should not look expired');
  assert.strictEqual(JSON.stringify(st2.json).includes('abc123'), false, 'cookie text NEVER returns to a client');
  // The credential lands ENCRYPTED in settings, not as a plaintext file in data/.
  assert.ok(!fs.existsSync(path.join(process.env.TRIBOON_DATA, 'yt-cookies.txt')), 'no plaintext cookie file written to data/');
  const oldDetect2 = ytmusic.detectYtdlp;
  const oldList = ytmusic.listPlaylists;
  try {
    ytmusic.detectYtdlp = () => ({ cmd: ['mock-ytdlp'], version: 'test' });
    ytmusic.listPlaylists = async () => { throw new Error('cookies expired'); };
    const expired = await httpJson(srv.port, 'GET', '/api/music/playlists', null, admin);
    assert.strictEqual(expired.status, 502);
    const stExpired = await httpJson(srv.port, 'GET', '/api/music/status', null, admin);
    assert.strictEqual(stExpired.json.linked, true, 'expired cookies are still a linked account, not never-linked');
    assert.strictEqual(stExpired.json.needsRelink, true, 'playlist failures mark the link as needing relink');
    assert.match(stExpired.json.linkIssue.message, /cookies expired/);
  } finally {
    ytmusic.detectYtdlp = oldDetect2;
    ytmusic.listPlaylists = oldList;
  }
  await httpJson(srv.port, 'POST', '/api/music/unlink', {}, admin);
  const stUnlinked = await httpJson(srv.port, 'GET', '/api/music/status', null, admin);
  assert.strictEqual(stUnlinked.json.linked, false, 'unlink clears it');
  assert.strictEqual(stUnlinked.json.linkSource, 'none');
  assert.strictEqual(stUnlinked.json.needsRelink, false);
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

test('music: stream proxy recovers from a stale (403) googlevideo URL by re-resolving', async () => {
  const ytmusic = require('../server/ytmusic');
  const oldDetect = ytmusic.detectYtdlp;
  const oldResolve = ytmusic.resolveStream;
  let hits = 0;
  const resolveCalls = [];
  const upstream = http.createServer((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(403); res.end('expired'); return; } // first (stale) URL is rejected
    res.writeHead(206, { 'content-type': 'audio/mp4', 'content-range': 'bytes 0-3/8', 'content-length': '4' });
    res.end('MUSI');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  try {
    ytmusic.detectYtdlp = () => ({ cmd: ['mock-ytdlp'], version: 'test' });
    ytmusic.resolveStream = async (id, opts) => {
      resolveCalls.push({ id, force: !!opts.force });
      return { url: `http://127.0.0.1:${upstream.address().port}/audio`, mime: 'audio/mp4', headers: {} };
    };
    const uid = srv.auth._users().list[0].id;
    const tok = srv.auth.streamToken(uid, 'music:AAAAAAAAAAA');
    const audio = await httpRaw(srv.port, `/api/music/stream/AAAAAAAAAAA?t=${tok}`, { range: 'bytes=0-3' });
    assert.strictEqual(audio.status, 206, 'a stale URL is transparently re-resolved rather than surfaced as an error');
    assert.strictEqual(audio.body.toString(), 'MUSI');
    assert.ok(hits >= 2, 'the upstream was retried after the 403');
    assert.ok(resolveCalls.length >= 2, 'the track was re-resolved after the 403');
    assert.strictEqual(resolveCalls[1].force, true, 'the recovery re-resolve forces a fresh URL (bypasses cache + inflight dedupe)');
  } finally {
    ytmusic.detectYtdlp = oldDetect;
    ytmusic.resolveStream = oldResolve;
    upstream.close();
  }
});

test('music: yt-dlp-backed endpoints are rate-limited per user', async () => {
  const ytmusic = require('../server/ytmusic');
  const oldDetect = ytmusic.detectYtdlp;
  // bootServer mutates the process-global TRIBOON_DATA; restore it so later tests that read the
  // shared server's data dir (e.g. the Trakt test) aren't pointed at this throwaway dir.
  const prevData = process.env.TRIBOON_DATA;
  const rlSrv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    // Force the fast 503 path so allowed requests don't spawn real yt-dlp (the throttle runs first,
    // so a capped request still 429s regardless of yt-dlp presence).
    ytmusic.detectYtdlp = () => false;
    const rlAdmin = await setupAdmin(rlSrv.port);
    const statuses = [];
    for (let i = 0; i < 45; i++) {
      const r = await httpJson(rlSrv.port, 'GET', '/api/music/search?q=spam', null, rlAdmin);
      statuses.push(r.status);
      if (r.status === 429) break;
    }
    assert.ok(statuses.includes(429), `music search must 429 once a user exceeds the per-minute cap (saw ${statuses.join(',')})`);
    assert.ok(statuses.length > 40, 'the cap is generous (~40/min) so a normal browsing burst is never throttled');
  } finally {
    ytmusic.detectYtdlp = oldDetect;
    await rlSrv.shutdown();
    process.env.TRIBOON_DATA = prevData;
  }
});

test('music: home shelves and charts are cached and tokenized', async () => {
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
    assert.deepStrictEqual(first.json.charts.map((c) => c.id), ['weekly']);
    assert.strictEqual(first.json.charts[0].results.length, 2);
    assert.ok(/^\/api\/music\/stream\/WWWWWWWWWWW\?t=/.test(first.json.charts[0].results[0].streamUrl));

    const second = await httpJson(srv.port, 'GET', '/api/music/charts', null, admin);
    assert.strictEqual(second.status, 200, second.raw);
    assert.strictEqual(calls.length, 1, 'weekly chart searches are cached after the first request');
    assert.ok(/^\/api\/music\/stream\/WWWWWWWWWWW\?t=/.test(second.json.charts[0].results[0].streamUrl),
      'cached chart tracks still receive tokenized stream URLs in the response');

    const home = await httpJson(srv.port, 'GET', '/api/music/home', null, admin);
    assert.strictEqual(home.status, 200, home.raw);
    assert.strictEqual(home.json.version, 2);
    assert.strictEqual(home.json.mode, home.json.catalog ? 'catalog' : 'basic');
    assert.strictEqual(home.json.shelves[0].id, 'personal', 'personal playlists are the first Music Home shelf');
    assert.ok(home.json.shelves.find((s) => s.id === 'weekly-playlists' && s.kind === 'feeds'),
      'Music Home exposes weekly playlist-style discovery');
    assert.ok(!home.json.shelves.find((s) => s.id === 'seasonal-mixes' || s.id === 'moods' || s.id === 'trending-now'),
      'Music Home keeps first load short instead of rendering extra daily/mood shelves');
    const weekly = home.json.shelves.find((s) => s.id === 'top-songs-week');
    assert.ok(weekly && /^\/api\/music\/stream\/WWWWWWWWWWW\?t=/.test(weekly.results[0].streamUrl),
      'Music Home track shelves are playable with scoped stream tokens');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
    assert.match(ui, /const MUSIC_PAGE_SIZE = 24;[\s\S]+const MUSIC_PLAYLIST_INITIAL = 12;/,
      'Music playlists should first-load a small page and reveal more personal playlists locally');
    assert.match(ui, /S\.ytmPlaylists\.slice\(0, S\.musicPlaylistLimit\)[\s\S]+title: 'More playlists'[\s\S]+S\.musicPlaylistLimit = Math\.min\(S\.ytmPlaylists\.length/,
      'Music page should cap personal playlist cards at first paint with a More playlists reveal');
    assert.doesNotMatch(ui, /coverPlaylist: p\.id|coverPlaylist: 'LM'/,
      'Music page should not prefetch playlist tracks just to paint personal playlist covers');
    const feedA = await httpJson(srv.port, 'GET', '/api/music/search?q=cover-feed-cache-test&limit=12', null, admin);
    const feedB = await httpJson(srv.port, 'GET', '/api/music/search?q=cover-feed-cache-test&limit=12', null, admin);
    assert.strictEqual(feedA.status, 200, feedA.raw);
    assert.strictEqual(feedB.status, 200, feedB.raw);
    assert.strictEqual(calls.filter((c) => c.q === 'cover-feed-cache-test').length, 1,
      'deterministic Music cover/search feeds are cached server-side across reloads');
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
  srv.mounts.set('paused-x', mk('paused-x', now - 60 * 60000));
  srv.pipeline.sessions.set('paused-session-x', { id: 'paused-session-x', createdAt: now, currentMountId: 'paused-x' });
  const evicted = srv.sweep(now);
  assert.ok(evicted.includes('idle-x'), 'idle mount evicted');
  assert.ok(!srv.mounts.has('idle-x'));
  assert.ok(srv.mounts.has('fresh-x'), 'recently-touched mount survives');
  assert.ok(!evicted.includes('paused-x'), 'paused session mount not treated as idle');
  assert.ok(srv.mounts.has('paused-x'), 'paused session mount survives for resume');
  srv.mounts.delete('fresh-x');
  srv.mounts.delete('paused-x');
  srv.pipeline.sessions.delete('paused-session-x');
});

test('housekeeping sweep: cap trimming preserves paused session mounts', async () => {
  const now = Date.now();
  const mk = (id, touched) => ({ id, _touched: touched, name: id, size: 1, streamable: true, tags: [] });
  const ids = [];
  for (let i = 0; i < 18; i++) {
    const id = `cap-${i}`;
    ids.push(id);
    srv.mounts.set(id, mk(id, now - (30 + i) * 1000));
  }
  srv.mounts.set('paused-cap-x', mk('paused-cap-x', now - 60 * 60000));
  srv.pipeline.sessions.set('paused-cap-session-x', { id: 'paused-cap-session-x', createdAt: now, currentMountId: 'paused-cap-x' });
  const evicted = srv.sweep(now);
  assert.ok(srv.mounts.has('paused-cap-x'), 'paused session mount survives global cap trimming');
  assert.ok(!evicted.includes('paused-cap-x'), 'protected paused mount is not reported as evicted');
  assert.ok(evicted.length >= 3, 'ordinary old mounts are trimmed before protected sessions');
  for (const id of ids) srv.mounts.delete(id);
  srv.mounts.delete('paused-cap-x');
  srv.pipeline.sessions.delete('paused-cap-session-x');
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

test('fetchUrl: validator-provided lookup pins the already-checked upstream address', async () => {
  const { fetchUrl } = require('../server/newznab');
  const up = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`host=${req.headers.host}`);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  try {
    const r = await fetchUrl(`http://pin-only.invalid:${up.address().port}/ok`, {
      validateUrl: () => ({
        lookup: (host, opts, cb) => {
          if (typeof opts === 'function') { cb = opts; opts = {}; }
          if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
          else cb(null, '127.0.0.1', 4);
        },
      }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.toString(), `host=pin-only.invalid:${up.address().port}`);
  } finally {
    up.close();
  }
});

test('iptv: pinned DNS cache rotates and sidelines failed upstream addresses', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const newznabCode = fs.readFileSync(path.join(__dirname, '..', 'server', 'newznab.js'), 'utf8');
  assert.match(serverCode, /function pickCachedIptvAddress\(host\) \{[\s\S]+hit\.failures[\s\S]+const pool = addrs\.length \? addrs : hit\.addrs;[\s\S]+hit\.next = pickedIdx >= 0 \? pickedIdx \+ 1 : offset \+ 1;/,
    'IPTV pinning should rotate across the validated DNS set instead of always using addrs[0]');
  assert.match(serverCode, /function markIptvPinnedAddressFailure\(pin, ttlMs = 60000\) \{[\s\S]+hit\.failures\[key\] = Date\.now\(\) \+ ttlMs;[\s\S]+hit\.next = idx \+ 1;/,
    'a failed pinned address should be sidelined briefly and the next address tried first');
  assert.match(serverCode, /validateAndPinIptvUrl[\s\S]+cacheHost: net\.isIP\(host\) \? '' : host,[\s\S]+onFailure: \(\) => markIptvPinnedAddressFailure/,
    'validated IPTV pins should carry enough metadata to mark connection failures');
  assert.match(serverCode, /let safeHit = null;[\s\S]+safeHit = iptvUrlSafetyCache\.get\(host\);[\s\S]+addressCount: safeHit && Array\.isArray\(safeHit\.addrs\)/,
    'validated IPTV pins should keep the cached DNS metadata in function scope for returned retry metadata');
  assert.doesNotMatch(serverCode, /const safeHit = iptvUrlSafetyCache\.get\(host\);/,
    'safeHit must not be block-scoped or native/remux playback can fail before opening the provider URL');
  assert.match(serverCode, /addressCount: safeHit && Array\.isArray\(safeHit\.addrs\) \? safeHit\.addrs\.length : \(picked \? 1 : 0\),/,
    'validated IPTV pins should carry the safe DNS pool size for bounded same-request retry');
  assert.match(serverCode, /const retryPinnedAddress = \(reason\) => \{[\s\S]+markPinFailure\(\);[\s\S]+ctx\.res\.headersSent[\s\S]+pin\.addressCount[\s\S]+open\(rawTarget, hop, pinRetries \+ 1, uaIndex\);[\s\S]+return true;/,
    'native Live TV should retry the next pinned address in the same request before any response bytes are sent');
  assert.match(newznabCode, /validated && typeof validated\.onFailure === 'function'[\s\S]+validated\.onFailure\(e\)/,
    'generic IPTV fetches should report failed pinned connections back to the validator');
});

test('iptv: live-remux preserves HTTPS hostnames for provider TLS SNI', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(serverCode, /function iptvRemuxInputHref\(pin, fallbackUrl\) \{[\s\S]+if \(u\.protocol === 'https:'\) return href;[\s\S]+return \(pin && pin\.pinnedHref\) \|\| href;[\s\S]+\}/,
    'HTTPS IPTV remux should pass the original hostname to ffmpeg so TLS SNI/certificates still work');
  assert.match(serverCode, /spawnLiveRemux\(iptvRemuxInputHref\(pin, target\.url\), \{[\s\S]+headers: pin\.hostHeader \? \{ Host: pin\.hostHeader \} : undefined/,
    'Live TV remux should use the SNI-safe URL helper while keeping a sanitized Host header');
});

test('streaming: HTTP range reads use startup/seek lanes and keep completed range read-ahead warm', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const vfsCode = fs.readFileSync(path.join(__dirname, '..', 'server', 'vfs.js'), 'utf8');
  assert.match(serverCode, /vf\._touched = _now;[\s\S]+_now - _lastStreamRebalance > 1000[\s\S]+pipeline\.rebalancePlaybackWindows\(_now\);[\s\S]+ctx\.req\.setTimeout\(120000\);[\s\S]+ctx\.res\.setTimeout\(120000\);[\s\S]+const requestedPriority = String\(ctx\.url\.searchParams\.get\('priority'\)[\s\S]+const explicitPriority = requestedPriority === 'read-ahead' \? 'readAhead' : requestedPriority;[\s\S]+const highWaterEnd = Number\(vf\._streamHighWaterEnd \|\| 0\);[\s\S]+const sequentialRange = start > 0[\s\S]+highWaterEnd > 0[\s\S]+start <= highWaterEnd \+ sequentialSlack;[\s\S]+const readPriority = \['background', 'readAhead', 'health'\]\.includes\(explicitPriority\)[\s\S]+: \(start === 0 \? 'startup' : \(sequentialRange \? 'playback' : 'seek'\)\);[\s\S]+ctx\.req\.once\('close', stopReqRead\);[\s\S]+ctx\.res\.once\('close', stopResRead\);[\s\S]+vf\.read\(start, end, \{ priority: readPriority, signal: readSignal \}\)/,
    'the stream route should mark initial reads as startup, real jumps as seek, normal sequential ranges as playback, and allow explicit background readers for subtitle extraction');
  assert.match(serverCode, /let completedRead = false;[\s\S]+const abortRead = \(\) => \{[\s\S]+readController\.abort\(\);[\s\S]+vf\.cancelReadAhead\(\);[\s\S]+const stopReqRead = \(\) => \{[\s\S]+if \(!ctx\.req\.complete\) abortRead\(\);[\s\S]+const stopResRead = \(\) => \{[\s\S]+if \(!completedRead && !ctx\.res\.writableEnded\) abortRead\(\);[\s\S]+completedRead = !readSignal\.aborted && !ctx\.res\.destroyed;[\s\S]+vf\._streamHighWaterEnd = Math\.max\(Number\(vf\._streamHighWaterEnd \|\| 0\), end\)/,
    'client disconnects should stop stale read-ahead, but completed ExoPlayer ranges should keep their warm buffer');
  // v2.3.0 quick wins: the static UI is gzipped + ETag/304-revalidated, and the per-Range rebalance is
  // throttled with a cached os.totalmem (see the functional test below + pipeline.js).
  assert.match(serverCode, /_now - _lastStreamRebalance > 1000[\s\S]+pipeline\.rebalancePlaybackWindows\(_now\);/,
    'the per-Range playback-window rebalance is throttled to <=1/sec (was firing on every byte-range request)');
  const pipelineCode2 = fs.readFileSync(path.join(__dirname, '..', 'server', 'pipeline.js'), 'utf8');
  assert.match(pipelineCode2, /const TOTAL_MEM_MB = Math\.floor\(os\.totalmem\(\) \/ \(1024 \* 1024\)\);/,
    'os.totalmem() is read once at load, not per read-ahead window sizing');
  assert.match(pipelineCode2, /_getFreshSearchHit\(key\) \{[\s\S]+this\.searchCache\.delete\(key\); this\.searchCache\.set\(key, hit\);/,
    'the search cache is LRU (touch-on-hit) so a hot replayed title survives unrelated browses');
  assert.match(serverCode, /if \(readSignal\.aborted\) \{[\s\S]+ctx\.res\.destroy\(\);[\s\S]+return;[\s\S]+\}/,
    'aborted VOD reads should not end a short body under the original content-length');
  assert.match(vfsCode, /cancelReadAhead\(\) \{[\s\S]+this\.readAheadEpoch\+\+;[\s\S]+\}/,
    'virtual files should expose a safe read-ahead cancel hook');
  assert.match(vfsCode, /async mount\(priority = 'startup'\)[\s\S]+this\._fetchSegment\(0, priority \|\| 'startup'\)/,
    'mount should fetch the first segment through the startup lane so play start cannot queue behind read-ahead');
  assert.match(vfsCode, /async readAt\(start, len, opts = \{\}\)[\s\S]+const priority = opts\.priority \|\| 'startup';[\s\S]+this\._fetchSegment\(first \+ k, priority\)/,
    'header/random access reads used during mount should also stay on the startup lane');
  assert.match(vfsCode, /async \*read\(start, end, opts = \{\}\) \{[\s\S]+const priority = opts\.priority \|\| 'playback';[\s\S]+let activePriority = priority;[\s\S]+priority !== 'background' && priority !== 'health' && readAheadEpoch === this\.readAheadEpoch[\s\S]+this\._fetchSegment\(segIdx, activePriority, \{ signal \}\)[\s\S]+activePriority = 'playback'/,
    'virtual file reads should pass caller priority into the first real article fetch, return to playback, and keep background readers from scheduling read-ahead');
});

test('static UI: gzip + ETag/304 revalidation keeps the ~1.2MB shell fast to load', async () => {
  const gz = await httpRaw(srv.port, '/', { headers: { 'accept-encoding': 'gzip' } });
  assert.strictEqual(gz.status, 200);
  assert.strictEqual(gz.headers['content-encoding'], 'gzip', 'the UI is gzip-compressed when the client accepts it');
  assert.match(String(gz.headers.vary || ''), /accept-encoding/i, 'the gzip response varies on Accept-Encoding');
  assert.ok(gz.headers.etag, 'the UI carries an ETag validator');
  assert.ok(gz.body.length >= 2 && gz.body[0] === 0x1f && gz.body[1] === 0x8b, 'the body is a real gzip stream (magic bytes)');
  // Revalidation with the ETag → 304 with no body — the point of the win: unchanged loads cost ~0 bytes.
  const notMod = await httpRaw(srv.port, '/', { headers: { 'if-none-match': gz.headers.etag } });
  assert.strictEqual(notMod.status, 304, 'an unchanged UI revalidates to 304 Not Modified');
  assert.strictEqual(notMod.body.length, 0, 'a 304 carries no body');
  // No Accept-Encoding → uncompressed HTML, still ETagged (same validator as the gzip response).
  const plain = await httpRaw(srv.port, '/');
  assert.strictEqual(plain.status, 200);
  assert.ok(!plain.headers['content-encoding'], 'no gzip when the client does not accept it');
  assert.ok(plain.headers.etag, 'the uncompressed response is still ETagged');
  assert.match(plain.body.toString('utf8').slice(0, 200), /<!doctype html>/i, 'the uncompressed path serves the real HTML');
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
  const rawTrakt = fs.existsSync(path.join(process.env.TRIBOON_DATA, 'trakt.json'))
    ? fs.readFileSync(path.join(process.env.TRIBOON_DATA, 'trakt.json'), 'utf8')
    : '';
  const rawSettings = fs.readFileSync(path.join(process.env.TRIBOON_DATA, 'settings.json'), 'utf8');
  assert.ok(!rawTrakt.includes('acc1') && !rawTrakt.includes('ref1'), 'Trakt OAuth tokens are not stored in the plaintext trakt table');
  assert.ok(!rawSettings.includes('acc1') && !rawSettings.includes('ref1'), 'Trakt OAuth tokens are encrypted inside settings');
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

test('admin 2FA: encrypted TOTP setup, challenge login, recovery codes, and disable flow', async () => {
  const initial = await httpJson(srv.port, 'GET', '/api/me/security', null, admin);
  assert.strictEqual(initial.status, 200);
  assert.strictEqual(initial.json.twoFactor.enabled, false);

  const badSetup = await httpJson(srv.port, 'POST', '/api/me/totp/setup', { password: 'wrong' }, admin);
  assert.strictEqual(badSetup.status, 400);

  const setup = await httpJson(srv.port, 'POST', '/api/me/totp/setup', { password: 'hunter22' }, admin);
  assert.strictEqual(setup.status, 200);
  assert.match(setup.json.secret, /^[A-Z2-7]{32}$/);
  assert.ok(setup.json.otpauthUrl.startsWith('otpauth://totp/'), 'authenticator URL returned');
  srv.store.flush();
  let rawUsers = fs.readFileSync(path.join(srv.store.dir, 'users.json'), 'utf8');
  assert.ok(!rawUsers.includes(setup.json.secret), 'pending TOTP secret is encrypted at rest');

  const badEnable = await httpJson(srv.port, 'POST', '/api/me/totp/enable',
    { password: 'hunter22', code: '000000' }, admin);
  assert.strictEqual(badEnable.status, 400);

  const oldAdmin = admin;
  const enable = await httpJson(srv.port, 'POST', '/api/me/totp/enable',
    { password: 'hunter22', code: totpCode(setup.json.secret) }, admin);
  assert.strictEqual(enable.status, 200);
  assert.strictEqual(enable.json.user.twoFactorEnabled, true);
  assert.strictEqual(enable.json.recoveryCodes.length, 8);
  admin = enable.json.token;
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, oldAdmin)).status, 401,
    'enabling 2FA revokes older sessions');

  const passwordOnly = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
  assert.strictEqual(passwordOnly.status, 200);
  assert.strictEqual(passwordOnly.json.twoFactorRequired, true);
  assert.ok(passwordOnly.json.challenge);
  assert.ok(!passwordOnly.json.token, 'password-only login does not issue a session when 2FA is enabled');

  const bad2fa = await httpJson(srv.port, 'POST', '/api/login/2fa',
    { challenge: passwordOnly.json.challenge, code: '000000' });
  assert.strictEqual(bad2fa.status, 401);

  const good2fa = await httpJson(srv.port, 'POST', '/api/login/2fa',
    { challenge: passwordOnly.json.challenge, code: totpCode(setup.json.secret) });
  assert.strictEqual(good2fa.status, 200);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, good2fa.json.token)).json.twoFactorEnabled, true);

  const recoveryCode = enable.json.recoveryCodes[0];
  const recoveryChallenge = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
  const recoveryLogin = await httpJson(srv.port, 'POST', '/api/login/2fa',
    { challenge: recoveryChallenge.json.challenge, code: recoveryCode });
  assert.strictEqual(recoveryLogin.status, 200);
  assert.strictEqual(recoveryLogin.json.recoveryUsed, true);

  const replayChallenge = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
  const replay = await httpJson(srv.port, 'POST', '/api/login/2fa',
    { challenge: replayChallenge.json.challenge, code: recoveryCode });
  assert.strictEqual(replay.status, 401, 'recovery codes are single-use');
  const afterRecovery = await httpJson(srv.port, 'GET', '/api/me/security', null, admin);
  assert.strictEqual(afterRecovery.json.twoFactor.recoveryCodesRemaining, 7);

  srv.store.flush();
  rawUsers = fs.readFileSync(path.join(srv.store.dir, 'users.json'), 'utf8');
  assert.ok(!rawUsers.includes(setup.json.secret), 'enabled TOTP secret is encrypted at rest');
  assert.ok(!rawUsers.includes(normalizeTestRecovery(recoveryCode)), 'recovery codes are hashed at rest');

  const regen = await httpJson(srv.port, 'POST', '/api/me/totp/recovery',
    { password: 'hunter22', code: totpCode(setup.json.secret) }, admin);
  assert.strictEqual(regen.status, 200);
  assert.strictEqual(regen.json.recoveryCodes.length, 8);

  const disableBad = await httpJson(srv.port, 'POST', '/api/me/totp/disable',
    { password: 'hunter22', code: '000000' }, admin);
  assert.strictEqual(disableBad.status, 400);
  const disable = await httpJson(srv.port, 'POST', '/api/me/totp/disable',
    { password: 'hunter22', code: totpCode(setup.json.secret) }, admin);
  assert.strictEqual(disable.status, 200);
  assert.strictEqual(disable.json.user.twoFactorEnabled, false);
  admin = disable.json.token;

  const openLogin = await httpJson(srv.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
  assert.strictEqual(openLogin.status, 200);
  assert.ok(openLogin.json.token);
  assert.ok(!openLogin.json.twoFactorRequired);
  admin = openLogin.json.token;
});

test('password change: requires the current password, old one stops working', async () => {
  const oldAdmin = admin;
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/me/password',
    { oldPassword: 'wrong', newPassword: 'newpass1' }, admin)).status, 400);
  assert.strictEqual((await httpJson(srv.port, 'POST', '/api/me/password',
    { oldPassword: 'hunter22', newPassword: 'newpass1' }, admin)).status, 200);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/me', null, oldAdmin)).status, 401,
    'password change revokes already-issued session tokens');
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

test('cast CORS: media routes reflect the request Origin and expose Range headers', async () => {
  // Phase 2 casting: a Custom Web Receiver on a different origin fetches media cross-origin, so the
  // stream/remux/transcode/HLS/subtitle routes MUST carry CORS. The headers are applied by PATH
  // before auth, so even a 401 (garbage token, no real mount) still carries them — that is what we
  // assert here (we don't need a live mount to prove the CORS contract).
  const RECEIVER = 'https://cast.example.com';
  const mediaPaths = [
    '/api/stream/deadbeef', '/api/remux/deadbeef', '/api/transcode/deadbeef',
    '/api/hls/deadbeef', '/api/hls/deadbeef/index.m3u8',
    '/api/subtitle/deadbeef/0', '/api/releasesub/deadbeef/track-1', '/api/ossubs/deadbeef',
  ];
  for (const p of mediaPaths) {
    const r = await httpWithHeaders(srv.port, 'GET', p, { origin: RECEIVER });
    assert.strictEqual(r.headers['access-control-allow-origin'], RECEIVER,
      `media route ${p} must reflect the request Origin`);
    assert.match(String(r.headers['access-control-expose-headers'] || ''), /Content-Range/i,
      `media route ${p} must expose Content-Range so the receiver can seek`);
    assert.match(String(r.headers['vary'] || ''), /Origin/i,
      `media route ${p} must Vary on Origin when it reflects one`);
  }
});

test('cast CORS: OPTIONS preflight is answered 204 on media routes, 404 elsewhere', async () => {
  const RECEIVER = 'https://cast.example.com';
  const pre = await httpWithHeaders(srv.port, 'OPTIONS', '/api/stream/deadbeef', { origin: RECEIVER });
  assert.strictEqual(pre.status, 204, 'media OPTIONS preflight must be answered');
  assert.strictEqual(pre.headers['access-control-allow-origin'], RECEIVER);
  assert.match(String(pre.headers['access-control-allow-headers'] || ''), /Range/i,
    'preflight must allow the Range request header');
  assert.match(String(pre.headers['access-control-allow-methods'] || ''), /GET/i);

  // A non-media route must NOT become CORS-enabled or answer OPTIONS (deny-by-default is intact).
  const nonMedia = await httpWithHeaders(srv.port, 'OPTIONS', '/api/me', { origin: RECEIVER });
  assert.strictEqual(nonMedia.status, 404, 'OPTIONS on a non-media route is not routed');
});

test('cast CORS: non-media API routes do not emit Access-Control-Allow-Origin', async () => {
  const RECEIVER = 'https://cast.example.com';
  // /api/server is public; /api/me needs auth. Neither is a media route → no CORS leak.
  for (const p of ['/api/server', '/api/me', '/api/status']) {
    const r = await httpWithHeaders(srv.port, 'GET', p, { origin: RECEIVER });
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined,
      `non-media route ${p} must not emit CORS headers`);
  }
});

test('cast: /cast/receiver serves a dependency-free custom Web Receiver page (public)', async () => {
  const r = await httpJson(srv.port, 'GET', '/cast/receiver');
  assert.strictEqual(r.status, 200, 'receiver page must be publicly reachable (no token — Cast device fetches it)');
  assert.match(String(r.headers['content-type'] || ''), /text\/html/i);
  // It must load the CAF Web Receiver SDK and register a LOAD interceptor, and stay dependency-free
  // (served static asset — the SDK is the only external, from gstatic, which CSP/deny rules allow).
  assert.match(r.raw, /caf_receiver\/v3\/cast_receiver_framework\.js/, 'receiver must load the CAF Web Receiver SDK from gstatic');
  assert.match(r.raw, /setMessageInterceptor/, 'receiver must intercept LOAD to resolve the stream URL');
  assert.match(r.raw, /getDeviceCapabilities|canDisplayType/, 'receiver must probe device codec caps');
});

test('cast: server config exposes the receiver app-id, defaulting to the Default Media Receiver', async () => {
  const r = await httpJson(srv.port, 'GET', '/api/server');
  assert.strictEqual(r.status, 200);
  // Nothing registered yet → the safe default is Google's Default Media Receiver so Phase 1/3
  // keep working unchanged. The owner overrides this once they register a custom app-id.
  assert.strictEqual(r.json.castReceiverAppId, 'CC1AD845',
    'default cast receiver app-id must be the Default Media Receiver (CC1AD845)');
});

test('cast: a valid custom receiver app-id round-trips; junk is rejected back to the default', async () => {
  // Set a valid 8-hex custom id (as issued by the Cast Developer Console).
  let s = await httpJson(srv.port, 'POST', '/api/settings', { castReceiverAppId: 'a1b2c3d4' }, admin);
  assert.strictEqual(s.status, 200);
  let srv1 = await httpJson(srv.port, 'GET', '/api/server');
  assert.strictEqual(srv1.json.castReceiverAppId, 'A1B2C3D4', 'a valid custom app-id is served (upper-cased) to senders');
  let get1 = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(get1.json.castReceiverAppId, 'A1B2C3D4', 'settings echoes the raw custom app-id (public identifier, not a secret)');

  // A malformed value must be ignored and fall back to the Default Media Receiver — never brick casting.
  await httpJson(srv.port, 'POST', '/api/settings', { castReceiverAppId: 'not-hex!!' }, admin);
  let srv2 = await httpJson(srv.port, 'GET', '/api/server');
  assert.strictEqual(srv2.json.castReceiverAppId, 'CC1AD845', 'a malformed app-id resets senders to the Default Media Receiver');

  // Clearing it (empty string) also returns to the default.
  await httpJson(srv.port, 'POST', '/api/settings', { castReceiverAppId: '' }, admin);
  let srv3 = await httpJson(srv.port, 'GET', '/api/server');
  assert.strictEqual(srv3.json.castReceiverAppId, 'CC1AD845', 'clearing the app-id returns to the Default Media Receiver');
});

// The owner's ask: on a restricted profile, over-cap titles must not SHOW UP in the catalog at all
// (the old behavior showed them but blocked the click). The TMDB proxy filters list responses so
// the catalog matches the server play gate. This exercises the real request path end to end against
// a mock TMDB, self-contained so it can't perturb the shared server.
test('maturity: restricted profiles get over-cap titles filtered OUT of the catalog, not just blocked on play', async () => {
  const j = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const mock = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.endsWith('/configuration')) return j(res, { images: {} });
    if (p.endsWith('/discover/movie')) return j(res, { page: 1, total_pages: 1, results: [
      { id: 700, title: 'PG13 Action', poster_path: '/a.jpg', adult: false, genre_ids: [28] },
      { id: 701, title: 'R Thriller', poster_path: '/b.jpg', adult: false, genre_ids: [53] },
      { id: 702, title: 'G Cartoon', poster_path: '/c.jpg', adult: false, genre_ids: [16, 10751] },
      { id: 703, title: 'XXX', poster_path: '/d.jpg', adult: true, genre_ids: [] },
      { id: 704, title: 'PG Family', poster_path: '/g.jpg', adult: false, genre_ids: [28] },
    ] });
    if (p.endsWith('/discover/tv')) return j(res, { page: 1, total_pages: 1, results: [
      { id: 800, name: 'TV14 Drama', poster_path: '/e.jpg' },
      { id: 801, name: 'TVMA Crime', poster_path: '/f.jpg' },
    ] });
    if (p.endsWith('/movie/700')) return j(res, { id: 700, adult: false, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] }] } });
    if (p.endsWith('/movie/701')) return j(res, { id: 701, adult: false, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] } });
    if (p.endsWith('/movie/702')) return j(res, { id: 702, adult: false, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'G' }] }] } });
    if (p.endsWith('/movie/704')) return j(res, { id: 704, adult: false, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG' }] }] } });
    if (p.endsWith('/tv/800')) return j(res, { id: 800, content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-14' }] } });
    if (p.endsWith('/tv/801')) return j(res, { id: 801, content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] } });
    j(res, { results: [] });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  let s;
  try {
    s = await bootServer({ NNTP_HOST: null, TMDB_BASE: `http://127.0.0.1:${mock.address().port}/3` });
    const tok = await setupAdmin(s.port);
    await httpJson(s.port, 'POST', '/api/settings', { tmdbKey: 'mat-filter-key' }, tok);
    // Rating tiers: 0 G · 1 PG · 2 PG-13 · 3 R · 4 No limit. Each tier drops everything above its cap.
    const pg13 = (await httpJson(s.port, 'POST', '/api/me/profiles', { name: 'PG13', level: 2 }, tok)).json.id;
    const pg = (await httpJson(s.port, 'POST', '/api/me/profiles', { name: 'PG', level: 1 }, tok)).json.id;
    const g = (await httpJson(s.port, 'POST', '/api/me/profiles', { name: 'G', level: 0 }, tok)).json.id;
    const ids = (r) => (r.json.results || []).map((x) => x.id).sort((a, b) => a - b);

    // No profile context (owner / No limit) → the catalog comes back unfiltered.
    const noneM = await httpJson(s.port, 'GET', '/api/tmdb/discover/movie', null, tok);
    assert.deepStrictEqual(ids(noneM), [700, 701, 702, 703, 704], 'No limit sees the full unfiltered catalog');

    // PG-13 (≤PG-13/TV-14): the R movie and the hard-adult title are GONE from the list itself.
    const pg13M = await httpJson(s.port, 'GET', `/api/tmdb/discover/movie?_pf=${pg13}`, null, tok);
    assert.deepStrictEqual(ids(pg13M), [700, 702, 704], 'PG-13 catalog keeps PG-13/PG/G, drops R + adult');
    // TMDB's discover/tv can't filter by rating — the server filter is what removes the TV-MA show.
    const pg13T = await httpJson(s.port, 'GET', `/api/tmdb/discover/tv?_pf=${pg13}`, null, tok);
    assert.deepStrictEqual(ids(pg13T), [800], 'PG-13 TV catalog drops the TV-MA show, keeps TV-14');

    // PG (≤PG): the PG-13 title now drops too — proves the finer-than-4 granularity.
    const pgM = await httpJson(s.port, 'GET', `/api/tmdb/discover/movie?_pf=${pg}`, null, tok);
    assert.deepStrictEqual(ids(pgM), [702, 704], 'PG catalog keeps PG/G, drops PG-13 + R + adult');

    // G (strictest: ≤G AND a kid genre): only the animated/family G title survives — the PG family
    // title is dropped (cert above G and not a kid genre).
    const gM = await httpJson(s.port, 'GET', `/api/tmdb/discover/movie?_pf=${g}`, null, tok);
    assert.deepStrictEqual(ids(gM), [702], 'G catalog keeps only the kid-genre G title');

    // An unknown/bogus profile id fails CLOSED to the strictest tier (no spoofed-id catalog bypass).
    const spoof = await httpJson(s.port, 'GET', '/api/tmdb/discover/movie?_pf=deadbeef', null, tok);
    assert.deepStrictEqual(ids(spoof), [702], 'an unknown _pf id is treated as the strictest tier (G)');
  } finally {
    if (s) await s.shutdown();
    await new Promise((r) => mock.close(r));
    delete process.env.TMDB_BASE;
  }
});

// The rating-tier redesign (v1 Kids/Teen/Family/Adult → v2 G/PG/PG-13/R/No limit) migrates stored
// profiles ONCE at boot. The invariant that must hold: no migrated profile ever becomes MORE
// permissive (no mature content newly appears). This seeds v1-shaped data on disk and boots against it.
test('maturity migration: legacy tiers remap preserving the cert cap (never more permissive), idempotently', async () => {
  const os = require('os');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-matmig-'));
  let s1, s2;
  try {
    s1 = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const tok1 = await setupAdmin(s1.port);
    await httpJson(s1.port, 'POST', '/api/me/profiles', { name: 'WasTeen', level: 2 }, tok1);
    await httpJson(s1.port, 'POST', '/api/me/profiles', { name: 'WasKids', level: 1 }, tok1);
    await s1.shutdown();

    // Rewrite the store to v1-scheme values + drop the schema stamp so the next boot re-migrates.
    const usersPath = path.join(dataDir, 'users.json');
    const store = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    delete store.maturitySchema;
    const profs = store.list[0].profiles;
    profs.find((p) => p.name === 'WasTeen').level = 1;   // v1 Teen (≤PG-13)
    profs.find((p) => p.name === 'WasKids').level = 0;   // v1 Kids (≤PG)
    (profs.find((p) => p.level === 4) || profs[0]).level = 3; // account default → v1 Adult (all)
    profs.push({ id: 'legacy01', name: 'NoLevelKid', kid: true }); // pre-level profile, kid flag only
    fs.writeFileSync(usersPath, JSON.stringify(store));

    s2 = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const login = () => httpJson(s2.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    const me = (await httpJson(s2.port, 'GET', '/api/me', null, (await login()).json.token)).json;
    const lvl = (name) => (me.profiles.find((p) => p.name === name) || {}).level;
    assert.strictEqual(lvl('WasTeen'), 2, 'v1 Teen (≤PG-13) → PG-13 (2): cap preserved');
    assert.strictEqual(lvl('WasKids'), 0, 'v1 Kids → G (0): stays strictest, never looser');
    assert.strictEqual(lvl('NoLevelKid'), 0, 'legacy no-level kid back-fills to G (0)');
    assert.strictEqual(lvl('owner'), 4, 'v1 Adult (all) → No limit (4): owner still plays everything');

    // Idempotent: a third boot (schema already stamped) must not shift anything further.
    await s2.shutdown();
    s2 = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
    const me3 = (await httpJson(s2.port, 'GET', '/api/me', null, (await login()).json.token)).json;
    assert.strictEqual((me3.profiles.find((p) => p.name === 'WasTeen') || {}).level, 2, 'migration is idempotent');
  } finally {
    if (s1) await s1.shutdown().catch(() => {});
    if (s2) await s2.shutdown().catch(() => {});
    delete process.env.TMDB_BASE;
  }
});

// Windows "settings/users wiped on reinstall" root cause: a transient read failure of secret.json
// during the fragile post-install boot (AV lock / just-changed ACL) made the server MINT A NEW
// secret — orphaning encrypted settings — and the migration then overwrote users.json empty. The fix:
// existing files are NEVER clobbered after a read failure. These prove it with the Auth + Store classes.
test('secret: an existing secret.json is NEVER regenerated (no orphaned settings on reinstall)', () => {
  const os = require('os');
  const { Store } = require('../server/store');
  const { Auth } = require('../server/auth');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-secret-'));
  // 1. Fresh (no secret.json) → a secret is generated + persisted.
  const a1 = new Auth(new Store(dir));
  const onDisk = fs.readFileSync(path.join(dir, 'secret.json'), 'utf8');
  assert.ok(a1.secret && a1.secret.length >= 32, 'first boot generates a secret');
  // 2. Reboot, same dir → the SAME secret is reused and the file is untouched.
  const a2 = new Auth(new Store(dir));
  assert.strictEqual(a2.secret, a1.secret, 'existing secret reused, never regenerated');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'secret.json'), 'utf8'), onDisk, 'secret.json not rewritten on reboot');
  // 3. An existing-but-UNREADABLE secret.json must THROW, never be silently replaced (a fresh secret
  //    would make saved settings undecryptable — the exact reinstall data-loss bug).
  fs.writeFileSync(path.join(dir, 'secret.json'), '{ not valid json at all');
  assert.throws(() => new Auth(new Store(dir)), /secret\.json exists but could not be read/,
    'a corrupt/locked existing secret is never replaced with a fresh one');
});

test('maturity migration never wipes an existing users.json when the read fails', () => {
  const os = require('os');
  const { Store } = require('../server/store');
  const { Auth } = require('../server/auth');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-users-'));
  fs.writeFileSync(path.join(dir, 'secret.json'), JSON.stringify({ value: 'a'.repeat(64) }));
  const corruptUsers = '{ "list": [ {an admin record that will not parse';
  fs.writeFileSync(path.join(dir, 'users.json'), corruptUsers);
  new Auth(new Store(dir)); // constructs + runs the one-time migration
  assert.strictEqual(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'), corruptUsers,
    'an unreadable users.json is left intact, never overwritten with an empty (stamped) list');
});

test('teardown', async () => {
  await srv.shutdown();
  await mockNntp.close();
  tmdbMock.close();
  if (ixServer) ixServer.close();
});

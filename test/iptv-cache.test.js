'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { httpJson, httpRaw, bootServer, setupAdmin } = require('./helpers');

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
    ];
    for (const iptvUrl of mapped) {
      const r = await httpJson(srv.port, 'POST', '/api/me/iptv/sources',
        { name: 'Mapped', iptvMode: 'm3u', iptvUrl }, admin);
      assert.strictEqual(r.status, 400, `${iptvUrl} should be blocked`);
      assert.match(r.json.error, /private|loopback|blocked/i);
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

test('iptv: Xtream browser remux fallback ingests TS before HLS', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-remux-ts-first-'));
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    if (action === 'get_live_streams') {
      return res.end(JSON.stringify([{ stream_id: 777, name: 'TS First News', category_id: '1' }]));
    }
    res.end(JSON.stringify({ epg_listings: [] }));
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
    const closeOnce = () => {
      if (child.closed) return;
      child.closed = true;
      child.emit('close', 0);
    };
    child.kill = () => {
      closeOnce();
    };
    process.nextTick(() => {
      child.stdout.write(Buffer.from('fmp4'));
      child.stdout.end();
      closeOnce();
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
    const out = await httpRaw(srv.port, ch.json.channels[0].streamUrl);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.headers['content-type'], 'video/mp4');
    assert.strictEqual(out.body.toString('utf8'), 'fmp4');
    assert.strictEqual(calls.length, 1, 'successful TS remux should not try the HLS URL');
    assert.match(calls[0].url, /\/live\/xtuser\/xtpass\/777\.ts$/);
    assert.strictEqual(calls[0].hlsFriendly, false, 'raw TS remux should not use HLS-only ffmpeg flags');
    assert.strictEqual(calls[0].headers, null, 'test-local IPTV uses the private-target opt-in, so no production Host override is needed');
  } finally {
    if (srv) await srv.shutdown();
    transcode.detectFfmpeg = originalDetect;
    transcode.spawnLiveRemux = originalSpawn;
    upstream.close();
  }
});

test('iptv: browser remux safely resolves provider redirects before retrying ffmpeg', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-xtream-remux-redirect-'));
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
    const out = await httpRaw(srv.port, ch.json.channels[0].streamUrl);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.toString('utf8'), 'fmp4');
    assert.strictEqual(calls.length, 2, 'ffmpeg should retry once after the server resolves the safe provider redirect');
    assert.match(calls[0].url, /\/live\/xtuser\/xtpass\/777\.ts$/);
    assert.match(calls[1].url, /\/edge\/777\.ts$/);
    assert.ok(upstreamHits.some((url) => /\/live\/xtuser\/xtpass\/777\.ts$/.test(url)),
      'server should probe the original provider URL to read the redirect target safely');
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
  const t0 = new Date(Date.now() - 10 * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const t1 = new Date(Date.now() + 50 * 60000).toISOString().slice(0, 19).replace('T', ' ');
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
    const cached = first.store.read('xtreamepgcache', null);
    assert.ok(cached && cached.streams && cached.streams.length, 'Xtream guide cache persisted');
    const staleAt = Date.now() - (2 * 24 * 3600000);
    cached.at = staleAt;
    cached.streams = cached.streams.map(([id, e]) => [id, { ...e, at: staleAt }]);
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

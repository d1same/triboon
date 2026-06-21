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
    const guide = await httpJson(first.port, 'GET', `/api/iptv/guide?chs=${ch.json.channels[0].idx}`, null, admin);
    assert.strictEqual(guide.json.channels[0].programmes[0].title, 'Cached Morning');
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

test('iptv: provider protection failures are only cached briefly so a retune can recover', async () => {
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
    srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
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
    calls.push({ url, hlsFriendly: !!opts.hlsFriendly });
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

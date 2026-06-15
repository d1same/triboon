'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { httpJson, bootServer, setupAdmin } = require('./helpers');

test('iptv: daily guide warm targets the next local midnight', async () => {
  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null });
  try {
    assert.strictEqual(srv.msUntilNextIptvWarm(new Date(2026, 0, 2, 12, 0, 0, 0).getTime()), 12 * 3600000);
    assert.strictEqual(srv.msUntilNextIptvWarm(new Date(2026, 0, 2, 23, 59, 59, 500).getTime()), 500);
    assert.strictEqual(srv.msUntilNextIptvWarm(new Date(2026, 0, 2, 0, 0, 0, 0).getTime()), 24 * 3600000);
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

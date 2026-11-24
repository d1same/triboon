'use strict';
// Wave 5 regression tests: Live TV / XMLTV, TMDB proxy single-flight & cache headroom,
// Discover trailer memo, Calendar race guard, and MSE chunk coalescing.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { parseXmltv } = require('../server/xmltv');
const { TmdbProxy } = require('../server/tmdb');

function fmtXmltvDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

test('xmltv parseXmltv skips out-of-window rows and parses single/double-quoted attributes', () => {
  const now = Date.UTC(2026, 10, 23, 12, 0, 0);
  const oldStart = fmtXmltvDate(now - 36 * 3600000);
  const oldStop = fmtXmltvDate(now - 35 * 3600000);
  const liveStart = fmtXmltvDate(now - 30 * 60000);
  const liveStop = fmtXmltvDate(now + 30 * 60000);
  const farStart = fmtXmltvDate(now + 72 * 3600000);
  const farStop = fmtXmltvDate(now + 73 * 3600000);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="ch.one"><display-name>News One HD</display-name></channel>
  <channel id='ch.two'><display-name>Sports Two</display-name></channel>
  <programme channel="ch.one" start="${oldStart}" stop="${oldStop}">
    <title>Too Old &amp; Stale</title>
  </programme>
  <programme channel="ch.one" start="${liveStart}" stop="${liveStop}">
    <title>Evening News &amp; Weather</title>
    <desc>Live &quot;Top&quot; Stories</desc>
  </programme>
  <programme channel='ch.two' start='${liveStart}' stop='${liveStop}'>
    <title>Match Night</title>
  </programme>
  <programme channel="ch.one" start="${farStart}" stop="${farStop}">
    <title>Too Far Ahead</title>
  </programme>
</tv>`;

  const parsed = parseXmltv(xml, [{ tvgId: 'ch.one', name: 'News One HD' }], now);
  const byCh = new Map(parsed.byChannel);
  assert.equal(byCh.size, 1, 'only carried channel should be kept');
  const rows = byCh.get('ch.one') || [];
  assert.equal(rows.length, 1, 'out-of-window programmes should be dropped');
  assert.equal(rows[0].title, 'Evening News & Weather');

  const unfiltered = parseXmltv(xml, [], now);
  const byChAll = new Map(unfiltered.byChannel);
  assert.equal(byChAll.size, 2, 'single-quoted channel attr should also parse');
  assert.equal((byChAll.get('ch.two') || [])[0].title, 'Match Night');
});

test('TmdbProxy deduplicates concurrent identical requests via single-flight map', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 550, title: 'Fight Club', hits }));
    }, 35);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  const mem = {};
  const store = {
    read: (k, def) => (k in mem ? mem[k] : def),
    update: (k, def, fn) => { mem[k] = fn(k in mem ? mem[k] : def); return mem[k]; },
  };
  const tmdb = new TmdbProxy(store, () => 'test-key', `http://127.0.0.1:${port}`);

  try {
    const results = await Promise.all([
      tmdb.get('/movie/550'),
      tmdb.get('/movie/550'),
      tmdb.get('/movie/550'),
      tmdb.get('/movie/550'),
      tmdb.get('/movie/550'),
    ]);
    assert.equal(hits, 1, '5 concurrent identical calls should trigger only 1 upstream TMDB request');
    for (const r of results) assert.equal(r.title, 'Fight Club');
    assert.equal(tmdb._inFlight.size, 0, '_inFlight map should clean up after completion');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('TmdbProxy retains more than 500 entries without premature eviction', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url.split('?')[0] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  const mem = {};
  const store = {
    read: (k, def) => (k in mem ? mem[k] : def),
    update: (k, def, fn) => { mem[k] = fn(k in mem ? mem[k] : def); return mem[k]; },
  };
  const tmdb = new TmdbProxy(store, () => 'test-key', `http://127.0.0.1:${port}`);

  try {
    for (let i = 1; i <= 600; i++) {
      await tmdb.get(`/movie/${i}`);
    }
    const keys = Object.keys(mem['tmdb-cache'] || {});
    assert.equal(keys.length, 600, '600 entries should all remain cached under the 4000 cap');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Wave 5 server and web contracts remain wired', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

  assert.match(serverSrc, /iptvAggregateCaches\s*=\s*new Map\(\)/, 'per-user IPTV aggregate cache Map');
  assert.match(serverSrc, /schedulePersistXtreamEpgCache/, 'debounced Xtream EPG disk persistence');
  assert.match(serverSrc, /flushPendingXtreamEpgPersists/, 'Xtream EPG persistence flushed on shutdown');
  assert.match(serverSrc, /function warmXmltvFromRam\(/, 'non-blocking warm RAM XMLTV lookup');
  assert.match(serverSrc, /maturityCertCache\s*=\s*new Map\(\)/, 'maturity cert lookup cache');

  assert.match(webSrc, /function discoverTrailerList\(/, 'Discover trailer list memoization');
  assert.match(webSrc, /S\._calReq/, 'Calendar stale-request race guard');
  assert.match(webSrc, /batch\.length\s*<\s*8/, 'MSE pump chunk coalescing');
});

'use strict';
// Wave 6 regression tests: Local Library SQLite composite indexes + batched newEpisodeInfo,
// parallel Trakt pullWatched + keep-alive cleanup, userDelete cascade cleanup, async local
// streaming cleanup, lazy activity poster index, and resilient Quick Connect polling.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { LibraryDb } = require('../server/library-db');
const { Trakt } = require('../server/trakt');

test('LibraryDb creates composite sort indexes and batches newEpisodeInfo per page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-wave6-libdb-'));
  const db = new LibraryDb(dir);
  try {
    assert.equal(db.available, true, 'SQLite library db should be available');
    const idxNames = new Set(
      db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name),
    );
    assert.ok(idxNames.has('library_items_title_sort_idx'), 'title sort index created');
    assert.ok(idxNames.has('library_items_year_sort_idx'), 'year sort index created');
    assert.ok(idxNames.has('library_items_rating_sort_idx'), 'rating sort index created');

    const now = Date.now();
    const oldTs = now - 60 * 24 * 3600000;
    const items = [
      { idx: 0, kind: 'show', title: 'Alpha Show', year: 2025, rating: 8.5, addedAt: now - 1000, genres: [18] },
      { idx: 1, kind: 'episode', showIdx: 0, s: 1, e: 1, title: 'Alpha Show · S01E01', addedAt: now - 10 * 24 * 3600000 },
      { idx: 2, kind: 'episode', showIdx: 0, s: 1, e: 2, title: 'Alpha Show · S01E02', addedAt: now - 2000 },
      { idx: 3, kind: 'episode', showIdx: 0, s: 1, e: 3, title: 'Alpha Show · S01E03', addedAt: now - 1000 },
      { idx: 4, kind: 'show', title: 'Beta Show', year: 2024, rating: 7.2, addedAt: now - 5000, genres: [18] },
      { idx: 5, kind: 'episode', showIdx: 4, s: 2, e: 4, title: 'Beta Show · S02E04', addedAt: now - 5000 },
      { idx: 6, kind: 'show', title: 'Old Show', year: 2019, rating: 9.0, addedAt: oldTs, genres: [18] },
      { idx: 7, kind: 'episode', showIdx: 6, s: 1, e: 1, title: 'Old Show · S01E01', addedAt: oldTs },
    ];
    db.replaceLibrary('tv1', now, items);

    const page = db.page('tv1', { limit: 10, sort: 'title.asc' });
    assert.equal(page.items.length, 3);
    const alpha = page.items.find((x) => x.title === 'Alpha Show');
    const beta = page.items.find((x) => x.title === 'Beta Show');
    const oldShow = page.items.find((x) => x.title === 'Old Show');

    assert.equal(alpha.newEpisodes, 2, 'Alpha has 2 episodes within batchMs');
    assert.deepEqual(alpha.latestEpisode, { s: 1, e: 3 });
    assert.equal(beta.newEpisodes, 1, 'Beta has 1 recent episode');
    assert.deepEqual(beta.latestEpisode, { s: 2, e: 4 });
    assert.equal(oldShow.newEpisodes, undefined, 'Old Show outside recentMs has no newEpisodes badge');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Trakt pullWatched fetches movies and shows concurrently and destroyAgents cleans up', async () => {
  let active = 0;
  let maxConcurrent = 0;
  const srv = http.createServer((req, res) => {
    active++;
    if (active > maxConcurrent) maxConcurrent = active;
    setTimeout(() => {
      active--;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/sync/watched/movies') {
        res.end(JSON.stringify([{ movie: { title: 'Inception', year: 2010, ids: { tmdb: 27205 } } }]));
      } else if (req.url === '/sync/watched/shows') {
        res.end(JSON.stringify([{
          show: { title: 'Severance', year: 2022, ids: { tmdb: 95396 } },
          seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }],
        }]));
      } else {
        res.end('[]');
      }
    }, 60);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prevBase = process.env.TRAKT_BASE;
  process.env.TRAKT_BASE = `http://127.0.0.1:${srv.address().port}`;

  const mem = {};
  const store = {
    read: (k, def) => (k in mem ? mem[k] : def),
    write: (k, v) => { mem[k] = v; return v; },
    update: (k, def, fn) => { mem[k] = fn(k in mem ? mem[k] : def); return mem[k]; },
  };
  let settingsDoc = {
    traktClientId: 'cid',
    traktClientSecret: 'csec',
    traktTokens: {
      u1: { access: 'tok1', refresh: 'ref1', expiresAt: Date.now() + 3600000 },
    },
  };
  const trakt = new Trakt(store, () => settingsDoc, (fn) => { settingsDoc = fn(settingsDoc) || settingsDoc; });

  try {
    const keys = await trakt.pullWatched('u1');
    assert.equal(maxConcurrent, 2, 'watched movies and watched shows should run in parallel');
    assert.equal(keys.length, 3);
    assert.equal(keys[0].key, 'tmdb:movie:27205');
    assert.equal(keys[1].key, 'tmdb:tv:95396:s1e1');
    assert.equal(keys[2].key, 'tmdb:tv:95396:s1e2');
  } finally {
    trakt.destroyAgents();
    if (prevBase === undefined) delete process.env.TRAKT_BASE;
    else process.env.TRAKT_BASE = prevBase;
    await new Promise((r) => srv.close(r));
  }
});

test('Wave 6 server and web contracts remain wired', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

  assert.match(serverSrc, /legacyThumbsCleaned\s*=\s*new Set\(\)/, 'legacy thumb cleanup gated once per process');
  assert.match(serverSrc, /traktSyncInflight\s*=\s*new Map\(\)/, 'Trakt sync single-flight dedup');
  assert.match(serverSrc, /traktSyncRetryAfter\s*=\s*new Map\(\)/, 'Trakt failure backoff instead of 6h lockout');
  assert.match(serverSrc, /const getPosterIdx = \(\) => \(sharedPosterIdx/, 'Activity shares lazy poster index across sessions & history');
  assert.match(serverSrc, /store\.update\('iptvgroups', \{\}, \(all\) => \{ delete all\[uid\];/, 'userDelete cleans iptvgroups');
  assert.match(serverSrc, /store\.update\('traktOutbox', \{\}, \(all\) => \{ delete all\[uid\];/, 'userDelete cleans traktOutbox');
  assert.match(serverSrc, /if \(trakt\.status\(uid\)\.linked\) trakt\.unlink\(uid\);/, 'userDelete unlinks Trakt');
  assert.match(serverSrc, /function iptvSourcesFromSettings\(s = settings\.peek\(\)\)/, 'hot-path settings.peek()');

  assert.match(webSrc, /Promise\.all\(\[api\('\/api\/status'\), api\('\/api\/settings'\)\]\)/, 'Settings fetches status and settings in parallel');
  assert.match(webSrc, /Date\.now\(\) >= until \? 'expired' : 'pending'/, 'Quick Connect tolerates transient network blips');
  assert.match(webSrc, /Date\.now\(\) > until \? 'expired' : 'pending'/, 'Login QR tolerates transient network blips');
});

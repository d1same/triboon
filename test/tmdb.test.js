'use strict';
// TmdbProxy caching. The one behavior with teeth here is the external_ids self-heal: TMDB serves a
// 200 external_ids body even for a title/episode whose imdb_id is not populated yet (common right
// after a show is added). Caching that empty for the 24h TTL used to pin a no-show-imdb title (e.g.
// "Goosebumps: The Vanishing", tmdb 281666 / show imdb null) into a permanent "no subtitles": the
// /api/ossubs episode-imdb resolution read the cached empty and dead-ended on the tmdb-tv id. The
// proxy must therefore treat an external_ids response with no usable imdb_id as non-cacheable —
// never write it, and never serve a stale one — so the next lookup re-fetches and self-heals.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { TmdbProxy } = require('../server/tmdb');

function memStore(seed = {}) {
  const mem = { ...seed };
  return {
    read: (k, d) => (k in mem ? mem[k] : d),
    update: (k, d, fn) => { mem[k] = fn(k in mem ? mem[k] : d); },
    _mem: mem,
  };
}

// A mock TMDB upstream whose body per path is scriptable, counting how many times each path is hit.
function mockTmdb() {
  const bodies = new Map();        // path (no query) -> () => object
  const hits = new Map();          // path -> count
  const srv = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits.set(path, (hits.get(path) || 0) + 1);
    const make = bodies.get(path);
    if (!make) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(make()));
  });
  return {
    srv,
    setBody: (p, fn) => bodies.set(p, fn),
    hits: (p) => hits.get(p) || 0,
    listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port))),
    close: () => new Promise((r) => srv.close(r)),
  };
}

test('tmdb: external_ids with no usable imdb_id is never cached and self-heals on the next fetch', async () => {
  const up = mockTmdb();
  const port = await up.listen();
  try {
    const store = memStore();
    const tmdb = new TmdbProxy(store, () => 'test-key', `http://127.0.0.1:${port}/3`);
    const path = '/tv/281666/season/1/episode/1/external_ids';

    // Phase 1: TMDB has not populated the episode imdb yet — returns 200 with imdb_id null.
    up.setBody(`/3${path}`, () => ({ id: 999, imdb_id: null, tvdb_id: 1 }));
    const first = await tmdb.get(path);
    assert.strictEqual(first.imdb_id, null, 'the live (empty) body is still returned to the caller');
    assert.strictEqual(up.hits(`/3${path}`), 1);
    assert.ok(!(`${path}` in (store._mem['tmdb-cache'] || {})),
      'an external_ids body with no usable imdb_id must NOT be written to the cache');

    // Phase 2: the caller retries later — because the empty was not cached, this MUST hit upstream
    // again (self-heal), and now TMDB has populated the id.
    up.setBody(`/3${path}`, () => ({ id: 999, imdb_id: 'tt31241619', tvdb_id: 1 }));
    const second = await tmdb.get(path);
    assert.strictEqual(second.imdb_id, 'tt31241619', 'once TMDB populates the id, the caller gets it');
    assert.strictEqual(up.hits(`/3${path}`), 2, 'the empty was not served from cache — a live re-fetch happened');
    assert.ok((store._mem['tmdb-cache'] || {})[path], 'the now-valid external_ids IS cached');

    // Phase 3: a populated external_ids is served from cache (no third upstream hit).
    const third = await tmdb.get(path);
    assert.strictEqual(third.imdb_id, 'tt31241619');
    assert.strictEqual(up.hits(`/3${path}`), 2, 'valid external_ids is cached — no extra upstream hit');
  } finally {
    await up.close();
  }
});

test('tmdb: a pre-existing stale empty external_ids in the cache is ignored (re-fetched live)', async () => {
  const up = mockTmdb();
  const port = await up.listen();
  try {
    const path = '/tv/281666/season/1/episode/1/external_ids';
    // Seed the persisted cache with a fresh-but-empty external_ids (simulates a box that cached the
    // empty earlier, e.g. the owner's Unraid before TMDB populated the episode id).
    const store = memStore({ 'tmdb-cache': { [path]: { at: Date.now(), data: { id: 999, imdb_id: null } } } });
    const tmdb = new TmdbProxy(store, () => 'test-key', `http://127.0.0.1:${port}/3`);
    up.setBody(`/3${path}`, () => ({ id: 999, imdb_id: 'tt31241619' }));

    const got = await tmdb.get(path);
    assert.strictEqual(got.imdb_id, 'tt31241619', 'a cached-but-empty external_ids is not served; the live id wins');
    assert.strictEqual(up.hits(`/3${path}`), 1, 'the stale empty forced a live re-fetch');
  } finally {
    await up.close();
  }
});

test('tmdb: normal (non-external_ids) responses still cache — no regression', async () => {
  const up = mockTmdb();
  const port = await up.listen();
  try {
    const store = memStore();
    const tmdb = new TmdbProxy(store, () => 'test-key', `http://127.0.0.1:${port}/3`);
    const path = '/tv/281666';
    up.setBody(`/3${path}`, () => ({ id: 281666, name: 'Goosebumps: The Vanishing' }));

    await tmdb.get(path);
    await tmdb.get(path);
    assert.strictEqual(up.hits(`/3${path}`), 1, 'a normal detail body is cached after the first fetch');
  } finally {
    await up.close();
  }
});

test('tmdb: a show-level external_ids WITH an imdb caches normally', async () => {
  const up = mockTmdb();
  const port = await up.listen();
  try {
    const store = memStore();
    const tmdb = new TmdbProxy(store, () => 'test-key', `http://127.0.0.1:${port}/3`);
    const path = '/tv/194764/external_ids';
    up.setBody(`/3${path}`, () => ({ id: 194764, imdb_id: 'tt15435876' }));

    await tmdb.get(path);
    await tmdb.get(path);
    assert.strictEqual(up.hits(`/3${path}`), 1, 'a populated external_ids caches like any other 200');
    assert.ok((store._mem['tmdb-cache'] || {})[path], 'populated external_ids is written to cache');
  } finally {
    await up.close();
  }
});

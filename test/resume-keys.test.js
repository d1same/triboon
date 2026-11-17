'use strict';
// Stable resume keys for library items (brief 99, results 85 and 98), end to end through the real
// server: a made-up library on disk, real scans, progress saved the way the pages save it.
// Every name here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { httpJson, bootServer, setupAdmin } = require('./helpers');
const { LibraryDb } = require('../server/library-db');

function startTmdbMock() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const copper = { id: 9001, title: 'Copper Lantern', original_title: 'Copper Lantern', release_date: '2010-04-01', poster_path: '/copper.jpg', overview: 'Made up.' };
    const iron = { id: 9101, name: 'Iron Harbor', original_name: 'Iron Harbor', first_air_date: '2015-02-01', poster_path: '/iron.jpg', overview: 'Made up.' };
    if (u.pathname === '/3/movie/9001') return send(200, { ...copper, genres: [] });
    if (u.pathname === '/3/tv/9101') return send(200, { ...iron, genres: [], seasons: [{ season_number: 1, episode_count: 3 }] });
    if (u.pathname === '/3/tv/9101/season/1') {
      return send(200, { episodes: [1, 2, 3].map((n) => ({ episode_number: n, air_date: '2015-02-0' + n, name: `Part ${n}` })) });
    }
    const m = /^\/3\/search\/(movie|tv)$/.exec(u.pathname);
    if (m) {
      const q = String(u.searchParams.get('query') || '');
      const hits = m[1] === 'movie' && /copper lantern/i.test(q) ? [copper] : (m[1] === 'tv' && /iron harbor/i.test(q) ? [iron] : []);
      return send(200, { page: 1, results: hits, total_results: hits.length });
    }
    return send(404, { status_code: 34 });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const put = (root, rel, body) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body || rel);
};
function makeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-keys-'));
  put(root, 'Copper Lantern (2010)/Copper Lantern.mkv');
  put(root, 'Gol Sorkh گل سرخ [1080p]/gol.sorkh.mkv');
  put(root, 'Shab Abi (2019) شب آبی/shab.abi.mkv');
  for (const n of [1, 2, 3]) put(root, `Iron Harbor (2015)/Season 01/Iron Harbor - S01E0${n}.mp4`);
  for (const n of [1, 2, 3]) put(root, `Darya دریا [1080p]/Season 01/Darya - S01E0${n}.mp4`);
  put(root, 'Kuh کوه [1080p]/tvshow.nfo', '<tvshow><title>IR - Kuh کوه [1080p]</title></tvshow>');
  for (const n of [1, 2, 3]) put(root, `Kuh کوه [1080p]/Season 01/Kuh - S01E0${n}.mp4`);
  return root;
}
async function runScan(port, libId, token) {
  const start = await httpJson(port, 'POST', `/api/libraries/${libId}/scan`, {}, token);
  assert.strictEqual(start.status, 202);
  for (let i = 0; i < 400; i++) {
    const st = await httpJson(port, 'GET', `/api/libraries/${libId}/scanstatus`, null, token);
    if (!st.json.running) return st.json;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan timeout');
}
async function allItems(port, libId, token) {
  const top = (await httpJson(port, 'GET', `/api/libraries/${libId}/items?limit=500`, null, token)).json.items;
  const out = [...top];
  for (const show of top.filter((x) => x.kind === 'show')) {
    out.push(...(await httpJson(port, 'GET', `/api/libraries/${libId}/items?limit=500&showIdx=${show.idx}`, null, token)).json.items);
  }
  return out;
}
const find = (items, re, kind, s, e) => items.find((x) => re.test(x.title) && (!kind || x.kind === kind) && (s == null || (x.s === s && x.e === e)));
const save = (port, token, body) => httpJson(port, 'POST', '/api/watch', body, token);
const rowsOf = async (port, token, profile = 'default') => (await httpJson(port, 'GET', `/api/watch?profile=${profile}`, null, token)).json;
const lookup = async (port, token, key) => (await httpJson(port, 'GET', `/api/libraries/local-lookup?key=${encodeURIComponent(key)}`, null, token)).json.items[key];

test('resume keys: progress stays on its title when folders are added, removed, or a new episode lands in an earlier show (result 98 b1, b2, c)', async () => {
  const root = makeLibrary();
  const mock = await startTmdbMock();
  const srv = await bootServer({ TMDB_BASE: `http://127.0.0.1:${mock.address().port}/3` });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'mock-key' }, admin);
    const lib = (await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Mixed', kind: 'movie', path: root }, admin)).json;
    await runScan(srv.port, lib.id, admin);
    let items = await allItems(srv.port, lib.id, admin);
    const copper = find(items, /^Copper/, 'movie');
    const gol = find(items, /^Gol Sorkh/, 'movie');
    const shab = find(items, /^Shab Abi/, 'movie');
    const ironE2 = find(items, /^Iron Harbor/, 'episode', 1, 2);
    const daryaE2 = find(items, /^Darya/, 'episode', 1, 2);
    const kuhE2 = find(items, /^Kuh/, 'episode', 1, 2);
    assert.strictEqual(copper.watchKey, 'tmdb:movie:9001');
    assert.strictEqual(ironE2.watchKey, 'tmdb:tv:9101:s1e2', 'a matched show\'s episode saves under the catalog key (F-1)');
    for (const it of [gol, shab, daryaE2, kuhE2]) assert.match(it.watchKey, new RegExp(`^local:${lib.id}:[0-9a-f]{12}`), it.title);
    assert.strictEqual(daryaE2.watchKey, `${find(items, /^Darya/, 'show').watchKey}:s1e2`);
    assert.ok(!('relPath' in gol) && !('fileSize' in gol), 'paths and sizes stay on the server');
    assert.strictEqual(find(items, /^Kuh/, 'show').title, 'Kuh کوه', 'the cleaned NFO title (3.4.15)');

    const saved = { [gol.watchKey]: 400, [shab.watchKey]: 410, [daryaE2.watchKey]: 66, [kuhE2.watchKey]: 70, [ironE2.watchKey]: 62 };
    for (const profile of ['default', 'p2']) {
      for (const [key, position] of Object.entries(saved)) {
        const r = await save(srv.port, admin, { key, profile, position, duration: 900, meta: { title: 'card', type: 'movie' } });
        assert.strictEqual(r.status, 200);
      }
    }
    const golRow = (await rowsOf(srv.port, admin)).find((w) => w.key === gol.watchKey);
    assert.strictEqual(golRow.meta.localKey, gol.key, 'the server notes the library item');
    assert.strictEqual(golRow.meta.relPath, undefined === golRow.meta.relPath ? undefined : golRow.meta.relPath);
    assert.ok(String(golRow.meta.relPath).startsWith('Gol Sorkh'), 'and its place in the library');
    const ironRow = (await rowsOf(srv.port, admin)).find((w) => w.key === ironE2.watchKey);
    assert.strictEqual(ironRow.meta.localKey, undefined, 'a catalog key gets no note without the page\'s hint');
    await save(srv.port, admin, { key: ironE2.watchKey, localKey: ironE2.key, position: 63, duration: 900, meta: { title: 'Iron Harbor' } });
    assert.strictEqual((await rowsOf(srv.port, admin)).find((w) => w.key === ironE2.watchKey).meta.localKey, ironE2.key, 'with it, it does');
    await save(srv.port, admin, { key: ironE2.watchKey, localKey: gol.key, position: 64, duration: 900, meta: { title: 'Iron Harbor', localKey: 'forged' } });
    assert.strictEqual((await rowsOf(srv.port, admin)).find((w) => w.key === ironE2.watchKey).meta.localKey, ironE2.key,
      'a hint for another item, or a page-sent localKey, is never taken');

    // b1: two film folders and a show that sort first.
    put(root, 'Aab آب/aab.mkv');
    put(root, 'Baran باران/baran.mkv');
    for (const n of [1, 2]) put(root, `Aaa Show/Season 01/Aaa Show - S01E0${n}.mp4`);
    // c: a new episode of a show that sorts before Kuh.
    put(root, 'Darya دریا [1080p]/Season 01/Darya - S01E04.mp4');
    await runScan(srv.port, lib.id, admin);
    items = await allItems(srv.port, lib.id, admin);
    assert.notStrictEqual(find(items, /^Gol Sorkh/, 'movie').idx, gol.idx, 'positions did move');
    for (const [title, kind, s, e, key] of [[/^Gol Sorkh/, 'movie', null, null, gol.watchKey], [/^Shab Abi/, 'movie', null, null, shab.watchKey],
      [/^Darya/, 'episode', 1, 2, daryaE2.watchKey], [/^Kuh/, 'episode', 1, 2, kuhE2.watchKey]]) {
      assert.strictEqual(find(items, title, kind, s, e).watchKey, key, `${title} keeps its key`);
      const hit = await lookup(srv.port, admin, key);
      assert.ok(hit && title.test(hit.title), `${key} still opens ${title} (got ${hit && hit.title})`);
      if (s != null) assert.strictEqual(hit.e, e);
    }
    for (const profile of ['default', 'p2']) {
      const rows = await rowsOf(srv.port, admin, profile);
      for (const [key, position] of Object.entries(saved)) {
        assert.strictEqual((rows.find((w) => w.key === key) || {}).position, key === ironE2.watchKey && profile === 'default' ? 64 : position, `${profile} ${key}`);
      }
    }

    // b2: a film folder is deleted: its rows leave Continue Watching (kept aside), the others stay.
    fs.rmSync(path.join(root, 'Shab Abi (2019) شب آبی'), { recursive: true, force: true });
    await runScan(srv.port, lib.id, admin);
    const after = await rowsOf(srv.port, admin);
    assert.ok(!after.some((w) => w.key === shab.watchKey), 'the deleted film\'s card is gone');
    assert.ok(after.some((w) => w.key === gol.watchKey));
    // The folder comes back (a share that was briefly away): so does its progress.
    put(root, 'Shab Abi (2019) شب آبی/shab.abi.mkv');
    await runScan(srv.port, lib.id, admin);
    assert.strictEqual((await rowsOf(srv.port, admin, 'p2')).find((w) => w.key === shab.watchKey).position, 410);
  } finally {
    await srv.shutdown();
    mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume keys: Up next comes from the library for local shows, and from the catalog key for a matched show (S-3, F-1)', async () => {
  const root = makeLibrary();
  const mock = await startTmdbMock();
  const srv = await bootServer({ TMDB_BASE: `http://127.0.0.1:${mock.address().port}/3` });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'mock-key' }, admin);
    const lib = (await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Mixed', kind: 'movie', path: root }, admin)).json;
    await runScan(srv.port, lib.id, admin);
    const items = await allItems(srv.port, lib.id, admin);
    const darya1 = find(items, /^Darya/, 'episode', 1, 1);
    const darya2 = find(items, /^Darya/, 'episode', 1, 2);
    const kuh1 = find(items, /^Kuh/, 'episode', 1, 1);
    const iron1 = find(items, /^Iron Harbor/, 'episode', 1, 1);
    for (const it of [darya1, kuh1, iron1]) {
      await save(srv.port, admin, { key: it.watchKey, profile: 'p2', watched: true, position: 120, duration: 120, meta: { title: it.title, type: 'episode' } });
    }
    const next = (await httpJson(srv.port, 'GET', '/api/watch/next?profile=p2', null, admin)).json;
    const keys = next.map((x) => x.key);
    assert.ok(keys.includes(darya2.watchKey), `Darya E02 is next (${keys})`);
    assert.ok(keys.includes(find(items, /^Kuh/, 'episode', 1, 2).watchKey), 'Kuh E02 is next');
    assert.ok(keys.includes('tmdb:tv:9101:s1e2'), 'the matched show is next through its catalog key');
    const card = next.find((x) => x.key === darya2.watchKey);
    assert.strictEqual(card.title, 'Darya دریا');
    assert.ok(card._local && card._local.playUrl, 'the card can play the file without a warm page');
    assert.strictEqual(card._nextEp, true, 'a next-episode card: pressing it plays (and it carries the NEXT EPISODE tag)');
    // Episode 2 in progress: no Up next for that show.
    await save(srv.port, admin, { key: darya2.watchKey, profile: 'p2', position: 60, duration: 120, meta: { title: 'Darya' } });
    const busy = (await httpJson(srv.port, 'GET', '/api/watch/next?profile=p2', null, admin)).json.map((x) => x.key);
    assert.ok(!busy.some((k) => k.startsWith(darya2.watchKey.replace(/:s\d+e\d+$/, ''))), 'a show in progress gets no next card');
    // No TMDB key: library shows still get theirs.
    await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: '' }, admin);
    const offline = (await httpJson(srv.port, 'GET', '/api/watch/next?profile=p2', null, admin)).json.map((x) => x.key);
    assert.ok(offline.includes(find(items, /^Kuh/, 'episode', 1, 2).watchKey));
  } finally {
    await srv.shutdown();
    mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume keys: rows saved by 3.4.15 under scan positions move to their title once, with a backup; unsure ones are kept aside', async () => {
  const root = makeLibrary();
  put(root, 'Twin (2020)/twin.a.mkv');
  put(root, 'Twin (2024)/twin.b.mkv');
  const mock = await startTmdbMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-keys-data-'));
  const srv = await bootServer({ TRIBOON_DATA: data, TMDB_BASE: `http://127.0.0.1:${mock.address().port}/3` });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'mock-key' }, admin);
    const lib = (await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Mixed', kind: 'movie', path: root }, admin)).json;
    await runScan(srv.port, lib.id, admin);
    // Make the store look like 3.4.15: the same items without keys, and rows under positions.
    const db = new LibraryDb(data);
    const rec = db.readLibrary(lib.id);
    const old = rec.items.map((it) => { const c = { ...it }; delete c.key; delete c.relPath; delete c.fileSize; delete c.tmdbShared; return c; });
    db.replaceLibrary(lib.id, rec.scannedAt, old);
    db.close();
    const pos = (re, kind, s, e) => old.find((x) => re.test(x.title) && x.kind === kind && (s == null || (x.s === s && x.e === e))).idx;
    const legacy = (p) => `local:${lib.id}:${p}`;
    const rows = [
      // [profile, key, title, position, extra meta]
      ['default', legacy(pos(/^Gol Sorkh/, 'movie')), 'Gol Sorkh گل سرخ', 400],
      ['p2', legacy(pos(/^Gol Sorkh/, 'movie')), 'Gol Sorkh گل سرخ', 401],
      ['default', legacy(pos(/^Kuh/, 'episode', 1, 2)), 'IR - Kuh کوه [1080p] — S01E02', 70], // 3.4.14 raw NFO title
      ['default', legacy(pos(/^Iron Harbor/, 'episode', 1, 2)), 'Iron Harbor — S01E02', 62], // F-1 move
      ['default', legacy(pos(/^Twin/, 'movie')), 'Twin', 50], // two films called Twin: not guessed
      ['p2', legacy(pos(/^Shab Abi/, 'movie')), 'Some Other Film', 33], // position holds another title now
    ];
    for (const [profile, key, title, position] of rows) {
      const r = await save(srv.port, admin, { key, profile, position, duration: 900, meta: { title, type: 'movie' } });
      assert.strictEqual(r.status, 200);
    }
    assert.ok((await rowsOf(srv.port, admin)).some((w) => w.key === legacy(pos(/^Gol Sorkh/, 'movie'))), 'saved as 3.4.15 did');

    await runScan(srv.port, lib.id, admin); // the first pass of 3.4.16 on this data
    const sized = new LibraryDb(data);
    const stored = sized.readLibrary(lib.id).items;
    sized.close();
    assert.ok(stored.filter((it) => it.file).every((it) => Number.isFinite(it.fileSize)),
      'files stored without a size get one on the first pass (pairing needs it), within the per-pass budget');
    const items = await allItems(srv.port, lib.id, admin);
    const gol = find(items, /^Gol Sorkh/, 'movie');
    const kuh2 = find(items, /^Kuh/, 'episode', 1, 2);
    const def = await rowsOf(srv.port, admin);
    const p2 = await rowsOf(srv.port, admin, 'p2');
    assert.strictEqual(def.find((w) => w.key === gol.watchKey).position, 400);
    assert.strictEqual(p2.find((w) => w.key === gol.watchKey).position, 401);
    assert.strictEqual(def.find((w) => w.key === kuh2.watchKey).position, 70);
    assert.strictEqual(def.find((w) => w.key === 'tmdb:tv:9101:s1e2').position, 62, 'the matched episode joins its catalog key (F-1)');
    assert.ok(![...def, ...p2].some((w) => /^local:[^:]+:\d{1,5}$/.test(w.key)), 'no position row is left');
    const state = srv.store.read('watchKeyState', {});
    assert.ok(state.backupDir && fs.existsSync(path.join(state.backupDir, 'watch.json')), 'a backup was written first');
    const backup = JSON.parse(fs.readFileSync(path.join(state.backupDir, 'watch.json'), 'utf8'));
    assert.ok(Object.keys(backup).some((k) => k.endsWith(legacy(pos(/^Gol Sorkh/, 'movie')))), 'the backup holds the old rows');
    const orphans = srv.store.read('watchOrphans', {});
    const parked = Object.values(orphans).map((o) => o.row.meta.title).sort();
    assert.deepStrictEqual(parked, ['Some Other Film', 'Twin'], 'the two unsure rows are kept aside, not guessed');
  } finally {
    await srv.shutdown();
    mock.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('resume keys: the boot pass keys a library stored by 3.4.15 and moves its rows without a scan', async () => {
  const root = makeLibrary();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-keys-boot-'));
  const srv = await bootServer({ TRIBOON_DATA: data, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    const lib = (await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Mixed', kind: 'movie', path: root }, admin)).json;
    await runScan(srv.port, lib.id, admin);
    const db = new LibraryDb(data);
    const rec = db.readLibrary(lib.id);
    const old = rec.items.map((it) => { const c = { ...it }; delete c.key; delete c.relPath; delete c.fileSize; delete c.tmdbShared; return c; });
    db.replaceLibrary(lib.id, rec.scannedAt, old);
    db.close();
    const golPos = old.find((x) => /^Gol Sorkh/.test(x.title)).idx;
    const before = (await allItems(srv.port, lib.id, admin)).find((x) => /^Gol Sorkh/.test(x.title));
    assert.strictEqual(before.watchKey, undefined, 'an unkeyed item: the page falls back to its position');
    await save(srv.port, admin, { key: `local:${lib.id}:${golPos}`, position: 321, duration: 900, meta: { title: 'Gol Sorkh گل سرخ', type: 'movie' } });
    const out = srv.keyStoredLibraries();
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].stats.moved, 1);
    const gol = (await allItems(srv.port, lib.id, admin)).find((x) => /^Gol Sorkh/.test(x.title));
    assert.match(gol.watchKey, /^local:[^:]+:[0-9a-f]{12}$/);
    assert.strictEqual((await rowsOf(srv.port, admin)).find((w) => w.key === gol.watchKey).position, 321);
    // Run again: nothing left to do.
    const again = srv.keyStoredLibraries()[0];
    assert.strictEqual(again.stats, null);
    assert.strictEqual(again.skipped, true, 'a keyed library with no position rows is not read again at the next start (brief 101: 1.3 s stall on a 21,000-item library)');
    // A position row written later (an old page) brings the pass back.
    await save(srv.port, admin, { key: `local:${lib.id}:${golPos}`, position: 400, duration: 900, meta: { title: 'Gol Sorkh گل سرخ', type: 'movie' } });
    const third = srv.keyStoredLibraries()[0];
    assert.ok(!third.skipped && third.stats && third.stats.moved === 1);
  } finally {
    await srv.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('resume keys: a Jellyfin app and the pages share one row through the stable key, also after a rescan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-keys-jf-'));
  put(root, 'Alpha Film/alpha.mkv');
  put(root, 'Bravo Film/bravo.mkv');
  const srv = await bootServer({ TMDB_BASE: null });
  const send = (method, p, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* text */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { jellyfinApps: true }, admin);
    const lib = (await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Films', kind: 'movie', path: root }, admin)).json;
    await runScan(srv.port, lib.id, admin);
    const items = await allItems(srv.port, lib.id, admin);
    const alpha = find(items, /^Alpha/, 'movie');
    const bravo = find(items, /^Bravo/, 'movie');
    const login = await send('POST', '/Users/AuthenticateByName', { 'content-type': 'application/json', authorization: 'MediaBrowser Client="Test", Device="PC", DeviceId="pc-keys", Version="1"' },
      JSON.stringify({ Username: 'owner', Pw: 'hunter22' }));
    assert.strictEqual(login.status, 200);
    const authz = { authorization: `MediaBrowser Client="Test", Device="PC", DeviceId="pc-keys", Version="1", Token="${login.json.AccessToken}"` };
    const me = (await send('GET', '/Users/Me', authz)).json;
    const shelf = (await send('GET', `/Users/${me.Id}/Items?ParentId=l${lib.id}&IncludeItemTypes=Movie&Recursive=true&Limit=10`, authz)).json.Items;
    const jfBravo = shelf.find((row) => row.Name === 'Bravo Film');
    assert.ok(jfBravo, JSON.stringify(shelf.map((r) => r.Name)));
    const played = await send('POST', `/Users/${me.Id}/PlayedItems/${jfBravo.Id}`, authz);
    assert.strictEqual(played.json.Played, true);
    // Jellyfin saves into the account's first profile (it has no profile picker): read every row.
    const allRows = () => Object.entries(srv.store.read('watch', {})).map(([k, v]) => ({ key: k.split(':').slice(2).join(':'), ...v }));
    const rows = allRows();
    assert.ok(rows.some((w) => w.key === bravo.watchKey && w.watched), `the app's tick lands on the stable key (${rows.map((w) => w.key)})`);
    assert.ok(!rows.some((w) => /^local:[^:]+:\d{1,5}$/.test(w.key)), 'not on a position');
    // A pause saved by a page under the stable key shows on the app's Continue Watching row.
    await save(srv.port, admin, { key: alpha.watchKey, position: 90, duration: 3600, meta: { title: 'Alpha Film', type: 'movie' } });
    let resume = (await send('GET', `/Users/${me.Id}/Items/Resume`, authz)).json.Items;
    assert.strictEqual((resume.find((r) => r.Name === 'Alpha Film') || {}).UserData?.PlaybackPositionTicks, 90 * 10000000);
    // A folder that sorts first moves every position; the app still sees the same title and minute.
    put(root, 'Aaa Film/aaa.mkv');
    await runScan(srv.port, lib.id, admin);
    resume = (await send('GET', `/Users/${me.Id}/Items/Resume`, authz)).json.Items;
    const again = resume.find((r) => r.Name === 'Alpha Film');
    assert.ok(again && again.UserData.PlaybackPositionTicks === 90 * 10000000, 'same title, same minute after the shift');
    assert.ok(!resume.some((r) => r.Name === 'Aaa Film'), 'the new first folder did not take Alpha\'s minute');
    const shelf2 = (await send('GET', `/Users/${me.Id}/Items?ParentId=l${lib.id}&IncludeItemTypes=Movie&Recursive=true&Limit=10`, authz)).json.Items;
    assert.strictEqual(shelf2.find((row) => row.Name === 'Bravo Film').UserData.Played, true, 'the tick stays on Bravo');
    assert.ok(!shelf2.find((row) => row.Name === 'Aaa Film').UserData.Played);
  } finally {
    await srv.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume keys: progress follows its files when the library path changes to the parent folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-keys-path-'));
  put(root, 'Movies/Gol Sorkh گل سرخ/gol.sorkh.mkv', 'GOL');
  put(root, 'Movies/Shab Abi/shab.abi.mkv', 'SHAB-LONGER');
  const srv = await bootServer({ TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    const lib = (await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Films', kind: 'movie', path: path.join(root, 'Movies') }, admin)).json;
    await runScan(srv.port, lib.id, admin);
    const gol = find(await allItems(srv.port, lib.id, admin), /^Gol Sorkh/, 'movie');
    await save(srv.port, admin, { key: gol.watchKey, position: 444, duration: 900, meta: { title: 'Gol Sorkh گل سرخ', type: 'movie' } });
    await httpJson(srv.port, 'PATCH', `/api/libraries/${lib.id}`, { path: root }, admin);
    await runScan(srv.port, lib.id, admin);
    const moved = find(await allItems(srv.port, lib.id, admin), /^Gol Sorkh/, 'movie');
    assert.ok(moved, 'the film is still found one level down');
    assert.notStrictEqual(moved.watchKey, gol.watchKey, 'its place in the library changed');
    const rows = await rowsOf(srv.port, admin);
    assert.strictEqual((rows.find((w) => w.key === moved.watchKey) || {}).position, 444, 'paired by name and size: the minute followed');
    assert.ok(!rows.some((w) => w.key === gol.watchKey), 'no row left on a key nothing has');
  } finally {
    await srv.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume keys: Fix match works in a "Folder & NFO only" library, and switching modes carries progress both ways (S-4, M-3, S-1)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-keys-mode-'));
  put(root, 'Copper Lantern (2010)/Copper Lantern.mkv');
  put(root, 'Romeo/romeo.mkv');
  const mock = await startTmdbMock();
  const srv = await bootServer({ TMDB_BASE: `http://127.0.0.1:${mock.address().port}/3` });
  try {
    const admin = await setupAdmin(srv.port);
    await httpJson(srv.port, 'POST', '/api/settings', { tmdbKey: 'mock-key' }, admin);
    const lib = (await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Films', kind: 'movie', path: root }, admin)).json;
    await runScan(srv.port, lib.id, admin);
    let items = await allItems(srv.port, lib.id, admin);
    const copper = find(items, /^Copper/, 'movie');
    assert.strictEqual(copper.watchKey, 'tmdb:movie:9001');
    // Played from the library copy (the page sends the copy as a hint), and on another profile from
    // Usenet (no hint).
    await save(srv.port, admin, { key: copper.watchKey, localKey: copper.key, position: 300, duration: 900, meta: { title: 'Copper Lantern' } });
    await save(srv.port, admin, { key: copper.watchKey, profile: 'p2', position: 222, duration: 900, meta: { title: 'Copper Lantern', source: { name: 'Copper.Lantern.2010.1080p.WEB' } } });
    // Switch to Folder & NFO only: the library copy's progress follows it to its folder key.
    await httpJson(srv.port, 'PATCH', `/api/libraries/${lib.id}`, { tmdbMatch: 'local' }, admin);
    await runScan(srv.port, lib.id, admin);
    items = await allItems(srv.port, lib.id, admin);
    const local = find(items, /^Copper/, 'movie');
    assert.match(local.watchKey, /^local:/);
    assert.strictEqual((await rowsOf(srv.port, admin)).find((w) => w.key === local.watchKey).position, 300);
    assert.strictEqual((await rowsOf(srv.port, admin, 'p2')).find((w) => w.key === 'tmdb:movie:9001').position, 222,
      'a Usenet watch of the catalog film stays with the catalog film');
    // Fix match inside that library: applied (it used to be saved and never used) and progress follows.
    const romeo = find(items, /^Romeo/, 'movie');
    await save(srv.port, admin, { key: romeo.watchKey, position: 500, duration: 900, meta: { title: 'Romeo' } });
    const fix = await httpJson(srv.port, 'POST', `/api/libraries/${lib.id}/match`, { idx: romeo.idx, tmdbId: 9001 }, admin);
    assert.strictEqual(fix.status, 202);
    for (let i = 0; i < 200; i++) {
      const st = await httpJson(srv.port, 'GET', `/api/libraries/${lib.id}/scanstatus`, null, admin);
      if (!st.json.running) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    items = await allItems(srv.port, lib.id, admin);
    const fixed = find(items, /^Romeo/, 'movie');
    assert.strictEqual(fixed.tmdbId, 9001, 'the pick is applied in local mode');
    assert.strictEqual(fixed.watchKey, 'tmdb:movie:9001');
    assert.strictEqual((await rowsOf(srv.port, admin)).find((w) => w.key === 'tmdb:movie:9001').position, 500, 'its progress followed (S-1)');
    // Back to Auto-match: Copper's progress returns to its catalog key... unless Romeo now holds that id.
    await httpJson(srv.port, 'PATCH', `/api/libraries/${lib.id}`, { tmdbMatch: 'auto' }, admin);
    await runScan(srv.port, lib.id, admin);
    const rows = await rowsOf(srv.port, admin);
    assert.ok(rows.some((w) => w.key === local.watchKey && w.position === 300) || rows.some((w) => w.key === 'tmdb:movie:9001'),
      'nothing is lost when two folders claim one id');
  } finally {
    await srv.shutdown();
    mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

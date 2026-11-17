'use strict';
// The 3.4.16 migration of saved progress on REAL rows: what Triboon 3.4.13, 3.4.14 and 3.4.15 wrote for
// the same made-up library and the same clicks, two profiles each (test/fixtures/resume-keys, made by
// the result-98 QA rig with each version's own server and page). The boot pass keys the stored items
// and moves every row; nothing is guessed, nothing is lost.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootServer } = require('./helpers');
const { LibraryDb } = require('../server/library-db');

const FIX = path.join(__dirname, 'fixtures', 'resume-keys');

for (const version of ['3.4.13', '3.4.14', '3.4.15']) {
  test(`resume keys: rows written by ${version} move to their titles for both profiles, with nothing guessed or lost`, async () => {
    const dir = path.join(FIX, version);
    const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const capture = read('capture.json');
    // The rig ran on Windows: on Linux the stored library paths are Linux paths, as a server there writes them.
    const local = (p) => (typeof p === 'string' && path.sep === '/' ? p.replace(/^C:\\qa-lib/, '/qa-lib').replace(/\\/g, '/') : p);
    const libs = read('libraries.json');
    for (const lib of libs.list) lib.path = local(lib.path);
    const items = read('library-items.json').rows.map((r) => ({ ...r, payload: { ...r.payload, file: local(r.payload.file), dir: local(r.payload.dir) } }));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `triboon-keys-${version}-`));
    for (const f of ['watch.json', 'watchlist.json']) fs.copyFileSync(path.join(dir, f), path.join(data, f));
    fs.writeFileSync(path.join(data, 'libraries.json'), JSON.stringify(libs));
    const db = new LibraryDb(data);
    for (const lib of libs.list) {
      db.replaceLibrary(lib.id, 1, items.filter((r) => r.lib_id === lib.id).map((r) => ({ ...r.payload, idx: r.idx })));
    }
    db.close();
    const before = read('watch.json');
    const srv = await bootServer({ TRIBOON_DATA: data, TMDB_BASE: null });
    try {
      const out = srv.keyStoredLibraries();
      assert.strictEqual(out.length, 2);
      const keyed = new LibraryDb(data);
      const [movies, tv] = libs.list;
      const M = keyed.readLibrary(movies.id).items;
      const T = keyed.readLibrary(tv.id).items;
      keyed.close();
      const film = (re) => M.find((it) => re.test(it.title));
      const ep = (re, e) => T.find((it) => it.kind === 'episode' && re.test(it.title) && it.e === e);
      const show = (re) => T.find((it) => it.kind === 'show' && re.test(it.title));
      for (const it of [...M, ...T]) assert.match(it.key, /^local:[0-9a-f]+:[0-9a-f]{12}(:s\d+e\d+)?$/, it.title);

      const watch = srv.store.read('watch', {});
      const list = srv.store.read('watchlist', {});
      const orphans = srv.store.read('watchOrphans', {});
      const uid = capture.userId;
      const [owner, second] = capture.profiles.map((p) => p.id);
      const at = (profile, key) => watch[`${uid}:${profile}:${key}`];
      const legacyKey = (it) => (it.kind === 'episode' && it.tmdbId ? `tmdb:tv:${it.tmdbId}:s${it.s}e${it.e}` : it.key);
      const gol = film(/^Gol Sorkh/);
      const shab = film(/^Shab Abi/);
      const iron2 = ep(/^Iron Harbor/, 2);
      const darya = [1, 2, 3].map((e) => ep(/^Darya/, e));
      const kuh = [1, 2].map((e) => ep(/Kuh/, e));

      // "owner": the film at 42 %, E01 finished and E02 at 55 % of each show, a watched tick on Darya E03.
      assert.strictEqual(at(owner, 'tmdb:movie:9001').position, before[`${uid}:${owner}:tmdb:movie:9001`].position, 'the matched film stays on its catalog key');
      assert.strictEqual(at(owner, gol.key).position, 127);
      assert.ok(at(owner, shab.key) && at(owner, shab.key).position > 100);
      assert.strictEqual(at(owner, 'tmdb:tv:9101:s1e1').watched, true, 'the matched show\'s episode joins the catalog key (F-1)');
      assert.ok(at(owner, legacyKey(iron2)).position > 60);
      assert.strictEqual(at(owner, darya[0].key).watched, true);
      assert.ok(at(owner, darya[1].key).position > 60);
      assert.strictEqual(at(owner, darya[2].key).watched, true, 'the episode tick saved with only the show title');
      assert.strictEqual(at(owner, kuh[0].key).watched, true, `${version}'s Kuh title is confirmed`);
      assert.ok(at(owner, kuh[1].key).position > 60);
      // "Second": E01 of each show finished, Kuh E02 at 55 %, Shab Abi at 42 %, a watched tick on Gol Sorkh.
      assert.strictEqual(at(second, 'tmdb:tv:9101:s1e1').watched, true);
      assert.strictEqual(at(second, darya[0].key).watched, true);
      assert.strictEqual(at(second, kuh[0].key).watched, true);
      assert.ok(at(second, kuh[1].key).position > 60);
      assert.ok(at(second, shab.key).position > 100);
      assert.strictEqual(at(second, gol.key).watched, true, 'the tick from the library card menu');
      // Every row has a home; no row is left on a position, none kept aside, none lost.
      const keys = Object.keys(watch);
      assert.ok(!keys.some((k) => /:local:[^:]+:\d{1,5}$/.test(k)), keys.join('\n'));
      assert.deepStrictEqual(orphans, {}, 'nothing kept aside: every row of these clicks is confirmable');
      const rowsBefore = Object.keys(before).length;
      const merged = (out[0].stats ? out[0].stats.merged : 0) + (out[1].stats ? out[1].stats.merged : 0);
      assert.strictEqual(keys.length + merged, rowsBefore, 'every row is kept, or merged into a newer row of the same episode');
      // Watchlist: the show bookmark and the film bookmark follow; catalog keys stay.
      assert.ok(list[`${uid}:${show(/^Darya/).key}`], 'Darya show bookmark');
      assert.ok(list[`${uid}:${gol.key}`], 'Gol Sorkh bookmark');
      assert.ok(list[`${uid}:tmdb:movie:9001`] && list[`${uid}:tmdb:tv:9101`]);
      assert.ok(!Object.keys(list).some((k) => /:local:[^:]+:\d{1,5}$/.test(k)));
      // The server noted the library item on each moved row, and kept a copy of the old tables.
      assert.strictEqual(at(owner, gol.key).meta.localKey, gol.key);
      const state = srv.store.read('watchKeyState', {});
      const backup = JSON.parse(fs.readFileSync(path.join(state.backupDir, 'watch.json'), 'utf8'));
      assert.deepStrictEqual(backup, before, 'the backup is the table as the old version left it');
    } finally {
      await srv.shutdown();
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
}

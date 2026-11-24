'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LibraryDb } = require('../server/library-db');

test('library sqlite catalog pages and looks up local media without genre false positives', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-library-db-'));
  const db = new LibraryDb(dir);
  if (!db.available) return;
  try {
    const items = [
      { idx: 1, kind: 'movie', title: 'The Matrix', year: 1999, tmdbId: 603, genres: [28, 878], addedAt: 3000, file: '/media/matrix.mkv' },
      { idx: 2, kind: 'movie', title: 'Not Sci Fi', year: 2020, tmdbId: 1, genres: [2878], addedAt: 2000, file: '/media/not-scifi.mkv' },
      { idx: 3, kind: 'show', title: 'Test Show', year: 2026, tmdbId: 424242, genres: [18], addedAt: 1000, dir: '/media/show' },
      { idx: 4, kind: 'episode', showIdx: 3, title: 'Episode Two', tmdbId: 424242, s: 1, e: 2, addedAt: 1001, file: '/media/show/s01e02.mkv' },
    ];
    assert.strictEqual(db.replaceLibrary('libA', 12345, items), true);
    assert.strictEqual(db.checkpoint(), true, 'library SQLite catalog can checkpoint stale WAL pages after scans');

    const first = db.page('libA', { offset: 0, limit: 2, sort: 'added.desc' });
    assert.strictEqual(first.total, 3, 'top-level page excludes episodes');
    assert.deepStrictEqual(first.items.map((i) => i.title), ['The Matrix', 'Not Sci Fi']);
    assert.strictEqual(first.hasMore, true);

    const byTitle = db.page('libA', { offset: 0, limit: 10, sort: 'title.asc' });
    assert.deepStrictEqual(byTitle.items.map((i) => i.title), ['Not Sci Fi', 'Test Show', 'The Matrix']);
    const nineties = db.page('libA', { offset: 0, limit: 10, years: [1999] });
    assert.deepStrictEqual(nineties.items.map((i) => i.title), ['The Matrix']);
    db.replaceLibrary('libShows', 99, [
      { idx: 0, kind: 'show', title: 'Old Show', addedAt: 5000, dir: '/old' },
      { idx: 1, kind: 'episode', showIdx: 0, title: 'Old Episode', s: 1, e: 1, addedAt: 1000, file: '/old/e.mkv' },
      { idx: 2, kind: 'show', title: 'New Show', addedAt: 1000, dir: '/new' },
      { idx: 3, kind: 'episode', showIdx: 2, title: 'New Episode', s: 1, e: 1, addedAt: 9000, file: '/new/e.mkv' },
    ]);
    const newestEpisode = db.page('libShows', { offset: 0, limit: 10, sort: 'content.desc' });
    assert.deepStrictEqual(newestEpisode.items.map((i) => i.title), ['New Show', 'Old Show'],
      'a show sorts by its newest episode, not the day the show folder appeared');
    const letter = db.page('libA', { offset: 0, limit: 10, starts: 'm' });
    assert.deepStrictEqual(letter.items.map((i) => i.title), ['The Matrix'], 'M matches Matrix after the word The');
    db.replaceLibrary('libSort', 50, [
      { idx: 1, kind: 'movie', title: '2001', year: 1968, runtime: 140, addedAt: 1, file: '/a.mkv' },
      { idx: 2, kind: 'movie', title: 'Short', year: 2020, runtime: 80, addedAt: 2, file: '/b.mkv' },
      { idx: 3, kind: 'movie', title: 'The Long One', year: 2010, runtime: 180, addedAt: 3, file: '/c.mkv' },
    ]);
    const longest = db.page('libSort', { offset: 0, limit: 10, sort: 'runtime.desc' });
    assert.deepStrictEqual(longest.items.map((i) => i.title), ['The Long One', '2001', 'Short']);
    const numbers = db.page('libSort', { offset: 0, limit: 10, before: 'A' });
    assert.deepStrictEqual(numbers.items.map((i) => i.title), ['2001'], 'the # letter keeps titles that do not start with a letter');
    const scifi = db.page('libA', { offset: 0, limit: 10, genre: 878 });
    assert.deepStrictEqual(scifi.items.map((i) => i.title), ['The Matrix'],
      'genre tokens do not match larger ids like 2878');

    const eps = db.page('libA', { showIdx: 3, offset: 0, limit: 10 });
    assert.strictEqual(eps.show.title, 'Test Show');
    assert.deepStrictEqual(eps.items.map((i) => `${i.s}x${i.e}`), ['1x2']);

    const named = db.search('matrix', ['libA']);
    assert.strictEqual(named.length, 1, 'title search finds the local movie');
    assert.strictEqual(named[0].item.title, 'The Matrix');
    assert.deepStrictEqual(db.search('matrix', ['otherLib']), [], 'search respects allowed library ids');
    assert.deepStrictEqual(db.search('m', ['libA']), [], 'one-letter search stays empty');
    db.replaceLibrary('libOffice', 12346, [
      { idx: 1, kind: 'show', title: 'The Office', year: 2005, tmdbId: 2316, addedAt: 1, dir: '/media/The Office' },
      { idx: 2, kind: 'show', title: 'Police Javan', year: 2020, tmdbId: 2, addedAt: 9, dir: '/media/police', overview: 'A cop walks into the office' },
      { idx: 3, kind: 'movie', title: 'Rice Cake', year: 1988, tmdbId: 3, addedAt: 8, file: '/media/rice.mkv' },
      { idx: 4, kind: 'movie', title: 'ABC Africa', year: 2001, tmdbId: 4, addedAt: 7, file: '/media/africa.mkv' },
      { idx: 5, kind: 'show', title: 'Onside', year: 2024, tmdbId: 5, addedAt: 6, dir: '/media/onside' },
    ]);
    const officeHits = db.search('the office', ['libOffice']);
    assert.deepStrictEqual(officeHits.map((x) => x.item.title), ['The Office'],
      'The Office must not pull in Police/Onside/Africa just because office is close');
    assert.deepStrictEqual(db.search('office', ['libOffice']).map((x) => x.item.title), ['The Office']);

    const found = db.lookup(['tmdb:movie:603', 'tmdb:tv:424242:s1e2', 'local:libA:1'], ['libA']);
    assert.strictEqual(found['tmdb:movie:603'].item.title, 'The Matrix');
    assert.strictEqual(found['tmdb:tv:424242:s1e2'].item.title, 'Episode Two');
    assert.strictEqual(found['local:libA:1'].item.title, 'The Matrix',
      'Continue Watching local: keys resolve unmatched personal-library files');
    assert.deepStrictEqual(db.lookup(['local:libA:1'], ['otherLib']), {}, 'local: lookup respects allowed library ids');
    assert.deepStrictEqual(db.lookup(['tmdb:movie:603'], ['otherLib']), {}, 'lookup respects allowed library ids');

    const matrix = db.item('libA', 1);
    matrix.title = 'The Matrix Reloaded';
    matrix.tmdbId = 604;
    assert.strictEqual(db.updateItem('libA', 1, matrix), true);
    assert.strictEqual(db.lookup(['tmdb:movie:603'], ['libA'])['tmdb:movie:603'], undefined);
    assert.strictEqual(db.lookup(['tmdb:movie:604'], ['libA'])['tmdb:movie:604'].item.title, 'The Matrix Reloaded');

    assert.strictEqual(db.firstEpisodeFile('libA', 3), '/media/show/s01e02.mkv',
      'show covers look up one episode file, not the whole catalog');
    assert.strictEqual(db.firstEpisodeFile('libA', 99), null);

    assert.strictEqual(db.deleteLibrary('libA'), true);
    assert.strictEqual(db.readLibrary('libA'), null);
  } finally {
    db.close();
  }
});

test('library genre list is cached per scan and invalidated on rescan/update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-library-genres-'));
  const db = new LibraryDb(dir);
  if (!db.available) return;
  try {
    db.replaceLibrary('libG', 100, [
      { idx: 1, kind: 'movie', title: 'A', tmdbId: 1, genres: [28, 12], addedAt: 1, file: '/m/a.mkv' },
      { idx: 2, kind: 'movie', title: 'B', tmdbId: 2, genres: [878], addedAt: 2, file: '/m/b.mkv' },
    ]);
    assert.deepStrictEqual(db.genresCached('libG', 100), [12, 28, 878], 'genre set computed');
    // Cache hit: mutate the underlying row directly, then the SAME scannedAt must still return the
    // cached set — proving genresCached does NOT full-scan on every call.
    db.db.prepare("UPDATE library_items SET genres='|99|' WHERE lib_id='libG' AND idx=1").run();
    assert.deepStrictEqual(db.genresCached('libG', 100), [12, 28, 878], 'same scannedAt → cached, no re-scan');
    // Rescan (new scannedAt) refreshes the cache.
    db.replaceLibrary('libG', 200, [
      { idx: 1, kind: 'movie', title: 'A', tmdbId: 1, genres: [16], addedAt: 1, file: '/m/a.mkv' },
    ]);
    assert.deepStrictEqual(db.genresCached('libG', 200), [16], 'rescan refreshes the genre cache');
    // updateItem invalidates too (a match-override can change genres without a rescan).
    const it = db.item('libG', 1); it.genres = [16, 35];
    db.updateItem('libG', 1, it);
    assert.deepStrictEqual(db.genresCached('libG', 200), [16, 35], 'updateItem invalidates the genre cache');
    assert.deepStrictEqual(db.page('libG', { offset: 0, limit: 10 }).genres, [16, 35], 'page() surfaces cached genres');
  } finally {
    db.close();
  }
});

test('mapped drive letters resolve to the UNC share when the letter is missing', () => {
  const { resolveLibraryPath, windowsMappedUnc } = require('../server/library-path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-libpath-'));
  assert.strictEqual(resolveLibraryPath(dir), dir, 'existing folders stay as-is');
  assert.strictEqual(resolveLibraryPath(''), '', 'empty path stays empty');
  if (process.platform !== 'win32') return;
  const unc = windowsMappedUnc('M');
  if (!unc) return;
  const missing = 'M:\\__triboon_no_such_library_folder__';
  assert.ok(!fs.existsSync(missing), 'probe folder must be absent so the UNC rewrite runs');
  const resolved = resolveLibraryPath(missing);
  assert.ok(resolved.toLowerCase().startsWith(unc.toLowerCase()),
    'missing M: becomes the UNC share so an elevated scan can still walk files');
  assert.ok(/__triboon_no_such_library_folder__$/i.test(resolved), 'folder under the share is kept');
  if (fs.existsSync('M:\\') && fs.existsSync(unc)) {
    const both = resolveLibraryPath('M:\\');
    assert.ok(both.toLowerCase().startsWith(unc.toLowerCase()),
      'when the share is there, the scan uses it even if the drive letter also exists');
  }
});

test('library firstEpisodeFile picks the earliest season/episode file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-library-epfile-'));
  const db = new LibraryDb(dir);
  if (!db.available) return;
  try {
    db.replaceLibrary('libE', 1, [
      { idx: 1, kind: 'show', title: 'Show', year: 2026, dir: '/tv/show' },
      { idx: 2, kind: 'episode', showIdx: 1, title: 'S2', s: 2, e: 1, file: '/tv/show/s02e01.mkv' },
      { idx: 3, kind: 'episode', showIdx: 1, title: 'S1E2', s: 1, e: 2, file: '/tv/show/s01e02.mkv' },
      { idx: 4, kind: 'episode', showIdx: 1, title: 'S1E1', s: 1, e: 1, file: '/tv/show/s01e01.mkv' },
    ]);
    assert.strictEqual(db.firstEpisodeFile('libE', 1), '/tv/show/s01e01.mkv');
  } finally {
    db.close();
  }
});

test('library page: a show card says which of its episodes are new', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-library-newep-'));
  const db = new LibraryDb(dir);
  if (!db.available) return;
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    db.replaceLibrary('tv', 1, [
      { idx: 0, kind: 'show', title: 'Daily Show', addedAt: now - 1 * day, dir: '/tv/daily' },
      { idx: 1, kind: 'episode', showIdx: 0, s: 1, e: 1, addedAt: now - 90 * day, file: '/tv/daily/e1.mkv' },
      { idx: 2, kind: 'episode', showIdx: 0, s: 1, e: 2, addedAt: now - 3 * day, file: '/tv/daily/e2.mkv' },
      { idx: 3, kind: 'episode', showIdx: 0, s: 1, e: 3, addedAt: now - 1 * day, file: '/tv/daily/e3.mkv' },
      { idx: 4, kind: 'show', title: 'One New', addedAt: now - 5 * day, dir: '/tv/one' },
      { idx: 5, kind: 'episode', showIdx: 4, s: 2, e: 4, addedAt: now - 60 * day, file: '/tv/one/e4.mkv' },
      { idx: 6, kind: 'episode', showIdx: 4, s: 2, e: 5, addedAt: now - 5 * day, file: '/tv/one/e5.mkv' },
      { idx: 7, kind: 'show', title: 'Quiet Show', addedAt: now - 200 * day, dir: '/tv/quiet' },
      { idx: 8, kind: 'episode', showIdx: 7, s: 1, e: 1, addedAt: now - 200 * day, file: '/tv/quiet/e1.mkv' },
      { idx: 9, kind: 'movie', title: 'A Film', addedAt: now, file: '/films/a.mkv' },
    ]);
    const page = db.page('tv', { offset: 0, limit: 10, sort: 'added.desc' });
    const by = Object.fromEntries(page.items.map((i) => [i.title, i]));
    assert.deepStrictEqual(page.items.map((i) => i.title), ['A Film', 'Daily Show', 'One New', 'Quiet Show']);
    assert.strictEqual(by['Daily Show'].newEpisodes, 2, 'E2 and E3 came within three days of each other; E1 is old');
    assert.deepStrictEqual(by['Daily Show'].latestEpisode, { s: 1, e: 3 });
    assert.strictEqual(by['One New'].newEpisodes, 1);
    assert.deepStrictEqual(by['One New'].latestEpisode, { s: 2, e: 5 });
    assert.strictEqual(by['Quiet Show'].newEpisodes, undefined, 'nothing new in the last 30 days');
    assert.strictEqual(by['A Film'].newEpisodes, undefined, 'films carry no episode info');
    const eps = db.page('tv', { offset: 0, limit: 10, showIdx: 0 });
    assert.ok(eps.items.every((i) => i.newEpisodes === undefined), 'the episode list of a show is unchanged');
  } finally {
    db.close && db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('library db: the stable key has its own column, the relative path is not stored, and a 5211707 database is upgraded (brief 101)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-keys-db-'));
  try {
    // A database as 5211707 wrote it: no item_key column, the key inside the payload, an expression index.
    const raw = new DatabaseSync(path.join(dir, 'library.sqlite'));
    raw.exec(`CREATE TABLE library_meta (lib_id TEXT PRIMARY KEY, scanned_at INTEGER NOT NULL);
      CREATE TABLE library_items (lib_id TEXT NOT NULL, idx INTEGER NOT NULL, kind TEXT NOT NULL, show_idx INTEGER, tmdb_id INTEGER,
        season INTEGER, episode INTEGER, title TEXT, title_key TEXT, year INTEGER, rating REAL, added_at INTEGER, file TEXT,
        art_file TEXT, dir TEXT, genres TEXT, payload TEXT NOT NULL, PRIMARY KEY (lib_id, idx));
      CREATE INDEX library_items_key_idx ON library_items(lib_id, json_extract(payload, '$.key'));
      INSERT INTO library_meta VALUES ('libA', 1);`);
    raw.prepare('INSERT INTO library_items (lib_id, idx, kind, title, payload) VALUES (?, ?, ?, ?, ?)')
      .run('libA', 0, 'movie', 'Old', JSON.stringify({ idx: 0, kind: 'movie', title: 'Old', key: 'local:libA:0123456789ab', relPath: 'Old/old.mkv' }));
    raw.close();
    const db = new LibraryDb(dir);
    assert.strictEqual(db.itemByKey('libA', 'local:libA:0123456789ab').title, 'Old', 'the key column is backfilled from the payload');
    assert.strictEqual(db.unkeyedCount('libA'), 0);
    const idx = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'library_items'").all().map((r) => r.name);
    assert.ok(!idx.includes('library_items_key_idx'), 'the json_extract index is gone (it parsed every payload on each write)');
    assert.ok(idx.includes('library_items_item_key_idx'));
    db.replaceLibrary('libA', 2, [{ idx: 0, kind: 'movie', title: 'New', key: 'local:libA:aaaaaaaaaaaa', relPath: 'New/new.mkv' }, { idx: 1, kind: 'movie', title: 'Unkeyed' }]);
    const payload = db.db.prepare('SELECT payload FROM library_items WHERE lib_id = ? AND idx = 0').get('libA').payload;
    assert.ok(!/relPath/.test(payload), 'the relative path is recomputed, not stored');
    assert.strictEqual(db.itemByKey('libA', 'local:libA:aaaaaaaaaaaa').title, 'New');
    assert.strictEqual(db.unkeyedCount('libA'), 1);
    assert.strictEqual(db.unkeyedCount('nope'), null);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('library sqlite search handles Persian spelling folding, matchTitle, and cached non-episode index without loading episodes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-library-fa-search-'));
  const db = new LibraryDb(dir);
  if (!db.available) return;
  try {
    db.replaceLibrary('libFa', 500, [
      { idx: 1, kind: 'movie', title: 'درباره كوچك', originalTitle: 'درباره کوچک', tmdbId: 731, addedAt: 3000, file: '/fa/small.mkv' },
      { idx: 2, kind: 'show', title: 'Kaval کول', tmdbId: null, addedAt: 2000, dir: '/fa/kaval' },
      { idx: 3, kind: 'show', title: 'Bandar Sefid بندر سفید', matchTitle: 'White Harbour', tmdbId: 721, addedAt: 1000, dir: '/fa/bandar' },
      { idx: 4, kind: 'episode', showIdx: 3, title: 'Bandar Sefid · S01E01', s: 1, e: 1, addedAt: 1001, file: '/fa/bandar/e1.mkv' },
    ]);
    // Direct Persian search with Persian Yeh/Kaf finds Arabic Yeh/Kaf stored title.
    assert.deepStrictEqual(db.search('درباره کوچک', ['libFa']).map((x) => x.item.title), ['درباره كوچك']);
    assert.deepStrictEqual(db.search('کول', ['libFa']).map((x) => x.item.title), ['Kaval کول']);
    // Non-episode cached index excludes episodes and exposes matchTitle for fast matcher fallback.
    const byMatch = db.searchByMatcher(['libFa'], (e) => /white harbour/i.test(e.matchTitle || ''), 10);
    assert.deepStrictEqual(byMatch.map((x) => x.item.title), ['Bandar Sefid بندر سفید']);
    const titles = db.topTitles(['libFa'], 100);
    assert.ok(titles.includes('Kaval کول') && !titles.some((t) => /S01E01/.test(t)), 'topTitles excludes episodes');
    // Unchanged touch preserves cache; updateItem/deleteLibrary invalidate it.
    assert.strictEqual(db.touchLibrary('libFa', 600), true);
    assert.strictEqual(db._searchCache.get('libFa').scannedAt, 600);
    const it = db.item('libFa', 2);
    it.title = 'Kaval جدید';
    db.updateItem('libFa', 2, it);
    assert.strictEqual(db._searchCache.has('libFa'), false);
    assert.deepStrictEqual(db.search('جدید', ['libFa']).map((x) => x.item.title), ['Kaval جدید']);
    db.deleteLibrary('libFa');
    assert.strictEqual(db._searchCache.has('libFa'), false);
  } finally {
    db.close && db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

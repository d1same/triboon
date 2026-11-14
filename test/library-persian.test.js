'use strict';

// Local libraries with Persian names: the shown title is the folder name, a near or same-year
// Persian title never binds, explicit picks (NFO id, admin Fix match on the show) survive, and
// Persian season folders / numbered episodes are seen as a series. Every name here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const lm = require('../server/library-match');
const { httpJson, bootServer, setupAdmin } = require('./helpers');

// ---------- matching (unit) ----------

test('a Persian name with a year does not bind a same-year Persian title with other words', () => {
  const decoy = { id: 1, title: 'Paper Moon', original_title: 'ماه کاغذی', release_date: '2025-02-01' };
  const right = { id: 2, title: 'Blue Petal', original_title: 'گلبرگ آبی', release_date: '2025-03-01' };
  assert.strictEqual(lm.pickLibraryTmdbHit([decoy, right], 'گلبرگ آبی (2025)', '2025', 'movie'), right,
    'the decoy listed first must be skipped, the right title still binds');
  assert.strictEqual(lm.pickLibraryTmdbHit([decoy], 'گلبرگ آبی (2025)', '2025', 'movie'), null,
    'with only the decoy there is no match at all');
  // Arabic Yeh/Kaf in the folder, Persian letters at TMDB: the same name.
  const elly = { id: 3, title: 'On Ella', original_title: 'درباره الی کوچک', release_date: '2009-02-06' };
  const other = { id: 4, title: 'Other Film', original_title: 'فیلم دیگر', release_date: '2009-01-01' };
  assert.strictEqual(lm.pickLibraryTmdbHit([other, elly], 'درباره الي كوچك (2009)', '2009', 'movie'), elly);
});

test('a short folder name does not take a longer near name (a short name inside a longer one)', () => {
  const near = { id: 10, name: 'Kavalda', original_name: 'کولدا', first_air_date: '2019-12-20' };
  const right = { id: 11, name: 'Kaval', original_name: 'کول', first_air_date: '2025-01-01' };
  assert.strictEqual(lm.pickLibraryTmdbHit([near], 'Kaval کول [1080p]', null, 'tv'), null, 'Kaval is not Kavalda');
  assert.strictEqual(lm.pickLibraryTmdbHit([near, right], 'Kaval کول [1080p]', null, 'tv'), right,
    'the [1080p] tag no longer blocks the right show');
});

test('mixed Latin + Persian names: Persian candidates need the Persian words, foreign ones need Latin words and a year', () => {
  const dubbed = { id: 20, title: 'Chariot Days', original_title: 'Chariot Days', release_date: '1959-11-18' };
  assert.strictEqual(lm.pickLibraryTmdbHit([dubbed], 'Chariot Days (1959) روزهای ارابه', '1959', 'movie'), dubbed,
    'a dubbed foreign film binds on its Latin title and year');
  assert.strictEqual(lm.pickLibraryTmdbHit([dubbed], 'Chariot Days روزهای ارابه [1080p]', null, 'movie'), null,
    'without a year the Latin words alone are too weak for a Persian-named folder');
  const persianOther = { id: 21, title: 'Chariot Days', original_title: 'روزهای دیگر', release_date: '1959-01-01' };
  assert.strictEqual(lm.pickLibraryTmdbHit([persianOther], 'Chariot Days (1959) روزهای ارابه', '1959', 'movie'), null,
    'a Persian candidate with other Persian words never binds on its English title');
});

test('Latin names keep the old rules (articles, numbers, catalog halves)', () => {
  assert.ok(lm.pickLibraryTmdbHit([{ id: 30, title: '1917', release_date: '2019-12-25' }], '1917', null, 'movie'));
  const br = { id: 31, title: 'Glass Runner 2049', release_date: '2017-10-04' };
  assert.strictEqual(lm.pickLibraryTmdbHit([br], 'Glass Runner 2049 (2017)', '2017', 'movie'), br);
  assert.strictEqual(lm.pickLibraryTmdbHit([{ id: 32, title: 'Crystal Skull', release_date: '2008-01-01' }], 'Crystal (2008)', '2008', 'movie'), null);
});

test('Latin names with accents or apostrophes keep matching', () => {
  const tr = { id: 33, title: 'Onur Sözü', original_title: 'Onur Sözü', release_date: '1978-01-01' };
  assert.strictEqual(lm.pickLibraryTmdbHit([tr], 'Onur Sözü (1978)', '1978', 'movie'), tr);
  const fr = { id: 34, title: 'Amélia', original_title: 'Le Monde d\'Amélia', release_date: '2001-04-25' };
  assert.strictEqual(lm.pickLibraryTmdbHit([fr], 'Amelia (2001)', '2001', 'movie'), fr);
  const ap = { id: 35, name: 'Grey\'s Garden', original_name: 'Grey\'s Garden', first_air_date: '2005-03-27' };
  assert.strictEqual(lm.pickLibraryTmdbHit([ap], 'Grey\'s Garden (2005)', '2005', 'tv'), ap);
  assert.strictEqual(lm.pickLibraryTmdbHit([ap], 'Grey\'s Garden (2005) باغ خاکستری', '2005', 'tv'), ap,
    'a dubbed copy with a Persian half binds a foreign title on its Latin half and year');
});

test('years: Solar Hijri and Persian digits are read as the release year', () => {
  assert.deepStrictEqual(
    (({ display, year }) => ({ display, year }))(lm.libraryNameParts('Shahr Kuchak (1382) شهر کوچک')),
    { display: 'Shahr Kuchak شهر کوچک', year: '2003' });
  assert.strictEqual(lm.libraryNameParts('شهر کوچک (۱۳۸۲)').year, '2003');
  assert.strictEqual(lm.libraryNameParts('شهر کوچک (۲۰۰۳)').year, '2003');
  const film = { id: 40, title: 'Small Town', original_title: 'شهر کوچک', release_date: '2004-02-01' };
  assert.strictEqual(lm.pickLibraryTmdbHit([film], 'شهر کوچک (۱۳۸۲)', null, 'movie'), film, '1382 is 2003/2004');
  assert.strictEqual(lm.pickLibraryTmdbHit([{ ...film, release_date: '2012-01-01' }], 'شهر کوچک (۱۳۸۲)', null, 'movie'), null,
    'a movie years apart is another film');
});

test('the shown name is the folder name without its year and release tags', () => {
  const d = (s, o) => lm.libraryNameParts(s, o).display;
  assert.strictEqual(d('Do Gol (2025) دو گل'), 'Do Gol دو گل');
  assert.strictEqual(d('Kaval کول [1080p]'), 'Kaval کول');
  assert.strictEqual(d('Hezar Shab (2025) (IR) هزار شب'), 'Hezar Shab هزار شب');
  assert.strictEqual(d('Bachehaye.Kuche بچه‌های کوچه'), 'Bachehaye Kuche بچه‌های کوچه');
  assert.strictEqual(d('Wonder.Lady.1984.2020.1080p.WEB.mkv', { file: true }), 'Wonder Lady 1984');
  assert.strictEqual(d('Glass Runner 2049.mkv', { file: true }), 'Glass Runner 2049', 'a bare trailing number stays');
  assert.strictEqual(d('Gol Sabz 1390 گل سبز'), 'Gol Sabz 1390 گل سبز', 'a bare year before the Persian half tells parts apart');
});

test('stored matches: NFO ids and admin picks are trusted; episodes are judged by the show folder', () => {
  const showDir = path.join('M:', 'IR', 'SERIES', 'Bandar Sefid (2011) بندر سفید');
  const ep = {
    kind: 'episode', tmdbId: 50, title: 'Bandar Sefid بندر سفید · S01E01', titleSource: 'folder',
    matchTitle: 'White Harbour', originalTitle: 'بندر سفید', matchSource: 'auto', year: '2011', s: 1, e: 1,
    file: path.join(showDir, 'Season 01', 'Bandar Sefid - S01E01.mp4'),
  };
  assert.strictEqual(lm.libraryItemMatchesTmdb(ep), true, 'an episode of a matched Persian show keeps its TMDB id');
  // Rows scanned before this update: episode title carried the English show name only.
  const legacyEp = { kind: 'episode', tmdbId: 50, title: 'White Harbour · S01E01', year: '2011', s: 1, e: 1, file: ep.file };
  assert.strictEqual(lm.libraryItemMatchesTmdb(legacyEp), false, 'a legacy row without the original title is re-checked by the next scan');
  const manualEp = { ...legacyEp, matchSource: 'manual' };
  assert.strictEqual(lm.libraryItemMatchesTmdb(manualEp), true, 'an admin Fix match on the show covers its episodes');
  const nfoFilm = {
    kind: 'movie', tmdbId: 60, title: 'درباره کوچک', titleSource: 'folder', matchSource: 'nfo',
    matchTitle: 'About Small', file: path.join('M:', 'IR', 'MOVIES', 'درباره كوچك', 'درباره كوچك.mkv'),
  };
  assert.strictEqual(lm.libraryItemMatchesTmdb(nfoFilm), true, 'an NFO TMDB id is an explicit pick');
  const nfoPlot = { ...nfoFilm, matchSource: undefined, overview: 'متن خودم', overviewSource: 'nfo' };
  assert.strictEqual(lm.unboundLibraryItem(nfoPlot).overview, 'متن خودم', 'an unbound row keeps the NFO plot');
  assert.strictEqual(lm.unboundLibraryItem(nfoPlot).title, 'درباره کوچک', 'and its folder title');
});

test('episode numbers and season folders: Persian digits, فصل, E001, EP001, قسمت, bare numbers', () => {
  assert.strictEqual(lm.isLibrarySeasonDir('فصل ۱'), true);
  assert.strictEqual(lm.isLibrarySeasonDir('Season 02'), true);
  assert.strictEqual(lm.isLibrarySeasonDir('Movies'), false);
  assert.strictEqual(lm.librarySeasonFromDir('فصل ۲'), 2);
  const n = (f, o) => { const r = lm.libraryEpisodeNumber(f, o); return r && [r.s, r.e, r.strong]; };
  assert.deepStrictEqual(n('Show - S۰۱E۰۲.mkv'), [1, 2, true]);
  assert.deepStrictEqual(n('Show 2x05.mp4'), [2, 5, true]);
  assert.strictEqual(n('Movie.1920x1080.mkv'), null, 'a resolution is not 1920x1080 episodes');
  assert.deepStrictEqual(n('Kapitan.Toop.1983.E001.Farsi.mkv'), [1, 1, false]);
  assert.deepStrictEqual(n('Bolak - EP012.mp4'), [1, 12, false]);
  assert.deepStrictEqual(n('قسمت ۰۳.mkv', { season: 2 }), [2, 3, false]);
  assert.deepStrictEqual(n('10.mp4'), [1, 10, false]);
  assert.strictEqual(n('Shabe Roshan (2001) شب روشن.mp4'), null);
});

// ---------- end to end: scan, read, search (fixture + local TMDB mock) ----------

const SEARCH = [
  // [query must include, results]
  ['گلبرگ آبی', [
    { id: 701, title: 'Paper Moon', original_title: 'ماه کاغذی', release_date: '2025-02-01', poster_path: '/decoy.jpg', overview: 'Decoy plot.' },
    { id: 702, title: 'Blue Petal', original_title: 'گلبرگ آبی', release_date: '2025-03-01', poster_path: '/petal.jpg', overview: 'Petal plot.' },
  ]],
  ['Kaval', [{ id: 711, name: 'Kavalda', original_name: 'کولدا', first_air_date: '2019-12-20', poster_path: '/kavalda.jpg' }]],
  ['کول', [{ id: 711, name: 'Kavalda', original_name: 'کولدا', first_air_date: '2019-12-20', poster_path: '/kavalda.jpg' }]],
  ['بندر سفید', [{ id: 721, name: 'White Harbour', original_name: 'بندر سفید', first_air_date: '2011-03-21', poster_path: '/capital.jpg', overview: 'Capital plot.' }]],
  ['Bandar', [{ id: 721, name: 'White Harbour', original_name: 'بندر سفید', first_air_date: '2011-03-21', poster_path: '/capital.jpg', overview: 'Capital plot.' }]],
];
function startTmdbMock() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/3/movie/731') {
      return send(200, { id: 731, title: 'About Small', original_title: 'درباره کوچک', release_date: '2009-02-06', poster_path: '/small.jpg', overview: 'TMDB plot.', genres: [{ id: 18 }] });
    }
    const m = /^\/3\/search\/(movie|tv)$/.exec(u.pathname);
    if (m) {
      const q = String(u.searchParams.get('query') || '');
      const hit = SEARCH.find(([k]) => q.includes(k));
      return send(200, { page: 1, results: hit ? hit[1] : [], total_results: hit ? hit[1].length : 0 });
    }
    return send(404, { status_code: 34 });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
async function runScan(port, libId, token, mode) {
  const start = await httpJson(port, 'POST', `/api/libraries/${libId}/scan`, mode ? { mode } : {}, token);
  assert.strictEqual(start.status, 202);
  for (let i = 0; i < 400; i++) {
    const st = await httpJson(port, 'GET', `/api/libraries/${libId}/scanstatus`, null, token);
    if (!st.json.running) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan timeout');
}
const put = (root, rel, body = 'VIDEO') => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};
const itemsOf = async (port, libId, token, q = '') => (await httpJson(port, 'GET', `/api/libraries/${libId}/items${q}`, null, token)).json.items;

test('scan: folder names are shown, near and decoy titles stay unmatched, episodes keep the show match', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-fa-'));
  put(root, 'Golbarg Abi (2025) گلبرگ آبی/Golbarg Abi.mkv', 'PETAL');
  put(root, 'Kaval کول [1080p]/Season 01/Kavalda کولدا - S01E01.mp4', 'K1');
  put(root, 'Kaval کول [1080p]/Season 01/Kavalda کولدا - S01E02.mp4', 'K2');
  put(root, 'Bandar Sefid (2011) بندر سفید/Season 01/Bandar Sefid - S01E01.mp4', 'P1');
  put(root, 'Bandar Sefid (2011) بندر سفید/Season 01/Bandar Sefid - S01E02.mp4', 'P2');
  put(root, 'درباره كوچك/درباره كوچك.mkv', 'SMALL');
  put(root, 'درباره كوچك/movie.nfo', '<movie><title>About Small</title><plot>متن خودم.</plot><uniqueid type="tmdb">731</uniqueid></movie>');
  const mock = await startTmdbMock();
  const { port, shutdown } = await bootServer({ TMDB_BASE: `http://127.0.0.1:${mock.address().port}/3` });
  try {
    const admin = await setupAdmin(port);
    await httpJson(port, 'POST', '/api/settings', { tmdbKey: 'mock-key' }, admin);
    const lib = await httpJson(port, 'POST', '/api/libraries', { name: 'FA', kind: 'movie', path: root }, admin);
    await runScan(port, lib.json.id, admin);
    const items = await itemsOf(port, lib.json.id, admin);
    const petal = items.find((i) => i.kind === 'movie' && i.title.startsWith('Golbarg'));
    assert.ok(petal, JSON.stringify(items.map((i) => i.title)));
    assert.strictEqual(petal.title, 'Golbarg Abi گلبرگ آبی', 'the folder name is the shown title');
    assert.strictEqual(petal.tmdbId, 702, 'the decoy listed first is skipped');
    assert.strictEqual(petal.matchTitle, 'Blue Petal', 'the catalog title is kept beside the folder name');
    assert.strictEqual(petal.poster, '/petal.jpg');

    const kaval = items.find((i) => i.kind === 'show' && i.title.startsWith('Kaval'));
    assert.strictEqual(kaval.title, 'Kaval کول', 'the show is shown under its folder name');
    assert.strictEqual(kaval.tmdbId, null, 'Kaval is not bound to Kavalda');

    const capital = items.find((i) => i.kind === 'show' && i.title.startsWith('Bandar'));
    assert.strictEqual(capital.title, 'Bandar Sefid بندر سفید');
    assert.strictEqual(capital.tmdbId, 721);
    const eps = await itemsOf(port, lib.json.id, admin, `?showIdx=${capital.idx}&limit=50`);
    assert.strictEqual(eps.length, 2);
    for (const ep of eps) {
      assert.strictEqual(ep.tmdbId, 721, 'episodes keep the show TMDB id when served');
      assert.match(ep.title, /^Bandar Sefid بندر سفید · S01E0[12]$/);
    }

    const small = items.find((i) => i.kind === 'movie' && i.title.includes('درباره'));
    assert.strictEqual(small.title, 'درباره كوچك', 'a scraper NFO title does not replace the folder name');
    assert.strictEqual(small.tmdbId, 731, 'the NFO TMDB id survives the read-time check');
    assert.strictEqual(small.overview, 'متن خودم.', 'the NFO plot is kept');
    assert.strictEqual(small.poster, '/small.jpg');

    // Search: Persian Yeh/Kaf typed differently, a 2-letter word, and the matched English title.
    const search = async (q) => (await httpJson(port, 'GET', `/api/libraries/search?q=${encodeURIComponent(q)}`, null, admin)).json.items.map((i) => i.title);
    assert.deepStrictEqual(await search('درباره کوچک'), ['درباره كوچك']);
    assert.ok((await search('کول')).includes('Kaval کول'), '2-letter Persian word finds its show');
    assert.ok((await search('White Harbour')).includes('Bandar Sefid بندر سفید'), 'matched title still finds the folder-named show');

    // A plain rescan keeps all of it (reuse path).
    await runScan(port, lib.json.id, admin);
    const again = await itemsOf(port, lib.json.id, admin);
    assert.strictEqual(again.find((i) => i.idx === petal.idx).tmdbId, 702);
    assert.strictEqual(again.find((i) => i.idx === petal.idx).title, 'Golbarg Abi گلبرگ آبی');
    assert.strictEqual(again.find((i) => i.idx === small.idx).tmdbId, 731);
  } finally {
    await shutdown();
    mock.close();
  }
});

test('scan: Persian season folders and numbered episodes make one series, not one movie per folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-fa-eps-'));
  put(root, 'Shahr Sabz (2015)/فصل ۱/قسمت ۰۱.mkv', 'A1');
  put(root, 'Shahr Sabz (2015)/فصل ۱/قسمت ۰۲.mkv', 'A2');
  put(root, 'Shahr Sabz (2015)/فصل ۲/قسمت ۰۱.mkv', 'B1');
  put(root, 'Kapitan Toop/Kapitan.Toop.1983.E001.Farsi.mkv', 'T1');
  put(root, 'Kapitan Toop/Kapitan.Toop.1983.E002.Farsi.mkv', 'T2');
  put(root, 'Kapitan Toop/Kapitan.Toop.1983.E003.Farsi.mkv', 'T3');
  put(root, 'Nell Kuchak/1.mp4', 'N1');
  put(root, 'Nell Kuchak/2.mp4', 'N2');
  put(root, 'Film Tanha (2020)/Film Tanha.mkv', 'F');
  const { port, shutdown } = await bootServer({ TMDB_BASE: null });
  try {
    const admin = await setupAdmin(port);
    const lib = await httpJson(port, 'POST', '/api/libraries', { name: 'FA eps', kind: 'tv', path: root }, admin);
    const st = await runScan(port, lib.json.id, admin);
    const items = await itemsOf(port, lib.json.id, admin);
    const shows = items.filter((i) => i.kind === 'show').map((i) => i.title).sort();
    assert.deepStrictEqual(shows, ['Kapitan Toop', 'Nell Kuchak', 'Shahr Sabz']);
    assert.strictEqual(st.json.shows, 3);
    const movies = items.filter((i) => i.kind === 'movie').map((i) => i.title);
    assert.deepStrictEqual(movies, ['Film Tanha'], 'no season folder shows up as a movie');
    const sabz = items.find((i) => i.kind === 'show' && i.title === 'Shahr Sabz');
    const eps = await itemsOf(port, lib.json.id, admin, `?showIdx=${sabz.idx}&limit=50`);
    assert.deepStrictEqual(eps.map((e) => [e.s, e.e]), [[1, 1], [1, 2], [2, 1]]);
    const toop = items.find((i) => i.kind === 'show' && i.title === 'Kapitan Toop');
    const teps = await itemsOf(port, lib.json.id, admin, `?showIdx=${toop.idx}&limit=50`);
    assert.deepStrictEqual(teps.map((e) => [e.s, e.e]), [[1, 1], [1, 2], [1, 3]]);
  } finally {
    await shutdown();
  }
});

test('update path: a library scanned by the old code drops weak matches at once and gets folder titles on the next scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-fa-old-'));
  put(root, 'Golbarg Abi (2025) گلبرگ آبی/Golbarg Abi.mkv', 'PETAL');
  put(root, 'Bandar Sefid (2011) بندر سفید/Season 01/Bandar Sefid - S01E01.mp4', 'P1');
  put(root, 'Kaval کول [1080p]/Golbarg Kaval.mkv', 'KV');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-fa-data-'));
  const libId = 'oldlib0001';
  fs.writeFileSync(path.join(data, 'libraries.json'), JSON.stringify({ list: [{ id: libId, name: 'Old', kind: 'movie', mediaType: 'movie', path: root, users: [], tmdbMatch: 'auto' }] }));
  const petalFile = path.join(root, 'Golbarg Abi (2025) گلبرگ آبی', 'Golbarg Abi.mkv');
  const showDir = path.join(root, 'Bandar Sefid (2011) بندر سفید');
  const epFile = path.join(showDir, 'Season 01', 'Bandar Sefid - S01E01.mp4');
  const kavalFile = path.join(root, 'Kaval کول [1080p]', 'Golbarg Kaval.mkv');
  // Rows as the old code stored them: the TMDB title in `title`, no matchTitle/titleSource.
  fs.writeFileSync(path.join(data, 'libitems.json'), JSON.stringify({ [libId]: { scannedAt: 1, items: [
    { idx: 0, kind: 'movie', file: petalFile, title: 'Paper Moon', originalTitle: 'ماه کاغذی', year: '2025', tmdbId: 701, poster: '/decoy.jpg', genres: [], addedAt: 1 },
    { idx: 1, kind: 'show', dir: showDir, file: null, title: 'White Harbour', originalTitle: 'بندر سفید', year: '2011', tmdbId: 721, poster: '/capital.jpg', genres: [], addedAt: 1 },
    { idx: 2, kind: 'episode', file: epFile, showIdx: 1, s: 1, e: 1, title: 'White Harbour · S01E01', year: '2011', tmdbId: 721, poster: '/capital.jpg', genres: [], addedAt: 1 },
    { idx: 3, kind: 'movie', file: kavalFile, title: 'Fixed By Hand', year: null, tmdbId: 702, matchOverride: 702, poster: '/petal.jpg', genres: [], addedAt: 1 },
  ] } }));
  const mock = await startTmdbMock();
  const { port, shutdown } = await bootServer({ TRIBOON_DATA: data, TMDB_BASE: `http://127.0.0.1:${mock.address().port}/3` });
  try {
    const admin = await setupAdmin(port);
    await httpJson(port, 'POST', '/api/settings', { tmdbKey: 'mock-key' }, admin);
    const before = await itemsOf(port, libId, admin);
    assert.strictEqual(before.find((i) => i.idx === 0).tmdbId, null, 'the old wrong same-year match is dropped at once');
    assert.strictEqual(before.find((i) => i.idx === 1).tmdbId, 721, 'an old right match is kept');
    assert.strictEqual(before.find((i) => i.idx === 3).tmdbId, 702, 'an old manual fix is kept');
    await runScan(port, libId, admin);
    const after = await itemsOf(port, libId, admin);
    const byFile = (t) => after.find((i) => i.title.startsWith(t));
    assert.strictEqual(byFile('Golbarg Abi').tmdbId, 702, 'the next scan finds the right title');
    assert.strictEqual(byFile('Golbarg Abi').title, 'Golbarg Abi گلبرگ آبی');
    assert.strictEqual(byFile('Bandar').tmdbId, 721);
    assert.strictEqual(byFile('Bandar').title, 'Bandar Sefid بندر سفید', 'the old TMDB title gives way to the folder name');
    assert.strictEqual(byFile('Kaval').tmdbId, 702, 'the manual fix survives the scan');
    assert.strictEqual(byFile('Kaval').title, 'Kaval کول');
    const capital = byFile('Bandar');
    const eps = await itemsOf(port, libId, admin, `?showIdx=${capital.idx}&limit=50`);
    assert.strictEqual(eps[0].tmdbId, 721, 'episodes are bound again after the scan');
  } finally {
    await shutdown();
    mock.close();
  }
});

// ---------- rescan: only the files that exist now, pictures follow their file ----------

test('rescan: deleted, renamed, moved and replaced files leave no stale entries, pictures or lost manual picks', async () => {
  const { detectFfmpeg } = require('../server/transcode');
  const ff = detectFfmpeg();
  const { execFileSync } = require('child_process');
  const crypto = require('crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-fa-rescan-'));
  // Real tiny videos when ffmpeg exists (the picture checks need frames); bytes otherwise.
  const clip = (rel, color) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (ff) execFileSync(ff.path || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=160x120:d=7`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
    else fs.writeFileSync(f, `VIDEO-${color}`);
  };
  clip('Bravo Gol (2020) براوو گل/Bravo Gol.mp4', 'blue');
  clip('Charlie Gol (2021) چارلی گل/Charlie Gol.mp4', 'green');
  clip('Delta Gol (2019) دلتا گل/Delta Gol.mp4', 'yellow');
  clip('Echo Sar/Season 01/Echo Sar - S01E01.mp4', 'red');
  clip('Echo Sar/Season 01/Echo Sar - S01E02.mp4', 'purple');
  clip('Fox Sar [720p]/Season 01/Fox Sar - S01E01.mp4', 'white');
  clip('Golf Sar/Season 01/Golf Sar - S01E01.mp4', 'gray');
  const { port, shutdown } = await bootServer({ TMDB_BASE: null });
  try {
    const admin = await setupAdmin(port);
    const lib = await httpJson(port, 'POST', '/api/libraries', { name: 'Rescan', kind: 'movie', path: root }, admin);
    const id = lib.json.id;
    await runScan(port, id, admin);
    const first = await itemsOf(port, id, admin);
    const charlie = first.find((i) => i.title.startsWith('Charlie'));
    const delta = first.find((i) => i.title.startsWith('Delta'));
    const echo = first.find((i) => i.kind === 'show' && i.title === 'Echo Sar');
    // Manual picks: "use folder info" on Delta (a movie folder) and on the Echo show.
    for (const idx of [delta.idx, echo.idx]) {
      assert.strictEqual((await httpJson(port, 'POST', `/api/libraries/${id}/match`, { idx, tmdbId: null }, admin)).status, 202);
      for (let i = 0; i < 200; i++) {
        const st = await httpJson(port, 'GET', `/api/libraries/${id}/scanstatus`, null, admin);
        if (!st.json.running) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const pic = async (it) => {
      const r = await (require('./helpers').httpRaw)(port, it.thumbUrl);
      return r.status === 200 ? crypto.createHash('md5').update(r.body).digest('hex') : `status ${r.status}`;
    };
    const before = {};
    if (ff) for (const it of await itemsOf(port, id, admin)) if (it.kind !== 'show') before[it.title] = await pic(it);

    // Changes on disk.
    fs.rmSync(path.join(root, 'Bravo Gol (2020) براوو گل', 'Bravo Gol.mp4'));                    // file deleted
    fs.rmSync(path.join(root, 'Golf Sar'), { recursive: true });                                 // folder deleted
    fs.renameSync(path.join(root, 'Delta Gol (2019) دلتا گل'), path.join(root, 'Delta Gol Taze (2019) دلتا گل تازه')); // folder renamed
    fs.renameSync(path.join(root, 'Echo Sar'), path.join(root, 'Echo Sar Kamel'));               // show folder renamed
    clip('Alfa Gol (2018) آلفا گل/Alfa Gol.mp4', 'orange');                                     // new file, sorts first
    fs.rmSync(path.join(root, 'Fox Sar [720p]'), { recursive: true });                           // show replaced by a better copy
    clip('Fox Sar (2020)/Season 01/Fox Sar - S01E01 1080p.mp4', 'white');
    fs.renameSync(path.join(root, 'Echo Sar Kamel', 'Season 01', 'Echo Sar - S01E02.mp4'),
      path.join(root, 'Fox Sar (2020)', 'Season 01', 'Fox Sar - S01E02.mp4'));                  // episode moved to another show
    await runScan(port, id, admin);

    const after = await itemsOf(port, id, admin);
    const tops = after.filter((i) => i.kind !== 'episode').map((i) => i.title).sort();
    assert.deepStrictEqual(tops, ['Alfa Gol آلفا گل', 'Charlie Gol چارلی گل', 'Delta Gol Taze دلتا گل تازه', 'Echo Sar Kamel', 'Fox Sar'],
      'exactly the folders that exist now: no deleted, old-name or duplicate entries');
    const fox = after.find((i) => i.kind === 'show' && i.title === 'Fox Sar');
    const foxEps = await itemsOf(port, id, admin, `?showIdx=${fox.idx}&limit=50`);
    assert.deepStrictEqual(foxEps.map((e) => [e.s, e.e]), [[1, 1], [1, 2]], 'the replaced show has only its new copy plus the moved episode');
    const echoNow = after.find((i) => i.kind === 'show' && i.title === 'Echo Sar Kamel');
    const echoEps = await itemsOf(port, id, admin, `?showIdx=${echoNow.idx}&limit=50`);
    assert.deepStrictEqual(echoEps.map((e) => [e.s, e.e]), [[1, 1]], 'the moved episode left its old show');
    assert.strictEqual(after.find((i) => i.title.startsWith('Delta')).matchOverride, 'none', 'a manual pick follows its renamed movie folder');
    assert.strictEqual(echoNow.matchOverride, 'none', 'a manual pick follows its renamed show folder');
    assert.strictEqual(after.find((i) => i.title.startsWith('Charlie')).idx, charlie.idx, 'an unchanged file keeps its place here');

    // Pictures belong to the file, never to the position: the new film must not show the deleted
    // film's frame, and the moved episode keeps its own frame.
    const alfa = after.find((i) => i.title.startsWith('Alfa'));
    const foxE2 = foxEps.find((e) => e.e === 2);
    assert.notStrictEqual(alfa.thumbUrl, first.find((i) => i.title.startsWith('Bravo')).thumbUrl,
      'a new title at an old position gets a new picture URL, so a browser cache cannot show the old picture');
    if (ff) {
      assert.notStrictEqual(await pic(alfa), before['Bravo Gol براوو گل'], 'the new film does not show the deleted film\'s frame');
      assert.strictEqual(await pic(foxE2), before['Echo Sar · S01E02'], 'the moved episode keeps its own frame');
      assert.strictEqual(await pic(after.find((i) => i.title.startsWith('Charlie'))), before['Charlie Gol چارلی گل']);
    }
  } finally {
    await shutdown();
  }
});

// ---------- second check (3.4.14 gate): fixes found in review ----------

test('numeric titles with a year in brackets keep the match 3.4.13 gave them', () => {
  for (const [label, title, year] of [['1917 (2019)', '1917', '2019'], ['2012 (2009)', '2012', '2009'], ['1408 (2007)', '1408', '2007'], ['300 (2006)', '300', '2006']]) {
    const p = lm.libraryNameParts(label);
    assert.deepStrictEqual([p.display, p.year], [title, year], `${label}: the number is the title, the bracketed year is the year`);
    const hit = { id: 4, title, original_title: title, release_date: `${year}-07-01` };
    assert.strictEqual(lm.pickLibraryTmdbHit([hit], label, p.year, 'movie'), hit, `${label} binds its own title`);
    // A row stored by 3.4.13 (TMDB title in `title`) keeps its match at read time.
    const row = { kind: 'movie', file: path.join(os.tmpdir(), 'lib', label, `${title}.mkv`), title, year, tmdbId: 4 };
    assert.strictEqual(lm.libraryItemMatchesTmdb(row), true, `${label}: the stored match is kept`);
  }
  // A name that is only a number keeps the number as its title and has no year.
  assert.deepStrictEqual([lm.libraryNameParts('1917').display, lm.libraryNameParts('1917').year], ['1917', null]);
  assert.deepStrictEqual([lm.libraryNameParts('2012').display, lm.libraryNameParts('2012').year], ['2012', null]);
});

test('rescan: a manual pick follows its own renamed file, never a new file that only shares its name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-fa-pick-'));
  const old = new Date('2024-03-01T10:00:00Z');
  const fresh = new Date('2025-09-01T10:00:00Z');
  const make = (rel, when) => { put(root, rel, `V-${rel}`); fs.utimesSync(path.join(root, rel), when, when); };
  make('Old Gol (2020) اولد گل/video.mp4', old);              // generic file name, manual pick, deleted later
  make('Ren Gol (2019) رن گل/film.mp4', old);                 // manual pick, folder renamed later
  make('Old Sar/Season 01/S01E01.mp4', old);                  // show with generic episode names, manual pick, deleted later
  make('Old Sar/Season 01/S01E02.mp4', old);
  const { port, shutdown } = await bootServer({ TMDB_BASE: null });
  try {
    const admin = await setupAdmin(port);
    const lib = await httpJson(port, 'POST', '/api/libraries', { name: 'Picks', kind: 'movie', path: root }, admin);
    const id = lib.json.id;
    await runScan(port, id, admin);
    const first = await itemsOf(port, id, admin);
    for (const it of [first.find((i) => i.title.startsWith('Old Gol')), first.find((i) => i.title.startsWith('Ren Gol')), first.find((i) => i.kind === 'show')]) {
      assert.strictEqual((await httpJson(port, 'POST', `/api/libraries/${id}/match`, { idx: it.idx, tmdbId: null }, admin)).status, 202);
      for (let i = 0; i < 200; i++) {
        const st = await httpJson(port, 'GET', `/api/libraries/${id}/scanstatus`, null, admin);
        if (!st.json.running) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    // Delete the picked movie and show; add other titles whose files carry the same generic names.
    fs.rmSync(path.join(root, 'Old Gol (2020) اولد گل'), { recursive: true });
    fs.rmSync(path.join(root, 'Old Sar'), { recursive: true });
    make('New Gol (2022) نیو گل/video.mp4', fresh);
    make('New Sar/Season 01/S01E01.mp4', fresh);
    make('New Sar/Season 01/S01E02.mp4', fresh);
    fs.renameSync(path.join(root, 'Ren Gol (2019) رن گل'), path.join(root, 'Ren Gol Taze (2019) رن گل تازه'));
    await runScan(port, id, admin);
    const after = await itemsOf(port, id, admin);
    assert.strictEqual(after.find((i) => i.title.startsWith('New Gol')).matchOverride, undefined,
      'a new film does not take a deleted film\'s pick because both files are called video.mp4');
    assert.strictEqual(after.find((i) => i.kind === 'show' && i.title === 'New Sar').matchOverride, undefined,
      'a new show does not take a deleted show\'s pick because both name their files S01E01');
    assert.strictEqual(after.find((i) => i.title.startsWith('Ren Gol Taze')).matchOverride, 'none', 'a renamed folder keeps its own pick');
  } finally {
    await shutdown();
  }
});

test('scan walk: every season folder read still gives the event loop one turn', () => {
  // The walk is sync fs and slow on an Unraid user share; one turn per show/season folder keeps
  // playback and the API answering during a scan (the pinned scan-loop contract in phase4).
  const body = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(body, /const showEpisodesIn = async \(dir, entries\) => \{[\s\S]+?\} else if \(f\.isDirectory\(\) && isLibrarySeasonDir\(f\.name\)\) \{\s*await breathe\(\);/,
    'the season folders read by showEpisodesIn yield before each read');
  assert.match(body, /const epFiles = await showEpisodesIn\(full, sub\);/);
  assert.match(body, /const eps2 = await showEpisodesIn\(path\.join\(full, f\.name\), inner\);/);
});

test('a frame past the end of a short video counts as no picture, so the earlier-second retry runs', async (t) => {
  const tc = require('../server/transcode');
  const ff = tc.detectFfmpeg();
  if (!ff) return t.skip('ffmpeg not installed');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-thumb-'));
  const clip = path.join(dir, 'short.mp4');
  execFileSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
  const late = path.join(dir, 'late.jpg');
  // ffmpeg 5.x (Debian, the Linux CI) exits 0 here without writing anything.
  assert.strictEqual(await tc.makeThumb(clip, late, 120), false, 'no frame at 120 s of a 3 s video');
  const early = path.join(dir, 'early.jpg');
  assert.strictEqual(await tc.makeThumb(clip, early, 1), true);
  assert.ok(fs.statSync(early).size > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('web search: a Persian query keeps the library hits the server found', () => {
  // The page re-checks library hits with a Latin-only word splitter, so every Persian query lost its
  // Library row although /api/libraries/search had found the folder ("گل آبی" -> "Gol Abi گل آبی").
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const m = /function libraryHitShown\(q, it\) \{[\s\S]+?\n\}/.exec(ui);
  assert.ok(m, 'libraryHitShown exists');
  const calls = [];
  const shown = new Function('searchLibraryTitleMatch', `${m[0]}; return libraryHitShown;`)((q, t) => { calls.push([q, t]); return /gol/i.test(q) && /gol/i.test(t); });
  assert.strictEqual(shown('گل آبی', { title: 'Gol Abi گل آبی' }), true, 'Persian query: the server match is kept');
  assert.strictEqual(shown('کول', { title: 'Kaval کول' }), true);
  assert.strictEqual(shown('Gol', { title: 'Gol Abi گل آبی' }), true, 'Latin query: the page check still runs');
  assert.strictEqual(shown('Cobalt', { title: 'Gol Abi گل آبی' }), false);
  assert.strictEqual(calls.length, 2, 'only Latin queries go through the page check');
  assert.match(ui, /const libHits = lib\.filter\(\(it\) => libraryHitShown\(q, it\)\);/);
  assert.match(ui, /const lib = \(await libJob\.catch\(\(\) => \[\]\)\)\.filter\(\(it\) => libraryHitShown\(q, it\)\);/);
});

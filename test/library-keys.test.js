'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  relPath, hashOf, parseLocalKey, isLegacyPositionKey, isStableLocalKey, assignStableKeys, watchKeyFor,
} = require('../server/library-keys');

const ROOT = path.join(path.sep === '\\' ? 'C:\\' : '/', 'media', 'Movies');
const at = (...parts) => path.join(ROOT, ...parts);

function scan(items, root = ROOT) {
  items.forEach((it, i) => { it.idx = i; });
  return assignStableKeys('lib1', root, items);
}

test('library keys: a film folder, a loose file, a show and its episodes each get a 12-hex key', () => {
  const items = scan([
    { kind: 'movie', file: at('Copper Lantern (2010)', 'Copper.Lantern.2010.1080p.mkv') },
    { kind: 'movie', file: at('Loose Film 2001.mp4') },
    { kind: 'show', dir: at('Darya') },
    { kind: 'episode', file: at('Darya', 'Season 01', 'Darya.S01E02.mkv'), showIdx: 2, s: 1, e: 2 },
  ]);
  assert.match(items[0].key, /^local:lib1:[0-9a-f]{12}$/);
  assert.match(items[1].key, /^local:lib1:[0-9a-f]{12}$/);
  assert.match(items[2].key, /^local:lib1:[0-9a-f]{12}$/);
  assert.strictEqual(items[3].key, `${items[2].key}:s1e2`, 'an episode is its show key plus season and episode');
  assert.strictEqual(new Set(items.map((i) => i.key)).size, 4);
  assert.strictEqual(items[0].relPath, 'Copper Lantern (2010)/Copper.Lantern.2010.1080p.mkv');
});

test('library keys: a better copy or a renamed file inside the folder keeps the film key', () => {
  const a = scan([{ kind: 'movie', file: at('Gol Sorkh', 'gol.sorkh.720p.mkv') }])[0].key;
  const b = scan([{ kind: 'movie', file: at('Gol Sorkh', 'Gol.Sorkh.2160p.mp4') }])[0].key;
  assert.strictEqual(a, b);
  const loose1 = scan([{ kind: 'movie', file: at('Film.mkv') }])[0].key;
  const loose2 = scan([{ kind: 'movie', file: at('Film.mp4') }])[0].key;
  assert.strictEqual(loose1, loose2, 'a loose file keeps its key when only the extension changes');
});

test('library keys: adding or removing other folders never changes a key (the position bug)', () => {
  const before = scan([
    { kind: 'movie', file: at('Bravo', 'b.mkv') },
    { kind: 'movie', file: at('Delta', 'd.mkv') },
  ]);
  const after = scan([
    { kind: 'movie', file: at('Alpha', 'a.mkv') },
    { kind: 'movie', file: at('Bravo', 'b.mkv') },
    { kind: 'movie', file: at('Delta', 'd.mkv') },
  ]);
  assert.strictEqual(after[1].key, before[0].key);
  assert.strictEqual(after[2].key, before[1].key);
  // A new episode in an earlier show must not move the later show's episode keys (result 98 check c).
  const showsBefore = scan([
    { kind: 'show', dir: at('Darya') },
    { kind: 'episode', file: at('Darya', 'S01E01.mkv'), showIdx: 0, s: 1, e: 1 },
    { kind: 'show', dir: at('Kuh') },
    { kind: 'episode', file: at('Kuh', 'S01E02.mkv'), showIdx: 2, s: 1, e: 2 },
  ]);
  const showsAfter = scan([
    { kind: 'show', dir: at('Darya') },
    { kind: 'episode', file: at('Darya', 'S01E01.mkv'), showIdx: 0, s: 1, e: 1 },
    { kind: 'episode', file: at('Darya', 'S01E04.mkv'), showIdx: 0, s: 1, e: 4 },
    { kind: 'show', dir: at('Kuh') },
    { kind: 'episode', file: at('Kuh', 'S01E02.mkv'), showIdx: 3, s: 1, e: 2 },
  ]);
  assert.strictEqual(showsAfter[4].key, showsBefore[3].key);
});

test('library keys: Unicode NFC, ZWNJ and the path separator give one key; case is kept', () => {
  const nfc = 'Gol Sorkh گل‌سرخ Café'.normalize('NFC');
  const nfd = nfc.normalize('NFD');
  assert.notStrictEqual(nfc, nfd);
  const a = scan([{ kind: 'movie', file: at(nfc, 'f.mkv') }])[0].key;
  const b = scan([{ kind: 'movie', file: at(nfd, 'f.mkv') }])[0].key;
  assert.strictEqual(a, b, 'NFD and NFC folder names give the same key');
  assert.strictEqual(relPath('C:\\Media\\Movies', 'C:\\Media\\Movies\\A b\\f.mkv'), 'A b/f.mkv');
  assert.strictEqual(relPath('/data/movies', '/data/movies/A b/f.mkv'), 'A b/f.mkv');
  assert.notStrictEqual(hashOf('dir', 'Abc'), hashOf('dir', 'abc'), 'no case folding');
  assert.notStrictEqual(hashOf('dir', 'گل‌سرخ'), hashOf('dir', 'گلسرخ'), 'a ZWNJ is part of the name');
});

test('library keys: a library path change (or Windows vs Docker paths) keeps every key', () => {
  const win = assignStableKeys('lib1', 'M:\\Movies', [{ idx: 0, kind: 'movie', file: 'M:\\Movies\\Shab Abi (2019)\\shab.mkv' }])[0].key;
  const unc = assignStableKeys('lib1', '\\\\tower\\media\\Movies', [{ idx: 0, kind: 'movie', file: '\\\\tower\\media\\Movies\\Shab Abi (2019)\\shab.mkv' }])[0].key;
  const docker = assignStableKeys('lib1', '/media/Movies', [{ idx: 0, kind: 'movie', file: '/media/Movies/Shab Abi (2019)/shab.mkv' }])[0].key;
  assert.strictEqual(win, unc);
  assert.strictEqual(win, docker);
  const outside = assignStableKeys('lib1', '/media/Movies', [{ idx: 0, kind: 'movie', file: '/elsewhere/x.mkv' }])[0];
  assert.strictEqual(outside.key, undefined, 'a file outside the library folder gets no key');
});

test('library keys: doubled episode numbers keep one s/e key and give the others their file key', () => {
  const items = scan([
    { kind: 'show', dir: at('Show') },
    { kind: 'episode', file: at('Show', 'b', 'S01E03.mkv'), showIdx: 0, s: 1, e: 3 },
    { kind: 'episode', file: at('Show', 'a', 'S01E03.mkv'), showIdx: 0, s: 1, e: 3 },
  ]);
  assert.strictEqual(items[2].key, `${items[0].key}:s1e3`, 'the first by path keeps the s/e key');
  assert.match(items[1].key, /^local:lib1:[0-9a-f]{12}$/);
  assert.notStrictEqual(items[1].key, items[2].key);
});

test('library keys: legacy position keys and stable keys are told apart by length, also for an all-digit hash', () => {
  let digits = null;
  for (let i = 0; i < 20000 && !digits; i++) {
    const h = hashOf('dir', `folder ${i}`);
    if (/^\d{12}$/.test(h)) digits = h;
  }
  assert.ok(digits, 'found an all-digit stable id');
  assert.ok(isStableLocalKey(`local:lib1:${digits}`));
  assert.ok(!isLegacyPositionKey(`local:lib1:${digits}`), 'an all-digit stable id is never a position');
  assert.deepStrictEqual(parseLocalKey(`local:lib1:${digits}`), { libId: 'lib1', legacy: false, id: digits });
  assert.ok(isLegacyPositionKey('local:lib1:0'));
  assert.ok(isLegacyPositionKey('local:lib1:24999'));
  assert.deepStrictEqual(parseLocalKey('local:lib1:15115'), { libId: 'lib1', legacy: true, pos: 15115 });
  assert.deepStrictEqual(parseLocalKey('local:lib1:0123456789ab:s2e10'), { libId: 'lib1', legacy: false, id: '0123456789ab', season: 2, episode: 10 });
  assert.strictEqual(parseLocalKey('tmdb:movie:5'), null);
  assert.strictEqual(parseLocalKey('local:lib1:123456'), null, 'six digits is neither');
});

test('library keys: the watch key is the catalog key for a match, also for episodes (F-1), else the stable key', () => {
  const items = scan([
    { kind: 'movie', file: at('Copper Lantern (2010)', 'c.mkv'), tmdbId: 9001 },
    { kind: 'movie', file: at('Gol Sorkh', 'g.mkv'), tmdbId: null },
    { kind: 'show', dir: at('Iron Harbor (2015)'), tmdbId: 9101 },
    { kind: 'episode', file: at('Iron Harbor (2015)', 'S01E02.mkv'), showIdx: 2, s: 1, e: 2, tmdbId: 9101 },
    { kind: 'show', dir: at('Darya') },
    { kind: 'episode', file: at('Darya', 'S01E02.mkv'), showIdx: 4, s: 1, e: 2 },
  ]);
  assert.strictEqual(watchKeyFor(items[0]), 'tmdb:movie:9001');
  assert.strictEqual(watchKeyFor(items[1]), items[1].key);
  assert.strictEqual(watchKeyFor(items[2]), 'tmdb:tv:9101');
  assert.strictEqual(watchKeyFor(items[3]), 'tmdb:tv:9101:s1e2', 'a matched show\'s episode shares the catalog key');
  assert.strictEqual(watchKeyFor(items[5]), items[5].key);
  assert.strictEqual(watchKeyFor({ ...items[0], tmdbId: null }), items[0].key, 'a dropped match falls back to the stable key');
});

test('library keys: two show folders of one library on one TMDB id keep local episode keys', () => {
  const items = scan([
    { kind: 'show', dir: at('Show A'), tmdbId: 77 },
    { kind: 'episode', file: at('Show A', 'S01E01.mkv'), showIdx: 0, s: 1, e: 1, tmdbId: 77 },
    { kind: 'show', dir: at('Show B'), tmdbId: 77 },
    { kind: 'episode', file: at('Show B', 'S01E01.mkv'), showIdx: 2, s: 1, e: 1, tmdbId: 77 },
  ]);
  assert.strictEqual(watchKeyFor(items[1]), items[1].key);
  assert.strictEqual(watchKeyFor(items[3]), items[3].key);
  assert.notStrictEqual(items[1].key, items[3].key);
  assert.strictEqual(watchKeyFor(items[0]), items[0].key);
});

test('library keys: two loose files with one name and other extensions get two keys', () => {
  const items = scan([
    { kind: 'movie', file: at('Film.mp4') },
    { kind: 'movie', file: at('Film.mkv') },
  ]);
  assert.notStrictEqual(items[0].key, items[1].key);
  const again = scan([
    { kind: 'movie', file: at('Film.mkv') },
    { kind: 'movie', file: at('Film.mp4') },
  ]);
  assert.deepStrictEqual(new Set(again.map((i) => i.key)), new Set(items.map((i) => i.key)), 'the same two keys whatever the walk order');
});

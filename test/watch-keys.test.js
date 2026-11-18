'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { assignStableKeys, watchKeyFor } = require('../server/library-keys');
const {
  planMoves, applyLibraryMoves, parkVanished, restoreReturned, parkLibraryRows, normTitle, savedTitleParts, ORPHAN_KEEP_MS,
} = require('../server/watch-keys');

const ROOT = path.join(path.sep === '\\' ? 'C:\\' : '/', 'lib');
const at = (...p) => path.join(ROOT, ...p);
const LIB = 'abc123def0';

// A pass: items get idx in order and their stable keys.
function pass(items) {
  items.forEach((it, i) => { it.idx = i; });
  return assignStableKeys(LIB, ROOT, items.map((it) => ({ ...it })));
}
const film = (folder, file, extra = {}) => ({ kind: 'movie', file: at(folder, file), title: extra.title || folder, titleSource: 'folder', ...extra });
const wk = (it) => watchKeyFor(it);
const row = (title, extra = {}) => ({ position: 600, duration: 1800, watched: false, meta: { title, type: 'movie' }, updatedAt: 100, ...extra });

function run(prevItems, items, watch, { watchlist = {}, orphans = {}, claimed = () => false, now = 1000 } = {}) {
  const moves = planMoves({ prevItems, items, watchKeyOf: wk, claimedElsewhere: claimed });
  const stats = applyLibraryMoves({ libId: LIB, watch, watchlist, orphans, prevItems, items, moves, watchKeyOf: wk, now });
  return { moves, stats, watch, watchlist, orphans };
}

test('watch keys: a legacy row confirmed by its title moves to the stable key, for every profile', () => {
  const items = pass([film('Bravo', 'b.mkv'), film('Delta', 'd.mkv')]);
  const watch = {
    [`u1:default:local:${LIB}:1`]: row('Delta'),
    [`u1:p2:local:${LIB}:0`]: row('Bravo', { watched: true }),
  };
  const { stats } = run(items, items, watch);
  assert.strictEqual(stats.moved, 2);
  assert.deepStrictEqual(Object.keys(watch).sort(), [`u1:default:${items[1].key}`, `u1:p2:${items[0].key}`].sort());
  assert.strictEqual(watch[`u1:default:${items[1].key}`].position, 600);
  assert.strictEqual(watch[`u1:default:${items[1].key}`].meta.localKey, items[1].key, 'the server notes the item');
  assert.strictEqual(watch[`u1:p2:${items[0].key}`].watched, true);
});

test('watch keys: a row whose position now holds another title goes to the one item with its title', () => {
  // Written when Delta was at position 0; the pass it was written against still says so.
  const prev = pass([film('Delta', 'd.mkv'), film('Echo', 'e.mkv')]);
  const watch = { [`u1:default:local:${LIB}:0`]: row('Echo') }; // saved title Echo at position 0: shifted
  const { stats } = run(prev, prev, watch);
  assert.strictEqual(stats.moved, 1);
  assert.ok(watch[`u1:default:${prev[1].key}`], 'Echo keeps its own progress');
});

test('watch keys: a title that appears twice is never guessed: the row is kept aside with its key and date', () => {
  const prev = pass([film('Same Name (2020)', 'a.mkv', { title: 'Same Name' }), film('Same Name (2024)', 'b.mkv', { title: 'Same Name' }), film('Other', 'o.mkv')]);
  const watch = { [`u1:default:local:${LIB}:2`]: row('Same Name') };
  const { stats, orphans } = run(prev, prev, watch, { now: 5000 });
  assert.strictEqual(stats.parked, 1);
  assert.deepStrictEqual(Object.keys(watch), []);
  const kept = orphans[`u1:default:local:${LIB}:2`];
  assert.ok(kept && kept.at === 5000 && kept.reason === 'unconfirmed' && kept.row.position === 600);
});

test('watch keys: a 3.4.15 row is matched by its file name, even between two films with one title', () => {
  const prev = pass([film('Same Name (2020)', 'same.2020.mkv', { title: 'Same Name' }), film('Same Name (2024)', 'same.2024.mkv', { title: 'Same Name' })]);
  const watch = { [`u1:default:local:${LIB}:0`]: row('Same Name', { meta: { title: 'Same Name', source: { name: 'same.2024.mkv' } } }) };
  run(prev, prev, watch);
  assert.ok(watch[`u1:default:${prev[1].key}`], 'the file name names the 2024 film');
});

test('watch keys: a 3.4.14 episode row with the raw NFO title is confirmed (IR - Show [1080p] · S01E02)', () => {
  const prev = pass([
    { kind: 'show', dir: at('Kuh کوه [1080p]'), title: 'Kuh کوه', titleSource: 'nfo' },
    { kind: 'episode', file: at('Kuh کوه [1080p]', 'Season 01', 'Kuh.S01E01.mkv'), showIdx: 0, s: 1, e: 1, title: 'Kuh کوه · S01E01' },
    { kind: 'episode', file: at('Kuh کوه [1080p]', 'Season 01', 'Kuh.S01E02.mkv'), showIdx: 0, s: 1, e: 2, title: 'Kuh کوه · S01E02' },
  ]);
  const watch = { [`u1:default:local:${LIB}:2`]: row('IR - Kuh کوه [1080p] — S01E02', { meta: { title: 'IR - Kuh کوه [1080p] — S01E02', type: 'episode' } }) };
  run(prev, prev, watch);
  assert.ok(watch[`u1:default:${prev[0].key}:s1e2`], 'moved to the show key plus s1e2');
  assert.strictEqual(normTitle('IR - Kuh کوه [1080p]'), normTitle('Kuh کوه'));
  assert.deepStrictEqual(savedTitleParts({ title: 'Kuh کوه — S01E02 · Name' }), { title: normTitle('Kuh کوه'), s: 1, e: 2 });
});

test('watch keys: a matched show\'s episode saved under a position moves to the catalog key (F-1)', () => {
  const prev = pass([
    { kind: 'show', dir: at('Iron Harbor (2015)'), title: 'Iron Harbor', tmdbId: 9101, matchTitle: 'Iron Harbor', matchSource: 'nfo' },
    { kind: 'episode', file: at('Iron Harbor (2015)', 'S01E02.mkv'), showIdx: 0, s: 1, e: 2, title: 'Iron Harbor · S01E02', tmdbId: 9101, matchTitle: 'Iron Harbor', matchSource: 'nfo' },
  ]);
  const watch = {
    [`u1:default:local:${LIB}:1`]: row('Iron Harbor — S01E02', { position: 61, updatedAt: 200, meta: { title: 'Iron Harbor — S01E02', tmdbId: 9101 } }),
    // The catalog page's own "Play S01E01" wrote a second, older row for the same episode.
    'u1:default:tmdb:tv:9101:s1e2': row('Iron Harbor', { position: 1, updatedAt: 150 }),
  };
  const { stats } = run(prev, prev, watch);
  assert.deepStrictEqual(Object.keys(watch), ['u1:default:tmdb:tv:9101:s1e2']);
  assert.strictEqual(watch['u1:default:tmdb:tv:9101:s1e2'].position, 61, 'the newer row wins');
  assert.strictEqual(watch['u1:default:tmdb:tv:9101:s1e2'].meta.tmdbId, 9101, 'a row on a catalog key names its catalog id');
  assert.strictEqual(stats.merged, 0);
  // The other way round: an existing newer catalog row is kept.
  const watch2 = {
    [`u1:default:local:${LIB}:1`]: row('Iron Harbor — S01E02', { position: 61, updatedAt: 100, meta: { title: 'Iron Harbor — S01E02', tmdbId: 9101 } }),
    'u1:default:tmdb:tv:9101:s1e2': row('Iron Harbor', { position: 900, updatedAt: 300 }),
  };
  const r2 = run(prev, prev, watch2);
  assert.strictEqual(watch2['u1:default:tmdb:tv:9101:s1e2'].position, 900);
  assert.strictEqual(r2.stats.merged, 1);
});

test('watch keys: a gained, lost or changed match moves the rows; a still-claimed or Trakt row stays', () => {
  const before = pass([film('Romeo', 'r.mkv')]);
  const after = pass([film('Romeo', 'r.mkv', { tmdbId: 680, matchOverride: 680, matchTitle: 'Pulp Fiction' })]);
  const watch = { [`u1:default:${before[0].key}`]: row('Romeo') };
  const r = run(before, after, watch);
  assert.deepStrictEqual(r.moves.map((m) => [m.from, m.to]), [[before[0].key, 'tmdb:movie:680']]);
  assert.ok(watch['u1:default:tmdb:movie:680'], 'Fix match: the saved minute follows to the catalog key');
  assert.strictEqual(watch['u1:default:tmdb:movie:680'].meta.tmdbId, 680,
    'real setup (brief 101): a row moved by Fix match names its catalog id, so "Details" opens the catalog page instead of playing');
  // Match lost (a switch to Folder & NFO only): a row played from this library copy (the server's
  // stamp) goes back to the stable key; another user's Usenet row of that film stays a catalog row.
  const mine = { title: 'Romeo', type: 'movie', localKey: after[0].key };
  const lost = {
    'u1:default:tmdb:movie:680': row('Romeo', { meta: mine }),
    'u2:default:tmdb:movie:680': row('Pulp Fiction', { meta: { title: 'Pulp Fiction', source: { name: 'Pulp.Fiction.1994.1080p.BluRay' } } }),
  };
  run(after, before, lost);
  assert.ok(lost[`u1:default:${before[0].key}`], 'the library copy\'s row follows it');
  assert.ok(lost['u2:default:tmdb:movie:680'], 'a Usenet row of the catalog title is not taken');
  // A 3.4.15 row played from the library carries the file name instead of a stamp.
  const byName = { 'u1:default:tmdb:movie:680': row('Romeo', { meta: { title: 'Romeo', source: { name: 'r.mkv' } } }) };
  run(after, before, byName);
  assert.ok(byName[`u1:default:${before[0].key}`]);
  // Another library item still owns the id: nothing moves.
  const shared = { 'u1:default:tmdb:movie:680': row('Romeo', { meta: mine }) };
  run(after, before, shared, { claimed: (k) => k === 'tmdb:movie:680' });
  assert.ok(shared['u1:default:tmdb:movie:680']);
  // A row imported from Trakt never leaves its catalog key.
  const trakt = { 'u1:default:tmdb:movie:680': row('Romeo', { fromTrakt: true, meta: mine }) };
  run(after, before, trakt);
  assert.ok(trakt['u1:default:tmdb:movie:680']);
  // Fix match from one id to another: only this copy's rows go to the new id.
  const other = pass([film('Romeo', 'r.mkv', { tmdbId: 681, matchOverride: 681, matchTitle: 'Other' })]);
  const fix = {
    'u1:default:tmdb:movie:680': row('Romeo', { meta: mine }),
    'u2:default:tmdb:movie:680': row('Pulp Fiction', { meta: { title: 'Pulp Fiction', source: { name: 'Pulp.Fiction.1994.WEB' } } }),
  };
  run(after, other, fix);
  assert.ok(fix['u1:default:tmdb:movie:681'] && fix['u2:default:tmdb:movie:680']);
});

test('watch keys: a mode switch carries rows saved before 3.4.16 (no stamp, no file name), unless they are shown to be another copy', () => {
  // Owner answer 4: progress carries over when a library switches to "Folder & NFO only". Rows saved
  // before 3.4.16 rarely name their file (a card resume drops it), so the rule is "carry unless shown
  // otherwise".
  const before = pass([film('Romeo', 'r.mkv', { tmdbId: 680, matchOverride: 680, matchTitle: 'Pulp Fiction' })]);
  const after = pass([film('Romeo', 'r.mkv')]);
  const watch = {
    'u1:default:tmdb:movie:680': row('Romeo', { meta: { title: 'Romeo', type: 'movie' } }), // plain old row: carried
    'u1:p2:tmdb:movie:680': row('Pulp Fiction', { meta: { title: 'Pulp Fiction', source: { name: 'Pulp.Fiction.1994.WEB' } } }), // a Usenet release
    'u1:p3:tmdb:movie:680': row('Romeo', { meta: { title: 'Romeo', localKey: 'local:other:aaaaaaaaaaaa' } }), // another library copy
    'u1:p4:tmdb:movie:680': row('Romeo', { fromTrakt: true }),
    'u9:default:tmdb:movie:680': row('Romeo'), // a user who cannot see this library
  };
  const moves = planMoves({ prevItems: before, items: after, watchKeyOf: wk });
  applyLibraryMoves({ libId: LIB, watch, watchlist: {}, orphans: {}, prevItems: before, items: after, moves, watchKeyOf: wk, userSees: (uid) => uid !== 'u9' });
  assert.ok(watch[`u1:default:${after[0].key}`], 'the plain row followed the folder');
  for (const k of ['u1:p2:tmdb:movie:680', 'u1:p3:tmdb:movie:680', 'u1:p4:tmdb:movie:680', 'u9:default:tmdb:movie:680']) assert.ok(watch[k], `${k} stays`);
});

test('watch keys: a merge keeps a watched tick over a newer row that only started the episode again', () => {
  const prev = pass([
    { kind: 'show', dir: at('Iron Harbor (2015)'), title: 'Iron Harbor', tmdbId: 9101, matchTitle: 'Iron Harbor', matchSource: 'nfo' },
    { kind: 'episode', file: at('Iron Harbor (2015)', 'S01E01.mkv'), showIdx: 0, s: 1, e: 1, title: 'Iron Harbor · S01E01', tmdbId: 9101, matchTitle: 'Iron Harbor', matchSource: 'nfo' },
  ]);
  const watch = {
    [`u1:default:local:${LIB}:1`]: row('Iron Harbor — S01E01', { watched: true, position: 121, updatedAt: 100, meta: { title: 'Iron Harbor — S01E01', type: 'episode' } }),
    'u1:default:tmdb:tv:9101:s1e1': row('Iron Harbor', { watched: false, position: 2, updatedAt: 200, meta: { title: 'Iron Harbor', type: 'episode' } }),
  };
  run(prev, prev, watch);
  assert.strictEqual(watch['u1:default:tmdb:tv:9101:s1e1'].watched, true, 'the 2 s replay from "Play S01E01" does not undo the finished episode');
  // A newer row with real progress still wins.
  const w2 = {
    [`u1:default:local:${LIB}:1`]: row('Iron Harbor — S01E01', { watched: true, position: 121, updatedAt: 100, meta: { title: 'Iron Harbor — S01E01', type: 'episode' } }),
    'u1:default:tmdb:tv:9101:s1e1': row('Iron Harbor', { watched: false, position: 90, updatedAt: 200, meta: { title: 'Iron Harbor', type: 'episode' } }),
  };
  run(prev, prev, w2);
  assert.strictEqual(w2['u1:default:tmdb:tv:9101:s1e1'].position, 90);
});

test('watch keys: a generic file name names the file only together with the saved title and kind', () => {
  const show = (dir, at0) => [
    { kind: 'show', dir: at(dir), title: dir },
    { kind: 'episode', file: at(dir, 'Season 1', '01.mp4'), showIdx: at0, s: 1, e: 1, title: `${dir} · S01E01` },
  ];
  // Written when Beta's 01.mp4 was at position 1; "Alpha" now sorts in front, and the stored pass
  // (the previous one) already shows Alpha's 01.mp4 there.
  const prev = pass([...show('Alpha', 0), ...show('Beta', 2)]);
  const w = { [`u1:default:local:${LIB}:1`]: row('Beta — S01E01', { meta: { title: 'Beta — S01E01', type: 'episode', source: { name: '01.mp4' } } }) };
  run(prev, prev, w);
  assert.ok(!w[`u1:default:${prev[0].key}:s1e1`], 'never Alpha\'s episode');
  assert.ok(w[`u1:default:${prev[2].key}:s1e1`], 'Beta\'s, found by title and file name');
});

test('watch keys: a film row whose old position now holds an episode is still looked up as a film', () => {
  const prev = pass([
    { kind: 'show', dir: at('Show'), title: 'Show' },
    { kind: 'episode', file: at('Show', 'S01E01.mkv'), showIdx: 0, s: 1, e: 1, title: 'Show · S01E01' },
    film('Romeo', 'r.mkv'),
  ]);
  const w = { [`u1:default:local:${LIB}:1`]: row('Romeo', { meta: { title: 'Romeo', type: 'movie' } }) };
  run(prev, prev, w);
  assert.ok(w[`u1:default:${prev[2].key}`], 'Romeo is unique: found');
  // An episode row never lands on a show item.
  const w2 = { [`u1:default:local:${LIB}:0`]: row('Show — S01E01', { meta: { title: 'Show — S01E01', type: 'episode' } }) };
  run(prev, prev, w2);
  assert.ok(!w2[`u1:default:${prev[0].key}`]);
  assert.ok(w2[`u1:default:${prev[0].key}:s1e1`]);
});

test('watch keys: a renamed or moved folder is paired by file name and size, never by guess', () => {
  const before = pass([film('Foxtrot', 'fox.mkv', { fileSize: 111 }), film('Hotel', 'hotel.mkv', { fileSize: 222 })]);
  const after = pass([film('Golf (renamed)', 'fox.mkv', { fileSize: 111 }), film('Hotel', 'hotel.mkv', { fileSize: 222 })]);
  const watch = { [`u1:default:${before[0].key}`]: row('Foxtrot') };
  run(before, after, watch);
  assert.ok(watch[`u1:default:${after[0].key}`], 'the rename keeps its progress');
  // Two candidates with the same name and size: nothing moves.
  const b2 = pass([film('A', 'video.mp4', { fileSize: 5 }), film('B', 'video.mp4', { fileSize: 5 })]);
  const a2 = pass([film('C', 'video.mp4', { fileSize: 5 }), film('D', 'video.mp4', { fileSize: 5 })]);
  const w2 = { [`u1:default:${b2[0].key}`]: row('A') };
  const r2 = run(b2, a2, w2);
  assert.strictEqual(r2.moves.length, 0);
  // A different size is another file.
  const a3 = pass([film('Golf', 'fox.mkv', { fileSize: 999 }), film('Hotel', 'hotel.mkv', { fileSize: 222 })]);
  assert.strictEqual(run(before, a3, {}).moves.length, 0);
});

test('watch keys: a renamed show folder carries the show and its episodes', () => {
  const show = (dir) => [
    { kind: 'show', dir: at(dir), title: dir },
    { kind: 'episode', file: at(dir, 'S01E01.mkv'), showIdx: 0, s: 1, e: 1, fileSize: 10, title: `${dir} · S01E01` },
    { kind: 'episode', file: at(dir, 'S01E02.mkv'), showIdx: 0, s: 1, e: 2, fileSize: 20, title: `${dir} · S01E02` },
  ];
  const before = pass(show('Kilo'));
  const after = pass(show('Kilo Show'));
  const watch = {
    [`u1:default:${before[2].key}`]: row('Kilo · S01E02'),
    [`u1:default:${before[0].key}`]: row('Kilo', { watched: true }),
  };
  run(before, after, watch);
  assert.ok(watch[`u1:default:${after[2].key}`], 'episode progress follows');
  assert.ok(watch[`u1:default:${after[0].key}`], 'the show row follows');
});

test('watch keys: rows of a removed file are kept aside, come back with the file, and go after 30 days', () => {
  const before = pass([film('Golf', 'g.mkv'), film('Hotel', 'h.mkv')]);
  const after = pass([film('Hotel', 'h.mkv')]);
  const watch = { [`u1:default:${before[0].key}`]: row('Golf') };
  const watchlist = { [`u1:${before[0].key}`]: { meta: { title: 'Golf' }, addedAt: 1 } };
  const orphans = {};
  const n = parkVanished({ libId: LIB, watch, watchlist, orphans, prevItems: before, items: after, moves: [], watchKeyOf: wk, now: 10 });
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(Object.keys(watch), []);
  assert.deepStrictEqual(Object.keys(watchlist), []);
  // The share comes back: the rows return.
  const back = restoreReturned({ libId: LIB, watch, watchlist, orphans, items: before, watchKeyOf: wk });
  assert.strictEqual(back, 2);
  assert.ok(watch[`u1:default:${before[0].key}`] && watchlist[`u1:${before[0].key}`]);
  // Parked again, then 30 days pass: a later pass deletes them.
  parkVanished({ libId: LIB, watch, watchlist, orphans, prevItems: before, items: after, moves: [], watchKeyOf: wk, now: 10 });
  const r = run(after, after, {}, { orphans, now: 10 + ORPHAN_KEEP_MS + 1 });
  assert.strictEqual(r.stats.purged, 2);
  assert.deepStrictEqual(Object.keys(orphans), []);
});

test('watch keys: deleting a library keeps its local rows aside and leaves catalog rows', () => {
  const watch = {
    [`u1:default:local:${LIB}:0123456789ab`]: row('A'),
    [`u1:default:local:${LIB}:3`]: row('B'),
    'u1:default:tmdb:movie:5': row('C'),
    'u1:default:local:otherlib00:0123456789ab': row('D'),
  };
  const orphans = {};
  const n = parkLibraryRows({ libId: LIB, watch, watchlist: {}, orphans, now: 1 });
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(Object.keys(watch).sort(), ['u1:default:local:otherlib00:0123456789ab', 'u1:default:tmdb:movie:5']);
});

test('watch keys: a title at its own position is not trusted when the library has a twin of it', () => {
  const prev = pass([film('Twin (2020)', 'a.mkv', { title: 'Twin' }), film('Twin (2024)', 'b.mkv', { title: 'Twin' })]);
  const watch = { [`u1:default:local:${LIB}:0`]: row('Twin') };
  const { stats } = run(prev, prev, watch);
  assert.strictEqual(stats.parked, 1, 'an earlier scan could have swapped the twins');
  // The file name proves it.
  const w2 = { [`u1:default:local:${LIB}:0`]: row('Twin', { meta: { title: 'Twin', source: { name: 'a.mkv' } } }) };
  run(prev, prev, w2);
  assert.ok(w2[`u1:default:${prev[0].key}`]);
});

test('watch keys: an episode tick saved with only the show title moves by position, never onto the show', () => {
  const show = [
    { kind: 'show', dir: at('Darya'), title: 'Darya' },
    { kind: 'episode', file: at('Darya', 'S01E01.mkv'), showIdx: 0, s: 1, e: 1, title: 'Darya · S01E01' },
    { kind: 'episode', file: at('Darya', 'S01E02.mkv'), showIdx: 0, s: 1, e: 2, title: 'Darya · S01E02' },
    film('Other', 'o.mkv'),
  ];
  const prev = pass(show);
  const tick = (pos) => ({ [`u1:default:local:${LIB}:${pos}`]: row('Darya', { watched: true, meta: { title: 'Darya', type: 'episode' } }) });
  const w1 = tick(2);
  run(prev, prev, w1);
  assert.ok(w1[`u1:default:${prev[0].key}:s1e2`], 'the episode at that position (episode grid tick)');
  const w2 = tick(3); // the position holds a film now: the row cannot say which episode
  const r2 = run(prev, prev, w2);
  assert.strictEqual(r2.stats.parked, 1);
  assert.ok(!w2[`u1:default:${prev[0].key}`], 'never moved onto the show itself');
});

test('watch keys: legacy watchlist rows move too', () => {
  const items = pass([film('Bravo', 'b.mkv'), film('Delta', 'd.mkv')]);
  const watchlist = { [`u1:local:${LIB}:1`]: { meta: { title: 'Delta', type: 'movie' }, addedAt: 3 } };
  run(items, items, {}, { watchlist });
  assert.deepStrictEqual(Object.keys(watchlist), [`u1:${items[1].key}`]);
});

test('watch keys: thousands of old rows on a large library move in well under seconds (the pass runs beside the video)', () => {
  const big = [];
  for (let s = 0; s < 300; s++) {
    const showIdx = big.length;
    big.push({ kind: 'show', dir: at(`Show ${s}`), title: `Show ${s}` });
    for (let e = 1; e <= 20; e++) big.push({ kind: 'episode', file: at(`Show ${s}`, `S01E${e}.mkv`), showIdx, s: 1, e, title: `Show ${s} · S01E${e}` });
  }
  for (let m = 0; m < 2000; m++) big.push(film(`Film ${m}`, 'f.mkv'));
  const items = pass(big);
  const watch = {};
  for (let i = 0; i < 3000; i++) {
    const it = items[(i * 7) % items.length];
    const title = it.kind === 'episode' ? `${it.title.split(' · ')[0]} — S01E${it.e}` : it.title;
    watch[`u1:p${i % 3}:local:${LIB}:${it.idx}`] = row(title, { meta: { title, _kind: it.kind } });
  }
  const t0 = Date.now();
  const { stats } = run(items, items, watch);
  const ms = Date.now() - t0;
  assert.strictEqual(stats.parked, 0);
  assert.ok(ms < 3000, `took ${ms} ms`);
});

// ---- Second check (brief 100) ----

test('watch keys: an episode row resumed from a Continue Watching card (show title only) is placed by its saved S/E, not by its position', () => {
  // 3.4.13 to 3.4.15 cards drop "— S01E02" from the title, and a save in the first 30 s has no file
  // name; the row still carries the episode in q and genre. An S01E00 file added later moved E01
  // onto the position E02 was saved at.
  const show = { kind: 'show', dir: at('Iron Harbor'), title: 'Iron Harbor' };
  const ep = (e) => ({ kind: 'episode', file: at('Iron Harbor', `Iron Harbor S01E0${e}.mkv`), showIdx: 0, s: 1, e, title: `Iron Harbor · S01E0${e}` });
  const prev = pass([show, ep(0), ep(1), ep(2)]);
  const meta = { title: 'Iron Harbor', type: 'episode', _kind: 'episode', q: 'Iron Harbor S01E02', genre: 'S01E02' };
  const watch = { [`u1:default:local:${LIB}:2`]: row('Iron Harbor', { meta }) };
  run(prev, prev, watch);
  assert.deepStrictEqual(Object.keys(watch), [`u1:default:${prev[0].key}:s1e2`], 'E02, never the E01 now at its position');
  // A film's genre ("Drama") or a film title that is its q never reads as an episode.
  assert.strictEqual(savedTitleParts({ title: 'Baran', genre: 'Drama', q: 'Baran' }).s, null);
});

test('watch keys: twins with one title and one file name are not told apart by a position that may have shifted', () => {
  // Baran (2001) was at position 1 when the row was saved; a folder ahead of it was then removed,
  // so position 1 holds Baran (2015), which has the same title and the same file name.
  const prev = pass([film('Baran (2001)', 'Baran.mkv', { title: 'Baran' }), film('Baran (2015)', 'Baran.mkv', { title: 'Baran' })]);
  const watch = { [`u1:default:local:${LIB}:1`]: row('Baran', { meta: { title: 'Baran', _kind: 'movie', source: { name: 'Baran.mkv' } } }) };
  const { stats } = run(prev, prev, watch);
  assert.strictEqual(stats.parked, 1, 'kept aside, never put on the 2015 film');
  assert.deepStrictEqual(Object.keys(watch), []);
});

test('watch keys: two copies of one matched film lose the match: each stamped row follows its own copy', () => {
  const before = pass([film('Film (2010) 1080p', 'a.mkv', { tmdbId: 77, title: 'Film' }), film('Film (2010) 2160p', 'b.mkv', { tmdbId: 77, title: 'Film' })]);
  const after = pass([film('Film (2010) 1080p', 'a.mkv', { title: 'Film' }), film('Film (2010) 2160p', 'b.mkv', { title: 'Film' })]);
  const watch = {
    'u1:p1:tmdb:movie:77': row('Film', { position: 300, meta: { title: 'Film', type: 'movie', localKey: before[0].key } }),
    'u1:p2:tmdb:movie:77': row('Film', { position: 600, meta: { title: 'Film', type: 'movie', localKey: before[1].key } }),
    'u1:p3:tmdb:movie:77': row('Film', { position: 900, meta: { title: 'Film', type: 'movie', source: { name: 'a.mkv' } } }),
  };
  run(before, after, watch);
  assert.strictEqual(watch[`u1:p1:${after[0].key}`].position, 300, 'the 1080p copy');
  assert.strictEqual(watch[`u1:p2:${after[1].key}`].position, 600, 'the 2160p copy');
  assert.strictEqual(watch[`u1:p3:${after[0].key}`].position, 900, 'its file name names the 1080p copy');
  assert.ok(!Object.keys(watch).some((k) => k.endsWith('tmdb:movie:77')), 'nothing is left on a catalog key no copy uses');
});

test('watch keys: a doubled episode file removed: the other copy takes the S/E key and keeps its own progress', () => {
  const show = { kind: 'show', dir: at('Kuh'), title: 'Kuh' };
  const a = { kind: 'episode', file: at('Kuh', 'Kuh S01E01 (1080p).mkv'), fileSize: 50, showIdx: 0, s: 1, e: 1, title: 'Kuh · S01E01' };
  const b = { kind: 'episode', file: at('Kuh', 'Kuh S01E01.mkv'), fileSize: 60, showIdx: 0, s: 1, e: 1, title: 'Kuh · S01E01' };
  const prev = pass([show, a, b]);
  assert.ok(prev[1].key.endsWith(':s1e1') && !prev[2].key.endsWith(':s1e1'), 'the first by path holds S/E');
  const next = pass([show, b]);
  const watch = { [`u1:default:${prev[2].key}`]: row('Kuh — S01E01', { position: 700, meta: { title: 'Kuh — S01E01', type: 'episode' } }) };
  const orphans = {};
  const moves = planMoves({ prevItems: prev, items: next, watchKeyOf: wk });
  applyLibraryMoves({ libId: LIB, watch, watchlist: {}, orphans, prevItems: prev, items: next, moves, watchKeyOf: wk, now: 1000 });
  parkVanished({ libId: LIB, watch, watchlist: {}, orphans, prevItems: prev, items: next, moves, watchKeyOf: wk, now: 1000 });
  assert.strictEqual(watch[`u1:default:${next[1].key}`] && watch[`u1:default:${next[1].key}`].position, 700);
  assert.deepStrictEqual(orphans, {});
  // The other way round: a better copy added beside the old one sorts first and takes S/E; the old
  // copy's rows stay where they are (S/E), as before.
  const one = pass([show, b]);
  const two = pass([show, a, b]);
  const w2 = { [`u1:default:${one[1].key}`]: row('Kuh — S01E01', { position: 400, meta: { title: 'Kuh — S01E01', type: 'episode' } }) };
  run(one, two, w2);
  assert.strictEqual(w2[`u1:default:${one[1].key}`].position, 400, 'the S/E row is not moved off its key');
});

test('watch keys: a row imported from Trakt never wins a merge over the user\'s own row', () => {
  const before = pass([film('Copper', 'c.mkv', { title: 'Copper' })]);
  const after = pass([film('Copper', 'c.mkv', { title: 'Copper', tmdbId: 9001 })]);
  const watch = {
    [`u1:default:${before[0].key}`]: row('Copper', { position: 300, updatedAt: 100, meta: { title: 'Copper', type: 'movie', localKey: before[0].key } }),
    'u1:default:tmdb:movie:9001': { position: 0, duration: 0, watched: true, fromTrakt: true, meta: { title: 'Copper', type: 'movie' }, updatedAt: 200 },
  };
  run(before, after, watch);
  const r = watch['u1:default:tmdb:movie:9001'];
  assert.strictEqual(r.position, 300, 'the user\'s 300 s stays');
  assert.ok(!r.fromTrakt);
});

test('watch keys: a row that changes catalog title is sent to Trakt again under the new title', () => {
  const before = pass([film('Romeo', 'r.mkv', { title: 'Romeo', tmdbId: 680 })]);
  const after = pass([film('Romeo', 'r.mkv', { title: 'Romeo', tmdbId: 681 })]);
  const watch = { 'u1:default:tmdb:movie:680': row('Romeo', { watched: true, traktExportedAt: 50, meta: { title: 'Romeo', type: 'movie' } }) };
  run(before, after, watch);
  assert.ok(watch['u1:default:tmdb:movie:681']);
  assert.strictEqual(watch['u1:default:tmdb:movie:681'].traktExportedAt, undefined);
});

test('watch keys: with no previous pass to read positions from, old rows wait; none is kept aside', () => {
  // The library database could not open, so the scan had no stored items: a position names nothing.
  const items = pass([film('Bravo', 'b.mkv'), film('Delta', 'd.mkv')]);
  const watch = { [`u1:default:local:${LIB}:1`]: row('Delta') };
  const { stats, orphans } = run([], items, watch);
  assert.strictEqual(stats.parked, 0);
  assert.deepStrictEqual(orphans, {});
  assert.ok(watch[`u1:default:local:${LIB}:1`], 'the row waits for a pass that knows its position');
});

test('watch keys: a watched tick imported from Trakt is not lost to the user\'s own replay of 30 s or less', () => {
  // The matched show's "Play S01E01" wrote 0 s over an episode Trakt says is watched.
  const show = (extra) => ({ kind: 'show', dir: at('Iron Harbor'), title: 'Iron Harbor', ...extra });
  const ep = (extra) => ({ kind: 'episode', file: at('Iron Harbor', 'Iron Harbor S01E02.mkv'), showIdx: 0, s: 1, e: 2, title: 'Iron Harbor · S01E02', ...extra });
  const before = pass([show({}), ep({})]);
  const after = pass([show({ tmdbId: 9101 }), ep({ tmdbId: 9101 })]);
  const watch = {
    [`u1:default:${before[1].key}`]: row('Iron Harbor — S01E02', { position: 0, updatedAt: 300, meta: { title: 'Iron Harbor — S01E02', type: 'episode' } }),
    'u1:default:tmdb:tv:9101:s1e2': { position: 0, duration: 0, watched: true, fromTrakt: true, meta: { title: 'Iron Harbor', type: 'episode' }, updatedAt: 200 },
  };
  run(before, after, watch);
  assert.strictEqual(watch['u1:default:tmdb:tv:9101:s1e2'].watched, true);
});

test('watch keys: a library path change (every show moves) is planned in well under seconds (brief 101)', () => {
  const big = (rootName) => {
    const list = [];
    for (let s = 0; s < 800; s++) {
      const showIdx = list.length;
      list.push({ kind: 'show', dir: at(rootName, `Show ${s}`), title: `Show ${s}` });
      for (let e = 1; e <= 25; e++) list.push({ kind: 'episode', file: at(rootName, `Show ${s}`, `S01E${e}.mkv`), showIdx, s: 1, e, title: `Show ${s} · S01E${e}`, fileSize: 1000 + s * 100 + e });
    }
    return pass(list);
  };
  const before = big('Old');
  const after = big('New'); // the library folder moved one level: every key changes, files pair by name + size
  const t0 = Date.now();
  const moves = planMoves({ prevItems: before, items: after, watchKeyOf: wk });
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `took ${ms} ms (the per-show scan of the whole library took 2.4 s here)`);
  assert.strictEqual(moves.filter((m) => /^local:[^:]+:[0-9a-f]{12}$/.test(m.from)).length, 800, 'every show followed its folder');
});

test('watch keys: a doubled episode removed: the other copy keeps its progress when the previous pass comes from storage (no relPath)', () => {
  // Check 103: the library database no longer stores relPath (f11d4fb) and keyed stored items are
  // used as they are (e7af53b), so the previous pass has no relPath; the same file is matched by
  // its stored path instead.
  const show = { kind: 'show', dir: at('Kuh'), title: 'Kuh' };
  const a = { kind: 'episode', file: at('Kuh', 'Kuh S01E01 (1080p).mkv'), fileSize: 50, showIdx: 0, s: 1, e: 1, title: 'Kuh · S01E01' };
  const b = { kind: 'episode', file: at('Kuh', 'Kuh S01E01.mkv'), fileSize: 60, showIdx: 0, s: 1, e: 1, title: 'Kuh · S01E01' };
  const stored = pass([show, a, b]).map((it) => { const { relPath: _r, ...rest } = it; return rest; });
  const next = pass([show, b]);
  const watch = { [`u1:default:${stored[2].key}`]: row('Kuh — S01E01', { position: 700, meta: { title: 'Kuh — S01E01', type: 'episode' } }) };
  const orphans = {};
  const moves = planMoves({ prevItems: stored, items: next, watchKeyOf: wk });
  applyLibraryMoves({ libId: LIB, watch, watchlist: {}, orphans, prevItems: stored, items: next, moves, watchKeyOf: wk, now: 1000 });
  parkVanished({ libId: LIB, watch, watchlist: {}, orphans, prevItems: stored, items: next, moves, watchKeyOf: wk, now: 1000 });
  assert.strictEqual(watch[`u1:default:${next[1].key}`] && watch[`u1:default:${next[1].key}`].position, 700);
  assert.deepStrictEqual(orphans, {});
});

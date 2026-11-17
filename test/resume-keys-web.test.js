'use strict';
// The page side of stable resume keys (brief 99): the functions run as written in web/index.html.
// Every name here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const fn = (name) => {
  let start = ui.indexOf(`function ${name}(`);
  if (ui.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const end = ui.indexOf('\nfunction ', start + 1);
  const asyncEnd = ui.indexOf('\nasync function ', start + 1);
  const stop = [end, asyncEnd].filter((n) => n > start).sort((a, b) => a - b)[0];
  assert.ok(start >= 0 && stop > start, `${name} should be extractable`);
  return ui.slice(start, stop);
};
const load = (names, deps = {}) => {
  const src = names.map(fn).join('\n');
  const keys = Object.keys(deps);
  return new Function(...keys, `${src}\nreturn { ${names.join(', ')} };`)(...keys.map((k) => deps[k]));
};

const LIB = 'abc123def0';
const H = '0123456789ab';
const DIGITS = '123456789012'; // a stable id can be all digits

test('web keys: a stable key is told from a position key by length, also when all digits', () => {
  const { parseStableLocalKey } = load(['parseStableLocalKey']);
  assert.deepStrictEqual(parseStableLocalKey(`local:${LIB}:${H}:s1e2`), { libId: LIB, id: H, season: 1, episode: 2 });
  assert.deepStrictEqual(parseStableLocalKey(`local:${LIB}:${DIGITS}`), { libId: LIB, id: DIGITS, season: null, episode: null });
  assert.strictEqual(parseStableLocalKey(`local:${LIB}:15115`), null);
  assert.strictEqual(parseStableLocalKey('tmdb:tv:9:s1e2'), null);
});

test('web keys: Continue Watching shows one card per library show with stable episode keys', () => {
  const { continueWatchingIdentity } = load(['continueWatchingCleanTitle', 'continueWatchingIdentity']);
  assert.strictEqual(continueWatchingIdentity({ key: `local:${LIB}:${H}:s1e2`, type: 'episode', title: 'Darya' }), `localshow:${LIB}:${H}`);
  assert.strictEqual(continueWatchingIdentity({ key: `local:${LIB}:${H}:s1e3`, title: 'Anything' }), `localshow:${LIB}:${H}`);
  assert.strictEqual(continueWatchingIdentity({ key: `local:${LIB}:${DIGITS}`, title: 'Film' }), `local:${LIB}:${DIGITS}`,
    'an all-digit stable id is a film key, not a position');
  assert.strictEqual(continueWatchingIdentity({ key: 'tmdb:tv:9101:s1e2' }), 'tv:9101', 'a matched show\'s episode is its catalog show (F-1)');
});

test('web keys: a stable key finds its library row by key, whatever its position', () => {
  const S = {
    libraries: [{ id: LIB, path: '/x' }],
    libCache: { [LIB]: { data: { items: [
      { idx: 0, key: `local:${LIB}:aaaaaaaaaaaa`, watchKey: `local:${LIB}:aaaaaaaaaaaa`, title: 'Aab' },
      { idx: 1, key: `local:${LIB}:${H}`, watchKey: `local:${LIB}:${H}`, title: 'Gol Sorkh' },
      { idx: 2, key: `local:${LIB}:bbbbbbbbbbbb:s1e2`, watchKey: 'tmdb:tv:9101:s1e2', title: 'Iron Harbor · S01E02', kind: 'episode' },
    ] } } },
  };
  const { localLibraryRowFromKey } = load(['parseStableLocalKey', 'localLibraryRowFromKey'], { S });
  assert.strictEqual(localLibraryRowFromKey(`local:${LIB}:${H}`).row.title, 'Gol Sorkh');
  assert.strictEqual(localLibraryRowFromKey(`local:${LIB}:0`).row.title, 'Aab', 'a position key still reads its position');
  assert.strictEqual(localLibraryRowFromKey(`local:${LIB}:cccccccccccc`).row, null, 'an unknown key finds nothing, never a neighbour');
});

test('web keys: a library card is titled by the library today; an old raw NFO title is cleaned (F-2)', () => {
  const S = { localMap: { [`local:${LIB}:${H}:s1e2`]: { name: 'Kuh کوه · S01E02' } } };
  const { continueWatchingTitleFor, cleanLibraryTitle } = load(['cleanLibraryTitle', 'continueWatchingTitleFor'], { S });
  assert.strictEqual(continueWatchingTitleFor({ key: `local:${LIB}:${H}:s1e2`, meta: { title: 'IR - Kuh کوه [1080p] — S01E02' } }), 'Kuh کوه');
  S.localMap[`local:${LIB}:eeeeeeeeeeee:s1e2`] = { name: 'IR - Kuh کوه [1080p] · S01E02' };
  assert.strictEqual(continueWatchingTitleFor({ key: `local:${LIB}:eeeeeeeeeeee:s1e2`, meta: { title: 'IR - Kuh کوه [1080p] — S01E02' } }), 'Kuh کوه',
    'a library stored by 3.4.14 still holds the raw NFO name before its first rescan: cleaned too');
  assert.strictEqual(continueWatchingTitleFor({ key: `local:${LIB}:dddddddddddd`, meta: { title: 'IR - Kuh کوه [1080p] — S01E02' } }), 'Kuh کوه',
    'not in the page map yet: cleaned like the server does');
  assert.strictEqual(continueWatchingTitleFor({ key: 'tmdb:movie:5', meta: { title: 'A Catalog Film [1080p]' } }), 'A Catalog Film [1080p]',
    'a catalog card keeps its saved title');
  assert.strictEqual(cleanLibraryTitle('|IR| Darya دریا (IR) [720p]'), 'Darya دریا');
  assert.strictEqual(cleanLibraryTitle('Shab Abi (2019) شب آبی'), 'Shab Abi (2019) شب آبی', 'the year and every word stay');
});

test('web keys: "Details" on a library card opens its library page, never playback (F-3)', () => {
  const { isLibraryOnlyCard } = load(['isLibraryOnlyCard']);
  assert.ok(isLibraryOnlyCard({ key: `local:${LIB}:${H}` }));
  assert.ok(isLibraryOnlyCard({ key: `local:${LIB}:3` }));
  assert.ok(isLibraryOnlyCard({ key: 'x', _lib: { path: '/p' } }));
  assert.ok(!isLibraryOnlyCard({ key: 'tmdb:movie:9001', _lib: { path: '/p' }, tmdbId: 9001 }), 'a matched card opens its catalog page');
  assert.match(ui, /else if \(act === 'info' && isLibraryOnlyCard\(it\)\) openLibraryDetailsFor\(it\);\s*else if \(act === 'info'\) openDetail\(detailTargetForItem\(it\)\);/);
  const opener = fn('openLibraryDetailsFor');
  assert.match(opener, /openLocalShowDetail\(/);
  assert.match(opener, /openLocalDetail\(/);
  assert.match(opener, /\/api\/libraries\/local-lookup/, 'a cold page looks the row up instead of playing');
});

test('web keys: Home asks for Up next when a library show episode is watched, with or without TMDB (S-3)', () => {
  const S = { profile: { id: 'p2' } };
  const { cwNextFingerprint } = load(['parseStableLocalKey', 'cwNextFingerprint'], { S });
  const fp = cwNextFingerprint([{ key: `local:${LIB}:${H}:s1e1`, watched: true }, { key: `local:${LIB}:${H}`, watched: true }]);
  assert.ok(fp.includes(`local:${LIB}:${H}:s1e1@1`), fp);
  assert.ok(!fp.includes(`local:${LIB}:${H}@`), 'a film key is not an episode');
  assert.match(fn('prepareHomeTvNext'), /const libraryNext = String\(fp\)\.includes\('local:'\);[\s\S]+&& !libraryNext\)/);
});

test('web keys: library cards save under the server\'s watch key and send the library copy as a hint', () => {
  assert.match(fn('mapLocal'), /key: x\.watchKey \|\| \(matched && type \? `tmdb:\$\{type\}:\$\{x\.tmdbId\}` : `local:\$\{lib\.id\}:\$\{x\.idx\}`\),\s*_localKey: x\.key \|\| '',/);
  assert.match(fn('mergeLocalItemsInto'), /if \(x\.key\) map\[x\.key\] = rec;/);
  assert.match(ui, /if \(p\.item\._localKey && p\.item\._localKey !== payload\.key\) payload\.localKey = p\.item\._localKey;/);
  assert.match(fn('buildCwItems'), /_localKey: \(w\.meta && w\.meta\.localKey\) \|\| undefined/);
});

test('web keys: Home looks up the pictures of library cards once when the page map is cold (F-4)', async () => {
  const asked = [];
  let painted = 0;
  const S = { localMap: { 'tmdb:movie:9001': { name: 'Copper Lantern' } } };
  const deps = {
    S,
    fetchLocalPlaybackKeys: async (keys) => { asked.push(...keys); for (const k of keys) if (!/missing/.test(k)) S.localMap[k] = { name: k }; },
    paintHomeWatchNow: () => { painted++; },
  };
  const { warmContinueWatchingArt } = load(['warmContinueWatchingArt'], deps);
  const cw = [
    { key: 'tmdb:movie:9001', meta: {} }, // already in the map
    { key: `local:${LIB}:${H}`, meta: {} },
    { key: 'tmdb:tv:9101:s1e2', meta: { localKey: `local:${LIB}:bbbbbbbbbbbb:s1e2` } },
    { key: `local:${LIB}:missing00000`, meta: {} },
    { key: 'live:1', meta: {} },
    { key: `local:${LIB}:cccccccccccc`, watched: true, meta: {} },
  ];
  assert.strictEqual(await warmContinueWatchingArt(cw), true);
  assert.deepStrictEqual(asked.sort(), [`local:${LIB}:${H}`, `local:${LIB}:bbbbbbbbbbbb:s1e2`, `local:${LIB}:missing00000`, 'tmdb:tv:9101:s1e2'].sort());
  assert.strictEqual(painted, 1, 'Home repaints once the pictures are known');
  assert.strictEqual(await warmContinueWatchingArt(cw), false, 'a key that found nothing is not asked again');
  assert.strictEqual(asked.length, 4);
  assert.match(fn('loadRows'), /publishHomeRows\(homeRowsFromWatch\(cw, false\)[^\n]+\n\s*if \(!opts\.catalogOnly && cw\.length\) \(window\.requestIdleCallback \|\| \(\(f\) => setTimeout\(f, 200\)\)\)\(\(\) => warmContinueWatchingArt\(cw\)\);/);
});

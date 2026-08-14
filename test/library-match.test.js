'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  parseLibraryName,
  libraryTitleMatches,
  pickLibraryTmdbHit,
  libraryItemMatchesTmdb,
  unboundLibraryItem,
} = require('../server/library-match');

test('parseLibraryName uses the last year token and drops trailing non-latin text', () => {
  assert.deepStrictEqual(parseLibraryName('Do Sag (2025) دو سگ'), { title: 'Do Sag', year: '2025' });
  assert.deepStrictEqual(parseLibraryName('Blade Runner 2049 (2017)'), { title: 'Blade Runner 2049', year: '2017' });
  assert.deepStrictEqual(parseLibraryName('Wonder.Woman.1984.2020.1080p.mkv'), { title: 'Wonder Woman 1984', year: '2020' });
});

test('library title match rejects first-hit TMDB collisions and keeps real aliases', () => {
  assert.strictEqual(
    libraryTitleMatches('Do Sag', 2025, 'The Lord of the Rings: The Return of the King', 2003, 'movie'),
    false,
    'Do Sag is not Return of the King');
  assert.strictEqual(
    libraryTitleMatches('Crystal', 2008, 'Indiana Jones and the Kingdom of the Crystal Skull', 2008, 'movie'),
    false,
    'Crystal is not Crystal Skull');
  assert.strictEqual(
    libraryTitleMatches('Impossible', 1996, 'Mission: Impossible', 1996, 'movie'),
    false,
    'one-word unique half is not enough for a movie');
  assert.strictEqual(
    libraryTitleMatches('The Return of the King', 2003, 'The Lord of the Rings: The Return of the King', 2003, 'movie'),
    true,
    'folder may be the unique catalog half');
  assert.strictEqual(
    libraryTitleMatches('Lioness', 2023, 'Special Ops: Lioness', 2023, 'tv'),
    true,
    'TV folder may be the unique catalog half');
  assert.strictEqual(
    libraryTitleMatches('matrix', 1999, 'The Matrix', 1999, 'movie'),
    true,
    'file may drop the leading article');
  assert.strictEqual(
    libraryTitleMatches('Do Sag', 2025, 'Do Sag', 2025, 'movie'),
    true);
  assert.strictEqual(
    libraryTitleMatches('Do Sag', 2025, 'Two Dogs', 2025, 'movie'),
    false,
    'English TMDB title still needs originalTitle at lookup time');
});

test('pickLibraryTmdbHit walks results instead of taking results[0]', () => {
  const rotk = {
    id: 122, title: 'The Lord of the Rings: The Return of the King',
    original_title: 'The Lord of the Rings: The Return of the King', release_date: '2003-12-01',
  };
  const doSag = {
    id: 999001, title: 'Do Sag', original_title: 'دو سگ', release_date: '2025-01-01',
  };
  assert.strictEqual(pickLibraryTmdbHit([rotk, doSag], 'Do Sag', 2025, 'movie'), doSag);
  assert.strictEqual(pickLibraryTmdbHit([rotk], 'Do Sag', 2025, 'movie'), null);
  const skull = {
    id: 217, title: 'Indiana Jones and the Kingdom of the Crystal Skull',
    original_title: 'Indiana Jones and the Kingdom of the Crystal Skull', release_date: '2008-05-22',
  };
  assert.strictEqual(pickLibraryTmdbHit([skull], 'Crystal', 2008, 'movie'), null);
  const lioness = { id: 157741, name: 'Special Ops: Lioness', original_name: 'Special Ops: Lioness', first_air_date: '2023-07-23' };
  assert.strictEqual(pickLibraryTmdbHit([lioness], 'Lioness', 2023, 'tv'), lioness);
});

test('stored TMDB ids are unbound when the file/folder title does not describe them', () => {
  const doSagFile = path.join('M:', 'IR', 'PERSIAN MOVIES', 'Do Sag (2025) دو سگ', 'Do Sag (2025) دو سگ.mkv');
  const bad = {
    kind: 'movie', tmdbId: 122, title: 'The Lord of the Rings: The Return of the King',
    year: 2025, file: doSagFile,
  };
  assert.strictEqual(libraryItemMatchesTmdb(bad), false);
  const unbound = unboundLibraryItem(bad);
  assert.strictEqual(unbound.tmdbId, null);
  assert.strictEqual(unbound.title, 'Do Sag');

  const matrix = {
    kind: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999,
    file: path.join('/media', 'matrix.mkv'),
  };
  assert.strictEqual(libraryItemMatchesTmdb(matrix), true);
  assert.strictEqual(unboundLibraryItem(matrix).tmdbId, 603);

  const forced = { ...bad, matchOverride: 122 };
  assert.strictEqual(libraryItemMatchesTmdb(forced), true, 'admin override still wins');

  const leftoverArt = {
    ...bad,
    matchOverride: 'none',
    poster: '/abc123.jpg',
    backdrop: '/def456.jpg',
  };
  const folderOnly = unboundLibraryItem(leftoverArt);
  assert.strictEqual(folderOnly.tmdbId, null, 'folder-info override drops the TMDB id');
  assert.strictEqual(folderOnly.poster, null, 'folder-info override drops the leftover TMDB poster');
  assert.strictEqual(folderOnly.backdrop, null, 'folder-info override drops the leftover TMDB backdrop');

  const originalOk = {
    kind: 'movie', tmdbId: 999001, title: 'Two Dogs', originalTitle: 'Do Sag',
    year: 2025, file: doSagFile,
  };
  assert.strictEqual(libraryItemMatchesTmdb(originalOk), true);
});

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

    const first = db.page('libA', { offset: 0, limit: 2, sort: 'added.desc' });
    assert.strictEqual(first.total, 3, 'top-level page excludes episodes');
    assert.deepStrictEqual(first.items.map((i) => i.title), ['The Matrix', 'Not Sci Fi']);
    assert.strictEqual(first.hasMore, true);

    const scifi = db.page('libA', { offset: 0, limit: 10, genre: 878 });
    assert.deepStrictEqual(scifi.items.map((i) => i.title), ['The Matrix'],
      'genre tokens do not match larger ids like 2878');

    const eps = db.page('libA', { showIdx: 3, offset: 0, limit: 10 });
    assert.strictEqual(eps.show.title, 'Test Show');
    assert.deepStrictEqual(eps.items.map((i) => `${i.s}x${i.e}`), ['1x2']);

    const found = db.lookup(['tmdb:movie:603', 'tmdb:tv:424242:s1e2'], ['libA']);
    assert.strictEqual(found['tmdb:movie:603'].item.title, 'The Matrix');
    assert.strictEqual(found['tmdb:tv:424242:s1e2'].item.title, 'Episode Two');
    assert.deepStrictEqual(db.lookup(['tmdb:movie:603'], ['otherLib']), {}, 'lookup respects allowed library ids');

    const matrix = db.item('libA', 1);
    matrix.title = 'The Matrix Reloaded';
    matrix.tmdbId = 604;
    assert.strictEqual(db.updateItem('libA', 1, matrix), true);
    assert.strictEqual(db.lookup(['tmdb:movie:603'], ['libA'])['tmdb:movie:603'], undefined);
    assert.strictEqual(db.lookup(['tmdb:movie:604'], ['libA'])['tmdb:movie:604'].item.title, 'The Matrix Reloaded');

    assert.strictEqual(db.deleteLibrary('libA'), true);
    assert.strictEqual(db.readLibrary('libA'), null);
  } finally {
    db.close();
  }
});

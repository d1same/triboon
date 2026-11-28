'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const demoSeed = require('../server/demo-seed');

test('store demo seeder: ships only copyright-free CC-BY Blender Open Movies and valid NFO XML', () => {
  assert.strictEqual(demoSeed.OPEN_MOVIES.length, 3);
  const titles = demoSeed.OPEN_MOVIES.map((m) => m.title);
  assert.deepStrictEqual(titles, ['Tears of Steel', 'Sintel', 'Big Buck Bunny']);
  for (const m of demoSeed.OPEN_MOVIES) {
    assert.match(m.plot, /Creative Commons Attribution/i);
    const nfo = demoSeed.buildMovieNfo(m);
    assert.match(nfo, /<movie>/);
    assert.match(nfo, new RegExp(`<title>${m.title}</title>`));
    assert.match(nfo, new RegExp(`<year>${m.year}</year>`));
  }
});

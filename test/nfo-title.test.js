'use strict';

// Hand-written NFO titles (result 88 T1). A downloader writes the provider's raw name into
// tvshow.nfo / movie NFOs ("IR - Show [1080p]"). The NFO title still wins over the folder name, but
// it is cleaned like a folder name: release and country tags go, and a leading "IR - " or "|IR|".
// Every name here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lm = require('../server/library-match');
const { httpJson, bootServer, setupAdmin } = require('./helpers');

test('an NFO title loses release and country tags and a leading IR prefix, and keeps its words', () => {
  assert.strictEqual(lm.cleanNfoTitle('IR - Yankee یانکی [1080p]'), 'Yankee یانکی');
  assert.strictEqual(lm.cleanNfoTitle('|IR| Dar دار [720p]'), 'Dar دار');
  assert.strictEqual(lm.cleanNfoTitle('| IR | Lane لین'), 'Lane لین');
  assert.strictEqual(lm.cleanNfoTitle('IR – Pako پاکو'), 'Pako پاکو', 'an en dash too');
  assert.strictEqual(lm.cleanNfoTitle('Film فیلم (2019) [1080p]'), 'Film فیلم (2019)', 'the year stays for the caller to strip');
  assert.strictEqual(lm.cleanNfoTitle('(IR) Mard مرد [۱۰۸۰p]'), 'Mard مرد', 'Persian digits in a tag');
  assert.strictEqual(lm.cleanNfoTitle('Kite Runner'), 'Kite Runner', 'a clean title is unchanged');
  assert.strictEqual(lm.cleanNfoTitle('IRA - The Long Way'), 'IRA - The Long Way', 'only the IR prefix, not a word that starts with IR');
  assert.strictEqual(lm.cleanNfoTitle('Iris - A Garden'), 'Iris - A Garden');
  assert.strictEqual(lm.cleanNfoTitle('Mike Show - IR - Notes'), 'Mike Show - IR - Notes', 'a prefix only at the start');
  assert.strictEqual(lm.cleanNfoTitle('[1080p]'), '', 'nothing left: the caller falls back to the folder name');
});

test('a scan shows the cleaned NFO title; the hand-written NFO still wins over the folder name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-nfotitle-'));
  const put = (rel, body = 'V') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  put('Yankee Folder/tvshow.nfo', '<tvshow><title>IR - Yankee یانکی [1080p]</title></tvshow>');
  put('Yankee Folder/Season 01/Yankee - S01E01.mp4');
  put('Film Folder (2019)/Film Folder.mkv');
  put('Film Folder (2019)/movie.nfo', '<movie><title>|IR| Film فیلم (2019) [1080p]</title></movie>');
  put('Bare Folder/Bare Folder.mkv');
  put('Bare Folder/movie.nfo', '<movie><title>[1080p]</title></movie>');
  const { port, shutdown } = await bootServer({ TMDB_BASE: null });
  try {
    const admin = await setupAdmin(port);
    const lib = await httpJson(port, 'POST', '/api/libraries', { name: 'NFO', kind: 'movie', path: root }, admin);
    const id = lib.json.id;
    await httpJson(port, 'POST', `/api/libraries/${id}/scan`, {}, admin);
    for (let i = 0; i < 100; i++) {
      const st = await httpJson(port, 'GET', `/api/libraries/${id}/scanstatus`, null, admin);
      if (!st.json.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const items = (await httpJson(port, 'GET', `/api/libraries/${id}/items?limit=60`, null, admin)).json.items || [];
    const titles = items.map((i) => i.title).sort();
    assert.ok(titles.includes('Yankee یانکی'), `show title from the NFO, cleaned: ${titles.join(' | ')}`);
    assert.ok(titles.includes('Film فیلم'), `film title from the NFO, tags and year gone: ${titles.join(' | ')}`);
    assert.ok(titles.includes('Bare Folder'), `an NFO title that is only a tag falls back to the folder name: ${titles.join(' | ')}`);
    assert.ok(!titles.some((t) => /\[1080p\]|^IR -|\|IR\|/.test(t)), 'no tag survives');
  } finally {
    await shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

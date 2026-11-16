'use strict';

// Library auto-scan cost (result 89, Part A). A pass is sync disk work on the thread that sends
// the video, and a user share answers every listing and every failed open slowly. So:
// - each folder is listed ONCE per pass and an NFO is opened only when the listing has it, and
//   read once;
// - an unchanged pass does not rewrite the library database;
// - the 15-minute auto-scan waits while anything plays (a stream or a Live TV viewer), with a
//   2-hour cap, and "Scan now" never waits.
// Every name here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpJson, bootServer, setupAdmin } = require('./helpers');
const { LibraryDb } = require('../server/library-db');

const put = (root, rel, body = 'V') => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};

function makeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-scancost-'));
  put(root, 'Amber Gate (2001)/Amber Gate.mkv');
  put(root, 'Amber Gate (2001)/Amber Gate.nfo', '<movie><title>Amber Gate</title><year>2001</year><plot>A made-up plot.</plot></movie>');
  put(root, 'Amber Gate (2001)/poster.jpg', 'J');
  put(root, 'Birch Line (2003)/Birch Line.mkv');
  put(root, 'Birch Line (2003)/movie.nfo', '<movie><title>Birch Line</title><thumb aspect="poster">cover.jpg</thumb></movie>');
  put(root, 'Birch Line (2003)/cover.jpg', 'J');
  put(root, 'Cedar Field (2005)/Cedar Field.mkv');
  put(root, 'Dune Harbor/tvshow.nfo', '<tvshow><title>Dune Harbor</title><plot>Made-up show.</plot></tvshow>');
  put(root, 'Dune Harbor/Season 01/Dune Harbor - S01E01.mp4');
  put(root, 'Dune Harbor/Season 01/Dune Harbor - S01E01.nfo', '<episodedetails><title>Pilot</title></episodedetails>');
  put(root, 'Dune Harbor/Season 01/Dune Harbor - S01E02.mp4');
  put(root, 'Dune Harbor/Season 02/Dune Harbor - S02E01.mp4');
  put(root, 'Loose Reel (2007).mkv');
  return root;
}
const FOLDERS = 7; // root, 3 film folders, the show folder, 2 season folders
const NFOS = 4;    // Amber Gate.nfo, movie.nfo, tvshow.nfo, the S01E01 episode NFO

async function scanAndWait(port, id, admin) {
  await httpJson(port, 'POST', `/api/libraries/${id}/scan`, {}, admin);
  for (let i = 0; i < 200; i++) {
    const st = await httpJson(port, 'GET', `/api/libraries/${id}/scanstatus`, null, admin);
    if (!st.json.running) return st.json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('scan did not finish');
}

function spyFs(root) {
  const seen = { readdir: [], read: [], readFail: [] };
  const origDir = fs.readdirSync;
  const origRead = fs.readFileSync;
  const under = (p) => String(p).startsWith(root);
  fs.readdirSync = function spyReaddir(p, ...a) {
    if (under(p)) seen.readdir.push(String(p));
    return origDir.call(this, p, ...a);
  };
  fs.readFileSync = function spyRead(p, ...a) {
    if (!under(p)) return origRead.call(this, p, ...a);
    try {
      const r = origRead.call(this, p, ...a);
      seen.read.push(String(p));
      return r;
    } catch (e) { seen.readFail.push(String(p)); throw e; }
  };
  seen.restore = () => { fs.readdirSync = origDir; fs.readFileSync = origRead; };
  return seen;
}

test('an unchanged library pass lists each folder once, opens only NFOs that exist, and keeps the database rows', async () => {
  const lib = makeLibrary();
  const srv = await bootServer({ TMDB_BASE: null });
  const replace = LibraryDb.prototype.replaceLibrary;
  let replaced = 0;
  LibraryDb.prototype.replaceLibrary = function counted(...a) { replaced++; return replace.apply(this, a); };
  try {
    const admin = await setupAdmin(srv.port);
    const created = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Cost', kind: 'movie', path: lib }, admin);
    assert.strictEqual(created.status, 200, created.raw);
    const id = created.json.id;
    const first = await scanAndWait(srv.port, id, admin);
    assert.ok(first.count >= 8, `first scan found the items: ${JSON.stringify(first)}`);
    const writesAfterFirst = replaced;
    assert.ok(writesAfterFirst >= 1, 'the first scan writes the rows');

    const spy = spyFs(lib);
    let second;
    try { second = await scanAndWait(srv.port, id, admin); } finally { spy.restore(); }
    assert.strictEqual(second.count, first.count);
    assert.strictEqual(new Set(spy.readdir).size, spy.readdir.length, `a folder was listed twice: ${spy.readdir.join(' | ')}`);
    assert.strictEqual(spy.readdir.length, FOLDERS, `every folder listed once: ${spy.readdir.join(' | ')}`);
    assert.deepStrictEqual(spy.readFail, [], 'no blind open of an NFO that is not in the listing');
    assert.strictEqual(spy.read.length, NFOS, `each NFO read once: ${spy.read.join(' | ')}`);
    assert.strictEqual(replaced, writesAfterFirst, 'an unchanged pass does not rewrite the library rows');

    // The NFO data still lands: titles, the NFO-named cover and the folder poster.
    assert.strictEqual(second.withLocalArt, first.withLocalArt);
    assert.ok(second.withLocalArt >= 2, 'poster.jpg and the cover named in movie.nfo are found');
    const items = (await httpJson(srv.port, 'GET', `/api/libraries/${id}/items?limit=60`, null, admin)).json.items || [];
    const titles = items.map((i) => i.title);
    assert.ok(titles.includes('Amber Gate') && titles.includes('Birch Line') && titles.includes('Dune Harbor'), titles.join(', '));

    // A new film is a change: that pass writes the rows again.
    put(lib, 'Elm Ridge (2009)/Elm Ridge.mkv');
    const third = await scanAndWait(srv.port, id, admin);
    assert.strictEqual(third.count, first.count + 1);
    assert.strictEqual(replaced, writesAfterFirst + 1, 'a changed pass writes the rows');
  } finally {
    LibraryDb.prototype.replaceLibrary = replace;
    await srv.shutdown();
    fs.rmSync(lib, { recursive: true, force: true });
  }
});

test('the auto-scan waits while a stream or a Live TV viewer plays, runs after playback stops or after 2 h, and Scan now never waits', async () => {
  const lib = makeLibrary();
  const srv = await bootServer({ TMDB_BASE: null });
  try {
    const admin = await setupAdmin(srv.port);
    assert.strictEqual((await httpJson(srv.port, 'POST', '/api/settings', { libAutoScanMin: 15 }, admin)).status, 200);
    const created = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Wait', kind: 'movie', path: lib }, admin);
    const id = created.json.id;
    await scanAndWait(srv.port, id, admin);
    const t0 = Date.now() + 60 * 60000; // well past any earlier pass
    const MIN = 60000;

    // A stream plays: the due pass waits.
    srv.mounts.set('zz-fake-play', { id: 'zz-fake-play', streamable: true, _activeStreamReads: 1 });
    assert.deepStrictEqual(srv.playbackActiveForAutoScan(t0), { vod: 1, live: 0 });
    assert.strictEqual(srv.autoScanTick(t0), 'deferred');
    assert.strictEqual(srv.autoScanTick(t0 + MIN), 'deferred', 'still waiting a minute later');
    // Scan now is never deferred.
    const manual = await scanAndWait(srv.port, id, admin);
    assert.ok(manual.count >= 8, 'Scan now ran while the stream played');
    // The cap: two hours after it became due, it runs anyway.
    assert.strictEqual(srv.autoScanTick(t0 + 120 * MIN), 'started');
    await scanAndWait(srv.port, id, admin);
    srv.mounts.delete('zz-fake-play');

    // A Live TV viewer counts too.
    const t1 = t0 + 140 * MIN;
    srv.liveStreamsForTest().set('zz-fake-live', { key: 'zz-fake-live' });
    assert.strictEqual(srv.playbackActiveForAutoScan(t1).live, 1);
    assert.strictEqual(srv.autoScanTick(t1), 'deferred');
    // Playback stops: the next tick runs it.
    srv.liveStreamsForTest().delete('zz-fake-live');
    assert.strictEqual(srv.autoScanTick(t1 + MIN), 'started');
    await scanAndWait(srv.port, id, admin);
    assert.strictEqual(srv.autoScanTick(t1 + 2 * MIN), 'not-due', 'the next pass is 15 minutes later');
  } finally {
    srv.mounts.delete('zz-fake-play');
    srv.liveStreamsForTest().delete('zz-fake-live');
    await srv.shutdown();
    fs.rmSync(lib, { recursive: true, force: true });
  }
});

test('a library kept in the JSON store moves into SQLite on the next scan, even when nothing changed', async () => {
  // SQLite could not open (a folder sits where the database file goes): the scan keeps its rows in
  // the JSON store. Once SQLite opens again, the next pass must move them there, as 3.4.14 did; an
  // unchanged pass that only "moves the scan time" found no SQLite row to move and wrote nothing.
  const lib = makeLibrary();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-scancost-json-'));
  const blocker = path.join(data, 'library.sqlite');
  fs.mkdirSync(blocker);
  let id;
  let first;
  const one = await bootServer({ TRIBOON_DATA: data, TMDB_BASE: null });
  try {
    const admin = await setupAdmin(one.port);
    id = (await httpJson(one.port, 'POST', '/api/libraries', { name: 'Json', kind: 'movie', path: lib }, admin)).json.id;
    first = await scanAndWait(one.port, id, admin);
    assert.ok(first.count >= 8, `the JSON-only scan found the items: ${JSON.stringify(first)}`);
  } finally {
    await one.shutdown();
  }
  fs.rmSync(blocker, { recursive: true, force: true });
  const two = await bootServer({ TRIBOON_DATA: data, TMDB_BASE: null });
  try {
    const login = await httpJson(two.port, 'POST', '/api/login', { name: 'owner', password: 'hunter22' });
    assert.strictEqual(login.status, 200, login.raw);
    const second = await scanAndWait(two.port, id, login.json.token);
    assert.strictEqual(second.count, first.count, 'nothing changed on disk');
  } finally {
    await two.shutdown();
  }
  const db = new LibraryDb(data);
  try {
    assert.ok(db.available, 'SQLite opens now');
    const rec = db.readLibrary(id);
    assert.ok(rec && rec.items && rec.items.length === first.count, `the rows are in SQLite after the scan (${rec ? rec.items.length : 'none'})`);
  } finally {
    db.close();
    fs.rmSync(lib, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

'use strict';
// Audiobook feature tests: Audnexus/Audible metadata provider (server/audible.js), book-aware
// indexer title verification (scoring/pipeline), and M4B chapter parsing. Mock HTTP for the two
// upstreams (Audible catalog + Audnexus), temp Store for the cache — mirrors phase2's approach.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store, VerdictCache } = require('../server/store');
const {
  AudibleProxy, normRegion, normProduct, normBook, normChapters, pickCover, ASIN_RE,
} = require('../server/audible');
const { parseAudiobook, scoreAudiobook, rankAudiobooks, audiobookLanguage } = require('../server/scoring');
const { Pipeline, parseWantedBook, bookMatches, isNonAudioAudiobookMount } = require('../server/pipeline');
const { parseFfprobeChapters } = require('../server/transcode');
const { audioTrackCandidates, audioInnerCandidates } = require('../server/archive');
const pubaudio = require('../server/pubaudio');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-audiobook-'));
  return new Store(dir);
}

// ---------- pure normalizers ----------
test('audible: region normalization falls back to us for unknown/empty', () => {
  assert.strictEqual(normRegion('uk'), 'uk');
  assert.strictEqual(normRegion('UK'), 'uk');
  assert.strictEqual(normRegion('zz'), 'us');
  assert.strictEqual(normRegion(''), 'us');
  assert.strictEqual(normRegion(undefined), 'us');
});

test('audible: pickCover returns the largest square image', () => {
  assert.strictEqual(pickCover({ '500': 'a.jpg', '1024': 'b.jpg', '250': 'c.jpg' }), 'b.jpg');
  assert.strictEqual(pickCover({}), null);
  assert.strictEqual(pickCover(null), null);
});

test('audible: normProduct maps an Audible catalog product', () => {
  const p = normProduct({
    asin: 'B0ABCDEFGH', title: 'The Way of Kings', subtitle: 'Book One',
    authors: [{ name: 'Brandon Sanderson' }], narrators: [{ name: 'Kate Reading' }, { name: 'Michael Kramer' }],
    product_images: { '500': 'cover500.jpg', '1024': 'cover1024.jpg' },
    runtime_length_min: 2734, release_date: '2010-08-31', language: 'english',
    series: [{ title: 'The Stormlight Archive', sequence: '1' }],
  });
  assert.strictEqual(p.asin, 'B0ABCDEFGH');
  assert.strictEqual(p.title, 'The Way of Kings');
  assert.deepStrictEqual(p.authors, ['Brandon Sanderson']);
  assert.deepStrictEqual(p.narrators, ['Kate Reading', 'Michael Kramer']);
  assert.strictEqual(p.cover, 'cover1024.jpg');
  assert.strictEqual(p.runtimeMin, 2734);
  assert.deepStrictEqual(p.series, { name: 'The Stormlight Archive', position: '1' });
});

test('audible: normChapters sorts by start and reports accuracy', () => {
  const c = normChapters({
    asin: 'B0ABCDEFGH', isAccurate: true, runtimeLengthMs: 9840000,
    brandIntroDurationMs: 2000, brandOutroDurationMs: 5000,
    chapters: [
      { title: 'Chapter 2', startOffsetMs: 600000, lengthMs: 500000 },
      { title: 'Chapter 1', startOffsetMs: 2000, lengthMs: 598000 },
    ],
  });
  assert.strictEqual(c.chapters.length, 2);
  assert.strictEqual(c.chapters[0].title, 'Chapter 1', 'sorted by start offset');
  assert.strictEqual(c.chapters[0].startMs, 2000);
  assert.strictEqual(c.isAccurate, true);
  assert.strictEqual(normChapters({ chapters: 'nope' }), null);
});

// ---------- provider with mock upstreams ----------
test('audible: search hits Audible catalog, filters non-books, and caches', async () => {
  let hits = 0;
  let lastQuery = null;
  const srv = http.createServer((req, res) => {
    hits++;
    const u = new URL(req.url, 'http://127.0.0.1');
    lastQuery = u.searchParams.get('keywords');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ products: [
      { asin: 'B0AAAAAAAA', title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }],
        narrators: [{ name: 'Michael Kramer' }], product_images: { '500': 'm.jpg' }, runtime_length_min: 1500 },
      { asin: 'B0BBBBBBBB', title: '', authors: [], runtime_length_min: null }, // junk: no title → filtered
    ] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const store = tmpStore();
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const ab = new AudibleProxy(store, { audibleBase: base });
    const out = await ab.search('mistborn', 'us');
    assert.strictEqual(out.length, 1, 'the untitled junk product is filtered out');
    assert.strictEqual(out[0].title, 'Mistborn');
    assert.strictEqual(lastQuery, 'mistborn');
    // Second identical search is served from cache (no new upstream hit).
    const out2 = await ab.search('mistborn', 'us');
    assert.strictEqual(out2.length, 1);
    assert.strictEqual(hits, 1, 'cached: upstream hit only once');
    assert.deepStrictEqual(await ab.search('', 'us'), [], 'empty query returns [] without an upstream hit');
    assert.strictEqual(hits, 1);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('audible: book + chapters look up by ASIN via Audnexus; bad ASIN rejected; 404 chapters → null', async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/books/B0AAAAAAAA/chapters') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ asin: 'B0AAAAAAAA', isAccurate: true, runtimeLengthMs: 100000,
        chapters: [{ title: 'Opening Credits', startOffsetMs: 0, lengthMs: 5000 }] }));
    }
    if (u.pathname === '/books/B0NOCHAPTS/chapters') { res.writeHead(404); return res.end('no'); }
    if (u.pathname === '/books/B0AAAAAAAA') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ asin: 'B0AAAAAAAA', title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }],
        narrators: [{ name: 'Michael Kramer' }], image: 'big.jpg', description: 'A hero rises.',
        genres: [{ name: 'Fantasy' }], rating: '4.7', runtimeLengthMin: 1500,
        seriesPrimary: { name: 'Mistborn', position: '1' } }));
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const store = tmpStore();
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const ab = new AudibleProxy(store, { audnexBase: base });
    const book = await ab.book('B0AAAAAAAA', 'us');
    assert.strictEqual(book.title, 'Mistborn');
    assert.strictEqual(book.cover, 'big.jpg');
    assert.strictEqual(book.rating, 4.7);
    assert.deepStrictEqual(book.series, { name: 'Mistborn', position: '1' });
    const chaps = await ab.chapters('B0AAAAAAAA', 'us');
    assert.strictEqual(chaps.chapters[0].title, 'Opening Credits');
    assert.strictEqual(await ab.chapters('B0NOCHAPTS', 'us'), null, 'missing chapters are null, not an error');
    await assert.rejects(() => ab.book('not-an-asin'), /bad asin/, 'bad ASIN rejected before any upstream call');
    assert.ok(!ASIN_RE.test('short'), 'ASIN regex rejects malformed ids');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// ---------- book-aware title verification ----------
test('audiobook: bookMatches accepts the right book in either order, rejects wrong title/author', () => {
  const w = parseWantedBook('The Way of Kings', 'Brandon Sanderson');
  assert.ok(bookMatches('Brandon Sanderson - The Way of Kings (2010) [M4B]', w), 'Author - Title form');
  assert.ok(bookMatches('The Way of Kings - Brandon Sanderson Unabridged 64kbps MP3', w), 'Title - Author form');
  assert.ok(bookMatches('Way of Kings by Sanderson [Audiobook]', w), 'dropped article + surname only');
  assert.ok(!bookMatches('Words of Radiance - Brandon Sanderson [M4B]', w), 'different title (right author) rejected');
  assert.ok(!bookMatches('The Way of Kings - Some Other Author [M4B]', w), 'right title, wrong author rejected');
  const noAuthor = parseWantedBook('Project Hail Mary', '');
  assert.ok(bookMatches('Project Hail Mary [M4B] Unabridged', noAuthor), 'title-only match when no author supplied');
});

// ---------- audiobook scoring ----------
test('audiobook: scoring prefers M4B + unabridged, penalizes abridged, disqualifies ebook-only', () => {
  const ranked = rankAudiobooks([
    { name: 'Author - Title Unabridged MP3 64kbps', sizeBytes: 300e6 },
    { name: 'Author - Title [M4B] Unabridged', sizeBytes: 320e6 },
    { name: 'Author - Title Abridged M4B', sizeBytes: 120e6 },
    { name: 'Author - Title EPUB', sizeBytes: 2e6 },
  ]);
  assert.ok(ranked[0].name.includes('M4B') && ranked[0].name.includes('Unabridged'), 'M4B unabridged wins');
  assert.ok(ranked.find((r) => /EPUB/.test(r.name)).score < -5000, 'ebook-only is disqualified');
  const abridged = ranked.find((r) => /Abridged/.test(r.name));
  const mp3 = ranked.find((r) => /MP3/.test(r.name));
  assert.ok(abridged.score < mp3.score, 'abridged ranks below a plain unabridged MP3');
  assert.strictEqual(parseAudiobook('Book [M4B] Unabridged 128kbps').format, 'm4b');
  assert.strictEqual(parseAudiobook('Book unabridged').unabridged, true);
  assert.strictEqual(parseAudiobook('Book Abridged').abridged, true);
  assert.strictEqual(parseAudiobook('Book Unabridged').abridged, false, '"unabridged" is not "abridged"');
});

// A book request can match an EBOOK release by title+author (e.g. "You" → Kepnes's ".mobi"); that
// release mounts fine but the <audio> element can't decode it, which surfaced as the client's
// "Playback source was lost". The mount-level guard rejects a non-audio primary so the walk advances.
test('audiobook: mount guard rejects ebook/text primaries, accepts real audio + multi-file', () => {
  // Reject: the actual "You" bug — an ebook picked as the primary file.
  assert.strictEqual(isNonAudioAudiobookMount({ name: 'For You and Only You_ ... now a hit Netflix show.mobi' }), true, '.mobi ebook rejected');
  assert.strictEqual(isNonAudioAudiobookMount({ name: 'Book.epub' }), true, '.epub rejected');
  assert.strictEqual(isNonAudioAudiobookMount({ name: 'Book.pdf' }), true, '.pdf rejected');
  assert.strictEqual(isNonAudioAudiobookMount({ name: 'cover.jpg' }), true, 'image rejected');
  // Accept: genuine audio primaries.
  assert.strictEqual(isNonAudioAudiobookMount({ name: 'Stephen.King.-.You.Like.It.Darker..m4b' }), false, 'single M4B accepted');
  assert.strictEqual(isNonAudioAudiobookMount({ name: '01 - Chapter One.mp3' }), false, 'single MP3 accepted');
  assert.strictEqual(isNonAudioAudiobookMount({ name: 'book.flac' }), false, 'FLAC accepted');
  // Accept: multi-file playlist mount (RAR of MP3s) exposes audioFiles even if vf.name isn't audio.
  assert.strictEqual(isNonAudioAudiobookMount({ name: 'release.part01.rar', audioFiles: [{ index: 0 }, { index: 1 }] }), false, 'multi-file audio playlist accepted');
});

// ---------- embedded chapter parsing (ffprobe fallback) ----------
test('audiobook: parseFfprobeChapters matches the Audnexus chapter shape and sorts', () => {
  const parsed = parseFfprobeChapters({
    format: { duration: '3600.5' },
    chapters: [
      { start_time: '1800.0', end_time: '3600.0', tags: { title: 'Chapter 2' } },
      { start_time: '0.0', end_time: '1800.0', tags: { title: 'Chapter 1' } },
      { start_time: '3600.0', end_time: '3600.5' }, // untitled → generated title
    ],
  });
  assert.strictEqual(parsed.chapters.length, 3);
  assert.strictEqual(parsed.chapters[0].title, 'Chapter 1', 'sorted by start');
  assert.strictEqual(parsed.chapters[0].startMs, 0);
  assert.strictEqual(parsed.chapters[0].lengthMs, 1800000);
  assert.strictEqual(parsed.chapters[2].title, 'Chapter 3', 'untitled chapter gets a generated title');
  assert.strictEqual(parsed.runtimeMs, 3600500);
  assert.strictEqual(parseFfprobeChapters({ chapters: [] }), null, 'no chapters → null');
  assert.strictEqual(parseFfprobeChapters({}), null);
});

// ---------- multi-file audiobook tracks ----------
test('audiobook: audioTrackCandidates keeps audio files, natural-sorts, drops non-audio', () => {
  const tracks = audioTrackCandidates([
    { name: 'Book - Part 10.mp3', bytes: 100 },
    { name: 'Book - Part 2.mp3', bytes: 100 },
    { name: 'Book - Part 1.mp3', bytes: 100 },
    { name: 'cover.jpg', bytes: 5 },
    { name: 'readme.nfo', bytes: 5 },
    { name: 'Book - Part 11.m4a', bytes: 100 },
  ]);
  assert.deepStrictEqual(tracks.map((t) => t.name), [
    'Book - Part 1.mp3', 'Book - Part 2.mp3', 'Book - Part 10.mp3', 'Book - Part 11.m4a',
  ], 'natural numeric order, non-audio excluded');
  assert.deepStrictEqual(tracks.map((t) => t.index), [0, 1, 2, 3], 'indices are contiguous');
  assert.strictEqual(audioTrackCandidates([{ name: 'only.mp3', bytes: 1 }]).length, 1);
});

test('audiobook: audioInnerCandidates orders RAR-packed tracks from (01) and skips non-store/non-audio', () => {
  // Mirrors a RAR audiobook: inner files carry extents + method. "(11)" is the biggest but must NOT
  // be track 0 — the fix for "starts from the middle".
  const inner = [
    { name: 'Book (11).mp3', size: 9000, method: 'store', extents: [{}] },
    { name: 'Book (01).mp3', size: 300, method: 'store', extents: [{}] },
    { name: 'Book (02).mp3', size: 4000, method: 'store', extents: [{}] },
    { name: 'cover.jpg', size: 50, method: 'store', extents: [{}] },
    { name: 'Book (03).mp3', size: 4000, method: 'compressed', extents: [{}] }, // compressed → skipped
  ];
  const tracks = audioInnerCandidates(inner);
  assert.deepStrictEqual(tracks.map((t) => t.name), ['Book (01).mp3', 'Book (02).mp3', 'Book (11).mp3']);
  assert.strictEqual(tracks[0].name, 'Book (01).mp3', 'plays from part 01, not the largest (11)');
});

// ---------- public-domain sources (LibriVox / Internet Archive) ----------
test('pubaudio: URL allowlist only permits archive.org / librivox.org (SSRF guard)', () => {
  assert.ok(pubaudio.isAllowedPubUrl('https://archive.org/download/x/ch1.mp3'));
  assert.ok(pubaudio.isAllowedPubUrl('https://www.archive.org/download/x/ch1.mp3'));
  assert.ok(pubaudio.isAllowedPubUrl('https://librivox.org/x.mp3'));
  assert.ok(!pubaudio.isAllowedPubUrl('https://evil.com/x.mp3'));
  assert.ok(!pubaudio.isAllowedPubUrl('http://169.254.169.254/latest/meta-data'));
  assert.ok(!pubaudio.isAllowedPubUrl('file:///etc/passwd'));
  assert.ok(!pubaudio.isAllowedPubUrl('not a url'));
});
test('pubaudio: naturalKey sorts numeric chapter files correctly', () => {
  const sorted = ['ch10.mp3', 'ch2.mp3', 'ch1.mp3'].sort((a, b) => pubaudio.naturalKey(a).localeCompare(pubaudio.naturalKey(b)));
  assert.deepStrictEqual(sorted, ['ch1.mp3', 'ch2.mp3', 'ch10.mp3']);
});

// ---------- discovery browse ----------
test('audible: browse hits the catalog with a sort + optional category, filters + caches', async () => {
  let hits = 0, lastSort = null, lastCat = null;
  const srv = http.createServer((req, res) => {
    hits++;
    const u = new URL(req.url, 'http://127.0.0.1');
    lastSort = u.searchParams.get('products_sort_by');
    lastCat = u.searchParams.get('category_id');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ products: [
      { asin: 'B0AAAAAAAA', title: 'Popular Book', authors: [{ name: 'Author One' }], runtime_length_min: 600 },
      { asin: 'B0BBBBBBBB', title: '', authors: [] }, // junk filtered
    ] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const store = tmpStore();
  try {
    const ab = new AudibleProxy(store, { audibleBase: `http://127.0.0.1:${srv.address().port}` });
    const rows = await ab.browse({ sort: 'BestSellers', categoryId: '18580606011' });
    assert.strictEqual(rows.length, 1, 'junk product filtered');
    assert.strictEqual(rows[0].title, 'Popular Book');
    assert.strictEqual(lastSort, 'BestSellers');
    assert.strictEqual(lastCat, '18580606011', 'category id passed through');
    await ab.browse({ sort: 'BestSellers', categoryId: '18580606011' });
    assert.strictEqual(hits, 1, 'second identical browse served from cache');
  } finally { await new Promise((r) => srv.close(r)); }
});

// ---------- language: English preferred, foreign editions demoted ----------
test('audiobook: detects foreign editions (codes + native words), ignores English title words', () => {
  assert.strictEqual(audiobookLanguage('Michelle Obama-Becoming-2MP3CD-DE-2018-FKKAuDiOBooK'), 'de');
  assert.strictEqual(audiobookLanguage('Some Book Hörbuch Deutsch M4B'), 'de');
  assert.strictEqual(audiobookLanguage('Le Petit Prince - French VF - VOSTFR'), 'fr');
  assert.strictEqual(audiobookLanguage('Libro - ESP - Castellano'), 'es');
  assert.strictEqual(audiobookLanguage('Dune - Frank Herbert [M4B] Unabridged'), '');
  // English titles that CONTAIN language words must NOT be flagged foreign.
  assert.strictEqual(audiobookLanguage('The Italian Job - Michael Caine [M4B]'), '');
  assert.strictEqual(audiobookLanguage('A German Requiem - Philip Kerr'), '');
  assert.strictEqual(audiobookLanguage('The French Chef - Julia Child'), '');
});
test('audiobook: an English edition outranks a German one (Becoming bug)', () => {
  const ranked = rankAudiobooks([
    { name: 'Michelle Obama-Becoming-2MP3CD-DE-2018-FKKAuDiOBooK', sizeBytes: 3e8 },
    { name: 'Michelle Obama - Becoming (Unabr - 64k [2018])', sizeBytes: 3e8 },
  ]);
  assert.ok(ranked[0].name.includes('Unabr'), 'English edition ranks first');
  assert.ok(ranked.find((r) => /DE-2018/.test(r.name)).score <= -1000, 'German edition heavily demoted');
});

// ---------- searchAudiobook: fan-out + category + verification + ranking ----------
test('audiobook: searchAudiobook queries cat 3030, verifies titles, ranks best first', async () => {
  let seenCat = null;
  const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) =>
    `<item><title>${i.name}</title><enclosure url="${i.url}" length="${i.size}"/></item>`).join('')}</channel></rss>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    seenCat = u.searchParams.get('cat');
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rss([
      { name: 'Brandon Sanderson - Mistborn The Final Empire [M4B] Unabridged', url: 'http://x/a.nzb', size: 400e6 },
      { name: 'Mistborn The Final Empire - Brandon Sanderson MP3 64kbps', url: 'http://x/b.nzb', size: 380e6 },
      { name: 'Completely Different Book - Someone Else [M4B]', url: 'http://x/c.nzb', size: 300e6 },
    ]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const store = tmpStore();
  try {
    const pipeline = new Pipeline({
      pool: () => null,
      verdicts: new VerdictCache(store),
      mounts: new Map(),
      indexers: () => [{ name: 'ix', url: `http://127.0.0.1:${srv.address().port}`, apikey: 'k' }],
    });
    const { candidates } = await pipeline.searchAudiobook({ title: 'Mistborn: The Final Empire', author: 'Brandon Sanderson' });
    assert.strictEqual(seenCat, '3030', 'searched the Audio>Audiobook category');
    assert.strictEqual(candidates.length, 2, 'the unrelated book was filtered out by the verifier');
    assert.ok(candidates[0].name.includes('M4B'), 'M4B ranked first');
    assert.ok(candidates.every((c) => c.pickKey), 'candidates carry a pickKey for the Sources drawer');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('audiobook: searchAudiobook falls back to a no-category query when 3030 is empty', async () => {
  // Simulates an indexer that DOESN'T tag audiobooks under 3030: it returns the book only when the
  // category filter is absent. The fallback strategy must still find + verify it.
  const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) =>
    `<item><title>${i.name}</title><enclosure url="${i.url}" length="${i.size}"/></item>`).join('')}</channel></rss>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const hasCat = u.searchParams.has('cat');
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rss(hasCat ? [] : [
      { name: 'Andy Weir - Project Hail Mary [M4B] Unabridged', url: 'http://x/p.nzb', size: 500e6 },
    ]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const store = tmpStore();
  try {
    const pipeline = new Pipeline({
      pool: () => null, verdicts: new VerdictCache(store), mounts: new Map(),
      indexers: () => [{ name: 'ix', url: `http://127.0.0.1:${srv.address().port}`, apikey: 'k' }],
    });
    const { candidates } = await pipeline.searchAudiobook({ title: 'Project Hail Mary', author: 'Andy Weir' });
    assert.strictEqual(candidates.length, 1, 'the no-category fallback found the miscategorized audiobook');
    assert.ok(candidates[0].name.includes('Project Hail Mary'));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

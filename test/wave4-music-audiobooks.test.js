'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { scoreAudiobook, rankAudiobooks } = require('../server/scoring');
const { Pipeline, parseWantedBook, bookMatches } = require('../server/pipeline');
const { Store, VerdictCache } = require('../server/store');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('wave4: scoreAudiobook honors health verdicts and disqualifies 7z/iso containers', () => {
  const ranked = rankAudiobooks([
    { name: 'Author - Book [M4B] Unabridged', sizeBytes: 400e6, health: 'missing' },
    { name: 'Author - Book [M4B] Unabridged.7z', sizeBytes: 400e6 },
    { name: 'Author - Book Unabridged MP3 64kbps', sizeBytes: 380e6, health: 'verified' },
    { name: 'Author - Book [M4B] Unabridged', sizeBytes: 400e6, health: 'playback-failed' },
  ]);
  assert.ok(ranked[0].name.includes('MP3 64kbps'), `healthy MP3 must beat dead/7z/failed M4Bs (got ${ranked[0].name})`);
  assert.ok(ranked.find((r) => r.health === 'missing').score < -5000, 'missing verdict disqualifies audiobook');
  assert.ok(ranked.find((r) => r.name.endsWith('.7z')).score < -5000, '7z container disqualifies audiobook');
  assert.ok(ranked.find((r) => r.health === 'playback-failed').score < ranked[0].score, 'playback-failed demotes audiobook');
});

test('wave4: bookMatches folds diacritics, handles Audible subtitles, and requires surname (not first name)', () => {
  // Diacritics
  const lesMis = parseWantedBook('Les Misérables', 'Victor Hugo');
  assert.ok(bookMatches('Victor Hugo - Les Miserables [M4B] Unabridged', lesMis), 'diacritics fold cleanly');

  // Audible subtitle stripped fallback
  const phm = parseWantedBook('Project Hail Mary: A Novel (Unabridged)', 'Andy Weir');
  assert.ok(bookMatches('Andy Weir - Project Hail Mary [M4B]', phm), 'Audible subtitle does not block clean Usenet release');

  // Surname required — first name alone ("John") must not match another author
  const grisham = parseWantedBook('The Firm', 'John Grisham');
  assert.ok(bookMatches('The Firm - Grisham [M4B]', grisham), 'surname matches');
  assert.ok(!bookMatches('The Firm - John Smith [M4B]', grisham), 'different author sharing first name rejected');
});

test('wave4: searchAudiobook does not early-break when strategy 1 only finds an ebook', async () => {
  const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) =>
    `<item><title>${i.name}</title><enclosure url="${i.url}" length="${i.size}"/></item>`).join('')}</channel></rss>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const cat = u.searchParams.get('cat');
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    if (cat === '3030') {
      return res.end(rss([{ name: 'Andy Weir - Project Hail Mary EPUB', url: 'http://x/eb.nzb', size: 3e6 }]));
    }
    return res.end(rss([{ name: 'Andy Weir - Project Hail Mary [M4B] Unabridged', url: 'http://x/ab.nzb', size: 420e6 }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-w4-'));
  try {
    const pipeline = new Pipeline({
      pool: () => null,
      verdicts: new VerdictCache(new Store(dir)),
      mounts: new Map(),
      indexers: () => [{ name: 'ix', url: `http://127.0.0.1:${srv.address().port}`, apikey: 'k' }],
    });
    const { candidates } = await pipeline.searchAudiobook({ title: 'Project Hail Mary', author: 'Andy Weir' });
    assert.ok(candidates.some((c) => c.name.includes('[M4B]') && c.score > 0), 'continued past ebook-only cat 3030 hit to find playable M4B');
  } finally {
    await new Promise((r) => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wave4: playAudiobook marks session.audiobook so advance() preserves audiobook: true', async () => {
  const pipeline = new Pipeline({
    pool: () => null,
    verdicts: { get: () => null, set: () => {} },
    mounts: new Map(),
  });
  let seenAdvanceOpts = [];
  pipeline.searchAudiobook = async () => ({
    candidates: [
      { name: 'Author - Book [M4B] A', pickKey: 'a', score: 100, nzbUrl: 'http://x/a.nzb' },
      { name: 'Author - Book [M4B] B', pickKey: 'b', score: 90, nzbUrl: 'http://x/b.nzb' },
    ],
    errors: [],
  });
  pipeline._advance = async (session, opts) => {
    seenAdvanceOpts.push({ audiobook: !!opts.audiobook, sid: session.id });
    return { session, vf: { id: 'm1', streamable: true }, candidate: session.candidates[0], attempts: [] };
  };
  const first = await pipeline.playAudiobook({ title: 'Book', author: 'Author' });
  assert.equal(first.session.audiobook, true, 'PlaySession persists audiobook flag');
  await pipeline.advance(first.session.id, {});
  assert.equal(seenAdvanceOpts.length, 2);
  assert.equal(seenAdvanceOpts[1].audiobook, true, 'advance() preserves audiobook: true');
});

test('wave4 audit: ytmusic ytArgs pins IPv4, enables Node JS runtime on 2026+ yt-dlp, and server/client guard 302/HLS/pubaudio CSP', () => {
  const ytSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'ytmusic.js'), 'utf8');
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

  assert.match(ytSrc, /--force-ipv4/, 'yt-dlp pins IPv4 to match Node proxy family:4');
  assert.match(ytSrc, /--js-runtimes', 'node'/, 'yt-dlp 2025.11+ enables Node JS runtime');
  assert.match(ytSrc, /protocol!\*=m3u8/, 'music format selector prefers progressive HTTP audio over HLS');
  assert.match(srvSrc, /\[301, 302, 303, 307, 308\]\.includes\(up\.statusCode\)/, 'proxyResolvedYoutube follows 302 redirects instead of emitting 0-byte 200');
  assert.match(srvSrc, /family: 4/, 'proxyResolvedYoutube pins IPv4');
  assert.match(srvSrc, /\/api\/pubaudio\/stream\?u=/, 'pubaudioTracks rewrites external archive.org URLs to same-origin proxy');
  assert.match(srvSrc, /api\\\/music\\\/token\\\/|musicToken:\s*async/, 'music token refresh route is registered');
  assert.match(webSrc, /id="pinPad"/, 'PIN gate includes touch & D-pad 0-9 keypad');
  assert.match(webSrc, /openGate === \$\('gatePin'\) && \$\('pinPad'\)/, 'PIN keypad supports 2D 3-column TV D-pad navigation');
  assert.match(webSrc, /id="gateOnboard"/, 'First-run host onboarding checklist is present');
  assert.match(webSrc, /function focusHostOnboardingStep\(\)/, 'Host onboarding focuses active step for TV D-pad');
  assert.match(webSrc, /function renderScoringManager\(restoreFocus = null\)/, 'Scoring manager preserves TV D-pad focus when toggling rules or removing chips');
  assert.match(webSrc, /id="pgCloseBtn"/, 'In-player Live TV guide includes Close button');
  assert.match(webSrc, /id="pgSearch"/, 'In-player Live TV guide includes channel filter input');
});

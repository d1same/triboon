'use strict';
// Phase 2 golden corpus: TRaSH-style scoring, newznab fan-out, and the press-play pipeline
// with verdict cache + auto-advance. Mock indexer (newznab RSS over http) + mock NNTP.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseRelease, scoreRelease, rankReleases } = require('../server/scoring');
const { parseNewznabRss, dedupe, fanout, searchIndexer } = require('../server/newznab');
const { Store, VerdictCache } = require('../server/store');
const { Pipeline, GATE_MS, nzbVerdictKey, summarizeAttempts, stubFeatureReason } = require('../server/pipeline');
const { NntpPool, ProviderPool } = require('../server/nntp');
const { createMockNntp } = require('./mock-nntp');
const { encodePart } = require('../server/yenc');
const { seededPayload, writeRar4Store } = require('./archive-fixtures');

// ---------- scoring ----------
test('scoring: parses release attributes', () => {
  const a = parseRelease('Movie.2024.2160p.WEB-DL.DV.HDR10Plus.DDP5.1.Atmos.H.265-FLUX');
  assert.strictEqual(a.resolution, '2160p');
  assert.strictEqual(a.source, 'web-dl');
  assert.strictEqual(a.codec, 'hevc');
  assert.ok(a.features.includes('dovi') && a.features.includes('atmos'));
  assert.strictEqual(a.group, 'FLUX');
  assert.strictEqual(a.groupClass, 'trusted');
});

test('scoring: source tiers, group tiers, and junk penalties order sanely', () => {
  const ranked = rankReleases([
    { name: 'Movie.2024.1080p.WEBRip.x264-GalaxyRG', sizeBytes: 2e9 },
    { name: 'Movie.2024.1080p.BluRay.x264.DTS-FGT', sizeBytes: 9e9 },
    { name: 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', sizeBytes: 6e9 },
    { name: 'Movie.2024.HDCAM.x264-QFX', sizeBytes: 2e9 },
    { name: 'Movie.2024.1080p.BluRay.x265-YTS', sizeBytes: 1.4e9 },
  ]);
  const names = ranked.map((r) => r.name);
  assert.ok(names.indexOf('Movie.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX') < 2, 'trusted WEB-DL near top');
  assert.ok(names[names.length - 1].includes('HDCAM'), 'cam dead last');
  assert.ok(names.indexOf('Movie.2024.1080p.BluRay.x265-YTS') > names.indexOf('Movie.2024.1080p.BluRay.x264.DTS-FGT'),
    'LQ re-encode group below proper BluRay');
  assert.ok(ranked[0].reasons.length > 0, 'reasons are reported for transparency');
});

test('scoring: unknown resolution is neutral — not rejected for an SD-capped user, not boosted', () => {
  // A release with no resolution token must not be over-cap-penalized for a 480p user…
  const sd = rankReleases([
    { name: 'Old.Movie.1968.BluRay.x264-GRP', sizeBytes: 2e9 },          // unknown res
    { name: 'Old.Movie.1968.480p.DVDRip.x264-GRP', sizeBytes: 1e9 },     // known 480p
  ], { maxResolutionRank: 0 });
  assert.ok(sd.every((r) => r.score > -5000), 'no candidate disqualified by unknown resolution');
  // …and unknown must not outrank a known higher resolution purely from a phantom 720p default.
  const hd = rankReleases([
    { name: 'Show.S01E01.WEB-DL.H.264-NTb', sizeBytes: 3e9 },            // unknown res
    { name: 'Show.S01E01.1080p.WEB-DL.H.264-NTb', sizeBytes: 3e9 },      // known 1080p
  ], { maxResolutionRank: 4 });
  assert.ok(hd[0].name.includes('1080p'), 'known 1080p beats unknown-resolution sibling');
});

test('scoring: per-user cap — a 1080p-capped user never gets a 2160p pick', () => {
  const ranked = rankReleases([
    { name: 'Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-FraMeSToR', sizeBytes: 60e9 },
    { name: 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-NTb', sizeBytes: 7e9 },
  ], { maxResolutionRank: 3 });
  assert.ok(ranked[0].name.includes('1080p'), 'source-fit beats transcoding');
  assert.ok(ranked[1].score < -5000, 'over-cap source is disqualified, not merely demoted');
});

test('scoring: explicit 1080p/4K picks choose the matching source class', () => {
  const releases = [
    { name: 'Movie.2024.2160p.WEB-DL.DDP5.1.HEVC-FLUX', sizeBytes: 30e9 },
    { name: 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-NTb', sizeBytes: 7e9 },
  ];
  // Press-play default: the lean 1080p WEB-DL wins (size shaping)…
  const auto = rankReleases(releases.map((r) => ({ ...r })), { maxResolutionRank: 4 });
  assert.ok(auto[0].name.includes('1080p'), 'default auto-pick favors the lean 1080p');
  // Explicit 1080p is a cap AND a preference: 4K must not win and then transcode.
  const hd = rankReleases(releases.map((r) => ({ ...r })), { maxResolutionRank: 3, preferResolutionRank: 3 });
  assert.ok(hd[0].name.includes('1080p'), '1080p selection leads with a 1080p source');
  assert.ok(hd[1].score < -5000, '1080p selection rejects 2160p sources');
  // …but the user explicitly tapping the 4K toggle must put 2160p first, 1080p as fallback.
  const picked = rankReleases(releases.map((r) => ({ ...r })), { maxResolutionRank: 4, preferResolutionRank: 4, exactResolutionRank: 4 });
  assert.ok(picked[0].name.includes('2160p'), '4K leads when explicitly selected');
  assert.ok(picked[1].score < -5000, '4K selection rejects 1080p fallback sources');
  // The preference NEVER overrides the cap — a 1080p-capped user asking for 4K still gets 1080p.
  const capped = rankReleases(releases.map((r) => ({ ...r })), { maxResolutionRank: 3, preferResolutionRank: 4 });
  assert.ok(capped[0].name.includes('1080p'), 'cap still wins over preference');
});

test('scoring: Atmos/TrueHD remuxes are preferred only for capable passthrough devices', () => {
  const releases = [
    { name: 'Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos.HEVC-FraMeSToR', sizeBytes: 20e9 },
    { name: 'Movie.2024.2160p.WEB-DL.DDP5.1.Atmos.HEVC-FLUX', sizeBytes: 15e9 },
  ];
  const plain = rankReleases(releases.map((r) => ({ ...r })), { maxResolutionRank: 4 });
  assert.ok(plain[0].name.includes('WEB-DL'), 'without passthrough, the safer DDP WEB-DL wins');
  const capable = rankReleases(releases.map((r) => ({ ...r })), {
    maxResolutionRank: 4,
    audioPassthrough: true,
    audioTrueHd: true,
  });
  assert.ok(capable[0].name.includes('REMUX.TrueHD.Atmos'), 'TrueHD passthrough devices can prefer the lossless Atmos remux');
  const budget = rankReleases(releases.map((r) => ({ ...r })), {
    maxResolutionRank: 4,
    lowPowerDevice: true,
    audioPassthrough: true,
    audioTrueHd: true,
  });
  assert.ok(budget[0].name.includes('WEB-DL'), 'budget devices stay conservative even if a broad passthrough flag appears');
});

test('scoring: soundtracks, bonus discs and bare audio rips are disqualified outright', () => {
  // Both top names are the REAL releases that bit users: the soundtrack album auto-played
  // for a film with no video releases yet, and the bonus disc outranked the actual movie.
  const ranked = rankReleases([
    { name: 'John Williams - Disclosure Day (Original Motion Picture Soundtrack) FLAC 24bit', sizeBytes: 0.9e9 },
    { name: 'Inception 2010 Special Features 1080p BluRay REMUX DD 2.0 AVC-d3g', sizeBytes: 12e9 },
    { name: 'Movie.2024.Discography.MP3.320kbps', sizeBytes: 0.4e9 },
    { name: 'Inception.2010.1080p.BluRay.x264.DTS-FGT', sizeBytes: 9e9 },
    { name: 'Movie.2024.2160p.BluRay.REMUX.FLAC.7.1.x265-GROUP', sizeBytes: 14e9 }, // FLAC *audio track* in a real movie
  ], { maxResolutionRank: 4 });
  assert.ok(!/soundtrack|special features|discography/i.test(ranked[0].name), 'a real movie wins');
  for (const c of ranked) {
    const isJunk = /soundtrack|special features|discography/i.test(c.name);
    if (isJunk) assert.ok(c.score < -5000, `${c.name} below the playability cutoff (got ${c.score})`);
    else assert.ok(c.score > -5000, `${c.name} stays playable (got ${c.score})`);
  }
  const { notTheMovie } = require('../server/scoring');
  assert.strictEqual(notTheMovie('Movie.2160p.REMUX.FLAC.7.1.x265-G'), null, 'FLAC audio in a remux is fine');
  assert.strictEqual(notTheMovie('Artist - Album (2024) FLAC'), 'audio-only');
  assert.strictEqual(notTheMovie('Show.S01.Extras.Only.720p.WEB'), 'extras-disc');
});

test('title verification: short titles match only releases that ARE that title', () => {
  // Real incident: pressing Play on "From" S01E01 streamed "Stranger Things Tales From 85"
  // — the old check accepted the title words ANYWHERE in the name, so every one-word title
  // ("From", "It", "Angel") matched countless other releases, and quality ranking then put
  // a 2160p Atmos wrong-show above the real 1080p one. All names below are real indexer hits.
  const { parseWantedTitle, releaseMatches } = require('../server/pipeline');
  const from = parseWantedTitle('from s01e01');
  for (const good of [
    'FROM.S01E01.Long.Days.Journey.Into.Night.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX',
    'From.2022.S01E01.2160p.MGMP.WEB-DL.H.265.AAC-UBWEB',
    'FROM S01E01 Long Days Journey Into Night 1080p AMZN WEB-DL DDP5 1 H 264-FLUX',
  ]) assert.ok(releaseMatches(good, from), `accepts ${good}`);
  for (const bad of [
    'Stranger.Things.Tales.From.85.S01E01.Chapter.One.2160p.WEBRip.DDP.5.1.Atmos.DV.HDR10.x265-MarkIII',
    'Colin.from.Accounts.S01E01.1080p.DUAL.TV+.WEB-DL.x264.AAC-HdT',          // anchored: title ≠ first token
    'Splinter.Cell.Deathwatch.S01E01.Up.From.the.Grave.720p.WEBRip.x265-V3',  // "from" mid-episode-title
    'From.Dusk.Till.Dawn.S01E01.1080p.WEB-DL.DD5.1.H.264-NTb',                // boundary: plain word after title
    'From.Hong.Kong.to.Beijing.2023.S01E01.1080p.WEB-DL.H.264-UBWEB',
  ]) assert.ok(!releaseMatches(bad, from), `rejects ${bad}`);

  // The year disambiguates one-word movie titles ("It").
  const it = parseWantedTitle('it 2017');
  assert.ok(releaseMatches('It.2017.1080p.BluRay.REMUX.AVC.DTS-HD.MA.TrueHD.7.1.Atmos-FGT', it));
  assert.ok(!releaseMatches('It.Chapter.Two.2019.2160p.UHD.BluRay.x265-TERMiNAL', it), 'sequel: wrong year + plain word after title');
  assert.ok(!releaseMatches('Power.Rangers.2017.2160p.UHD.BDRip.HEVC-MUSHR00M', it), 'same year, different film');

  // Spin-off trap: the structural-boundary rule keeps longer-titled shows out.
  const twd = parseWantedTitle('the walking dead s01e01');
  assert.ok(releaseMatches('The.Walking.Dead.S01E01.Days.Gone.Bye.2010.BluRay.1080p.AVC.TrueHD.5.1.REMUX-FraMeSToR', twd));
  for (const spin of [
    'The.Walking.Dead.Daryl.Dixon.S01E01.Lame.Perdue.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRiMM',
    'The.Walking.Dead.Dead.City.S01E01.2023.1080p.NF.WEB-DL.DDP5.1.H.264-HDSWEB',
    'Tales.of.the.Walking.Dead.S01E01.Evie.Joe.1080p.AMZN.WEB-DL.DDP5.1.H.265-GRiMM',
  ]) assert.ok(!releaseMatches(spin, twd), `rejects spin-off ${spin}`);

  // Long titles still tolerate the regional word swap (and apostrophes vanish).
  const hp = parseWantedTitle('harry potter and the sorcerers stone 2001');
  assert.ok(releaseMatches('Harry.Potter.and.the.Sorcerers.Stone.2001.UHD.BluRay.2160p.DDP.7.1.DV.HDR.x265-BHDStudio', hp));
  assert.ok(releaseMatches("Harry.Potter.and.the.Philosopher's.Stone.2001.1080p.BluRay.DTS.x264-ESiR", hp), 'one-word substitution allowed');

  // Long franchise titles must not fuzzily slide into a sibling movie.
  const fellowship = parseWantedTitle('the lord of the rings the fellowship of the ring 2001');
  const fellowshipNoYear = parseWantedTitle('the lord of the rings the fellowship of the ring');
  for (const wanted of [fellowship, fellowshipNoYear]) {
    assert.ok(releaseMatches('The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.EXTENDED.1080p.BluRay.x264-CtrlHD', wanted),
      'accepts the exact Fellowship release');
    assert.ok(releaseMatches('Lord.of.the.Rings.Fellowship.of.the.Ring.2001.1080p.BluRay.x265-GROUP', wanted),
      'accepts harmless missing articles in release names');
    for (const wrong of [
      'The.Lord.of.the.Rings.The.Two.Towers.2002.EXTENDED.1080p.BluRay.x264-CtrlHD',
      'The.Lord.of.the.Rings.The.Return.of.the.King.2003.EXTENDED.1080p.BluRay.x264-CtrlHD',
      'The.Lord.of.the.Rings.The.Rings.of.Power.S01E01.1080p.WEB-DL.x264-GROUP',
    ]) assert.ok(!releaseMatches(wrong, wanted), `rejects sibling LOTR title ${wrong}`);
  }
});

test('scoring: admin custom formats — group tiers override built-ins, keywords add their score', () => {
  const releases = [
    { name: 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', sizeBytes: 6e9 },
    { name: 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-NOBODY', sizeBytes: 6e9 },
  ];
  // Default (recommended): built-in trusted FLUX outranks the unknown group.
  const def = rankReleases(releases.map((r) => ({ ...r })), {});
  assert.ok(def[0].name.endsWith('-FLUX'), 'built-in tiers apply when no custom scoring is set');
  // Admin demotes FLUX and trusts NOBODY → the tier is REPLACED (override), not stacked.
  const flipped = rankReleases(releases.map((r) => ({ ...r })),
    { customScoring: { groupsTrusted: ['nobody'], groupsAvoid: ['flux'] } });
  assert.ok(flipped[0].name.endsWith('-NOBODY'), 'admin group tiers override the built-ins');
  const flux = flipped.find((c) => c.name.endsWith('-FLUX'));
  assert.ok(flux.reasons.some((r) => r.includes('avoid·admin') && r.includes('-50')),
    'override replaces the built-in +50 with -50, never both');
  // Keywords: word-boundary match; spaces in the term match scene separators (dot/dash/_).
  const kw = rankReleases(releases.map((r) => ({ ...r })),
    { customScoring: { keywords: [{ term: 'DDP5 1', score: 120 }, { term: 'XYZNOPE', score: 500 }] } });
  assert.ok(kw[0].reasons.some((r) => r.includes('custom:DDP5 1 +120')), 'keyword matched across dots');
  assert.ok(kw.every((c) => !c.reasons.some((r) => r.includes('XYZNOPE'))), 'non-matching keyword adds nothing');
});

test('scoring: hard size caps — over-cap releases are disqualified, not just deranked', () => {
  const releases = [
    { name: 'Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD-FraMeSToR', sizeBytes: 58e9 },
    { name: 'Movie.2024.2160p.WEB-DL.DDP5.1.HEVC-FLUX', sizeBytes: 14e9 },
    { name: 'Movie.2024.1080p.BluRay.REMUX.AVC.DTS-HD-EbP', sizeBytes: 28e9 },
    { name: 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-NTb', sizeBytes: 7e9 },
    { name: 'Movie.2024.WEB-DL.H.264-GRP', sizeBytes: 30e9 }, // unknown res, monster size
  ];
  const capped = rankReleases(releases.map((r) => ({ ...r })), { maxSizeGb4k: 30, maxSizeGb1080: 20 });
  const dead = capped.filter((c) => c.score < -50000).map((c) => c.name);
  assert.ok(dead.some((n) => n.includes('UHD.BluRay.REMUX')), '58GB 4K remux over the 30GB 4K cap');
  assert.ok(dead.some((n) => n.includes('1080p.BluRay.REMUX')), '28GB 1080p remux over the 20GB HD cap');
  assert.ok(dead.some((n) => !/2160p|1080p/.test(n)), 'unknown-res 30GB falls under the HD cap (could be anything)');
  assert.ok(capped.find((c) => c.name.includes('2160p.WEB-DL')).score > -5000, '14GB 4K WEB-DL survives');
  assert.ok(capped.find((c) => c.name.includes('1080p.WEB-DL')).score > -5000, '7GB 1080p WEB-DL survives');
  // No caps configured → nothing disqualified by size (only the soft shaping applies).
  const open = rankReleases(releases.map((r) => ({ ...r })), {});
  assert.ok(open.every((c) => c.score > -50000), 'without caps no release is size-disqualified');
});

test('scoring: press-play size shaping — sane-size 4K beats a 60GB remux even uncapped', () => {
  const ranked = rankReleases([
    { name: 'Movie.2024.UHD.BluRay.2160p.FLAC.HEVC.REMUX-FraMeSToR', sizeBytes: 60e9 },
    { name: 'Movie.2024.2160p.WEB-DL.DDP5.1.HEVC-FLUX', sizeBytes: 18e9 },
  ], { maxResolutionRank: 4 });
  assert.ok(ranked[0].name.includes('WEB-DL'), 'time-to-first-frame beats archival quality by default');
  // …but the remux is demoted, not disqualified: still offered in the Sources drawer.
  assert.ok(ranked[1].score > -5000, 'remux remains pickable');
});

test('scoring: Onn-class Android TV prefers lighter 4K WEB sources over huge remuxes', () => {
  const ranked = rankReleases([
    { name: 'Movie.2024.2160p.UHD.BluRay.REMUX.TrueHD.Atmos-FraMeSToR', sizeBytes: 62e9 },
    { name: 'Movie.2024.2160p.WEB-DL.DDP5.1.HEVC-FLUX', sizeBytes: 16e9 },
    { name: 'Movie.2024.2160p.WEBRip.HEVC-GRP', sizeBytes: 8e9 },
  ], {
    maxResolutionRank: 4, preferResolutionRank: 4, exactResolutionRank: 4,
    lowPowerDevice: true, sizePreferenceGB: 10, dolbyVision: false,
  });
  assert.ok(ranked[0].name.includes('WEB-DL'), 'budget Android TV should avoid 4K remux as the default pick');
  assert.ok(ranked.find((r) => r.name.includes('REMUX')), 'heavy remux remains available in ranked sources');
});

test('scoring: budget Android TV defaults to safer 1080p AVC when available', () => {
  const ranked = rankReleases([
    { name: 'Movie.2024.1080p.BluRay.HEVC-LEGi0N', sizeBytes: 5e9 },
    { name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', sizeBytes: 7e9 },
    { name: 'Movie.2024.1080p.WEB-DL.AV1-GRP', sizeBytes: 4e9 },
  ], {
    maxResolutionRank: 3,
    preferResolutionRank: 3,
    lowPowerDevice: true,
  });
  assert.ok(ranked[0].name.includes('H.264-NTb'), 'low-power Android should auto-pick the AVC source first');
  assert.ok(ranked.find((r) => r.name.includes('HEVC-LEGi0N')).score > -5000, 'HEVC remains available as a fallback/manual source');
  assert.ok(ranked[0].reasons.some((r) => r.includes('device-safe-avc')),
    'the compatibility preference is visible in scoring reasons');
});

test('scoring: streamability and health verdicts shape the order (Triboon edge)', () => {
  const ranked = rankReleases([
    { name: 'Movie.2024.1080p.BluRay.x264-FGT', sizeBytes: 9e9, streamClass: 'compressed' },
    { name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', sizeBytes: 7e9, streamClass: 'store', health: 'verified' },
    { name: 'Movie.2024.1080p.BluRay.x264-SPARKS', sizeBytes: 9e9, health: 'blocked' },
  ]);
  assert.ok(ranked[0].name.includes('NTb'), 'verified store release wins');
  assert.ok(ranked[0].score - ranked[1].score > 200, '🐢 compressed clearly demoted');
  assert.ok(ranked[2].score < -5000, 'blocked release is disqualified, not just demoted');
});

// ---------- newznab ----------
function rssFor(items) {
  return `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>
${items.map((i) => `<item><title>${i.name}</title><link>${i.url}</link>
<enclosure url="${i.url}" length="${i.size}" type="application/x-nzb"/>
<newznab:attr name="size" value="${i.size}"/></item>`).join('\n')}
</channel></rss>`;
}

test('newznab: decodes XML entities in titles and urls (dedupe keys stay clean)', () => {
  const xml = rssFor([{ name: 'Tom &amp; Jerry 2024 1080p WEB-DL', url: 'http://x/a?b=1&amp;c=2', size: 4e9 }]);
  const parsed = parseNewznabRss(xml, 'ix');
  assert.strictEqual(parsed[0].name, 'Tom & Jerry 2024 1080p WEB-DL');
  assert.strictEqual(parsed[0].nzbUrl, 'http://x/a?b=1&c=2');
});

test('newznab: TV episodes use tvsearch even when an IMDb id is also present', async () => {
  let seen;
  const srv = http.createServer((req, res) => {
    seen = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rssFor([{ name: 'House.S03E22.1080p.WEB-DL.H.264-NTb', url: 'http://x/house.nzb', size: 2e9 }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const rows = await searchIndexer(
      { name: 'ix', url: `http://127.0.0.1:${srv.address().port}`, apikey: 'secret' },
      { q: 'House S03E22', imdbid: 'tt0412142', tvdbid: '73255', season: 3, ep: 22 },
      { timeoutMs: 1000 }
    );
    assert.strictEqual(seen.searchParams.get('t'), 'tvsearch');
    assert.strictEqual(seen.searchParams.get('tvdbid'), '73255');
    assert.strictEqual(seen.searchParams.get('season'), '3');
    assert.strictEqual(seen.searchParams.get('ep'), '22');
    assert.strictEqual(seen.searchParams.has('imdbid'), false, 'IMDb must not force movie search for an episode');
    assert.strictEqual(rows[0].name, 'House.S03E22.1080p.WEB-DL.H.264-NTb');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('opensubs: SRT→VTT conversion + search-query parsing', () => {
  const { srtToVtt, shiftVtt, parseQuery } = require('../server/opensubs');
  const vtt = srtToVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n');
  assert.ok(vtt.startsWith('WEBVTT\n'), 'VTT header prepended');
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500/, 'comma timestamps become dots');
  assert.ok(!vtt.includes('\r'), 'CRLF normalized');
  assert.strictEqual(srtToVtt('WEBVTT\n\nalready vtt'), 'WEBVTT\n\nalready vtt', 'VTT passes through');
  assert.match(shiftVtt(vtt, 0.5), /00:00:01\.500 --> 00:00:03\.000/, 'positive shift moves cues later');
  assert.match(shiftVtt(vtt, -2), /00:00:00\.000 --> 00:00:00\.500/, 'negative shift clamps cue starts at zero');
  assert.deepStrictEqual(parseQuery('The Boys S01E02'), { title: 'The Boys', season: 1, ep: 2, year: null });
  assert.deepStrictEqual(parseQuery('Movie Name 2024'), { title: 'Movie Name', season: null, ep: null, year: 2024 });
});

test('subs: Wyzie file download is authenticated without leaking keys to unrelated hosts', async () => {
  const { downloadSubtitle, _subtitleDownloadUrl } = require('../server/opensubs');
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    seen.push({ path: u.pathname, headerKey: req.headers['api-key'], queryKey: u.searchParams.get('key') });
    if (u.pathname === '/c/mock/id/1') {
      if (u.searchParams.get('key') !== 'test-key') {
        res.writeHead(401);
        return res.end('missing key on Wyzie file route');
      }
      res.writeHead(302, { location: '/file.srt?format=srt' });
      return res.end();
    }
    if (u.pathname !== '/file.srt' || u.searchParams.get('key') !== 'test-key') {
      res.writeHead(401);
      return res.end('missing query key');
    }
    res.writeHead(200);
    return res.end('1\r\n00:00:01,000 --> 00:00:02,500\r\nAuthenticated\r\n');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const vtt = await downloadSubtitle({ url: `${base}/c/mock/id/1?format=srt`, format: 'srt' }, { key: 'test-key', base });
    assert.ok(vtt.startsWith('WEBVTT'), 'downloaded subtitle converts to WebVTT');
    assert.match(vtt, /Authenticated/);
    assert.ok(seen.some((h) => h.path === '/file.srt' && h.queryKey === 'test-key'),
      'subtitle file redirects keep the Wyzie query key on the next same-host request');
    assert.strictEqual(_subtitleDownloadUrl('http://cdn.example/sub.srt', { key: 'secret', base }),
      'http://cdn.example/sub.srt', 'keys are not appended to unrelated subtitle hosts');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('subs: non-UTF-8 subtitle bodies are decoded by language (no mojibake)', async () => {
  const { decodeSubtitleBuffer, downloadSubtitle } = require('../server/opensubs');
  // Unit: windows-1256 Arabic + windows-1251 Cyrillic decode correctly; ASCII/UTF-8 pass through; BOM stripped.
  const arBytes = Buffer.from([0xC7, 0xE1, 0xD3, 0xE1, 0xC7, 0xE5]);
  const ar = decodeSubtitleBuffer(arBytes, 'ar');
  assert.ok(!ar.includes('�'), 'Arabic windows-1256 decodes without replacement chars');
  assert.strictEqual(ar, 'السلاه', 'Arabic windows-1256 maps to the right code points');
  assert.strictEqual(decodeSubtitleBuffer(Buffer.from([0xCF, 0xF0, 0xE8]), 'ru'), 'При', 'Cyrillic windows-1251 decodes correctly');
  assert.strictEqual(decodeSubtitleBuffer(Buffer.from('Hello', 'utf8'), 'en'), 'Hello', 'ASCII unchanged');
  assert.strictEqual(decodeSubtitleBuffer(Buffer.from('café', 'utf8'), 'fr'), 'café', 'valid UTF-8 preserved untouched');
  assert.strictEqual(decodeSubtitleBuffer(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('WEBVTT', 'utf8')]), 'en'), 'WEBVTT', 'UTF-8 BOM stripped');

  // Integration: a Wyzie download of a windows-1256 SRT keeps the Arabic glyphs in the VTT.
  const srt = Buffer.concat([Buffer.from('1\r\n00:00:01,000 --> 00:00:02,500\r\n', 'latin1'), arBytes, Buffer.from('\r\n', 'latin1')]);
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end(srt); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const vtt = await downloadSubtitle({ url: `${base}/x.srt`, format: 'srt', language: 'ar' }, { base });
    assert.ok(vtt.startsWith('WEBVTT'), 'still converts to WebVTT');
    assert.ok(!vtt.includes('�'), 'no mojibake in the served subtitle');
    assert.ok(vtt.includes('السلاه'), 'Arabic text survives the charset decode');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('subs: ranking respects forced + SDH preference; declared encoding honored', () => {
  const { rankSubs, decodeSubtitleBuffer } = require('../server/opensubs');
  // Forced / foreign-parts-only never auto-picks over a full sub of the same release — even with far more downloads.
  const fdata = [
    { id: 'full', url: 'u1', format: 'srt', display: 'Show.S01E01.1080p.WEB-DL-GRP', language: 'en', downloadCount: 5 },
    { id: 'forced', url: 'u2', format: 'srt', display: 'Show.S01E01.1080p.WEB-DL-GRP.forced', language: 'en', downloadCount: 9000 },
  ];
  const fr = rankSubs(fdata, 'Show.S01E01.1080p.WEB-DL-GRP', {});
  assert.strictEqual(fr[0].id, 'full', 'a full sub outranks a forced one even with far more downloads');
  assert.strictEqual(fr.find((v) => v.id === 'forced').forced, true, 'forced subs are flagged for the menu');

  // SDH preference: avoid -> dialogue-only wins; prefer -> SDH wins; both stay listed either way.
  const sdata = [
    { id: 'plain', url: 'p', format: 'srt', display: 'Movie.2020.1080p.BluRay-X', language: 'en', isHearingImpaired: false },
    { id: 'sdh', url: 's', format: 'srt', display: 'Movie.2020.1080p.BluRay-X', language: 'en', isHearingImpaired: true, downloadCount: 5000 },
  ];
  assert.strictEqual(rankSubs(sdata, 'Movie.2020.1080p.BluRay-X', { sdhPref: 'avoid' })[0].id, 'plain', 'avoid prefers dialogue-only');
  assert.strictEqual(rankSubs(sdata, 'Movie.2020.1080p.BluRay-X', { sdhPref: 'prefer' })[0].id, 'sdh', 'prefer favors SDH');
  assert.strictEqual(rankSubs(sdata, 'Movie.2020.1080p.BluRay-X', { sdhPref: 'avoid' }).length, 2, 'both variants remain listed');

  // Wyzie returns a per-subtitle `encoding`; honor the declared charset over a UTF-8 assumption.
  assert.strictEqual(decodeSubtitleBuffer(Buffer.from([0xCF, 0xF0, 0xE8]), '', 'windows-1251'), 'При', 'declared windows-1251 decoded correctly');
  assert.strictEqual(decodeSubtitleBuffer(Buffer.from('café', 'utf8'), '', 'UTF-8'), 'café', 'declared UTF-8 passes through');
});

test('subs: auto-match falls through stale subtitle file links', async () => {
  const { fetchOnlineSub, downloadBestSubtitle } = require('../server/opensubs');
  const downloads = [];
  let base;
  const results = () => [
    {
      id: 'dead',
      url: `${base}/dead.srt`,
      format: 'srt',
      display: 'Movie.2024.1080p.WEB-DL-GRP',
      fileName: 'Movie.2024.1080p.WEB-DL-GRP.srt',
    },
    {
      id: 'ok',
      url: `${base}/ok.srt`,
      format: 'srt',
      display: 'Movie.2024.1080p.WEB-DL',
    },
  ];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/search') {
      assert.strictEqual(u.searchParams.get('key'), 'test-key');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(results()));
    }
    downloads.push(u.pathname);
    if (u.pathname === '/dead.srt') {
      res.writeHead(401);
      return res.end('stale provider link');
    }
    if (u.pathname === '/ok.srt') {
      res.writeHead(200);
      return res.end('1\r\n00:00:01,000 --> 00:00:02,500\r\nHealthy fallback\r\n');
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    base = `http://127.0.0.1:${srv.address().port}`;
    const vtt = await fetchOnlineSub({
      key: 'test-key',
      tmdbId: '123',
      query: 'Movie 2024',
      lang: 'en',
      releaseName: 'Movie.2024.1080p.WEB-DL-GRP.mkv',
      base,
      attempts: 1,
      retryDelayMs: 0,
    });
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /Healthy fallback/);
    assert.deepStrictEqual(downloads, ['/dead.srt', '/ok.srt']);
    downloads.length = 0;
    const preferred = await downloadBestSubtitle(results(), {
      key: 'test-key',
      releaseName: 'Movie.2024.1080p.WEB-DL-GRP.mkv',
      preferredId: 'dead',
      base,
      attempts: 1,
      retryDelayMs: 0,
    });
    assert.match(preferred, /Healthy fallback/);
    assert.deepStrictEqual(downloads, ['/dead.srt', '/ok.srt']);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('subs: pickSub matches the sub to OUR release cut (sync depends on it)', () => {
  const { pickSub, rankSubs } = require('../server/opensubs');
  // Wyzie's flat result shape: { id, url, format, display, isHearingImpaired }.
  const data = [
    { id: 1, url: 'http://x/1.srt', format: 'srt', display: 'Show.S01E01.720p.BluRay.x264-GRP' },
    { id: 2, url: 'http://x/2.srt', format: 'srt', display: 'Show.S01E01.1080p.AMZN.WEB-DL-NTb' },
    { id: 3, url: 'http://x/3.sub', format: 'sub', display: 'Show.S01E01.VOBSUB' }, // bitmap — can't become VTT
    { id: 4, format: 'srt', display: 'no url — unusable' },
  ];
  const forWeb = pickSub(data, 'Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv');
  assert.strictEqual(forWeb.id, 2, 'WEB-DL source picks the WEB-DL sub');
  const exactFile = [
    { id: 'generic', url: 'http://x/generic.srt', format: 'srt', display: 'Show.S01E01.1080p.WEB-DL' },
    { id: 'exact', url: 'http://x/exact.srt', format: 'srt', fileName: 'Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.srt' },
  ];
  assert.strictEqual(pickSub(exactFile, 'Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv').id, 'exact',
    'exact subtitle file/release matches beat generic same-title rows');
  const forBlu = pickSub(data, 'Show.S01E01.1080p.BluRay.x264-GRP.mkv');
  assert.strictEqual(forBlu.id, 1, 'BluRay source matches the BluRay sub');
  const normalCut = [
    { id: 'plain', url: 'http://x/plain.srt', format: 'srt', display: 'Sec.Test.2024.WEB-DL-GRP' },
    { id: 'extended', url: 'http://x/extended.srt', format: 'srt', display: 'Sec.Test.2024.Extended.Edition.WEB-DL-GRP' },
  ];
  assert.strictEqual(pickSub(normalCut, 'Sec.Test.2024.WEB-DL-GRP.mkv').id, 'plain',
    'edition-tagged subtitles must not auto-win for normal theatrical-looking releases');
  const rookie = [
    { id: 'e1', url: 'http://x/e1.srt', format: 'srt', display: 'The.Rookie.S01E01.1080p.WEB-DL-GRP' },
    { id: 'e3', url: 'http://x/e3.srt', format: 'srt', display: 'The.Rookie.S01E03.1080p.WEB-DL-GRP' },
    { id: 'show', url: 'http://x/show.srt', format: 'srt', display: 'The.Rookie.1080p.WEB-DL-GRP' },
  ];
  assert.strictEqual(pickSub(rookie, 'The.Rookie.S01E03.1080p.WEB-DL-GRP.mkv').id, 'e3',
    'TV subtitles must prefer the exact episode over same-show/wrong-episode files');
  const rookieRanked = rankSubs(rookie, 'The.Rookie.S01E03.1080p.WEB-DL-GRP.mkv');
  assert.strictEqual(rookieRanked[0].id, 'e3', 'the exact episode is the selected subtitle variant');
  assert.match(rookieRanked[0].label, /S01E03 - WEB-DL - GRP/,
    'ranked TV subtitle labels should call out episode, source, and release group');
  assert.ok(rookieRanked.find((v) => v.id === 'e1').score < rookieRanked.find((v) => v.id === 'show').score,
    'wrong-episode subtitle files rank below generic fallback rows');
  const lotr = [
    { id: 10, url: 'http://x/theatrical.srt', format: 'srt', display: 'The.Lord.of.the.Rings.The.Return.of.the.King.2003.Theatrical.1080p.BluRay.x264-GRP' },
    { id: 11, url: 'http://x/extended.srt', format: 'srt', display: 'The.Lord.of.the.Rings.The.Return.of.the.King.2003.Extended.Edition.1080p.BluRay.x264-GRP' },
  ];
  assert.strictEqual(pickSub(lotr, 'The.Lord.of.the.Rings.The.Return.of.the.King.2003.1080p.BluRay.x264-GRP.mkv',
    { durationSeconds: 15796 }).id, 11, 'very long cuts prefer Extended Edition subtitles');
  assert.strictEqual(pickSub(lotr, 'The.Lord.of.the.Rings.The.Return.of.the.King.2003.Theatrical.1080p.BluRay.x264-GRP.mkv').id,
    10, 'explicit theatrical releases prefer theatrical subtitles');
  const ranked = rankSubs(lotr, 'The.Lord.of.the.Rings.The.Return.of.the.King.2003.1080p.BluRay.x264-GRP.mkv',
    { durationSeconds: 15796 });
  assert.strictEqual(ranked[0].id, '11', 'ranked variants expose the same auto-selected extended cut');
  assert.match(ranked[0].label, /Extended/i, 'variant label calls out the cut');
  assert.ok(ranked[0].selected, 'the best automatic match is marked for the UI');
  assert.strictEqual(ranked[1].id, '10', 'alternate cuts remain available instead of disappearing');
  assert.strictEqual(rankSubs(lotr, '', { durationSeconds: 13698 })[0].id, '11',
    'a 3h48 feature still infers an extended cut even if the release name is generic');
  assert.notStrictEqual(pickSub(data, '').id, 3, 'bitmap formats never win');
  assert.ok(pickSub([{ id: 9, format: 'srt' }], '') === undefined, 'url-less results are skipped entirely');
});

test('subs: usableVariants trims the wrong-episode / unplayable rows from the menu', () => {
  const { rankSubs, usableVariants } = require('../server/opensubs');
  // A long-running show (House-style) where the provider returns lots of cross-episode noise +
  // a bitmap. The user is watching S02E05; the menu must NOT advertise the wrong episodes or the
  // bitmap, both of which "don't work" when picked.
  const house = [
    { id: 'right', url: 'http://x/right.srt', format: 'srt', display: 'House.S02E05.1080p.WEB-DL-GRP' },
    { id: 'wrong1', url: 'http://x/w1.srt', format: 'srt', display: 'House.S02E04.1080p.WEB-DL-GRP' },
    { id: 'wrong2', url: 'http://x/w2.srt', format: 'srt', display: 'House.S03E12.720p.HDTV-GRP' },
    { id: 'generic', url: 'http://x/g.srt', format: 'srt', display: 'House.Complete.Series.Pack' },
    { id: 'bitmap', url: 'http://x/b.sub', format: 'sub', display: 'House.S02E05.VOBSUB' },
  ];
  const release = 'House.S02E05.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv';
  const ranked = rankSubs(house, release);
  assert.ok(ranked.some((v) => v.id === 'wrong1'), 'rankSubs still keeps wrong-episode rows for auto-pick/fallback reasoning');
  const menu = usableVariants(ranked, { releaseName: release });
  const ids = menu.map((v) => v.id);
  assert.deepStrictEqual(ids.sort(), ['generic', 'right'], 'menu keeps only the right episode + the generic/no-episode fallback');
  assert.ok(!ids.includes('wrong1') && !ids.includes('wrong2'), 'explicit wrong-episode subs are hidden');
  assert.ok(!ids.includes('bitmap'), 'bitmap (non-text) subs are hidden — they can never render');
  assert.ok(menu.find((v) => v.id === 'right').selected, 'the right episode stays selected after the trim');

  // Movie target (no episode): only the bitmap is unplayable, everything else stays.
  const movie = [
    { id: 'srt', url: 'http://x/m.srt', format: 'srt', display: 'Some.Movie.2024.1080p.WEB-DL-GRP' },
    { id: 'pgs', url: 'http://x/m.sup', format: 'sup', display: 'Some.Movie.2024.PGS' },
  ];
  const mMenu = usableVariants(rankSubs(movie, 'Some.Movie.2024.1080p.WEB-DL-GRP.mkv'), { releaseName: 'Some.Movie.2024.1080p.WEB-DL-GRP.mkv' });
  assert.deepStrictEqual(mMenu.map((v) => v.id), ['srt'], 'movies drop only the unplayable bitmap row');

  // Degrade gracefully: if EVERY result is a wrong episode, do not return an empty menu.
  const allWrong = [
    { id: 'a', url: 'http://x/a.srt', format: 'srt', display: 'House.S01E01.WEB-DL-GRP' },
    { id: 'b', url: 'http://x/b.srt', format: 'srt', display: 'House.S01E02.WEB-DL-GRP' },
  ];
  const fallback = usableVariants(rankSubs(allWrong, release), { releaseName: release });
  assert.strictEqual(fallback.length, 2, 'when nothing matches the episode we keep best-effort rows rather than show nothing');
  assert.ok(fallback.some((v) => v.selected), 'a best-effort row is still marked selected');
});

test('subs: hasConfidentAutoPick guards the automatic pick against wrong-episode-only results', () => {
  const { rankSubs, hasConfidentAutoPick } = require('../server/opensubs');
  const release = 'House.S02E05.1080p.WEB-DL-GRP.mkv';
  const right = rankSubs([
    { id: 'r', url: 'http://x/r.srt', format: 'srt', display: 'House.S02E05.WEB-DL-GRP' },
    { id: 'w', url: 'http://x/w.srt', format: 'srt', display: 'House.S02E04.WEB-DL-GRP' },
  ], release);
  assert.ok(hasConfidentAutoPick(right, { releaseName: release }), 'a right-episode match is a confident auto-pick');
  const generic = rankSubs([{ id: 'g', url: 'http://x/g.srt', format: 'srt', display: 'House.Complete.Pack' }], release);
  assert.ok(hasConfidentAutoPick(generic, { releaseName: release }), 'a generic/no-episode row is acceptable to auto-serve');
  const allWrong = rankSubs([
    { id: 'a', url: 'http://x/a.srt', format: 'srt', display: 'House.S01E01.WEB-DL-GRP' },
    { id: 'b', url: 'http://x/b.srt', format: 'srt', display: 'House.S03E09.WEB-DL-GRP' },
  ], release);
  assert.ok(!hasConfidentAutoPick(allWrong, { releaseName: release }),
    'when EVERY result is a confirmed different episode there is no confident auto-pick (report no-subs, do not feed wrong dialogue)');
  const movie = rankSubs([{ id: 'm', url: 'http://x/m.srt', format: 'srt', display: 'Some.Movie.2024.WEB-DL' }], 'Some.Movie.2024.WEB-DL.mkv');
  assert.ok(hasConfidentAutoPick(movie, { releaseName: 'Some.Movie.2024.WEB-DL.mkv' }), 'movies (no episode) auto-pick any text sub');
});

test('subs: popularity/trust break ties without overriding release or episode matches', () => {
  const { rankSubs, pickSub } = require('../server/opensubs');
  // Two equally-generic English subs for the same movie: the far more downloaded one should win.
  const tie = [
    { id: 'rare', url: 'http://x/rare.srt', format: 'srt', display: 'Some.Movie.2024.1080p.WEB-DL', downloadCount: 3 },
    { id: 'popular', url: 'http://x/pop.srt', format: 'srt', display: 'Some.Movie.2024.1080p.WEB-DL', downloadCount: 5000, fromTrusted: true },
  ];
  assert.strictEqual(pickSub(tie, 'Some.Movie.2024.1080p.WEB-DL-GRP.mkv').id, 'popular',
    'among equal-quality matches the popular/trusted sub is the default pick');
  // But popularity must NOT beat a real release-name match, and must NEVER beat the right episode.
  const release = [
    { id: 'exactBlu', url: 'http://x/blu.srt', format: 'srt', display: 'Some.Movie.2024.1080p.BluRay.x264-GRP', downloadCount: 1 },
    { id: 'popularWeb', url: 'http://x/web.srt', format: 'srt', display: 'Some.Movie.2024.1080p.WEB-DL-OTHER', downloadCount: 999999 },
  ];
  assert.strictEqual(pickSub(release, 'Some.Movie.2024.1080p.BluRay.x264-GRP.mkv').id, 'exactBlu',
    'a popular wrong-cut sub never beats the matching release cut');
  const ep = [
    { id: 'rightEp', url: 'http://x/e.srt', format: 'srt', display: 'House.S02E05.WEB-DL-GRP', downloadCount: 2 },
    { id: 'popularWrongEp', url: 'http://x/we.srt', format: 'srt', display: 'House.S02E04.WEB-DL-GRP', downloadCount: 999999 },
  ];
  assert.strictEqual(rankSubs(ep, 'House.S02E05.1080p.WEB-DL-GRP.mkv')[0].id, 'rightEp',
    'a hugely popular wrong-episode sub never out-ranks the correct episode');
});

test('subs: variant labels are distinct and fall back to the release name, not "Subtitle version"', () => {
  const { rankSubs } = require('../server/opensubs');
  // Results with no episode/source/group structure must not all collapse to one label.
  const blank = [
    { id: 'a', url: 'http://x/a.srt', format: 'srt', display: 'House.MD.Season.2.Complete' },
    { id: 'b', url: 'http://x/b.srt', format: 'srt', display: 'House.M.D.S02.PROPER' },
  ];
  const ranked = rankSubs(blank, '');
  const labels = ranked.map((v) => v.label);
  assert.ok(!labels.some((l) => /^Subtitle version$/i.test(l)), 'rows fall back to the readable release name');
  assert.strictEqual(new Set(labels).size, labels.length, 'no two rows share an identical label');
  // Genuinely identical display strings still get disambiguated with a numeric suffix.
  const dupe = rankSubs([
    { id: '1', url: 'http://x/1.srt', format: 'srt', display: 'House' },
    { id: '2', url: 'http://x/2.srt', format: 'srt', display: 'House' },
  ], '');
  assert.strictEqual(new Set(dupe.map((v) => v.label)).size, 2, 'duplicate display strings are still made unique');
});

test('subs: subSyncResultOk rejects corrupt alass alignments (cue count must be preserved)', () => {
  const { subSyncResultOk } = require('../server/opensubs');
  const cue = (a, b, t) => `00:00:0${a},000 --> 00:00:0${b},000\n${t}\n`;
  const input = [cue(1, 2, 'one'), cue(3, 4, 'two'), cue(5, 6, 'three')].join('\n');
  const reTimed = [cue(2, 3, 'one'), cue(4, 5, 'two'), cue(6, 7, 'three')].join('\n'); // same 3 cues, shifted
  assert.ok(subSyncResultOk(input, reTimed), 'a correctly re-timed sub with the same cue count is accepted');
  assert.ok(!subSyncResultOk(input, ''), 'empty alass output is rejected');
  assert.ok(!subSyncResultOk(input, 'WEBVTT\n\nno timestamps here'), 'output without timestamps is rejected');
  assert.ok(!subSyncResultOk(input, [cue(1, 2, 'only one')].join('\n')), 'dropping most cues is rejected as corrupt');
  // Tiny tolerance: one extra/blank cue on a large sub is still accepted.
  const big = Array.from({ length: 100 }, (_, i) => cue(1, 2, 'line' + i)).join('\n');
  const bigPlus1 = big + '\n' + cue(9, 9, 'trailing');
  assert.ok(subSyncResultOk(big, bigPlus1), 'a single trailing cue within tolerance is accepted');
  const bigDropped = Array.from({ length: 80 }, (_, i) => cue(1, 2, 'line' + i)).join('\n');
  assert.ok(!subSyncResultOk(big, bigDropped), 'dropping 20% of cues exceeds tolerance and is rejected');
});

test('subs: distinctVariants collapses Wyzie mirror-duplicate rows into a few meaningful choices', () => {
  const { rankSubs, usableVariants, distinctVariants } = require('../server/opensubs.js');
  // Mirrors what live Wyzie returns for an episode: one BluRay + one HDTV + one SDH, plus a pile of
  // interchangeable generic English SRTs (no source info) re-uploaded across sites.
  const release = 'House.S02E05.1080p.BluRay.x264-DON.mkv';
  const data = [
    { id: 'blu', url: 'http://x/blu.srt', format: 'srt', display: 'House.S02E05.1080p.BluRay-DON', language: 'en' },
    { id: 'hdtv', url: 'http://x/hdtv.srt', format: 'srt', display: 'House.S02E05.720p.HDTV-LOL', language: 'en' },
    { id: 'sdh', url: 'http://x/sdh.srt', format: 'srt', display: 'House.S02E05.WEB-DL', language: 'en', isHearingImpaired: true },
  ];
  for (let i = 0; i < 8; i++) data.push({ id: 'gen' + i, url: `http://x/g${i}.srt`, format: 'srt', display: 'House.S02E05', language: 'en', downloadCount: i });
  const trimmed = usableVariants(rankSubs(data, release), { releaseName: release }).slice(0, 12);
  const menu = distinctVariants(trimmed);
  assert.ok(menu.length <= 5, `12 near-identical rows collapse to a handful of distinct choices (got ${menu.length})`);
  // The 8 generic English SRTs collapse to ONE row that records how many it stood in for.
  const generic = menu.find((v) => !/blu|hdtv|web/i.test(String(v.raw.display)) || /House\.S02E05$/.test(v.raw.display));
  assert.ok(menu.some((v) => v.dupes >= 6), 'the interchangeable generic mirrors collapse into one row with a dupes count');
  assert.ok(menu.some((v) => /BluRay/i.test(v.label)), 'the distinct BluRay source is preserved as its own choice');
  assert.ok(menu.some((v) => v.hearingImpaired), 'the SDH variant survives as a distinct choice');
  assert.ok(menu.some((v) => v.selected), 'a row stays selected after collapse');
  assert.strictEqual(menu.find((v) => v.selected).id, 'blu', 'the release-matched BluRay sub is the auto-pick');
});

test('subs: Wyzie search sends catalog id + episode but NO slow release/file hints', async () => {
  const { searchOnlineSubs } = require('../server/opensubs');
  let seen;
  const srv = http.createServer((req, res) => {
    seen = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 'ok', url: 'http://x/sub.srt', format: 'srt', display: 'Show.S01E01.1080p.WEB-DL-GRP' }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const release = 'Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv';
    await searchOnlineSubs({
      tmdbId: '123', query: 'Show S01E01', lang: 'en', releaseName: release,
      base: `http://127.0.0.1:${srv.address().port}`,
    });
    assert.strictEqual(seen.searchParams.get('id'), '123');
    assert.strictEqual(seen.searchParams.get('source'), 'all');
    assert.strictEqual(seen.searchParams.get('season'), '1');
    assert.strictEqual(seen.searchParams.get('episode'), '1');
    // Release/file hints are deliberately NOT sent: measured on a live key, that hinted lookup is
    // ~2x slower (~10s) AND almost always 400s "no matching release". We rank by release/episode/
    // edition LOCALLY in rankSubs, so the hint added latency for nothing.
    assert.strictEqual(seen.searchParams.has('release'), false, 'no slow release hint sent to Wyzie');
    assert.strictEqual(seen.searchParams.has('origin'), false);
    assert.strictEqual(seen.searchParams.has('fileName'), false);
    assert.strictEqual(seen.searchParams.has('file'), false);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('subs: explicit season/episode override the query so the right episode reaches Wyzie', async () => {
  const { searchOnlineSubs } = require('../server/opensubs');
  let seen;
  const srv = http.createServer((req, res) => {
    seen = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 'ok', url: 'http://x/sub.srt', format: 'srt', display: 'Show.S02E05.1080p.WEB-DL-GRP' }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    // The remembered query carries NO episode (the regression: a play route never stamped SxxExx).
    // The player now sends season/episode explicitly, so Wyzie must still be asked for exactly S02E05
    // rather than the whole show.
    await searchOnlineSubs({
      tmdbId: '123', query: 'Show', season: 2, episode: 5, lang: 'en',
      base: `http://127.0.0.1:${srv.address().port}`,
    });
    assert.strictEqual(seen.searchParams.get('season'), '2', 'explicit season is sent even with an episode-less query');
    assert.strictEqual(seen.searchParams.get('episode'), '5', 'explicit episode is sent even with an episode-less query');

    // And explicit params WIN over a stale/wrong SxxExx left in the query string.
    await searchOnlineSubs({
      tmdbId: '123', query: 'Show S01E09', season: 2, episode: 5, lang: 'en',
      base: `http://127.0.0.1:${srv.address().port}`,
    });
    assert.strictEqual(seen.searchParams.get('season'), '2', 'explicit season overrides a stale query SxxExx');
    assert.strictEqual(seen.searchParams.get('episode'), '5', 'explicit episode overrides a stale query SxxExx');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('subs: Wyzie search prefers IMDb id when available for paid provider coverage', async () => {
  const { searchOnlineSubs, _wyzieCatalogId } = require('../server/opensubs');
  let seen;
  const srv = http.createServer((req, res) => {
    seen = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 'ok', url: 'http://x/sub.srt', format: 'srt', display: 'Catch.Me.If.You.Can.2002.WEB-DL' }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await searchOnlineSubs({
      tmdbId: '640', imdbId: 'TT0264464', query: 'Catch Me If You Can 2002', lang: 'en',
      base: `http://127.0.0.1:${srv.address().port}`,
    });
    assert.strictEqual(_wyzieCatalogId({ tmdbId: '640', imdbId: 'TT0264464' }), 'tt0264464');
    assert.strictEqual(seen.searchParams.get('id'), 'tt0264464',
      'IMDb ids keep the tt prefix for providers that match by IMDb');
    assert.strictEqual(seen.searchParams.get('source'), 'all',
      'paid keys query every enabled Wyzie provider');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// A response that TRICKLES (a byte under every idle window) defeats socket timeouts — only a
// hard total deadline stops it. Same lesson as the NNTP stall bug: timeouts on every wire.
test('subs: Wyzie search is a single ID-only call (no wasted release-filter round-trip)', async () => {
  const { searchOnlineSubs } = require('../server/opensubs');
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    seen.push(u);
    // A real Wyzie 400s a release-hinted query — if we ever sent one again this mock would surface it.
    if (u.searchParams.has('release')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'No matching release found' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 'fallback', url: 'http://x/sub.srt', format: 'srt', display: 'Show.S01E01.1080p.WEB-DL-GRP' }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const rows = await searchOnlineSubs({
      tmdbId: '123', query: 'Show S01E01', lang: 'en', releaseName: 'Show.S01E01.Unknown.Release-GRP.mkv',
      base: `http://127.0.0.1:${srv.address().port}`,
    });
    assert.strictEqual(rows[0].id, 'fallback');
    assert.strictEqual(seen.length, 1, 'exactly one Wyzie call — the slow release-hinted round-trip was removed');
    assert.strictEqual(seen[0].searchParams.has('release'), false, 'release filters are never sent');
    assert.strictEqual(seen[0].searchParams.get('id'), '123');
    assert.strictEqual(seen[0].searchParams.get('season'), '1');
    assert.strictEqual(seen[0].searchParams.get('episode'), '1');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('subs: Wyzie no-subtitles response is a clean no-results error', async () => {
  const { searchOnlineSubs, _isNoSubtitleError } = require('../server/opensubs');
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls++;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'No subtitles found' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(searchOnlineSubs({
      tmdbId: '123', query: 'Unknown Show S01E01', lang: 'en',
      base: `http://127.0.0.1:${srv.address().port}`,
      attempts: 1,
      retryDelayMs: 0,
    }), (e) => {
      assert.strictEqual(_isNoSubtitleError(e), true);
      assert.strictEqual(e.permanent, true);
      assert.match(e.message, /no en subtitles found/i);
      return true;
    });
    assert.strictEqual(calls, 1, 'no-results responses do not retry as transient failures');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('opensubs/trakt: hard deadline kills trickling responses; redirect loops bounded', async () => {
  const { _request: osReq } = require('../server/opensubs');
  const { _request: tkReq } = require('../server/trakt');
  const trickle = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const t = setInterval(() => res.write('x'), 50);
    res.on('close', () => clearInterval(t));
  });
  await new Promise((r) => trickle.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${trickle.address().port}`;
  let t0 = Date.now();
  await assert.rejects(osReq('GET', base + '/sub', { deadlineMs: 300 }), /deadline/, 'opensubs trickle hits the deadline');
  assert.ok(Date.now() - t0 < 5000, 'rejected by the deadline, not a long idle timeout');
  const oldBase = process.env.TRAKT_BASE;
  process.env.TRAKT_BASE = base;
  try {
    t0 = Date.now();
    await assert.rejects(tkReq('/oauth/token', { deadlineMs: 300 }), /deadline/, 'trakt trickle hits the deadline');
    assert.ok(Date.now() - t0 < 5000, 'trakt rejected by the deadline');
  } finally {
    if (oldBase === undefined) delete process.env.TRAKT_BASE; else process.env.TRAKT_BASE = oldBase;
  }
  const loop = http.createServer((req, res) => { res.writeHead(302, { location: '/again' }); res.end(); });
  await new Promise((r) => loop.listen(0, '127.0.0.1', r));
  await assert.rejects(osReq('GET', `http://127.0.0.1:${loop.address().port}/a`, {}), /redirect loop/, 'self-redirect bounded');
  trickle.close(); loop.close();
});

test('newznab: parses RSS, dedupes by title + size window', () => {
  const xml = rssFor([
    { name: 'Show.S01E01.1080p.WEB-DL-NTb', url: 'http://x/1', size: 4000000000 },
    { name: 'Show S01E01 1080p WEB-DL-NTb', url: 'http://y/1', size: 4010000000 }, // dupe (1.0025x)
    { name: 'Show.S01E01.720p.HDTV-LOL', url: 'http://x/2', size: 800000000 },
  ]);
  const parsed = parseNewznabRss(xml, 'ix');
  assert.strictEqual(parsed.length, 3);
  const dd = dedupe(parsed);
  assert.strictEqual(dd.length, 2, 'cross-indexer duplicate collapsed');
  assert.strictEqual(dd[0].sizeBytes, 4000000000);
});

test('newznab: dedupe stays near-linear on large unique result sets', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => ({
    name: `Movie ${i} 2026 1080p WEB-DL-GRP`,
    sizeBytes: 1_000_000_000 + i,
    nzbUrl: `https://indexer.test/${i}.nzb`,
    indexer: i % 2 ? 'b' : 'a',
  }));
  const t0 = Date.now();
  const out = dedupe(rows);
  const elapsed = Date.now() - t0;
  assert.strictEqual(out.length, rows.length);
  assert.ok(elapsed < 750, `dedupe should not rescan every prior row for unrelated titles (${elapsed}ms)`);
});

test('newznab: fan-out keeps the fast indexer when another times out', async () => {
  const fastSockets = new Set();
  const fast = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rssFor([{ name: 'Movie.1080p.WEB-DL-FLUX', url: 'http://f/1', size: 5e9 }]));
  });
  fast.on('connection', (sock) => {
    fastSockets.add(sock);
    sock.on('close', () => fastSockets.delete(sock));
  });
  const slowSockets = new Set();
  const slow = http.createServer(() => { /* never responds */ });
  slow.on('connection', (sock) => {
    slowSockets.add(sock);
    sock.on('close', () => slowSockets.delete(sock));
  });
  await new Promise((r) => fast.listen(0, '127.0.0.1', r));
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));

  try {
    const t0 = Date.now();
    const { results, errors } = await fanout([
      { name: 'fast', url: `http://127.0.0.1:${fast.address().port}`, apikey: 'k' },
      { name: 'slow', url: `http://127.0.0.1:${slow.address().port}`, apikey: 'k' },
    ], { q: 'movie' }, { timeoutMs: 400 });
    const elapsed = Date.now() - t0;

    assert.strictEqual(results.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].error, /timeout|deadline/);
    assert.ok(elapsed < 1500, `fan-out bounded by budget (took ${elapsed}ms)`);
  } finally {
    for (const sock of fastSockets) sock.destroy();
    for (const sock of slowSockets) sock.destroy();
    if (typeof fast.closeAllConnections === 'function') fast.closeAllConnections();
    if (typeof slow.closeAllConnections === 'function') slow.closeAllConnections();
    fast.close();
    slow.close();
  }
});

test('newznab: search timeout is a hard total budget, not a 3x trickle window', async () => {
  const trickle = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    const t = setInterval(() => res.write(' '), 40);
    res.on('close', () => clearInterval(t));
  });
  await new Promise((r) => trickle.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => searchIndexer(
        { name: 'trickle', url: `http://127.0.0.1:${trickle.address().port}`, apikey: 'k' },
        { q: 'movie' },
        { timeoutMs: 250 }
      ),
      /deadline/
    );
    assert.ok(Date.now() - t0 < 1200, 'trickling indexers cannot stretch source search into a long wait');
  } finally {
    await new Promise((r) => trickle.close(r));
  }
});

// ---------- pipeline e2e ----------
// Mock indexer that also serves the NZB downloads; releases map to mock-NNTP articles.
function makeMockIndexer(releases) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      const port = server.address().port;
      return res.end(rssFor(releases.map((r, i) => ({
        name: r.name, url: `http://127.0.0.1:${port}/nzb/${i}`, size: r.size,
      }))));
    }
    const m = /^\/nzb\/(\d+)$/.exec(u.pathname);
    if (m) { res.writeHead(200); return res.end(releases[+m[1]].nzb); }
    res.writeHead(404); res.end();
  });
  return { server, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

function nzbFor(volumes, partSize, prefix) {
  const articles = new Map();
  const fileXml = volumes.map((v, fi) => {
    const totalParts = Math.ceil(v.data.length / partSize) || 1;
    const segs = [];
    for (let p = 0; p < totalParts; p++) {
      const begin = p * partSize, end = Math.min(v.data.length, begin + partSize);
      const body = encodePart(v.data, { name: v.name, partNum: p + 1, totalParts, begin, end, totalSize: v.data.length });
      const msgId = `${prefix}f${fi}s${p}@t.test`;
      articles.set(msgId, body);
      segs.push(`<segment bytes="${body.length}" number="${p + 1}">${msgId}</segment>`);
    }
    return `<file poster="t" date="1" subject="[r] &quot;${v.name}&quot; yEnc (1/${totalParts})"><groups><group>a.b</group></groups><segments>${segs.join('')}</segments></file>`;
  }).join('');
  return { nzb: `<?xml version="1.0"?><nzb>${fileXml}</nzb>`, articles };
}

test('pipeline: detail warmup and immediate Play share one indexer fan-out', async () => {
  const payload = seededPayload(90 * 1024, 0xfa5);
  const good = nzbFor(writeRar4Store([{ name: 'Movie.mkv', data: payload }], { base: 'warm' }), 30000, 'warm');
  const articles = new Map([...good.articles]);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  let indexerFanouts = 0;
  let nzbHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api') {
      indexerFanouts++;
      const port = server.address().port;
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        res.end(rssFor([{ name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', url: `http://127.0.0.1:${port}/nzb/0`, size: 5e9 }]));
      }, 80);
    }
    if (u.pathname === '/nzb/0') {
      nzbHits++;
      return setTimeout(() => { res.writeHead(200); res.end(good.nzb); }, 160);
    }
    res.writeHead(404); res.end();
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  const [search, play] = await Promise.all([
    pipeline.search({ q: 'Movie 2024' }),
    pipeline.play({ q: 'Movie 2024' }),
  ]);

  assert.strictEqual(indexerFanouts, 1, 'a quick Play should join the active detail-page warmup search');
  assert.strictEqual(search.candidates[0].name, 'Movie.2024.1080p.WEB-DL.H.264-NTb');
  assert.strictEqual(play.candidate.name, 'Movie.2024.1080p.WEB-DL.H.264-NTb');
  assert.strictEqual(nzbHits, 1, 'Play should join the detail-page NZB prefetch instead of downloading it twice');
  const metrics = pipeline.metricsSnapshot();
  assert.strictEqual(metrics.search.fanouts, 1, 'metrics should preserve the single fan-out proof');
  assert.ok(metrics.search.inflightJoins >= 1, 'metrics should show Play joined the warmup search');
  assert.ok(metrics.nzb.prefetches >= 1, 'detail warmup should still start the cheap NZB prefetch');
  assert.ok(metrics.nzb.inflightJoins >= 1, 'metrics should show Play joined the active NZB prefetch');
  assert.strictEqual(metrics.mount.successes, 1, 'playback should mount exactly one chosen source');
  assert.ok(metrics.firstProbe.present >= 1, 'first-article probe should record the healthy source');

  pool.close(); await mock.close(); server.close(); store.close();
});

test('pipeline: exact-id Play reuses title-only detail warmup search', async () => {
  const payload = seededPayload(60 * 1024, 0xfa6);
  const good = nzbFor([{ name: 'Movie.mkv', data: payload }], 30000, 'idwarm');
  const articles = new Map([...good.articles]);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  let indexerFanouts = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api') {
      indexerFanouts++;
      const port = server.address().port;
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rssFor([{ name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', url: `http://127.0.0.1:${port}/nzb/0`, size: 5e9 }]));
    }
    if (u.pathname === '/nzb/0') { res.writeHead(200); return res.end(good.nzb); }
    res.writeHead(404); res.end();
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  await pipeline.search({ q: 'Movie 2024' });
  const play = await pipeline.play({ q: 'Movie 2024', imdbid: 'tt1234567' });

  assert.strictEqual(indexerFanouts, 1, 'Play with catalog ids should reuse the title-only warmup search');
  assert.strictEqual(play.candidate.name, 'Movie.2024.1080p.WEB-DL.H.264-NTb');
  assert.ok(pipeline.metricsSnapshot().search.cacheHits >= 1, 'metrics should record the warmup cache hit');

  pool.close(); await mock.close(); server.close(); store.close();
});

test('pipeline: TV episode Play reuses detail warmup even when season and episode types differ', async () => {
  const payload = seededPayload(60 * 1024, 0xfa7);
  const good = nzbFor([{ name: 'Show.S03E01.mkv', data: payload }], 30000, 'tvwarm');
  const articles = new Map([...good.articles]);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  let indexerFanouts = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api') {
      indexerFanouts++;
      const port = server.address().port;
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rssFor([{ name: 'Show.S03E01.1080p.WEB-DL.H.264-NTb', url: `http://127.0.0.1:${port}/nzb/0`, size: 3e9 }]));
    }
    if (u.pathname === '/nzb/0') { res.writeHead(200); return res.end(good.nzb); }
    res.writeHead(404); res.end();
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  await pipeline.search({ q: 'Show', season: '3', ep: '1' });
  const play = await pipeline.play({ q: 'Show', season: 3, ep: 1 });

  assert.strictEqual(indexerFanouts, 1, 'URL-string detail warmup should satisfy numeric Play episode keys');
  assert.strictEqual(play.candidate.name, 'Show.S03E01.1080p.WEB-DL.H.264-NTb');
  assert.ok(pipeline.metricsSnapshot().search.cacheHits >= 1, 'metrics should record the episode warmup cache hit');

  pool.close(); await mock.close(); server.close(); store.close();
});

test('pipeline: prepared detail source is reused by Play without a second mount', async () => {
  const payload = seededPayload(90 * 1024, 0xfa8);
  const good = nzbFor(writeRar4Store([{ name: 'Movie.mkv', data: payload }], { base: 'prepare' }), 30000, 'prepare');
  const articles = new Map([...good.articles]);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  let indexerFanouts = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api') {
      indexerFanouts++;
      const port = server.address().port;
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rssFor([{ name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', url: `http://127.0.0.1:${port}/nzb/0`, size: 5e9 }]));
    }
    if (u.pathname === '/nzb/0') { res.writeHead(200); return res.end(good.nzb); }
    res.writeHead(404); res.end();
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  await pipeline.search({ q: 'Movie 2024' });
  const [prepared, play] = await Promise.all([
    pipeline.prepare({ q: 'Movie 2024' }),
    pipeline.play({ q: 'Movie 2024' }),
  ]);

  assert.strictEqual(prepared.prepared, true, 'detail prepare should mount the top source');
  assert.strictEqual(play.vf.id, prepared.vf.id, 'Play should reuse the prepared live mount');
  assert.strictEqual(indexerFanouts, 1, 'prepare and Play should reuse the warmed search');
  assert.strictEqual(pipeline.metricsSnapshot().mount.successes, 1, 'Play should not mount a second copy');

  pool.close(); await mock.close(); server.close(); store.close();
});

test('pipeline: detail prepare skips a bad top source and warms the next playable source', async () => {
  const goodPayload = seededPayload(90 * 1024, 0xfa9);
  const bad = nzbFor([{ name: 'Missing.mkv', data: seededPayload(40 * 1024, 0xfb0) }], 30000, 'prepare-bad');
  const good = nzbFor(writeRar4Store([{ name: 'Movie.mkv', data: goodPayload }], { base: 'prepare-good' }), 30000, 'prepare-good');
  const articles = new Map([...good.articles]);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  let indexerFanouts = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api') {
      indexerFanouts++;
      const port = server.address().port;
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rssFor([
        { name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', url: `http://127.0.0.1:${port}/nzb/0`, size: 5e9 },
        { name: 'Movie.2024.1080p.WEBRip.x264-GalaxyRG', url: `http://127.0.0.1:${port}/nzb/1`, size: 3e9 },
      ]));
    }
    if (u.pathname === '/nzb/0') { res.writeHead(200); return res.end(bad.nzb); }
    if (u.pathname === '/nzb/1') { res.writeHead(200); return res.end(good.nzb); }
    res.writeHead(404); res.end();
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  const prepared = await pipeline.prepare({ q: 'Movie 2024' });
  const play = await pipeline.play({ q: 'Movie 2024' });

  assert.strictEqual(prepared.prepared, true, 'prepare should continue past the bad top source');
  assert.match(prepared.attempts[0].fail, /missing: first article unavailable/);
  assert.strictEqual(prepared.candidate.name, 'Movie.2024.1080p.WEBRip.x264-GalaxyRG');
  assert.strictEqual(play.vf.id, prepared.vf.id, 'Play should reuse the warmed fallback source');
  assert.strictEqual(indexerFanouts, 1, 'prepare and Play should still share one warmed search');
  assert.strictEqual(pipeline.metricsSnapshot().mount.successes, 1, 'the fallback source should mount once');

  pool.close(); await mock.close(); server.close(); store.close();
});

test('pipeline: timed-out health gate does not duplicate background triage', async () => {
  const payload = seededPayload(90 * 1024, 0xfa7);
  const good = nzbFor([{ name: 'Movie.mkv', data: payload }], 30000, 'slowhealth');
  const articles = new Map([...good.articles]);
  let startupStats = 0;
  let startupAborts = 0;
  let healthStats = 0;
  const slowPool = {
    stat(msgId, priority = 'health', opts = {}) {
      if (priority === 'startup') startupStats++;
      else healthStats++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(true), priority === 'startup' ? 2000 : 900);
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            startupAborts++;
            const e = new Error('aborted');
            e.code = 'ABORT_ERR';
            reject(e);
          }, { once: true });
        }
      });
    },
    body(msgId) {
      const body = articles.get(msgId);
      if (!body) return Promise.reject(new Error('missing body'));
      return Promise.resolve(body);
    },
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api') {
      const port = server.address().port;
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rssFor([{ name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', url: `http://127.0.0.1:${port}/nzb/0`, size: 5e9 }]));
    }
    if (u.pathname === '/nzb/0') { res.writeHead(200); return res.end(good.nzb); }
    res.writeHead(404); res.end();
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => slowPool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  await pipeline.play({ q: 'Movie 2024' });

  // The health gate is synchronous within play(): the timeout must NOT spawn a second triage batch.
  assert.strictEqual(healthStats, 4, 'health gate timeout should keep the original triage instead of starting a second batch');
  assert.ok(pipeline.metricsSnapshot().healthGate.timeouts >= 1, 'metrics should record the bounded health-gate timeout');

  // The first-article probe now runs CONCURRENTLY with the mount (startup win #1) — it no longer
  // gates play, so its STAT is aborted on the 800ms probe timeout shortly AFTER play() returns.
  // Assert the probe lifecycle after a settle rather than synchronously on the critical path.
  await new Promise((r) => setTimeout(r, 950));
  assert.strictEqual(startupStats, 1, 'first-article probe should start once');
  assert.strictEqual(startupAborts, 1, 'timed-out first-article probe should abort its STAT');
  assert.ok(pipeline.metricsSnapshot().firstProbe.timeout >= 1, 'metrics should record the probe timeout');
  server.close(); store.close();
});

test('pipeline: imdb/tvdb source searches fall back to verified title search', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(Object.fromEntries(u.searchParams.entries()));
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    if (u.searchParams.get('imdbid')) return res.end(rssFor([]));
    res.end(rssFor([
      { name: 'The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.Extended.1080p.BluRay.x264-GRP', url: 'http://x/good', size: 8e9 },
      { name: 'The.Lord.of.the.Rings.The.Two.Towers.2002.Extended.1080p.BluRay.x264-GRP', url: 'http://x/wrong2', size: 8e9 },
      { name: 'The.Lord.of.the.Rings.The.Return.of.the.King.2003.1080p.BluRay.x264-GRP', url: 'http://x/wrong', size: 8e9 },
      { name: 'The.Lord.of.the.Rings.The.Rings.of.Power.S01E01.1080p.WEB-DL.x264-GRP', url: 'http://x/wrong3', size: 5e9 },
    ]));
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const pipeline = new Pipeline({
    pool: () => null, verdicts: { get: () => null, set: () => {} }, mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });
  try {
    const r = await pipeline.search({ q: 'The Lord of the Rings The Fellowship of the Ring 2001', imdbid: 'tt0120737' });
    assert.strictEqual(seen[0].t, 'movie', 'first try uses the precise catalog id');
    assert.strictEqual(seen[0].imdbid, '0120737');
    assert.strictEqual(seen.at(-1).t, 'search', 'empty id search falls back to title search');
    assert.deepStrictEqual(r.candidates.map((c) => c.name), [
      'The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.Extended.1080p.BluRay.x264-GRP',
    ], 'title fallback still rejects sibling franchise movies');
  } finally {
    server.close();
  }
});

test('pipeline: TV episode fallback keeps SxxEyy instead of broad show search', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(Object.fromEntries(u.searchParams.entries()));
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    if (u.searchParams.get('tvdbid')) return res.end(rssFor([]));
    res.end(rssFor([
      { name: 'House.S03E22.1080p.WEB-DL.H.264-NTb', url: 'http://x/good', size: 2e9 },
      { name: 'House.S03E21.1080p.WEB-DL.H.264-NTb', url: 'http://x/wrong-episode', size: 2e9 },
      { name: 'House.of.Cards.S03E22.1080p.WEB-DL.H.264-NTb', url: 'http://x/wrong-show', size: 2e9 },
    ]));
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const pipeline = new Pipeline({
    pool: () => null, verdicts: { get: () => null, set: () => {} }, mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });
  try {
    const r = await pipeline.search({ q: 'House', imdbid: 'tt0412142', tvdbid: '73255', season: 3, ep: 22 });
    assert.strictEqual(seen[0].t, 'tvsearch');
    assert.strictEqual(seen[0].tvdbid, '73255');
    assert.strictEqual(seen[0].q, 'House S03E22');
    assert.strictEqual(seen.at(-1).t, 'tvsearch', 'fallback without ids remains an episode search');
    assert.strictEqual(seen.at(-1).q, 'House S03E22');
    assert.strictEqual(seen.at(-1).season, '3');
    assert.strictEqual(seen.at(-1).ep, '22');
    assert.deepStrictEqual(r.candidates.map((c) => c.name), [
      'House.S03E22.1080p.WEB-DL.H.264-NTb',
    ]);
  } finally {
    server.close();
  }
});

test('archive: obfuscated .7z.001 split volumes are detected as unsupported, never streamed as flat', async () => {
  const { mountNzb } = require('../server/archive');
  // Real-world failure: an obfuscated post named 9fZq….7z.001 fell through volume detection,
  // mounted FLAT, and "played" raw 7z bytes as if they were video.
  const sevenZip = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), seededPayload(40 * 1024, 5)]);
  const { nzb, articles } = nzbFor([
    { name: '9fZqmGjksLftVfRCM.7z.001', data: sevenZip },
    { name: '9fZqmGjksLftVfRCM.7z.002', data: seededPayload(40 * 1024, 6) },
  ], 30000, 'sz');
  const mock = createMockNntp({ articles });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, 2);
  const vf = await mountNzb(pool, nzb);
  assert.strictEqual(vf.streamable, false, 'split 7z must not stream as flat video');
  assert.ok(vf.tags.includes('unsupported-container'), `tags: ${vf.tags}`);
  pool.close();
  await mock.close();
});

test('pipeline: indexer daily NZB limit skips the grab without poisoning the verdict cache', async () => {
  const payload = seededPayload(80 * 1024, 0xcc1);
  const good = nzbFor([{ name: 'Limited.mkv', data: payload }], 30000, 'lim');
  const mock = createMockNntp({ articles: good.articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const ix = makeMockIndexer([{ name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', size: 5e9, nzb: good.nzb }]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const verdicts = new VerdictCache(store);
  let grabs = 0, allowed = false;
  const p = new Pipeline({
    pool: () => pool, verdicts, mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
    usage: { canGrab: () => allowed, onGrab: () => grabs++ },
  });

  await assert.rejects(() => p.play({ q: 'movie' }, {}), (e) => {
    assert.ok(e.attempts.every((a) => /daily NZB limit/.test(a.fail)), JSON.stringify(e.attempts));
    return true;
  });
  assert.strictEqual(grabs, 0, 'blocked grab is never counted');
  // The quota is the INDEXER's problem, not the release's — no failure verdict cached.
  assert.strictEqual(verdicts.get(`http://127.0.0.1:${ixPort}/nzb/0`), null, 'verdict cache untouched');

  allowed = true; // a new day (or another indexer tier) — the same release plays normally
  const r = await p.play({ q: 'movie' }, {});
  assert.strictEqual(r.vf.streamable, true);
  assert.strictEqual(grabs, 1, 'successful fetch counted exactly once');

  pool.close(); await mock.close(); ix.server.close(); store.close();
});

test('pipeline e2e: ranks, skips dead + unstreamable candidates, plays the good one, caches verdicts', async () => {
  const payload = seededPayload(150 * 1024, 0xab1);
  const good = nzbFor(writeRar4Store([{ name: 'Movie.mkv', data: payload }], { volSize: 60 * 1024, base: 'good' }), 30000, 'good');
  const comp = nzbFor([{ name: 'comp.rar', data: fs.readFileSync(path.join(__dirname, 'fixtures', 'real', 'comp5.rar')) }], 30000, 'comp');
  const dead = nzbFor([{ name: 'Dead.mkv', data: seededPayload(60 * 1024, 7) }], 30000, 'dead');

  // NNTP mock holds articles for good + comp, but NOT for dead (its articles 430 on mount).
  const articles = new Map([...good.articles, ...comp.articles]);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 6);

  // Scoring must order: dead (remux, trusted) > comp (bluray) > good (webrip) so the
  // pipeline walks all three and ends on good.
  const ix = makeMockIndexer([
    { name: 'Movie.2024.1080p.BluRay.REMUX.DDP5.1-FraMeSToR', size: 9e9, nzb: dead.nzb },
    { name: 'Movie.2024.1080p.BluRay.x264.DTS-FGT', size: 8e9, nzb: comp.nzb },
    { name: 'Movie.2024.1080p.WEBRip.x264-GECKOS', size: 7e9, nzb: good.nzb },
  ]);
  const ixPort = await ix.listen();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const verdicts = new VerdictCache(store);
  const mounts = new Map();
  const pipeline = new Pipeline({
    pool: () => pool, verdicts, mounts,
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  const t0 = Date.now();
  const { vf, candidate, session } = await pipeline.play({ q: 'movie' }, { maxResolutionRank: 3 });
  const elapsed = Date.now() - t0;

  assert.strictEqual(candidate.name, 'Movie.2024.1080p.WEBRip.x264-GECKOS', 'good release wins after failures');
  assert.strictEqual(vf.container, 'rar');
  assert.strictEqual(vf.streamable, true);
  assert.ok(mounts.has(vf.id), 'mount registered for streaming');
  assert.strictEqual(session.history.length, 3, 'dead + compressed + good all recorded');
  assert.match(session.history[0].outcome, /missing|mount|nzb/);
  assert.match(session.history[1].outcome, /unstreamable/);
  assert.ok(elapsed < 5000, `pipeline under the 5s cold budget (took ${elapsed}ms)`);
  // Playback read-ahead boost: streamable mounts leave the conservative default behind, while
  // decoded segment retention stays byte-capped so large 4K posts cannot balloon memory.
  for (const v of (vf.vols || [vf])) {
    assert.strictEqual(v.readAhead, 12, 'playback mount read-ahead boosted');
    assert.strictEqual(v.cacheMax, 36, 'playback mount cache window boosted without retaining too many decoded segments');
    assert.strictEqual(v.cacheMaxBytes, 96 * 1024 * 1024, 'playback mount cache byte budget set');
  }

  // Bytes are the proof: stream the mounted result and compare.
  const chunks = [];
  for await (const c of vf.read(0, vf.size)) chunks.push(c);
  assert.ok(Buffer.concat(chunks).equals(payload), 'streamed bytes byte-exact');

  // Verdict cache: a fresh search must now demote the compressed and dead candidates.
  const { candidates } = await pipeline.search({ q: 'movie' }, { maxResolutionRank: 3 });
  assert.strictEqual(candidates[0].name, 'Movie.2024.1080p.WEBRip.x264-GECKOS', 'verdict-informed re-rank');
  const compC = candidates.find((c) => c.name.includes('FGT'));
  assert.strictEqual(compC.streamClass, 'compressed', 'compressed verdict cached');

  pool.close(); await mock.close(); ix.server.close(); store.close();
});

test('pipeline: 4K preferred — when every UHD source is dead, fall back to the best healthy lower-res instead of failing', async () => {
  // Owner rule: keep trying the preferred (4K) tier until one works; only when ZERO healthy 4K
  // remain, fall back to 1080p. The 4K toggle sets exactResolutionRank, which scores every non-4K
  // below the playable cut — so the 1080p must NOT be reachable until the UHD tier is exhausted.
  const payload = seededPayload(120 * 1024, 0x4ca);
  const good1080 = nzbFor([{ name: 'HotD.S03E01.1080p.WEB-DL.mkv', data: payload }], 30000, 'h1080');
  const dead4kA = nzbFor([{ name: 'HotD.S03E01.2160p.A.mkv', data: seededPayload(60 * 1024, 7) }], 30000, 'd4ka');
  const dead4kB = nzbFor([{ name: 'HotD.S03E01.2160p.B.mkv', data: seededPayload(60 * 1024, 8) }], 30000, 'd4kb');

  // Mock NNTP holds ONLY the 1080p articles — every 2160p article 430s (provider source rot).
  const mock = createMockNntp({ articles: new Map([...good1080.articles]) });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 6);

  const ix = makeMockIndexer([
    { name: 'House.of.the.Dragon.S03E01.2160p.HMAX.WEB-DL.DDP5.1.H.265-NTb', size: 8e9, nzb: dead4kA.nzb },
    { name: 'House.of.the.Dragon.S03E01.2160p.AMZN.WEB-DL.DDP5.1.H.265-FLUX', size: 8e9, nzb: dead4kB.nzb },
    { name: 'House.of.the.Dragon.S03E01.1080p.WEB-DL.DDP5.1.H.264-NTb', size: 4e9, nzb: good1080.nzb },
  ]);
  const ixPort = await ix.listen();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  const r = await pipeline.play({ q: 'House of the Dragon' }, { maxResolutionRank: 4, preferResolutionRank: 4, exactResolutionRank: 4 });
  assert.match(r.candidate.name, /1080p/, 'fell back to the healthy 1080p after both 2160p sources 430d');
  assert.strictEqual(r.relaxedResolution, 4, 'signals the UI that the preferred 4K was relaxed to a lower res');
  assert.strictEqual(r.vf.streamable, true, 'the fallback release actually mounts + streams');

  pool.close(); await mock.close(); ix.server.close(); store.close();
});

test('pipeline: playback warmup pre-fetches BOTH the head and the tail (container index) so remux/ExoPlayer parse hits warm cache', async () => {
  // Regression for "plays fine, then buffers after a minute": the remux/ExoPlayer parse the
  // container index (mkv Cues / mp4 moov, usually at the END for WEB-DL) before streaming. A cold
  // tail made those seeks multi-second uncached reads → the remux trickled below the play bitrate
  // for ~30s and the startup buffer drained. The warmup must warm the tail too, not just the head.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({ pool: () => null, verdicts: new VerdictCache(store), mounts: new Map(), indexers: () => [] });
  const reads = [];
  const size = 8e9; // a "big" (4K) mount
  const fakeVf = {
    streamable: true, size,
    read(from, to) { reads.push([from, to]); return (async function* () {})(); },
  };
  pipeline._startPlaybackWarmup(fakeVf, { cacheMaxBytes: 1024 * 1024 * 1024 });
  await new Promise((r) => setTimeout(r, 300)); // warmup fires on a 150ms timer
  assert.ok(reads.some(([f]) => f === 0), 'warms the head from offset 0');
  assert.ok(reads.some(([, t]) => t === size), 'warms the TAIL up to EOF (mkv Cues / mp4 moov)');
  store.close();
});

test('pipeline: playback warmup warms the RESUME byte window so a Continue-Watching resume is not a cold seek', async () => {
  // A resume seeks straight to a deep mid-file byte offset that the head/tail warm never primed —
  // the 20-30s native resume lag. resumeFrac (resume seconds / duration, supplied by the client)
  // warms THAT window on the read-ahead lane (plus only a small head, since the head isn't played on
  // a resume). With NO resumeFrac the behaviour is unchanged (full head + tail).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({ pool: () => null, verdicts: new VerdictCache(store), mounts: new Map(), indexers: () => [] });
  const size = 8e9; // a "big" (4K) mount
  const reads = [];
  const resumeVf = { streamable: true, size, read(from, to) { reads.push([from, to]); return (async function* () {})(); } };
  pipeline._startPlaybackWarmup(resumeVf, { cacheMaxBytes: 1024 * 1024 * 1024 }, 0.5); // resume at ~50%
  await new Promise((r) => setTimeout(r, 300));
  const mid = size * 0.5;
  assert.ok(reads.some(([f, t]) => f <= mid && t >= mid), 'warms a byte window covering the ~50% resume offset');
  assert.ok(reads.some(([f]) => f === 0), 'still warms a (small) head for the container-header parse');

  const reads2 = [];
  const freshVf = { streamable: true, size, read(from, to) { reads2.push([from, to]); return (async function* () {})(); } };
  pipeline._startPlaybackWarmup(freshVf, { cacheMaxBytes: 1024 * 1024 * 1024 }); // no resumeFrac
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(reads2.some(([f]) => f === 0) && reads2.some(([, t]) => t === size), 'no resumeFrac → classic head + tail warm');
  assert.ok(!reads2.some(([f, t]) => f > size * 0.2 && t < size * 0.8), 'no resumeFrac → no mid-file resume warm');
  store.close();
});

test('pipeline: active mount rebalance shrinks read-ahead when another stream starts', async () => {
  const now = Date.now();
  const mounts = new Map();
  const pipeline = new Pipeline({
    pool: () => null,
    verdicts: { get: () => null, set: () => {} },
    mounts,
    performance: () => ({
      usableConnections: 20,
      reserveConnections: 4,
      maxConnPerStream1080: 12,
      maxConnPerStream4k: 20,
    }),
  });
  const mk = (id) => ({
    id, size: 2e9, streamable: true, _touched: now, trimCalls: 0,
    trimCache() { this.trimCalls++; },
  });

  const first = mk('first');
  mounts.set(first.id, first);
  assert.strictEqual(pipeline.rebalancePlaybackWindows(now), 1);
  assert.strictEqual(first.readAhead, 12, 'single active stream gets the configured 1080p window');
  assert.strictEqual(first.maxReadAhead, 12, 'single stream cannot boost past the configured 1080p cap');
  assert.strictEqual(first.cacheMaxBytes, 96 * 1024 * 1024, 'single stream gets the full 1080p cache budget');

  const second = mk('second');
  mounts.set(second.id, second);
  assert.strictEqual(pipeline.rebalancePlaybackWindows(now), 2);
  assert.strictEqual(first.readAhead, 8, 'existing stream shrinks to the fair connection share');
  assert.strictEqual(second.readAhead, 8, 'new stream receives the same fair connection share');
  assert.strictEqual(first.maxReadAhead, 9, 'existing stream may only borrow bounded spare reserve');
  assert.strictEqual(second.maxReadAhead, 9, 'new stream boost ceiling matches the fair reserve model');
  assert.strictEqual(first.cacheMaxBytes, 48 * 1024 * 1024, 'existing stream cache budget shrinks with concurrency');
  assert.strictEqual(second.cacheMaxBytes, 48 * 1024 * 1024, 'new stream cache budget matches concurrency');
  assert.ok(first.trimCalls >= 2, 'rebalance trims retained decoded bytes after shrinking');
  assert.strictEqual(pipeline.metricsSnapshot().windowRebalances, 2, 'rebalance telemetry should track window recalculations');
});

test('pipeline: 4K buffer seconds raise decoded segment retention for small article posts', async () => {
  const now = Date.now();
  const mounts = new Map();
  const pipeline = new Pipeline({
    pool: () => null,
    verdicts: { get: () => null, set: () => {} },
    mounts,
    performance: () => ({
      usableConnections: 119,
      reserveConnections: 24,
      maxConnPerStream4k: 18,
      buffer4kSec: 120,
    }),
  });
  const vf = {
    id: 'uhd',
    size: 7 * 1024 * 1024 * 1024,
    partSize: 700 * 1024,
    segments: Array.from({ length: 10486 }, (_, i) => ({ msgId: `seg${i}` })),
    streamable: true,
    _touched: now,
    _tracks: { duration: 700 }, // 7 GB / 700 s ≈ 86 Mbps — a high-bitrate 4K (DV/HDR) stream
    trimCache() {},
  };
  mounts.set(vf.id, vf);

  assert.strictEqual(pipeline.rebalancePlaybackWindows(now), 1);
  assert.strictEqual(vf.readAhead, 18, '4K stream still respects the configured connection window');
  // The byte budget is now sized from the file's REAL ~86 Mbps bitrate, not a fixed 24 Mbps — so it
  // is far deeper than the old 360 MB (~38s) that froze on latency spikes. (Bounded by ~20% RAM.)
  assert.ok(vf.cacheMaxBytes > 360 * 1024 * 1024,
    '120s goal on a high-bitrate 4K file maps to a much deeper decoded-byte budget than the old fixed sizing');
  assert.ok(vf.cacheMax >= Math.ceil(vf.cacheMaxBytes / vf.partSize),
    'segment cap should be high enough to retain the decoded-byte budget for small articles');
});

test('pipeline: playback warmup is bounded and stays below active playback priority', async () => {
  const pipeline = new Pipeline({
    pool: () => null,
    verdicts: { get: () => null, set: () => {} },
    mounts: new Map(),
  });
  const calls = [];
  const vf = {
    streamable: true,
    size: 7 * 1024 * 1024 * 1024,
    async *read(start, end, opts = {}) {
      calls.push({ start, end, priority: opts.priority });
      yield Buffer.alloc(1);
    },
  };

  pipeline._startPlaybackWarmup(vf, { cacheMaxBytes: 360 * 1024 * 1024 });
  pipeline._startPlaybackWarmup(vf, { cacheMaxBytes: 360 * 1024 * 1024 });
  await new Promise((resolve) => setTimeout(resolve, 220));

  // Once per mounted source (the 2nd call is deduped), and ONE warmup now warms the head AND the
  // tail (container index) — so two reads, not four. Both stay on the low-priority read-ahead lane.
  assert.strictEqual(calls.length, 2, 'warmup starts once per mounted source (head + tail), even if called twice');
  assert.deepStrictEqual(calls[0], {
    start: 0,
    end: 96 * 1024 * 1024,
    priority: 'readAhead',
  }, '4K warmup should fill a bounded HEAD chunk on the low-priority lane');
  assert.deepStrictEqual(calls[1], {
    start: vf.size - 48 * 1024 * 1024,
    end: vf.size,
    priority: 'readAhead',
  }, '4K warmup should also warm the TAIL (mkv Cues / mp4 moov) on the low-priority lane');
});

test('pipeline: a manual Sources pick is honored first, then the next-smaller release, then the best auto-pick', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({ pool: () => null, verdicts: new VerdictCache(store), mounts: new Map(), indexers: () => [] });
  const cands = [
    { pickKey: 'e', sizeBytes: 40e9, score: -6000 }, // bigger than the pick → never a fallback
    { pickKey: 'p', sizeBytes: 38e9, score: -6000 }, // over-cap manual pick (auto-scorer would reject it)
    { pickKey: 'b', sizeBytes: 30e9, score: -6000 }, // the single next-smaller release → tried 2nd
    { pickKey: 'c', sizeBytes: 15e9, score: 200 },    // best auto-ranked (within cap)
    { pickKey: 'd', sizeBytes: 12e9, score: 100 },
  ];
  const order = pipeline._playableCandidates(cands, { pickKey: 'p' }).map((c) => c.pickKey);
  assert.deepStrictEqual(order, ['p', 'b', 'c', 'd'],
    'manual pick honored first (even over-cap), then ONE next-smaller by size, then best auto-ranked; a bigger-than-pick release is never a fallback');
  const auto = pipeline._playableCandidates(cands, {}).map((c) => c.pickKey);
  assert.deepStrictEqual(auto, ['c', 'd'], 'with no manual pick, only within-cap auto-ranked releases are playable');
  store.close();
});

test('pipeline: auto-advance mounts the next candidate when the current source dies', async () => {
  const pay1 = seededPayload(90 * 1024, 11);
  const pay2 = seededPayload(90 * 1024, 22);
  const r1 = nzbFor(writeRar4Store([{ name: 'A.mkv', data: pay1 }], { base: 'r1' }), 30000, 'r1');
  const r2 = nzbFor(writeRar4Store([{ name: 'B.mkv', data: pay2 }], { base: 'r2' }), 30000, 'r2');
  const articles = new Map([...r1.articles, ...r2.articles]);
  const mock = createMockNntp({ articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const ix = makeMockIndexer([
    { name: 'Movie.2024.1080p.WEB-DL.H.264-FLUX', size: 7e9, nzb: r1.nzb },
    { name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', size: 7e9, nzb: r2.nzb },
  ]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const mounts = new Map();
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts,
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  const first = await pipeline.play({ q: 'movie' }, {});
  assert.strictEqual(first.candidate.name, 'Movie.2024.1080p.WEB-DL.H.264-FLUX');

  // Mid-stream death of source 1 → player calls advance → source 2 mounts, byte-exact.
  const next = await pipeline.advance(first.session.id);
  assert.strictEqual(next.candidate.name, 'Movie.2024.1080p.WEB-DL.H.264-NTb');
  assert.notStrictEqual(next.vf.id, first.vf.id);
  const chunks = [];
  for await (const c of next.vf.read(0, next.vf.size)) chunks.push(c);
  assert.ok(Buffer.concat(chunks).equals(pay2), 'advanced source streams byte-exact');

  await assert.rejects(() => pipeline.advance('nope'), /unknown play session/);

  pool.close(); await mock.close(); ix.server.close(); store.close();
});

test('pipeline: resume re-checks health and auto-advances when the saved source died while away', async () => {
  // Continue Watching gap: a source that mounted and streamed fine can ROT on the provider
  // before the user resumes (retention expiry / DMCA takedown). On resume the player re-checks
  // health (the /api/health route runs vf.triage); a now-blocked verdict must hand off to a
  // healthy source so the user resumes from their timestamp instead of staring at a dead stream.
  const pay1 = seededPayload(300 * 1024, 71);
  const pay2 = seededPayload(300 * 1024, 72);
  const r1 = nzbFor([{ name: 'Resume.A.mkv', data: pay1 }], 30000, 'res1');
  const r2 = nzbFor([{ name: 'Resume.B.mkv', data: pay2 }], 30000, 'res2');
  const mock = createMockNntp({ articles: new Map([...r1.articles, ...r2.articles]) });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 6);
  const ix = makeMockIndexer([
    { name: 'Resume.Movie.2024.1080p.WEB-DL.H.264-FLUX', size: 7e9, nzb: r1.nzb },
    { name: 'Resume.Movie.2024.1080p.WEB-DL.H.264-NTb', size: 7e9, nzb: r2.nzb },
  ]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  try {
    // Initial watch: source 1 mounts and is healthy.
    const first = await pipeline.play({ q: 'Resume Movie 2024' }, {});
    assert.strictEqual(first.candidate.name, 'Resume.Movie.2024.1080p.WEB-DL.H.264-FLUX');
    assert.strictEqual((await first.vf.triage(100)).verdict, 'verified', 'source is healthy at first watch');

    // ...time passes; every article of source 1 is taken down on the provider.
    for (const id of r1.articles.keys()) mock.markMissing(id);

    // Resume re-checks health on the SAME live mount: it must now report blocked, never silently
    // serve dead bytes. (A cached "verified" from the first watch would defeat the whole point.)
    const recheck = await first.vf.triage(100);
    assert.strictEqual(recheck.verdict, 'blocked', 'resume health re-check catches the rotted source live');

    // The player hands off to the next ranked source, byte-exact and seekable to the resume point.
    const resumed = await pipeline.advance(first.session.id);
    assert.strictEqual(resumed.candidate.name, 'Resume.Movie.2024.1080p.WEB-DL.H.264-NTb');
    assert.notStrictEqual(resumed.vf.id, first.vf.id, 'resume mounts a fresh healthy source, not the dead one');
    const chunks = [];
    for await (const c of resumed.vf.read(0, resumed.vf.size)) chunks.push(c);
    assert.ok(Buffer.concat(chunks).equals(pay2), 'resumed healthy source streams byte-exact');
    // A deep cold seek to the resume timestamp must also be exact on the recovered source.
    const seekStart = Math.floor(resumed.vf.size * 0.6);
    const seek = [];
    for await (const c of resumed.vf.read(seekStart, resumed.vf.size, { priority: 'seek' })) seek.push(c);
    assert.ok(Buffer.concat(seek).equals(pay2.subarray(seekStart)), 'resume-point seek on the recovered source is byte-exact');
  } finally {
    pool.close(); await mock.close(); ix.server.close(); store.close();
  }
});

test('pipeline: multi-user concurrent VOD streams stay byte-exact and never exceed the connection cap', async () => {
  // Real-world gap (docs-architecture / CLAUDE.md "still open"): several 1080p/4K starts and
  // seeks at once must ALL stream correctly while sharing one provider's bounded connection
  // pool — no stream starves, every byte stays exact, and the pool never opens more sockets than
  // its cap (a connection leak under load would exhaust the provider and "stick buffering").
  const { VirtualFile } = require('../server/vfs');
  const STREAMS = 4;
  const POOL = 12;
  const releases = Array.from({ length: STREAMS }, (_, i) => {
    const data = seededPayload(512 * 1024 + i * 4096, 0xd00 + i); // distinct sizes + seeds
    return { ...nzbFor([{ name: `Concurrent${i}.mkv`, data }], 48 * 1024, `cc${i}`), data };
  });
  const articles = new Map();
  for (const r of releases) for (const [k, v] of r.articles) articles.set(k, v);
  const mock = createMockNntp({ articles, latencyMs: 12 }); // simulate provider RTT under load
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, POOL);

  try {
    const vfs = [];
    for (const r of releases) {
      const vf = new VirtualFile(pool, r.nzb, { readAhead: 4 });
      await vf.mount();
      vfs.push(vf);
    }

    const t0 = Date.now();
    // Each "user" does a full sequential read AND a deep cold seek — all four concurrently,
    // contending for the same 12 connections.
    const results = await Promise.all(vfs.map(async (vf, i) => {
      const data = releases[i].data;
      const full = [];
      for await (const c of vf.read(0, vf.size, { priority: 'startup' })) full.push(c);
      const seekStart = Math.floor(vf.size * 0.7);
      const seek = [];
      for await (const c of vf.read(seekStart, vf.size, { priority: 'seek' })) seek.push(c);
      return { full: Buffer.concat(full), seek: Buffer.concat(seek), data, seekStart };
    }));
    const elapsed = Date.now() - t0;

    for (let i = 0; i < STREAMS; i++) {
      assert.ok(results[i].full.equals(results[i].data), `stream ${i} full read byte-exact under contention`);
      assert.ok(results[i].seek.equals(results[i].data.subarray(results[i].seekStart)),
        `stream ${i} cold seek byte-exact under contention`);
    }
    assert.ok(mock.connCount() <= POOL,
      `pool stayed within its ${POOL}-connection cap (opened ${mock.connCount()}) — no leaked connections under load`);
    assert.ok(elapsed < 15000, `four concurrent streams finished within budget (${elapsed}ms)`);
  } finally {
    pool.close(); await mock.close();
  }
});

test('pipeline: explicit pickKey mounts the chosen source before auto-pick', async () => {
  const autoPayload = seededPayload(90 * 1024, 51);
  const pickedPayload = seededPayload(90 * 1024, 52);
  const auto = nzbFor(writeRar4Store([{ name: 'Auto.mkv', data: autoPayload }], { base: 'auto' }), 30000, 'auto');
  const picked = nzbFor(writeRar4Store([{ name: 'Picked.mkv', data: pickedPayload }], { base: 'picked' }), 30000, 'picked');
  const mock = createMockNntp({ articles: new Map([...auto.articles, ...picked.articles]) });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const ix = makeMockIndexer([
    { name: 'Manual.Pick.2024.1080p.WEB-DL.H.264-FLUX', size: 6e9, nzb: auto.nzb },
    { name: 'Manual.Pick.2024.1080p.BluRay.REMUX.AVC-FraMeSToR', size: 49e9, nzb: picked.nzb },
  ]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  try {
    const { candidates } = await pipeline.search({ q: 'Manual Pick 2024' }, {});
    assert.strictEqual(candidates[0].name, 'Manual.Pick.2024.1080p.WEB-DL.H.264-FLUX',
      'auto-pick remains the faster/smaller source');
    const remux = candidates.find((c) => c.name.includes('REMUX'));
    assert.ok(remux && remux.pickKey, 'manual Sources row has a stable pick key');

    const first = await pipeline.play({ q: 'Manual Pick 2024' }, {});
    assert.strictEqual(first.candidate.name, 'Manual.Pick.2024.1080p.WEB-DL.H.264-FLUX',
      'initial play mounts the auto-pick first');
    const firstChunks = [];
    for await (const c of first.vf.read(0, first.vf.size)) firstChunks.push(c);
    assert.ok(Buffer.concat(firstChunks).equals(autoPayload), 'initial auto source streams byte-exact');

    const r = await pipeline.play({ q: 'Manual Pick 2024', pickKey: remux.pickKey }, {});
    assert.strictEqual(r.candidate.name, remux.name, 'manual source pick is mounted first, not auto-pick');
    assert.notStrictEqual(r.vf.id, first.vf.id, 'manual source swap creates/returns the selected mount, not the old active one');
    const chunks = [];
    for await (const c of r.vf.read(0, r.vf.size)) chunks.push(c);
    assert.ok(Buffer.concat(chunks).equals(pickedPayload), 'picked source streams byte-exact');
  } finally {
    pool.close(); await mock.close(); ix.server.close(); store.close();
  }
});

test('pipeline: quality policy streams the matching 1080p or 4K source bytes', async () => {
  const hdPayload = seededPayload(90 * 1024, 61);
  const uhdPayload = seededPayload(90 * 1024, 62);
  const hd = nzbFor(writeRar4Store([{ name: 'Quality.1080p.mkv', data: hdPayload }], { base: 'quality-hd' }), 30000, 'quality-hd');
  const uhd = nzbFor(writeRar4Store([{ name: 'Quality.2160p.mkv', data: uhdPayload }], { base: 'quality-uhd' }), 30000, 'quality-uhd');
  const mock = createMockNntp({ articles: new Map([...hd.articles, ...uhd.articles]) });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const ix = makeMockIndexer([
    { name: 'Quality.Match.2024.2160p.WEB-DL.HEVC-FLUX', size: 16e9, nzb: uhd.nzb },
    { name: 'Quality.Match.2024.1080p.WEB-DL.H.264-NTb', size: 6e9, nzb: hd.nzb },
  ]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });
  const readAll = async (vf) => {
    const chunks = [];
    for await (const c of vf.read(0, vf.size)) chunks.push(c);
    return Buffer.concat(chunks);
  };

  try {
    const hdPlay = await pipeline.play(
      { q: 'Quality Match 2024' },
      { maxResolutionRank: 3, preferResolutionRank: 3 }
    );
    assert.strictEqual(hdPlay.candidate.attributes.resolution, '1080p',
      '1080p selection should mount a 1080p source');
    assert.ok((await readAll(hdPlay.vf)).equals(hdPayload),
      '1080p selection should stream bytes from the 1080p NZB');

    const uhdPlay = await pipeline.play(
      { q: 'Quality Match 2024' },
      { maxResolutionRank: 4, preferResolutionRank: 4, exactResolutionRank: 4 }
    );
    assert.strictEqual(uhdPlay.candidate.attributes.resolution, '2160p',
      '4K selection should mount a 2160p source');
    assert.ok(uhdPlay.session.candidates.every((c) => c.attributes.resolution === '2160p'),
      '4K selection should not leave a 1080p source in the playable queue');
    assert.ok((await readAll(uhdPlay.vf)).equals(uhdPayload),
      '4K selection should stream bytes from the 2160p NZB');
  } finally {
    pool.close(); await mock.close(); ix.server.close(); store.close();
  }
});

test('pipeline: 4K toggle with no 4K source falls back to the best available instead of failing', async () => {
  // "I tapped 4K and nothing plays": exactResolutionRank=4 disqualifies every non-4K release, so a
  // title with only a 1080p source would throw. The fallback re-ranks without the exact lock.
  const hdPayload = seededPayload(90 * 1024, 63);
  const hd = nzbFor(writeRar4Store([{ name: 'Only.1080p.mkv', data: hdPayload }], { base: 'only-hd' }), 30000, 'only-hd');
  const mock = createMockNntp({ articles: new Map([...hd.articles]) });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const ix = makeMockIndexer([
    { name: 'No4K.Movie.2024.1080p.WEB-DL.H.264-NTb', size: 6e9, nzb: hd.nzb },
  ]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });
  try {
    const r = await pipeline.play({ q: 'No4K Movie 2024' },
      { maxResolutionRank: 4, preferResolutionRank: 4, exactResolutionRank: 4 });
    assert.strictEqual(r.candidate.name, 'No4K.Movie.2024.1080p.WEB-DL.H.264-NTb',
      'falls back to the best available 1080p instead of throwing "no playable releases"');
    assert.strictEqual(r.candidate.attributes.resolution, '1080p');
    const chunks = [];
    for await (const c of r.vf.read(0, r.vf.size)) chunks.push(c);
    assert.ok(Buffer.concat(chunks).equals(hdPayload), 'fallback source streams byte-exact');
  } finally {
    pool.close(); await mock.close(); ix.server.close(); store.close();
  }
});

test('pipeline: a picked SAMPLE file fails the candidate and auto-advance finds the feature', async () => {
  // Real incident: a sample-only post ("From.S01E01.GERMAN.DL.2160p" — 68MB) mounted its
  // sample.mkv and auto-played as the episode. The indexer DECLARED a big size, so scoring
  // can't catch it — the mount-level name guard must.
  const pay1 = seededPayload(90 * 1024, 33);
  const pay2 = seededPayload(90 * 1024, 44);
  const r1 = nzbFor(writeRar4Store([{ name: 'movie.2024.2160p-grp-sample.mkv', data: pay1 }], { base: 's1' }), 30000, 's1');
  const r2 = nzbFor(writeRar4Store([{ name: 'Movie.mkv', data: pay2 }], { base: 's2' }), 30000, 's2');
  const mock = createMockNntp({ articles: new Map([...r1.articles, ...r2.articles]) });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const ix = makeMockIndexer([
    // FLUX outranks NTb (trusted-group tier), so the sample post is GUARANTEED first pick;
    // it lies about its size, so only the mount-level name guard can catch it.
    { name: 'Movie.2024.1080p.WEB-DL.H.264-FLUX', size: 7e9, nzb: r1.nzb },
    { name: 'Movie.2024.1080p.WEB-DL.H.264-NTb', size: 7e9, nzb: r2.nzb },
  ]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });

  try {
    const r = await pipeline.play({ q: 'movie' }, {});
    assert.strictEqual(r.candidate.name, 'Movie.2024.1080p.WEB-DL.H.264-NTb', 'sample post skipped');
    assert.ok(r.attempts.some((a) => /sample/i.test(a.fail)), 'failure names the sample pick');
  } finally {
    // finally: an assertion failure must not leak sockets — a leaked mock server keeps the
    // test runner's event loop alive forever, which reads as a "hung" suite.
    pool.close(); await mock.close(); ix.server.close(); store.close();
  }
});

test('pipeline: stubFeatureReason rejects a tiny file masquerading as a real feature (the 220MB-as-4K bug)', () => {
  // The Mortal Kombat II incident: a ~220MB file auto-played as a "2160p movie" because the indexer's
  // DECLARED size lied past scoring; only a check on the ACTUAL mounted bytes can catch it.
  assert.ok(/stub|incomplete/i.test(stubFeatureReason(220 * 1e6, 'Mortal.Kombat.II.2026.2160p.WEB-DL.DV.HDR-Grp')),
    '220MB is rejected for a 2160p release');
  assert.match(stubFeatureReason(220 * 1e6, 'Movie.2024.2160p-Grp'), /2160p/);
  assert.ok(stubFeatureReason(50 * 1e6, 'Whatever.no.res.tag'), '50MB rejected even with no resolution tag (<80MB floor)');
  assert.ok(stubFeatureReason(150 * 1e6, 'Show.S01E01.1080p.WEB-Grp'), '150MB rejected for a 1080p claim (<300MB)');
  // Real features pass — and an unknown size is never guessed at.
  assert.strictEqual(stubFeatureReason(8 * 1e9, 'Movie.2024.2160p.WEB-DL-Grp'), '', '8GB 2160p is a real feature');
  assert.strictEqual(stubFeatureReason(600 * 1e6, 'Movie.2024.no.res'), '', '600MB no-res file passes the 80MB floor');
  assert.strictEqual(stubFeatureReason(0, 'Movie.2024.2160p'), '', 'unknown size (0) is not flagged');
});

test('pipeline: summarizeAttempts turns raw fail reasons into one actionable sentence', () => {
  // Dead-source title (the real Mortal Kombat II 2026 case): removed + encrypted + stub.
  const dead = summarizeAttempts([
    { fail: 'mount: BODY abc: 430 No Such Article' },
    { fail: 'unstreamable: encrypted,headers-encrypted' },
    { fail: 'stub/incomplete: only 220MB for a 2160p release' },
    { fail: 'mount: BODY def: 430 No Such Article' },
  ]);
  assert.match(dead, /No healthy source/i);
  assert.match(dead, /2 removed\/missing/);
  assert.match(dead, /1 password-protected/);
  assert.match(dead, /1 incomplete\/sample/);
  assert.match(dead, /add more indexers/i);

  // Slow-connection title: mostly timeouts => a DIFFERENT, connection-focused headline.
  const slow = summarizeAttempts([
    { fail: 'mount: mount timeout' }, { fail: 'mount: mount timeout' }, { fail: 'health: blocked' },
  ]);
  assert.match(slow, /timing out/i);

  // Unreachable providers (VPN/port/creds) must read as a CONNECTION problem, NOT "removed/missing"
  // — the exact mislabel that sent the owner chasing source rot when nothing could connect.
  const down = summarizeAttempts([
    { fail: 'provider unreachable: no usenet provider could be reached (connection/VPN/port/credentials)' },
    { fail: 'mount: connect ETIMEDOUT 1.2.3.4:563' },
    { fail: 'nzb: fetch-failed' },
  ]);
  assert.match(down, /connection problem/i);
  assert.doesNotMatch(down, /removed\/missing/);
  assert.match(down, /Settings . Providers|VPN/i);

  assert.match(summarizeAttempts([]), /No sources were available/i);
});

test('nntp: ProviderPool never opens more than its configured size, even under heavy concurrent load', async () => {
  // The owner's guarantee: "if I set 100 on Newshosting, the app must never open more than 100."
  // Fire far more concurrent fetches than the cap and prove simultaneous connections stay <= size.
  const payload = seededPayload(40 * 1024, 0x31);
  const r = nzbFor(writeRar4Store([{ name: 'cap.mkv', data: payload }], { base: 'cap' }), 30000, 'cap');
  const mock = createMockNntp({ articles: r.articles });
  const port = await mock.listen();
  const SIZE = 3;
  const pool = new ProviderPool({ host: '127.0.0.1', port, tls: false }, SIZE);
  const msgIds = [...r.articles.keys()];
  try {
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, pool.conns.length + pool.connecting); }, 2);
    const tasks = [];
    for (let i = 0; i < 30; i++) tasks.push(pool.body(msgIds[i % msgIds.length]).catch(() => null)); // 30 ≫ 3
    await Promise.all(tasks);
    clearInterval(sampler);
    peak = Math.max(peak, pool.conns.length + pool.connecting);
    assert.ok(peak <= SIZE, `pool peaked at ${peak} simultaneous connections for size=${SIZE} — must never exceed the cap`);
  } finally { pool.close(); await mock.close(); }
});

test('nntp: pool stats report per-provider connection usage (host + in-use/open/size) without credentials', async () => {
  const payload = seededPayload(40 * 1024, 0x42);
  const r = nzbFor(writeRar4Store([{ name: 'stat.mkv', data: payload }], { base: 'stat' }), 30000, 'stat');
  const mock = createMockNntp({ articles: r.articles });
  const port = await mock.listen();
  const SIZE = 4;
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false, user: 'secret-user', pass: 'secret-pass' }, SIZE);
  const msgIds = [...r.articles.keys()];
  try {
    const idle = pool.stats();
    assert.strictEqual(idle.providers.length, 1, 'one provider in the pool');
    assert.strictEqual(idle.providers[0].host, '127.0.0.1', 'stats expose the host label');
    assert.strictEqual(idle.providers[0].size, SIZE, 'stats expose the configured cap');
    assert.strictEqual(idle.inUse, 0, 'nothing in use before any fetch');
    assert.ok(!JSON.stringify(idle).includes('secret'), 'connection stats never leak credentials');

    let peakInUse = 0;
    const sampler = setInterval(() => { peakInUse = Math.max(peakInUse, pool.stats().inUse); }, 2);
    await Promise.all(Array.from({ length: 12 }, (_, i) => pool.body(msgIds[i % msgIds.length]).catch(() => null)));
    clearInterval(sampler);
    assert.ok(peakInUse > 0 && peakInUse <= SIZE, `in-use connections (${peakInUse}) tracked and bounded by the cap`);
    assert.strictEqual(pool.stats().inUse, 0, 'in-use returns to zero once work drains');
  } finally { pool.close(); await mock.close(); }
});

test('nntp: combined stat throws NO_PROVIDER when unreachable (so a down link is not mislabeled "missing")', async () => {
  // 127.0.0.1:1 refuses instantly — stands in for "no provider reachable" (VPN/port/firewall).
  const pool = new NntpPool({ host: '127.0.0.1', port: 1, tls: false }, 2);
  try {
    // Opt-in: callers that need to tell "down" from "article gone" get a throw, not a silent false.
    await assert.rejects(
      () => pool.stat('x@y.test', 'health', { throwIfUnreachable: true }),
      (e) => e.code === 'NO_PROVIDER',
      'unreachable providers reject with NO_PROVIDER',
    );
    // Legacy contract unchanged: without the opt, an unreachable stat still resolves false.
    assert.strictEqual(await pool.stat('x@y.test', 'health'), false, 'default stat stays false (back-compat)');
  } finally { pool.close(); }
});

test('scoring: sample-size stubs and foreign-language dubs sink; duals stay honest fallbacks', () => {
  // The 68MB "2160p" sample post is disqualified outright on its DECLARED size…
  const ranked = rankReleases([
    { name: 'From.S01E01.GERMAN.DL.2160p.WEB.H265-VoDTv', sizeBytes: 68e6 },
    { name: 'FROM.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX', sizeBytes: 3e9 },
  ], {});
  assert.strictEqual(ranked[0].name.includes('FLUX'), true);
  assert.ok(ranked[1].score < -5000, `sample-size post disqualified (got ${ranked[1].score})`);
  // …while a legit small SD episode is merely "tiny", not dead.
  const sd = rankReleases([{ name: 'Old.Show.S01E01.480p.DVDRip.x264-GRP', sizeBytes: 250e6 }], {});
  assert.ok(sd[0].score > -5000, 'small SD episode stays playable');

  // Language: English-native > foreign DUAL > dubbed-only, even when the dub has more pixels.
  const lang = rankReleases([
    { name: 'Movie.2024.GERMAN.2160p.WEB.H265-DUB', sizeBytes: 12e9 },        // dubbed only
    { name: 'Movie.2024.GERMAN.DL.2160p.WEB.H265-VoDTv', sizeBytes: 12e9 },   // dual (orig audio aboard)
    { name: 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', sizeBytes: 7e9 },    // English-native
  ], {});
  assert.strictEqual(lang[0].name.includes('FLUX'), true, 'English 1080p beats foreign 2160p');
  assert.ok(lang.findIndex((c) => c.name.includes('DL.2160p')) < lang.findIndex((c) => c.name.includes('H265-DUB')),
    'dual ranks above dubbed-only');

  const foreignOriginal = rankReleases([
    { name: 'Parasite.2019.KOREAN.1080p.BluRay.x264-GRP', sizeBytes: 9e9 },
    { name: 'Parasite.2019.KOREAN.DL.1080p.BluRay.x264-GRP', sizeBytes: 9e9 },
    { name: 'Parasite.2019.GERMAN.2160p.WEB.H265-DUB', sizeBytes: 12e9 },
  ], { originalLanguage: 'ko', preferredAudioLanguage: 'en' });
  assert.ok(foreignOriginal[0].name.includes('KOREAN.DL.1080p'),
    'foreign-original titles prefer original-language dual/multi-audio when English audio is desired');
  assert.ok(foreignOriginal.findIndex((c) => c.name.includes('KOREAN.1080p')) <
    foreignOriginal.findIndex((c) => c.name.includes('GERMAN.2160p')),
    'original-language release beats unrelated dubbed 4K for non-English originals');
});

test('store: a failing flush never throws and retries once the disk recovers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const s = new Store(dir);
  s.write('t', { a: 1 });
  const realDir = s.dir;
  s.dir = path.join(realDir, 'does', 'not', 'exist'); // both write paths will fail
  assert.doesNotThrow(() => s.flush(), 'flush failure must not propagate (it once crashed prod)');
  assert.ok(s.dirty.has('t'), 'table stays dirty for retry');
  s.dir = realDir;
  s.flush();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(realDir, 't.json'), 'utf8')), { a: 1 });
  s.close();
});

test('store: data directory is owner-only on POSIX filesystems', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const s = new Store(dir);
  try {
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
    }
  } finally {
    s.close();
  }
});

test('store: atomic persistence round-trip and verdict TTL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const s1 = new Store(dir);
  s1.write('users', { admin: { name: 'a' } });
  s1.flush();
  const s2 = new Store(dir);
  assert.deepStrictEqual(s2.read('users'), { admin: { name: 'a' } });

  const vc = new VerdictCache(s2, 50);
  vc.set('k1', 'verified', { streamClass: 'store' });
  assert.strictEqual(vc.get('k1').verdict, 'verified');
  return new Promise((r) => setTimeout(() => {
    assert.strictEqual(vc.get('k1'), null, 'verdict expired after TTL');
    s1.close(); s2.close(); r();
  }, 80));
});

test('verdict cache: NZB keys are sanitized hashes and legacy secret URLs are scrubbed', () => {
  const a = nzbVerdictKey('https://api.nzbgeek.info/api?t=get&id=abc&apikey=secret-one');
  const b = nzbVerdictKey('https://api.nzbgeek.info/api?apikey=secret-two&id=abc&t=get');
  assert.strictEqual(a, b, 'API key differences do not affect the stable verdict key');
  assert.ok(a.startsWith('nzb:'), 'verdict key is namespaced');
  assert.ok(!a.includes('secret'), 'secret is not present in the key');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  store.write('verdicts', {
    'https://api.nzbgeek.info/api?t=get&id=abc&apikey=secret-one': { verdict: 'missing', checkedAt: Date.now() },
    'nzb:already-safe': { verdict: 'verified', checkedAt: Date.now() },
  });
  store.flush();
  const verdicts = new VerdictCache(store);
  store.flush();
  const raw = JSON.stringify(store.read('verdicts', {}));
  assert.ok(!raw.includes('secret-one'), 'legacy URL key with API key is removed');
  assert.strictEqual(verdicts.get('nzb:already-safe').verdict, 'verified', 'safe key survives scrub');
  store.close();
});

test('pipeline: cheap missing-article probe skips stale NZBs past the old four-source cap', async () => {
  const goodPayload = seededPayload(100 * 1024, 0x5ca1e);
  const dead = Array.from({ length: 5 }, (_, i) =>
    nzbFor([{ name: `Dead${i}.mkv`, data: seededPayload(50 * 1024, i + 1) }], 30000, `dead${i}`));
  const good = nzbFor(writeRar4Store([{ name: 'Movie.mkv', data: goodPayload }], { base: 'good-after-dead' }), 30000, 'good-after-dead');

  const mock = createMockNntp({ articles: new Map([...good.articles]) });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const ix = makeMockIndexer([
    ...dead.map((d, i) => ({ name: `Movie.2024.1080p.WEB-DL.H.264-DEAD${i}`, size: 5e9, nzb: d.nzb })),
    { name: 'Movie.2024.1080p.WEB-DL.H.264-GOOD', size: 5e9, nzb: good.nzb },
  ]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const verdicts = new VerdictCache(store);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts, mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'secret-indexer-key' }],
  });

  const started = Date.now();
  const r = await pipeline.play({ q: 'movie' }, { maxResolutionRank: 3 });
  assert.strictEqual(r.candidate.name, 'Movie.2024.1080p.WEB-DL.H.264-GOOD');
  assert.strictEqual(r.attempts.length, 5, 'five stale sources were skipped before the good one');
  assert.ok(r.attempts.every((a) => /^missing:/.test(a.fail)), JSON.stringify(r.attempts));
  assert.ok(Date.now() - started < 5000, 'missing sources are skipped by STAT, not slow BODY mounts');
  const keys = Object.keys(store.read('verdicts', {}));
  assert.ok(keys.every((k) => k.startsWith('nzb:') || k.startsWith('t:')), 'verdict keys do not persist raw NZB URLs');
  assert.ok(!JSON.stringify(store.read('verdicts', {})).includes('secret-indexer-key'), 'verdict cache does not persist indexer secrets');

  pool.close(); await mock.close(); ix.server.close(); store.close();
});

test('pipeline: slow first-article probe does not reject an otherwise playable source', async () => {
  const payload = seededPayload(90 * 1024, 0x51a0);
  const good = nzbFor([{ name: 'Movie.mkv', data: payload }], 200000, 'slow-probe');

  // Simulate a healthy provider that answers just after the cheap 800ms startup STAT budget.
  // The probe is only an optimization; timeout must continue into the real mount path.
  const mock = createMockNntp({ articles: new Map([...good.articles]), latencyMs: 950 });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const ix = makeMockIndexer([
    { name: 'Movie.2024.1080p.WEB-DL.H.264-SLOWPROBE', size: 5e9, nzb: good.nzb },
  ]);
  const ixPort = await ix.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-test-'));
  const store = new Store(dir);
  const verdicts = new VerdictCache(store);
  const pipeline = new Pipeline({
    pool: () => pool, verdicts, mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'secret-indexer-key' }],
  });

  const r = await pipeline.play({ q: 'movie' }, { maxResolutionRank: 3 });
  assert.strictEqual(r.candidate.name, 'Movie.2024.1080p.WEB-DL.H.264-SLOWPROBE');
  assert.deepStrictEqual(r.attempts, [], 'slow STAT preflight is not a candidate failure');
  const verdictJson = JSON.stringify(store.read('verdicts', {}));
  assert.ok(!verdictJson.includes('probe-timeout'), 'slow preflight does not poison the verdict cache');

  pool.close(); await mock.close(); ix.server.close(); store.close();
});

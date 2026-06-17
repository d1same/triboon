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
const { parseNewznabRss, dedupe, fanout } = require('../server/newznab');
const { Store, VerdictCache } = require('../server/store');
const { Pipeline, GATE_MS } = require('../server/pipeline');
const { NntpPool } = require('../server/nntp');
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
  const forBlu = pickSub(data, 'Show.S01E01.1080p.BluRay.x264-GRP.mkv');
  assert.strictEqual(forBlu.id, 1, 'BluRay source matches the BluRay sub');
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
  assert.notStrictEqual(pickSub(data, '').id, 3, 'bitmap formats never win');
  assert.ok(pickSub([{ id: 9, format: 'srt' }], '') === undefined, 'url-less results are skipped entirely');
});

// A response that TRICKLES (a byte under every idle window) defeats socket timeouts — only a
// hard total deadline stops it. Same lesson as the NNTP stall bug: timeouts on every wire.
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

test('newznab: fan-out keeps the fast indexer when another times out', async () => {
  const fast = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rssFor([{ name: 'Movie.1080p.WEB-DL-FLUX', url: 'http://f/1', size: 5e9 }]));
  });
  const slow = http.createServer(() => { /* never responds */ });
  await new Promise((r) => fast.listen(0, '127.0.0.1', r));
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));

  const t0 = Date.now();
  const { results, errors } = await fanout([
    { name: 'fast', url: `http://127.0.0.1:${fast.address().port}`, apikey: 'k' },
    { name: 'slow', url: `http://127.0.0.1:${slow.address().port}`, apikey: 'k' },
  ], { q: 'movie' }, { timeoutMs: 400 });
  const elapsed = Date.now() - t0;

  assert.strictEqual(results.length, 1);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].error, /timeout/);
  assert.ok(elapsed < 1500, `fan-out bounded by budget (took ${elapsed}ms)`);
  fast.close(); slow.close();
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

  const [search, play] = await Promise.all([
    pipeline.search({ q: 'Movie 2024' }),
    pipeline.play({ q: 'Movie 2024' }),
  ]);

  assert.strictEqual(indexerFanouts, 1, 'a quick Play should join the active detail-page warmup search');
  assert.strictEqual(search.candidates[0].name, 'Movie.2024.1080p.WEB-DL.H.264-NTb');
  assert.strictEqual(play.candidate.name, 'Movie.2024.1080p.WEB-DL.H.264-NTb');

  pool.close(); await mock.close(); server.close(); store.close();
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
    { name: 'Movie.2024.1080p.BluRay.REMUX.TrueHD-FraMeSToR', size: 9e9, nzb: dead.nzb },
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
  assert.match(session.history[0].outcome, /mount|nzb/);
  assert.match(session.history[1].outcome, /unstreamable/);
  assert.ok(elapsed < 5000, `pipeline under the 5s cold budget (took ${elapsed}ms)`);
  // Playback read-ahead boost: streamable mounts leave the conservative default behind so
  // the buffer runs ahead of the player (4 GB+ releases get an even bigger window).
  for (const v of (vf.vols || [vf])) {
    assert.strictEqual(v.readAhead, 12, 'playback mount read-ahead boosted');
    assert.strictEqual(v.cacheMax, 48, 'playback mount cache window boosted');
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

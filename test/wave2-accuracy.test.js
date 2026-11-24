'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreRelease, rankReleases, parseRelease, releaseLanguageTags } = require('../server/scoring');
const { parseWantedTitle, releaseMatches, releaseQualifies, Pipeline } = require('../server/pipeline');
const { parseNewznabRss, stripSubjectWrapper } = require('../server/newznab');
const { pickPrimaryFile } = require('../server/nzb');

test('wave2: English titles containing nationality words are not penalized as foreign-dub', () => {
  const italianJob = scoreRelease({ name: 'The.Italian.Job.2003.1080p.BluRay.x264-GRP', sizeBytes: 9e9 }, { preferredAudioLanguage: 'en' });
  assert.ok(!italianJob.reasons.some((r) => r.startsWith('foreign-dub')), `The Italian Job should not get foreign-dub: ${italianJob.reasons.join(', ')}`);

  const frenchDispatch = scoreRelease({ name: 'The.French.Dispatch.2021.1080p.WEB-DL.DDP5.1.H.264-FLUX', sizeBytes: 7e9 }, { preferredAudioLanguage: 'en' });
  assert.ok(!frenchDispatch.reasons.some((r) => r.startsWith('foreign-dub')), 'The French Dispatch should not get foreign-dub');

  const danishGirl = scoreRelease({ name: 'The.Danish.Girl.2015.1080p.BluRay.x264-SPARKS', sizeBytes: 8e9 }, { preferredAudioLanguage: 'en' });
  assert.ok(!danishGirl.reasons.some((r) => r.startsWith('foreign-dub')), 'The Danish Girl should not get foreign-dub');

  // Actual French dub of The Italian Job STILL gets penalized!
  const frenchDubOfItalianJob = scoreRelease({ name: 'The.Italian.Job.2003.FRENCH.1080p.BluRay.x264-GRP', sizeBytes: 9e9 }, { preferredAudioLanguage: 'en' });
  assert.ok(frenchDubOfItalianJob.reasons.some((r) => r.startsWith('foreign-dub')), 'FRENCH after year must still be caught as foreign-dub');

  // Yearless title with policy.wantedTitle also skips nationality word in title
  const yearlessItalian = scoreRelease({ name: 'The.Italian.Job.1080p.BluRay.x264-GRP', sizeBytes: 9e9 }, { preferredAudioLanguage: 'en', wantedTitle: 'The Italian Job' });
  assert.ok(!yearlessItalian.reasons.some((r) => r.startsWith('foreign-dub')), 'yearless The Italian Job with wantedTitle skips title prefix');

  // New language tags recognized cleanly
  assert.deepEqual(releaseLanguageTags('Movie.2024.PERSIAN.1080p.WEB-DL-GRP'), ['fa']);
  assert.deepEqual(releaseLanguageTags('Movie.2024.DUBLADO.1080p.WEB-DL-GRP'), ['pt']);
});

test('wave2: Dolby Vision Profile 5 vs DV+HDR10 hybrid and -DV group guard', () => {
  assert.ok(!parseRelease('Movie.2024.1080p.WEB-DL.H.264-DV').features.includes('dovi'), '-DV release group must not trigger dovi');
  assert.ok(parseRelease('Movie.2024.2160p.DV.WEB-DL.HEVC-FLUX').features.includes('dovi'), '.DV. token triggers dovi');

  const dvOnly = scoreRelease({ name: 'Movie.2024.2160p.DV.WEB-DL.HEVC-FLUX', sizeBytes: 14e9 }, { dolbyVision: false, maxResolutionRank: 4 });
  const dvHdr = scoreRelease({ name: 'Movie.2024.2160p.DV.HDR.WEB-DL.HEVC-FLUX', sizeBytes: 14e9 }, { dolbyVision: false, maxResolutionRank: 4 });
  assert.ok(dvHdr.score > dvOnly.score + 80, `DV+HDR10 hybrid (${dvHdr.score}) must strongly outrank Profile-5 DV-only (${dvOnly.score}) on non-DV screen`);

  const browserDvOnly = scoreRelease({ name: 'Movie.2024.2160p.DV.WEB-DL.HEVC-FLUX', sizeBytes: 14e9 }, { maxResolutionRank: 4 });
  const browserHdr = scoreRelease({ name: 'Movie.2024.2160p.HDR.WEB-DL.HEVC-FLUX', sizeBytes: 14e9 }, { maxResolutionRank: 4 });
  assert.ok(browserHdr.score > browserDvOnly.score, 'plain HDR beats Profile-5 DV-only on browser');
});

test('wave2: DDP+Atmos plays cleanly on E-AC-3 devices without -45 penalty, and unsupported plain DTS is penalized', () => {
  const eac3Tv = scoreRelease(
    { name: 'Movie.2024.2160p.WEB-DL.DDP5.1.Atmos.HEVC-FLUX', sizeBytes: 14e9 },
    { maxResolutionRank: 4, audioEac3: true, audioEac3Joc: false, audioPassthrough: false },
  );
  assert.ok(!eac3Tv.reasons.some((r) => r.includes('unsupported-atmos')), 'DDP+Atmos plays E-AC-3 core natively on E-AC-3 TV');

  const dtsNoSupport = scoreRelease(
    { name: 'Movie.2024.1080p.BluRay.DTS.x264-GRP', sizeBytes: 9e9 },
    { maxResolutionRank: 4, audioDts: false, audioDecodesLossless: false },
  );
  assert.ok(dtsNoSupport.reasons.some((r) => r.includes('unsupported-dts -65')), 'plain DTS is penalized when device has no DTS decode');
});

test('wave2: season pack exempt from full-season oversized/device-4k-size penalties while single episode still wins ties', () => {
  const pack = { name: 'Show.S01.2160p.WEB-DL.HEVC-FLUX', sizeBytes: 48e9 };
  const single = { name: 'Show.S01E03.2160p.WEB-DL.HEVC-FLUX', sizeBytes: 5e9 };
  const policy = { maxResolutionRank: 4, lowPowerDevice: true, wantedEpisode: { s: 1, e: 3 } };
  const sp = scoreRelease(pack, policy);
  const ss = scoreRelease(single, policy);
  assert.ok(!sp.reasons.some((r) => r.startsWith('oversized') || r.startsWith('device-4k-size')),
    `season pack must not get full-season size penalties: ${sp.reasons.join(', ')}`);
  assert.ok(ss.score > sp.score, 'equal-quality single episode still beats season pack');
  assert.ok(sp.score > 0, `4K season pack stays healthy-scored (${sp.score}), not buried at -1000`);
});

test('wave2: non-US dominant shows (Dark, Kingdom) accept untagged releases when no dominant sibling exists', () => {
  const dark = parseWantedTitle('Dark S01E01');
  dark.year = 2017;
  dark.country = 'other';
  dark.otherYears = [1998];
  dark.hasDominantSibling = false;
  assert.ok(releaseMatches('Dark.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb', dark),
    'Dark (DE) with only an obscure sibling must accept untagged Dark.S01E01');

  // Same show WITH a matching indexer TVDB ID also accepts untagged even if hasDominantSibling is true
  const darkStrict = { ...dark, hasDominantSibling: true };
  assert.ok(releaseQualifies({ name: 'Dark.S01E01.1080p.NF.WEB-DL-NTb', tvdbid: '334824' }, darkStrict, { tvdbid: '334824' }),
    'matching indexer TVDB id verifies untagged non-US episode');
});

test('wave2: anime [Group] prefix strip, attribute-order-independent newznab attr(), and 3-digit episodes', () => {
  assert.equal(stripSubjectWrapper('[SubsPlease] Jujutsu.Kaisen.S02E01.1080p.WEB-DL.mkv'), 'Jujutsu.Kaisen.S02E01.1080p.WEB-DL.mkv');
  assert.equal(stripSubjectWrapper('[1080p] Movie.2024.mkv'), '[1080p] Movie.2024.mkv');

  const rss = `<rss><channel><item>
    <title>Test.Movie.2024.1080p.WEB-DL-NTb</title>
    <guid>g1</guid>
    <enclosure url="http://ix/1.nzb" length="5000000000" type="application/x-nzb"/>
    <newznab:attr value="tt1234567" name="imdb"/>
    <newznab:attr value="998877" name="tvdbid"/>
  </item></channel></rss>`;
  const rows = parseNewznabRss(rss, 'ix');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imdb, 'tt1234567');
  assert.equal(rows[0].tvdbid, '998877');

  // Hiatus air-year tolerance for modern multi-year streaming seasons (e.g. 2016 -> S05 in 2025)
  const st = parseWantedTitle('Stranger Things S05E01');
  st.year = 2016;
  assert.ok(releaseMatches('Stranger.Things.2025.S05E01.2160p.NF.WEB-DL-FLUX', st));
});

test('wave2: obfuscated exact-episode NZB with 1 main payload + tiny sample picks the main payload', () => {
  const files = [
    { subject: '"a1b2c3d4e5.mkv" yEnc (1/100)', segments: [{ bytes: 2000 * 1024 * 1024 }] },
    { subject: '"z9y8x7w6v5.mkv" yEnc (1/5)', segments: [{ bytes: 15 * 1024 * 1024 }] },
  ];
  const picked = pickPrimaryFile({ files }, {
    wantedEpisode: { s: 1, e: 2 },
    releaseName: 'Show.S01E02.1080p.WEB-DL-FLUX',
  });
  assert.equal(picked, files[0], 'dominant >=10x obfuscated payload on exact-episode release is selected');
});

test('wave2: fetch-failed verdict does not poison other indexers via title verdict key', () => {
  const saved = new Map();
  const pipeline = new Pipeline({
    pool: () => null,
    verdicts: { get: (k) => saved.get(k) || null, set: (k, v, d) => saved.set(k, { verdict: v, detail: d }) },
    mounts: new Map(),
  });
  pipeline._recordVerdict({ name: 'Heat.1995.1080p.BluRay-FLUX', nzbUrl: 'http://ix-a/1.nzb' }, 'fetch-failed');
  assert.ok(saved.has('u:http://ix-a/1.nzb') || [...saved.keys()].some((k) => !k.startsWith('t:')), 'failing URL verdict recorded');
  assert.ok(![...saved.keys()].some((k) => k.startsWith('t:')), 'fetch-failed must NOT write a title-wide verdict');
});

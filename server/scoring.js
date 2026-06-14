'use strict';
// TRaSH-Guides-style release scoring (clean-room, our own weights). A release name is parsed
// into attributes, then scored by weighted custom formats. Triboon adds signals the arrs lack:
// streamability (store RAR beats 🐢 compressed beats blocked) and live health verdicts.
// Crucially this is tuned for PRESS-PLAY, not archiving: quality within the user's cap wins,
// and a giant remux does NOT outscore a clean direct-play release for a capped device.

const RES = [
  { key: '2160p', score: 0, rank: 4, re: /\b(2160p|4k|uhd)\b/i },
  { key: '1080p', score: 0, rank: 3, re: /\b1080p\b/i },
  { key: '720p', score: 0, rank: 2, re: /\b720p\b/i },
  { key: '576p', score: 0, rank: 1, re: /\b576p\b/i },
  { key: '480p', score: 0, rank: 0, re: /\b(480p|sd)\b/i },
];

// Source tiers — Remux is top quality but huge; WEB-DL is the press-play sweet spot.
const SOURCE = [
  { key: 'remux', score: 120, re: /\b(remux|bdremux)\b/i },
  { key: 'bluray', score: 100, re: /\b(blu-?ray|bdrip|brrip)\b/i },
  { key: 'web-dl', score: 95, re: /\b(web-?dl|webdl)\b/i },
  { key: 'webrip', score: 70, re: /\bweb-?rip\b/i },
  { key: 'hdtv', score: 40, re: /\bhdtv\b/i },
  { key: 'dvd', score: 20, re: /\b(dvdrip|dvd)\b/i },
  { key: 'cam', score: -1000, re: /\b(cam|ts|telesync|telecine|hdcam|hdts)\b/i },
];

// Video codecs — efficiency matters for streaming/direct-play compatibility.
const CODEC = [
  { key: 'av1', score: 18, re: /\b(av1)\b/i },
  { key: 'hevc', score: 30, re: /\b(hevc|h\.?265|x265)\b/i },
  { key: 'avc', score: 25, re: /\b(avc|h\.?264|x264)\b/i },
  { key: 'xvid', score: -20, re: /\b(xvid|divx)\b/i },
];

// HDR / audio enrichers (additive, like TRaSH custom formats).
const FEATURE = [
  { key: 'dovi', score: 18, re: /\b(dv|dolby[ .]?vision|dovi)\b/i },
  { key: 'hdr10plus', score: 14, re: /\b(hdr10\+|hdr10plus)\b/i },
  { key: 'hdr', score: 10, re: /\b(hdr|pq|bt2020)\b/i },
  { key: 'atmos', score: 14, re: /\b(atmos)\b/i },
  { key: 'truehd', score: 10, re: /\b(truehd)\b/i },
  { key: 'dts-hd', score: 9, re: /\b(dts-?hd|dts-?x|dtsma)\b/i },
  { key: 'ddp', score: 6, re: /\b(ddp|eac3|dd\+)\b/i },
  { key: 'repack', score: 8, re: /\b(repack|rerip)\b/i },
  { key: 'proper', score: 6, re: /\bproper\b/i },
  { key: 'imax', score: 6, re: /\b(imax)\b/i },
  { key: 'multi', score: 3, re: /\b(multi|dual[ .]?audio)\b/i },
];

// Release-group tiers (small representative list; admin-extensible in Phase 4 settings).
const GROUP_TIER = [
  { score: 50, groups: ['FLUX', 'NTb', 'TEPES', 'CtrlHD', 'EbP', 'FraMeSToR', 'HiDt', 'SMURF', 'D-Z0N3'] },
  { score: 25, groups: ['RARBG', 'FGT', 'LEGION', 'LEGi0N', 'SPARKS', 'AMIABLE', 'GECKOS'] },
  { score: -50, groups: ['YTS', 'YIFY', 'GALAXYRG', 'RMTEAM', 'MEGUSTA', 'TGX', 'AOC', 'PSA'] }, // re-encoders
];
const BAD_FLAGS = [
  { key: 'hardcoded-subs', score: -200, re: /\b(hc|korsub|hardsub)\b/i },
  { key: 'upscaled', score: -150, re: /\b(upscal|fake4k)\b/i },
  { key: 'sample', score: -1000, re: /\bsample\b/i },
];

// NOT THE MOVIE — disqualified outright (below the pipeline's -5000 playability cutoff).
// Both bit real users: a brand-new film with no video releases auto-played its SOUNDTRACK
// album (FLAC + cover art), and "Inception ... Special Features BluRay REMUX" (the 59-min
// bonus disc) outranked the actual film.
const NOT_THE_MOVIE = [
  { key: 'soundtrack', re: /\b(ost|soundtracks?|original[ ._-]+(motion[ ._-]+picture|tv|series)?[ ._-]*soundtrack|score[ ._-]+album)\b/i },
  { key: 'extras-disc', re: /\b(special[ ._-]+features?|bonus[ ._-]+(disc|features?|content)|extras[ ._-]+only|behind[ ._-]+the[ ._-]+scenes|featurettes?|deleted[ ._-]+scenes)\b/i },
];
// Audio-only heuristic: music-format markers WITHOUT any video marker. (FLAC alone must NOT
// trigger — real movie remuxes carry FLAC *audio tracks* next to 2160p/x265 markers.)
const VIDEO_MARKER = /\b(2160p|1080p|720p|576p|480p|x26[45]|h[. ]?26[45]|hevc|avc|xvid|divx|av1|blu-?ray|web[ ._-]?(dl|rip)|hdtv|remux|bd(rip|remux)?|dvd(rip)?|hdr|dovi|dv)\b/i;
const AUDIO_MARKER = /\b(flac|mp3|m4a|alac|24bit|16bit|44[.1]*khz|48khz|96khz|vinyl|cd[ ._-]?rip|discography|web[ ._-]?flac)\b/i;
function notTheMovie(name) {
  for (const t of NOT_THE_MOVIE) if (t.re.test(name)) return t.key;
  if (AUDIO_MARKER.test(name) && !VIDEO_MARKER.test(name)) return 'audio-only';
  return null;
}

function matchOne(name, table) {
  for (const t of table) if (t.re.test(name)) return t;
  return null;
}
function groupOf(name) {
  const m = /-([A-Za-z0-9]+)(?:\.[A-Za-z0-9]+)?$/.exec(name.trim());
  return m ? m[1] : null;
}

// Parse a release name into structured attributes.
function parseRelease(name) {
  const res = matchOne(name, RES);
  const source = matchOne(name, SOURCE);
  const codec = matchOne(name, CODEC);
  const features = FEATURE.filter((f) => f.re.test(name)).map((f) => f.key);
  const bad = BAD_FLAGS.filter((b) => b.re.test(name)).map((b) => b.key);
  const group = groupOf(name);
  let groupScore = 0, groupClass = 'unknown';
  if (group) {
    for (const tier of GROUP_TIER) {
      if (tier.groups.some((g) => g.toLowerCase() === group.toLowerCase())) {
        groupScore = tier.score; groupClass = tier.score > 0 ? 'trusted' : 'low-quality'; break;
      }
    }
  }
  return {
    resolution: res ? res.key : 'unknown', resolutionRank: res ? res.rank : 2,
    source: source ? source.key : 'unknown', codec: codec ? codec.key : 'unknown',
    features, bad, group, groupScore, groupClass,
  };
}

// Explicit foreign-language tags in scene names. English-tagged or untagged releases are
// assumed original-language; MULTi/DL/dual carry the original track alongside the dub.
const LANG_TAG = /\b(german|french|italian|ita|spanish|castellano|latino|hindi|tamil|telugu|polish|turkish|nordic|swedish|norwegian|danish|finnish|dutch|flemish|russian|rus|czech|hungarian|korean|japanese|vostfr|truefrench)\b/i;
const DUAL_TAG = /\b(dl|dual|multi|2audio|\d?audios|ita[ ._-]?eng|eng[ ._-]?ita)\b/i;

// Streamability + health → score. Store RAR / flat = instant; compressed = playable but slow;
// encrypted/unsupported = unplayable in Phase 1.
const STREAM_SCORE = { flat: 60, store: 60, compressed: -300, encrypted: -100000, unsupported: -100000 };
const HEALTH_SCORE = {
  verified: 40, unverified: 0, degraded: -120, blocked: -100000,
  'mount-failed': -400, 'fetch-failed': -200, // remembered failures from the verdict cache
};

// Score one candidate against a user policy.
//   candidate: { name, sizeBytes?, streamClass?, health?, indexer?, ... }
//   policy:    { maxResolutionRank? (0..4), preferSmaller?, sizePreferenceGB? }
function scoreRelease(candidate, policy = {}) {
  const a = parseRelease(candidate.name);
  const reasons = [];
  let score = 0;
  const add = (label, n) => { if (n) { score += n; reasons.push(`${label} ${n > 0 ? '+' : ''}${n}`); } };

  // Resolution within the cap. Over-cap is disqualified so "1080p" means pick a 1080p
  // source, not a better-scored 4K source that will later need transcoding.
  // Unknown resolution is treated as neutral — never penalized as over-cap, never boosted as
  // if it were 720p (a missing token must not outrank a known low-res or get an SD user rejected).
  const cap = Number.isInteger(policy.maxResolutionRank) ? policy.maxResolutionRank : 4;
  if (a.resolution === 'unknown') add('res unknown', 0);
  else if (a.resolutionRank > cap) add(`over-cap ${a.resolution}`, -100000);
  else add(`res ${a.resolution}`, a.resolutionRank * 30); // higher allowed res preferred
  if (Number.isInteger(policy.exactResolutionRank) && a.resolutionRank !== policy.exactResolutionRank) {
    add(`not-requested-resolution ${a.resolution}`, -100000);
  }
  // An EXPLICIT resolution pick (the detail-page 4K toggle) outweighs source/size shaping —
  // the user asked for this resolution, so matching releases lead; others stay as fallbacks.
  if (Number.isInteger(policy.preferResolutionRank) && a.resolution !== 'unknown'
      && a.resolutionRank === policy.preferResolutionRank && a.resolutionRank <= cap) {
    add(`preferred ${a.resolution}`, 400);
  }

  const src = matchOne(candidate.name, SOURCE); if (src) add(`source ${src.key}`, src.score);
  const cod = matchOne(candidate.name, CODEC); if (cod) add(`codec ${cod.key}`, cod.score);
  for (const f of FEATURE) if (f.re.test(candidate.name)) add(f.key, f.score);
  for (const b of BAD_FLAGS) if (b.re.test(candidate.name)) add(b.key, b.score);
  // Soundtracks / bonus discs / bare music rips are never what "press play on a movie" means.
  const ntm = notTheMovie(candidate.name);
  if (ntm) add(`not-the-movie:${ntm}`, -100000);
  // Language shaping (TRaSH "language: not original" spirit): a GERMAN.DL 2160p once beat
  // the English 1080p on resolution alone. Dubbed-only releases sink hard; DUAL releases
  // (DL / MULTi / ITA-ENG — original audio still aboard) take a milder hit so they stay
  // honest fallbacks when nothing English-native exists.
  if (LANG_TAG.test(candidate.name)) {
    add(DUAL_TAG.test(candidate.name) ? 'foreign-dual' : 'foreign-dub',
      DUAL_TAG.test(candidate.name) ? -150 : -350);
  }

  // Admin scoring tweaks (TRaSH-style "custom formats" lite). The built-in weights are the
  // recommended default; admin entries EXTEND them — and for group tiers, OVERRIDE them.
  const cs = policy.customScoring || {};
  let gScore = a.groupScore, gClass = a.groupClass;
  if (a.group) {
    const g = a.group.toLowerCase();
    if ((cs.groupsTrusted || []).some((x) => String(x).toLowerCase() === g)) { gScore = 50; gClass = 'trusted·admin'; }
    else if ((cs.groupsAvoid || []).some((x) => String(x).toLowerCase() === g)) { gScore = -50; gClass = 'avoid·admin'; }
  }
  if (gScore) add(`group ${a.group} (${gClass})`, gScore);
  for (const k of cs.keywords || []) {
    if (!k || !k.term || !Number.isFinite(+k.score)) continue;
    // Word-boundary match; spaces in the term match any scene separator (dot/dash/underscore).
    const safe = String(k.term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[ ._-]');
    try {
      if (new RegExp(`\\b${safe}\\b`, 'i').test(candidate.name)) {
        add(`custom:${k.term}`, Math.max(-5000, Math.min(5000, Math.round(+k.score))));
      }
    } catch { /* a malformed term never breaks ranking */ }
  }

  if (candidate.streamClass && candidate.streamClass in STREAM_SCORE) {
    add(`stream:${candidate.streamClass}`, STREAM_SCORE[candidate.streamClass]);
  }
  if (candidate.health && candidate.health in HEALTH_SCORE) {
    add(`health:${candidate.health}`, HEALTH_SCORE[candidate.health]);
  }

  // Size shaping for press-play (not archiving): a 60GB remux must NOT be the default pick —
  // its NZB alone takes tens of seconds to fetch and parse, killing time-to-first-frame.
  // Penalty ramps hard past 2× the target so the Sources drawer still offers it to remux fans.
  if (candidate.sizeBytes) {
    const gb = candidate.sizeBytes / 1e9;
    // HARD size cap (admin "max release size"): over-cap releases are neither offered in the
    // Sources drawer nor auto-played. 4K has its own cap; everything else (incl. unknown res,
    // which COULD be a mislabeled monster) falls under the 1080p cap.
    const hardCap = a.resolutionRank >= 4 && a.resolution !== 'unknown' ? policy.maxSizeGb4k : policy.maxSizeGb1080;
    if (hardCap && gb > hardCap) add(`over-size-cap ${gb.toFixed(1)}GB>${hardCap}GB`, -100000);
    // Targets sized for instant start (NZB fetch+parse time scales with release size):
    // 4K ≈ 15GB (good HDR WEB-DL territory), 1080p ≈ 8GB, 720p ≈ 3.5GB. Penalty past 1.6×,
    // CLAMPED at -400: enough to keep a 50GB remux from ever auto-playing, but unclamped it
    // sank legit remuxes below outright junk and out of the Sources drawer entirely —
    // "I can't find any big 4K movies". Hiding is the manual cap's job, not the shaper's.
    const target = policy.sizePreferenceGB || (cap >= 4 ? 15 : cap >= 3 ? 8 : 3.5);
    const overshoot = Math.max(0, gb - target * 1.6);
    if (overshoot > 0) add(`oversized ${gb.toFixed(1)}GB`, -Math.min(400, Math.round(overshoot * 25)));
    // Sample/stub disqualifier: a "2160p" post weighing 68MB IS the sample, not the show —
    // one auto-played as the real episode (-120 "suspiciously tiny" was nowhere near enough).
    // Floors: nothing real is <80MB; nothing claiming 1080p/2160p is <300MB.
    if (gb < 0.08 || (gb < 0.3 && a.resolutionRank >= 3 && a.resolution !== 'unknown')) {
      add(`sample-or-stub ${(gb * 1000).toFixed(0)}MB`, -100000);
    } else if (gb < 0.2) add('suspiciously tiny', -120);
  }

  return { score: Math.round(score), attributes: a, reasons };
}

// Rank a list of candidates (highest score first), attaching scoring detail. Stable for ties.
function rankReleases(candidates, policy = {}) {
  return candidates
    .map((c, i) => ({ ...c, ...scoreRelease(c, policy), _i: i }))
    .sort((x, y) => (y.score - x.score) || (x._i - y._i))
    .map(({ _i, ...c }) => c);
}

module.exports = { parseRelease, scoreRelease, rankReleases, notTheMovie, RES, SOURCE };

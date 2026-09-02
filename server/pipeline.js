'use strict';
// The press-play pipeline: fan-out search → TRaSH-style ranking within the user's cap →
// fetch NZB → mount → bounded health gate (≤500ms soft) → stream URL + ranked alternates.
// Verdicts from every attempt feed the two-tier cache so the next press of Play is smarter.
// Auto-advance: the player calls /api/advance with the session id; we mount the next
// candidate and the client resumes at its last timestamp.

const os = require('os');
const debug = require('./debug');
// System RAM is fixed for the process lifetime — read it ONCE at load, not per Range request. The
// read-ahead window sizing below (_playbackWindowFor) runs on the hot streaming path, and
// os.totalmem() was being re-read on every rebalance. ~20% is the cross-stream buffer budget.
const TOTAL_MEM_MB = Math.floor(os.totalmem() / (1024 * 1024));
const { fanout, fetchUrl, normTitle } = require('./newznab');

// ---- title verification ----
// Split a search query into title words + structured parts (year, SxxEyy).
function tokenizeWanted(q) {
  const out = { words: [], year: null, s: null, e: null };
  // Catalog titles spell "&" but scene names spell "and" (Law & Order → Law.and.Order) — the "&"
  // produced NO token, so `law, order` could never consecutively match `law, and, order` and whole
  // franchises were unfindable. Convert to the word; releaseMatches treats "and" as skippable, so
  // releases that DROP it (Law.Order.…) still match too.
  const toks = String(q || '').toLowerCase().replace(/&/g, ' and ').split(/\s+/).filter(Boolean);
  // The movie query is "title … year", so ONLY the TRAILING year-shaped token is the release year; a
  // year-shaped token earlier in the string is part of the TITLE ("1917", "2012", "2001 A Space Odyssey",
  // "Blade Runner 2049"). Without this, a bare-year title was swallowed as the year → ZERO title words →
  // the anchor + structural-boundary checks were skipped and ANY film within ±1 year matched (a wrong
  // movie would play), while the film's own release was rejected.
  let lastYearIdx = -1;
  for (let i = toks.length - 1; i >= 0; i--) { if (/^(19|20)\d{2}$/.test(toks[i])) { lastYearIdx = i; break; } }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const m = /^s(\d{1,2})e(\d{1,3})$/.exec(t);
    if (m) { out.s = +m[1]; out.e = +m[2]; continue; }
    if (i === lastYearIdx) { out.year = +t; continue; }
    // Apostrophes vanish in scene names ("Dont") but every OTHER separator becomes a word break —
    // fusing "spider-noir" into "spidernoir" could never match "Spider.Noir.S01E01" (release names
    // normalize all punctuation to spaces), so the title was unfindable.
    for (const w of (t.replace(/['’`]/g, '').match(/[a-z0-9]+/g) || [])) out.words.push(w);
  }
  // A query that is ONLY a year (1917 the movie, 1923 the show) must still ANCHOR on that number.
  // Swallowing it as the year left ZERO title words, so any same-episode release matched — including
  // Yellowstone.S01E01 for a play of 1923. Drop the year filter; the digits ARE the title.
  if (!out.words.length && out.year !== null) { out.words.push(String(out.year)); out.year = null; }
  return out;
}

// Catalog titles use "Franchise: Unique name" or "Brand's Unique name". The unique half is what
// scene names often use (Lioness.S02E01, Fellowship.of.the.Ring.2001). The shared half must NEVER
// be enough on its own — that is how Fellowship used to play Two Towers. Apostrophes inside a word
// (Sorcerer's Stone) are not a brand split. One-word possessives are only brands (Marvel's Daredevil),
// never the first word of the real title (Grey's Anatomy, The Queen's Gambit, It's Always Sunny).
const POSSESSIVE_BRANDS = new Set([
  'marvel', 'dc', 'disney', 'pixar', 'lucasfilm', 'netflix', 'amazon', 'apple',
  'hbo', 'bbc', 'fx', 'amc', 'syfy', 'cbs', 'nbc', 'abc', 'paramount', 'peacock',
  'hulu', 'showtime', 'starz',
]);
const POSSESSIVE_PREFIX_ARTICLES = new Set(['the', 'a', 'an']);

function catalogUniqueRaw(raw) {
  const s = String(raw || '').trim();
  const colon = s.indexOf(':');
  if (colon >= 0) {
    const unique = s.slice(colon + 1).trim();
    if (unique) return unique;
  }
  const poss = /^((?:[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,2}))['’]s\s+(.+)$/i.exec(s);
  if (!poss || !poss[2]) return '';
  const prefixCore = String(poss[1]).toLowerCase().split(/\s+/)
    .filter((w) => w && !POSSESSIVE_PREFIX_ARTICLES.has(w));
  if (prefixCore.length >= 2) return poss[2].trim();
  if (prefixCore.length === 1 && POSSESSIVE_BRANDS.has(prefixCore[0])) return poss[2].trim();
  return '';
}

const GENERIC_ALIAS_HEAD = new Set(['part', 'chapter', 'volume', 'episode', 'season', 'book', 'act']);

function aliasWordsIfSafe(full, unique) {
  const aliasCore = titleCoreWords(unique.words);
  const fullCore = titleCoreWords(full.words);
  if (!aliasCore.length || aliasCore.join(' ') === fullCore.join(' ')) return [];
  const hasEpisode = Number.isInteger(full.s) && Number.isInteger(full.e) && full.e > 0;
  // One leftover word is only safe with a TV episode (Lioness.S02E01). Movies need two+ unique
  // words so "Mission: Impossible" cannot play a film named Impossible, and LOTR cannot collapse
  // to "the ring".
  if (aliasCore.length === 1 && (!hasEpisode || aliasCore[0].length < 6)) return [];
  // "Dune: Part Two" / "John Wick: Chapter 4" unique halves are generic. Keep the full catalog
  // title as the match so Part.Two.2024 cannot play as Dune.
  if (GENERIC_ALIAS_HEAD.has(aliasCore[0]) && aliasCore.length <= 2) return [];
  return unique.words;
}

function episodeOrdinalAlias(unique) {
  const w = unique.words || [];
  if (w[0] === 'episode' && w[1] && /^(?:[ivxlcdm]+|\d{1,2})$/.test(w[1]) && w.length > 3) {
    return { ...unique, words: w.slice(2) };
  }
  return unique;
}

function parseWantedTitle(q) {
  const raw = String(q || '');
  const out = tokenizeWanted(raw);
  out.aliasWords = aliasWordsIfSafe(out, episodeOrdinalAlias(tokenizeWanted(catalogUniqueRaw(raw))));
  out.branded = out.aliasWords.length > 0;
  return out;
}
// The requested episode from a play/prepare request (season+ep), or null for a movie. Threaded into
// mountOpts so a season pack mounts the RIGHT episode file, and into the scoring policy so a pack is
// not size-cap-disqualified for streaming one episode of it.
function wantedEpisodeOf(params) {
  const s = Number(params && params.season), e = Number(params && params.ep);
  // TMDB uses season 0 for specials. It is still an episode selection contract: dropping it here
  // makes a specials pack mount its largest member and lets its prepared mount alias a movie.
  return (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > 0) ? { s, e } : null;
}

// Only collection-shaped releases need request-scoped negative verdicts. A normal exact
// Show.S02E05 release has no sibling payload to poison, so its missing/blocked verdict remains
// reusable (critical for fast source skipping on the next play).
function isEpisodeCollectionName(name, wantedEpisode) {
  const s = Number(wantedEpisode && wantedEpisode.s);
  const e = Number(wantedEpisode && wantedEpisode.e);
  if (!Number.isInteger(s) || s < 0 || !Number.isInteger(e) || e <= 0) return false;
  const norm = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const range = /\bs0?(\d{1,2})e0?(\d{1,3})\s*e0?(\d{1,3})\b/.exec(norm);
  const inMultiEpisodeRange = !!(range && +range[1] === s
    && +range[2] < +range[3] && +range[2] <= e && e <= +range[3]);
  const seasonToken = new RegExp(`\\b(s0?${s}|season\\s?0?${s})\\b`).test(norm);
  const anyEpisodeToken = /\b(s\d{1,2}\s?e\d{1,3}|\d{1,2}x\d{1,3}|(?:episode|ep)\s?\d{1,3}|e\d{1,3})\b/.test(norm);
  return inMultiEpisodeRange || (seasonToken && !anyEpisodeToken);
}

// NZB XML and health verdicts are release-wide, but a mounted virtual file is not: one season-pack
// NZB can expose many episodes, and audiobook mode can choose a different payload. Keep live mount
// reuse and in-flight prepare joins scoped to the exact selection contract.
function mountIdentity(candidate, mountOpts = {}) {
  const we = mountOpts && mountOpts.wantedEpisode;
  const s = Number(we && we.s), e = Number(we && we.e);
  const hasEpisode = Number.isInteger(s) && s >= 0 && Number.isInteger(e) && e > 0;
  return JSON.stringify([
    String(candidate && candidate.nzbUrl || ''),
    hasEpisode ? 1 : 0, // keep a movie distinct from S00E00-like/default numeric sentinels
    hasEpisode ? s : 0,
    hasEpisode ? e : 0,
    mountOpts && mountOpts.audiobook ? 1 : 0,
  ]);
}
// What may legally follow the title in a scene name: year, SxxEyy/NxMM, resolution, source/
// codec, edition/region words. A PLAIN word right after the matched title means the release's
// real title is LONGER than the wanted one — a different film/show.
const STRUCTURAL_AFTER_TITLE = new RegExp('^(' + [
  '(19|20)\\d{2}', 's\\d{1,2}(e\\d{1,3})?', '\\d{1,2}x\\d{1,3}', // year / SxxEyy / season / 1x01
  '(2160|1080|720|576|480)[pi]', '4k', 'uhd', 'hdr', 'hdr10', 'dv', 'dovi', 'sdr',
  'x26[45]', 'h26[45]', 'hevc', 'avc', 'av1', 'xvid', 'divx',
  'web', 'webrip', 'webdl', 'rip', 'dl', 'bluray', 'blu', 'ray', 'bd', 'bdrip', 'brrip',
  'bdremux', 'remux', 'dvdrip', 'dvd', 'hdtv', 'uhdtv', 'hybrid',
  'complete', 'season', 'extended', 'directors', 'theatrical', 'unrated', 'uncut',
  'remastered', 'imax', 'proper', 'repack', 'internal', 'limited', 'criterion',
  'anniversary', 'edition', 'cut', 'redux', 'aka', 'intl',
  'us', 'uk', 'au', 'nz', 'ca', 'multi', 'dual', 'dubbed', 'ita', 'eng', 'french', 'german',
  'spanish', 'nordic', 'vostfr',
].join('|') + ')$');
// Country/remake tags are a legal title boundary (The.Office.AU is not a longer title), but they
// name a DIFFERENT show unless the query asked for that country. "The Office" (US, tt0386679)
// must not play The.Office.AU. Untagged The.Office.S01E01 still matches. "The Office UK" still
// matches The.Office.UK because the wanted words include uk.
const COUNTRY_EDITION = new Set(['au', 'uk', 'nz', 'ca']);
const TITLE_WORD_EQUIV = new Map([
  ['sorcerers', 'philosophers'],
  ['philosophers', 'sorcerers'],
]);
// "and" rides along: parseWantedTitle turns "&" into "and", and release names spell it either way
// ("Law.and.Order" / "Law.Order") — skippable keeps both findable without loosening the anchored/
// consecutive/structural-boundary rules that guard against wrong titles.
const OPTIONAL_TITLE_ARTICLES = new Set(['the', 'a', 'an', 'and']);
function titleWordMatches(wantedWord, releaseWord) {
  return wantedWord === releaseWord || TITLE_WORD_EQUIV.get(wantedWord) === releaseWord;
}

function titleCoreWords(words) {
  return (words || []).filter((w) => !OPTIONAL_TITLE_ARTICLES.has(w));
}

// Extra indexer query for the unique catalog half ("Lioness S02E01", "fellowship of the ring 2001").
function shortTitleQuery(paramsQ, wanted) {
  const alias = (wanted && wanted.aliasWords) || [];
  if (!alias.length) return '';
  if (titleCoreWords(alias).length >= titleCoreWords(wanted.words).length) return '';
  const tokens = String(paramsQ || '').split(/\s+/).filter(Boolean);
  const tail = tokens.filter((w) => /^(S\d{2}E\d{2}|s\d{2}e\d{2}|(19|20)\d{2})$/.test(w));
  const head = alias.slice();
  while (head.length && OPTIONAL_TITLE_ARTICLES.has(head[0])) head.shift();
  const q = [...head, ...tail].join(' ').trim();
  const current = String(paramsQ || '').trim();
  return q && q.toLowerCase() !== current.toLowerCase() ? q : '';
}

function sanitizeIndexerQuery(q) {
  return String(q || '').replace(/['’`]/g, '').replace(/[:&,!?./\\()\[\]\-_;]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function queryTailTokens(paramsQ) {
  return String(paramsQ || '').split(/\s+/).filter((w) => /^(S\d{2}E\d{2}|s\d{2}e\d{2}|(19|20)\d{2})$/.test(w));
}

// Extra indexer queries from TMDB original/aka names. SEARCH only — verify still uses the
// catalog wanted title, so "The Mutiny" cannot play Mutiny on the Bounty.
function aliasSearchQueries(paramsQ, aliases, wanted) {
  const current = sanitizeIndexerQuery(paramsQ);
  const currentLc = current.toLowerCase();
  const tail = queryTailTokens(current);
  const seen = new Set([currentLc]);
  const short = shortTitleQuery(current, wanted);
  if (short) seen.add(short.toLowerCase());
  const out = [];
  for (const raw of aliases || []) {
    const head = sanitizeIndexerQuery(raw);
    if (!head) continue;
    const hasTail = tail.some((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(head));
    const q = (hasTail ? head : [...head.split(/\s+/).filter(Boolean), ...tail].join(' ')).trim();
    const lc = q.toLowerCase();
    if (!q || seen.has(lc)) continue;
    seen.add(lc);
    out.push(q);
    if (out.length >= 2) break;
  }
  return out;
}

// "Mutiny 2026" often indexes as "Mutiny". Keep the year on the verifier, not the query.
function yearlessSearchQuery(paramsQ, wanted) {
  if (!wanted || !wanted.year) return '';
  const current = String(paramsQ || '').trim();
  const next = current.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  return next && next.toLowerCase() !== current.toLowerCase() ? next : '';
}

function mergeQualifiedResults(results, extraResults, qualifies) {
  const verified = (extraResults || []).filter(qualifies);
  if (!verified.length) return results;
  const seen = new Set(results.map((r) => r.nzbUrl || r.guid || r.name));
  for (const r of verified) {
    const k = r.nzbUrl || r.guid || r.name;
    if (!seen.has(k)) { seen.add(k); results.push(r); }
  }
  return results;
}

function titleWordsMatchFromStart(toks, words) {
  let ti = 0;
  // Scene names keep a leading "The" the catalog dropped ("The.Mutiny.2026" for Mutiny 2026).
  while (ti < toks.length && OPTIONAL_TITLE_ARTICLES.has(toks[ti])
    && words[0] && !titleWordMatches(words[0], toks[ti])) {
    ti++;
  }
  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi];
    const t = toks[ti];
    if (t === undefined) {
      if (OPTIONAL_TITLE_ARTICLES.has(w)) continue;
      return -1;
    }
    if (titleWordMatches(w, t)) { ti++; continue; }
    const nextWanted = words[wi + 1];
    if (OPTIONAL_TITLE_ARTICLES.has(w) && nextWanted && titleWordMatches(nextWanted, t)) continue;
    return -1;
  }
  return ti;
}

// Does this release NAME actually carry the wanted title, episode, and a compatible year?
// Three rules learned from "From S01E01" playing Stranger Things and long franchise titles:
//  1. ANCHORED — the title starts at the FIRST token (scene convention: Title.Year/SxxEyy.tags).
//     "contains the words somewhere" let one-word titles ("From", "It", "Angel") match
//     mid-name junk: Stranger.Things.Tales.FROM.85, Colin.FROM.Accounts, Up.FROM.the.Grave.
//  2. CONSECUTIVE — title words must match in order. The only soft spots are harmless
//     missing articles in release names and explicit known aliases (Sorcerers/Philosophers).
//     Arbitrary gaps made LOTR-style franchise titles match the wrong movie.
//  3. STRUCTURAL BOUNDARY — the token after the title must be a year/SxxEyy/quality tag,
//     never a plain word (From.DUSK.Till.Dawn for "From"; Walking.Dead.DARYL.DIXON for
//     "The Walking Dead" — the spin-off/longer-title trap).
//  4. UNIQUE CATALOG HALF — "Franchise: Unique name" may also match a release that STARTS with
//     the unique name (Lioness.S02E01, Fellowship.of.the.Ring.2001). The shared franchise half is
//     never enough on its own, so Two Towers cannot play for Fellowship and Dragon cannot play
//     for House of the Dragon.
function releaseMatches(name, wanted) {
  const norm = ' ' + String(name || '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ') + ' ';
  const toks = norm.trim().split(' ');
  if (wanted.words.length) {
    const variants = [wanted.words];
    if (wanted.aliasWords && wanted.aliasWords.length) variants.push(wanted.aliasWords);
    // TMDB original/aka of THIS title (Special Ops Lioness for catalog Lioness). Not a
    // free "contains the word" match — the release must still start with that aka.
    if (wanted.akaWords && wanted.akaWords.length) {
      for (const words of wanted.akaWords) {
        if (words && words.length) variants.push(words);
      }
    }
    let matched = false;
    for (const words of variants) {
      const ti = titleWordsMatchFromStart(toks, words);
      if (ti < 0) continue;
      const after = toks[ti];
      if (after !== undefined && COUNTRY_EDITION.has(after) && !words.includes(after)) continue;
      if (after !== undefined && !STRUCTURAL_AFTER_TITLE.test(after)) continue;
      matched = true;
      break;
    }
    if (!matched) return false;
  }
  if (wanted.s !== null) {
    const s = wanted.s, e = wanted.e;
    const exact = new RegExp(`\\b(s0?${s}\\s?e0?${e}|${s}x0?${e})\\b`);
    if (!exact.test(norm)) {
      // Not the exact episode — but ACCEPT a source that CONTAINS it, so a show only posted as a whole
      // season still plays (the mount then selects the episode file). Two forms, both keeping the season
      // EXACT (s0?2 never matches s03) and still rejecting a DIFFERENT single episode:
      //  - a multi-episode RANGE covering it: S02E01-E08 → norm "s02e01 e08" (the 'e' prefix on the
      //    second number is what distinguishes a real range from a trailing "1080p"); and
      //  - a whole-season PACK: the exact season token with NO single-episode token anywhere.
      const range = /\bs0?(\d{1,2})e0?(\d{1,3})\s*e0?(\d{1,3})\b/.exec(norm);
      const inRange = !!(range && +range[1] === s && +range[2] <= e && e <= +range[3]);
      const seasonToken = new RegExp(`\\b(s0?${s}|season\\s?0?${s})\\b`).test(norm);
      // DETACHED episode: season and episode split by other tokens ("S02 720p E05", "S02 Episode 5").
      // Accept ONLY when the standalone episode number is the WANTED one — a DIFFERENT detached episode
      // ("S02 720p E07") must NOT slip through the pack reading below and auto-play the wrong episode.
      const detachedExact = seasonToken && new RegExp(`\\b(e0?${e}|(?:ep|episode)\\s?0?${e})\\b`).test(norm);
      // Any single-episode marker — glued, spaced, verbose ("Episode 7"/"EP07"), OR a standalone "E##" —
      // disqualifies the whole-season-PACK reading, so a different single episode is never mistaken for a
      // pack. (Keep the ep-marker forms in sync with scoring.js isSeasonPack.)
      const anyEpToken = /\b(s\d{1,2}\s?e\d{1,3}|\d{1,2}x\d{1,3}|(?:episode|ep)\s?\d{1,3}|e\d{1,3})\b/.test(norm);
      if (!inRange && !detachedExact && !(seasonToken && !anyEpToken)) return false;
    }
  }
  if (wanted.year) {
    const years = [...norm.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => +m[0]);
    if (years.length) {
      if (wanted.s !== null) {
        // Episode air year AFTER SxxExx (The.Simpsons.S35E05.2024) must not reject a
        // long-running show whose catalog year is first-air (1989). Only a remake-style
        // year BETWEEN title and episode (The.Office.2024.S01E01) is a hard reject —
        // and only on early seasons, where that year is the remake, not the air year.
        const beforeEp = String(norm.split(/\b(?:s\d{1,2}\s?e\d{1,3}|\d{1,2}x\d{1,3})\b/)[0] || '');
        const remakeYears = [...beforeEp.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => +m[0]);
        if (remakeYears.length && !remakeYears.some((y) => Math.abs(y - wanted.year) <= 1)) {
          const looksLikeAirYear = wanted.s >= 3 && remakeYears.every((y) => y >= wanted.year);
          if (!looksLikeAirYear) return false;
        }
      } else if (!years.some((y) => Math.abs(y - wanted.year) <= 1)) {
        return false;
      }
    }
  }
  // A movie query (year, no episode) must not play a TV series with the same short name.
  // The.Batman.S01E01 has no year token, so the ±1 year check would let it through for The Batman 2022.
  if (wanted.year && wanted.s === null
      && /(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{1,3})(?=$|[^a-z0-9])/i.test(String(name || ''))) {
    return false;
  }
  return true;
}

// Catalog identity lock for remakes / same-name titles. Indexers often return The Office 2024
// next to The Office 2005. If the NZB is tagged with a DIFFERENT IMDb or TVDB id than the
// catalog title, it is the other work — reject even when the filename has no year.
// Untagged NZBs still go through releaseMatches (name + year + country).
function normImdb(id) {
  const digits = String(id || '').trim().toLowerCase().replace(/^tt/, '').replace(/\D/g, '');
  if (!digits) return '';
  const n = parseInt(digits, 10);
  return Number.isInteger(n) && n > 0 ? String(n) : '';
}
function normCatalogId(id) {
  const n = parseInt(String(id || '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? String(n) : '';
}
function catalogIdentityMatches(result, params) {
  const wantImdb = normImdb(params && params.imdbid);
  const gotImdb = normImdb(result && (result.imdb || result.imdbid));
  if (wantImdb && gotImdb && wantImdb !== gotImdb) return false;
  const wantTvdb = normCatalogId(params && params.tvdbid);
  const gotTvdb = normCatalogId(result && result.tvdbid);
  if (wantTvdb && gotTvdb && wantTvdb !== gotTvdb) return false;
  return true;
}
function releaseQualifies(result, wanted, params) {
  return catalogIdentityMatches(result, params) && releaseMatches(result && result.name, wanted);
}
const { rankReleases, parseRelease, rankAudiobooks } = require('./scoring');
const { mountNzb, orderVolumes } = require('./archive');

// ---- audiobook title verification ----
// Book releases don't follow the scene "Title.Year.Quality" convention: they're free-form
// ("Author - Title (Year) [M4B]", "Title - Author Unabridged 64kbps"), title and author can appear
// in either order, and there's no SxxEyy/resolution boundary to anchor on. So the video verifier
// (releaseMatches) rejects them all. Instead: require the wanted TITLE words to appear IN ORDER (as a
// subsequence, tolerant of gaps and dropped articles) AND the author surname to be present — the two
// together are a strong "this is the right book" signal without the scene-name assumptions.
const BOOK_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in']);
function bookTokens(s) {
  return String(s || '').toLowerCase().replace(/['’`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}
function parseWantedBook(title, author) {
  const titleWords = bookTokens(title).filter((w) => !BOOK_STOP.has(w));
  const authorWords = bookTokens(author).filter((w) => w.length > 2 && !BOOK_STOP.has(w));
  return { titleWords, authorWords };
}
function tokensInOrder(needle, hay) {
  if (!needle.length) return false;
  let i = 0;
  for (const h of hay) { if (h === needle[i]) i++; if (i === needle.length) return true; }
  return false;
}
function bookMatches(name, wanted) {
  const toks = bookTokens(name);
  if (!tokensInOrder(wanted.titleWords, toks)) return false;
  // Author is a strong disambiguator but optional: if none was supplied, title-in-order is enough.
  // When supplied, require ANY author word present (surname is enough — "Sanderson").
  if (wanted.authorWords.length && !wanted.authorWords.some((w) => toks.includes(w))) return false;
  return true;
}

// Turn the raw per-candidate fail reasons into one honest, actionable sentence for the user, so
// "all candidates failed" stops being a dead end. Most real failures are SOURCE health (removed
// posts, password-protected RARs, incomplete/fake files) — those mean "try later / add indexers",
// which is very different from a slow connection (timeouts) the user can act on differently.
function summarizeAttempts(attempts = []) {
  if (!attempts.length) return 'No sources were available to try for this title.';
    const cats = { connection: 0, missing: 0, encrypted: 0, stub: 0, unsupported: 0, timeout: 0, blocked: 0, episode: 0, other: 0 };
  for (const a of attempts) {
    const f = String((a && a.fail) || '').toLowerCase();
    // Connection FIRST — an unreachable provider must never be mislabeled as a removed article.
    if (/unreachable|econnrefused|econnreset|etimedout|ehostunreach|enotfound|getaddrinfo|socket hang|\bauthinfo\b|too many connection|\b502\b|fetch-failed/.test(f)) cats.connection++;
    else if (/^episode:|requested episode/.test(f)) cats.episode++;
    else if (/\b430\b|no such article|missing/.test(f)) cats.missing++;
    else if (/encrypt/.test(f)) cats.encrypted++;
    else if (/stub|incomplete|\bsample\b/.test(f)) cats.stub++;
    else if (/unstreamable|compressed|unsupported|unmappable|7z/.test(f)) cats.unsupported++;
    else if (/timeout/.test(f)) cats.timeout++;
    else if (/blocked|health/.test(f)) cats.blocked++;
    else cats.other++;
  }
  const n = attempts.length;
  const parts = [];
  if (cats.connection) parts.push(`${cats.connection} couldn't reach a provider`);
  if (cats.missing) parts.push(`${cats.missing} removed/missing`);
  if (cats.encrypted) parts.push(`${cats.encrypted} password-protected`);
  if (cats.stub) parts.push(`${cats.stub} incomplete/sample`);
  if (cats.unsupported) parts.push(`${cats.unsupported} unsupported format`);
  if (cats.timeout) parts.push(`${cats.timeout} timed out`);
  if (cats.blocked) parts.push(`${cats.blocked} failed health`);
  if (cats.episode) parts.push(`${cats.episode} didn't contain that episode`);
  if (cats.other) parts.push(`${cats.other} other`);
  const deadSource = cats.missing + cats.encrypted + cats.stub + cats.unsupported;
  const half = Math.ceil(n / 2);
  let head, tail = ' Try again later, pick another release in Sources, or add more indexers.';
  if (cats.connection >= half) {
    head = "Couldn't reach your usenet provider(s) — this is a connection problem, not a missing release";
    tail = ' Check that the server can reach your providers (VPN on? ports/credentials right in Settings → Providers), then retry.';
  } else if (cats.timeout >= half) {
    head = 'Sources kept timing out — the connection or provider is too slow right now';
  } else if (deadSource >= half) {
    head = 'No healthy source for this title yet — every release is removed, password-protected, or incomplete';
  } else {
    head = `Couldn't start any of the ${n} available sources`;
  }
  return `${head} (${parts.join(', ')}).${tail}`;
}

// Is this mounted file too small to be the real feature it claims? Pure + exported so it can be unit-
// tested without a multi-MB fixture. Mirrors scoring.js's DECLARED-size floors on the ACTUAL mounted
// bytes: nothing real is <80MB; nothing claiming 1080p/2160p is <300MB. Returns a fail reason or ''.
function stubFeatureReason(sizeBytes, name, declaredBytes) {
  const gb = (Number(sizeBytes) || 0) / 1e9;
  if (gb <= 0) return ''; // unknown size — don't guess
  const declaredGb = (Number(declaredBytes) || 0) / 1e9;
  const rank = parseRelease(name || '').resolutionRank; // 2160p=4, 1080p=3, unknown=2
  // 80MB is the hard floor. A real short 4K (Sintel ~15 min) can be 180–400MB, so a flat
  // 300MB 1080p/4K reject was swapping those Plays to 1080p. Catch the MK2-class lie instead:
  // indexer billed a feature-sized file, but the mounted payload is a sample/stub.
  if (gb < 0.08) {
    const forRes = rank >= 4 ? ' for a 2160p release' : rank >= 3 ? ' for a 1080p release' : '';
    return `stub/incomplete: only ${(gb * 1000).toFixed(0)}MB${forRes}`;
  }
  if (declaredGb >= 2 && gb < 0.4 && rank >= 3) {
    const forRes = rank >= 4 ? ' for a 2160p release' : ' for a 1080p release';
    return `stub/incomplete: only ${(gb * 1000).toFixed(0)}MB${forRes}`;
  }
  return '';
}
const { parseNzb, pickPrimaryFile, fileNameFromSubject, AUDIO_EXT } = require('./nzb');

// An audiobook mount must actually be AUDIO. An ebook/text release (.mobi/.epub/.azw3/.pdf/.txt)
// can match a book by title+author and mount cleanly, but the browser <audio> can't decode it, so
// playback errors mid-start and the client reports "Playback source was lost". Reject any audiobook
// mount whose primary file isn't an audio extension AND exposes no audio inner files, so the walk
// advances to a real audiobook (or honestly reports none playable) instead of streaming an ebook.
function isNonAudioAudiobookMount(vf) {
  const hasAudioFiles = vf && Array.isArray(vf.audioFiles) && vf.audioFiles.length > 0;
  return !hasAudioFiles && !AUDIO_EXT.test((vf && vf.name) || '');
}
const crypto = require('crypto');

const GATE_MS = 500;          // bounded upfront health gate (soft timeout)
const NZB_FETCH_IDLE_MS = 5000;
const NZB_FETCH_DEADLINE_MS = 15000; // hard cap — a slow NZB download advances to the next source
const MOUNT_DEADLINE_MS = 30000;     // hard cap — a stalled mount advances instead of hanging Play
const FIRST_ARTICLE_PROBE_MS = 800;   // cheap STAT probe catches stale NZBs before BODY fetches
const MAX_ATTEMPTS = 18;      // source walk: stale indexer rows are common; keep going past one bad release family
const MAX_ADVANCE_MS = 45000; // hard UX budget for one play/advance source walk
const PREPARE_MAX_ATTEMPTS = 6; // background detail prep: walk past several dead/encrypted top picks so the
                                // prefetch actually PRE-MOUNTS a working source (new releases often have
                                // 2-3 missing/unmappable variants ranked first). Bounded by PREPARE_MAX_MS.
const PREPARE_MAX_MS = 15000;
// A false-empty prepare (indexer timeout, year-filter miss) must not hide the title for
// 15 minutes. 45s stops a focus-loop hammer without looking like "no sources exist."
const PREPARE_FAIL_RETRY_MS = 45 * 1000;
// Next-episode prepare starts ~120s before EOF. Search cache is only 60s, so Play Next
// would otherwise fan out indexers again even though the mount is already live.
const TITLE_PREPARED_READY_MS = 180000;
const ACTIVE_PLAYBACK_GRACE_MS = 120000;
const PREPARED_CACHE_BYTES_1080 = 96 * 1024 * 1024;
const PREPARED_CACHE_BYTES_4K = 192 * 1024 * 1024;
const PREPARED_CACHE_BYTES_1080_WIDE = 192 * 1024 * 1024;
const PREPARED_CACHE_BYTES_4K_WIDE = 384 * 1024 * 1024;
const PREPARED_PEEK_MIN = 4;
const PREPARED_PEEK_MAX = 8;
const PREPARED_PEEK_FRAC = 0.04;
const PREPARED_PRESSURE_RATIO = 0.75;
const PREPARED_RAM_FRACTION = 0.10;
const PREPARED_TOTAL_MAX_BYTES = 512 * 1024 * 1024;
const RESUME_WARM_COVERAGE_TTL_MS = 120000;

// `_touched` is mount-lifecycle activity (prepare, probes, tracks, subtitles, and playback). Only
// real player reads should consume a viewer's connection/cache share. The HTTP stream route owns
// these two playback fields; keeping the predicate here gives window sizing and runtime telemetry
// one definition without coupling the pipeline to HTTP request objects.
function mountHasActivePlayback(mount, now = Date.now()) {
  if (!mount || !mount.streamable) return false;
  if ((Number(mount._activeStreamReads) || 0) > 0) return true;
  const touched = Number(mount._playbackTouched) || 0;
  return touched > 0 && now - touched < ACTIVE_PLAYBACK_GRACE_MS;
}

// Disk add-ins share the HTTP mounts map, but they do not pull NNTP articles.
// Counting them as viewers used to shrink a live Usenet Play — example: a
// ripped 4K from M:\Movies stole 4K sockets from FROM next door.
function mountNeedsUsenetShare(mount, now = Date.now()) {
  return !!(mount && !mount._local && mountHasActivePlayback(mount, now));
}

// Live connection allocator. Fair-share is the default. Auto mode may grow a starving
// playhead and take extra read-ahead sockets from a fat one. Custom mode stays on even
// split. Coverage is bytes AHEAD of the last player read — tail warmup must not look fat.
const ALLOC_STARVE_SEC = 20;
const ALLOC_FAT_SEC = 75;
const ALLOC_STEAL_STEP = 2;
const ALLOC_STARTUP_MS = 8000;
const ALLOC_HOLD_MS = 8000;
const ALLOC_STEAL_COOLDOWN_MS = 5000;
const AUTO_BASE_CONNS = 10;
const AUTO_HARD_MAX = 24;
const DEFAULT_MBPS_PER_CONN = 8;
const UHD_SIZE_BYTES = 4e9;
const UHD_AVG_MBPS = 20;

// 4K is the release, not "bigger than 4 GB". A 3 GB 2160p episode still needs
// the 4K socket cap and buffer; a 12 GB 1080p remux already qualifies by size.
function streamIsUhd(vf) {
  if (vf === true) return true;
  if (vf == null || typeof vf !== 'object') return Number(vf) > UHD_SIZE_BYTES;
  const size = Number(vf.size) || 0;
  if (size > UHD_SIZE_BYTES) return true;
  const name = String(vf._releaseName || '').trim() || String(vf.name || '').trim();
  if (name && parseRelease(name).resolutionRank >= 4) return true;
  const durationSec = vf._tracks && Number(vf._tracks.duration) > 0 ? Number(vf._tracks.duration) : 0;
  if (durationSec > 0 && size > 0) {
    const avgMbps = ((size * 8) / durationSec) / 1e6;
    if (Number.isFinite(avgMbps) && avgMbps >= UHD_AVG_MBPS) return true;
  }
  return false;
}

function streamNeedMbps(vf) {
  const big = streamIsUhd(vf);
  const durationSec = vf && vf._tracks && Number(vf._tracks.duration) > 0 ? Number(vf._tracks.duration) : 0;
  const size = Number(vf && vf.size) || 0;
  const measuredMbps = durationSec > 0 && size > 0 ? ((size * 8) / durationSec) / 1e6 : 0;
  const avgMbps = Number.isFinite(measuredMbps) && measuredMbps > 0 ? measuredMbps : (big ? 45 : 12);
  const need = Math.max(big ? 45 : 12, Math.min(big ? 120 : 50, avgMbps * (big ? 2.2 : 1.4)));
  return Number.isFinite(need) && need > 0 ? need : (big ? 45 : 12);
}

function mountAheadBytes(vf) {
  if (!vf) return null;
  if (typeof vf.aheadCacheBytes !== 'function' && Number.isFinite(vf.aheadCacheBytes)) {
    return Math.max(0, vf.aheadCacheBytes);
  }
  let n = 0;
  let known = false;
  for (const v of (vf.vols || [vf])) {
    if (!v) continue;
    if (typeof v.aheadCacheBytes === 'function') {
      const a = v.aheadCacheBytes();
      if (Number.isFinite(a)) { n += a; known = true; }
    } else if (Number.isFinite(v.aheadCacheBytes)) {
      n += v.aheadCacheBytes;
      known = true;
    }
  }
  return known ? Math.max(0, n) : null;
}

function fileIsFullyAhead(vf) {
  const size = Number(vf && vf.size) || 0;
  if (!(size > 0)) return false;
  const ahead = mountAheadBytes(vf);
  if (ahead == null) return false;
  const offset = Number.isFinite(vf.lastPlaybackOffset) ? Math.max(0, vf.lastPlaybackOffset) : 0;
  const remain = Math.max(0, size - offset);
  return remain > 0 && ahead >= remain * 0.98;
}

function isIdleGraceViewer(vf) {
  return (Number(vf && vf._activeStreamReads) || 0) <= 0;
}

function isStartupViewer(vf, now) {
  const t = Number(vf && (vf._playbackTouched || vf._touched)) || 0;
  return t > 0 && (now - t) >= 0 && (now - t) < ALLOC_STARTUP_MS;
}

function classifyStreamNeed(vf, now = Date.now()) {
  if (!vf) return 'ok';
  if (isStartupViewer(vf, now)) return 'ok';
  const ahead = mountAheadBytes(vf);
  if (ahead == null) return 'ok';
  const mbps = streamNeedMbps(vf);
  const coverage = mbps > 0 ? (ahead * 8) / (mbps * 1e6) : 0;
  if (!Number.isFinite(coverage)) return 'ok';
  if (isIdleGraceViewer(vf)) return coverage > ALLOC_FAT_SEC ? 'fat' : 'ok';
  if (coverage < ALLOC_STARVE_SEC) return 'starve';
  if (coverage > ALLOC_FAT_SEC) return 'fat';
  return 'ok';
}

function heldAllocKind(vf, raw, now, holdMs) {
  if (!vf || raw === 'ok') {
    if (vf) { vf._allocKind = 'ok'; vf._allocKindSince = now; }
    return 'ok';
  }
  if (vf._allocKind !== raw) {
    vf._allocKind = raw;
    vf._allocKindSince = now;
    return 'ok';
  }
  const since = Number(vf._allocKindSince);
  if (!Number.isFinite(since) || (now - since) < holdMs) return 'ok';
  return raw;
}

// A 502 is one account saying it is full. With several providers that is not a
// household-wide cap — only squeeze Auto grow when every usable provider is at 502.
function mbpsPerConnection(perf = {}) {
  const measured = Number(perf && perf.measuredMbpsPerConn);
  if (Number.isFinite(measured) && measured > 0) return Math.max(2, Math.min(40, measured));
  return DEFAULT_MBPS_PER_CONN;
}

function autoStreamCap(vf, perf = {}, { starving = false } = {}) {
  const need = streamNeedMbps(vf);
  const fromBw = Math.ceil(need / mbpsPerConnection(perf));
  const want = Math.max(AUTO_BASE_CONNS, Number.isFinite(fromBw) ? fromBw : AUTO_BASE_CONNS);
  const room = starving ? Math.ceil(want * 1.6) : want;
  return Math.max(4, Math.min(AUTO_HARD_MAX, room));
}

function playbackRamFraction(totalMemMb = TOTAL_MEM_MB) {
  const mb = Number(totalMemMb) || 0;
  if (mb > 0 && mb < 4096) return 0.12;
  if (mb > 0 && mb < 8192) return 0.15;
  return 0.20;
}

function playbackCacheCapMb(big, totalMemMb = TOTAL_MEM_MB) {
  const ramCapMb = Math.floor((Number(totalMemMb) || 0) * playbackRamFraction(totalMemMb));
  const heapSafeMb = Math.max(big ? 96 : 48, Math.min(1536, Math.floor((Number(totalMemMb) || 0) * 0.08)));
  const classCap = big ? 3072 : 1024;
  const minMb = big ? 96 : 48;
  return Math.max(minMb, Math.min(classCap, ramCapMb, heapSafeMb));
}

function cacheNeedWeight(vf, now = Date.now()) {
  if (fileIsFullyAhead(vf)) return 0.35;
  const kind = classifyStreamNeed(vf, now);
  if (kind === 'starve') return 1.4;
  if (kind === 'fat') return 0.75;
  return 1;
}

function householdProviderLoad(providers) {
  if (!Array.isArray(providers) || !providers.length) return { used: 0, cap: 0 };
  let used = 0;
  let cap = 0;
  for (const p of providers) {
    if (!p) continue;
    cap += Math.max(0, Number(p.size) || 0);
    used += ((p.busy && p.busy.size) || 0) + (Number(p.connecting) || 0) + ((p.queue && p.queue.length) || 0);
  }
  return { used, cap };
}

function preparedHouseHasRoom(providers) {
  const { used, cap } = householdProviderLoad(providers);
  if (!(cap > 0)) return true;
  return used < cap * PREPARED_PRESSURE_RATIO;
}

function preparedPeekSockets(providers) {
  const { used, cap } = householdProviderLoad(providers);
  if (!(cap > 0)) return PREPARED_PEEK_MAX;
  if (used >= cap * PREPARED_PRESSURE_RATIO) return PREPARED_PEEK_MIN;
  return Math.max(PREPARED_PEEK_MIN, Math.min(PREPARED_PEEK_MAX, Math.floor(cap * PREPARED_PEEK_FRAC)));
}

function householdConnPressure(providers, now = Date.now()) {
  if (!Array.isArray(providers) || !providers.length) return 1;
  const live = providers.filter((p) => {
    if (!p) return false;
    if (typeof p.down === 'function') return !p.down();
    return true;
  });
  const list = live.length ? live : providers.filter(Boolean);
  if (!list.length) return 1;
  const allCapped = list.every((p) => p.capHitAt && now - p.capHitAt < 60000);
  return allCapped ? 0.5 : 1;
}

function allocateStreamConnections(mounts, perf = {}, opts = {}) {
  const list = Array.isArray(mounts) ? mounts.filter(Boolean) : [];
  const n = list.length;
  if (!n) return Object.assign([], { stole: false });
  const usable = Math.max(0, Number(perf.usableConnections) || 0);
  const reserve = Math.max(0, Number(perf.reserveConnections) || 0);
  const pool = usable > reserve ? usable - reserve : 0;
  const downMbps = Number(perf.serverDownloadMbps) > 0 ? Number(perf.serverDownloadMbps) * 0.8 : 0;
  const measuredPerConn = Number(perf.measuredMbpsPerConn) > 0 ? Number(perf.measuredMbpsPerConn) : 0;
  const viewerChanged = opts.viewerChanged === true;
  const custom = perf.connectionMode === 'custom' || opts.connectionMode === 'custom';
  const growFrozen = opts.growFrozen === true;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const holdMs = Number.isFinite(opts.holdMs) ? Math.max(0, opts.holdMs) : ALLOC_HOLD_MS;
  const lastStealAt = Number(opts.lastStealAt) || 0;
  const stealCooldown = Number.isFinite(opts.stealCooldownMs) ? opts.stealCooldownMs : ALLOC_STEAL_COOLDOWN_MS;
  const caps = Array.isArray(opts.caps) ? opts.caps : null;

  const meta = list.map((vf, i) => {
    const floor = 4;
    const raw = custom ? 'ok' : classifyStreamNeed(vf, now);
    const kind = custom ? 'ok' : heldAllocKind(vf, raw, now, holdMs);
    const configured = Number(caps && caps[i]);
    const ownerCap = streamIsUhd(vf)
      ? Number(perf.maxConnPerStream4k)
      : Number(perf.maxConnPerStream1080);
    const autoCap = autoStreamCap(vf, perf, { starving: kind === 'starve' });
    const fallback = custom
      ? Math.max(floor, Number.isFinite(ownerCap) && ownerCap > 0 ? ownerCap : (streamIsUhd(vf) ? 20 : 12))
      : (Number.isFinite(ownerCap) && ownerCap > 0 ? Math.min(autoCap, ownerCap) : autoCap);
    const cap = Math.max(floor, Number.isFinite(configured) && configured > 0 ? configured : fallback);
    return { vf, floor, cap, needMbps: streamNeedMbps(vf), kind };
  });

  const totalNeed = meta.reduce((sum, m) => sum + (Number.isFinite(m.needMbps) ? m.needMbps : 0), 0);
  const bandwidthBound = downMbps > 0 && totalNeed > downMbps * 0.9;
  const perConn = measuredPerConn > 0 ? measuredPerConn : mbpsPerConnection(perf);

  let assignable = pool;
  if (downMbps > 0 && perConn > 0) {
    const pipeConns = Math.floor(downMbps / perConn);
    if (Number.isFinite(pipeConns) && pipeConns >= 0) {
      assignable = Math.min(assignable, Math.max(n * 4, pipeConns));
    }
  }
  if (bandwidthBound && !custom) {
    for (const m of meta) m.cap = Math.min(m.cap, Math.max(m.floor, Math.floor(assignable / n) + 2));
  }

  const noBudget = !(usable > 0);
  const fair = assignable > 0 ? Math.max(4, Math.floor(assignable / n)) : 4;
  const assigned = meta.map((m) => {
    // No streaming-profile budget (tests / unset house): Auto still starts at 10.
    const start = custom
      ? (noBudget ? m.cap : fair)
      : (noBudget ? AUTO_BASE_CONNS : Math.min(AUTO_BASE_CONNS, fair));
    return Math.min(m.cap, Math.max(m.floor, start));
  });
    if (!custom) {
    meta.forEach((m, i) => {
      // A brand-new Play still starts at 10 even if the first articles already
      // filled a small file. Drip to the floor only after that startup window.
      if (fileIsFullyAhead(m.vf) && !isStartupViewer(m.vf, now)) assigned[i] = m.floor;
      else if (m.kind === 'fat' && assigned[i] > AUTO_BASE_CONNS) assigned[i] = AUTO_BASE_CONNS;
    });
  }
  let spare = Math.max(0, assignable - assigned.reduce((sum, v) => sum + v, 0));
  const growCeiling = (growFrozen || bandwidthBound)
    ? fair
    : (custom || !(downMbps > 0) ? fair + 2 : Infinity);

  const starve = [];
  const fat = [];
  const ok = [];
  meta.forEach((m, i) => {
    if (m.kind === 'starve') starve.push(i);
    else if (m.kind === 'fat') fat.push(i);
    else ok.push(i);
  });

  const grow = (i) => {
    if (!custom && fileIsFullyAhead(meta[i].vf)) return false;
    if (spare <= 0 || assigned[i] >= meta[i].cap || assigned[i] >= growCeiling) return false;
    assigned[i]++;
    spare--;
    return true;
  };
  const growRoundRobin = (indexes) => {
    let progressed = true;
    while (progressed && spare > 0) {
      progressed = false;
      for (const i of indexes) {
        if (grow(i)) progressed = true;
      }
    }
  };
  if (!growFrozen && !custom) {
    const starting = [];
    meta.forEach((m, i) => {
      if (isStartupViewer(m.vf, now)) starting.push(i);
    });
    // Take turns. Filling the first Play to its cap left a 1080p seek waiting
    // while a 4K next to it vacuumed leftover sockets.
    growRoundRobin(starting);
    growRoundRobin(starve);
  }

  let stole = false;
  const canSteal = !custom && !growFrozen && !viewerChanged && starve.length && fat.length
    && (now - lastStealAt >= stealCooldown);
  if (canSteal) {
    for (const i of starve) {
      let stolen = 0;
      for (const j of fat) {
        while (stolen < ALLOC_STEAL_STEP && assigned[j] > meta[j].floor && assigned[i] < meta[i].cap) {
          assigned[j]--;
          assigned[i]++;
          stolen++;
          stole = true;
        }
      }
    }
  }

  if (spare > 0 && !growFrozen && !custom) {
    growRoundRobin(starve);
  }
  return Object.assign(assigned, { stole });
}
// Cold press-play races the top N candidates' fetch+mount+health concurrently and takes the first
// HEALTHY one (startup win #2). Measured: a cold start is dominated by walking PAST dead/incomplete
// top picks one-at-a-time — racing collapses that serial tail to the fastest healthy of the top N.
// Kept small so startup never floods the provider pool (the startup reserve covers a few parallel
// mounts). Recovery uses a narrower delayed hedge below because an active source has already died.
const PLAY_RACE_WIDTH = 5;
// Three people can press Play at once. Each keeps one front-runner mount slot; extra
// hedges and background /api/prepare wait behind those Plays instead of flooding NZB
// downloads and NNTP startup work. One Play still uses leftover slots for hedges.
const STARTUP_SLOTS = 3;
// Recovery keeps the common healthy-next-source path single-grab, but launches one delayed hedge
// when that replacement stalls. This avoids another full 30-second mount wait after the player has
// already declared its active release unhealthy.
const RECOVERY_RACE_WIDTH = 2;
// Hedge delay before speculatively mounting the next candidate in parallel. A healthy/fast top
// pick (usually prefetched → NZB cached → mounts in well under this) commits before the hedge
// fires, so the common case costs ZERO extra indexer grabs; only a STALLING top pick gets a
// parallel understudy started. A fast dead pick fails before the hedge too and the next launches
// immediately on that failure — the hedge only matters for slow-failing/slow-mounting picks.
const RACE_HEDGE_MS = 800;
// Once a lower-ranked hedge is healthy, give earlier ranks only a short final chance to settle.
// This preserves quality when the top source is milliseconds behind without turning a ready player
// into a 30-second wait behind its mount deadline.
const RACE_COMMIT_GRACE_MS = 250;

// Fair startup limiter: Play front-runners beat hedges, hedges beat prepare.
class StartupGate {
  constructor(max = STARTUP_SLOTS) {
    this.max = max;
    this.active = 0;
    this.peak = 0;
    this.playWait = [];
    this.hedgeWait = [];
    this.prepWait = [];
  }
  _queue(priority) {
    if (priority === 'prepare') return this.prepWait;
    if (priority === 'hedge') return this.hedgeWait;
    return this.playWait;
  }
  acquire({ signal, priority = 'play' } = {}) {
    const abortErr = () => Object.assign(new Error('request aborted'), { code: 'ABORT_ERR' });
    const ticket = () => {
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.release();
        },
      };
    };
    if (signal && signal.aborted) return Promise.reject(abortErr());
    if (this.active < this.max) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve(ticket());
    }
    return new Promise((resolve, reject) => {
      const q = this._queue(priority);
      const rec = { resolve, reject, settled: false };
      rec.finish = (fn) => {
        if (rec.settled) return;
        rec.settled = true;
        if (signal && rec.onAbort) signal.removeEventListener('abort', rec.onAbort);
        fn();
      };
      rec.onAbort = () => {
        const i = q.indexOf(rec);
        if (i < 0) return; // already granted a slot
        q.splice(i, 1);
        rec.finish(() => reject(abortErr()));
      };
      if (signal) signal.addEventListener('abort', rec.onAbort, { once: true });
      q.push(rec);
    }).then(() => ticket());
  }
  release() {
    const next = this.playWait.shift() || this.hedgeWait.shift() || this.prepWait.shift();
    if (next) next.finish(() => next.resolve());
    else this.active = Math.max(0, this.active - 1);
  }
}

function candidateKey(candidate) {
  return crypto.createHash('sha1').update([
    candidate && candidate.indexer || '',
    candidate && candidate.nzbUrl || '',
    candidate && candidate.name || '',
    candidate && candidate.sizeBytes || '',
  ].join('\0')).digest('hex').slice(0, 16);
}

function nzbVerdictKey(rawUrl) {
  let stable = String(rawUrl || '');
  try {
    const u = new URL(stable);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(apikey|api_key|key|token|access_token|auth|password)$/i.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    stable = u.href;
  } catch {}
  return 'nzb:' + crypto.createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

const DEAD_RELEASE_VERDICTS = new Set(['missing', 'blocked']);

// Same Usenet post under a second indexer URL: size + poster, plus usenet-day when we have it.
// Requires a poster so two different same-size releases from the same RSS day cannot collide.
function releaseFingerprint(candidate) {
  const size = Number(candidate && candidate.sizeBytes);
  const poster = String(candidate && candidate.poster || '').trim().toLowerCase();
  if (!(size > 0) || !poster.includes('@')) return null;
  let day = 0;
  const rawDate = candidate.usenetDate || candidate.pubDate;
  if (rawDate != null && rawDate !== '') {
    const n = Number(rawDate);
    const ms = Number.isFinite(n) && n > 0
      ? (n < 1e12 ? n * 1000 : n)
      : Date.parse(String(rawDate));
    if (Number.isFinite(ms)) day = Math.floor(ms / 86400000);
  }
  return 'fp:' + crypto.createHash('sha256').update(`${Math.round(size)}|${poster}|${day}`).digest('hex').slice(0, 32);
}

function applyNzbFingerprintFields(candidate, xml) {
  if (!candidate || candidate.poster) return;
  try {
    const nzb = parseNzb(xml);
    const file = nzb.files && nzb.files[0];
    if (file && file.poster) candidate.poster = file.poster;
    if (file && file.date && !candidate.usenetDate) candidate.usenetDate = file.date;
  } catch {}
}

function lookupVerdict(verdicts, candidate) {
  if (!verdicts || !candidate) return null;
  return verdicts.get(nzbVerdictKey(candidate.nzbUrl))
    || verdicts.get('t:' + normTitle(candidate.name))
    || (releaseFingerprint(candidate) && verdicts.get(releaseFingerprint(candidate)))
    || null;
}

function cachedStreamClass(v) {
  if (!v || !v.detail) return undefined;
  const tags = v.detail.tags || [];
  if (tags.includes('unmappable')) return 'unmappable';
  if (tags.includes('compressed')) return 'compressed';
  if (tags.includes('encrypted')) return 'encrypted';
  return v.detail.streamClass;
}

function skipTitleVerdict(verdict, detail = {}) {
  return verdict === 'unstreamable'
    && (detail.streamClass === 'unmappable' || (detail.tags || []).includes('unmappable'));
}

function firstProbeTarget(nzbXml, mountOpts = {}, candidateName = '') {
  const nzb = parseNzb(nzbXml);
  const candidates = nzb.files.map((f) => ({
    ...f,
    name: fileNameFromSubject(f.subject),
    bytes: f.segments.reduce((s, x) => s + x.bytes, 0),
  }));
  // Archive posts must probe their first volume. Loose season packs must probe the exact file that
  // mountNzb will select for the requested episode; probing the largest E01 and mounting E05 can
  // otherwise reject a healthy E05 (or bless a missing one) before playback even starts.
  const firstVolume = orderVolumes(candidates)[0] || null;
  const file = firstVolume || pickPrimaryFile(nzb, { ...mountOpts, releaseName: candidateName });
  return {
    msgId: file && file.segments && file.segments[0] && file.segments[0].msgId,
    // A missing loose-pack episode says nothing about the other members in the same NZB. Archive
    // volume failure remains release-wide because every inner episode depends on that volume set.
    episodeScoped: !firstVolume
      && isEpisodeCollectionName(candidateName, mountOpts && mountOpts.wantedEpisode),
  };
}

function firstProbeMsgId(nzbXml, mountOpts = {}, candidateName = '') {
  return firstProbeTarget(nzbXml, mountOpts, candidateName).msgId;
}

function mountVerdictForError(e) {
  const msg = String((e && e.message) || e || '');
  return /\b430\b|no such article|missing article/i.test(msg) ? 'missing' : 'mount-failed';
}

async function probeFirstArticle(pool, msgId) {
  const ac = new AbortController();
  let timer;
  try {
    return await Promise.race([
      pool.stat(msgId, 'startup', { signal: ac.signal, throwIfUnreachable: true })
        .then((ok) => ok ? 'present' : 'missing')
        .catch((e) => {
          if (e && e.code === 'ABORT_ERR') return 'timeout';
          if (e && e.code === 'NO_PROVIDER') return 'unreachable'; // can't reach a provider != article gone
          return 'missing';
        }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          ac.abort();
          resolve('timeout');
        }, FIRST_ARTICLE_PROBE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

// Race a promise against a hard deadline (timer is always cleaned up).
function withDeadline(promise, ms, msg) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); }),
  ]).finally(() => clearTimeout(t));
}

class PlaySession {
  constructor(query, candidates) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.query = query;
    this.candidates = candidates; // ranked, best first
    this.cursor = 0;              // next candidate index to try
    this.history = [];            // { name, outcome }
    this.createdAt = Date.now();
    this.lastSeen = this.createdAt;
    this.released = false;
  }
}

class Pipeline {
  constructor({
    pool, verdicts, mounts, indexers = () => [], usage = {}, performance = () => null,
    enforceFeatureSize = false, mountDeadlineMs = MOUNT_DEADLINE_MS, totalMemMb = TOTAL_MEM_MB,
  }) {
    this.pool = pool;             // () => NntpPool (lazy, settings-driven)
    this.verdicts = verdicts;     // VerdictCache
    this.mounts = mounts;         // shared Map(id -> vf) owned by the HTTP server
    this.indexers = indexers;     // () => [{name,url,apikey}]
    // Post-mount feature-size floor (reject a 220MB file masquerading as a 2160p movie). OFF by
    // default so the KB-scale mount/seek test fixtures aren't all flagged as stubs; the HTTP server
    // turns it ON for real playback, where releases are GB-scale and a tiny mount IS junk.
    this.enforceFeatureSize = !!enforceFeatureSize;
    // Indexer usage accounting (daily API/grab limits live in the HTTP layer's store):
    // onSearch fires per indexer per actual fan-out (cache hits are free); canGrab/onGrab
    // gate and count NZB downloads (cached NZBs and live-mount reuse never count).
    this.usage = { onSearch: () => {}, canGrab: () => true, onGrab: () => {}, ...usage };
    this.performance = performance; // admin streaming profile: connection fairness + buffers
    // Constructor override exists for deterministic timeout regression tests; production keeps the
    // canonical bounded deadline above.
    this.mountDeadlineMs = Number.isFinite(mountDeadlineMs) && mountDeadlineMs > 0
      ? mountDeadlineMs : MOUNT_DEADLINE_MS;
    this.totalMemMb = Number.isFinite(totalMemMb) && totalMemMb > 0 ? totalMemMb : TOTAL_MEM_MB;
    this._playbackExpiryTimer = null;
    this._playbackExpiryAt = 0;
    this._playbackRuntimeDisposed = false;
    this._allocActiveCount = -1;
    this._allocLastStealAt = 0;
    this.sessions = new Map();    // id -> PlaySession
    this.searchCache = new Map(); // queryKey -> { at, results, errors } (prefetch-on-browse → instant play)
    this.searchInflight = new Map(); // queryKey -> Promise(hit), so Play can join an active prefetch
    this.nzbCache = new Map();    // nzbUrl -> xml (small LRU; replays remount instantly)
    this.nzbInflight = new Map(); // nzbUrl -> Promise(xml), so Play joins detail-page prefetch
    this.prepareInflight = new Map(); // mountIdentity -> shared cancellable mount record
    this.titlePrepareInflight = new Map(); // prepareJobKey -> shared title-level prepare job
    this.prepareFailUntil = new Map(); // prepareJobKey -> Date.now() until we retry a no-playable miss
    this.titlePreparedReady = new Map(); // prepareJobKey -> { vf, candidate, at } after prepare wins
    this.titlePreparedStandby = new Map(); // next-ranked backup mount, warmed during Details
    this.mountByUrl = new Map();  // mountIdentity -> mount id (same selected payload reuses instantly)
    this._startupGate = new StartupGate(STARTUP_SLOTS);
    this._inflightAdvances = 0;
    this._activeFanouts = 0;
    this.metrics = {
      searchCacheHits: 0,
      searchCacheMisses: 0,
      searchInflightJoins: 0,
      searchFanouts: 0,
      searchFanoutMs: 0,
      searchFanoutMaxMs: 0,
      nzbCacheHits: 0,
      nzbInflightJoins: 0,
      nzbFetches: 0,
      nzbPrefetches: 0,
      firstProbePresent: 0,
      firstProbeMissing: 0,
      firstProbeTimeout: 0,
      firstProbeError: 0,
      firstProbeMs: 0,
      firstProbeMaxMs: 0,
      mountAttempts: 0,
      mountSuccesses: 0,
      mountFailures: 0,
      mountMs: 0,
      mountMaxMs: 0,
      healthGateTimeouts: 0,
      healthGateBlocked: 0,
      healthGateResults: 0,
      healthGateMs: 0,
      healthGateMaxMs: 0,
      windowRebalances: 0,
      titlePrepareJoins: 0,
    };
  }

  metricsSnapshot() {
    const m = this.metrics;
    const avg = (sum, count) => count ? Math.round(sum / count) : 0;
    const firstProbeCount = m.firstProbePresent + m.firstProbeMissing + m.firstProbeTimeout + m.firstProbeError;
    const healthCount = m.healthGateTimeouts + m.healthGateBlocked + m.healthGateResults;
    return {
      search: {
        cacheHits: m.searchCacheHits,
        cacheMisses: m.searchCacheMisses,
        inflightJoins: m.searchInflightJoins,
        fanouts: m.searchFanouts,
        avgFanoutMs: avg(m.searchFanoutMs, m.searchFanouts),
        maxFanoutMs: m.searchFanoutMaxMs,
      },
      nzb: {
        cacheHits: m.nzbCacheHits,
        inflightJoins: m.nzbInflightJoins,
        fetches: m.nzbFetches,
        prefetches: m.nzbPrefetches,
      },
      firstProbe: {
        present: m.firstProbePresent,
        missing: m.firstProbeMissing,
        timeout: m.firstProbeTimeout,
        error: m.firstProbeError,
        avgMs: avg(m.firstProbeMs, firstProbeCount),
        maxMs: m.firstProbeMaxMs,
      },
      mount: {
        attempts: m.mountAttempts,
        successes: m.mountSuccesses,
        failures: m.mountFailures,
        avgMs: avg(m.mountMs, m.mountAttempts),
        maxMs: m.mountMaxMs,
      },
      prepare: {
        inflightJoins: m.titlePrepareJoins,
      },
      healthGate: {
        timeouts: m.healthGateTimeouts,
        blocked: m.healthGateBlocked,
        results: m.healthGateResults,
        avgMs: avg(m.healthGateMs, healthCount),
        maxMs: m.healthGateMaxMs,
      },
      windowRebalances: m.windowRebalances,
    };
  }

  async _fanoutMeasured(ixs, params, opts) {
    this._activeFanouts++;
    const competing = Math.max(1, this._activeFanouts);
    const concurrency = competing > 1
      ? Math.max(2, Math.ceil(ixs.length / competing))
      : ixs.length;
    const t0 = Date.now();
    try {
      return await fanout(ixs, params, { ...opts, concurrency });
    } finally {
      this._activeFanouts = Math.max(0, this._activeFanouts - 1);
      const ms = Date.now() - t0;
      this.metrics.searchFanouts++;
      this.metrics.searchFanoutMs += ms;
      this.metrics.searchFanoutMaxMs = Math.max(this.metrics.searchFanoutMaxMs, ms);
    }
  }

  _searchCacheKey(params, opts = {}) {
    const clean = (v) => {
      const s = String(v ?? '').trim();
      return s || undefined;
    };
    const episodePart = (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? String(n) : clean(v);
    };
    return JSON.stringify([
      clean(params.q),
      opts.ignoreCatalogIds ? undefined : clean(params.imdbid),
      opts.ignoreCatalogIds ? undefined : clean(params.tvdbid),
      episodePart(params.season),
      episodePart(params.ep),
      // Catalog year is the remake lock (The Office 2005 vs 2024). Keep it on the key so a
      // yearless search cannot reuse a 2005-filtered hit, or the other way around.
      Number.isInteger(params.year) ? params.year : undefined,
      // A 4K Play fans out an extra 2160p query. Do not reuse a 1080p-only cache hit.
      opts.wantUhd ? 1 : undefined,
      // Aka/original-title queries must not reuse a title-only hit that missed those files.
      (opts.akaQueries && opts.akaQueries.length) ? opts.akaQueries.join('|') : undefined,
      opts.widenSearch === false ? 0 : undefined,
    ]);
  }

  // Title-level prepare job: same search + quality policy. Smash Play joins this instead of
  // opening a second full-width source race on top of the Details warmup.
  _prepareJobKey(params, policy = {}, opts = {}) {
    return JSON.stringify([
      this._searchCacheKey(params, opts),
      policy.maxResolutionRank ?? null,
      policy.preferResolutionRank ?? null,
      policy.exactResolutionRank ?? null,
      policy.maxSizeGb4k ?? null,
      policy.maxSizeGb1080 ?? null,
      policy.sizePreferenceGB ?? null,
      policy.lowPowerDevice ? 1 : 0,
      policy.dolbyVision === false ? 0 : (policy.dolbyVision === true ? 1 : null),
      policy.deviceClass || null,
    ]);
  }

  _findTitlePrepare(params, policy = {}) {
    const key = this._prepareJobKey(params, policy);
    let rec = this.titlePrepareInflight.get(key);
    if (!rec && (params.imdbid || params.tvdbid)) {
      rec = this.titlePrepareInflight.get(this._prepareJobKey(params, policy, { ignoreCatalogIds: true }));
    }
    return rec || null;
  }

  _titleIdentity(params = {}) {
    return [params.q, params.imdbid, params.tvdbid, params.season, params.ep]
      .map((v) => String(v || '').trim().toLowerCase()).join('|');
  }

  _rememberTitlePrepared(params, policy, vf, candidate) {
    if (!vf || !candidate) return;
    const rec = { vf, candidate, at: Date.now(), titleId: this._titleIdentity(params) };
    this.titlePreparedReady.set(this._prepareJobKey(params, policy), rec);
    if (params.imdbid || params.tvdbid) {
      this.titlePreparedReady.set(this._prepareJobKey(params, policy, { ignoreCatalogIds: true }), rec);
    }
  }

  // 4K stop → 1080 Play (or the reverse) must drop the other quality's warm mount.
  // Same title, different policy. Leaving both live splits the pool and 502s the new Play.
  forgetMismatchedPrepared(params, policy = {}) {
    const keepKey = this._prepareJobKey(params, policy);
    const titleId = this._titleIdentity(params);
    if (!titleId || titleId === '||||') return 0;
    const keepRec = this.titlePreparedReady.get(keepKey);
    const keepId = keepRec && keepRec.vf && keepRec.vf.id;
    let dropped = 0;
    for (const [key, rec] of [...this.titlePreparedReady]) {
      if (key === keepKey) continue;
      if ((rec && rec.titleId) !== titleId) continue;
      this.titlePreparedReady.delete(key);
      const vf = rec && rec.vf;
      if (!vf || vf.id === keepId) continue;
      let held = false;
      for (const s of this.sessions.values()) {
        if (s && !s.released && s.currentMountId === vf.id) { held = true; break; }
      }
      if (held) continue;
      try { this.cancelPlaybackWarmups(vf); } catch {}
      this.mounts.delete(vf.id);
      for (const [url, id] of this.mountByUrl) if (id === vf.id) this.mountByUrl.delete(url);
      dropped++;
    }
    if (dropped) this.rebalancePlaybackWindows();
    return dropped;
  }

  _standbyKeys(params, policy = {}) {
    const keys = [this._prepareJobKey(params, policy)];
    if (params.imdbid || params.tvdbid) keys.push(this._prepareJobKey(params, policy, { ignoreCatalogIds: true }));
    return keys;
  }

  _rememberTitleStandby(params, policy, vf, candidate) {
    if (!vf || !candidate) return;
    const rec = { vf, candidate, at: Date.now() };
    for (const key of this._standbyKeys(params, policy)) this.titlePreparedStandby.set(key, rec);
  }

  _findTitleStandby(params, policy = {}) {
    for (const key of this._standbyKeys(params, policy)) {
      const rec = this.titlePreparedStandby.get(key);
      if (!rec) continue;
      const live = rec.vf && rec.vf.id ? this.mounts.get(rec.vf.id) : null;
      if (!live || !live.streamable) {
        this.titlePreparedStandby.delete(key);
        continue;
      }
      rec.vf = live;
      return rec;
    }
    return null;
  }

  _clearTitleStandby(params, policy, pickKey) {
    for (const key of this._standbyKeys(params, policy)) {
      const rec = this.titlePreparedStandby.get(key);
      if (rec && rec.candidate && rec.candidate.pickKey === pickKey) this.titlePreparedStandby.delete(key);
    }
  }

  _hasActiveForeignPlayback(exceptVf = null) {
    const now = Date.now();
    const exceptId = exceptVf && exceptVf.id;
    for (const vf of this.mounts.values()) {
      if (!vf || (exceptId && vf.id === exceptId)) continue;
      if (mountNeedsUsenetShare(vf, now)) return true;
    }
    return false;
  }

  _standbyResolutionRank(candidate) {
    if (!candidate) return null;
    const rank = candidate.attributes && Number.isInteger(candidate.attributes.resolutionRank)
      ? candidate.attributes.resolutionRank
      : parseRelease(candidate.name).resolutionRank;
    return Number.isInteger(rank) ? rank : null;
  }

  // A 4K Details warmup that times out used to park a 1080 leftover under the 4K key.
  // Resume and Start Over then joined that 1080 forever and never raced the real 4K list.
  _preparedFitsPolicy(rec, policy = {}) {
    if (!rec || !rec.candidate) return false;
    const want = Number.isInteger(policy.exactResolutionRank) ? policy.exactResolutionRank : null;
    if (want == null) return true;
    const have = this._standbyResolutionRank(rec.candidate);
    return have == null || have === want;
  }

  _rememberPolicyForCandidate(policy = {}, candidate) {
    const have = this._standbyResolutionRank(candidate);
    const exact = Number.isInteger(policy.exactResolutionRank) ? policy.exactResolutionRank : null;
    if (exact == null || have == null || have === exact) return policy;
    const next = { ...policy };
    delete next.exactResolutionRank;
    next.preferResolutionRank = have;
    next.maxResolutionRank = have;
    return next;
  }

  _pickStandbyCandidate(playable, primaryPickKey, primary = null) {
    const rest = (playable || []).filter((c) => c && c.pickKey && c.pickKey !== primaryPickKey && c.score > -5000);
    if (!rest.length) return null;
    const want = this._standbyResolutionRank(primary);
    if (want != null) {
      const same = rest.find((c) => this._standbyResolutionRank(c) === want);
      if (same) return same;
    }
    return rest[0];
  }

  _armStandby(params, policy = {}, mountOpts = {}, playable = [], primaryPickKey, resumeFrac = 0, primary = null) {
    const next = this._pickStandbyCandidate(playable, primaryPickKey, primary);
    if (!next) return;
    const existing = this._findTitleStandby(params, policy);
    if (existing && existing.candidate && existing.candidate.pickKey === next.pickKey) {
      if (resumeFrac) this._startPlaybackWarmup(existing.vf, existing.vf._playWin, resumeFrac, {
        hot: this._prepareWarmIsHot(existing.vf),
      });
      return;
    }
    this._tryCandidate(next, { ...mountOpts, startupPriority: 'prepare' }).then((res) => {
      if (!res || !res.vf || res.fail) return;
      const primary = this._findTitlePreparedReady(params, policy);
      if (primary && primary.candidate && primary.candidate.pickKey === next.pickKey) return;
      res.vf._touched = Date.now();
      if (!mountHasActivePlayback(res.vf)) res.vf._preparedOnly = true;
      if (next.name) res.vf._releaseName = next.name;
      this.mounts.set(res.vf.id, res.vf);
      this.mountByUrl.set(res.vf._mountIdentity || mountIdentity(next, mountOpts), res.vf.id);
      this._rememberTitleStandby(params, policy, res.vf, next);
      this.rebalancePlaybackWindows();
      this._startPlaybackWarmup(res.vf, res.vf._playWin, resumeFrac, {
        hot: this._prepareWarmIsHot(res.vf),
      });
    }).catch(() => {});
  }

  _attachStandby(session, params, policy, mountOpts = {}) {
    if (!session || !session.candidates || session.candidates.length < 2) return;
    const primary = session.activeCandidate && session.activeCandidate.pickKey;
    const ready = this._findTitleStandby(params, policy);
    if (ready && ready.candidate && ready.candidate.pickKey !== primary) {
      session.standby = ready;
    }
    this._armStandby(params, policy, mountOpts, session.candidates, primary, session.query && session.query.resumeFrac, session.activeCandidate);
  }

  _findTitlePreparedReady(params, policy = {}) {
    const keys = [this._prepareJobKey(params, policy)];
    if (params.imdbid || params.tvdbid) {
      keys.push(this._prepareJobKey(params, policy, { ignoreCatalogIds: true }));
    }
    for (const key of keys) {
      const rec = this.titlePreparedReady.get(key);
      if (!rec) continue;
      const live = rec.vf && rec.vf.id ? this.mounts.get(rec.vf.id) : null;
      // Eviction is the TTL. A 3-minute clock used to drop a parked RAM mount while the
      // file was still live, so Resume remounted + re-parsed the NZB (~8s) for no reason.
      if (!live || !live.streamable) {
        this.titlePreparedReady.delete(key);
        continue;
      }
      if (!this._preparedFitsPolicy(rec, policy)) {
        console.log('[play] skip prepared ' + (rec.candidate && rec.candidate.name || '') + ' (want ' + (policy.exactResolutionRank || '') + ')');
        this.titlePreparedReady.delete(key);
        continue;
      }
      rec.vf = live;
      return rec;
    }
    return null;
  }

  _getFreshSearchHit(key, maxAgeMs = 60000) {
    const hit = this.searchCache.get(key);
    if (!hit) return null;
    if (Number.isFinite(maxAgeMs) && Date.now() - hit.at > maxAgeMs) return null;
    // LRU touch: re-insert so the eviction (delete oldest key) drops the genuinely least-recently-USED
    // entry, not the oldest-inserted. A hot replayed title survives a burst of unrelated browses.
    this.searchCache.delete(key); this.searchCache.set(key, hit);
    return hit;
  }

  _rememberSearchHit(key, hit) {
    const hasResults = !!(hit && hit.results && hit.results.length);
    // Never store an empty fan-out. A throttle 0-hit used to cache for 60s so the
    // next Play/Sources retry said "no playable" / "no 1080p lead".
    if (!hasResults) return;
    this.searchCache.set(key, hit);
    if (this.searchCache.size > 50) this.searchCache.delete(this.searchCache.keys().next().value);
  }

  _rememberNzb(url, xml) {
    this.nzbCache.set(url, xml);
    if (this.nzbCache.size > 15) this.nzbCache.delete(this.nzbCache.keys().next().value);
  }

  _startNzbFetch(candidate, opts = {}) {
    let pending = this.nzbInflight.get(candidate.nzbUrl);
    if (pending) {
      this.metrics.nzbInflightJoins++;
      return pending;
    }
    if (opts.prefetch) this.metrics.nzbPrefetches++;
    else this.metrics.nzbFetches++;
    pending = fetchUrl(candidate.nzbUrl, { timeoutMs: NZB_FETCH_IDLE_MS, deadlineMs: NZB_FETCH_DEADLINE_MS, maxBytes: 100 * 1024 * 1024 })
      .then((r) => {
        const xml = r.body.toString('utf8');
        if (r.status !== 200 || !/<file\b/i.test(xml)) throw new Error(`nzb fetch HTTP ${r.status}`);
        this._rememberNzb(candidate.nzbUrl, xml);
        return xml;
      })
      .finally(() => this.nzbInflight.delete(candidate.nzbUrl));
    this.nzbInflight.set(candidate.nzbUrl, pending);
    return pending;
  }

  _streamConnCap(vfOrBig, perf = {}) {
    const vf = (vfOrBig && typeof vfOrBig === 'object') ? vfOrBig : { size: vfOrBig ? 5e9 : 2e9 };
    const custom = perf.connectionMode === 'custom';
    const configured = custom
      ? (streamIsUhd(vf) ? (perf.maxConnPerStream4k || 20) : (perf.maxConnPerStream1080 || 12))
      : autoStreamCap(vf, perf);
    let pressure = 1;
    try {
      const pool = typeof this.pool === 'function' ? this.pool() : this.pool;
      pressure = householdConnPressure(pool && pool.providers);
    } catch {}
    return Math.max(4, Math.floor(configured * pressure));
  }

  _allocateStreamConnections(active, perf, opts = {}) {
    let growFrozen = opts.growFrozen === true;
    try {
      const pool = typeof this.pool === 'function' ? this.pool() : this.pool;
      if (householdConnPressure(pool && pool.providers) < 1) growFrozen = true;
    } catch {}
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const assigned = allocateStreamConnections(active, perf, {
      ...opts,
      now,
      growFrozen,
      lastStealAt: this._allocLastStealAt || 0,
      caps: perf.connectionMode === 'custom'
        ? active.map((vf) => this._streamConnCap(vf, perf))
        : null,
    });
    if (assigned.stole) this._allocLastStealAt = now;
    const out = new Map();
    active.forEach((vf, i) => out.set(vf, assigned[i]));
    return out;
  }

  _playbackWindowFor(vf, activeMounts, perf = this.performance() || {}, assignedReadAhead, activeList) {
    const big = streamIsUhd(vf);
    const siblings = Array.isArray(activeList) && activeList.length ? activeList : null;
    const activeCount = Math.max(1, siblings ? siblings.length : (activeMounts || 1));
    const usable = perf.usableConnections || 0;
    const reserve = perf.reserveConnections || 0;
    const perStreamBudget = usable > reserve ? Math.max(4, Math.floor((usable - reserve) / activeCount)) : Infinity;
    const baseCap = this._streamConnCap(vf, perf);
    const configuredWindow = Number.isFinite(assignedReadAhead)
      ? Math.max(baseCap, Math.floor(assignedReadAhead))
      : baseCap;
    const fairReadAhead = Math.max(4, Math.min(configuredWindow, perStreamBudget));
    const readAhead = Number.isFinite(assignedReadAhead)
      ? Math.max(4, Math.min(configuredWindow, Math.floor(assignedReadAhead)))
      : fairReadAhead;
    const borrowedReserve = reserve > 2 ? Math.floor(reserve / 2) : 0;
    const adaptiveBudget = usable > reserve
      ? Math.max(readAhead, Math.floor((usable - Math.max(1, reserve - borrowedReserve)) / activeCount))
      : readAhead;
    const maxReadAhead = Math.max(readAhead, Math.min(configuredWindow, adaptiveBudget, readAhead + 4));
    const bufferSec = Number(big ? perf.buffer4kSec : perf.buffer1080Sec);
    const hasBufferTarget = Number.isFinite(bufferSec) && bufferSec > 0;
    const fallbackCacheMb = big
      ? Math.max(96, Math.floor(192 / activeCount))
      : Math.max(48, Math.floor(96 / activeCount));
    let cacheMaxBytes = fallbackCacheMb * 1024 * 1024;
    let cacheMax = Math.max(readAhead * 3, big ? 48 : 36);
    if (hasBufferTarget) {
      // The owner setting is in SECONDS, but the VFS retains decoded article bytes — so convert
      // seconds → a byte target using the file's REAL average bitrate (size ÷ probed duration), not
      // a fixed guess. The old fixed 24 Mbps assumption + 384 MB cap badly under-sized high-bitrate
      // 4K (Dolby Vision / HDR10+ ~60-90 Mbps): it held only ~38s regardless of the configured goal,
      // so a brief upstream latency spike drained the buffer and stalled playback every few minutes.
      const durationSec = vf && vf._tracks && Number(vf._tracks.duration) > 0 ? Number(vf._tracks.duration) : 0;
      const measuredMbps = durationSec && vf.size ? ((vf.size * 8) / durationSec) / 1e6 : 0;
      // VBR 4K PEAKS well above its size/duration average (action scenes can be 2-3x the average),
      // so size the buffer for the PEAK — otherwise a high-bitrate sequence drains a buffer that
      // looked deep "on average" (a 35 GB / 3.5 h film averages ~24 Mbps but spikes to ~80). Before
      // the probe lands, use a realistic default; clamp so a bad probe can't zero out or balloon it.
      const avgMbps = measuredMbps || (big ? 45 : 12);
      const streamMbps = Math.max(big ? 45 : 12, Math.min(big ? 120 : 50, avgMbps * (big ? 2.2 : 1.4)));
      const targetMb = Math.ceil((bufferSec * streamMbps) / 8);
      // 200s is the goal. One mount cannot keep ~3 GB on the Node heap — that GC-stalls
      // Play. Cap one stream to ~8% RAM, never above 1536 MB, then split across viewers.
      const minMb = big ? 96 : 48;
      const maxMb = playbackCacheCapMb(big, TOTAL_MEM_MB);
      const totalMb = Math.max(minMb, Math.min(maxMb, targetMb));
      let share = 1 / activeCount;
      if (perf.connectionMode !== 'custom' && siblings && siblings.length > 1) {
        const weights = siblings.map((m) => cacheNeedWeight(m));
        const sum = weights.reduce((a, b) => a + b, 0) || siblings.length;
        const idx = Math.max(0, siblings.indexOf(vf));
        share = (weights[idx] || 1) / sum;
      }
      const perActiveMb = Math.max(big ? 64 : 32, Math.floor(totalMb * share));
      cacheMaxBytes = perActiveMb * 1024 * 1024;
      const segmentBytes = Number(vf.partSize)
        || (Array.isArray(vf.segments) && vf.segments.length ? Math.ceil((vf.size || 0) / vf.segments.length) : 0);
      if (Number.isFinite(segmentBytes) && segmentBytes > 0) {
        cacheMax = Math.max(cacheMax, Math.ceil(cacheMaxBytes / segmentBytes));
      }
    }
    return {
      readAhead,
      maxReadAhead,
      cacheMax,
      cacheMaxBytes,
    };
  }

  _applyPlaybackWindow(vf, activeMounts, perf = this.performance() || {}, assignedReadAhead, activeList) {
    if (!vf) return null;
    const previousCacheMaxBytes = Math.max(1, Number(vf._playWin && vf._playWin.cacheMaxBytes) || Infinity);
    const win = this._playbackWindowFor(vf, activeMounts, perf, assignedReadAhead, activeList);
    if (win.cacheMaxBytes < previousCacheMaxBytes) {
      vf._warmedResumeFrac = null;
      vf._warmedResumeRange = null;
    }
    for (const v of (vf.vols || [vf])) {
      if (typeof v.applyPlaybackWindow === 'function') v.applyPlaybackWindow(win);
      else {
        v.readAhead = win.readAhead;
        v.maxReadAhead = win.maxReadAhead;
        v.cacheMax = win.cacheMax;
        v.cacheMaxBytes = win.cacheMaxBytes;
        if (typeof v.trimCache === 'function') v.trimCache();
      }
    }
    vf._activePlayWin = win;
    vf._playWin = win;
    return win;
  }

  _preparedCacheTotalBytes() {
    const ramDerived = Math.floor(this.totalMemMb * PREPARED_RAM_FRACTION * 1024 * 1024);
    return Math.min(PREPARED_TOTAL_MAX_BYTES, Math.max(PREPARED_CACHE_BYTES_1080, ramDerived));
  }

  _preparedHouseHasRoom() {
    try {
      const pool = typeof this.pool === 'function' ? this.pool() : this.pool;
      return preparedHouseHasRoom(pool && pool.providers);
    } catch {
      return true;
    }
  }

  _prepareWarmIsHot(exceptVf = null) {
    return this._preparedHouseHasRoom() && !this._hasActiveForeignPlayback(exceptVf);
  }

  _quietOtherPreparedWarms(exceptVf = null) {
    const exceptId = exceptVf && exceptVf.id;
    for (const other of this.mounts.values()) {
      if (!other || (exceptId && other.id === exceptId)) continue;
      if (other._preparedOnly && !mountHasActivePlayback(other)) this.cancelPlaybackWarmups(other);
    }
  }

  _preparedPeekSockets() {
    try {
      const pool = typeof this.pool === 'function' ? this.pool() : this.pool;
      return preparedPeekSockets(pool && pool.providers);
    } catch {
      return PREPARED_PEEK_MAX;
    }
  }

  _applyPreparedWindow(vf, win = {}, aggregateShare = Infinity) {
    if (!vf) return null;
    const aheadCap = this._preparedPeekSockets();
    const wide = aheadCap > PREPARED_PEEK_MIN;
    const activeWin = vf._activePlayWin || win;
    const cap = streamIsUhd(vf)
      ? (wide ? PREPARED_CACHE_BYTES_4K_WIDE : PREPARED_CACHE_BYTES_4K)
      : (wide ? PREPARED_CACHE_BYTES_1080_WIDE : PREPARED_CACHE_BYTES_1080);
    const previousCacheMaxBytes = Math.max(1, Number(vf._playWin && vf._playWin.cacheMaxBytes) || Infinity);
    const prepared = {
      ...activeWin,
      readAhead: Math.min(aheadCap, Math.max(0, Number(activeWin.readAhead) || 0)),
      maxReadAhead: Math.min(aheadCap, Math.max(0, Number(activeWin.maxReadAhead) || 0)),
      cacheMaxBytes: Math.min(cap, Math.max(1, Number(activeWin.cacheMaxBytes) || cap), aggregateShare),
    };
    // A REAL cap shrink can evict the warmed resume interval. Identical prepared reapplication is
    // common during another viewer's Range rebalance and must preserve the short coverage TTL.
    if (prepared.cacheMaxBytes < previousCacheMaxBytes) {
      vf._warmedResumeFrac = null;
      vf._warmedResumeRange = null;
    }
    for (const v of (vf.vols || [vf])) {
      if (typeof v.applyPlaybackWindow === 'function') v.applyPlaybackWindow(prepared);
      else {
        v.readAhead = prepared.readAhead;
        v.maxReadAhead = prepared.maxReadAhead;
        v.cacheMax = prepared.cacheMax;
        v.cacheMaxBytes = prepared.cacheMaxBytes;
        if (typeof v.trimCache === 'function') v.trimCache();
      }
    }
    vf._playWin = prepared;
    return prepared;
  }

  rebalancePreparedWindows(now = Date.now()) {
    const prepared = [...this.mounts.values()]
      .filter((vf) => vf && vf.streamable && vf._preparedOnly && !mountHasActivePlayback(vf, now));
    if (!prepared.length) return 0;
    const share = Math.max(1, Math.floor(this._preparedCacheTotalBytes() / prepared.length));
    for (const vf of prepared) this._applyPreparedWindow(vf, vf._activePlayWin || vf._playWin || {}, share);
    return prepared.length;
  }

  _startPlaybackWarmup(vf, win, resumeFrac = 0, opts = {}) {
    if (!vf || !vf.streamable || typeof vf.read !== 'function') return;
    const size = Number(vf.size) || 0;
    if (size <= 0) return;
    const big = streamIsUhd(vf);
    const othersPlaying = [...this.mounts.values()].some((m) => (
      m && m !== vf && m.streamable && mountNeedsUsenetShare(m)
    ));
    const capBytes = Number(win && win.cacheMaxBytes) || 0;
    const warmMb = (big && !othersPlaying) ? 96 : 32;
    const warmBytes = Math.min(size, capBytes || Infinity, warmMb * 1024 * 1024);
    if (!Number.isFinite(warmBytes) || warmBytes <= 0) return;
    const warm = (key, from, to, priority = 'readAhead') => {
      if (!(to > from)) return;
      this._cancelPlaybackWarmup(vf, key);
      if (!(vf._playbackWarmupJobs instanceof Map)) vf._playbackWarmupJobs = new Map();
      const controller = new AbortController();
      const job = { controller, timer: null, promise: null };
      job.timer = setTimeout(() => {
        job.timer = null;
        job.promise = (async () => {
          const warmPriority = priority || 'readAhead';
          for await (const _chunk of vf.read(from, to, { priority: warmPriority, signal: controller.signal })) {
            // Only a short first-picture slice stays on startup/seek. The old path put the
            // whole 4K head+tail+resume window on that lane, so a 1080p seek next to it waited.
          }
        })().catch(() => {}).finally(() => {
          // VFS read-ahead is fire-and-forget. Ending the explicit generator does not mean its
          // trailing article fetches ended, so close this warm job's signal on normal completion too.
          // Shared fetches remain alive when an active player is still a consumer.
          if (!controller.signal.aborted) controller.abort();
          if (vf._playbackWarmupJobs && vf._playbackWarmupJobs.get(key) === job) {
            vf._playbackWarmupJobs.delete(key);
          }
        });
      }, 150);
      vf._playbackWarmupJobs.set(key, job);
      if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
    };
    // RESUME WINDOW. A Continue-Watching resume makes the player seek straight to a DEEP mid-file byte
    // offset that the head/tail warm never primed — that cold window is the 20-30s resume wait on
    // Android (and worse for big 4K multi-volume RARs). Warm it on the SAME read-ahead lane + cap as
    // head/tail. resumeFrac (resume seconds / duration) comes from the client, which knows the
    // duration; the server's _tracks aren't probed yet at prepare/play, so we can't compute it here.
    // Allowed once per distinct resume position even if the head/tail warm already ran (the position
    // can change between focuses). Worst case (no/odd frac) it simply doesn't fire — never a regression.
    const frac = Number(resumeFrac) || 0;
    const resuming = frac > 0.02 && frac < 0.985;
    if (!resuming) {
      this._cancelPlaybackWarmup(vf, 'resume');
      this._cancelPlaybackWarmup(vf, 'resume:tail');
      vf._warmedResumeFrac = null;
      vf._warmedResumeRange = null;
    }
    if (resuming) {
      const target = Math.max(0, Math.min(size - 1, Math.floor(size * frac)));
      const previous = vf._warmedResumeRange;
      const safety = Math.max(1, Math.floor(warmBytes * 0.1));
      const covered = previous && Date.now() - (Number(previous.at) || 0) < RESUME_WARM_COVERAGE_TTL_MS
        && target >= previous.start + safety && target < previous.end - safety;
      if (!covered) {
        vf._warmedResumeFrac = frac;
        const back = Math.floor(warmBytes * 0.3); // start well BEFORE the estimate to absorb VBR time→byte drift
        const start = Math.max(0, Math.min(Math.max(0, size - warmBytes), target - back));
        const end = Math.min(size, start + warmBytes);
        vf._warmedResumeRange = { start, end, at: Date.now() };
        const hot = opts && opts.hot === true;
        if (hot) {
          const urgent = Math.min(end, start + (big ? 16 : 8) * 1024 * 1024);
          warm('resume', start, urgent, 'seek');
          if (end > urgent) warm('resume:tail', urgent, end, 'readAhead');
        } else {
          warm('resume', start, end, 'readAhead');
        }
      }
    }
    // HEAD: a fresh start plays from the head (full warm); a resume only needs the container header
    // parsed (its body is the resume window above), so warm just a small head there to keep the cache
    // budget close to the non-resume head+tail. Start Over / a later 0:00 play may reuse a mount
    // that was prepared for Resume — that mount only has the small header, so expand to a full head
    // instead of leaving 0:00 cold.
    const headBytes = resuming ? Math.min(warmBytes, (big ? 16 : 8) * 1024 * 1024) : warmBytes;
    const needFullHead = !resuming && !vf._fullHeadWarmed;
    if (vf._playbackWarmupStarted && !needFullHead) return;
    const firstWarm = !vf._playbackWarmupStarted;
    vf._playbackWarmupStarted = true;
    const hot = opts && opts.hot === true;
    if (hot && !resuming) {
      const urgent = Math.min(headBytes, (big ? 16 : 8) * 1024 * 1024);
      warm('head', 0, urgent, 'startup');
      if (headBytes > urgent) warm('head:tail', urgent, headBytes, 'readAhead');
    } else {
      warm('head', 0, headBytes, 'readAhead');
    }
    if (!resuming) vf._fullHeadWarmed = true;
    if (!firstWarm) return;
    // TAIL warm — the decisive fix for "plays fine, then buffers after a minute". The browser fMP4
    // remux (ffmpeg) AND Android ExoPlayer both parse the container INDEX before they can stream:
    // mkv Cues / mp4 moov, which for WEB-DL releases usually sits at the END of the file. ffmpeg
    // seeks there on its first reads via HTTP Range; a COLD tail turns each parse-seek into a
    // multi-second uncached fetch, so the remux trickles at 4-12 Mbps for ~30s (below the play
    // bitrate → the player's startup buffer drains → buffering) before it finally streams. Measured
    // live: warming head+tail cut a 36s / 21 Mbps cold remux start to <4s / 240 Mbps. Fired
    // concurrently with the head warm (own timer), bounded by the cache cap, and skipped when it
    // would overlap the head warm (small files).
    const tailBytes = Math.min(size, capBytes || Infinity, (big ? 48 : 24) * 1024 * 1024);
    if (tailBytes > 0 && size - tailBytes > warmBytes) warm('tail', size - tailBytes, size, 'readAhead');
  }

  _cancelPlaybackWarmup(vf, key) {
    const jobs = vf && vf._playbackWarmupJobs;
    if (!(jobs instanceof Map)) return false;
    const job = jobs.get(key);
    if (!job) return false;
    jobs.delete(key);
    if (job.timer) clearTimeout(job.timer);
    if (job.controller && !job.controller.signal.aborted) job.controller.abort();
    return true;
  }

  cancelPlaybackWarmups(vf) {
    const jobs = vf && vf._playbackWarmupJobs;
    if (!(jobs instanceof Map)) return 0;
    let cancelled = 0;
    for (const key of [...jobs.keys()]) if (this._cancelPlaybackWarmup(vf, key)) cancelled++;
    return cancelled;
  }

  schedulePlaybackExpiryRebalance(now = Date.now()) {
    if (this._playbackRuntimeDisposed) return null;
    let next = Infinity;
    for (const vf of this.mounts.values()) {
      if (!vf || !vf.streamable || vf._preparedOnly || (Number(vf._activeStreamReads) || 0) > 0) continue;
      const touched = Number(vf._playbackTouched) || 0;
      const expires = touched + ACTIVE_PLAYBACK_GRACE_MS;
      if (touched > 0 && expires > now) next = Math.min(next, expires);
    }
    if (!Number.isFinite(next)) {
      this.clearPlaybackExpiryRebalance();
      return null;
    }
    const due = next + 5; // cross the strict grace boundary even if the timer fires a few ms early
    if (this._playbackExpiryTimer && this._playbackExpiryAt === due) return due;
    this.clearPlaybackExpiryRebalance();
    this._playbackExpiryAt = due;
    this._playbackExpiryTimer = setTimeout(() => {
      this._playbackExpiryTimer = null;
      this._playbackExpiryAt = 0;
      const firedAt = Date.now();
      this.rebalancePlaybackWindows(firedAt);
      this.schedulePlaybackExpiryRebalance(firedAt);
    }, Math.max(1, due - now));
    if (this._playbackExpiryTimer && typeof this._playbackExpiryTimer.unref === 'function') {
      this._playbackExpiryTimer.unref();
    }
    return due;
  }

  clearPlaybackExpiryRebalance() {
    if (this._playbackExpiryTimer) clearTimeout(this._playbackExpiryTimer);
    this._playbackExpiryTimer = null;
    this._playbackExpiryAt = 0;
  }

  disposePlaybackRuntime() {
    this._playbackRuntimeDisposed = true;
    this.clearPlaybackExpiryRebalance();
  }

  rebalancePlaybackWindows(now = Date.now()) {
    const perf = this.performance() || {};
    for (const vf of this.mounts.values()) {
      const touched = Number(vf && vf._playbackTouched) || 0;
      if (vf && vf.streamable && !vf._preparedOnly && (Number(vf._activeStreamReads) || 0) <= 0
          && touched > 0 && now - touched >= ACTIVE_PLAYBACK_GRACE_MS) {
        vf._preparedOnly = true;
      }
    }
    const active = [...this.mounts.values()]
      .filter((m) => mountNeedsUsenetShare(m, now));
    const activeCount = Math.max(1, active.length);
    const viewerChanged = this._allocActiveCount !== active.length;
    this._allocActiveCount = active.length;
    const shares = this._allocateStreamConnections(active, perf, { viewerChanged, now });
    for (const vf of active) this._applyPlaybackWindow(vf, activeCount, perf, shares.get(vf), active);
    this.rebalancePreparedWindows(now);
    this.metrics.windowRebalances++;
    return active.length;
  }

  async _fetchSearchHit(ixs, params, wanted, timeoutMs, opts = {}) {
    ixs.forEach((ix) => this.usage.onSearch(ix.name)); // a real fan-out costs one API hit per indexer
    // Start the short-title alias in parallel with the main query so Play does not wait
    // 2s + 2s when both are needed. Merge after both land; empty-result fallbacks stay serial.
    const aliasQ = shortTitleQuery(params.q, wanted);
    const idSearch = !!(params.imdbid || params.tvdbid);
    const season = Number(params.season);
    const ep = Number(params.ep);
    const episodeSearch = Number.isInteger(season) && Number.isInteger(ep) && season >= 0 && ep > 0;
    // Branded catalog titles ("Special Ops: Lioness") need the unique half. TMDB now names that
    // show just "Lioness", so there is no alias — but tvsearch+tvdbid still only returns the few
    // ID-tagged Special.Ops.Lioness leftovers. Always pair an id episode search with a plain
    // t=search of the same q so Lioness.S01E01 WEB-DLs actually show up.
    const titleQ = aliasQ || (idSearch && episodeSearch ? params.q : '');
    let aliasP = null;
    if (titleQ) {
      ixs.forEach((ix) => this.usage.onSearch(ix.name));
      const aliasParams = { q: titleQ };
      aliasP = this._fanoutMeasured(ixs, aliasParams, { timeoutMs });
    }
    // 4K toggle: ID/title searches often fill the first page with 1080p. A parallel
    // q-only "2160p" fan-out finds UHD WEB-DLs the id search never ranked high enough to return.
    let uhdP = null;
    if (opts.wantUhd && params.q && !/\b(2160p|4k|uhd)\b/i.test(params.q)) {
      ixs.forEach((ix) => this.usage.onSearch(ix.name));
      const uhdParams = { q: `${params.q} 2160p` };
      if (episodeSearch) { uhdParams.season = season; uhdParams.ep = ep; }
      uhdP = this._fanoutMeasured(ixs, uhdParams, { timeoutMs });
    }
    const akaQs = opts.widenSearch === false ? [] : aliasSearchQueries(params.q, params.aliases, wanted);
    const akaJobs = akaQs.map((q) => {
      ixs.forEach((ix) => this.usage.onSearch(ix.name));
      return this._fanoutMeasured(ixs, { q }, { timeoutMs });
    });
    let { results, errors } = await this._fanoutMeasured(ixs, params, { timeoutMs });
    // TITLE VERIFICATION — indexers return loosely-related releases; a release only
    // qualifies if its name actually contains the wanted title (and episode/year) AND
    // any indexer IMDb/TVDB tag matches the catalog title. Wrong remake = trust-killer.
    const qualifies = (r) => releaseQualifies(r, wanted, params);
    results = results.filter(qualifies);
    if (aliasP) {
      const retry = await aliasP;
      results = mergeQualifiedResults(results, retry.results, qualifies);
      if (retry.errors && retry.errors.length) errors = errors.concat(retry.errors);
    }
    if (uhdP) {
      const extra = await uhdP;
      results = mergeQualifiedResults(results, extra.results, qualifies);
      if (extra.errors && extra.errors.length) errors = errors.concat(extra.errors);
    }
    if (akaJobs.length) {
      const extras = await Promise.all(akaJobs);
      for (const extra of extras) {
        results = mergeQualifiedResults(results, extra.results, qualifies);
        if (extra.errors && extra.errors.length) errors = errors.concat(extra.errors);
      }
    }
    // Fallback: long branded titles ("Brand Name Subtitle SxxEyy") often index under the
    // shorter brand — retry once with a trimmed QUERY, but verify hits against the FULL
    // original title so the shorter search can never surface a different film.
    if (!results.length) {
      const words = params.q.split(' ');
      const tail = words.filter((w) => /^(S\d{2}E\d{2}|s\d{2}e\d{2}|(19|20)\d{2})$/.test(w));
      const head = words.filter((w) => !tail.includes(w));
      if (head.length > 3) {
        const simpler = [...head.slice(0, 3), ...tail].join(' ');
        ixs.forEach((ix) => this.usage.onSearch(ix.name));
        const retry = await this._fanoutMeasured(ixs, { ...params, q: simpler }, { timeoutMs });
        const verified = retry.results.filter(qualifies);
        if (verified.length) { results = verified; errors = retry.errors; }
      }
    }
    // Some Newznab providers return worse/no results for imdbid/tvdbid searches even when
    // their plain title index has the release. Fall back to q-only, but keep the same strict
    // title verifier so catalog identity improves precision without making old films vanish.
    if (!results.length && (params.imdbid || params.tvdbid)) {
      const titleOnly = { ...params };
      delete titleOnly.imdbid;
      delete titleOnly.tvdbid;
      ixs.forEach((ix) => this.usage.onSearch(ix.name));
      const retry = await this._fanoutMeasured(ixs, titleOnly, { timeoutMs });
      const verified = retry.results.filter(qualifies);
      if (verified.length) { results = verified; errors = retry.errors; }
    }
    // "Mutiny 2026" missed every file indexed as just "Mutiny". Only when the titled
    // search is empty — a parallel yearless query on every movie splits Play/warmup.
    if (!results.length && opts.widenSearch !== false) {
      const yearless = yearlessSearchQuery(params.q, wanted);
      if (yearless) {
        ixs.forEach((ix) => this.usage.onSearch(ix.name));
        const retry = await this._fanoutMeasured(ixs, { q: yearless }, { timeoutMs });
        const verified = retry.results.filter(qualifies);
        if (verified.length) { results = verified; errors = retry.errors; }
      }
    }
    return { at: Date.now(), results, errors };
  }

  // Search + rank only (powers the Sources drawer). Applies cached verdict adjustments.
  async search(params, policy = {}, { timeoutMs = 2000, allowStale = false, widenSearch = true } = {}) {
    const ixs = this.indexers();
    if (!ixs.length) throw new Error('no indexers configured');
    // Scene names never carry punctuation — "Tom Clancy's Jack Ryan: Ghost War" must reach
    // the indexer as "Tom Clancys Jack Ryan Ghost War" or it finds nothing. Hyphens split into
    // spaces too: "Spider-Noir" found nothing while "Spider Noir" matched 30 releases.
    const sanitize = (q) => String(q || '').replace(/['’`]/g, '').replace(/[:&,!?./\\()\[\]\-_;]+/g, ' ').replace(/\s+/g, ' ').trim();
    // The indexer query and the title verifier are DELIBERATELY derived from different strings.
    // sanitize() strips "&" (scene names never carry it) for the cleanest indexer query, but the
    // verifier needs "&" turned into the skippable word "and" (His & Hers → his/and/hers) so real
    // releases spelled His.and.Hers still pass releaseMatches — parseWantedTitle does that on the
    // ORIGINAL query. Parsing the SANITIZED query instead dropped the "&" before the conversion
    // could run, so every "and"-spelled release was rejected and only one loose source survived.
    const rawQ = String(params.q || '');
    params = { ...params, q: sanitize(rawQ) };
    const season = Number(params.season);
    const ep = Number(params.ep);
    let verifyQ = rawQ;
    if (Number.isInteger(season) && Number.isInteger(ep) && season >= 0 && ep > 0 && !/\bS\d{1,2}\s*E\d{1,3}\b/i.test(params.q)) {
      const se = ` S${String(season).padStart(2, '0')}E${String(ep).padStart(2, '0')}`;
      params.q = `${params.q}${se}`.trim();
      verifyQ = `${verifyQ}${se}`.trim();
    }
    const wanted = parseWantedTitle(verifyQ);
    // Episode Play sends year=2005 on the body, not in q ("The Office S01E01"). Without this
    // copy, The.Office.2024 still matches the title+episode and can outrank the US original.
    if (wanted && !wanted.year && policy.wantedYear) wanted.year = policy.wantedYear;
    if (widenSearch !== false && params.aliases && params.aliases.length) {
      wanted.akaWords = params.aliases
        .map((a) => parseWantedTitle(a).words)
        .filter((words) => words && words.length);
    }
    // TV episode context for scoring: a whole-season PACK must not be size-cap-disqualified — only ONE
    // episode streams from it (it's still size-SHAPED, so it stays a low-ranked fallback below singles).
    // Scoped to episode requests; movies/season-less searches never get wantedEpisode → unaffected.
    { const _we = wantedEpisodeOf(params); if (_we) policy = { ...policy, wantedEpisode: _we }; }
    // The matcher accepts ±1 year (regional release-date drift); scoring should still PREFER the
    // exact year so a re-release/adjacent-year duplicate never outranks the true title on a tie.
    if (wanted && wanted.year) {
      policy = { ...policy, wantedYear: wanted.year };
      params = { ...params, year: wanted.year };
    }
    const wantUhd = policy.exactResolutionRank === 4 || policy.preferResolutionRank === 4;
    const akaQueries = widenSearch === false ? [] : aliasSearchQueries(params.q, params.aliases, wanted);
    const key = this._searchCacheKey(params, { wantUhd, akaQueries, widenSearch });
    const titleKey = this._searchCacheKey(params, { ignoreCatalogIds: true, wantUhd, akaQueries, widenSearch });
    const maxAgeMs = allowStale ? Number.POSITIVE_INFINITY : 60000;
    let hit = this._getFreshSearchHit(key, maxAgeMs);
    if (!hit && (params.imdbid || params.tvdbid)) {
      hit = this._getFreshSearchHit(titleKey, maxAgeMs);
      if (hit) this._rememberSearchHit(key, hit);
    }
    if (hit) {
      this.metrics.searchCacheHits++;
    } else {
      this.metrics.searchCacheMisses++;
      let pending = this.searchInflight.get(key);
      let pendingKey = key;
      if (!pending && (params.imdbid || params.tvdbid)) {
        pending = this.searchInflight.get(titleKey);
        pendingKey = titleKey;
      }
      if (pending) this.metrics.searchInflightJoins++;
      if (!pending) {
        pending = this._fetchSearchHit(ixs, params, wanted, timeoutMs, { wantUhd, widenSearch })
          .then((fresh) => {
            this._rememberSearchHit(key, fresh);
            this._rememberSearchHit(titleKey, fresh);
            return fresh;
          })
          .finally(() => this.searchInflight.delete(key));
        this.searchInflight.set(key, pending);
      }
      hit = await pending;
      if (pendingKey !== key) this._rememberSearchHit(key, hit);
    }
    const { errors } = hit;
    // Re-filter on every use. Detail warmup is title-only and can cache a remake next to
    // the original; Play with catalog year/IMDb must drop the other version from that hit.
    const results = (hit.results || []).filter((r) => releaseQualifies(r, wanted, params));
    // Deep prefetch: warm the TOP candidate's NZB in the background while the user is still
    // looking at the title page. Track it per quality policy: warming the 1080p top pick
    // must not prevent a later 4K toggle from warming the UHD top pick too.
    const prefetchKey = JSON.stringify([
      policy.maxResolutionRank ?? null,
      policy.preferResolutionRank ?? null,
      policy.exactResolutionRank ?? null,
      policy.maxSizeGb4k ?? null,
      policy.maxSizeGb1080 ?? null,
      policy.sizePreferenceGB ?? null,
      policy.lowPowerDevice ? 1 : 0,
      policy.dolbyVision === false ? 0 : (policy.dolbyVision === true ? 1 : null),
      policy.deviceClass || null,
    ]);
    if (!hit.prefetchedKeys) hit.prefetchedKeys = new Set();
    if (!hit.prefetchedKeys.has(prefetchKey)) {
      hit.prefetchedKeys.add(prefetchKey);
      const top = rankReleases(results.map((r) => ({ ...r })), policy).find((c) => c.score > -5000);
      if (top && !this.nzbCache.has(top.nzbUrl) && this.usage.canGrab(top.indexer)) {
        this.usage.onGrab(top.indexer);
        this._startNzbFetch(top, { prefetch: true }).catch(() => {});
      }
    }
    const enriched = results.map((r) => {
      const v = lookupVerdict(this.verdicts, r);
      return {
        ...r,
        streamClass: cachedStreamClass(v),
        health: v ? (v.verdict === 'ok' ? 'verified' : v.verdict) : undefined,
      };
    });
    return { candidates: rankReleases(enriched, policy).map((c) => ({ ...c, pickKey: candidateKey(c) })), errors };
  }

  // Audiobook search: same indexer fan-out + verdict-cache + NZB machinery as video, but with the
  // Audio>Audiobook newznab category, the book-aware verifier, and the audiobook scorer. params:
  // { title, author, region, cat }. Returns { candidates, errors } shaped like search().
  async searchAudiobook(params = {}, { timeoutMs = 2500 } = {}) {
    const ixs = this.indexers();
    if (!ixs.length) throw new Error('no indexers configured');
    const title = String(params.title || '').trim();
    if (!title) throw new Error('title required');
    const author = String(params.author || '').trim();
    const wanted = parseWantedBook(title, author);
    const sanitize = (s) => String(s || '').replace(/['’`]/g, '').replace(/[:&,!?./\\()\[\]\-_;]+/g, ' ').replace(/\s+/g, ' ').trim();
    const cat = params.cat || '3030'; // 3030 = Newznab Audio>Audiobook; admins override via params.cat.
    const qFull = sanitize(`${author} ${title}`).trim() || sanitize(title);
    const qTitle = sanitize(title);
    // Real-world audiobook posts are inconsistently categorized and named, so try progressively
    // looser strategies until one yields VERIFIED book matches (each cached independently):
    //  1. category + "author title" (the precise case)
    //  2. category + "title" only (author formatting varies wildly: "Lastname, First", initials…)
    //  3. NO category + "author title" (indexers that don't tag audiobooks under 3030 at all) —
    //     safe because bookMatches still requires the author surname, so movies/other media drop out.
    const strategies = [{ q: qFull, cat }];
    if (qTitle !== qFull) strategies.push({ q: qTitle, cat });
    // Parent Audio category (3000) catches audiobooks mis-tagged under Audio-but-not-Audiobook,
    // before the last-resort no-category sweep. Only when using the default 3030 (admin overrides skip).
    if (cat === '3030') strategies.push({ q: qFull, cat: '3000' });
    strategies.push({ q: qFull, cat: undefined });
    let verified = [];
    let lastErrors = [];
    for (const strat of strategies) {
      const key = JSON.stringify(['ab', strat.q, strat.cat || '']);
      let hit = this._getFreshSearchHit(key);
      if (hit) { this.metrics.searchCacheHits++; }
      else {
        this.metrics.searchCacheMisses++;
        let pending = this.searchInflight.get(key);
        if (pending) this.metrics.searchInflightJoins++;
        if (!pending) {
          const searchParams = { q: strat.q };
          if (strat.cat) searchParams.cat = strat.cat;
          pending = (async () => {
            ixs.forEach((ix) => this.usage.onSearch(ix.name));
            const { results, errors } = await this._fanoutMeasured(ixs, searchParams, { timeoutMs });
            return { at: Date.now(), results, errors };
          })().finally(() => this.searchInflight.delete(key));
          this.searchInflight.set(key, pending);
        }
        hit = await pending;
        this._rememberSearchHit(key, hit);
      }
      lastErrors = hit.errors;
      verified = hit.results.filter((r) => bookMatches(r.name, wanted));
      if (verified.length) break; // first strategy that finds real books wins
    }
    const enriched = verified.map((r) => {
      const v = lookupVerdict(this.verdicts, r);
      return { ...r, health: v ? (v.verdict === 'ok' ? 'verified' : v.verdict) : undefined };
    });
    return {
      candidates: rankAudiobooks(enriched).map((c) => ({ ...c, pickKey: candidateKey(c) })),
      errors: lastErrors,
    };
  }

  // Cheap availability probe: is this book on usenet at all? ONE no-category fanout (the catch-all)
  // + the book verifier — used to filter discovery so a click never dead-ends. Reuses the 60s search
  // cache; the HTTP layer caches the boolean far longer.
  async isAvailable(params = {}, { timeoutMs = 3000 } = {}) {
    const title = String(params.title || '').trim();
    if (!title) return false;
    const ixs = this.indexers();
    if (!ixs.length) return false;
    const author = String(params.author || '').trim();
    const wanted = parseWantedBook(title, author);
    const sanitize = (s) => String(s || '').replace(/['’`]/g, '').replace(/[:&,!?./\\()\[\]\-_;]+/g, ' ').replace(/\s+/g, ' ').trim();
    const q = sanitize(`${author} ${title}`) || sanitize(title);
    const key = JSON.stringify(['abavail', q]);
    let hit = this._getFreshSearchHit(key);
    if (!hit) {
      let pending = this.searchInflight.get(key);
      if (!pending) {
        pending = (async () => {
          ixs.forEach((ix) => this.usage.onSearch(ix.name));
          const { results, errors } = await this._fanoutMeasured(ixs, { q }, { timeoutMs });
          return { at: Date.now(), results, errors };
        })().finally(() => this.searchInflight.delete(key));
        this.searchInflight.set(key, pending);
      }
      hit = await pending;
      this._rememberSearchHit(key, hit);
    }
    return hit.results.some((r) => bookMatches(r.name, wanted));
  }

  _recordVerdict(candidate, verdict, detail = {}) {
    this.verdicts.set(nzbVerdictKey(candidate.nzbUrl), verdict, detail);
    // unmappable is "this NZB's extents failed", not "the release name is 7z". Title-keying
    // it made every FLUX/NTb copy of that name unplayable for the verdict TTL.
    if (!skipTitleVerdict(verdict, detail)) {
      this.verdicts.set('t:' + normTitle(candidate.name), verdict, detail);
    }
    const fp = DEAD_RELEASE_VERDICTS.has(verdict) && releaseFingerprint(candidate);
    if (fp) this.verdicts.set(fp, verdict, detail);
  }

  // Mid-play abandon: always demote THIS nzb so the next warmup skips it. Title/fingerprint
  // stay movie-only so one episode stall cannot blacklist a season pack's siblings.
  _recordPlaybackFailed(candidate, { episodeScoped = false } = {}) {
    if (!candidate) return;
    this.verdicts.set(nzbVerdictKey(candidate.nzbUrl), 'playback-failed', { stage: 'recovery-advance' });
    if (!episodeScoped) {
      this.verdicts.set('t:' + normTitle(candidate.name), 'playback-failed', { stage: 'recovery-advance' });
    }
  }

  // Try one candidate: fetch NZB → mount → gate. Returns { vf } or { fail: reason }.
  async _tryCandidate(candidate, mountOpts = {}) {
    const identity = mountIdentity(candidate, mountOpts);
    const consumerSignal = mountOpts && mountOpts.signal;
    if (consumerSignal && consumerSignal.aborted) return { fail: 'cancelled: source race loser' };
    const fp = releaseFingerprint(candidate);
    const deadFp = fp && this.verdicts.get(fp);
    if (deadFp && DEAD_RELEASE_VERDICTS.has(deadFp.verdict)) {
      return { fail: `${deadFp.verdict}: same usenet post already known dead` };
    }
    // Live-mount reuse: replays and multi-user plays of the same release skip everything.
    const liveId = this.mountByUrl.get(identity);
    if (liveId) {
      const live = this.mounts.get(liveId);
      if (live && live.streamable) {
        live._touched = Date.now();
        if (candidate.name) live._releaseName = candidate.name;
        return { vf: live };
      }
      this.mountByUrl.delete(identity);
    }
    let record = this.prepareInflight.get(identity);
    // A last consumer may cancel the shared master while its non-cancellable indexer NZB fetch is
    // still unwinding. A later Play must not join that already-doomed record; it may safely reuse
    // the independent NZB fetch, then create a fresh mount controller of its own.
    if (record && !record.settled && record.controller.signal.aborted) {
      if (this.prepareInflight.get(identity) === record) this.prepareInflight.delete(identity);
      record = null;
    }
    if (!record) {
      const controller = new AbortController();
      record = { controller, consumers: 0, settled: false, promise: null };
      const runOpts = { ...mountOpts, signal: controller.signal };
      record.promise = Promise.resolve()
        .then(() => this._tryCandidateFresh(candidate, runOpts))
        .then((result) => {
          if (result && result.vf && !result.fail) result.vf._mountIdentity = identity;
          return result;
        })
        .finally(() => {
          record.settled = true;
          if (this.prepareInflight.get(identity) === record) this.prepareInflight.delete(identity);
        });
      this.prepareInflight.set(identity, record);
    }

    // Every play/prepare caller is a consumer of the shared mount. A hedged loser may detach at
    // once; the underlying startup work is aborted only when NO other caller still needs it. This
    // releases startup-priority NNTP work without breaking a concurrent play that joined the same
    // prepared mount.
    record.consumers++;
    let released = false;
    let removeAbort = () => {};
    const release = () => {
      if (released) return;
      released = true;
      removeAbort();
      record.consumers = Math.max(0, record.consumers - 1);
      if (!record.settled && record.consumers === 0 && !record.controller.signal.aborted) {
        record.controller.abort();
      }
    };
    if (!consumerSignal) {
      try { return await record.promise; }
      finally { release(); }
    }
    const cancelled = new Promise((resolve) => {
      const onAbort = () => {
        // Detach synchronously with the hedge decision so the shared master controller (when this is
        // its last consumer) releases the NNTP startup request before the winner is returned.
        release();
        resolve({ fail: 'cancelled: source race loser' });
      };
      consumerSignal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => consumerSignal.removeEventListener('abort', onAbort);
    });
    try { return await Promise.race([record.promise, cancelled]); }
    finally { release(); }
  }

  async _tryCandidateFresh(candidate, mountOpts = {}) {
    let ticket;
    try {
      ticket = await this._startupGate.acquire({
        signal: mountOpts && mountOpts.signal,
        priority: (mountOpts && mountOpts.startupPriority) || 'play',
      });
    } catch (e) {
      if ((e && e.code === 'ABORT_ERR') || (mountOpts && mountOpts.signal && mountOpts.signal.aborted)) {
        return { fail: 'cancelled: source race loser' };
      }
      throw e;
    }
    try {
      return await this._runCandidateFresh(candidate, mountOpts);
    } finally {
      ticket.release();
    }
  }

  async _runCandidateFresh(candidate, mountOpts = {}) {
    const selectionEpisodeScoped = isEpisodeCollectionName(candidate.name, mountOpts.wantedEpisode);
    const recordSelectionVerdict = (verdict, detail = {}) => {
      // Post-mount judgments describe the selected pack member. They must not blacklist every
      // episode behind the release-wide NZB/title keys; the current request still fails/advances.
      if (!selectionEpisodeScoped) this._recordVerdict(candidate, verdict, detail);
    };
    let xml = this.nzbCache.get(candidate.nzbUrl);
    // LRU touch: a hot NZB (fast replay / multi-user same title) survives eviction by unrelated grabs.
    if (xml) { this.nzbCache.delete(candidate.nzbUrl); this.nzbCache.set(candidate.nzbUrl, xml); this.metrics.nzbCacheHits++; }
    else {
      const pendingNzb = this.nzbInflight.get(candidate.nzbUrl);
      if (pendingNzb) {
        try {
          xml = await this._startNzbFetch(candidate);
        } catch (e) {
          this._recordVerdict(candidate, 'fetch-failed');
          return { fail: `nzb: ${e.message}` };
        }
      } else {
      // Daily grab limit: skipping is about the INDEXER's quota, not the release's health —
      // no verdict is recorded, so the release plays fine tomorrow (or via another indexer).
      if (!this.usage.canGrab(candidate.indexer)) {
        return { fail: `nzb: ${candidate.indexer} daily NZB limit reached` };
      }
      try {
        xml = await this._startNzbFetch(candidate);
        this.usage.onGrab(candidate.indexer);
      } catch (e) {
        this._recordVerdict(candidate, 'fetch-failed');
        return { fail: `nzb: ${e.message}` };
      }
      }
    }
    applyNzbFingerprintFields(candidate, xml);
    const fpAfterNzb = releaseFingerprint(candidate);
    const deadAfterNzb = fpAfterNzb && this.verdicts.get(fpAfterNzb);
    if (deadAfterNzb && DEAD_RELEASE_VERDICTS.has(deadAfterNzb.verdict)) {
      return { fail: `${deadAfterNzb.verdict}: same usenet post already known dead` };
    }

    // First-article STAT probe and the mount now run CONCURRENTLY (startup win #1). The probe used
    // to be AWAITED before the mount, adding one provider round-trip to every cold play. Now the
    // mount starts immediately; the cheap STAT only short-circuits a genuinely MISSING source, so
    // stale NZBs are still skipped fast without paying a full BODY mount on the healthy path.
    let probePromise = null;
    let probeEpisodeScoped = false;
    const probeT0 = Date.now();
    try {
      const probeTarget = firstProbeTarget(xml, mountOpts, candidate.name);
      const probeMsg = probeTarget.msgId;
      probeEpisodeScoped = probeTarget.episodeScoped;
      if (probeMsg) {
        probePromise = probeFirstArticle(this.pool(), probeMsg).then((verdict) => {
          const probeMs = Date.now() - probeT0;
          this.metrics.firstProbeMs += probeMs;
          this.metrics.firstProbeMaxMs = Math.max(this.metrics.firstProbeMaxMs, probeMs);
          if (verdict === 'missing') this.metrics.firstProbeMissing++;
          else if (verdict === 'timeout') { this.metrics.firstProbeTimeout++; candidate._probeTimeout = true; }
          else if (verdict === 'unreachable') this.metrics.firstProbeError++;
          else this.metrics.firstProbePresent++;
          return verdict;
        }, () => { this.metrics.firstProbeError++; return 'error'; });
      }
    } catch { this.metrics.firstProbeError++; }

    let vf;
    const mountT0 = Date.now();
    this.metrics.mountAttempts++;
    // Link a mount-local controller to the shared prepare signal. Terminal probe/deadline results
    // must stop the underlying BODY work before the prepare record becomes settled; otherwise a
    // returned failure can retain startup-priority pool capacity until the provider times out.
    const mountController = new AbortController();
    const parentMountSignal = mountOpts.signal || null;
    const onParentMountAbort = () => mountController.abort();
    if (parentMountSignal) {
      if (parentMountSignal.aborted) mountController.abort();
      else parentMountSignal.addEventListener('abort', onParentMountAbort, { once: true });
    }
    let mountParentDetached = false;
    const finishMountStartup = (abort = false) => {
      if (abort && !mountController.signal.aborted) mountController.abort();
      if (!mountParentDetached && parentMountSignal) {
        parentMountSignal.removeEventListener('abort', onParentMountAbort);
      }
      mountParentDetached = true;
    };
    const mountPromise = withDeadline(
      mountNzb(this.pool(), xml, { ...mountOpts, signal: mountController.signal, releaseName: candidate.name }),
      this.mountDeadlineMs,
      'mount timeout',
    );
    mountPromise.catch(() => {}); // a probe-missing short-circuit must not leave an unhandled rejection

    // Fail fast if the cheap probe proves the first article missing before the mount lands —
    // the dead-source skip the probe exists for, now without gating the healthy path.
    if (probePromise) {
      const winner = await Promise.race([
        probePromise.then((v) => ({ kind: 'probe', v })),
        mountPromise.then(() => ({ kind: 'mount' }), () => ({ kind: 'mount' })),
      ]);
      if (winner.kind === 'probe' && winner.v === 'missing') {
        finishMountStartup(true);
        if (!probeEpisodeScoped) this._recordVerdict(candidate, 'missing', { stage: 'first-article' });
        return { fail: `${probeEpisodeScoped ? 'episode' : 'missing'}: first article unavailable` };
      }
      // No provider answered at all — a connection/VPN/port/credentials problem, NOT a dead source.
      // Fail with an honest reason (no verdict cached — the source is fine once connectivity returns).
      if (winner.kind === 'probe' && winner.v === 'unreachable') {
        finishMountStartup(true);
        return { fail: 'provider unreachable: no usenet provider could be reached (connection/VPN/port/credentials)' };
      }
    }
    try {
      vf = await mountPromise;
      finishMountStartup(false);
      const mountMs = Date.now() - mountT0;
      this.metrics.mountSuccesses++;
      this.metrics.mountMs += mountMs;
      this.metrics.mountMaxMs = Math.max(this.metrics.mountMaxMs, mountMs);
    } catch (e) {
      const cancelled = !!(parentMountSignal && parentMountSignal.aborted)
        || !!(e && e.code === 'ABORT_ERR');
      finishMountStartup(true);
      const mountMs = Date.now() - mountT0;
      // Losing a hedge is scheduling, not source health or a mount failure. The caller already
      // detached this consumer; do not demote a healthy-but-slower release or skew failure metrics.
      if (cancelled) return { fail: 'cancelled: source race loser' };
      this.metrics.mountFailures++;
      this.metrics.mountMs += mountMs;
      this.metrics.mountMaxMs = Math.max(this.metrics.mountMaxMs, mountMs);
      // If the mount failed AND the concurrent probe says the first article is missing, report a
      // missing source (stable fast-skip verdict) rather than a generic mount error.
      if (probePromise) {
        const pv = await probePromise.catch(() => 'error');
        if (pv === 'missing') {
          if (!probeEpisodeScoped) this._recordVerdict(candidate, 'missing', { stage: 'first-article' });
          return { fail: `${probeEpisodeScoped ? 'episode' : 'missing'}: first article unavailable` };
        }
      }
      // Episode selection is scoped to this requested S/E, while health verdicts are release-wide.
      // Do not poison an otherwise valid season pack for every other episode when this member is
      // absent or ambiguous; simply advance this play to the next ranked source.
      if (e && e.code === 'EPISODE_SELECTION') return { fail: `episode: ${e.message}` };
      // Chronically SLOW source (the cheap STAT probe timed out AND the mount then timed out):
      // record the 'probe-timeout' demotion HEALTH_SCORE was designed with (-800 — softer than
      // mount-failed, the release may be fine on a better provider day) so the next play demotes
      // it up front instead of re-paying the full 30s mount walk. This flag was set but never
      // read, leaving the intended demotion dead code.
      if (probeEpisodeScoped && candidate._probeTimeout
          && /mount timeout/i.test(String(e && e.message || ''))) {
        return { fail: `mount: ${e.message} (requested episode only)` };
      }
      if (candidate._probeTimeout && /mount timeout/i.test(String(e && e.message || ''))) {
        if (!probeEpisodeScoped) this._recordVerdict(candidate, 'probe-timeout', { stage: 'mount' });
        return { fail: `mount: ${e.message} (slow articles — demoted for later)` };
      }
      if (!probeEpisodeScoped) this._recordVerdict(candidate, mountVerdictForError(e));
      return { fail: `mount: ${e.message}` };
    }

    if (!vf.streamable) {
      const streamClass = vf.tags.includes('compressed') ? 'compressed'
        : vf.tags.includes('encrypted') ? 'encrypted'
        : vf.tags.includes('unmappable') ? 'unmappable'
        : 'unsupported';
      recordSelectionVerdict('unstreamable', { streamClass, tags: vf.tags });
      return { fail: `unstreamable: ${vf.tags.join(',')}`, vf };
    }

    // The picked inner file must be the FEATURE, not the sample clip: a sample-only post
    // (68MB "2160p episode") mounted and auto-played as the real thing. Applies to archive
    // picks too — some releases keep Sample/ alongside the movie RARs.
    if (/\bsample\b/i.test(vf.name || '')) {
      recordSelectionVerdict('unstreamable', { streamClass: 'sample' });
      return { fail: `sample file picked (${vf.name})`, vf };
    }

    // Audiobook releases must resolve to an AUDIO file, never an ebook/text (.mobi/.epub/.pdf…) that
    // merely matched the title+author. Streaming one as audio errors on start → "source lost".
    if (mountOpts.audiobook && isNonAudioAudiobookMount(vf)) {
      this._recordVerdict(candidate, 'unstreamable', { streamClass: 'not-audio' });
      return { fail: `not an audiobook — non-audio file (${vf.name})`, vf };
    }

    // Size sanity on the ACTUAL mounted bytes. The pre-mount scoring floor (scoring.js) only sees
    // the indexer's DECLARED size, which can be missing or a lie — an incomplete/fake post mounts
    // far smaller than billed (a 220 MB file that auto-played as a 2160p movie). Fail it so the
    // walk advances to a genuine source — or reports "no healthy source" honestly, not silent junk.
    // Audiobooks are legitimately small (a short unabridged title at 32-64kbps can be well under the
    // video 80MB floor), so skip the video feature-size stub check for them — the audiobook scorer
    // already applied its own (much lower) pre-mount junk floor.
    const stub = this.enforceFeatureSize && !mountOpts.audiobook && stubFeatureReason(
      Number(vf.size) || 0, vf.name || candidate.name || '', Number(candidate.sizeBytes) || 0);
    if (stub) {
      recordSelectionVerdict('unstreamable', { streamClass: 'stub', sizeGb: +((Number(vf.size) || 0) / 1e9).toFixed(3) });
      return { fail: stub, vf };
    }

    // Playback read-ahead: keep work ahead of the player, but bound retained decoded bytes.
    // so the buffer outruns the bitrate — 4K-class releases (>4 GB) get the biggest window.
    // Segment sizes vary by release; the mount default stays small so triage/header peeks
    // never flood the pool.
    const perf = this.performance() || {};
    // Size this candidate as one bounded speculative/future viewer, but never count existing
    // prepare-only mounts. Details-page focus may prepare several titles; those mounts retain their
    // own capped warm window without shrinking the share of a playing 4K stream.
    const now = Date.now();
    const activeMounts = [...this.mounts.values()].filter((m) => mountNeedsUsenetShare(m, now)).length + 1;
    const win = this._applyPlaybackWindow(vf, activeMounts, perf);

    // Bounded gate: verdict within 500ms or we play anyway and keep checking in background.
    // (Provider quirk, see bench/RESULTS.md: healthy STATs answer in ~60-250ms; only MISSES
    // are slow — so "no answer by 500ms" usually means trouble, but we never block on it.)
    const gateT0 = Date.now();
    const probeLimit = this._hasActiveForeignPlayback(vf)
      ? 2
      : (perf.healthProbeLimit || 6);
    const triage = vf.triage(probeLimit).catch(() => null);
    const gate = await Promise.race([
      triage,
      new Promise((r) => setTimeout(r, GATE_MS, 'timeout')),
    ]);
    const gateMs = Date.now() - gateT0;
    this.metrics.healthGateMs += gateMs;
    this.metrics.healthGateMaxMs = Math.max(this.metrics.healthGateMaxMs, gateMs);
    const streamClass = vf.container === 'flat' ? 'flat' : vf.method; // consistent across both paths
    if (gate === 'timeout') {
      this.metrics.healthGateTimeouts++;
      triage.then((h) => {
        if (h && h.verdict && !h.unreachable && h.verdict !== 'unverified') {
          recordSelectionVerdict(h.verdict, { streamClass });
        }
      }).catch(() => {});
    } else if (gate && gate.unreachable) {
      // Provider down is not a rotten NZB. Play and retry health later.
    } else if (gate && gate.verdict === 'blocked') {
      this.metrics.healthGateBlocked++;
      recordSelectionVerdict('blocked', { streamClass });
      return { fail: 'health: blocked', vf };
    } else if (gate) {
      this.metrics.healthGateResults++;
      recordSelectionVerdict(gate.verdict, { streamClass });
    } else {
      this.metrics.healthGateResults++;
    }
    // Read-ahead warmup is started by the CALLER for the winning mount only — racing several
    // candidates (parallel walk) must not have losers draining the pool. Stash the window so the
    // caller can warm the winner with the same budget _applyPlaybackWindow just computed.
    vf._playWin = win;
    // Startup timing breadcrumb, read by the optional TRIBOON_STARTUP_TRACE logging in index.js.
    // Separates NZB/RAR mount cost from the bounded health gate so a slow VOD start can be pinned to
    // mount vs gate vs downstream (ffmpeg remux probe / moov tail-seek), which the index.js handlers
    // append when serving. Pure diagnostic data — no effect on playback behaviour.
    vf._su = {
      t0: mountT0,
      mountMs: gateT0 - mountT0,
      gateMs,
      name: vf.name,
      size: Number(vf.size) || 0,
      container: vf.container,
      method: vf.method,
    };
    return { vf };
  }

  // Full play: returns { session, vf, candidate, attempts } or throws with detail.
  // params.pickKey front-loads the exact user-chosen source from the Sources drawer; the old
  // release-name pick stays as a fallback for older clients. Auto-advance still walks the
  // ranked list behind that explicit choice.
  async play(params, policy = {}, mountOpts = {}) {
    const _we = wantedEpisodeOf(params);
    if (_we) mountOpts = { ...mountOpts, wantedEpisode: _we }; // so a season pack mounts the wanted episode
    this.forgetMismatchedPrepared(params, policy);
    // A smash-Play after a false-empty prepare must re-search now, not wait out the fail TTL.
    this.prepareFailUntil.delete(this._prepareJobKey(params, policy));
    if (params.imdbid || params.tvdbid) {
      this.prepareFailUntil.delete(this._prepareJobKey(params, policy, { ignoreCatalogIds: true }));
    }
    const ready = !((params.pickKey || params.pick) && !params.pinnedResume)
      && this._findTitlePreparedReady(params, policy);
    if (ready) {
      this.metrics.titlePrepareJoins++;
      console.log('[play] joined prepared ' + (ready.candidate && ready.candidate.name || ''));
      debug.log('play', `joined prepared pick=${(ready.candidate && ready.candidate.pickKey) || '-'} mount=${ready.vf && ready.vf.id || '-'}`);
      const session = new PlaySession(params, [ready.candidate]);
      session.policy = policy;
      session.cursor = 1;
      this.sessions.set(session.id, session);
      const committed = this._commitMount(session, ready.candidate, ready.vf, [], mountOpts);
      // Ranked backups can wait. First frame must not sit behind an indexer fan-out.
      this.search(params, policy, { allowStale: true }).then(({ candidates }) => {
        if (session.released) return;
        let extra = this._playableCandidates(candidates, params);
        if (!extra.some((c) => c.pickKey === ready.candidate.pickKey)) {
          extra = [ready.candidate, ...extra];
        }
        if (!extra.length) return;
        session.candidates = extra;
        const readyIdx = extra.findIndex((c) => c.pickKey === ready.candidate.pickKey);
        session.cursor = readyIdx >= 0 ? readyIdx + 1 : 1;
        this._attachStandby(session, params, policy, mountOpts);
      }).catch(() => {});
      return committed;
    }
    let { candidates } = await this.search(params, policy);
    if (!(candidates && candidates.length)) {
      const stale = await this.search(params, policy, { allowStale: true });
      if (stale.candidates && stale.candidates.length) candidates = stale.candidates;
    }
    let playable = this._playableCandidates(candidates, params);
    const explicitPick = (params.pickKey || params.pick) && !params.pinnedResume;
    if (explicitPick && !playable.length) throw new Error('picked source not found');
    // Exact 4K (or any exact rank) with no playable match: try labelled matching-res releases
    // that are only soft-penalized (probe-timeout, small short-film) before relaxing to 1080p.
    // Hard disqualifies (−100000: missing, encrypted, sample <80MB, not-the-movie) stay out.
    if (!playable.length && policy.exactResolutionRank != null && !explicitPick) {
      playable = candidates.filter((c) => {
        const rank = c.attributes && Number.isInteger(c.attributes.resolutionRank)
          ? c.attributes.resolutionRank
          : parseRelease(c.name).resolutionRank;
        return rank === policy.exactResolutionRank && c.score > -50000;
      });
    }
    // 4K toggle with no 4K source: exactResolutionRank disqualifies every non-4K release, which
    // would fail the play entirely ("I toggled 4K and nothing plays"). Fall back to the best
    // available resolution instead — keep the 4K preference so UHD still wins when it exists.
    if (!playable.length && policy.exactResolutionRank != null && !explicitPick) {
      const relaxed = { ...policy };
      delete relaxed.exactResolutionRank;
      const retry = await this.search(params, relaxed);
      playable = this._playableCandidates(retry.candidates, params);
    }
    if (!playable.length) {
      const wide = await this._widenPlayable(params, policy, playable, candidates);
      playable = wide.playable;
      if (wide.candidates && wide.candidates.length) candidates = wide.candidates;
    }
    if (!playable.length) throw new Error('no playable releases found');
    const session = new PlaySession(params, playable);
    session.policy = policy;
    this.sessions.set(session.id, session);
    // Cold start races the top candidates; a single explicit Sources pick stays a direct mount.
    // A pinned resume keeps the race: the pin leads the ranked list, but a dead pin must not turn
    // resume into a serial one-at-a-time walk (the pre-pin behavior users knew was the raced one).
    const joiningPrepare = !explicitPick && this._findTitlePrepare(params, policy);
    if (joiningPrepare) {
      this.metrics.titlePrepareJoins++;
      console.log('[play] joining prepare');
    }
    // Smash Play during Details prepare must join that job, not open a 5-wide race that
    // starves the same NNTP slots the warmup already holds. One hedge is enough to skip a
    // dead top pick; waiting on Details stays instant because the mount is already live.
    const width = explicitPick ? 1 : (joiningPrepare ? 2 : PLAY_RACE_WIDTH);
    debug.log('play', `advance width=${width} joiningPrepare=${!!joiningPrepare} explicitPick=${!!explicitPick}`);
    try {
      return await this._advance(session, mountOpts, { width });
    } catch (e) {
      // Owner rule: keep trying the preferred resolution until one works; ONLY when EVERY healthy
      // 4K source is exhausted (all rotted/removed/incomplete) fall back to the best lower-res
      // release instead of failing. The 4K toggle sets exactResolutionRank, which scores every
      // non-4K below the playable cut — so the lower-res tier was never in the first walk. Relax
      // that lock (NOT the maxResolutionRank hard cap) and walk only the releases we hadn't been
      // allowed to try yet. Re-search is a cache hit (raw results re-scored under the relaxed
      // policy), so this costs no network. Explicit Sources picks keep their own fallback chain.
      if (policy.exactResolutionRank != null && ((!params.pickKey && !params.pick) || params.pinnedResume)) {
        const relaxed = { ...policy };
        delete relaxed.exactResolutionRank;
        const retry = await this.search(params, relaxed);
        const tried = new Set(playable.map((c) => c.pickKey));
        const fallback = this._playableCandidates(retry.candidates, params).filter((c) => !tried.has(c.pickKey));
        if (fallback.length) {
          const s2 = new PlaySession(params, fallback);
          this.sessions.set(s2.id, s2);
          const r = await this._advance(s2, mountOpts, { width });
          r.relaxedResolution = policy.exactResolutionRank; // signal the UI a lower res was substituted
          return r;
        }
      }
      throw e;
    }
  }

  // Press-play for an audiobook: rank via searchAudiobook, then walk candidates with the same
  // mount/health/auto-advance machinery as video. mountOpts.audiobook skips the video stub floor.
  async playAudiobook(params = {}, mountOpts = {}) {
    const { candidates, errors } = await this.searchAudiobook(params);
    const playable = this._playableCandidates(candidates, params);
    if (!playable.length) {
      // No candidates at all vs. candidates that all scored unplayable are different problems —
      // say which, and surface any indexer errors so the owner can act (wrong key, no audiobook cat…).
      const e = new Error(candidates.length
        ? 'Found audiobook releases but none are playable right now.'
        : `“${params.title}” isn’t posted on usenet right now — try a different edition or a more widely-available title.`);
      e.notOnUsenet = !candidates.length;
      e.summary = e.message;
      if (errors && errors.length) e.attempts = errors.map((x) => ({ fail: x.error, indexer: x.indexer }));
      throw e;
    }
    const session = new PlaySession(params, playable);
    this.sessions.set(session.id, session);
    const width = (params.pickKey || params.pick) ? 1 : PLAY_RACE_WIDTH;
    return await this._advance(session, { ...mountOpts, audiobook: true }, { width });
  }

  _playableCandidates(candidates, params = {}) {
    const autoPlayable = candidates.filter((c) => c.score > -5000);
    if (!params.pickKey && !params.pick) return autoPlayable;
    const picked = candidates.find((c) => params.pickKey && c.pickKey === params.pickKey)
      || candidates.find((c) => params.pick && c.name === params.pick);
    if (!picked) return [];
    // A pinned resume is the source we HAPPENED to be playing, not a choice the user is owed.
    // Front it only while the scorer still calls it playable — a pin that rotted since the last
    // session is skipped outright, and the ranked list plays without the manual-pick size-window
    // detour (that heuristic models a deliberate human override, which this is not).
    if (params.pinnedResume) {
      if (!autoPlayable.some((c) => c.pickKey === picked.pickKey)) return autoPlayable;
      return [picked, ...autoPlayable.filter((c) => c.pickKey !== picked.pickKey)];
    }
    // A manual Sources pick is the file they tapped. Do not substitute a smaller WEB-DL when
    // the 41GB remux they chose is slow, over-cap, or missing from the re-search — fail instead
    // so the drawer choice is honest.
    return [picked];
  }

  // 1080 toggle: Play searches without the extra 2160p fan-out, so a title we JUST had in 4K
  // can come back empty (first page is all over-cap 4K, or the 1080 cache miss is a 0-hit).
  // Reuse the UHD search hit and re-score under the 1080 cap. If this title is 4K-only,
  // start the 4K rather than toast "no playable".
  async _widenPlayable(params, policy, playable, candidates) {
    const explicitPick = (params.pickKey || params.pick) && !params.pinnedResume;
    const cap = policy.maxResolutionRank;
    if (playable.length || explicitPick || !Number.isInteger(cap) || cap >= 4) {
      return { playable, candidates, widened: false };
    }
    const uhdPolicy = { ...policy, preferResolutionRank: 4 };
    delete uhdPolicy.exactResolutionRank;
    const uhd = await this.search(params, uhdPolicy);
    let next = this._playableCandidates(uhd.candidates, params);
    if (next.length) {
      console.log('[play] 1080 empty, reused 4K search');
      return { playable: next, candidates: uhd.candidates, widened: true };
    }
    const relaxed = { ...uhdPolicy };
    delete relaxed.maxResolutionRank;
    const fallback = await this.search(params, relaxed);
    next = this._playableCandidates(fallback.candidates, params);
    if (next.length) {
      console.log('[play] 1080 empty, fell back to best available');
      return { playable: next, candidates: fallback.candidates, widened: true };
    }
    return { playable, candidates, widened: false };
  }

  async prepare(params, policy = {}, mountOpts = {}) {
    const _we = wantedEpisodeOf(params);
    if (_we) mountOpts = { ...mountOpts, wantedEpisode: _we }; // prewarm the SAME episode file play() will mount
    this.forgetMismatchedPrepared(params, policy);
    const key = this._prepareJobKey(params, policy);
    let existing = this.titlePrepareInflight.get(key);
    if (!existing && (params.imdbid || params.tvdbid)) {
      existing = this.titlePrepareInflight.get(this._prepareJobKey(params, policy, { ignoreCatalogIds: true }));
    }
    if (existing) {
      this.metrics.titlePrepareJoins++;
      return existing.promise;
    }
    const failUntil = this.prepareFailUntil.get(key);
    if (failUntil && Date.now() < failUntil) {
      const e = new Error('no playable releases found');
      e.cachedFail = true;
      throw e;
    }
    const rec = { promise: null };
    rec.promise = this._runPrepare(params, policy, mountOpts).then((r) => {
      this.prepareFailUntil.delete(key);
      return r;
    }, (e) => {
      if (e && /no playable/.test(String(e.message || ''))) {
        this.prepareFailUntil.set(key, Date.now() + PREPARE_FAIL_RETRY_MS);
        if (this.prepareFailUntil.size > 80) {
          const oldest = this.prepareFailUntil.keys().next().value;
          this.prepareFailUntil.delete(oldest);
        }
      }
      throw e;
    }).finally(() => {
      if (this.titlePrepareInflight.get(key) === rec) this.titlePrepareInflight.delete(key);
    });
    this.titlePrepareInflight.set(key, rec);
    return rec.promise;
  }

  async _runPrepare(params, policy = {}, mountOpts = {}) {
    let { candidates } = await this.search(params, policy);
    let playable = this._playableCandidates(candidates, params);
    if (!playable.length) {
      const wide = await this._widenPlayable(params, policy, playable, candidates);
      playable = wide.playable;
      if (wide.candidates && wide.candidates.length) candidates = wide.candidates;
    }
    if (!playable.length) throw new Error('no playable releases found');
    const attempts = [];
    const started = Date.now();
    const tryList = async (list) => {
      for (const candidate of list.slice(0, PREPARE_MAX_ATTEMPTS)) {
        if (Date.now() - started >= PREPARE_MAX_MS) break;
        const res = await this._tryCandidate(candidate, { ...mountOpts, startupPriority: 'prepare' });
        if (res.vf && !res.fail) {
          res.vf._touched = Date.now();
          if (!mountHasActivePlayback(res.vf)) {
            res.vf._preparedOnly = true;
          }
          if (candidate.name) res.vf._releaseName = candidate.name;
          this.mounts.set(res.vf.id, res.vf);
          this.mountByUrl.set(res.vf._mountIdentity || mountIdentity(candidate, mountOpts), res.vf.id);
          this._rememberTitlePrepared(params, this._rememberPolicyForCandidate(policy, candidate), res.vf, candidate);
          this.rebalancePlaybackWindows();
          this._startPlaybackWarmup(res.vf, res.vf._playWin, params.resumeFrac, {
            hot: this._prepareWarmIsHot(res.vf),
          });
          // Next-episode prepare runs while the current file is still playing. A second
          // standby mount here steals NNTP slots from that last scene and can remount it.
          if (!this._hasActiveForeignPlayback(res.vf)) {
            this._armStandby(params, policy, mountOpts, list, candidate.pickKey, params.resumeFrac, candidate);
          }
          return { vf: res.vf, candidate };
        }
        attempts.push({ name: candidate.name, fail: res.fail || 'prepare failed' });
      }
      return null;
    };
    let done = await tryList(playable);
    // Mirror play()'s relax-on-exhaustion: when every preferred-res (4K) source is dead, pre-warm
    // the fallback resolution too — so a focus pre-warm keeps resume instant even on UHD source rot,
    // not just when 4K is healthy. Cache-hit re-search re-scores the lower-res tier into playability.
    if (!done && policy.exactResolutionRank != null && ((!params.pickKey && !params.pick) || params.pinnedResume) && Date.now() - started < PREPARE_MAX_MS) {
      const relaxed = { ...policy };
      delete relaxed.exactResolutionRank;
      const retry = await this.search(params, relaxed);
      const tried = new Set(playable.map((c) => c.pickKey));
      const fallback = this._playableCandidates(retry.candidates, params).filter((c) => !tried.has(c.pickKey));
      if (fallback.length) done = await tryList(fallback);
    }
    if (done) return { ...done, attempts, prepared: true };
    return { candidate: playable[0], attempts, prepared: false };
  }

  // Commit a winning mount to the session and warm its read-ahead. Shared by both walk modes.
  _commitMount(session, candidate, vf, attempts, mountOpts = {}) {
    vf._touched = Date.now();
    vf._preparedOnly = false;
    vf._playbackTouched = Date.now();
    if (candidate.name) vf._releaseName = candidate.name;
    this.mounts.set(vf.id, vf);
    this.mountByUrl.set(vf._mountIdentity || mountIdentity(candidate, mountOpts), vf.id);
    session.currentMountId = vf.id;
    this._quietOtherPreparedWarms(vf);
    this.rebalancePlaybackWindows();
    this._rememberTitlePrepared(session.query || {}, this._rememberPolicyForCandidate(session.policy || {}, candidate), vf, candidate);
    this._startPlaybackWarmup(vf, vf._playWin, session.query && session.query.resumeFrac, { hot: true });
    session.history.push({ name: candidate.name, outcome: 'playing' });
    session.activeCandidate = candidate; // recovery-advance demotes exactly this source
    session.policy = session.policy || {};
    this._attachStandby(session, session.query || {}, session.policy, mountOpts);
    return { session, vf, candidate, attempts };
  }

  // Mount the next viable candidate in the session. width > 1 races the top N candidates'
  // fetch+mount+health concurrently and commits the first HEALTHY one (cold-start and bounded
  // recovery hedge); width 1 is the original one-at-a-time walk used by explicit Sources picks.
  async _advance(session, mountOpts = {}, { width = 1 } = {}) {
    this._inflightAdvances++;
    try {
      if (width > 1) {
        if (this._inflightAdvances >= 3) width = 1;
        else if (this._inflightAdvances === 2) width = Math.min(width, 2);
      }
      return await this._advanceBody(session, mountOpts, { width });
    } finally {
      this._inflightAdvances = Math.max(0, this._inflightAdvances - 1);
    }
  }

  async _advanceBody(session, mountOpts = {}, { width = 1 } = {}) {
    const attempts = [];
    const started = Date.now();
    const budgetLeft = () => Date.now() - started < MAX_ADVANCE_MS;
    if (width <= 1) {
      while (session.cursor < session.candidates.length && attempts.length < MAX_ATTEMPTS && budgetLeft()) {
        const candidate = session.candidates[session.cursor++];
        const res = await this._tryCandidate(candidate, mountOpts);
        if (res.vf && !res.fail) return this._commitMount(session, candidate, res.vf, attempts, mountOpts);
        session.history.push({ name: candidate.name, outcome: res.fail });
        attempts.push({ name: candidate.name, fail: res.fail });
      }
    } else {
      // Hedged parallel walk: rank order is preferred, but it is not allowed to hold a ready player
      // behind a stuck source's full mount deadline. A failed front-runner pulls the next candidate
      // in at once; a stalling front-runner gets one understudy after RACE_HEDGE_MS. Once a lower
      // rank is healthy, earlier ranks get RACE_COMMIT_GRACE_MS to settle before the ready source
      // commits. Losers stay unregistered and start no read-ahead (see _tryCandidateFresh), so they
      // fall out of the pool cheaply.
      const results = [];          // launch order k -> { candidate, state:'pending'|'ok'|'fail', vf?, fail? }
      const inflight = new Map();  // k -> promise(resolving to k)
      let committed = 0;           // next rank index still to decide
      const launchOne = (kind = 'hedge') => {
        if (session.cursor >= session.candidates.length || results.length >= MAX_ATTEMPTS) return false;
        const candidate = session.candidates[session.cursor++];
        const k = results.length;
        const controller = new AbortController();
        const parentSignal = mountOpts && mountOpts.signal;
        const onParentAbort = () => controller.abort();
        if (parentSignal) {
          if (parentSignal.aborted) controller.abort();
          else parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }
        const rec = {
          candidate, state: 'pending', controller,
          cleanupParent: () => parentSignal && parentSignal.removeEventListener('abort', onParentAbort),
        };
        results.push(rec);
        inflight.set(k, this._tryCandidate(candidate, {
          ...mountOpts, signal: controller.signal, startupPriority: kind,
        }).then(
          (res) => {
            Object.assign(rec, (res.vf && !res.fail)
              ? { state: 'ok', vf: res.vf }
              : { state: 'fail', fail: res.fail });
            rec.cleanupParent();
            return k;
          },
          (e) => {
            Object.assign(rec, { state: 'fail', fail: `error: ${e.message}` });
            rec.cleanupParent();
            return k;
          },
        ));
        return true;
      };
      const cancelLosers = (winnerIndex = -1) => {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          r.cleanupParent();
          if (i !== winnerIndex && r.controller && !r.controller.signal.aborted) r.controller.abort();
        }
      };
      const commitAt = (index) => {
        const r = results[index];
        // Abort every still-pending source BEFORE registering/warming the winner. This releases its
        // startup-priority NNTP consumer immediately instead of letting a stalled hedge retain pool
        // capacity until MOUNT_DEADLINE_MS.
        cancelLosers(index);
        return this._commitMount(session, r.candidate, r.vf, attempts, mountOpts);
      };
      const fill = () => { while (inflight.size < width && launchOne()) { /* keep window full */ } };
      let walking = false; // flips true on the first dead pick — past that we KNOW we're walking
      let initialHedgeLaunched = false;
      let blockedHealthyIndex = -1;
      let blockedHealthyAt = 0;
      const firstHealthyFrom = (from) => {
        for (let i = from; i < results.length; i++) if (results[i].state === 'ok') return i;
        return -1;
      };
      const raceWithTimer = async (racers, label, delayMs) => {
        let timer = null;
        if (Number.isFinite(delayMs) && delayMs >= 0) {
          racers = [...racers, new Promise((resolve) => {
            timer = setTimeout(() => resolve(label), delayMs);
            if (timer.unref) timer.unref();
          })];
        }
        try { return await Promise.race(racers); }
        finally { if (timer) clearTimeout(timer); }
      };
      launchOne('play');
      while (budgetLeft()) {
        // Commit the longest decided prefix, in rank order.
        while (committed < results.length && results[committed].state !== 'pending') {
          const r = results[committed];
          if (r.state === 'ok') return commitAt(committed);
          session.history.push({ name: r.candidate.name, outcome: r.fail });
          attempts.push({ name: r.candidate.name, fail: r.fail });
          committed++;
          // A dead pick proves this is a real walk (common for 4K: top UHD BluRay remuxes are
          // unstreamable) — race the whole window now instead of ramping one understudy at a time.
          walking = true;
          if (firstHealthyFrom(committed) < 0) fill();
        }
        if (!inflight.size) break; // nothing decided-OK and nothing left running → all failed

        // A lower-ranked candidate may already be healthy while an earlier rank is stuck in a
        // 30-second mount deadline. Give the earlier ranks one short final grace, then commit the
        // ready source. While it is ready, launch NO more candidates — extra grabs cannot improve
        // first-frame latency and only consume provider/indexer capacity.
        const healthyIndex = firstHealthyFrom(committed);
        if (healthyIndex > committed && results[committed].state === 'pending') {
          if (blockedHealthyIndex !== healthyIndex) {
            blockedHealthyIndex = healthyIndex;
            blockedHealthyAt = Date.now();
          }
          const remaining = Math.max(0, RACE_COMMIT_GRACE_MS - (Date.now() - blockedHealthyAt));
          const earlier = [...inflight.entries()]
            .filter(([k]) => k < healthyIndex)
            .map(([, promise]) => promise);
          if (!earlier.length || remaining <= 0) {
            for (let i = committed; i < healthyIndex; i++) {
              if (results[i].state === 'pending') {
                session.history.push({ name: results[i].candidate.name, outcome: 'skipped: faster healthy hedge' });
              }
            }
            return commitAt(healthyIndex);
          }
          const settled = await raceWithTimer(earlier, 'rank-grace', remaining);
          if (settled === 'rank-grace') {
            for (let i = committed; i < healthyIndex; i++) {
              if (results[i].state === 'pending') {
                session.history.push({ name: results[i].candidate.name, outcome: 'skipped: faster healthy hedge' });
              }
            }
            return commitAt(healthyIndex);
          }
          inflight.delete(settled);
          continue;
        }
        blockedHealthyIndex = -1;
        blockedHealthyAt = 0;

        // Before the first failure (happy path) only a STALLING top pick gets one hedged understudy,
        // so a healthy/cached top pick costs zero extra grabs. Once walking, the window is kept full.
        const canHedge = !walking && !initialHedgeLaunched && inflight.size < width
          && session.cursor < session.candidates.length && results.length < MAX_ATTEMPTS;
        const racers = [...inflight.values()];
        const w = await raceWithTimer(racers, 'hedge', canHedge ? RACE_HEDGE_MS : NaN);
        if (w === 'hedge') {
          initialHedgeLaunched = true;
          launchOne();
          continue;
        } // front-runner is stalling — widen the race once
        inflight.delete(w);
      }
      cancelLosers();
    }
    const err = new Error('all candidates failed');
    err.attempts = attempts;
    err.summary = summarizeAttempts(attempts);
    throw err;
  }

  // Auto-advance API: the player reports the current source died → next source, same query.
  async advance(sessionId, mountOpts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('unknown play session');
    // Warm the replacement mount at the LIVE timestamp the player reports, not the original
    // press-play resume point: a source dying at minute 70 used to warm the file HEAD while the
    // player seeked deep — re-introducing the exact cold-resume stall the resume warm was built
    // to kill. resumeFrac rides session.query, which _commitMount already feeds the warmup.
    const { resumeFrac, ...rest } = mountOpts;
    const frac = Number(resumeFrac);
    if (Number.isFinite(frac) && frac > 0 && frac < 1) {
      session.query = { ...(session.query || {}), resumeFrac: frac };
    }
    // Thread the wanted episode back in so an auto-advance of a season PACK still mounts the REQUESTED
    // episode (session.query carries season/ep). Without this, advance() dropped it and a pack advanced
    // to the largest file (E01). Movies/single-ep are unaffected — their largest video IS the content.
    const _we = wantedEpisodeOf(session.query);
    // The player has declared the ACTIVE source dead (stall/rot mid-playback). Remember that in the
    // persistent verdict cache so the next press-play/resume ranks it DOWN instead of serving the
    // same rotten release again — recovery used to fix only the live session, and a later resume
    // walked straight back into the source it had just abandoned. TTL'd (VerdictCache) because a
    // stall can also be the viewer's line, not the post. Episode-scoped sessions skip this: a
    // release-wide verdict from one episode's stall must not blacklist a season pack's healthy
    // siblings (the existing post-mount judgment contract).
    if (session.activeCandidate) {
      this._recordPlaybackFailed(session.activeCandidate, { episodeScoped: !!_we });
      this._clearTitleStandby(session.query || {}, session.policy || {}, session.activeCandidate.pickKey);
      session.activeCandidate = null;
    }
    const nextOpts = _we ? { ...rest, wantedEpisode: _we } : rest;
    const standby = session.standby && session.standby.vf && this.mounts.get(session.standby.vf.id);
    if (standby && standby.streamable && session.standby.candidate) {
      const committed = this._commitMount(session, session.standby.candidate, standby, [], nextOpts);
      session.standby = null;
      return committed;
    }
    return this._advance(session, nextOpts, { width: RECOVERY_RACE_WIDTH });
  }
}

module.exports = {
  Pipeline, GATE_MS, STARTUP_SLOTS, PLAY_RACE_WIDTH, StartupGate,
  parseWantedTitle, releaseMatches, catalogIdentityMatches, releaseQualifies, shortTitleQuery,
  aliasSearchQueries, yearlessSearchQuery,
  candidateKey, nzbVerdictKey,
  releaseFingerprint, applyNzbFingerprintFields,
  summarizeAttempts, stubFeatureReason, parseWantedBook, bookMatches,
  isNonAudioAudiobookMount, firstProbeMsgId, mountHasActivePlayback, mountNeedsUsenetShare, ACTIVE_PLAYBACK_GRACE_MS,
  allocateStreamConnections, classifyStreamNeed, streamNeedMbps, streamIsUhd, mountAheadBytes, fileIsFullyAhead,
  householdConnPressure, preparedHouseHasRoom, preparedPeekSockets, autoStreamCap, cacheNeedWeight,
  playbackRamFraction, playbackCacheCapMb,
  AUTO_BASE_CONNS,
};

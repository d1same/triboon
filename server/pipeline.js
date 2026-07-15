'use strict';
// The press-play pipeline: fan-out search → TRaSH-style ranking within the user's cap →
// fetch NZB → mount → bounded health gate (≤500ms soft) → stream URL + ranked alternates.
// Verdicts from every attempt feed the two-tier cache so the next press of Play is smarter.
// Auto-advance: the player calls /api/advance with the session id; we mount the next
// candidate and the client resumes at its last timestamp.

const os = require('os');
// System RAM is fixed for the process lifetime — read it ONCE at load, not per Range request. The
// read-ahead window sizing below (_playbackWindowFor) runs on the hot streaming path, and
// os.totalmem() was being re-read on every rebalance. ~20% is the cross-stream buffer budget.
const TOTAL_MEM_MB = Math.floor(os.totalmem() / (1024 * 1024));
const { fanout, fetchUrl, normTitle } = require('./newznab');

// ---- title verification ----
// Split a search query into title words + structured parts (year, SxxEyy).
function parseWantedTitle(q) {
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
  // A query that is ONLY a year (a bare-year title with no separate release year) must still ANCHOR on
  // that number rather than degrade to "any film ±1 year" — keep it as a title word, drop the year filter.
  if (!out.words.length && out.year !== null && out.s === null) { out.words.push(String(out.year)); out.year = null; }
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
  'us', 'uk', 'au', 'nz', 'multi', 'dual', 'dubbed', 'ita', 'eng', 'french', 'german',
  'spanish', 'nordic', 'vostfr',
].join('|') + ')$');
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
function releaseMatches(name, wanted) {
  const norm = ' ' + String(name || '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ') + ' ';
  const toks = norm.trim().split(' ');
  let ti = 0;
  for (let wi = 0; wi < wanted.words.length; wi++) {
    const w = wanted.words[wi];
    const t = toks[ti];
    if (t === undefined) {
      if (OPTIONAL_TITLE_ARTICLES.has(w)) continue;
      return false;
    }
    if (titleWordMatches(w, t)) { ti++; continue; }
    const nextWanted = wanted.words[wi + 1];
    if (OPTIONAL_TITLE_ARTICLES.has(w) && nextWanted && titleWordMatches(nextWanted, t)) continue;
    return false;
  }
  if (wanted.words.length) {
    const after = toks[ti];
    if (after !== undefined && !STRUCTURAL_AFTER_TITLE.test(after)) return false;
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
    if (years.length && !years.some((y) => Math.abs(y - wanted.year) <= 1)) return false;
  }
  return true;
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
  const cats = { connection: 0, missing: 0, encrypted: 0, stub: 0, unsupported: 0, timeout: 0, blocked: 0, other: 0 };
  for (const a of attempts) {
    const f = String((a && a.fail) || '').toLowerCase();
    // Connection FIRST — an unreachable provider must never be mislabeled as a removed article.
    if (/unreachable|econnrefused|econnreset|etimedout|ehostunreach|enotfound|getaddrinfo|socket hang|\bauthinfo\b|too many connection|\b502\b|fetch-failed/.test(f)) cats.connection++;
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
function stubFeatureReason(sizeBytes, name) {
  const gb = (Number(sizeBytes) || 0) / 1e9;
  if (gb <= 0) return ''; // unknown size — don't guess
  const rank = parseRelease(name || '').resolutionRank; // 2160p=4, 1080p=3, unknown=2
  if (gb < 0.08 || (gb < 0.3 && rank >= 3)) {
    const forRes = rank >= 4 ? ' for a 2160p release' : rank >= 3 ? ' for a 1080p release' : '';
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
const ACTIVE_PLAYBACK_GRACE_MS = 120000;
const PREPARED_CACHE_BYTES_1080 = 96 * 1024 * 1024;
const PREPARED_CACHE_BYTES_4K = 192 * 1024 * 1024;
const PREPARED_READ_AHEAD = 4;
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
// Cold press-play races the top N candidates' fetch+mount+health concurrently and takes the first
// HEALTHY one (startup win #2). Measured: a cold start is dominated by walking PAST dead/incomplete
// top picks one-at-a-time — racing collapses that serial tail to the fastest healthy of the top N.
// Kept small so startup never floods the provider pool (the startup reserve covers a few parallel
// mounts). Auto-advance stays serial (width 1) — the active source already died, no tail to race.
const PLAY_RACE_WIDTH = 5;
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
  const file = firstVolume || pickPrimaryFile(nzb, mountOpts);
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
    this.sessions = new Map();    // id -> PlaySession
    this.searchCache = new Map(); // queryKey -> { at, results, errors } (prefetch-on-browse → instant play)
    this.searchInflight = new Map(); // queryKey -> Promise(hit), so Play can join an active prefetch
    this.nzbCache = new Map();    // nzbUrl -> xml (small LRU; replays remount instantly)
    this.nzbInflight = new Map(); // nzbUrl -> Promise(xml), so Play joins detail-page prefetch
    this.prepareInflight = new Map(); // mountIdentity -> shared cancellable mount record
    this.mountByUrl = new Map();  // mountIdentity -> mount id (same selected payload reuses instantly)
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
    const t0 = Date.now();
    try {
      return await fanout(ixs, params, opts);
    } finally {
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
    ]);
  }

  _getFreshSearchHit(key) {
    const hit = this.searchCache.get(key);
    if (!(hit && Date.now() - hit.at <= 60000)) return null;
    // LRU touch: re-insert so the eviction (delete oldest key) drops the genuinely least-recently-USED
    // entry, not the oldest-inserted. A hot replayed title survives a burst of unrelated browses.
    this.searchCache.delete(key); this.searchCache.set(key, hit);
    return hit;
  }

  _rememberSearchHit(key, hit) {
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

  _playbackWindowFor(vf, activeMounts, perf = this.performance() || {}) {
    const big = (vf.size || 0) > 4e9;
    const activeCount = Math.max(1, activeMounts || 1);
    const usable = perf.usableConnections || 0;
    const reserve = perf.reserveConnections || 0;
    const perStreamBudget = usable > reserve ? Math.max(4, Math.floor((usable - reserve) / activeCount)) : Infinity;
    const configuredWindow = big ? (perf.maxConnPerStream4k || 20) : (perf.maxConnPerStream1080 || 12);
    const readAhead = Math.max(4, Math.min(configuredWindow, perStreamBudget));
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
      // 4K cap raised 384 → 1024 so a ~80 Mbps stream can actually hold ~100s. Bounded by ~20% of
      // system RAM (this totalMb is the TOTAL across active streams via the /activeCount split below),
      // so smaller self-hosted boxes stay safe — they just get a proportionally shallower buffer.
      const ramCapMb = Math.floor(TOTAL_MEM_MB * 0.2);
      const minMb = big ? 96 : 48;
      const maxMb = Math.max(minMb, Math.min(big ? 1024 : 384, ramCapMb));
      const totalMb = Math.max(minMb, Math.min(maxMb, targetMb));
      const perActiveMb = Math.max(big ? 64 : 32, Math.floor(totalMb / activeCount));
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

  _applyPlaybackWindow(vf, activeMounts, perf = this.performance() || {}) {
    if (!vf) return null;
    const previousCacheMaxBytes = Math.max(1, Number(vf._playWin && vf._playWin.cacheMaxBytes) || Infinity);
    const win = this._playbackWindowFor(vf, activeMounts, perf);
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

  _applyPreparedWindow(vf, win = {}, aggregateShare = Infinity) {
    if (!vf) return null;
    const activeWin = vf._activePlayWin || win;
    const cap = (Number(vf.size) || 0) > 4e9 ? PREPARED_CACHE_BYTES_4K : PREPARED_CACHE_BYTES_1080;
    const previousCacheMaxBytes = Math.max(1, Number(vf._playWin && vf._playWin.cacheMaxBytes) || Infinity);
    const prepared = {
      ...activeWin,
      readAhead: Math.min(PREPARED_READ_AHEAD, Math.max(0, Number(activeWin.readAhead) || 0)),
      maxReadAhead: Math.min(PREPARED_READ_AHEAD, Math.max(0, Number(activeWin.maxReadAhead) || 0)),
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

  _startPlaybackWarmup(vf, win, resumeFrac = 0) {
    if (!vf || !vf.streamable || typeof vf.read !== 'function') return;
    const size = Number(vf.size) || 0;
    if (size <= 0) return;
    const big = size > 4e9;
    const capBytes = Number(win && win.cacheMaxBytes) || 0;
    const warmBytes = Math.min(size, capBytes || Infinity, (big ? 96 : 32) * 1024 * 1024);
    if (!Number.isFinite(warmBytes) || warmBytes <= 0) return;
    const warm = (key, from, to) => {
      if (!(to > from)) return;
      this._cancelPlaybackWarmup(vf, key);
      if (!(vf._playbackWarmupJobs instanceof Map)) vf._playbackWarmupJobs = new Map();
      const controller = new AbortController();
      const job = { controller, timer: null, promise: null };
      job.timer = setTimeout(() => {
        job.timer = null;
        job.promise = (async () => {
          for await (const _chunk of vf.read(from, to, { priority: 'readAhead', signal: controller.signal })) {
            // Drain intentionally: this warms the VFS cache without blocking Play. MUST stay on the
            // read-ahead lane — a new stream's speculative warm must never outrank another user's
            // active playback (docs-streaming-performance.md). The player reads the head itself at
            // startup priority, so warming it higher would only steal connections, not help.
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
        warm('resume', start, end);
      }
    }
    if (vf._playbackWarmupStarted) return; // head/tail already warmed for this mount
    vf._playbackWarmupStarted = true;
    // HEAD: a fresh start plays from the head (full warm); a resume only needs the container header
    // parsed (its body is the resume window above), so warm just a small head there to keep the cache
    // budget close to the non-resume head+tail.
    warm('head', 0, resuming ? Math.min(warmBytes, (big ? 16 : 8) * 1024 * 1024) : warmBytes);
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
    if (tailBytes > 0 && size - tailBytes > warmBytes) warm('tail', size - tailBytes, size);
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
      .filter((m) => mountHasActivePlayback(m, now));
    const activeCount = Math.max(1, active.length);
    for (const vf of active) this._applyPlaybackWindow(vf, activeCount, perf);
    this.rebalancePreparedWindows(now);
    this.metrics.windowRebalances++;
    return active.length;
  }

  async _fetchSearchHit(ixs, params, wanted, timeoutMs) {
    ixs.forEach((ix) => this.usage.onSearch(ix.name)); // a real fan-out costs one API hit per indexer
    let { results, errors } = await this._fanoutMeasured(ixs, params, { timeoutMs });
    // TITLE VERIFICATION — indexers return loosely-related releases; a release only
    // qualifies if its name actually contains the wanted title (and episode/year).
    // Without this, "wrong movie plays" — the #1 trust-killer.
    results = results.filter((r) => releaseMatches(r.name, wanted));
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
        const verified = retry.results.filter((r) => releaseMatches(r.name, wanted));
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
      const verified = retry.results.filter((r) => releaseMatches(r.name, wanted));
      if (verified.length) { results = verified; errors = retry.errors; }
    }
    return { at: Date.now(), results, errors };
  }

  // Search + rank only (powers the Sources drawer). Applies cached verdict adjustments.
  async search(params, policy = {}, { timeoutMs = 2000 } = {}) {
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
    // TV episode context for scoring: a whole-season PACK must not be size-cap-disqualified — only ONE
    // episode streams from it (it's still size-SHAPED, so it stays a low-ranked fallback below singles).
    // Scoped to episode requests; movies/season-less searches never get wantedEpisode → unaffected.
    { const _we = wantedEpisodeOf(params); if (_we) policy = { ...policy, wantedEpisode: _we }; }
    const key = this._searchCacheKey(params);
    const titleKey = this._searchCacheKey(params, { ignoreCatalogIds: true });
    let hit = this._getFreshSearchHit(key);
    if (!hit && (params.imdbid || params.tvdbid)) {
      hit = this._getFreshSearchHit(titleKey);
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
        pending = this._fetchSearchHit(ixs, params, wanted, timeoutMs)
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
    const { results, errors } = hit;
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
      const v = this.verdicts.get(nzbVerdictKey(r.nzbUrl)) || this.verdicts.get('t:' + normTitle(r.name));
      return {
        ...r,
        streamClass: v?.detail?.streamClass,
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
      const v = this.verdicts.get(nzbVerdictKey(r.nzbUrl)) || this.verdicts.get('t:' + normTitle(r.name));
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
    this.verdicts.set('t:' + normTitle(candidate.name), verdict, detail);
  }

  // Try one candidate: fetch NZB → mount → gate. Returns { vf } or { fail: reason }.
  async _tryCandidate(candidate, mountOpts = {}) {
    const identity = mountIdentity(candidate, mountOpts);
    const consumerSignal = mountOpts && mountOpts.signal;
    if (consumerSignal && consumerSignal.aborted) return { fail: 'cancelled: source race loser' };
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
      mountNzb(this.pool(), xml, { ...mountOpts, signal: mountController.signal }),
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
        : vf.tags.includes('encrypted') ? 'encrypted' : 'unsupported';
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
    const stub = this.enforceFeatureSize && !mountOpts.audiobook && stubFeatureReason(Number(vf.size) || 0, vf.name || candidate.name || '');
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
    const activeMounts = [...this.mounts.values()].filter((m) => mountHasActivePlayback(m, now)).length + 1;
    const win = this._applyPlaybackWindow(vf, activeMounts, perf);

    // Bounded gate: verdict within 500ms or we play anyway and keep checking in background.
    // (Provider quirk, see bench/RESULTS.md: healthy STATs answer in ~60-250ms; only MISSES
    // are slow — so "no answer by 500ms" usually means trouble, but we never block on it.)
    const gateT0 = Date.now();
    const triage = vf.triage(perf.healthProbeLimit || 6).catch(() => null);
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
      triage.then((h) => { if (h && h.verdict) recordSelectionVerdict(h.verdict, { streamClass }); }).catch(() => {});
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
    const { candidates } = await this.search(params, policy);
    let playable = this._playableCandidates(candidates, params);
    // 4K toggle with no 4K source: exactResolutionRank disqualifies every non-4K release, which
    // would fail the play entirely ("I toggled 4K and nothing plays"). Fall back to the best
    // available resolution instead — keep the 4K preference so UHD still wins when it exists.
    if (!playable.length && policy.exactResolutionRank != null) {
      const relaxed = { ...policy };
      delete relaxed.exactResolutionRank;
      const retry = await this.search(params, relaxed);
      playable = this._playableCandidates(retry.candidates, params);
    }
    if (!playable.length) throw new Error('no playable releases found');
    const session = new PlaySession(params, playable);
    this.sessions.set(session.id, session);
    // Cold start races the top candidates; a single explicit Sources pick stays a direct mount.
    const width = (params.pickKey || params.pick) ? 1 : PLAY_RACE_WIDTH;
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
      if (policy.exactResolutionRank != null && !params.pickKey && !params.pick) {
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
    if (!picked) return autoPlayable;
    // A manual Sources pick is an explicit OVERRIDE — honored FIRST even when the auto-scorer would
    // reject it (the drawer deliberately lists releases past the auto-pick size cap; without this a
    // picked 38GB UHD remux was silently dropped). The system can't know WHY it was picked, so the
    // fallback never walks blindly by size: if the pick can't stream, try just the SINGLE next-
    // smaller release (a close alternative to what they chose), then fall back to the best auto-
    // ranked streamable release.
    const pickedSize = Number(picked.sizeBytes) || 0;
    const oneBelow = candidates
      .filter((c) => c.pickKey !== picked.pickKey && (Number(c.sizeBytes) || 0) > 0 && (Number(c.sizeBytes) || 0) < pickedSize)
      .sort((a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0))[0];
    const seen = new Set([picked.pickKey, oneBelow && oneBelow.pickKey].filter(Boolean));
    return [picked, ...(oneBelow ? [oneBelow] : []), ...autoPlayable.filter((c) => !seen.has(c.pickKey))];
  }

  async prepare(params, policy = {}, mountOpts = {}) {
    const _we = wantedEpisodeOf(params);
    if (_we) mountOpts = { ...mountOpts, wantedEpisode: _we }; // prewarm the SAME episode file play() will mount
    const { candidates } = await this.search(params, policy);
    const playable = this._playableCandidates(candidates, params);
    if (!playable.length) throw new Error('no playable releases found');
    const attempts = [];
    const started = Date.now();
    const tryList = async (list) => {
      for (const candidate of list.slice(0, PREPARE_MAX_ATTEMPTS)) {
        if (Date.now() - started >= PREPARE_MAX_MS) break;
        const res = await this._tryCandidate(candidate, mountOpts);
        if (res.vf && !res.fail) {
          res.vf._touched = Date.now();
          if (!mountHasActivePlayback(res.vf)) {
            res.vf._preparedOnly = true;
          }
          if (candidate.name) res.vf._releaseName = candidate.name;
          this.mounts.set(res.vf.id, res.vf);
          this.mountByUrl.set(res.vf._mountIdentity || mountIdentity(candidate, mountOpts), res.vf.id);
          this.rebalancePlaybackWindows();
          this._startPlaybackWarmup(res.vf, res.vf._playWin, params.resumeFrac);
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
    if (!done && policy.exactResolutionRank != null && !params.pickKey && !params.pick && Date.now() - started < PREPARE_MAX_MS) {
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
    if (candidate.name) vf._releaseName = candidate.name;
    this.mounts.set(vf.id, vf);
    this.mountByUrl.set(vf._mountIdentity || mountIdentity(candidate, mountOpts), vf.id);
    session.currentMountId = vf.id;
    this.rebalancePlaybackWindows();
    this._startPlaybackWarmup(vf, vf._playWin, session.query && session.query.resumeFrac);
    session.history.push({ name: candidate.name, outcome: 'playing' });
    return { session, vf, candidate, attempts };
  }

  // Mount the next viable candidate in the session. width > 1 races the top N candidates'
  // fetch+mount+health concurrently and commits the first HEALTHY one (cold-start win); width 1
  // is the original one-at-a-time walk (auto-advance, and explicit Sources picks).
  async _advance(session, mountOpts = {}, { width = 1 } = {}) {
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
      const launchOne = () => {
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
        inflight.set(k, this._tryCandidate(candidate, { ...mountOpts, signal: controller.signal }).then(
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
      launchOne();
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
    return this._advance(session, _we ? { ...rest, wantedEpisode: _we } : rest);
  }
}

module.exports = {
  Pipeline, GATE_MS, parseWantedTitle, releaseMatches, candidateKey, nzbVerdictKey,
  summarizeAttempts, stubFeatureReason, parseWantedBook, bookMatches,
  isNonAudioAudiobookMount, firstProbeMsgId, mountHasActivePlayback, ACTIVE_PLAYBACK_GRACE_MS,
};

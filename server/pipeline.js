'use strict';
// The press-play pipeline: fan-out search → TRaSH-style ranking within the user's cap →
// fetch NZB → mount → bounded health gate (≤500ms soft) → stream URL + ranked alternates.
// Verdicts from every attempt feed the two-tier cache so the next press of Play is smarter.
// Auto-advance: the player calls /api/advance with the session id; we mount the next
// candidate and the client resumes at its last timestamp.

const os = require('os');
const { fanout, fetchUrl, normTitle } = require('./newznab');

// ---- title verification ----
// Split a search query into title words + structured parts (year, SxxEyy).
function parseWantedTitle(q) {
  const out = { words: [], year: null, s: null, e: null };
  for (const t of String(q || '').toLowerCase().split(/\s+/)) {
    let m = /^s(\d{1,2})e(\d{1,3})$/.exec(t);
    if (m) { out.s = +m[1]; out.e = +m[2]; continue; }
    if (/^(19|20)\d{2}$/.test(t)) { out.year = +t; continue; }
    // Apostrophes vanish in scene names ("Dont") but every OTHER separator becomes a word
    // break — fusing "spider-noir" into "spidernoir" could never match "Spider.Noir.S01E01"
    // (release names normalize all punctuation to spaces), so the title was unfindable.
    for (const w of (t.replace(/['’`]/g, '').match(/[a-z0-9]+/g) || [])) out.words.push(w);
  }
  return out;
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
const OPTIONAL_TITLE_ARTICLES = new Set(['the', 'a', 'an']);
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
    const sxe = new RegExp(`\\b(s0?${wanted.s}\\s?e0?${wanted.e}|${wanted.s}x0?${wanted.e})\\b`);
    if (!sxe.test(norm)) return false;
  }
  if (wanted.year) {
    const years = [...norm.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => +m[0]);
    if (years.length && !years.some((y) => Math.abs(y - wanted.year) <= 1)) return false;
  }
  return true;
}
const { rankReleases, parseRelease } = require('./scoring');
const { mountNzb, orderVolumes } = require('./archive');

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
const { parseNzb, pickPrimaryFile, fileNameFromSubject } = require('./nzb');
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

function firstProbeMsgId(nzbXml) {
  const nzb = parseNzb(nzbXml);
  const candidates = nzb.files.map((f) => ({
    ...f,
    name: fileNameFromSubject(f.subject),
    bytes: f.segments.reduce((s, x) => s + x.bytes, 0),
  }));
  const file = orderVolumes(candidates)[0] || pickPrimaryFile(nzb);
  return file && file.segments && file.segments[0] && file.segments[0].msgId;
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
  constructor({ pool, verdicts, mounts, indexers = () => [], usage = {}, performance = () => null, enforceFeatureSize = false }) {
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
    this.sessions = new Map();    // id -> PlaySession
    this.searchCache = new Map(); // queryKey -> { at, results, errors } (prefetch-on-browse → instant play)
    this.searchInflight = new Map(); // queryKey -> Promise(hit), so Play can join an active prefetch
    this.nzbCache = new Map();    // nzbUrl -> xml (small LRU; replays remount instantly)
    this.nzbInflight = new Map(); // nzbUrl -> Promise(xml), so Play joins detail-page prefetch
    this.prepareInflight = new Map(); // nzbUrl -> Promise({vf|fail}), so Play joins detail-page prepare
    this.mountByUrl = new Map();  // nzbUrl -> mount id (live mounts are reused — replay ≈ instant)
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
    return hit && Date.now() - hit.at <= 60000 ? hit : null;
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
      const ramCapMb = Math.floor((os.totalmem() / (1024 * 1024)) * 0.2);
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
    const win = this._playbackWindowFor(vf, activeMounts, perf);
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
    return win;
  }

  _startPlaybackWarmup(vf, win) {
    if (!vf || !vf.streamable || vf._playbackWarmupStarted || typeof vf.read !== 'function') return;
    const size = Number(vf.size) || 0;
    if (size <= 0) return;
    const big = size > 4e9;
    const capBytes = Number(win && win.cacheMaxBytes) || 0;
    const warmBytes = Math.min(size, capBytes || Infinity, (big ? 96 : 32) * 1024 * 1024);
    if (!Number.isFinite(warmBytes) || warmBytes <= 0) return;
    vf._playbackWarmupStarted = true;
    const warm = (from, to) => {
      if (!(to > from)) return;
      const timer = setTimeout(() => (async () => {
        for await (const _chunk of vf.read(from, to, { priority: 'readAhead' })) {
          // Drain intentionally: this warms the VFS cache without blocking Play. MUST stay on the
          // read-ahead lane — a new stream's speculative warm must never outrank another user's
          // active playback (docs-streaming-performance.md). The player reads the head itself at
          // startup priority, so warming it higher would only steal connections, not help.
        }
      })().catch(() => {}), 150);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    warm(0, warmBytes);
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
    if (tailBytes > 0 && size - tailBytes > warmBytes) warm(size - tailBytes, size);
  }

  rebalancePlaybackWindows(now = Date.now()) {
    const perf = this.performance() || {};
    const active = [...this.mounts.values()]
      .filter((m) => m && m.streamable && now - (m._touched || 0) < 120000);
    const activeCount = Math.max(1, active.length);
    for (const vf of active) this._applyPlaybackWindow(vf, activeCount, perf);
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
    params = { ...params, q: sanitize(params.q) };
    const season = Number(params.season);
    const ep = Number(params.ep);
    if (Number.isInteger(season) && Number.isInteger(ep) && season > 0 && ep > 0 && !/\bS\d{1,2}\s*E\d{1,3}\b/i.test(params.q)) {
      params.q = `${params.q} S${String(season).padStart(2, '0')}E${String(ep).padStart(2, '0')}`.trim();
    }
    const wanted = parseWantedTitle(params.q);
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

  _recordVerdict(candidate, verdict, detail = {}) {
    this.verdicts.set(nzbVerdictKey(candidate.nzbUrl), verdict, detail);
    this.verdicts.set('t:' + normTitle(candidate.name), verdict, detail);
  }

  // Try one candidate: fetch NZB → mount → gate. Returns { vf } or { fail: reason }.
  async _tryCandidate(candidate, mountOpts) {
    // Live-mount reuse: replays and multi-user plays of the same release skip everything.
    const liveId = this.mountByUrl.get(candidate.nzbUrl);
    if (liveId) {
      const live = this.mounts.get(liveId);
      if (live && live.streamable) {
        live._touched = Date.now();
        if (candidate.name) live._releaseName = candidate.name;
        return { vf: live };
      }
      this.mountByUrl.delete(candidate.nzbUrl);
    }
    const pending = this.prepareInflight.get(candidate.nzbUrl);
    if (pending) return pending;
    const run = this._tryCandidateFresh(candidate, mountOpts);
    this.prepareInflight.set(candidate.nzbUrl, run);
    try {
      return await run;
    } finally {
      if (this.prepareInflight.get(candidate.nzbUrl) === run) this.prepareInflight.delete(candidate.nzbUrl);
    }
  }

  async _tryCandidateFresh(candidate, mountOpts) {
    let xml = this.nzbCache.get(candidate.nzbUrl);
    if (xml) this.metrics.nzbCacheHits++;
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
    const probeT0 = Date.now();
    try {
      const probeMsg = firstProbeMsgId(xml);
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
    const mountPromise = withDeadline(mountNzb(this.pool(), xml, mountOpts), MOUNT_DEADLINE_MS, 'mount timeout');
    mountPromise.catch(() => {}); // a probe-missing short-circuit must not leave an unhandled rejection

    // Fail fast if the cheap probe proves the first article missing before the mount lands —
    // the dead-source skip the probe exists for, now without gating the healthy path.
    if (probePromise) {
      const winner = await Promise.race([
        probePromise.then((v) => ({ kind: 'probe', v })),
        mountPromise.then(() => ({ kind: 'mount' }), () => ({ kind: 'mount' })),
      ]);
      if (winner.kind === 'probe' && winner.v === 'missing') {
        this._recordVerdict(candidate, 'missing', { stage: 'first-article' });
        return { fail: 'missing: first article unavailable' };
      }
      // No provider answered at all — a connection/VPN/port/credentials problem, NOT a dead source.
      // Fail with an honest reason (no verdict cached — the source is fine once connectivity returns).
      if (winner.kind === 'probe' && winner.v === 'unreachable') {
        return { fail: 'provider unreachable: no usenet provider could be reached (connection/VPN/port/credentials)' };
      }
    }
    try {
      vf = await mountPromise;
      const mountMs = Date.now() - mountT0;
      this.metrics.mountSuccesses++;
      this.metrics.mountMs += mountMs;
      this.metrics.mountMaxMs = Math.max(this.metrics.mountMaxMs, mountMs);
    } catch (e) {
      const mountMs = Date.now() - mountT0;
      this.metrics.mountFailures++;
      this.metrics.mountMs += mountMs;
      this.metrics.mountMaxMs = Math.max(this.metrics.mountMaxMs, mountMs);
      // If the mount failed AND the concurrent probe says the first article is missing, report a
      // missing source (stable fast-skip verdict) rather than a generic mount error.
      if (probePromise) {
        const pv = await probePromise.catch(() => 'error');
        if (pv === 'missing') {
          this._recordVerdict(candidate, 'missing', { stage: 'first-article' });
          return { fail: 'missing: first article unavailable' };
        }
      }
      this._recordVerdict(candidate, mountVerdictForError(e));
      return { fail: `mount: ${e.message}` };
    }

    if (!vf.streamable) {
      const streamClass = vf.tags.includes('compressed') ? 'compressed'
        : vf.tags.includes('encrypted') ? 'encrypted' : 'unsupported';
      this._recordVerdict(candidate, 'unstreamable', { streamClass, tags: vf.tags });
      return { fail: `unstreamable: ${vf.tags.join(',')}`, vf };
    }

    // The picked inner file must be the FEATURE, not the sample clip: a sample-only post
    // (68MB "2160p episode") mounted and auto-played as the real thing. Applies to archive
    // picks too — some releases keep Sample/ alongside the movie RARs.
    if (/\bsample\b/i.test(vf.name || '')) {
      this._recordVerdict(candidate, 'unstreamable', { streamClass: 'sample' });
      return { fail: `sample file picked (${vf.name})`, vf };
    }

    // Size sanity on the ACTUAL mounted bytes. The pre-mount scoring floor (scoring.js) only sees
    // the indexer's DECLARED size, which can be missing or a lie — an incomplete/fake post mounts
    // far smaller than billed (a 220 MB file that auto-played as a 2160p movie). Fail it so the
    // walk advances to a genuine source — or reports "no healthy source" honestly, not silent junk.
    const stub = this.enforceFeatureSize && stubFeatureReason(Number(vf.size) || 0, vf.name || candidate.name || '');
    if (stub) {
      this._recordVerdict(candidate, 'unstreamable', { streamClass: 'stub', sizeGb: +((Number(vf.size) || 0) / 1e9).toFixed(3) });
      return { fail: stub, vf };
    }

    // Playback read-ahead: keep work ahead of the player, but bound retained decoded bytes.
    // so the buffer outruns the bitrate — 4K-class releases (>4 GB) get the biggest window.
    // Segment sizes vary by release; the mount default stays small so triage/header peeks
    // never flood the pool.
    const perf = this.performance() || {};
    const activeMounts = [...this.mounts.values()].filter((m) => Date.now() - (m._touched || 0) < 120000).length + 1;
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
      triage.then((h) => { if (h && h.verdict) this._recordVerdict(candidate, h.verdict, { streamClass }); }).catch(() => {});
    } else if (gate && gate.verdict === 'blocked') {
      this.metrics.healthGateBlocked++;
      this._recordVerdict(candidate, 'blocked', { streamClass });
      return { fail: 'health: blocked', vf };
    } else if (gate) {
      this.metrics.healthGateResults++;
      this._recordVerdict(candidate, gate.verdict, { streamClass });
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
          if (candidate.name) res.vf._releaseName = candidate.name;
          this.mounts.set(res.vf.id, res.vf);
          this.mountByUrl.set(candidate.nzbUrl, res.vf.id);
          this.rebalancePlaybackWindows();
          this._startPlaybackWarmup(res.vf, res.vf._playWin);
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
  _commitMount(session, candidate, vf, attempts) {
    vf._touched = Date.now();
    if (candidate.name) vf._releaseName = candidate.name;
    this.mounts.set(vf.id, vf);
    this.mountByUrl.set(candidate.nzbUrl, vf.id);
    session.currentMountId = vf.id;
    this.rebalancePlaybackWindows();
    this._startPlaybackWarmup(vf, vf._playWin);
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
        if (res.vf && !res.fail) return this._commitMount(session, candidate, res.vf, attempts);
        session.history.push({ name: candidate.name, outcome: res.fail });
        attempts.push({ name: candidate.name, fail: res.fail });
      }
    } else {
      // Hedged parallel walk: speculatively mount up to `width` candidates concurrently, but COMMIT
      // IN RANK ORDER — the winner is the best (lowest-index) HEALTHY release, never a lower-ranked
      // one that merely finished first. A failed front-runner pulls the next candidate in at once; a
      // stalling front-runner gets a parallel understudy after RACE_HEDGE_MS. Losers stay unregistered
      // and start no read-ahead (see _tryCandidateFresh), so they fall out of the pool cheaply.
      const results = [];          // launch order k -> { candidate, state:'pending'|'ok'|'fail', vf?, fail? }
      const inflight = new Map();  // k -> promise(resolving to k)
      let committed = 0;           // next rank index still to decide
      const launchOne = () => {
        if (session.cursor >= session.candidates.length || results.length >= MAX_ATTEMPTS) return false;
        const candidate = session.candidates[session.cursor++];
        const k = results.length;
        results.push({ candidate, state: 'pending' });
        inflight.set(k, this._tryCandidate(candidate, mountOpts).then(
          (res) => { results[k] = (res.vf && !res.fail) ? { candidate, state: 'ok', vf: res.vf } : { candidate, state: 'fail', fail: res.fail }; return k; },
          (e) => { results[k] = { candidate, state: 'fail', fail: `error: ${e.message}` }; return k; },
        ));
        return true;
      };
      const fill = () => { while (inflight.size < width && launchOne()) { /* keep window full */ } };
      let walking = false; // flips true on the first dead pick — past that we KNOW we're walking
      launchOne();
      while (budgetLeft()) {
        // Commit the longest decided prefix, in rank order.
        while (committed < results.length && results[committed].state !== 'pending') {
          const r = results[committed];
          if (r.state === 'ok') return this._commitMount(session, r.candidate, r.vf, attempts);
          session.history.push({ name: r.candidate.name, outcome: r.fail });
          attempts.push({ name: r.candidate.name, fail: r.fail });
          committed++;
          // A dead pick proves this is a real walk (common for 4K: top UHD BluRay remuxes are
          // unstreamable) — race the whole window now instead of ramping one understudy at a time.
          walking = true;
          fill();
        }
        if (!inflight.size) break; // nothing decided-OK and nothing left running → all failed
        // Before the first failure (happy path) only a STALLING top pick gets one hedged understudy,
        // so a healthy/cached top pick costs zero extra grabs. Once walking, the window is kept full.
        const canHedge = !walking && inflight.size < width && session.cursor < session.candidates.length && results.length < MAX_ATTEMPTS;
        const racers = [...inflight.values()];
        if (canHedge) racers.push(new Promise((r) => { const t = setTimeout(() => r('hedge'), RACE_HEDGE_MS); if (t.unref) t.unref(); }));
        const w = await Promise.race(racers);
        if (w === 'hedge') { launchOne(); continue; } // front-runner is stalling — widen the race
        inflight.delete(w);
      }
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
    return this._advance(session, mountOpts);
  }
}

module.exports = { Pipeline, GATE_MS, parseWantedTitle, releaseMatches, candidateKey, nzbVerdictKey, summarizeAttempts, stubFeatureReason };

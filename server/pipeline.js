'use strict';
// The press-play pipeline: fan-out search → TRaSH-style ranking within the user's cap →
// fetch NZB → mount → bounded health gate (≤500ms soft) → stream URL + ranked alternates.
// Verdicts from every attempt feed the two-tier cache so the next press of Play is smarter.
// Auto-advance: the player calls /api/advance with the session id; we mount the next
// candidate and the client resumes at its last timestamp.

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
const { rankReleases } = require('./scoring');
const { mountNzb, orderVolumes } = require('./archive');
const { parseNzb, pickPrimaryFile, fileNameFromSubject } = require('./nzb');
const crypto = require('crypto');

const GATE_MS = 500;          // bounded upfront health gate (soft timeout)
const NZB_FETCH_IDLE_MS = 5000;
const NZB_FETCH_DEADLINE_MS = 15000; // hard cap — a slow NZB download advances to the next source
const MOUNT_DEADLINE_MS = 30000;     // hard cap — a stalled mount advances instead of hanging Play
const FIRST_ARTICLE_PROBE_MS = 800;   // cheap STAT probe catches stale NZBs before BODY fetches
const MAX_ATTEMPTS = 18;      // source walk: stale indexer rows are common; keep going past one bad release family
const MAX_ADVANCE_MS = 45000; // hard UX budget for one play/advance source walk
const PREPARE_MAX_ATTEMPTS = 3; // background detail prep: skip one bad top pick without silently walking the whole list
const PREPARE_MAX_MS = 12000;

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
      pool.stat(msgId, 'startup', { signal: ac.signal })
        .then((ok) => ok ? 'present' : 'missing')
        .catch((e) => (e && e.code === 'ABORT_ERR') ? 'timeout' : 'missing'),
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
  constructor({ pool, verdicts, mounts, indexers = () => [], usage = {}, performance = () => null }) {
    this.pool = pool;             // () => NntpPool (lazy, settings-driven)
    this.verdicts = verdicts;     // VerdictCache
    this.mounts = mounts;         // shared Map(id -> vf) owned by the HTTP server
    this.indexers = indexers;     // () => [{name,url,apikey}]
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
      // The owner setting is in seconds, but the VFS retains decoded article segments.
      // Convert to a bounded byte target, then raise the segment cap so small articles
      // can actually hold that buffer instead of being limited by readAhead * 3.
      const targetMbps = big ? 24 : 10;
      const targetMb = Math.ceil((bufferSec * targetMbps) / 8);
      const maxMb = big ? 384 : 256;
      const minMb = big ? 96 : 48;
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
    const timer = setTimeout(() => (async () => {
      for await (const _chunk of vf.read(0, warmBytes, { priority: 'readAhead' })) {
        // Drain intentionally: this warms the VFS cache without blocking Play.
      }
    })().catch(() => {}), 150);
    if (timer && typeof timer.unref === 'function') timer.unref();
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

    try {
      const probe = firstProbeMsgId(xml);
      if (probe) {
        const probeT0 = Date.now();
        const probeVerdict = await probeFirstArticle(this.pool(), probe);
        const probeMs = Date.now() - probeT0;
        this.metrics.firstProbeMs += probeMs;
        this.metrics.firstProbeMaxMs = Math.max(this.metrics.firstProbeMaxMs, probeMs);
        if (probeVerdict === 'missing') {
          this.metrics.firstProbeMissing++;
          this._recordVerdict(candidate, 'missing', { stage: 'first-article' });
          return { fail: 'missing: first article unavailable' };
        }
        // Timeout here is only "not enough evidence yet", especially over VPNs or slower
        // providers. Do not kill a candidate before the real mount/BODY path can prove it.
        if (probeVerdict === 'timeout') {
          this.metrics.firstProbeTimeout++;
          candidate._probeTimeout = true;
        } else {
          this.metrics.firstProbePresent++;
        }
      }
    } catch {
      this.metrics.firstProbeError++;
      // A malformed NZB should still fail through the normal mount path for a precise reason.
    }

    let vf;
    const mountT0 = Date.now();
    this.metrics.mountAttempts++;
    try {
      vf = await withDeadline(mountNzb(this.pool(), xml, mountOpts), MOUNT_DEADLINE_MS, 'mount timeout');
      const mountMs = Date.now() - mountT0;
      this.metrics.mountSuccesses++;
      this.metrics.mountMs += mountMs;
      this.metrics.mountMaxMs = Math.max(this.metrics.mountMaxMs, mountMs);
    } catch (e) {
      const mountMs = Date.now() - mountT0;
      this.metrics.mountFailures++;
      this.metrics.mountMs += mountMs;
      this.metrics.mountMaxMs = Math.max(this.metrics.mountMaxMs, mountMs);
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
    this._startPlaybackWarmup(vf, win);
    return { vf };
  }

  // Full play: returns { session, vf, candidate, attempts } or throws with detail.
  // params.pickKey front-loads the exact user-chosen source from the Sources drawer; the old
  // release-name pick stays as a fallback for older clients. Auto-advance still walks the
  // ranked list behind that explicit choice.
  async play(params, policy = {}, mountOpts = {}) {
    const { candidates } = await this.search(params, policy);
    const playable = this._playableCandidates(candidates, params);
    if (!playable.length) throw new Error('no playable releases found');
    const session = new PlaySession(params, playable);
    this.sessions.set(session.id, session);
    return this._advance(session, mountOpts);
  }

  _playableCandidates(candidates, params = {}) {
    let playable = candidates.filter((c) => c.score > -5000);
    if (params.pickKey || params.pick) {
      const picked = candidates.find((c) => params.pickKey && c.pickKey === params.pickKey)
        || candidates.find((c) => params.pick && c.name === params.pick);
      if (picked && picked.score > -5000) playable = [picked, ...playable.filter((c) => c.pickKey !== picked.pickKey)];
    }
    return playable;
  }

  async prepare(params, policy = {}, mountOpts = {}) {
    const { candidates } = await this.search(params, policy);
    const playable = this._playableCandidates(candidates, params);
    if (!playable.length) throw new Error('no playable releases found');
    const attempts = [];
    const started = Date.now();
    for (const candidate of playable.slice(0, PREPARE_MAX_ATTEMPTS)) {
      if (Date.now() - started >= PREPARE_MAX_MS) break;
      const res = await this._tryCandidate(candidate, mountOpts);
      if (res.vf && !res.fail) {
        res.vf._touched = Date.now();
        if (candidate.name) res.vf._releaseName = candidate.name;
        this.mounts.set(res.vf.id, res.vf);
        this.mountByUrl.set(candidate.nzbUrl, res.vf.id);
        this.rebalancePlaybackWindows();
        return { vf: res.vf, candidate, attempts, prepared: true };
      }
      attempts.push({ name: candidate.name, fail: res.fail || 'prepare failed' });
    }
    return { candidate: playable[0], attempts, prepared: false };
  }

  // Mount the next viable candidate in the session (used by play and by auto-advance).
  async _advance(session, mountOpts = {}) {
    const attempts = [];
    const started = Date.now();
    while (session.cursor < session.candidates.length
      && attempts.length < MAX_ATTEMPTS
      && Date.now() - started < MAX_ADVANCE_MS) {
      const candidate = session.candidates[session.cursor++];
      const res = await this._tryCandidate(candidate, mountOpts);
      if (res.vf && !res.fail) {
        res.vf._touched = Date.now();
        if (candidate.name) res.vf._releaseName = candidate.name;
        this.mounts.set(res.vf.id, res.vf);
        this.mountByUrl.set(candidate.nzbUrl, res.vf.id);
        session.currentMountId = res.vf.id;
        this.rebalancePlaybackWindows();
        session.history.push({ name: candidate.name, outcome: 'playing' });
        return { session, vf: res.vf, candidate, attempts };
      }
      session.history.push({ name: candidate.name, outcome: res.fail });
      attempts.push({ name: candidate.name, fail: res.fail });
    }
    const err = new Error('all candidates failed');
    err.attempts = attempts;
    throw err;
  }

  // Auto-advance API: the player reports the current source died → next source, same query.
  async advance(sessionId, mountOpts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('unknown play session');
    return this._advance(session, mountOpts);
  }
}

module.exports = { Pipeline, GATE_MS, parseWantedTitle, releaseMatches, candidateKey, nzbVerdictKey };

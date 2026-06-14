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
// Does this release NAME actually carry the wanted title, episode, and a compatible year?
// Three rules learned from "From S01E01" playing Stranger Things:
//  1. ANCHORED — the title starts at the FIRST token (scene convention: Title.Year/SxxEyy.tags).
//     "contains the words somewhere" let one-word titles ("From", "It", "Angel") match
//     mid-name junk: Stranger.Things.Tales.FROM.85, Colin.FROM.Accounts, Up.FROM.the.Grave.
//  2. NEAR-CONSECUTIVE — long titles tolerate one missing word and one inserted word
//     (Philosophers↔Sorcerers Stone), short titles none: any gap in a short title is a
//     different show (The.Curse.of.the.Crown is not The.Crown).
//  3. STRUCTURAL BOUNDARY — the token after the title must be a year/SxxEyy/quality tag,
//     never a plain word (From.DUSK.Till.Dawn for "From"; Walking.Dead.DARYL.DIXON for
//     "The Walking Dead" — the spin-off/longer-title trap).
function releaseMatches(name, wanted) {
  const norm = ' ' + String(name || '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ') + ' ';
  const toks = norm.trim().split(' ');
  let ti = 0, missed = 0, skipped = 0, matchedAny = false;
  const allowed = wanted.words.length >= 4 ? 1 : 0;
  for (const w of wanted.words) {
    const at = matchedAny ? toks.indexOf(w, ti) : (toks[0] === w ? 0 : -1);
    if (at === -1) { if (++missed > allowed) return false; continue; }  // wanted word absent
    skipped += at - ti;                                                 // name tokens jumped over
    if (skipped > allowed) return false;
    ti = at + 1; matchedAny = true;
  }
  if (wanted.words.length) {
    if (!matchedAny) return false;
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
const { mountNzb } = require('./archive');
const crypto = require('crypto');

const GATE_MS = 500;          // bounded upfront health gate (soft timeout)
const NZB_FETCH_IDLE_MS = 5000;
const NZB_FETCH_DEADLINE_MS = 15000; // hard cap — a slow NZB download advances to the next source
const MOUNT_DEADLINE_MS = 30000;     // hard cap — a stalled mount advances instead of hanging Play
const MAX_ATTEMPTS = 4;       // candidates tried per play before reporting failure

function candidateKey(candidate) {
  return crypto.createHash('sha1').update([
    candidate && candidate.indexer || '',
    candidate && candidate.nzbUrl || '',
    candidate && candidate.name || '',
    candidate && candidate.sizeBytes || '',
  ].join('\0')).digest('hex').slice(0, 16);
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
  constructor({ pool, verdicts, mounts, indexers = () => [], usage = {} }) {
    this.pool = pool;             // () => NntpPool (lazy, settings-driven)
    this.verdicts = verdicts;     // VerdictCache
    this.mounts = mounts;         // shared Map(id -> vf) owned by the HTTP server
    this.indexers = indexers;     // () => [{name,url,apikey}]
    // Indexer usage accounting (daily API/grab limits live in the HTTP layer's store):
    // onSearch fires per indexer per actual fan-out (cache hits are free); canGrab/onGrab
    // gate and count NZB downloads (cached NZBs and live-mount reuse never count).
    this.usage = { onSearch: () => {}, canGrab: () => true, onGrab: () => {}, ...usage };
    this.sessions = new Map();    // id -> PlaySession
    this.searchCache = new Map(); // queryKey -> { at, results, errors } (prefetch-on-browse → instant play)
    this.nzbCache = new Map();    // nzbUrl -> xml (small LRU; replays remount instantly)
    this.mountByUrl = new Map();  // nzbUrl -> mount id (live mounts are reused — replay ≈ instant)
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
    const wanted = parseWantedTitle(params.q);
    const key = JSON.stringify([params.q, params.imdbid, params.tvdbid, params.season, params.ep]);
    let hit = this.searchCache.get(key);
    if (!hit || Date.now() - hit.at > 60000) {
      ixs.forEach((ix) => this.usage.onSearch(ix.name)); // a real fan-out costs one API hit per indexer
      let { results, errors } = await fanout(ixs, params, { timeoutMs });
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
          const retry = await fanout(ixs, { ...params, q: simpler }, { timeoutMs });
          const verified = retry.results.filter((r) => releaseMatches(r.name, wanted));
          if (verified.length) { results = verified; errors = retry.errors; }
        }
      }
      hit = { at: Date.now(), results, errors };
      this.searchCache.set(key, hit);
      if (this.searchCache.size > 50) this.searchCache.delete(this.searchCache.keys().next().value);
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
    ]);
    if (!hit.prefetchedKeys) hit.prefetchedKeys = new Set();
    if (!hit.prefetchedKeys.has(prefetchKey)) {
      hit.prefetchedKeys.add(prefetchKey);
      const top = rankReleases(results.map((r) => ({ ...r })), policy).find((c) => c.score > -5000);
      if (top && !this.nzbCache.has(top.nzbUrl) && this.usage.canGrab(top.indexer)) {
        this.usage.onGrab(top.indexer);
        fetchUrl(top.nzbUrl, { timeoutMs: NZB_FETCH_IDLE_MS, deadlineMs: NZB_FETCH_DEADLINE_MS })
          .then((r) => {
            if (r.status === 200 && /<file\b/i.test(r.body.toString('utf8').slice(0, 4096))) {
              this.nzbCache.set(top.nzbUrl, r.body.toString('utf8'));
              if (this.nzbCache.size > 15) this.nzbCache.delete(this.nzbCache.keys().next().value);
            }
          }).catch(() => {});
      }
    }
    const enriched = results.map((r) => {
      const v = this.verdicts.get(r.nzbUrl) || this.verdicts.get('t:' + normTitle(r.name));
      return {
        ...r,
        streamClass: v?.detail?.streamClass,
        health: v ? (v.verdict === 'ok' ? 'verified' : v.verdict) : undefined,
      };
    });
    return { candidates: rankReleases(enriched, policy).map((c) => ({ ...c, pickKey: candidateKey(c) })), errors };
  }

  _recordVerdict(candidate, verdict, detail = {}) {
    this.verdicts.set(candidate.nzbUrl, verdict, detail);
    this.verdicts.set('t:' + normTitle(candidate.name), verdict, detail);
  }

  // Try one candidate: fetch NZB → mount → gate. Returns { vf } or { fail: reason }.
  async _tryCandidate(candidate, mountOpts) {
    // Live-mount reuse: replays and multi-user plays of the same release skip everything.
    const liveId = this.mountByUrl.get(candidate.nzbUrl);
    if (liveId) {
      const live = this.mounts.get(liveId);
      if (live && live.streamable) { live._touched = Date.now(); return { vf: live }; }
      this.mountByUrl.delete(candidate.nzbUrl);
    }
    let xml = this.nzbCache.get(candidate.nzbUrl);
    if (!xml) {
      // Daily grab limit: skipping is about the INDEXER's quota, not the release's health —
      // no verdict is recorded, so the release plays fine tomorrow (or via another indexer).
      if (!this.usage.canGrab(candidate.indexer)) {
        return { fail: `nzb: ${candidate.indexer} daily NZB limit reached` };
      }
      try {
        const r = await fetchUrl(candidate.nzbUrl, { timeoutMs: NZB_FETCH_IDLE_MS, deadlineMs: NZB_FETCH_DEADLINE_MS, maxBytes: 100 * 1024 * 1024 });
        xml = r.body.toString('utf8');
        if (r.status !== 200 || !/<file\b/i.test(xml)) throw new Error(`nzb fetch HTTP ${r.status}`);
        this.usage.onGrab(candidate.indexer);
        this.nzbCache.set(candidate.nzbUrl, xml);
        if (this.nzbCache.size > 15) this.nzbCache.delete(this.nzbCache.keys().next().value);
      } catch (e) {
        this._recordVerdict(candidate, 'fetch-failed');
        return { fail: `nzb: ${e.message}` };
      }
    }

    let vf;
    try {
      vf = await withDeadline(mountNzb(this.pool(), xml, mountOpts), MOUNT_DEADLINE_MS, 'mount timeout');
    } catch (e) {
      this._recordVerdict(candidate, 'mount-failed');
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

    // Playback read-ahead: keep a generous window of segments in flight AHEAD of the player
    // so the buffer outruns the bitrate — 4K-class releases (>4 GB) get the biggest window.
    // (The mount default stays small: triage/header peeks must not flood the pool.)
    const big = (vf.size || 0) > 4e9;
    for (const v of (vf.vols || [vf])) {
      v.readAhead = big ? 20 : 12;
      v.cacheMax = big ? 80 : 48;
    }

    // Bounded gate: verdict within 500ms or we play anyway and keep checking in background.
    // (Provider quirk, see bench/RESULTS.md: healthy STATs answer in ~60-250ms; only MISSES
    // are slow — so "no answer by 500ms" usually means trouble, but we never block on it.)
    const gate = await Promise.race([
      vf.triage(6).catch(() => null),
      new Promise((r) => setTimeout(r, GATE_MS, 'timeout')),
    ]);
    const streamClass = vf.container === 'flat' ? 'flat' : vf.method; // consistent across both paths
    if (gate === 'timeout') {
      vf.triage(8).then((h) => this._recordVerdict(candidate, h.verdict, { streamClass })).catch(() => {});
    } else if (gate && gate.verdict === 'blocked') {
      this._recordVerdict(candidate, 'blocked', { streamClass });
      return { fail: 'health: blocked', vf };
    } else if (gate) {
      this._recordVerdict(candidate, gate.verdict, { streamClass });
    }
    return { vf };
  }

  // Full play: returns { session, vf, candidate, attempts } or throws with detail.
  // params.pickKey front-loads the exact user-chosen source from the Sources drawer; the old
  // release-name pick stays as a fallback for older clients. Auto-advance still walks the
  // ranked list behind that explicit choice.
  async play(params, policy = {}, mountOpts = {}) {
    const { candidates } = await this.search(params, policy);
    let playable = candidates.filter((c) => c.score > -5000);
    if (params.pickKey || params.pick) {
      const picked = candidates.find((c) => params.pickKey && c.pickKey === params.pickKey)
        || candidates.find((c) => params.pick && c.name === params.pick);
      if (picked && picked.score > -5000) playable = [picked, ...playable.filter((c) => c.pickKey !== picked.pickKey)];
    }
    if (!playable.length) throw new Error('no playable releases found');
    const session = new PlaySession(params, playable);
    this.sessions.set(session.id, session);
    return this._advance(session, mountOpts);
  }

  // Mount the next viable candidate in the session (used by play and by auto-advance).
  async _advance(session, mountOpts = {}) {
    const attempts = [];
    while (session.cursor < session.candidates.length && attempts.length < MAX_ATTEMPTS) {
      const candidate = session.candidates[session.cursor++];
      const res = await this._tryCandidate(candidate, mountOpts);
      if (res.vf && !res.fail) {
        res.vf._touched = Date.now();
        this.mounts.set(res.vf.id, res.vf);
        this.mountByUrl.set(candidate.nzbUrl, res.vf.id);
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

module.exports = { Pipeline, GATE_MS, parseWantedTitle, releaseMatches, candidateKey };

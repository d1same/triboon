'use strict';
// Wyzie Subs client (sub.wyzie.io): one GET search by catalog id returns direct
// subtitle-file URLs. Auth is a server-side API key query param only.
// SRT to WebVTT for the browser <track> element. Stdlib only, like everything in server/.
// This is the CC path that matters in practice: BluRay releases carry only bitmap (PGS)
// subtitles that can never become text tracks, so online subs are how captions actually show.

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DEFAULT_BASE = 'https://sub.wyzie.io'; // .ru 301s here — skip the (flaky) redirect hop
const UA = 'Triboon v1.0';

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function permanent(message) {
  const e = new Error(message);
  e.permanent = true;
  return e;
}
function noSubtitles(message) {
  const e = permanent(message);
  e.noSubtitles = true;
  return e;
}
// Diagnostic: one concise line per Wyzie search so CC misses are debuggable in the server
// log without ever leaking the API key. Always strips key= before anything is printed.
function redactSubUrl(url) {
  const raw = String(url || '');
  try {
    const u = new URL(raw);
    if (u.searchParams.has('key')) u.searchParams.set('key', '***');
    return u.href;
  } catch {
    return raw.replace(/([?&]key=)[^&]+/gi, '$1***');
  }
}
function logSubs(msg) {
  try { console.log(`[subs] ${msg}`); } catch {}
}
function isNoSubtitleError(e) {
  return !!(e && e.noSubtitles);
}
function isNoSubtitleResponse(status, message) {
  return status === 400 && /no subtitles found/i.test(String(message || ''));
}
function noSubtitlesFor(lang, query) {
  const l = String(lang || 'en').slice(0, 5) || 'en';
  const q = String(query || 'this title').trim() || 'this title';
  return noSubtitles(`no ${l} subtitles found for "${q}"`);
}
function isTransientError(e) {
  return !e.permanent && /timeout|deadline|socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|HTTP (408|429|5\d\d)/i.test(String(e && e.message || e));
}
async function retryTransient(label, fn, { attempts = 2, delayMs = 700 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (i >= attempts - 1 || !isTransientError(e)) throw e;
      await wait(delayMs * (i + 1));
    }
  }
  const e = new Error(`${label} failed`);
  e.cause = last;
  throw e;
}

// timeoutMs = socket idle; deadlineMs = HARD total budget (a trickling response never idles,
// and this runs inside a player request — it must not be able to hang the CC menu forever).
// The deadline + hop budget are shared across redirects so a redirect chain can't loop/reset.
function request(method, url, { key, bearer, body, timeoutMs = 10000, deadlineMs = 20000, _deadlineAt, _hops = 0 } = {}) {
  const deadlineAt = _deadlineAt || (Date.now() + deadlineMs);
  return new Promise((resolve, reject) => {
    if (_hops > 5) return reject(new Error(`subs redirect loop: ${url.split('?')[0]}`));
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return reject(new Error(`subs deadline exceeded: ${url.split('?')[0]}`));
    const lib = url.startsWith('https') ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(url, {
      method,
      agent: false, // one-shot subtitle calls — no keep-alive sockets held to Wyzie
      headers: {
        'User-Agent': UA, Accept: 'application/json',
        ...(key ? { 'Api-Key': key } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); clearTimeout(deadline);
        const next = new URL(res.headers.location, url);
        const redirectKey = key && subtitleDownloadNeedsAuth(next.href, url) ? key : undefined;
        if (redirectKey && !next.searchParams.has('key')) next.searchParams.set('key', redirectKey);
        return request(method, next.href,
          { key: redirectKey, bearer, timeoutMs, _deadlineAt: deadlineAt, _hops: _hops + 1 }).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => { if (chunks.reduce((n, x) => n + x.length, 0) < 8e6) chunks.push(c); });
      res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    const deadline = setTimeout(() => req.destroy(new Error(`subs deadline after ${deadlineMs}ms: ${url.split('?')[0]}`)), remaining);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`subs timeout: ${url.split('?')[0]}`)));
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.end(payload);
  });
}

// "The Boys S01E02" / "Movie Name 2024" → { title, season, ep, year } for the search params.
function parseQuery(q) {
  const out = { title: q, season: null, ep: null, year: null };
  const se = /\bs(\d{1,2})\s?e(\d{1,3})\b/i.exec(q);
  if (se) { out.season = +se[1]; out.ep = +se[2]; }
  const yr = /\b(19|20)\d{2}\b/.exec(q);
  if (yr) out.year = +yr[0];
  out.title = q.replace(/\bs\d{1,2}\s?e\d{1,3}\b/i, '').replace(/\b(19|20)\d{2}\b/, '').replace(/\s+/g, ' ').trim();
  return out;
}

// SRT → WebVTT: header + comma→dot in timestamps. Cue ids/text pass through (VTT allows ids).
function srtToVtt(srt) {
  const body = String(srt).replace(/^﻿/, '').replace(/\r/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return body.startsWith('WEBVTT') ? body : 'WEBVTT\n\n' + body;
}

// Pick the result that best matches OUR release — sync lives and dies on this: a WEB-DL sub
// on a BluRay cut (or vice versa) drifts by the studio-logo/extended-scene offsets.
// Wyzie results are flat: { id, url, format, display, language, isHearingImpaired, media }.
function parseVttTimestamp(ts) {
  const m = /^(\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/.exec(String(ts || '').trim());
  if (!m) return null;
  return (((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000) + +m[4];
}

function formatVttTimestamp(ms) {
  let n = Math.max(0, Math.round(+ms || 0));
  const h = Math.floor(n / 3600000); n -= h * 3600000;
  const m = Math.floor(n / 60000); n -= m * 60000;
  const s = Math.floor(n / 1000); n -= s * 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(n).padStart(3, '0')}`;
}

function shiftVtt(vtt, seconds = 0) {
  const delta = Math.round((Number(seconds) || 0) * 1000);
  const body = String(vtt || '');
  if (!delta) return body;
  return body.replace(/(\d{2,}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}\.\d{3})([^\r\n]*)/g,
    (line, start, end, rest) => {
      const a = parseVttTimestamp(start);
      const b = parseVttTimestamp(end);
      if (a === null || b === null) return line;
      const shiftedStart = Math.max(0, a + delta);
      const shiftedEnd = Math.max(shiftedStart, b + delta);
      return `${formatVttTimestamp(shiftedStart)} --> ${formatVttTimestamp(shiftedEnd)}${rest || ''}`;
    });
}

function editionTags(s) {
  const x = String(s || '').toLowerCase();
  const tags = new Set();
  if (/\bextended|extended[. -]?edition\b/.test(x)) tags.add('extended');
  if (/\btheatrical|cinema[. -]?cut\b/.test(x)) tags.add('theatrical');
  if (/\bdirectors?[. -]?cut\b/.test(x)) tags.add('directors');
  if (/\bunrated\b/.test(x)) tags.add('unrated');
  if (/\buncut\b/.test(x)) tags.add('uncut');
  if (/\bimax\b/.test(x)) tags.add('imax');
  if (/\bremaster(ed)?\b/.test(x)) tags.add('remastered');
  return tags;
}
function inferredEditionFromDuration(durationSeconds) {
  const n = Number(durationSeconds) || 0;
  // Only very long feature films land here. This catches LOTR-style extended editions even
  // when the release name omits "Extended"; subtitles labeled theatrical are usually wrong.
  return n >= 3.5 * 3600 ? 'extended' : '';
}
function episodeKey(s) {
  const x = String(s || '').toLowerCase();
  const se = /\bs(\d{1,2})\s?e(\d{1,3})\b/i.exec(x);
  if (se) return `s${String(+se[1]).padStart(2, '0')}e${String(+se[2]).padStart(2, '0')}`;
  const xe = /\b(\d{1,2})x(\d{1,3})\b/i.exec(x);
  if (xe) return `s${String(+xe[1]).padStart(2, '0')}e${String(+xe[2]).padStart(2, '0')}`;
  return '';
}
function subtitleMatchText(d) {
  return [
    d && d.display,
    d && d.media,
    d && d.release,
    d && d.fileName,
    d && d.filename,
    d && d.file,
    d && d.origin,
    d && d.matchedRelease,
    d && d.matchedFilter,
  ].filter(Boolean).join(' ');
}
function releaseKey(s) {
  return String(s || '')
    .split(/[\\/]/).pop()
    .replace(/\.(mkv|mp4|m4v|avi|mov|ts|srt|vtt)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}
// "Is this subtitle already in sync with our file?" — the cheap, metadata-only signal that lets
// the server SKIP content-based sync (which would pull the audio). True when it's a moviehash-
// exact match, when the provider flagged a release/filename match, or when the subtitle's release
// key matches our file's release key. Used to avoid running alass on subs that are already synced.
// Sanity-check an alass alignment before trusting it. alass only RE-TIMES the cues it is given —
// it must never add or drop them — so a materially different cue count (or empty/garbage output)
// means the alignment is corrupt. The caller rejects it and keeps the unsynced track rather than
// show broken captions. A tiny tolerance absorbs trailing-blank / format quirks.
function subSyncResultOk(inputText, outputText) {
  const arrows = (s) => (String(s || '').match(/-->/g) || []).length;
  const outN = arrows(outputText);
  if (!outN || !/\d{2}:\d{2}:\d{2}/.test(String(outputText || ''))) return false; // empty / not timed
  const inN = arrows(inputText);
  if (!inN) return true;
  return Math.abs(outN - inN) <= Math.max(1, Math.floor(inN * 0.02));
}
function subtitleLooksSynced(d, releaseName = '') {
  if (!d) return false;
  if (d.moviehashMatch) return true;
  if (d.matchedRelease || d.matchedFilter) return true;
  const mine = releaseKey(releaseName);
  if (!mine || mine.length < 12) return false; // too little to trust a fuzzy match
  const theirs = releaseKey(subtitleMatchText(d));
  if (!theirs) return false;
  return theirs.includes(mine) || mine.includes(theirs);
}
// Popularity / trust tie-breakers (the OpenSubtitles ranking model): these only ever nudge
// BETWEEN otherwise-equal candidates. Capped well below the release/episode/hash signals so a
// popular-but-wrong-cut or wrong-episode sub can never out-rank the correct one. Both providers
// expose these under slightly different keys, so read all the common spellings.
function popularityBonus(d) {
  const downloads = Number(d && (d.downloadCount || d.downloads || d.download_count)) || 0;
  const rating = Number(d && (d.rating || d.ratings)) || 0;
  let s = Math.min(60, Math.log10(1 + Math.max(0, downloads)) * 18); // ~0..60 over 0..1e3+ downloads
  if (rating > 0) s += Math.min(12, rating * 1.2);
  if (d && (d.fromTrusted || d.from_trusted)) s += 40;
  return s;
}
// A readable, distinct label base from a release/file string: drop the path + extension and turn
// dot/underscore separators into spaces. Used so rows fall back to the actual release name rather
// than a generic "Subtitle version" (the "every option looks the same" gripe).
function cleanReleaseDisplay(s) {
  let x = String(s || '').split(/[\\/]/).pop().replace(/\.(srt|vtt|sub|idx|ass|ssa)$/i, '').trim();
  if (!x) return '';
  x = x.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return x.length > 48 ? x.slice(0, 47).trim() + '…' : x;
}
function pickSub(data, releaseName = '', { durationSeconds = 0 } = {}) {
  const mine = String(releaseName).toLowerCase();
  const myReleaseKey = releaseKey(releaseName);
  const myWeb = /\bweb[-. ]?(dl|rip)?\b|amzn|nf(?=[. ])|hulu|atvp|dsnp/i.test(mine);
  const myBlu = /blu-?ray|bd(rip|remux)?\b|remux/i.test(mine);
  const myGroup = (/-([a-z0-9]+)(?:\.(mkv|mp4|avi))?$/i.exec(mine) || [])[1];
  const myEpisode = episodeKey(mine);
  const myEdition = editionTags(mine);
  const inferredEdition = inferredEditionFromDuration(durationSeconds);
  if (inferredEdition) myEdition.add(inferredEdition);
  const score = (d) => {
    if (!d || !d.url) return -Infinity;
    const rel = subtitleMatchText(d).toLowerCase();
    const relKey = releaseKey(rel);
    const relEdition = editionTags(rel);
    const relEpisode = episodeKey(rel);
    let s = 0;
    if (!/^(srt|vtt|)$/i.test(String(d.format || ''))) s -= 500; // sub/idx etc. can't become VTT
    if (d.moviehashMatch) s += 1000; // hash-exact wins outright (OpenSubtitles), same as rankSubs
    if (myReleaseKey && relKey && relKey.includes(myReleaseKey)) s += 650; // Stremio-style exact file/release hint
    else if (myReleaseKey && relKey && myReleaseKey.includes(relKey) && relKey.length > 20) s += 220;
    if (myEpisode && relEpisode === myEpisode) s += 260;
    else if (myEpisode && relEpisode) s -= 1000;
    else if (myEpisode) s -= 80;
    if (myGroup && rel.includes(myGroup)) s += 200;              // same release group ≈ frame-exact
    const matchedEdition = [...myEdition].some((tag) => relEdition.has(tag));
    for (const tag of myEdition) {
      if (relEdition.has(tag)) s += 180;
      else if (relEdition.size && !matchedEdition) s -= 160;       // right movie, wrong cut
    }
    if (!myEdition.size && relEdition.size) s -= 140;              // do not auto-pick Extended/Uncut for theatrical-looking releases
    if (myWeb && /web|amzn|nf[. ]|hulu|atvp|dsnp/.test(rel)) s += 100;
    if (myBlu && /blu|bd|remux/.test(rel)) s += 100;
    if ((myWeb && /blu|bd|remux/.test(rel)) || (myBlu && /web/.test(rel))) s -= 80; // wrong cut
    s += popularityBonus(d); // tie-breaker only — capped below release/episode signals
    if (d.isHearingImpaired) s -= 10;
    return s;
  };
  return data.map((d) => ({ d, s: score(d) })).sort((x, y) => y.s - x.s).map((x) => x.d)
    .find((d) => d && d.url);
}

// Search by TMDB id (+ SxxExx parsed from the play query) → pick best file → SRT → VTT.
// Throws with a clear message on misses.
function subtitleVariantId(d, idx = 0) {
  const direct = d && d.id != null ? String(d.id) : '';
  if (direct) return direct.replace(/[^a-z0-9_.:-]/gi, '').slice(0, 80) || direct;
  const raw = [d && d.url, d && d.display, d && d.media, idx].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}
function subtitleSourceLabel(rel) {
  const x = String(rel || '').toLowerCase();
  if (/\bweb[-. ]?dl\b/.test(x)) return 'WEB-DL';
  if (/\bweb[-. ]?rip\b/.test(x)) return 'WEBRip';
  if (/\bhdtv\b/.test(x)) return 'HDTV';
  if (/\b(bd)?remux\b/.test(x)) return 'BluRay Remux';
  if (/blu[-. ]?ray|\bbdrip\b|\bbd\b/.test(x)) return 'BluRay';
  if (/\bweb\b|amzn|nf(?=[. ])|hulu|atvp|dsnp/i.test(x)) return 'WEB';
  return '';
}
function subtitleGroupLabel(d) {
  const raw = String(d && (d.display || d.media) || '');
  const m = /-([a-z0-9]+)(?:\.(?:srt|vtt))?$/i.exec(raw);
  return m && m[1] ? m[1] : '';
}
function subtitleVariantLabel(d) {
  const rel = subtitleMatchText(d).toLowerCase();
  const tags = editionTags(rel);
  const parts = [];
  const ep = episodeKey(rel);
  if (ep) parts.push(ep.toUpperCase());
  if (tags.has('extended')) parts.push('Extended');
  else if (tags.has('theatrical')) parts.push('Theatrical');
  else if (tags.has('directors')) parts.push("Director's cut");
  else if (tags.has('unrated')) parts.push('Unrated');
  else if (tags.has('uncut')) parts.push('Uncut');
  else if (tags.has('imax')) parts.push('IMAX');
  const source = subtitleSourceLabel(rel);
  if (source) parts.push(source);
  const group = subtitleGroupLabel(d);
  if (group) parts.push(group);
  if (d && d.isHearingImpaired) parts.push('SDH');
  if (parts.length) return parts.join(' - ');
  // No structured signal — fall back to the actual release/file name so rows stay distinct and
  // recognizable, not a wall of identical "Subtitle version" entries.
  return cleanReleaseDisplay(d && (d.display || d.media)) || String((d && d.language) || '') || 'Subtitle version';
}

function wyzieCatalogId({ tmdbId, imdbId } = {}) {
  const imdb = String(imdbId || '').trim();
  if (/^tt\d{5,10}$/i.test(imdb)) return imdb.toLowerCase();
  const tmdb = String(tmdbId || '').replace(/\D/g, '');
  return tmdb || '';
}

// Wyzie (and the OpenSubtitles REST API) expect ISO 639-1 two-letter language codes, but
// ffprobe / Matroska tracks emit three-letter ISO 639-2 codes — frequently the Bibliographic
// (B) variant derived from the English name (ger/fre/cze/gre/per/chi) which does NOT resemble
// the 639-1 code. Mapping the wrong/truncated code (e.g. ces -> "ce") makes Wyzie search a
// bogus language and return nothing — a top cause of "no subtitles" on non-English titles.
// This table covers every B/T dual-code pair plus the common single-code languages a media
// library realistically carries. Keep in sync with LANG_3TO2 in web/index.html.
const ISO6392_TO_1 = {
  eng: 'en', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt',
  rus: 'ru', ara: 'ar', hin: 'hi', ben: 'bn', urd: 'ur', fas: 'fa', per: 'fa', tur: 'tr',
  nld: 'nl', dut: 'nl', pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', nob: 'nb', nno: 'nn',
  fin: 'fi', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', tha: 'th', vie: 'vi', ind: 'id',
  msa: 'ms', may: 'ms', zsm: 'ms', heb: 'he', ell: 'el', gre: 'el', ces: 'cs', cze: 'cs',
  slk: 'sk', slo: 'sk', hun: 'hu', ron: 'ro', rum: 'ro', bul: 'bg', ukr: 'uk', hrv: 'hr',
  srp: 'sr', slv: 'sl', lit: 'lt', lav: 'lv', est: 'et', cat: 'ca', glg: 'gl', eus: 'eu',
  baq: 'eu', isl: 'is', ice: 'is', gle: 'ga', cym: 'cy', wel: 'cy', sqi: 'sq', alb: 'sq',
  hye: 'hy', arm: 'hy', kat: 'ka', geo: 'ka', mkd: 'mk', mac: 'mk', mya: 'my', bur: 'my',
  afr: 'af', swa: 'sw', tgl: 'tl', fil: 'tl', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn',
  mar: 'mr', guj: 'gu', pan: 'pa', sin: 'si', amh: 'am', aze: 'az', kaz: 'kk', uzb: 'uz',
  bel: 'be', bos: 'bs', srp_latn: 'sr',
};
// Normalize any language token (BCP 47 tag, 639-1, or 639-2 B/T) to the ISO 639-1 code Wyzie
// wants. Returns '' for unknown 3-letter codes so the caller can fall back deliberately.
function toIso6391(code) {
  const raw = String(code || '').trim().toLowerCase();
  if (!raw) return '';
  const primary = raw.split(/[-_]/)[0]; // 'pt-BR' -> 'pt', 'zh-hans' -> 'zh'
  if (primary.length === 2) return primary;        // already 639-1
  if (primary.length === 3) return ISO6392_TO_1[primary] || '';
  return '';
}

function wyzieSearchUrl({ base = DEFAULT_BASE, key, tmdbId, imdbId, query, lang = 'en', releaseName = '', refresh = false, releaseHints = true } = {}) {
  const w = parseQuery(query || '');
  const u = new URL(`${base}/search`);
  u.searchParams.set('id', wyzieCatalogId({ tmdbId, imdbId }));
  if (w.season != null) { u.searchParams.set('season', w.season); u.searchParams.set('episode', w.ep); }
  u.searchParams.set('language', toIso6391(lang) || String(lang || '').slice(0, 2) || 'en');
  u.searchParams.set('format', 'srt,vtt');
  u.searchParams.set('source', 'all');
  if (releaseName && releaseHints) {
    u.searchParams.set('release', releaseName);
    u.searchParams.set('origin', releaseName);
    u.searchParams.set('fileName', releaseName);
    u.searchParams.set('file', releaseName);
  }
  if (refresh) u.searchParams.set('refresh', 'true');
  if (key) u.searchParams.set('key', key);
  return u;
}

function parseWyzieSearchBody(body) {
  try { return JSON.parse(body); } catch { throw new Error('wyzie returned a non-JSON response'); }
}

async function wyzieSearchResults({ key, tmdbId, imdbId, query, lang = 'en', releaseName = '', base = DEFAULT_BASE,
  attempts = 2, retryDelayMs = 700 } = {}) {
  const requestSearch = (refresh = false, releaseHints = true) => retryTransient('Wyzie subtitle search', async () => {
    const u = wyzieSearchUrl({ base, key, tmdbId, imdbId, query, lang, releaseName, refresh, releaseHints });
    const r = await request('GET', u.href, { timeoutMs: 25000, deadlineMs: 35000 });
    if (r.status === 401) throw permanent('Wyzie Subs key missing or invalid');
    if (r.status !== 200) {
      let msg = '';
      try { msg = (JSON.parse(r.body) || {}).message || ''; } catch {}
      if (releaseHints && r.status === 400 && /no matching release/i.test(msg)) {
        const e = permanent('Wyzie release filters found no exact match');
        e.releaseMismatch = true;
        throw e;
      }
      if (isNoSubtitleResponse(r.status, msg)) throw noSubtitlesFor(lang, query);
      const e = new Error(msg ? `wyzie search HTTP ${r.status}: ${msg}` : `wyzie search HTTP ${r.status}`);
      if (![408, 429].includes(r.status) && r.status < 500) e.permanent = true;
      throw e;
    }
    return r;
  }, { attempts, delayMs: retryDelayMs });

  const run = async (releaseHints) => {
    try {
      let sr = await requestSearch(false, releaseHints);
      let data = parseWyzieSearchBody(sr.body);
      if (Array.isArray(data) && !data.length) {
        sr = await requestSearch(true, releaseHints);
        data = parseWyzieSearchBody(sr.body);
      }
      return data;
    } catch (e) {
      if (releaseHints && e && e.releaseMismatch) return null;
      throw e;
    }
  };

  const catId = wyzieCatalogId({ tmdbId, imdbId });
  const idKind = /^tt/.test(catId) ? 'imdb' : (catId ? 'tmdb' : 'none');
  const w = parseQuery(query || '');
  const ep = w.season != null ? ` s${w.season}e${w.ep}` : '';
  const wlang = toIso6391(lang) || String(lang || '').slice(0, 2) || 'en';
  const langLabel = wlang === lang ? wlang : `${lang}->${wlang}`;
  try {
    // Go straight to the broad search — we deliberately do NOT send Wyzie the release/file hints.
    // Measured on a live key: the hinted lookup is ~2x slower (~10s) AND almost always returns
    // 400 "no matching release", so it only ever delayed the broad fallback that actually has
    // results (~10s of dead time on every cold subtitle load). Release/episode/edition matching is
    // done LOCALLY in rankSubs/pickSub — that's what picks the in-sync sub — and subtitleLooksSynced
    // still detects release matches by key, so we lose nothing but the latency.
    let data = await run(false);
    let path = (Array.isArray(data) && data.length) ? 'broad' : 'empty';
    const count = Array.isArray(data) ? data.length : 0;
    logSubs(`search id=${catId || '-'}(${idKind}) lang=${langLabel}${ep} release=${releaseName ? 'y' : 'n'} path=${path} -> ${count} result(s)`);
    return data;
  } catch (e) {
    logSubs(`search id=${catId || '-'}(${idKind}) lang=${langLabel}${ep} release=${releaseName ? 'y' : 'n'} FAILED: ${String(e && e.message || e).slice(0, 140)}`);
    throw e;
  }
}

function rankSubs(data, releaseName = '', { durationSeconds = 0 } = {}) {
  const picked = pickSub(data, releaseName, { durationSeconds });
  const bestKey = picked && (picked.id != null ? String(picked.id) : String(picked.url || ''));
  const mine = String(releaseName).toLowerCase();
  const myReleaseKey = releaseKey(releaseName);
  const myWeb = /\bweb[-. ]?(dl|rip)?\b|amzn|nf(?=[. ])|hulu|atvp|dsnp/i.test(mine);
  const myBlu = /blu-?ray|bd(rip|remux)?\b|remux/i.test(mine);
  const myGroup = (/-([a-z0-9]+)(?:\.(mkv|mp4|avi))?$/i.exec(mine) || [])[1];
  const myEpisode = episodeKey(mine);
  const myEdition = editionTags(mine);
  const inferredEdition = inferredEditionFromDuration(durationSeconds);
  if (inferredEdition) myEdition.add(inferredEdition);
  const score = (d) => {
    if (!d || !d.url) return -Infinity;
    const rel = subtitleMatchText(d).toLowerCase();
    const relKey = releaseKey(rel);
    const relEdition = editionTags(rel);
    const relEpisode = episodeKey(rel);
    let s = 0;
    if (!/^(srt|vtt|)$/i.test(String(d.format || ''))) s -= 500;
    // Hash-exact (OpenSubtitles moviehash) is the strongest in-sync signal there is — it must
    // outrank even a perfect release-name match, per the OpenSubtitles ranking model.
    if (d.moviehashMatch) s += 1000;
    if (myReleaseKey && relKey && relKey.includes(myReleaseKey)) s += 650;
    else if (myReleaseKey && relKey && myReleaseKey.includes(relKey) && relKey.length > 20) s += 220;
    if (myEpisode && relEpisode === myEpisode) s += 260;
    else if (myEpisode && relEpisode) s -= 1000;
    else if (myEpisode) s -= 80;
    if (myGroup && rel.includes(myGroup)) s += 200;
    const matchedEdition = [...myEdition].some((tag) => relEdition.has(tag));
    for (const tag of myEdition) {
      if (relEdition.has(tag)) s += 180;
      else if (relEdition.size && !matchedEdition) s -= 160;
    }
    if (!myEdition.size && relEdition.size) s -= 140;
    if (myWeb && /web|amzn|nf[. ]|hulu|atvp|dsnp/.test(rel)) s += 100;
    if (myBlu && /blu|bd|remux/.test(rel)) s += 100;
    if ((myWeb && /blu|bd|remux/.test(rel)) || (myBlu && /web/.test(rel))) s -= 80;
    s += popularityBonus(d); // tie-breaker only — capped below release/episode/hash signals
    if (d.isHearingImpaired) s -= 10;
    return s;
  };
  const ranked = (Array.isArray(data) ? data : []).map((d, idx) => {
    const s = score(d);
    if (!Number.isFinite(s) || s === -Infinity || !d || !d.url) return null;
    const key = d.id != null ? String(d.id) : String(d.url || '');
    return {
      id: subtitleVariantId(d, idx),
      label: subtitleVariantLabel(d),
      display: String(d.display || d.media || d.url || ''),
      language: d.language || '',
      format: d.format || '',
      hearingImpaired: !!d.isHearingImpaired,
      score: s,
      selected: bestKey && key === bestKey,
      raw: d,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score || String(a.display).localeCompare(String(b.display)));
  if (ranked.length && !ranked.some((v) => v.selected)) ranked[0].selected = true;
  dedupeVariantLabels(ranked);
  return ranked;
}

// Guarantee no two menu rows read identically (the "many options look the same" gripe). When
// labels collide, append a distinguisher — release group, then source tag, then language — and
// fall back to a numeric suffix so uniqueness is always reached.
function dedupeVariantLabels(ranked) {
  const counts = new Map();
  for (const v of ranked) counts.set(v.label, (counts.get(v.label) || 0) + 1);
  const nth = new Map();
  for (const v of ranked) {
    if ((counts.get(v.label) || 0) <= 1) continue;
    const n = (nth.get(v.label) || 0) + 1; nth.set(v.label, n);
    if (n === 1) continue; // first occurrence keeps the clean label
    const rel = subtitleMatchText(v.raw || v);
    const extra = subtitleGroupLabel(v.raw || v) || subtitleSourceLabel(rel) || String(v.language || '').toUpperCase();
    v.label = extra && !v.label.toLowerCase().includes(extra.toLowerCase()) ? `${v.label} - ${extra} (${n})` : `${v.label} (${n})`;
  }
}

// The user-facing variant LIST must not advertise subtitles that cannot actually play for THIS
// file. Two confident "this option will not work" cases get trimmed before display:
//   - non-text formats (sub/idx/PGS bitmap can never become WebVTT), and
//   - for a TV target, files that are explicitly a DIFFERENT episode (wrong dialogue — the
//     classic "House has a dozen options but most don't work").
// rankSubs keeps those (heavily down-ranked) so auto-pick/fallback can still reason over the
// full set; this is purely the display trim. Generic / no-episode-key rows are KEPT — they are
// frequently the only correctly-synced option for a given release. If filtering would empty the
// list (e.g. the provider only returned wrong-episode hits) we return the ranked list unchanged
// so we degrade to best-effort rather than to a bare "no subtitles".
function usableVariants(ranked, { releaseName = '' } = {}) {
  const list = Array.isArray(ranked) ? ranked.filter(Boolean) : [];
  const myEpisode = episodeKey(releaseName);
  const playable = list.filter((v) => {
    if (!/^(srt|vtt|)$/i.test(String(v.format || ''))) return false; // bitmap can't render as text
    if (myEpisode) {
      const relEp = episodeKey(subtitleMatchText(v.raw || v));
      if (relEp && relEp !== myEpisode) return false;               // confirmed wrong episode
    }
    return true;
  });
  const out = playable.length ? playable : list;
  if (out.length && !out.some((v) => v.selected)) out[0].selected = true;
  return out;
}

// Collapse the ranked list into the DISTINCT choices worth showing a human. Wyzie routinely
// returns dozens of interchangeable English SRTs mirrored across source sites; a 12-row wall of
// "English (2)…(8)" is the real "many options but I can't tell them apart" gripe. We keep one
// representative (best-scored) per meaningful bucket — episode + release source (WEB-DL/HDTV/
// BluRay…) + hearing-impaired + language — and record how many duplicates it stood in for. The
// FULL ranked set is still used server-side for download fallback, so collapsing only trims the
// DISPLAY, never the candidates we can actually fetch.
function distinctVariants(variants, { max = 8 } = {}) {
  const list = Array.isArray(variants) ? variants.filter(Boolean) : [];
  const buckets = new Map();
  const out = [];
  for (const v of list) {
    const text = subtitleMatchText(v.raw || v);
    // Edition is part of the bucket: an Extended cut and a Theatrical cut are genuinely different
    // choices (they sync differently), so they must never collapse into each other.
    const edition = [...editionTags(text)].sort().join(',');
    const key = `${episodeKey(text)}|${subtitleSourceLabel(text)}|${edition}|${v.hearingImpaired ? 'sdh' : ''}|${v.language || ''}`;
    if (buckets.has(key)) { buckets.get(key).dupes = (buckets.get(key).dupes || 0) + 1; continue; }
    v.dupes = 0; buckets.set(key, v); out.push(v);
    if (out.length >= max) break;
  }
  if (out.length && !out.some((v) => v.selected)) out[0].selected = true;
  return out;
}

// Auto-select safety: is there a variant we can confidently auto-serve for THIS file? A text sub
// that is the right episode (or has no episode at all, e.g. a season pack / generically-named
// file) qualifies; a confirmed DIFFERENT episode does not. When this is false for a TV target we
// would rather report "no subtitles" than silently feed the viewer the wrong episode's dialogue
// (which reads as "CC is broken"). Explicit user picks bypass this — only the automatic path uses it.
function hasConfidentAutoPick(variants, { releaseName = '' } = {}) {
  const list = Array.isArray(variants) ? variants.filter(Boolean) : [];
  if (!list.length) return false;
  const isText = (v) => /^(srt|vtt|)$/i.test(String(v.format || ''));
  const myEpisode = episodeKey(releaseName);
  if (!myEpisode) return list.some(isText);
  return list.some((v) => {
    if (!isText(v)) return false;
    const relEp = episodeKey(subtitleMatchText(v.raw || v));
    return !relEp || relEp === myEpisode; // right episode or generic/no-episode
  });
}

function subtitleDownloadCanFallback(e) {
  const msg = String(e && e.message || e || '');
  const m = /subtitle file HTTP (\d+)/i.exec(msg);
  if (!m) return false;
  const status = +m[1];
  // 402/429 are account/quota/rate-limit problems. Other file failures are commonly stale
  // provider links, so keep walking the ranked subtitle list before bothering the viewer.
  return status !== 402 && status !== 429;
}

async function downloadBestSubtitle(data, { key, releaseName = '', durationSeconds = 0, preferredId = '',
  base = DEFAULT_BASE, attempts = 2, retryDelayMs = 700 } = {}) {
  const ranked = rankSubs(data, releaseName, { durationSeconds });
  if (!ranked.length) throw permanent(`no usable subtitle file in the results`);
  let ordered = ranked;
  if (preferredId) {
    const id = String(preferredId);
    const selected = ranked.find((v) => String(v.id) === id);
    if (!selected) throw new Error('that subtitle version is no longer available');
    ordered = [selected, ...ranked.filter((v) => v !== selected)];
  }
  let last;
  for (const v of ordered) {
    try {
      return await downloadSubtitle(v.raw, { key, base, attempts, retryDelayMs });
    } catch (e) {
      last = e;
      if (!subtitleDownloadCanFallback(e)) throw e;
    }
  }
  throw new Error(`subtitle files could not be downloaded${last ? ` (${last.message || last})` : ''}`);
}

async function fetchOnlineSub({ key, tmdbId, query, lang = 'en', releaseName = '', durationSeconds = 0, base = DEFAULT_BASE,
  attempts = 2, retryDelayMs = 700 } = {}) {
  if (!tmdbId) throw permanent('online subtitles need a catalog title (no TMDB id for this play)');
  const w = parseQuery(query || '');
  const u = new URL(`${base}/search`);
  u.searchParams.set('id', String(tmdbId));
  if (w.season != null) { u.searchParams.set('season', w.season); u.searchParams.set('episode', w.ep); }
  u.searchParams.set('language', lang);
  u.searchParams.set('format', 'srt,vtt');
  u.searchParams.set('source', 'all');
  if (releaseName) {
    u.searchParams.set('release', releaseName);
    u.searchParams.set('origin', releaseName);
    u.searchParams.set('fileName', releaseName);
    u.searchParams.set('file', releaseName);
  }
  if (key) u.searchParams.set('key', key);
  // Wyzie scrapes its sources live; measured around 15s on real keys. The default 10s idle
  // timeout was killing searches that were about to succeed.
  const search = (refresh = false) => retryTransient('Wyzie subtitle search', async () => {
    if (refresh) u.searchParams.set('refresh', 'true'); else u.searchParams.delete('refresh');
      const r = await request('GET', u.href, { timeoutMs: 25000, deadlineMs: 35000 });
      if (r.status === 401) throw permanent('Wyzie Subs key missing or invalid');
      if (r.status !== 200) {
        let msg = '';
        try { msg = (JSON.parse(r.body) || {}).message || ''; } catch {}
        if (isNoSubtitleResponse(r.status, msg)) throw noSubtitlesFor(lang, query);
        const e = new Error(msg ? `wyzie search HTTP ${r.status}: ${msg}` : `wyzie search HTTP ${r.status}`);
        if (![408, 429].includes(r.status) && r.status < 500) e.permanent = true;
        throw e;
    }
    return r;
  }, { attempts, delayMs: retryDelayMs });
  let sr = await search(false);
  let data;
  try { data = JSON.parse(sr.body); } catch { throw new Error('wyzie returned a non-JSON response'); }
  if (Array.isArray(data) && !data.length) {
    sr = await search(true);
    try { data = JSON.parse(sr.body); } catch { throw new Error('wyzie returned a non-JSON response'); }
  }
  if (!Array.isArray(data) || !data.length) throw noSubtitlesFor(lang, query);
  const hit = pickSub(data, releaseName, { durationSeconds });
  if (!hit) throw permanent(`no usable ${lang} subtitle file in the results`);
  return downloadSubtitle(hit, { key, base, attempts, retryDelayMs });
}

async function searchOnlineSubs({ key, tmdbId, query, lang = 'en', releaseName = '', base = DEFAULT_BASE,
  attempts = 2, retryDelayMs = 700 } = {}) {
  if (!tmdbId) throw permanent('online subtitles need a catalog title (no TMDB id for this play)');
  const w = parseQuery(query || '');
  const u = new URL(`${base}/search`);
  u.searchParams.set('id', String(tmdbId));
  if (w.season != null) { u.searchParams.set('season', w.season); u.searchParams.set('episode', w.ep); }
  u.searchParams.set('language', lang);
  u.searchParams.set('format', 'srt,vtt');
  u.searchParams.set('source', 'all');
  if (releaseName) {
    u.searchParams.set('release', releaseName);
    u.searchParams.set('origin', releaseName);
    u.searchParams.set('fileName', releaseName);
    u.searchParams.set('file', releaseName);
  }
  if (key) u.searchParams.set('key', key);
  const search = (refresh = false) => retryTransient('Wyzie subtitle search', async () => {
    if (refresh) u.searchParams.set('refresh', 'true'); else u.searchParams.delete('refresh');
      const r = await request('GET', u.href, { timeoutMs: 25000, deadlineMs: 35000 });
      if (r.status === 401) throw permanent('Wyzie Subs key missing or invalid');
      if (r.status !== 200) {
        let msg = '';
        try { msg = (JSON.parse(r.body) || {}).message || ''; } catch {}
        if (isNoSubtitleResponse(r.status, msg)) throw noSubtitlesFor(lang, query);
        const e = new Error(msg ? `wyzie search HTTP ${r.status}: ${msg}` : `wyzie search HTTP ${r.status}`);
        if (![408, 429].includes(r.status) && r.status < 500) e.permanent = true;
        throw e;
    }
    return r;
  }, { attempts, delayMs: retryDelayMs });
  let sr = await search(false);
  let data;
  try { data = JSON.parse(sr.body); } catch { throw new Error('wyzie returned a non-JSON response'); }
  if (Array.isArray(data) && !data.length) {
    sr = await search(true);
    try { data = JSON.parse(sr.body); } catch { throw new Error('wyzie returned a non-JSON response'); }
  }
  if (!Array.isArray(data) || !data.length) throw noSubtitlesFor(lang, query);
  return data;
}

function subtitleDownloadNeedsAuth(rawUrl, base = DEFAULT_BASE) {
  try {
    const target = new URL(String(rawUrl || ''));
    const configured = new URL(String(base || DEFAULT_BASE));
    const host = target.hostname.toLowerCase();
    const baseHost = configured.hostname.toLowerCase();
    return host === baseHost || host === 'sub.wyzie.io' || host === 'sub.wyzie.ru'
      || host.endsWith('.wyzie.io') || host.endsWith('.wyzie.ru');
  } catch {
    return false;
  }
}

function subtitleDownloadUrl(rawUrl, { key, base = DEFAULT_BASE } = {}) {
  if (!key || !subtitleDownloadNeedsAuth(rawUrl, base)) return rawUrl;
  try {
    const u = new URL(String(rawUrl));
    u.searchParams.set('key', key);
    return u.href;
  } catch {
    return rawUrl;
  }
}

async function downloadSubtitle(hit, { key, base = DEFAULT_BASE, attempts = 2, retryDelayMs = 700 } = {}) {
  if (!hit || !hit.url) throw permanent('subtitle result did not include a download url');
  const needsAuth = !!key && subtitleDownloadNeedsAuth(hit.url, base);
  const url = subtitleDownloadUrl(hit.url, { key, base });
  const file = await retryTransient('Wyzie subtitle download', async () => {
    const r = await request('GET', url, { key: needsAuth ? key : undefined, timeoutMs: 15000, deadlineMs: 25000 });
    if (r.status !== 200) {
      const e = new Error(`subtitle file HTTP ${r.status}`);
      if (![408, 429].includes(r.status) && r.status < 500) e.permanent = true;
      throw e;
    }
    return r;
  }, { attempts, delayMs: retryDelayMs });
  return srtToVtt(file.body);
}

async function fetchOnlineSubV2({ key, tmdbId, imdbId, query, lang = 'en', releaseName = '', durationSeconds = 0, base = DEFAULT_BASE,
  attempts = 2, retryDelayMs = 700 } = {}) {
  if (!wyzieCatalogId({ tmdbId, imdbId })) throw permanent('online subtitles need a catalog title (no TMDB or IMDb id for this play)');
  const data = await wyzieSearchResults({ key, tmdbId, imdbId, query, lang, releaseName, base, attempts, retryDelayMs });
  if (!Array.isArray(data) || !data.length) throw noSubtitlesFor(lang, query);
  return downloadBestSubtitle(data, { key, releaseName, durationSeconds, base, attempts, retryDelayMs });
}

async function searchOnlineSubsV2({ key, tmdbId, imdbId, query, lang = 'en', releaseName = '', base = DEFAULT_BASE,
  attempts = 2, retryDelayMs = 700 } = {}) {
  if (!wyzieCatalogId({ tmdbId, imdbId })) throw permanent('online subtitles need a catalog title (no TMDB or IMDb id for this play)');
  const data = await wyzieSearchResults({ key, tmdbId, imdbId, query, lang, releaseName, base, attempts, retryDelayMs });
  if (!Array.isArray(data) || !data.length) throw noSubtitlesFor(lang, query);
  return data;
}

// ---------------------------------------------------------------------------
// OpenSubtitles REST provider (api.opensubtitles.com/api/v1) — OPTIONAL second
// provider, added for HASH-EXACT matching that Wyzie cannot do. Entirely gated on
// an admin-configured Api-Key (+ username/password for the download quota); when
// unconfigured none of this runs and the Wyzie path is unchanged.
// ---------------------------------------------------------------------------
const OS_REST_BASE = 'https://api.opensubtitles.com/api/v1';
const OS_MASK = (1n << 64n) - 1n;

// OpenSubtitles "moviehash" (OSHash): 64-bit = filesize + sum of little-endian uint64
// words across the first 64KB and last 64KB, with unsigned 64-bit wraparound. Only 128KB
// of I/O is needed regardless of file size — cheap to compute on a mounted NZB via two reads.
// Returns null when the file is too small (<128KB) for the algorithm to be defined.
function moviehashFromChunks(headBuf, tailBuf, sizeBytes) {
  const size = Number(sizeBytes) || 0;
  if (size < 131072 || !Buffer.isBuffer(headBuf) || !Buffer.isBuffer(tailBuf)) return null;
  let hash = BigInt(size) & OS_MASK;
  const addChunk = (buf) => {
    const n = Math.floor(buf.length / 8) * 8;
    for (let i = 0; i < n; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & OS_MASK;
  };
  addChunk(headBuf);
  addChunk(tailBuf);
  return hash.toString(16).padStart(16, '0');
}

function osHeaders(apiKey, bearer) {
  return { apiKey, bearer };
}

// GET /subtitles — combine moviehash + external id + episode. Returns the raw `data` array.
async function osSearch({ apiKey, base = OS_REST_BASE, moviehash = '', imdbId = '', tmdbId = '',
  query = '', lang = 'en', attempts = 2, retryDelayMs = 700 } = {}) {
  if (!apiKey) throw permanent('OpenSubtitles is not configured (no API key)');
  const w = parseQuery(query || '');
  const u = new URL(`${base}/subtitles`);
  const wlang = toIso6391(lang) || String(lang || '').slice(0, 2) || 'en';
  u.searchParams.set('languages', wlang);
  if (moviehash) u.searchParams.set('moviehash', String(moviehash).toLowerCase());
  const imdbNum = String(imdbId || '').replace(/^tt/i, '').replace(/\D/g, '');
  const tmdbNum = String(tmdbId || '').replace(/\D/g, '');
  if (imdbNum) u.searchParams.set('imdb_id', imdbNum);
  else if (tmdbNum) u.searchParams.set('tmdb_id', tmdbNum);
  if (w.season != null) { u.searchParams.set('season_number', w.season); u.searchParams.set('episode_number', w.ep); }
  if (!moviehash && !imdbNum && !tmdbNum) throw permanent('OpenSubtitles needs a moviehash or catalog id');
  const r = await retryTransient('OpenSubtitles search', async () => {
    const res = await request('GET', u.href, { key: apiKey, timeoutMs: 15000, deadlineMs: 25000 });
    if (res.status === 401 || res.status === 403) throw permanent('OpenSubtitles API key invalid');
    if (res.status !== 200) {
      const e = new Error(`opensubtitles search HTTP ${res.status}`);
      if (![408, 429].includes(res.status) && res.status < 500) e.permanent = true;
      throw e;
    }
    return res;
  }, { attempts, delayMs: retryDelayMs });
  let body;
  try { body = JSON.parse(r.body); } catch { throw new Error('opensubtitles returned non-JSON'); }
  return Array.isArray(body && body.data) ? body.data : [];
}

// Map an OpenSubtitles `data[]` entry into the same shape pickSub/rankSubs already consume,
// so both providers rank in one list. moviehash_match becomes a strong release-key signal.
function osNormalize(entry) {
  const a = (entry && entry.attributes) || {};
  const file = (Array.isArray(a.files) && a.files[0]) || {};
  const rel = a.release || file.file_name || (a.feature_details && a.feature_details.movie_name) || '';
  return {
    id: `os:${file.file_id || entry.id || ''}`,
    _osFileId: file.file_id || null,
    url: file.file_id ? `opensubtitles:${file.file_id}` : '', // resolved at download time via /download
    format: 'srt',
    language: a.language || '',
    display: rel,
    media: rel,
    release: rel,
    isHearingImpaired: !!a.hearing_impaired,
    downloadCount: a.download_count || 0,
    rating: a.ratings || 0,
    fromTrusted: !!a.from_trusted,
    moviehashMatch: !!a.moviehash_match,
    _provider: 'opensubtitles',
  };
}

// POST /login → bearer token (+ possibly a dedicated base_url). Tokens are cached by the caller.
async function osLogin({ apiKey, username, password, base = OS_REST_BASE } = {}) {
  if (!apiKey || !username || !password) throw permanent('OpenSubtitles download needs API key + username + password');
  const res = await request('POST', `${base}/login`, { key: apiKey, body: { username, password }, timeoutMs: 15000, deadlineMs: 25000 });
  if (res.status !== 200) {
    const e = new Error(`opensubtitles login HTTP ${res.status}`);
    if (![408, 429].includes(res.status) && res.status < 500) e.permanent = true;
    throw e;
  }
  let body; try { body = JSON.parse(res.body); } catch { throw new Error('opensubtitles login non-JSON'); }
  if (!body || !body.token) throw permanent('opensubtitles login returned no token');
  return { token: body.token, baseUrl: body.base_url ? `https://${body.base_url}/api/v1` : base };
}

// POST /download {file_id} → temporary link, then GET the link → VTT. `quota` reports remaining.
async function osDownloadVtt(fileId, { apiKey, token, base = OS_REST_BASE } = {}) {
  if (!apiKey || !token) throw permanent('OpenSubtitles download needs a login token');
  if (!fileId) throw permanent('OpenSubtitles result had no file id');
  const res = await request('POST', `${base}/download`, { key: apiKey, bearer: token, body: { file_id: Number(fileId) }, timeoutMs: 15000, deadlineMs: 25000 });
  if (res.status === 406 || res.status === 429) { const e = new Error('OpenSubtitles download quota reached'); e.quota = true; throw e; }
  if (res.status !== 200) {
    const e = new Error(`opensubtitles download HTTP ${res.status}`);
    if (![408, 429].includes(res.status) && res.status < 500) e.permanent = true;
    throw e;
  }
  let body; try { body = JSON.parse(res.body); } catch { throw new Error('opensubtitles download non-JSON'); }
  if (!body || !body.link) throw new Error('opensubtitles download returned no link');
  const file = await request('GET', body.link, { timeoutMs: 15000, deadlineMs: 25000 });
  if (file.status !== 200) throw new Error(`opensubtitles file HTTP ${file.status}`);
  return { vtt: srtToVtt(file.body), remaining: Number(body.remaining), fileName: body.file_name || '' };
}

module.exports = {
  fetchOnlineSub: fetchOnlineSubV2, searchOnlineSubs: searchOnlineSubsV2,
  osSearch, osNormalize, osLogin, osDownloadVtt, moviehashFromChunks,
  downloadSubtitle, downloadBestSubtitle, rankSubs, usableVariants, distinctVariants, hasConfidentAutoPick,
  srtToVtt, shiftVtt, parseQuery, pickSub,
  _request: request, _isTransientError: isTransientError, _isNoSubtitleError: isNoSubtitleError,
  _wyzieCatalogId: wyzieCatalogId,
  _subtitleDownloadNeedsAuth: subtitleDownloadNeedsAuth,
  _subtitleDownloadUrl: subtitleDownloadUrl,
  _subtitleDownloadCanFallback: subtitleDownloadCanFallback,
  _redactSubUrl: redactSubUrl,
  _toIso6391: toIso6391,
  subtitleLooksSynced, subSyncResultOk,
};

'use strict';
// Wyzie Subs client (sub.wyzie.ru) — free subtitle aggregator: one GET search by TMDB id
// returns DIRECT subtitle-file URLs (no account login, no download quota; a free API key
// comes from store.wyzie.io/redeem). Replaced OpenSubtitles, whose API went paid.
// SRT → WebVTT for the browser <track> element. Stdlib only, like everything in server/.
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
        return request(method, new URL(res.headers.location, url).href,
          { key, timeoutMs, _deadlineAt: deadlineAt, _hops: _hops + 1 }).then(resolve, reject);
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
  return n >= 4 * 3600 ? 'extended' : '';
}
function episodeKey(s) {
  const x = String(s || '').toLowerCase();
  const se = /\bs(\d{1,2})\s?e(\d{1,3})\b/i.exec(x);
  if (se) return `s${String(+se[1]).padStart(2, '0')}e${String(+se[2]).padStart(2, '0')}`;
  const xe = /\b(\d{1,2})x(\d{1,3})\b/i.exec(x);
  if (xe) return `s${String(+xe[1]).padStart(2, '0')}e${String(+xe[2]).padStart(2, '0')}`;
  return '';
}
function pickSub(data, releaseName = '', { durationSeconds = 0 } = {}) {
  const mine = String(releaseName).toLowerCase();
  const myWeb = /\bweb[-. ]?(dl|rip)?\b|amzn|nf(?=[. ])|hulu|atvp|dsnp/i.test(mine);
  const myBlu = /blu-?ray|bd(rip|remux)?\b|remux/i.test(mine);
  const myGroup = (/-([a-z0-9]+)(?:\.(mkv|mp4|avi))?$/i.exec(mine) || [])[1];
  const myEpisode = episodeKey(mine);
  const myEdition = editionTags(mine);
  const inferredEdition = inferredEditionFromDuration(durationSeconds);
  if (inferredEdition) myEdition.add(inferredEdition);
  const score = (d) => {
    if (!d || !d.url) return -Infinity;
    const rel = `${d.display || ''} ${d.media || ''}`.toLowerCase();
    const relEdition = editionTags(rel);
    const relEpisode = episodeKey(rel);
    let s = 0;
    if (!/^(srt|vtt|)$/i.test(String(d.format || ''))) s -= 500; // sub/idx etc. can't become VTT
    if (myEpisode && relEpisode === myEpisode) s += 260;
    else if (myEpisode && relEpisode) s -= 1000;
    else if (myEpisode) s -= 80;
    if (myGroup && rel.includes(myGroup)) s += 200;              // same release group ≈ frame-exact
    for (const tag of myEdition) {
      if (relEdition.has(tag)) s += 180;
      else if (relEdition.size) s -= 160;                         // right movie, wrong cut
    }
    if (myWeb && /web|amzn|nf[. ]|hulu|atvp|dsnp/.test(rel)) s += 100;
    if (myBlu && /blu|bd|remux/.test(rel)) s += 100;
    if ((myWeb && /blu|bd|remux/.test(rel)) || (myBlu && /web/.test(rel))) s -= 80; // wrong cut
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
function subtitleVariantLabel(d) {
  const rel = `${d && d.display || ''} ${d && d.media || ''}`.toLowerCase();
  const tags = editionTags(rel);
  const parts = [];
  if (tags.has('extended')) parts.push('Extended');
  else if (tags.has('theatrical')) parts.push('Theatrical');
  else if (tags.has('directors')) parts.push("Director's cut");
  else if (tags.has('unrated')) parts.push('Unrated');
  else if (tags.has('uncut')) parts.push('Uncut');
  else if (tags.has('imax')) parts.push('IMAX');
  if (/web|amzn|nf[. ]|hulu|atvp|dsnp/.test(rel)) parts.push('WEB');
  else if (/blu|bd|remux/.test(rel)) parts.push('BluRay');
  const group = (/-([a-z0-9]+)(?:\.(srt|vtt))?$/i.exec(String(d && (d.display || d.media) || '')) || [])[1];
  if (group) parts.push(group);
  if (d && d.isHearingImpaired) parts.push('SDH');
  return parts.join(' - ') || String((d && (d.display || d.media || d.language)) || 'Subtitle version');
}
function rankSubs(data, releaseName = '', { durationSeconds = 0 } = {}) {
  const picked = pickSub(data, releaseName, { durationSeconds });
  const bestKey = picked && (picked.id != null ? String(picked.id) : String(picked.url || ''));
  const mine = String(releaseName).toLowerCase();
  const myWeb = /\bweb[-. ]?(dl|rip)?\b|amzn|nf(?=[. ])|hulu|atvp|dsnp/i.test(mine);
  const myBlu = /blu-?ray|bd(rip|remux)?\b|remux/i.test(mine);
  const myGroup = (/-([a-z0-9]+)(?:\.(mkv|mp4|avi))?$/i.exec(mine) || [])[1];
  const myEpisode = episodeKey(mine);
  const myEdition = editionTags(mine);
  const inferredEdition = inferredEditionFromDuration(durationSeconds);
  if (inferredEdition) myEdition.add(inferredEdition);
  const score = (d) => {
    if (!d || !d.url) return -Infinity;
    const rel = `${d.display || ''} ${d.media || ''}`.toLowerCase();
    const relEdition = editionTags(rel);
    const relEpisode = episodeKey(rel);
    let s = 0;
    if (!/^(srt|vtt|)$/i.test(String(d.format || ''))) s -= 500;
    if (myEpisode && relEpisode === myEpisode) s += 260;
    else if (myEpisode && relEpisode) s -= 1000;
    else if (myEpisode) s -= 80;
    if (myGroup && rel.includes(myGroup)) s += 200;
    for (const tag of myEdition) {
      if (relEdition.has(tag)) s += 180;
      else if (relEdition.size) s -= 160;
    }
    if (myWeb && /web|amzn|nf[. ]|hulu|atvp|dsnp/.test(rel)) s += 100;
    if (myBlu && /blu|bd|remux/.test(rel)) s += 100;
    if ((myWeb && /blu|bd|remux/.test(rel)) || (myBlu && /web/.test(rel))) s -= 80;
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
  return ranked;
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
  if (key) u.searchParams.set('key', key);
  // Wyzie scrapes its sources LIVE — measured ~15s on real keys. The default 10s idle
  // timeout was killing searches that were about to succeed.
  const search = (refresh = false) => retryTransient('Wyzie subtitle search', async () => {
    if (refresh) u.searchParams.set('refresh', 'true'); else u.searchParams.delete('refresh');
    const r = await request('GET', u.href, { timeoutMs: 25000, deadlineMs: 35000 });
    if (r.status === 401) throw permanent('Wyzie Subs key missing or invalid');
    if (r.status !== 200) {
      let msg = '';
      try { msg = (JSON.parse(r.body) || {}).message || ''; } catch {}
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
  if (!Array.isArray(data) || !data.length) throw permanent(`no ${lang} subtitles found for "${query}"`);
  const hit = pickSub(data, releaseName, { durationSeconds });
  if (!hit) throw permanent(`no usable ${lang} subtitle file in the results`);
  const file = await retryTransient('Wyzie subtitle download', async () => {
    const r = await request('GET', hit.url, { timeoutMs: 15000, deadlineMs: 25000 });
    if (r.status !== 200) {
      const e = new Error(`subtitle file HTTP ${r.status}`);
      if (![408, 429].includes(r.status) && r.status < 500) e.permanent = true;
      throw e;
    }
    return r;
  }, { attempts, delayMs: retryDelayMs });
  return srtToVtt(file.body);
}

async function searchOnlineSubs({ key, tmdbId, query, lang = 'en', base = DEFAULT_BASE,
  attempts = 2, retryDelayMs = 700 } = {}) {
  if (!tmdbId) throw permanent('online subtitles need a catalog title (no TMDB id for this play)');
  const w = parseQuery(query || '');
  const u = new URL(`${base}/search`);
  u.searchParams.set('id', String(tmdbId));
  if (w.season != null) { u.searchParams.set('season', w.season); u.searchParams.set('episode', w.ep); }
  u.searchParams.set('language', lang);
  u.searchParams.set('format', 'srt,vtt');
  u.searchParams.set('source', 'all');
  if (key) u.searchParams.set('key', key);
  const search = (refresh = false) => retryTransient('Wyzie subtitle search', async () => {
    if (refresh) u.searchParams.set('refresh', 'true'); else u.searchParams.delete('refresh');
    const r = await request('GET', u.href, { timeoutMs: 25000, deadlineMs: 35000 });
    if (r.status === 401) throw permanent('Wyzie Subs key missing or invalid');
    if (r.status !== 200) {
      let msg = '';
      try { msg = (JSON.parse(r.body) || {}).message || ''; } catch {}
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
  if (!Array.isArray(data) || !data.length) throw permanent(`no ${lang} subtitles found for "${query}"`);
  return data;
}
async function downloadSubtitle(hit, { attempts = 2, retryDelayMs = 700 } = {}) {
  const file = await retryTransient('Wyzie subtitle download', async () => {
    const r = await request('GET', hit && hit.url, { timeoutMs: 15000, deadlineMs: 25000 });
    if (r.status !== 200) {
      const e = new Error(`subtitle file HTTP ${r.status}`);
      if (![408, 429].includes(r.status) && r.status < 500) e.permanent = true;
      throw e;
    }
    return r;
  }, { attempts, delayMs: retryDelayMs });
  return srtToVtt(file.body);
}

module.exports = {
  fetchOnlineSub, searchOnlineSubs, downloadSubtitle, rankSubs, srtToVtt, shiftVtt, parseQuery, pickSub,
  _request: request, _isTransientError: isTransientError,
};

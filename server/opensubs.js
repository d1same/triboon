'use strict';
// Wyzie Subs client (sub.wyzie.ru) — free subtitle aggregator: one GET search by TMDB id
// returns DIRECT subtitle-file URLs (no account login, no download quota; a free API key
// comes from store.wyzie.io/redeem). Replaced OpenSubtitles, whose API went paid.
// SRT → WebVTT for the browser <track> element. Stdlib only, like everything in server/.
// This is the CC path that matters in practice: BluRay releases carry only bitmap (PGS)
// subtitles that can never become text tracks, so online subs are how captions actually show.

const https = require('https');
const http = require('http');

const DEFAULT_BASE = 'https://sub.wyzie.io'; // .ru 301s here — skip the (flaky) redirect hop
const UA = 'Triboon v1.0';

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
function pickSub(data, releaseName = '') {
  const mine = String(releaseName).toLowerCase();
  const myWeb = /\bweb[-. ]?(dl|rip)?\b|amzn|nf(?=[. ])|hulu|atvp|dsnp/i.test(mine);
  const myBlu = /blu-?ray|bd(rip|remux)?\b|remux/i.test(mine);
  const myGroup = (/-([a-z0-9]+)(?:\.(mkv|mp4|avi))?$/i.exec(mine) || [])[1];
  const score = (d) => {
    if (!d || !d.url) return -Infinity;
    const rel = `${d.display || ''} ${d.media || ''}`.toLowerCase();
    let s = 0;
    if (!/^(srt|vtt|)$/i.test(String(d.format || ''))) s -= 500; // sub/idx etc. can't become VTT
    if (myGroup && rel.includes(myGroup)) s += 200;              // same release group ≈ frame-exact
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
async function fetchOnlineSub({ key, tmdbId, query, lang = 'en', releaseName = '', base = DEFAULT_BASE }) {
  if (!tmdbId) throw new Error('online subtitles need a catalog title (no TMDB id for this play)');
  const w = parseQuery(query || '');
  const u = new URL(`${base}/search`);
  u.searchParams.set('id', String(tmdbId));
  if (w.season != null) { u.searchParams.set('season', w.season); u.searchParams.set('episode', w.ep); }
  u.searchParams.set('language', lang);
  if (key) u.searchParams.set('key', key);
  // Wyzie scrapes its sources LIVE — measured ~15s on real keys. The default 10s idle
  // timeout was killing searches that were about to succeed.
  const sr = await request('GET', u.href, { timeoutMs: 25000, deadlineMs: 35000 });
  if (sr.status === 401) throw new Error('Wyzie Subs key missing or invalid — claim a free key at store.wyzie.io/redeem (Settings → Catalog)');
  if (sr.status !== 200) {
    let msg = '';
    try { msg = (JSON.parse(sr.body) || {}).message || ''; } catch {}
    throw new Error(msg ? `Wyzie Subs: ${msg}` : `wyzie search HTTP ${sr.status}`);
  }
  let data;
  try { data = JSON.parse(sr.body); } catch { throw new Error('wyzie returned a non-JSON response'); }
  if (!Array.isArray(data) || !data.length) throw new Error(`no ${lang} subtitles found for "${query}"`);
  const hit = pickSub(data, releaseName);
  if (!hit) throw new Error(`no usable ${lang} subtitle file in the results`);
  const file = await request('GET', hit.url, { timeoutMs: 15000 });
  if (file.status !== 200) throw new Error(`subtitle file HTTP ${file.status}`);
  return srtToVtt(file.body);
}

module.exports = { fetchOnlineSub, srtToVtt, parseQuery, pickSub, _request: request };

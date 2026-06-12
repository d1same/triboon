'use strict';
// Newznab/Prowlarr/NZBHydra client + parallel fan-out. Plain stdlib http(s); every indexer
// gets a hard timeout budget (speed rule: a slow indexer never delays the pipeline), results
// are normalized and deduped by normalized-title + size window.

const http = require('http');
const https = require('https');

// timeoutMs = idle timeout; deadlineMs = HARD total budget (a steadily-trickling download
// never idles, so without a deadline a 30MB NZB can stall the pipeline for half a minute).
// The deadline and hop budget are SHARED across redirects so a redirect chain can't reset the
// clock or loop forever — both directly protect the press-play speed guarantee.
function fetchUrl(url, opts = {}) {
  const { timeoutMs = 5000, deadlineMs = 30000, headers = {}, maxBytes = 64 * 1024 * 1024 } = opts;
  const deadlineAt = opts._deadlineAt || (Date.now() + deadlineMs);
  const hops = opts._hops || 0;
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error(`too many redirects: ${url.split('?')[0]}`));
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return reject(new Error(`deadline exceeded: ${url.split('?')[0]}`));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Triboon/1.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); clearTimeout(deadline);
        const next = new URL(res.headers.location, url).href;
        return fetchUrl(next, { timeoutMs, headers, maxBytes, _deadlineAt: deadlineAt, _hops: hops + 1 }).then(resolve, reject);
      }
      // Response-size cap: a hostile/broken upstream must not be able to balloon memory.
      const chunks = []; let len = 0;
      res.on('data', (c) => {
        len += c.length;
        if (len > maxBytes) { clearTimeout(deadline); req.destroy(new Error(`response too large (>${maxBytes} bytes): ${url.split('?')[0]}`)); }
        else chunks.push(c);
      });
      res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, body: Buffer.concat(chunks) }); });
    });
    const deadline = setTimeout(() => req.destroy(new Error(`deadline after ${deadlineMs}ms: ${url.split('?')[0]}`)), remaining);
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url.split('?')[0]}`)));
  });
}

function attr(block, name) {
  const m = new RegExp(`<newznab:attr[^>]*name="${name}"[^>]*value="([^"]*)"`, 'i').exec(block);
  return m ? m[1] : null;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
}

function parseNewznabRss(xml, indexerName) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = decodeEntities(((/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(b) || [])[1] || '').trim());
    // url= and length= regexes both allow attributes in any order via [^>]*, so enclosure
    // attribute ordering doesn't matter.
    let url = (/<enclosure[^>]*url="([^"]+)"/.exec(b) || [])[1] || (/<link>([^<]+)<\/link>/.exec(b) || [])[1];
    const size = +((/<enclosure[^>]*length="(\d+)"/.exec(b) || [])[1] || attr(b, 'size') || 0);
    const pubDate = (/<pubDate>([^<]+)<\/pubDate>/.exec(b) || [])[1] || null;
    if (!title || !url) continue;
    url = decodeEntities(url);
    items.push({
      name: title, sizeBytes: size, nzbUrl: url, indexer: indexerName,
      pubDate, imdb: attr(b, 'imdbid') || attr(b, 'imdb'), tvdbid: attr(b, 'tvdbid'),
    });
  }
  return items;
}

// One indexer search. params: { q, imdbid, tvdbid, season, ep, cat, limit }
async function searchIndexer(indexer, params, { timeoutMs = 2000 } = {}) {
  const base = indexer.url.replace(/\/+$/, '');
  const u = new URL(base.endsWith('/api') ? base : `${base}/api`);
  u.searchParams.set('apikey', indexer.apikey || '');
  u.searchParams.set('t', params.imdbid ? 'movie' : params.tvdbid ? 'tvsearch' : 'search');
  if (params.q) u.searchParams.set('q', params.q);
  if (params.imdbid) u.searchParams.set('imdbid', String(params.imdbid).replace(/^tt/, ''));
  if (params.tvdbid) u.searchParams.set('tvdbid', params.tvdbid);
  if (params.season != null) u.searchParams.set('season', params.season);
  if (params.ep != null) u.searchParams.set('ep', params.ep);
  if (params.cat) u.searchParams.set('cat', params.cat);
  // 100 (most indexers' max): the default sort is recency, so a tight limit silently
  // drops older releases — every big BluRay remux of a 15-year-old film, for instance.
  u.searchParams.set('limit', params.limit || 100);
  const r = await fetchUrl(u.href, { timeoutMs, deadlineMs: timeoutMs * 3 }); // hard per-indexer budget
  if (r.status !== 200) throw new Error(`${indexer.name}: HTTP ${r.status}`);
  return parseNewznabRss(r.body.toString('utf8'), indexer.name);
}

function normTitle(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

// Dedupe: same normalized title AND size within 2% window → keep the first (indexer order).
function dedupe(results) {
  const out = [];
  for (const r of results) {
    const key = normTitle(r.name);
    const dup = out.find((o) => normTitle(o.name) === key &&
      (!r.sizeBytes || !o.sizeBytes || Math.abs(o.sizeBytes - r.sizeBytes) <= Math.max(o.sizeBytes, r.sizeBytes) * 0.02));
    if (!dup) out.push(r);
  }
  return out;
}

// Parallel fan-out with per-indexer budget; indexer failures never fail the search.
async function fanout(indexers, params, { timeoutMs = 2000 } = {}) {
  const settled = await Promise.allSettled(
    indexers.map((ix) => searchIndexer(ix, params, { timeoutMs }))
  );
  const errors = [];
  const merged = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') merged.push(...s.value);
    else errors.push({ indexer: indexers[i].name, error: s.reason.message });
  });
  return { results: dedupe(merged), errors };
}

module.exports = { searchIndexer, fanout, dedupe, parseNewznabRss, fetchUrl, normTitle };

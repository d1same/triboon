'use strict';
// Audiobook metadata provider. Free, no API key: search hits Audible's public catalog API for
// ASINs + basic fields, then rich detail (cover, narrator, series, chapters, rating) comes from
// Audnexus (the same free service Audiobookshelf uses). Server-side proxy + cache in the store,
// mirroring tmdb.js: clients call /api/audible/* and never see upstream directly, GET responses are
// cached with a TTL so browsing is instant. Zero runtime deps — plain HTTPS via newznab.fetchUrl.

const { fetchUrl } = require('./newznab');

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000; // book/chapter data is effectively immutable
const SEARCH_TTL_MS = 6 * 3600 * 1000;       // search results churn slowly but do change

// Audible marketplace by region. Search uses the regional Audible API host; Audnexus takes the
// region as a query param. Keep the two in lockstep so a UK ASIN is looked up on the UK catalog.
const REGIONS = {
  us: 'api.audible.com',
  ca: 'api.audible.ca',
  uk: 'api.audible.co.uk',
  au: 'api.audible.com.au',
  fr: 'api.audible.fr',
  de: 'api.audible.de',
  jp: 'api.audible.co.jp',
  it: 'api.audible.it',
  in: 'api.audible.in',
  es: 'api.audible.es',
};
const DEFAULT_REGION = 'us';

// ASINs are 10 chars, uppercase alphanumeric (Audible book ASINs start with B). Validating before
// we ever build an upstream URL keeps a hostile client from smuggling a path/host into the request.
const ASIN_RE = /^[A-Z0-9]{10}$/;

function normRegion(region) {
  const r = String(region || '').toLowerCase();
  return REGIONS[r] ? r : DEFAULT_REGION;
}

// Pick the largest square cover from Audible's product_images map ({ "500": url, "1024": url }).
function pickCover(images) {
  if (!images || typeof images !== 'object') return null;
  const sizes = Object.keys(images).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
  for (const s of sizes) { const u = images[String(s)]; if (u) return String(u); }
  return null;
}

function nameList(arr) {
  return Array.isArray(arr) ? arr.map((x) => (x && x.name ? String(x.name) : '')).filter(Boolean) : [];
}

function seriesOf(product) {
  const s = Array.isArray(product && product.series) && product.series[0];
  if (!s) return null;
  return { name: s.title ? String(s.title) : '', position: s.sequence != null ? String(s.sequence) : '' };
}

// Normalize one Audible catalog product to the shape the UI/pipeline consumes.
function normProduct(p) {
  if (!p || !p.asin) return null;
  return {
    asin: String(p.asin),
    title: p.title ? String(p.title) : '',
    subtitle: p.subtitle ? String(p.subtitle) : '',
    authors: nameList(p.authors),
    narrators: nameList(p.narrators),
    cover: pickCover(p.product_images),
    series: seriesOf(p),
    runtimeMin: Number(p.runtime_length_min) || null,
    releaseDate: p.release_date ? String(p.release_date) : null,
    language: p.language ? String(p.language) : null,
  };
}

// Normalize an Audnexus book record (richer than the catalog product).
function normBook(b) {
  if (!b || !b.asin) return null;
  const series = b.seriesPrimary && b.seriesPrimary.name
    ? { name: String(b.seriesPrimary.name), position: b.seriesPrimary.position != null ? String(b.seriesPrimary.position) : '' }
    : null;
  return {
    asin: String(b.asin),
    title: b.title ? String(b.title) : '',
    subtitle: b.subtitle ? String(b.subtitle) : '',
    authors: nameList(b.authors),
    narrators: nameList(b.narrators),
    cover: b.image ? String(b.image) : null,
    description: b.description ? String(b.description) : (b.summary ? String(b.summary) : ''),
    genres: Array.isArray(b.genres) ? b.genres.map((g) => (g && g.name ? String(g.name) : '')).filter(Boolean) : [],
    series,
    rating: b.rating != null && b.rating !== '' ? Number(b.rating) : null,
    runtimeMin: Number(b.runtimeLengthMin) || null,
    releaseDate: b.releaseDate ? String(b.releaseDate) : null,
    publisher: b.publisherName ? String(b.publisherName) : null,
    language: b.language ? String(b.language) : null,
  };
}

// Normalize Audnexus chapters into { title, startMs, lengthMs } sorted by start. isAccurate flags
// whether the timestamps are Audible-derived (accurate) vs. evenly-split fallbacks.
function normChapters(c) {
  if (!c || !Array.isArray(c.chapters)) return null;
  const chapters = c.chapters
    .map((ch) => ({
      title: ch && ch.title ? String(ch.title) : '',
      startMs: Number(ch && ch.startOffsetMs) || 0,
      lengthMs: Number(ch && ch.lengthMs) || 0,
    }))
    .sort((a, b) => a.startMs - b.startMs);
  return {
    chapters,
    runtimeMs: Number(c.runtimeLengthMs) || null,
    isAccurate: c.isAccurate !== false,
    brandIntroMs: Number(c.brandIntroDurationMs) || 0,
    brandOutroMs: Number(c.brandOutroDurationMs) || 0,
  };
}

class AudibleProxy {
  // audibleBase/audnexBase injectable (full origin, e.g. http://127.0.0.1:port) so tests can point
  // at a local mock, like tmdb.js's baseUrl. audibleBase overrides the per-region host when set.
  constructor(store, opts = {}) {
    this.store = store;
    this.audibleBase = opts.audibleBase || null; // full origin override (test hook)
    this.audnexBase = opts.audnexBase || 'https://api.audnex.us';
    this.timeoutMs = opts.timeoutMs || 8000;
  }

  _cacheGet(table, key, ttl) {
    const cache = this.store.read(table, {});
    const hit = cache[key];
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    return null;
  }

  _cacheSet(table, key, data, cap = 500) {
    this.store.update(table, {}, (c) => {
      c[key] = { at: Date.now(), data };
      const keys = Object.keys(c);
      if (keys.length > cap) for (const k of keys.slice(0, keys.length - Math.floor(cap * 0.8))) delete c[k];
      return c;
    });
  }

  _audibleBaseFor(region) {
    return this.audibleBase || `https://${REGIONS[region] || REGIONS[DEFAULT_REGION]}`;
  }

  async _getJson(url) {
    const r = await fetchUrl(url, { timeoutMs: this.timeoutMs, deadlineMs: this.timeoutMs + 4000 });
    if (r.status === 404) { const e = new Error('not found'); e.status = 404; throw e; }
    if (r.status !== 200) { const e = new Error(`audiobook upstream ${r.status}`); e.status = 502; throw e; }
    try { return JSON.parse(r.body.toString('utf8')); }
    catch { const e = new Error('audiobook upstream returned non-JSON'); e.status = 502; throw e; }
  }

  // Free-text search → normalized product list. Region selects the Audible marketplace.
  async search(query, region = DEFAULT_REGION) {
    const q = String(query || '').trim();
    if (!q) return [];
    region = normRegion(region);
    const cacheKey = `${region}:${q.toLowerCase()}`;
    const cached = this._cacheGet('audible-search', cacheKey, SEARCH_TTL_MS);
    if (cached) return cached;

    const u = new URL(`${this._audibleBaseFor(region)}/1.0/catalog/products`);
    u.searchParams.set('response_groups', 'contributors,product_desc,product_attrs,media,series');
    u.searchParams.set('num_results', '25');
    u.searchParams.set('products_sort_by', 'Relevance');
    u.searchParams.set('keywords', q);
    const data = await this._getJson(u.href);
    const products = Array.isArray(data && data.products) ? data.products : [];
    // Audible catalog carries podcasts/other content types too; keep audiobook-shaped items (have a
    // runtime and at least an author) so the section stays books, not a mixed feed.
    const out = products.map(normProduct).filter((p) => p && p.title && (p.authors.length || p.runtimeMin));
    this._cacheSet('audible-search', cacheKey, out);
    return out;
  }

  // Browse the catalog for discovery rows (no keyword) — by sort (BestSellers / -ReleaseDate) and
  // optional genre category. Cached with the short TTL. sort is validated by the caller.
  async browse({ sort = 'BestSellers', categoryId = null, region = DEFAULT_REGION, num = 20 } = {}) {
    region = normRegion(region);
    const cat = categoryId ? String(categoryId).replace(/[^0-9]/g, '') : '';
    const n = Math.max(1, Math.min(50, Number(num) || 20));
    const cacheKey = `${region}:${sort}:${cat || 'all'}:${n}`;
    const cached = this._cacheGet('audible-browse', cacheKey, SEARCH_TTL_MS);
    if (cached) return cached;
    const u = new URL(`${this._audibleBaseFor(region)}/1.0/catalog/products`);
    u.searchParams.set('response_groups', 'contributors,product_desc,product_attrs,media,series');
    u.searchParams.set('num_results', String(n));
    u.searchParams.set('products_sort_by', sort);
    if (cat) u.searchParams.set('category_id', cat);
    const data = await this._getJson(u.href);
    const products = Array.isArray(data && data.products) ? data.products : [];
    const out = products.map(normProduct).filter((p) => p && p.title && (p.authors.length || p.runtimeMin));
    this._cacheSet('audible-browse', cacheKey, out);
    return out;
  }

  // The REAL Audible best-seller charts (audible.com/charts/best). The catalog's BestSellers sort
  // returns a niche-heavy mix; the charts page is the genuine ranked list. Scrape its ASINs (1 fetch)
  // then batch-enrich metadata (1 call), preserving chart order. Cached ~6h; caller falls back to
  // browse() if this returns empty (page markup changes / region without a charts page).
  async charts(region = DEFAULT_REGION) {
    region = normRegion(region);
    const cached = this._cacheGet('audible-charts', region, 6 * 3600 * 1000);
    if (cached) return cached;
    const TLD = { us: 'com', uk: 'co.uk', ca: 'ca', au: 'com.au', fr: 'fr', de: 'de', jp: 'co.jp', it: 'it', in: 'in', es: 'es' };
    let out = [];
    try {
      const chartsUrl = this.chartsBase || `https://www.audible.${TLD[region] || 'com'}/charts/best`;
      const r = await fetchUrl(chartsUrl, { timeoutMs: this.timeoutMs, deadlineMs: this.timeoutMs + 6000, maxBytes: 6 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = r.status === 200 ? r.body.toString('utf8') : '';
      const asins = [...new Set([...html.matchAll(/\/pd\/[^"?]*\/([A-Z0-9]{10})/g)].map((m) => m[1]))].slice(0, 20);
      if (asins.length) {
        const u = new URL(`${this._audibleBaseFor(region)}/1.0/catalog/products`);
        u.searchParams.set('asins', asins.join(','));
        u.searchParams.set('response_groups', 'contributors,product_desc,product_attrs,media,series');
        const data = await this._getJson(u.href);
        const byAsin = new Map((data.products || []).map((p) => [String(p.asin), normProduct(p)]));
        out = asins.map((a) => byAsin.get(a)).filter((p) => p && p.title && (p.authors.length || p.runtimeMin));
      }
    } catch {}
    if (out.length) this._cacheSet('audible-charts', region, out);
    return out;
  }

  // Rich detail by ASIN via Audnexus.
  async book(asin, region = DEFAULT_REGION) {
    asin = String(asin || '').toUpperCase();
    if (!ASIN_RE.test(asin)) { const e = new Error('bad asin'); e.status = 400; throw e; }
    region = normRegion(region);
    const cacheKey = `${region}:${asin}`;
    const cached = this._cacheGet('audible-book', cacheKey, DEFAULT_TTL_MS);
    if (cached) return cached;
    const u = new URL(`${this.audnexBase}/books/${asin}`);
    u.searchParams.set('region', region);
    const data = await this._getJson(u.href);
    const out = normBook(data);
    if (!out) { const e = new Error('not found'); e.status = 404; throw e; }
    this._cacheSet('audible-book', cacheKey, out);
    return out;
  }

  // Chapter list by ASIN via Audnexus. Returns null (not an error) when the book has no chapter data
  // so the caller can fall back to file-embedded chapters without treating it as a failure.
  async chapters(asin, region = DEFAULT_REGION) {
    asin = String(asin || '').toUpperCase();
    if (!ASIN_RE.test(asin)) { const e = new Error('bad asin'); e.status = 400; throw e; }
    region = normRegion(region);
    const cacheKey = `${region}:${asin}`;
    const cached = this._cacheGet('audible-chapters', cacheKey, DEFAULT_TTL_MS);
    if (cached) return cached;
    const u = new URL(`${this.audnexBase}/books/${asin}/chapters`);
    u.searchParams.set('region', region);
    let data;
    try { data = await this._getJson(u.href); }
    catch (e) { if (e && e.status === 404) return null; throw e; }
    const out = normChapters(data);
    if (out) this._cacheSet('audible-chapters', cacheKey, out);
    return out;
  }
}

module.exports = {
  AudibleProxy, REGIONS, DEFAULT_REGION, ASIN_RE,
  normRegion, normProduct, normBook, normChapters, pickCover,
};

'use strict';
// TMDB server-side proxy + cache. The admin's key lives in encrypted settings; clients call
// /api/tmdb/* and never see it. GET responses cached in the store with a TTL so browsing is
// instant and TMDB rate limits never hit the living room.

const { fetchUrl } = require('./newznab');

const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const SHORT_TTL_MS = 3 * 3600 * 1000; // trending/search churn faster

class TmdbProxy {
  constructor(store, getKey, baseUrl = 'https://api.themoviedb.org/3') {
    this.store = store;
    this.getKey = getKey;       // () => api key | null
    this.baseUrl = baseUrl;     // injectable for tests
  }

  _ttlFor(path) {
    return /trending|search|popular|now_playing|on_the_air/.test(path) ? SHORT_TTL_MS : DEFAULT_TTL_MS;
  }

  // TMDB serves a 200 external_ids body even for an episode/title whose imdb_id isn't populated yet
  // (common right after a show is added, e.g. a just-released season). Caching that empty for the
  // 24h DEFAULT_TTL_MS pins a no-show-imdb title into "no subtitles": the /api/ossubs episode-imdb
  // resolution reads the cached empty imdb_id and dead-ends on the tmdb-tv id. So treat an
  // external_ids response with no usable imdb_id as NON-cacheable — ignore it on read and never
  // write it — so the next lookup re-fetches live and self-heals the moment TMDB populates the id.
  _externalIdsEmpty(path, data) {
    return /\/external_ids(\?|$)/.test(path)
      && !(data && /^tt\d{5,10}$/i.test(String(data.imdb_id || '')));
  }

  // path: "/trending/all/week?page=1" (no api_key — we add it server-side)
  async get(path) {
    const key = this.getKey();
    if (!key) { const e = new Error('TMDB not configured'); e.status = 503; throw e; }
    if (!/^\/[a-z0-9_/-]+(\?[a-zA-Z0-9_=&%.,-]*)?$/i.test(path)) {
      const e = new Error('bad tmdb path'); e.status = 400; throw e;
    }
    const cacheKey = path;
    const cache = this.store.read('tmdb-cache', {});
    const hit = cache[cacheKey];
    // A stale empty external_ids must never be served (it would keep a no-show-imdb title dead-ended
    // for the full TTL even after TMDB populates the id) — fall through to a live re-fetch instead.
    if (hit && Date.now() - hit.at < this._ttlFor(path) && !this._externalIdsEmpty(path, hit.data)) return hit.data;

    const sep = path.includes('?') ? '&' : '?';
    const r = await fetchUrl(`${this.baseUrl}${path}${sep}api_key=${key}`, { timeoutMs: 8000 });
    if (r.status !== 200) { const e = new Error(`tmdb upstream ${r.status}`); e.status = 502; throw e; }
    let data;
    try { data = JSON.parse(r.body.toString('utf8')); }
    catch { const e = new Error('tmdb upstream returned non-JSON'); e.status = 502; throw e; }
    if (!this._externalIdsEmpty(path, data)) {
      this.store.update('tmdb-cache', {}, (c) => {
        c[cacheKey] = { at: Date.now(), data };
        // Light eviction: keep the cache bounded.
        const keys = Object.keys(c);
        if (keys.length > 500) for (const k of keys.slice(0, keys.length - 400)) delete c[k];
        return c;
      });
    }
    return data;
  }
}

module.exports = { TmdbProxy };

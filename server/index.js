'use strict';
// Triboon server. SECURITY MODEL: deny-by-default routing — every endpoint lives in ROUTES
// and declares its auth level (public | user | admin | stream); anything not in the table is
// a 404, and the route-coverage test (test/security.test.js) enforces the declaration.
// Stream auth uses signed expiring query tokens so VLC/ExoPlayer/<video> can play URLs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { NntpPool, NntpConnection } = require('./nntp');
const { mountNzb } = require('./archive');
const { Store, VerdictCache } = require('./store');
const { Auth, SecureSettings, RateLimiter } = require('./auth');
const { Pipeline } = require('./pipeline');
const { TmdbProxy } = require('./tmdb');
const { Trakt } = require('./trakt');
const { detectFfmpeg, detectFfprobe, detectEncoder, decidePlayback, probeTracks, spawnRemux, spawnTranscode, spawnLiveRemux, spawnSubtitleExtract, makeThumb, LADDER, audioCopyOk } = require('./transcode');
const ytmusic = require('./ytmusic');
const https = require('https');

const PORT = parseInt(process.env.PORT || '7777', 10);
const WEB_DIR = path.join(__dirname, '..', 'web');

// ---------- state ----------
const store = new Store();
const auth = new Auth(store, process.env.TRIBOON_SECRET);
const settings = new SecureSettings(store, auth.secret);
const verdicts = new VerdictCache(store);
const mounts = new Map(); // id -> virtual file
const scanStates = new Map(); // library id -> { running, startedAt, progress, ...summary }
const thumbJobs = new Map(); // thumb path -> in-flight generation promise (no double-spawn)
const DATA_DIR = process.env.TRIBOON_DATA || path.join(__dirname, '..', 'data');

function envProvider() {
  if (!process.env.NNTP_HOST) return null;
  return {
    host: process.env.NNTP_HOST,
    port: parseInt(process.env.NNTP_PORT || '563', 10),
    tls: (process.env.NNTP_TLS || 'true') === 'true',
    user: process.env.NNTP_USER || '',
    pass: process.env.NNTP_PASS || '',
    connections: parseInt(process.env.NNTP_CONNECTIONS || '16', 10),
  };
}
function providerList() {
  const s = settings.get();
  const list = (s.providers && s.providers.length) ? s.providers : [envProvider()].filter(Boolean);
  return list;
}

let pool = null, poolKey = '';
function getPool() {
  const list = providerList();
  if (!list.length) { const e = new Error('no usenet provider configured'); e.status = 409; throw e; }
  const key = JSON.stringify(list.map((p) => [p.host, p.port, p.user]));
  if (pool && poolKey === key) return pool;
  if (pool) pool.close();
  poolKey = key;
  pool = new NntpPool(list, Math.max(...list.map((p) => p.connections || 16)));
  pool.warm(4); // first play shouldn't pay the cold TLS+AUTH wall
  return pool;
}

// Admin "max release size" caps. ONLY manual mode hard-hides releases — hiding must be an
// explicit admin decision. auto (default) applies NO hard cap: the press-play size shaping
// in scoring.js already keeps oversized releases from winning auto-pick, but they stay
// findable in Sources. (The old auto mode invented caps from connection count and silently
// hid every 50GB+ remux — "I can't find any big 4K movies" with nothing to explain why.)
function sizeCaps() {
  const s = settings.get();
  if ((s.sizeCapMode || 'auto') !== 'manual') return {};
  return {
    maxSizeGb4k: Number(s.sizeCap4kGb) > 0 ? Number(s.sizeCap4kGb) : undefined,
    maxSizeGb1080: Number(s.sizeCap1080Gb) > 0 ? Number(s.sizeCap1080Gb) : undefined,
  };
}

// Admin scoring tweaks (TRaSH-style custom-formats lite): custom group tiers override the
// built-in tiers; keyword=score pairs extend the weights. Empty settings = pure defaults.
function scoringPrefs() {
  const s = settings.get();
  const t = s.scoringGroupsTrusted || [], av = s.scoringGroupsAvoid || [], kw = s.scoringKeywords || [];
  if (!t.length && !av.length && !kw.length) return {};
  return { customScoring: { groupsTrusted: t, groupsAvoid: av, keywords: kw } };
}

// ---- per-indexer daily usage (API hits + NZB grabs) for admin-set limits ----
const todayKey = () => new Date().toISOString().slice(0, 10);
function ixUsageToday() {
  const u = store.read('ixusage', { date: null, byIndexer: {} });
  return u.date === todayKey() ? u : { date: todayKey(), byIndexer: {} };
}
function bumpIxUsage(name, field) {
  if (!name) return;
  store.update('ixusage', { date: null, byIndexer: {} }, (u) => {
    if (u.date !== todayKey()) { u.date = todayKey(); u.byIndexer = {}; } // midnight rollover
    const e = (u.byIndexer[name] = u.byIndexer[name] || { api: 0, grabs: 0 });
    e[field]++;
    return u;
  });
}
const ixByName = (name) => (settings.get().indexers || []).find((i) => i.name === name) || {};

const pipeline = new Pipeline({
  pool: getPool, verdicts, mounts,
  // API-exhausted indexers drop out of the fan-out for the rest of the day. If EVERY indexer
  // is exhausted, say so honestly instead of the generic "no indexers configured".
  indexers: () => {
    const all = settings.get().indexers || [];
    const usable = all.filter((ix) => {
      if (!ix.apiDayLimit) return true;
      const u = ixUsageToday().byIndexer[ix.name];
      return !u || u.api < ix.apiDayLimit;
    });
    if (all.length && !usable.length) {
      const e = new Error('every indexer has hit its daily API limit — resets at midnight');
      e.status = 429; throw e;
    }
    return usable;
  },
  usage: {
    onSearch: (name) => bumpIxUsage(name, 'api'),
    canGrab: (name) => {
      const lim = ixByName(name).grabDayLimit;
      if (!lim) return true;
      const u = ixUsageToday().byIndexer[name];
      return !u || u.grabs < lim;
    },
    onGrab: (name) => bumpIxUsage(name, 'grabs'),
  },
});
const { fetchUrl: fetchUrlExt, searchIndexer } = require('./newznab');
const {
  fetchOnlineSub, searchOnlineSubs, downloadSubtitle, rankSubs, shiftVtt,
  _isTransientError: isTransientSubError,
} = require('./opensubs');
const IPTV_CACHE_TTL_MS = 24 * 3600000;
const EPG_CACHE_TTL_MS = 24 * 3600000;
const EPG_CACHE_STALE_MS = 7 * 24 * 3600000;
const IPTV_WARM_DELAY_MS = 1500;
const IPTV_WARM_XTREAM_GUIDE_MAX = 96;
let iptvCache = { key: null, at: 0, channels: [] };
let epgCache = { key: null, at: 0, byChannel: new Map(), byName: new Map() };
let xtreamEpgCache = { key: null, byStream: new Map() };
const idHash = (s) => require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Channels from either source, normalized: { idx, id (stable), name, logo, group, tvgId, url (secret) }.
// Xtream channel URL is derived from settings — the DISK cache stores channels WITHOUT it
// (credentials stay encrypted-at-rest in settings only) and rebuilds it on read.
function xtUrlFor(s, streamId) {
  const base = String(s.xtHost || '').replace(/\/+$/, '');
  return `${base}/live/${encodeURIComponent(s.xtUser || '')}/${encodeURIComponent(s.xtPass || '')}/${streamId}.m3u8`;
}
function iptvNativeMime(url) {
  const u = String(url || '').toLowerCase();
  if (/\.m3u8(?:[?#]|$)/.test(u)) return 'application/x-mpegURL';
  if (/\.(?:ts|mpegts)(?:[?#]|$)/.test(u)) return 'video/mp2t';
  return '';
}
let iptvRefreshing = false;
let iptvWarmRunning = false;
let iptvWarmTimer = null;
let iptvWarmSoonTimer = null;
function iptvSourceKey(s) {
  return s.iptvMode === 'xtream' ? `xt:${s.xtHost}:${s.xtUser}` : `m3u:${s.iptvUrl}`;
}
function iptvConfigured(s) {
  return !!((s.iptvMode === 'xtream' && s.xtHost) || s.iptvUrl);
}
function epgSourceKey(s) {
  return idHash(`${iptvSourceKey(s)}|epg:${s.epgUrl || ''}`);
}
async function loadIptvChannels() {
  const s = settings.get();
  const key = iptvSourceKey(s);
  if (iptvCache.key === key && Date.now() - iptvCache.at < IPTV_CACHE_TTL_MS) return iptvCache.channels;
  // STALE-WHILE-REVALIDATE (TiviMate model): once we have ANY playlist for this source,
  // no user ever waits on the panel again — serve it instantly and refresh in the background.
  if (iptvCache.key === key && iptvCache.channels.length) {
    if (!iptvRefreshing) {
      iptvRefreshing = true;
      fetchIptvChannels(s, key)
        .catch((e) => { console.error('[iptv refresh]', e.message); iptvCache.at = Date.now() - (IPTV_CACHE_TTL_MS - 600000); }) // retry in ~10min
        .finally(() => { iptvRefreshing = false; });
    }
    return iptvCache.channels;
  }
  try {
    return await fetchIptvChannels(s, key);
  } catch (e) {
    // Panel down or rate-limiting (Xtream panels ban bursty playlist fetches — e.g. a few
    // server restarts in a row): serve the last good playlist from disk instead of a dead
    // page. Goes stale-but-working until the panel answers again.
    const disk = store.read('iptvcache', null);
    if (s.iptvMode === 'xtream' && disk && disk.key === key && Array.isArray(disk.channels) && disk.channels.length) {
      console.error(`[iptv] source failed (${e.message}) — serving the last cached playlist (${disk.channels.length} channels)`);
      const channels = disk.channels.map((c) => ({ ...c, url: xtUrlFor(s, c.xtreamId) }));
      iptvCache = { key, at: Date.now() - (IPTV_CACHE_TTL_MS - 600000), channels }; // near-stale: retry in ~10min
      return channels;
    }
    throw e;
  }
}
async function fetchIptvChannels(s, key) {
  if (iptvCache.key !== key) xtreamEpgCache = { key: null, byStream: new Map() };
  let channels = [];
  if (s.iptvMode === 'xtream' && s.xtHost) {
    const base = String(s.xtHost).replace(/\/+$/, '');
    const apiBase = `${base}/player_api.php?username=${encodeURIComponent(s.xtUser || '')}&password=${encodeURIComponent(s.xtPass || '')}`;
    const [catsR, streamsR] = await Promise.all([
      fetchUrlExt(`${apiBase}&action=get_live_categories`, { timeoutMs: 10000, deadlineMs: 25000, maxBytes: 5 * 1024 * 1024 }),
      fetchUrlExt(`${apiBase}&action=get_live_streams`, { timeoutMs: 10000, deadlineMs: 40000, maxBytes: 30 * 1024 * 1024 }),
    ]);
    let cats, streams; // hostile/broken JSON → a clean error, not an opaque parse throw
    try {
      cats = Object.fromEntries((JSON.parse(catsR.body.toString('utf8') || '[]') || []).map((c) => [String(c.category_id), c.category_name]));
      streams = JSON.parse(streamsR.body.toString('utf8') || '[]') || [];
    } catch { throw new Error('xtream returned invalid JSON (check host/credentials)'); }
    channels = streams.slice(0, 20000).map((x, i) => ({
      idx: i, id: 'xt' + x.stream_id, name: x.name || 'Channel ' + x.stream_id,
      logo: x.stream_icon || '', group: cats[String(x.category_id)] || 'Other',
      tvgId: x.epg_channel_id || '', xtreamId: x.stream_id,
      url: `${base}/live/${encodeURIComponent(s.xtUser || '')}/${encodeURIComponent(s.xtPass || '')}/${x.stream_id}.m3u8`,
    }));
  } else if (s.iptvUrl) {
    // Real-world playlists run to tens of thousands of channels — the UI renders groups
    // lazily, so a high cap is fine; the byte cap is the actual DoS guard.
    const r = await fetchUrlExt(s.iptvUrl, { timeoutMs: 15000, deadlineMs: 60000, maxBytes: 50 * 1024 * 1024 });
    const lines = r.body.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length && channels.length < 20000; i++) {
      if (!lines[i].startsWith('#EXTINF')) continue;
      const meta = lines[i];
      const name = (meta.split(',').pop() || '').trim();
      const logo = (/tvg-logo="([^"]*)"/.exec(meta) || [])[1] || '';
      const group = (/group-title="([^"]*)"/.exec(meta) || [])[1] || 'Other';
      const tvgId = (/tvg-id="([^"]*)"/.exec(meta) || [])[1] || '';
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      const streamUrl = (lines[j] || '').trim();
      if (name && /^https?:\/\//.test(streamUrl)) {
        channels.push({ idx: channels.length, id: idHash(streamUrl), name, logo, group, tvgId, url: streamUrl });
      }
    }
  }
  iptvCache = { key, at: Date.now(), channels };
  // Persist Xtream playlists for restart survival — WITHOUT the credential-bearing url
  // (rebuilt from encrypted settings on read). M3U playlists may embed third-party tokens
  // in every line, so those stay memory-only.
  if (s.iptvMode === 'xtream') {
    try { store.write('iptvcache', { key, at: Date.now(), channels: channels.map(({ url: _u, ...c }) => c) }); } catch {}
  }
  return channels;
}

// XMLTV: fetch + parse <programme> entries for channels we actually carry (capped ~40MB).
function parseXmltvDate(s) { // "20260611043000 +0000"
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/.exec(String(s || ''));
  if (!m) return 0;
  const off = m[7] ? (parseInt(m[7].slice(0, 3), 10) * 60 + parseInt(m[7][0] + m[7].slice(3), 10)) * 60000 : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off;
}
// Channel names normalized for guide matching: "UK: BBC One [1080p] HD" ≈ "BBC One".
function normChName(s) {
  return String(s || '').toLowerCase()
    .replace(/^[a-z]{2,3}\s*[:|-]\s*/, '')                        // country prefix "UK: "
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')                         // [1080p] (Events)
    .replace(/\b(uhd|fhd|hd|sd|4k|8k|1080p?|720p?|h26[45]|hevc|raw|vip|plus|backup)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}
function hydrateXmltvCache(raw, key) {
  if (!raw || raw.key !== key || !Array.isArray(raw.byChannel) || !Array.isArray(raw.byName)) return null;
  const at = Number(raw.at) || 0;
  if (!at || Date.now() - at > EPG_CACHE_STALE_MS) return null;
  const byChannel = new Map(raw.byChannel.map(([id, list]) => [String(id), Array.isArray(list) ? list : []]));
  const byName = new Map(raw.byName.map(([name, id]) => [String(name), String(id)]));
  return { key, at, byChannel, byName };
}
function persistXmltvCache(cache) {
  try {
    store.write('epgcache', {
      key: cache.key,
      at: cache.at,
      byChannel: [...cache.byChannel.entries()],
      byName: [...cache.byName.entries()],
    });
  } catch {}
}
function refreshXmltvInBackground(s, key) {
  if (epgRefreshing) return;
  epgRefreshing = true;
  fetchXmltv(s, key).catch((e) => console.error('[xmltv refresh]', e.message))
    .finally(() => { epgRefreshing = false; });
}
async function ensureXmltv() {
  const s = settings.get();
  if (!s.epgUrl) return null;
  const key = epgSourceKey(s);
  if (epgCache.key === key && Date.now() - epgCache.at < EPG_CACHE_TTL_MS) return epgCache;
  if (epgCache.key === key && epgCache.byChannel && epgCache.byChannel.size) {
    refreshXmltvInBackground(s, key);
    return epgCache;
  }
  const disk = hydrateXmltvCache(store.read('epgcache', null), key);
  if (disk && disk.byChannel.size) {
    epgCache = disk;
    if (Date.now() - disk.at >= EPG_CACHE_TTL_MS) refreshXmltvInBackground(s, key);
    return epgCache;
  }
  return fetchXmltv(s, key);
}
let epgRefreshing = false;
async function fetchXmltv(s, key = epgSourceKey(s)) {
  const r = await fetchUrlExt(s.epgUrl, { timeoutMs: 20000, deadlineMs: 90000, maxBytes: 48 * 1024 * 1024 });
  let xml = r.body;
  if (xml.length > 40 * 1024 * 1024) xml = xml.subarray(0, 40 * 1024 * 1024); // parse cap
  const text = xml.toString('utf8');
  const keepFrom = Date.now() - 12 * 3600000;
  const keepTo = Date.now() + 48 * 3600000;
  // Pass 1 — <channel> display-names: many playlists have no/poor tvg-ids, so the guide is
  // ALSO matched by normalized channel name.
  const byName = new Map();
  const chRe = /<channel[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
  let m, n = 0;
  while ((m = chRe.exec(text)) && n < 100000) {
    n++;
    const dnRe = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let d;
    while ((d = dnRe.exec(m[2]))) {
      const k = normChName(d[1].replace(/<!\[CDATA\[|\]\]>/g, ''));
      if (k && !byName.has(k)) byName.set(k, m[1]);
    }
  }
  // Which guide ids do we actually carry? (tvg-id direct + name-resolved)
  const wanted = new Set();
  for (const c of iptvCache.channels) {
    if (c.tvgId) wanted.add(c.tvgId);
    const viaName = byName.get(normChName(c.name));
    if (viaName) wanted.add(viaName);
  }
  // Pass 2 — programmes for carried channels only.
  const byChannel = new Map();
  const re = /<programme[^>]*start="([^"]+)"[^>]*stop="([^"]+)"[^>]*channel="([^"]+)"[^>]*>([\s\S]*?)<\/programme>/g;
  n = 0;
  while ((m = re.exec(text)) && n < 200000) {
    n++;
    if (wanted.size && !wanted.has(m[3])) continue;
    const title = ((/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[4]) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!title) continue;
    const start = parseXmltvDate(m[1]);
    const stop = parseXmltvDate(m[2]);
    if (!start || !stop || stop < keepFrom || start > keepTo) continue;
    if (!byChannel.has(m[3])) byChannel.set(m[3], []);
    byChannel.get(m[3]).push({ start, stop, title });
  }
  for (const list of byChannel.values()) list.sort((a, b) => a.start - b.start);
  epgCache = { key, at: Date.now(), byChannel, byName };
  persistXmltvCache(epgCache);
  return epgCache;
}
// Programme list for one channel: tvg-id first, normalized display-name second.
function xmltvListFor(epg, ch) {
  if (!epg) return [];
  let list = ch.tvgId ? epg.byChannel.get(ch.tvgId) : null;
  if (!list) {
    const id = epg.byName.get(normChName(ch.name));
    if (id) list = epg.byChannel.get(id);
  }
  return list || [];
}
const b64 = (s) => { try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; } };
function xtreamProgramme(e) {
  if (!e) return null;
  const title = b64(e.title);
  const start = (+e.start_timestamp || 0) * 1000;
  const stop = (+e.stop_timestamp || 0) * 1000;
  return title && start && stop ? { title, start, stop } : null;
}
function fallbackGuideTitle(ch) {
  let title = String(ch && ch.name || '').trim();
  if (!title) return '';
  title = title
    .replace(/[✶⋆]+/g, ' ')
    .replace(/^\([^)]*\)\s*:\s*/i, '')
    .replace(/^[A-Z]{2}\s*\([^)]*\)\s*:\s*/i, '')
    .replace(/^ENDED\s*:\s*/i, 'Ended: ')
    .replace(/\s*:\s+(?:USA|UK|US|BR|TR|GLOBAL|EN)\s*:.*$/i, '')
    .replace(/\s*\[(?:\d{3,4}p|h26[45]|hevc|uhd|fhd|hd|sd|4k-q|raw|extra)\]\s*/gi, ' ')
    .replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[a-z0-9]/i.test(title) ? title : '';
}
function fallbackProgramme(ch, from, to) {
  const title = fallbackGuideTitle(ch);
  return title ? { title, start: from, stop: to, synthetic: true, source: 'channel' } : null;
}
function xtreamEpgStoreKey(key) {
  return idHash(`xtreamepg:${key}`);
}
function hydrateXtreamEpgCache(key) {
  const raw = store.read('xtreamepgcache', null);
  if (!raw || raw.key !== xtreamEpgStoreKey(key) || !Array.isArray(raw.streams)) {
    xtreamEpgCache = { key, byStream: new Map() };
    return;
  }
  const byStream = new Map();
  for (const [id, entry] of raw.streams) {
    if (!entry || !Array.isArray(entry.list)) continue;
    const at = Number(entry.at) || 0;
    if (at && Date.now() - at <= EPG_CACHE_STALE_MS) byStream.set(String(id), { at, list: entry.list });
  }
  xtreamEpgCache = { key, byStream };
}
function persistXtreamEpgCache() {
  try {
    const streams = [...xtreamEpgCache.byStream.entries()]
      .filter(([, e]) => e && Array.isArray(e.list))
      .slice(-5000)
      .map(([id, e]) => [id, { at: Number(e.at) || 0, list: e.list }]);
    store.write('xtreamepgcache', { key: xtreamEpgStoreKey(xtreamEpgCache.key), at: Date.now(), streams });
  } catch {}
}
async function fetchXtreamEpgList(s, ch, limit) {
  const base = String(s.xtHost).replace(/\/+$/, '');
  const u = `${base}/player_api.php?username=${encodeURIComponent(s.xtUser || '')}&password=${encodeURIComponent(s.xtPass || '')}&action=get_short_epg&stream_id=${ch.xtreamId}&limit=${Math.max(2, Math.min(48, limit))}`;
  const r = await fetchUrlExt(u, { timeoutMs: 8000, deadlineMs: 15000, maxBytes: 2 * 1024 * 1024 });
  let raw;
  try { raw = (JSON.parse(r.body.toString('utf8') || '{}').epg_listings) || []; } catch { raw = []; }
  return raw.map(xtreamProgramme).filter(Boolean).sort((a, b) => a.start - b.start);
}
async function xtreamEpgList(ch, { limit = 24 } = {}) {
  const s = settings.get();
  if (s.iptvMode !== 'xtream' || !ch.xtreamId) return [];
  const key = iptvSourceKey(s);
  if (xtreamEpgCache.key !== key) hydrateXtreamEpgCache(key);
  const id = String(ch.xtreamId);
  const hit = xtreamEpgCache.byStream.get(id);
  if (hit && Date.now() - hit.at < EPG_CACHE_TTL_MS) return hit.list;
  if (hit && hit.list && hit.list.length && Date.now() - hit.at <= EPG_CACHE_STALE_MS) {
    if (!hit.promise) {
      const p = fetchXtreamEpgList(s, ch, limit).then((list) => {
        xtreamEpgCache.byStream.set(id, { at: Date.now(), list });
        if (xtreamEpgCache.byStream.size > 5000) xtreamEpgCache.byStream.clear();
        persistXtreamEpgCache();
        return list;
      }).catch((e) => {
        xtreamEpgCache.byStream.set(id, { at: hit.at, list: hit.list });
        throw e;
      });
      xtreamEpgCache.byStream.set(id, { ...hit, promise: p });
    }
    return hit.list;
  }
  if (hit && hit.promise) return hit.promise;
  const p = fetchXtreamEpgList(s, ch, limit).then((list) => {
    xtreamEpgCache.byStream.set(id, { at: Date.now(), list });
    if (xtreamEpgCache.byStream.size > 5000) xtreamEpgCache.byStream.clear();
    persistXtreamEpgCache();
    return list;
  });
  xtreamEpgCache.byStream.set(id, { at: 0, list: hit ? hit.list : [], promise: p });
  try {
    return await p;
  } catch {
    xtreamEpgCache.byStream.delete(id);
    if (hit) return hit.list;
    return [];
  }
}
async function epgNowNext(ch) {
  const s = settings.get();
  if (s.iptvMode === 'xtream' && ch.xtreamId) {
    const list = await xtreamEpgList(ch, { limit: 24 });
    const now = Date.now();
    const i = list.findIndex((p) => p.start <= now && p.stop > now);
    if (i === -1) {
      const next = list.find((p) => p.start > now);
      return next ? { now: null, next } : {};
    }
    return { now: list[i], next: list[i + 1] || null };
  }
  if (s.epgUrl) {
    const epg = await ensureXmltv();
    const list = xmltvListFor(epg, ch);
    const now = Date.now();
    const i = list.findIndex((p) => p.start <= now && p.stop > now);
    if (i === -1) return {};
    return { now: list[i], next: list[i + 1] || null };
  }
  return {};
}
function xtreamGuideWarmTargets(channels) {
  const out = [];
  const seen = new Set();
  const add = (ch) => {
    if (!ch || !ch.xtreamId || seen.has(ch.id)) return;
    seen.add(ch.id);
    out.push(ch);
  };
  const favIds = new Set();
  const favs = store.read('iptvfavs', {});
  for (const list of Object.values(favs || {})) {
    if (Array.isArray(list)) for (const id of list) favIds.add(String(id));
  }
  for (const ch of channels) if (favIds.has(String(ch.id))) add(ch);
  const cachedStreams = xtreamEpgCache.byStream && xtreamEpgCache.byStream.size
    ? new Set([...xtreamEpgCache.byStream.keys()].map(String)) : new Set();
  for (const ch of channels) if (cachedStreams.has(String(ch.xtreamId))) add(ch);
  channels.slice(0, 48).forEach(add);
  return out.slice(0, IPTV_WARM_XTREAM_GUIDE_MAX);
}
async function warmIptvCaches(reason = 'scheduled') {
  if (iptvWarmRunning) return { configured: iptvConfigured(settings.get()), skipped: 'running' };
  const s = settings.get();
  if (!iptvConfigured(s)) return { configured: false };
  iptvWarmRunning = true;
  try {
    const channels = await loadIptvChannels();
    const result = { configured: true, reason, channels: channels.length, xmltv: false, xtreamGuide: 0 };
    if (s.epgUrl) {
      await ensureXmltv();
      result.xmltv = true;
    } else if (s.iptvMode === 'xtream') {
      const key = iptvSourceKey(s);
      if (xtreamEpgCache.key !== key) hydrateXtreamEpgCache(key);
      const targets = xtreamGuideWarmTargets(channels);
      await mapLimit(targets, 4, async (ch) => {
        await xtreamEpgList(ch, { limit: 24 });
      });
      result.xtreamGuide = targets.length;
    }
    return result;
  } finally {
    iptvWarmRunning = false;
  }
}
function scheduleIptvWarmSoon(reason = 'changed', delayMs = IPTV_WARM_DELAY_MS) {
  if (iptvWarmSoonTimer) clearTimeout(iptvWarmSoonTimer);
  iptvWarmSoonTimer = setTimeout(() => {
    iptvWarmSoonTimer = null;
    warmIptvCaches(reason)
      .then((r) => {
        if (r && r.configured) console.log(`[iptv] warmed ${r.channels || 0} channels${r.xmltv ? ' + XMLTV' : ''}${r.xtreamGuide ? ` + ${r.xtreamGuide} Xtream guide channel(s)` : ''}`);
      })
      .catch((e) => console.error('[iptv warm]', e.message));
  }, delayMs);
  iptvWarmSoonTimer.unref();
}
function msUntilNextIptvWarm(nowMs = Date.now()) {
  const next = new Date(nowMs);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, next.getTime() - nowMs);
}
function scheduleNextIptvWarm() {
  if (iptvWarmTimer) clearTimeout(iptvWarmTimer);
  iptvWarmTimer = setTimeout(() => {
    iptvWarmTimer = null;
    scheduleIptvWarmSoon('daily-midnight', 1);
    scheduleNextIptvWarm();
  }, msUntilNextIptvWarm());
  iptvWarmTimer.unref();
}
const tmdb = new TmdbProxy(store, () => settings.get().tmdbKey, process.env.TMDB_BASE || undefined);
const trakt = new Trakt(store, () => settings.get());

// ---------- helpers ----------
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const out = isObj ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': isObj ? 'application/json' : 'text/plain',
    'x-content-type-options': 'nosniff', ...headers });
  res.end(out);
}
async function readBody(req, limit = 50 * 1024 * 1024) {
  const chunks = []; let len = 0;
  for await (const c of req) { len += c.length; if (len > limit) throw new Error('body too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { const e = new Error('bad json'); e.status = 400; throw e; }
}
// Strictly-monotonic timestamp so same-millisecond writes keep a deterministic recency order.
let _lastStamp = 0;
function nextStamp() { return (_lastStamp = Math.max(Date.now(), _lastStamp + 1)); }

function videoMime(name) {
  if (/\.mp4$/i.test(name)) return 'video/mp4';
  if (/\.webm$/i.test(name)) return 'video/webm';
  if (/\.mkv$/i.test(name)) return 'video/x-matroska';
  // Local music libraries stream through the same route — give browsers playable types.
  if (/\.mp3$/i.test(name)) return 'audio/mpeg';
  if (/\.flac$/i.test(name)) return 'audio/flac';
  if (/\.m4a$/i.test(name)) return 'audio/mp4';
  if (/\.(ogg|opus)$/i.test(name)) return 'audio/ogg';
  if (/\.wav$/i.test(name)) return 'audio/wav';
  return 'application/octet-stream';
}
function bearer(req, url) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return url.searchParams.get('t');
}
// Brute-force throttles (login / 4-digit PIN / invites / Quick Connect codes).
const limiter = new RateLimiter();
const clientIp = (ctx) => ctx.req.socket.remoteAddress || '?';
function throttled(ctx, key, opts) {
  const r = limiter.check(key, opts);
  if (r.ok) return false;
  send(ctx.res, 429, { error: 'too many attempts — try again later', retryAfterMs: r.retryMs },
    { 'retry-after': String(Math.ceil(r.retryMs / 1000)) });
  return true;
}
// A stream-scope token must be bound to the resource it's used on. Session tokens pass.
function streamScopeOk(ctx, resource) {
  if (ctx.claims.scope !== 'stream') return true;
  return ctx.claims.sub === resource;
}
// Client capability claims (canPlayType results sent with the play request). Hardware that
// decodes the source natively gets TRUE direct play — no server remux/transcode at all.
function parseCaps(raw) {
  const caps = {};
  for (const k of ['mkv', 'hevc', 'ac3', 'eac3', 'dts']) caps[k] = !!(raw && raw[k]);
  return caps;
}
function parseResolutionRank(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
}
function playbackPolicyFor(user, { maxResolutionRank, preferResolutionRank } = {}) {
  let policy = { ...user.policy, ...sizeCaps(), ...scoringPrefs() };
  const maxRank = parseResolutionRank(maxResolutionRank);
  if (maxRank !== null) {
    policy = { ...policy, maxResolutionRank: Math.min(user.policy.maxResolutionRank ?? 4, maxRank) };
  }
  const preferRank = parseResolutionRank(preferResolutionRank);
  if (preferRank !== null && preferRank <= (policy.maxResolutionRank ?? 4)) {
    policy = { ...policy, preferResolutionRank: preferRank };
    if (preferRank === 4) policy.exactResolutionRank = 4;
  }
  return policy;
}
function mountPayload(vf, uid, extra = {}) {
  const st = auth.streamToken(uid, vf.id);
  return {
    id: vf.id, name: vf.name, size: vf.size, segments: vf.segmentCount,
    container: vf.container, method: vf.method, streamable: vf.streamable, tags: vf.tags,
    streamUrl: `/api/stream/${vf.id}?t=${st}`,
    remuxUrl: detectFfmpeg() ? `/api/remux/${vf.id}?t=${st}` : null,
    transcodeUrl: detectEncoder() ? `/api/transcode/${vf.id}?t=${st}` : null,
    encoder: detectEncoder() ? detectEncoder().kind : null,
    tracksUrl: `/api/tracks/${vf.id}`,
    subtitleBase: `/api/subtitle/${vf.id}`, // + /<n>?t=<stream token>
    streamToken: st,
    playback: decidePlayback(vf.name, vf._caps || {}),
    ...extra,
  };
}
function localItemFor(ctx, libId, idx) {
  const lib = store.read('libraries', { list: [] }).list.find((l) => l.id === libId);
  if (!lib || !lib.path) return { status: 404, error: 'library not found' };
  if (lib.users && lib.users.length && ctx.user.role !== 'admin' && !lib.users.includes(ctx.user.id)) {
    return { status: 404, error: 'library not found' };
  }
  const rec = store.read('libitems', {})[libId];
  const item = rec && rec.items[parseInt(idx, 10)];
  if (!item || !item.file) return { status: 404, error: 'item not found' };
  return { lib, item };
}
function localMountFor(ctx, libId, idx, caps = {}) {
  const found = localItemFor(ctx, libId, idx);
  if (found.error) return found;
  let stat;
  try { stat = fs.statSync(found.item.file); } catch { return { status: 404, error: 'file missing on disk' }; }
  const id = 'l' + idHash(`${libId}:${idx}:${found.item.file}:${stat.size}:${stat.mtimeMs}`);
  let vf = mounts.get(id);
  if (!vf) {
    const name = path.basename(found.item.file);
    vf = {
      id, name, size: stat.size, segmentCount: 1,
      container: 'local', method: null, streamable: true, tags: [], health: { verdict: 'verified' },
      mountedAt: Date.now(), _local: { libId, idx: parseInt(idx, 10), file: found.item.file },
      _q: found.item.title || name,
      triage: async () => ({ verdict: 'verified', checked: 1, missing: 0, local: true }),
      read: async function* (start, end) {
        const rs = fs.createReadStream(found.item.file, { start, end: Math.max(start, end - 1) });
        try {
          for await (const chunk of rs) yield chunk;
        } finally {
          rs.destroy();
        }
      },
    };
    mounts.set(id, vf);
  }
  vf._caps = parseCaps(caps);
  vf._touched = Date.now();
  return { vf, item: found.item };
}
function parseEpisodeKey(key) {
  const m = /^tmdb:tv:(\d+):s(\d+)e(\d+)$/i.exec(String(key || ''));
  return m ? { showId: m[1], season: +m[2], episode: +m[3] } : null;
}
function aired(date) {
  return !!date && String(date).slice(0, 10) <= new Date().toISOString().slice(0, 10);
}
async function nextWatchEpisodes(uid, profile = 'default') {
  if (!settings.get().tmdbKey) return [];
  const all = store.read('watch', {});
  const prefix = `${uid}:${profile}:`;
  const byShow = {};
  const inProgress = new Set();
  for (const [fullKey, w] of Object.entries(all)) {
    if (!fullKey.startsWith(prefix)) continue;
    const key = fullKey.slice(prefix.length);
    const ep = parseEpisodeKey(key);
    if (!ep) continue;
    if (!w.watched && (w.position || 0) > 30) { inProgress.add(ep.showId); continue; }
    if (!w.watched) continue;
    const cur = byShow[ep.showId];
    if (!cur || ep.season > cur.season || (ep.season === cur.season && ep.episode > cur.episode)) byShow[ep.showId] = { ...ep, w };
  }
  const out = [];
  for (const [showId, top] of Object.entries(byShow).slice(0, 20)) {
    if (inProgress.has(showId)) continue;
    try {
      const d = await tmdb.get(`/tv/${showId}`);
      const seasons = (d.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0)
        .sort((a, b) => a.season_number - b.season_number);
      for (const s of seasons.filter((x) => x.season_number >= top.season)) {
        const sd = await tmdb.get(`/tv/${showId}/season/${s.season_number}`);
        const eps = (sd.episodes || []).filter((ep) => ep && ep.episode_number > 0 &&
          (s.season_number > top.season || ep.episode_number > top.episode) && aired(ep.air_date))
          .sort((a, b) => a.episode_number - b.episode_number);
        const next = eps.find((ep) => {
          const rec = all[`${prefix}tmdb:tv:${showId}:s${s.season_number}e${ep.episode_number}`];
          return !(rec && (rec.watched || (rec.position || 0) > 30));
        });
        if (!next) continue;
        const title = String((d.name || (top.w.meta && top.w.meta.title) || '')).replace(/\s*—\s*S\d+E\d+.*$/i, '');
        out.push({
          key: `tmdb:tv:${showId}:s${s.season_number}e${next.episode_number}`,
          title,
          q: `${title} S${String(s.season_number).padStart(2, '0')}E${String(next.episode_number).padStart(2, '0')}`,
          year: (d.first_air_date || '').slice(0, 4) || (top.w.meta && top.w.meta.year) || '',
          genre: 'Episode',
          rating: next.vote_average ? Number(next.vote_average).toFixed(1) : ((top.w.meta && top.w.meta.rating) || '—'),
          overview: next.overview || d.overview || (top.w.meta && top.w.meta.overview) || '',
          backdrop: next.still_path ? `https://image.tmdb.org/t/p/w1280${next.still_path}` :
            (d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : ((top.w.meta && top.w.meta.backdrop) || '')),
          poster: d.poster_path ? `https://image.tmdb.org/t/p/w342${d.poster_path}` : undefined,
          tmdbId: +showId, type: 'episode', progress: 0, resume: 0,
          _nextEp: true, _newEp: new Date(`${next.air_date}T00:00:00Z`).getTime() > (top.w.updatedAt || 0),
          season: s.season_number, episode: next.episode_number,
        });
        break;
      }
    } catch { /* one bad show must not break the row */ }
  }
  return out;
}

// ---------- handlers ----------
const H = {
  server: async (ctx) => send(ctx.res, 200, {
    app: 'triboon', phase: 4, needsSetup: !auth.hasUsers(),
    tmdb: !!settings.get().tmdbKey, ffmpeg: !!detectFfmpeg(),
    // Wyzie only needs the free key; no account login is required.
    opensubs: !!settings.get().openSubsKey,
    iptv: !!(settings.get().iptvUrl || (settings.get().iptvMode === 'xtream' && settings.get().xtHost)),
    music: !!ytmusic.detectYtdlp(), // Music tab shows only when yt-dlp is present
  }),

  setup: async (ctx) => {
    if (auth.hasUsers()) return send(ctx.res, 403, { error: 'already set up' });
    const { name, password } = await readJson(ctx.req);
    if (!name || !password || String(password).length < 4) return send(ctx.res, 400, { error: 'name and password (4+ chars) required' });
    auth.createUser({ name, password, role: 'admin' });
    const r = auth.login(name, password);
    send(ctx.res, 200, r);
  },

  login: async (ctx) => {
    const { name, password } = await readJson(ctx.req);
    const key = `login:${String(name || '').toLowerCase()}:${clientIp(ctx)}`;
    if (throttled(ctx, key, { max: 10, windowMs: 15 * 60000, lockMs: 15 * 60000 })) return;
    try { const r = auth.login(name, password); limiter.clear(key); send(ctx.res, 200, r); }
    catch { send(ctx.res, 401, { error: 'invalid credentials' }); }
  },

  me: async (ctx) => {
    const s = settings.get();
    const iptvAllowed = ctx.user.role === 'admin'
      || !(s.iptvUsers && s.iptvUsers.length) || s.iptvUsers.includes(ctx.user.id);
    send(ctx.res, 200, { ...auth.publicUser(ctx.user), iptvAllowed });
  },

  password: async (ctx) => {
    const { oldPassword, newPassword } = await readJson(ctx.req);
    try { auth.changePassword(ctx.user.id, oldPassword, newPassword); send(ctx.res, 200, { ok: true }); }
    catch (e) { send(ctx.res, 400, { error: e.message }); }
  },

  profileAdd: async (ctx) => {
    const b = await readJson(ctx.req);
    try { send(ctx.res, 200, auth.addProfile(ctx.user.id, { name: b.name, level: b.level, pin: b.pin })); }
    catch (e) { send(ctx.res, 400, { error: e.message }); }
  },
  // Set/change/remove a profile PIN — gated on the ACCOUNT password (a kid with the session
  // open can't lift the lock), and rate-limited like any password check.
  profileSetPin: async (ctx) => {
    const b = await readJson(ctx.req);
    const key = `pinset:${ctx.user.id}`;
    if (throttled(ctx, key, { max: 5, windowMs: 60000, lockMs: 60000 })) return;
    try {
      const p = auth.setProfilePin(ctx.user.id, ctx.m[1], b.password, b.pin === undefined ? null : b.pin);
      limiter.clear(key);
      send(ctx.res, 200, p);
    } catch (e) { send(ctx.res, 400, { error: e.message }); }
  },

  // Rename / change level — account-password-gated like PINs (kids can't self-promote).
  profileEdit: async (ctx) => {
    const b = await readJson(ctx.req);
    const key = `pinset:${ctx.user.id}`; // shares the PIN throttle: same brute-force surface
    if (throttled(ctx, key, { max: 5, windowMs: 60000, lockMs: 60000 })) return;
    try {
      const p = auth.editProfile(ctx.user.id, ctx.m[1], b.password, { name: b.name, level: b.level });
      limiter.clear(key);
      send(ctx.res, 200, p);
    } catch (e) { send(ctx.res, 400, { error: e.message }); }
  },

  profileDelete: async (ctx) => {
    const b = await readJson(ctx.req);
    const key = `pinset:${ctx.user.id}`;
    if (throttled(ctx, key, { max: 5, windowMs: 60000, lockMs: 60000 })) return;
    try {
      auth.deleteProfile(ctx.user.id, ctx.m[1], b.password);
      limiter.clear(key);
      // The profile's watch history goes with it — orphaned entries would resurface if a new
      // profile ever reused the id.
      const prefix = `${ctx.user.id}:${ctx.m[1]}:`;
      store.update('watch', {}, (all) => {
        for (const k of Object.keys(all)) if (k.startsWith(prefix)) delete all[k];
        return all;
      });
      send(ctx.res, 200, { ok: true });
    } catch (e) { send(ctx.res, 400, { error: e.message }); }
  },

  profileVerifyPin: async (ctx) => {
    const b = await readJson(ctx.req);
    // 4-digit PINs are trivially brute-forceable without a throttle: 5 tries/min, 60s lockout.
    const key = `pin:${ctx.user.id}:${ctx.m[1]}`;
    if (throttled(ctx, key, { max: 5, windowMs: 60000, lockMs: 60000 })) return;
    try {
      const ok = auth.verifyProfilePin(ctx.user.id, ctx.m[1], b.pin);
      if (ok) limiter.clear(key);
      send(ctx.res, 200, { ok });
    }
    catch (e) { send(ctx.res, 400, { error: e.message }); }
  },

  status: async (ctx) => {
    const provs = providerList();
    const os = require('os');
    send(ctx.res, 200, {
      app: 'triboon', phase: 4, mounts: mounts.size,
      version: require('../package.json').version,
      nntp: provs.length ? {
        host: provs[0].host, port: provs[0].port, tls: !!provs[0].tls,
        connections: provs[0].connections || 16, providers: provs.length,
        totalConnections: provs.reduce((n, p) => n + (p.connections || 16), 0),
      } : null,
      indexers: (settings.get().indexers || []).length,
      tmdb: !!settings.get().tmdbKey,
      ffmpeg: detectFfmpeg() ? detectFfmpeg().version : null,
      ytdlp: ytmusic.detectYtdlp() ? ytmusic.detectYtdlp().version : null,
      // Device + runtime info for the Engine panel.
      device: {
        os: `${os.type()} ${os.release()}`, arch: process.arch,
        cpus: os.cpus().length, memGb: +(os.totalmem() / 1e9).toFixed(1),
        node: process.version, uptimeSec: Math.floor(process.uptime()),
      },
    });
  },

  mount: async (ctx) => {
    const xml = (await readBody(ctx.req)).toString('utf8');
    const t0 = Date.now();
    const vf = await mountNzb(getPool(), xml);
    vf._touched = Date.now();
    mounts.set(vf.id, vf);
    vf.triage().catch((e) => console.error('[mount triage]', e.message));
    send(ctx.res, 200, mountPayload(vf, ctx.user.id, { mountMs: Date.now() - t0 }));
  },

  mounts: async (ctx) => send(ctx.res, 200, [...mounts.values()].map((v) => ({
    id: v.id, name: v.name, size: v.size, health: v.health, container: v.container,
    streamable: v.streamable, tags: v.tags,
    streamUrl: `/api/stream/${v.id}?t=${auth.streamToken(ctx.user.id, v.id)}`,
  }))),

  health: async (ctx) => {
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    send(ctx.res, 200, await vf.triage());
  },

  search: async (ctx) => {
    const q = ctx.url.searchParams.get('q');
    if (!q) return send(ctx.res, 400, { error: 'q required' });
    const { candidates, errors } = await pipeline.search(
      { q, imdbid: ctx.url.searchParams.get('imdbid') || undefined },
      playbackPolicyFor(ctx.user, {
        maxResolutionRank: ctx.url.searchParams.get('maxResolutionRank'),
        preferResolutionRank: ctx.url.searchParams.get('preferResolutionRank'),
      })
    );
    send(ctx.res, 200, {
      errors,
      // Over-size-cap releases (MANUAL admin cap only) are hidden outright, unlike health
      // warnings which stay visible with a chip — a size-capped release can never be the
      // right pick. The slice is deliberately deep (250): the drawer exists to OVERRIDE
      // auto-pick, and a tight slice made every big remux unfindable (they rank ~140th
      // behind the swarm of sane-size variants; the 4K toggle narrows the view client-side).
      candidates: candidates.filter((c) => !(c.reasons || []).some((r) => r.startsWith('over-size-cap'))).slice(0, 250).map((c) => ({
        name: c.name, pickKey: c.pickKey, sizeBytes: c.sizeBytes, indexer: c.indexer, score: c.score,
        reasons: c.reasons, attributes: c.attributes, streamClass: c.streamClass, health: c.health,
      })),
    });
  },

  play: async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.q) return send(ctx.res, 400, { error: 'q required' });
    const t0 = Date.now();
    // HD/UHD toggle: a per-play resolution preference may tighten the cap DOWNWARD, never
    // above the admin-set cap (Plex semantics — user picks within their ceiling).
    const policy = playbackPolicyFor(ctx.user, body);
    // Explicit resolution pick (4K toggle): boost matching releases — but only within the cap,
    // so a capped user can't smuggle UHD past their ceiling via the preference.
    try {
      const { session, vf, candidate, attempts } = await pipeline.play(
        { q: body.q, imdbid: body.imdbid, tvdbid: body.tvdbid, season: body.season, ep: body.ep, pick: body.pick, pickKey: body.pickKey },
        policy
      );
      vf._q = body.q; // remembered for online subtitle search (release names match poorly)
      vf._caps = parseCaps(body.caps); session.caps = vf._caps; // hardware claims ride the session
      send(ctx.res, 200, mountPayload(vf, ctx.user.id, {
        sessionId: session.id, mountMs: Date.now() - t0,
        candidate: { name: candidate.name, pickKey: candidate.pickKey, score: candidate.score, indexer: candidate.indexer, reasons: candidate.reasons, attributes: candidate.attributes },
        attempts,
      }));
    } catch (e) {
      send(ctx.res, 502, { error: e.message, attempts: e.attempts || [] });
    }
  },

  advance: async (ctx) => {
    const t0 = Date.now();
    try {
      const { session, vf, candidate, attempts } = await pipeline.advance(ctx.m[1]);
      vf._q = session.query && session.query.q;
      vf._caps = session.caps || {}; // same client, same hardware claims
      send(ctx.res, 200, mountPayload(vf, ctx.user.id, {
        sessionId: session.id, mountMs: Date.now() - t0,
        candidate: { name: candidate.name, pickKey: candidate.pickKey, score: candidate.score, indexer: candidate.indexer, attributes: candidate.attributes },
        attempts,
      }));
    } catch (e) {
      send(ctx.res, e.message.includes('unknown') ? 404 : 502, { error: e.message, attempts: e.attempts || [] });
    }
  },

  tmdbProxy: async (ctx) => {
    try {
      const data = await tmdb.get('/' + ctx.m[1] + (ctx.url.search || ''));
      send(ctx.res, 200, data, { 'cache-control': 'private, max-age=600' });
    } catch (e) { send(ctx.res, e.status || 500, { error: e.message }); }
  },

  // Custom libraries = admin-curated saved discover queries shown in the rail.
  // Libraries can be restricted to specific users (users[] of ids; empty/missing = everyone).
  // Admins always see every library (they manage them).
  librariesList: async (ctx) => {
    const list = store.read('libraries', { list: [] }).list
      .filter((l) => ctx.user.role === 'admin' || !(l.users && l.users.length) || l.users.includes(ctx.user.id));
    send(ctx.res, 200, list);
  },
  libraryCreate: async (ctx) => {
    const b = await readJson(ctx.req);
    const KINDS = ['movie', 'tv', 'sports', 'music', 'other'];
    const kind = KINDS.includes(b.kind) ? b.kind : (b.mediaType === 'tv' ? 'tv' : 'movie');
    if (!b.name) return send(ctx.res, 400, { error: 'name required' });
    if (b.mediaType !== undefined && !['movie', 'tv'].includes(b.mediaType) && !b.kind) {
      return send(ctx.res, 400, { error: 'name and mediaType (movie|tv) required' });
    }
    const ICONS = ['auto', 'movie', 'tv', 'star', 'heart', 'fire', 'sparkle'];
    const lib = {
      id: require('crypto').randomBytes(5).toString('hex'),
      name: String(b.name).slice(0, 40),
      kind, mediaType: kind === 'tv' ? 'tv' : 'movie', // mediaType keeps smart views working
      genreId: b.genreId ? String(b.genreId) : null,
      sort: typeof b.sort === 'string' ? b.sort : 'popularity.desc',
      path: b.path ? String(b.path).slice(0, 300) : null, // local folder → scannable
      icon: ICONS.includes(b.icon) ? b.icon : 'auto',     // rail icon (auto = derive from kind)
      users: Array.isArray(b.users) ? b.users.map(String).slice(0, 100) : [], // empty = everyone
    };
    store.update('libraries', { list: [] }, (s) => { s.list.push(lib); return s; });
    send(ctx.res, 200, lib);
  },

  // ---- IPTV v2: M3U or Xtream Codes API; EPG now/next; per-user favorites ----
  iptvChannels: async (ctx) => {
    const s = settings.get();
    const configured = (s.iptvMode === 'xtream' && s.xtHost) || s.iptvUrl;
    if (!configured) return send(ctx.res, 200, { configured: false, channels: [] });
    // Live TV can be restricted to specific users, exactly like libraries (empty = everyone).
    if (s.iptvUsers && s.iptvUsers.length && ctx.user.role !== 'admin' && !s.iptvUsers.includes(ctx.user.id)) {
      return send(ctx.res, 200, { configured: false, channels: [] });
    }
    try {
      const channels = await loadIptvChannels();
      const favs = new Set((store.read('iptvfavs', {})[ctx.user.id]) || []);
      // Admin-enforced hidden categories are stripped server-side for regular users — they
      // can't re-enable them. Admins still see everything (they manage the list).
      const globalHidden = new Set(s.iptvHiddenGroups || []);
      let list = ctx.user.role === 'admin' ? channels
        : channels.filter((c) => !globalHidden.has(c.group || 'Other'));
      // ?fav=1 → only the user's favorites (the home-row widget; keeps the payload tiny).
      if (ctx.url.searchParams.get('fav')) list = list.filter((c) => favs.has(c.id));
      send(ctx.res, 200, {
        configured: true,
        epg: !!(s.epgUrl || s.iptvMode === 'xtream'),
        hiddenGroups: (store.read('iptvgroups', {})[ctx.user.id]) || [],
        globalHidden: ctx.user.role === 'admin' ? [...globalHidden] : undefined,
        channels: list.map(({ url: _u, ...c }) => ({
          ...c, fav: favs.has(c.id),
          streamUrl: `/api/iptv/stream/${c.idx}?t=${auth.streamToken(ctx.user.id, `iptv:${c.idx}`)}`,
          nativeUrl: `/api/iptv/native/${c.idx}?t=${auth.streamToken(ctx.user.id, `iptv:${c.idx}`)}`,
          nativeMime: iptvNativeMime(_u),
        })),
      });
    } catch (e) {
      console.error('[iptv]', e.message);
      send(ctx.res, 502, { error: 'live tv source failed — check the playlist/Xtream settings' });
    }
  },

  // Per-user category visibility: hide provider groups you never watch (synced across devices).
  iptvGroups: async (ctx) => {
    const b = await readJson(ctx.req);
    if (!Array.isArray(b.hidden)) return send(ctx.res, 400, { error: 'hidden[] required' });
    const hidden = b.hidden.map((g) => String(g).slice(0, 80)).slice(0, 500);
    store.update('iptvgroups', {}, (all) => { all[ctx.user.id] = hidden; return all; });
    send(ctx.res, 200, { ok: true, hidden });
  },

  iptvFav: async (ctx) => {
    const b = await readJson(ctx.req);
    if (!b.id) return send(ctx.res, 400, { error: 'id required' });
    let on;
    store.update('iptvfavs', {}, (all) => {
      const list = new Set(all[ctx.user.id] || []);
      if (b.on === false || (b.on === undefined && list.has(b.id))) { list.delete(b.id); on = false; }
      else { list.add(b.id); on = true; }
      all[ctx.user.id] = [...list];
      return all;
    });
    send(ctx.res, 200, { id: b.id, on });
  },

  // Programme guide for a SET of channels (the timeline view): ?chs=1,2,3 → each channel's
  // programmes inside a ~5h window. XMLTV answers from the cached schedule; Xtream fans out
  // get_short_epg in parallel (bounded to one lazy UI page per request).
  iptvGuide: async (ctx) => {
    const idxs = String(ctx.url.searchParams.get('chs') || '')
      .split(',').map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 0).slice(0, 48);
    if (idxs.length && (!iptvCache.channels || !iptvCache.channels.length)) {
      try { await loadIptvChannels(); } catch {}
    }
    const chans = idxs.map((i) => iptvCache.channels && iptvCache.channels[i]).filter(Boolean);
    if (!chans.length) return send(ctx.res, 200, { channels: [] });
    const from = Date.now() - 90 * 60000, to = Date.now() + 4 * 3600000;
    const s = settings.get();
    let epg = null;
    if (s.epgUrl) { try { epg = await ensureXmltv(); } catch { epg = null; } }
    const channels = await mapLimit(chans, 8, async (ch) => {
      let progs = [];
      if (s.iptvMode === 'xtream' && ch.xtreamId) {
        progs = (await xtreamEpgList(ch, { limit: 24 })).filter((p) => p.stop > from && p.start < to);
      }
      if (!progs.length && epg && xmltvListFor(epg, ch).length) {
        progs = xmltvListFor(epg, ch).filter((p) => p.stop > from && p.start < to);
      }
      if (!progs.length) {
        const fallback = fallbackProgramme(ch, from, to);
        if (fallback) progs = [fallback];
      }
      return { idx: ch.idx, programmes: progs.slice(0, 24) };
    });
    send(ctx.res, 200, { from, to, channels });
  },

  // EPG now/next for one channel: Xtream short-EPG, or the configured XMLTV guide.
  iptvEpg: async (ctx) => {
    const ch = iptvCache.channels && iptvCache.channels[parseInt(ctx.m[1], 10)];
    if (!ch) return send(ctx.res, 404, { error: 'channel not found' });
    try {
      const nn = await epgNowNext(ch);
      send(ctx.res, 200, nn || {});
    } catch { send(ctx.res, 200, {}); }
  },

  // Live stream: ffmpeg ingests the channel URL (HLS/TS/whatever) → fMP4 the browser plays.
  iptvNative: async (ctx) => {
    if (!streamScopeOk(ctx, `iptv:${ctx.m[1]}`)) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const ch = iptvCache.channels && iptvCache.channels[parseInt(ctx.m[1], 10)];
    if (!ch) return send(ctx.res, 404, { error: 'channel not found - open Live TV first' });
    ctx.res.writeHead(302, {
      location: ch.url,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    ctx.res.end();
  },

  iptvStream: async (ctx) => {
    if (!streamScopeOk(ctx, `iptv:${ctx.m[1]}`)) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const ch = iptvCache.channels && iptvCache.channels[parseInt(ctx.m[1], 10)];
    if (!ch) return send(ctx.res, 404, { error: 'channel not found — open Live TV first' });
    if (!detectFfmpeg()) return send(ctx.res, 503, { error: 'ffmpeg required for Live TV' });
    ctx.res.writeHead(200, {
      'content-type': 'video/mp4',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();
    // Attempt 1 uses HLS-friendly demuxer options; if ffmpeg dies before emitting a single
    // byte (non-HLS channel, or an older ffmpeg without those options) retry once plain.
    const attempt = (hlsFriendly, retriesLeft) => {
      let ff;
      try { ff = spawnLiveRemux(ch.url, { hlsFriendly }); }
      catch (e) { console.error('[iptv]', e.message); try { ctx.res.destroy(); } catch {} return; }
      let wrote = false, err = '';
      ff.stdout.once('data', () => { wrote = true; });
      ff.stdout.pipe(ctx.res, { end: false });
      ff.stderr.on('data', (d) => { err += d; });
      ff.on('error', (e) => { console.error('[iptv spawn]', e.message); try { ctx.res.destroy(); } catch {} });
      ff.on('close', (codeNum) => {
        if (codeNum && !wrote && retriesLeft > 0 && !ctx.res.destroyed) {
          console.error(`[iptv] "${ch.name}" attempt failed (${err.slice(0, 120).trim()}) — retrying plain`);
          return attempt(false, retriesLeft - 1);
        }
        // Log the channel NAME only (the url embeds the provider account).
        if (codeNum && err) console.error(`[iptv] "${ch.name}" exit ${codeNum}:`, err.slice(0, 300));
        try { ctx.res.end(); } catch {}
      });
      ctx.req.on('close', () => ff.kill('SIGKILL'));
    };
    const likelyHls = /\.m3u8(?:[?#]|$)/i.test(ch.url);
    attempt(likelyHls, likelyHls ? 1 : 0);
  },

  // Watchlist (per user): a saved "want to watch" set, separate from watch progress.
  watchlistList: async (ctx) => {
    const all = store.read('watchlist', {});
    const prefix = `${ctx.user.id}:`;
    send(ctx.res, 200, Object.entries(all).filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ key: k.slice(prefix.length), ...v }))
      .sort((a, b) => b.addedAt - a.addedAt));
  },
  watchlistToggle: async (ctx) => {
    const b = await readJson(ctx.req);
    if (!b.key) return send(ctx.res, 400, { error: 'key required' });
    const k = `${ctx.user.id}:${b.key}`;
    let on;
    store.update('watchlist', {}, (all) => {
      if (b.on === false || (b.on === undefined && all[k])) { delete all[k]; on = false; }
      else { all[k] = { meta: b.meta || {}, addedAt: nextStamp() }; on = true; }
      return all;
    });
    if (trakt.status(ctx.user.id).linked) trakt.watchlist(ctx.user.id, b.key, on); // fire-and-forget
    send(ctx.res, 200, { key: b.key, on });
  },
  libraryDelete: async (ctx) => {
    store.update('libraries', { list: [] }, (s) => { s.list = s.list.filter((l) => l.id !== ctx.m[1]); return s; });
    store.update('libitems', {}, (s) => { delete s[ctx.m[1]]; return s; });
    send(ctx.res, 200, { ok: true });
  },

  libraryEdit: async (ctx) => {
    const b = await readJson(ctx.req);
    let updated = null;
    store.update('libraries', { list: [] }, (s) => {
      const lib = s.list.find((l) => l.id === ctx.m[1]);
      if (!lib) return s;
      if (b.name) lib.name = String(b.name).slice(0, 40);
      if (b.kind && ['movie', 'tv', 'sports', 'music', 'other'].includes(b.kind)) { lib.kind = b.kind; lib.mediaType = (b.kind === 'tv') ? 'tv' : 'movie'; }
      if (b.genreId !== undefined) lib.genreId = b.genreId ? String(b.genreId) : null;
      if (b.sort) lib.sort = String(b.sort);
      if (b.path !== undefined) lib.path = b.path ? String(b.path).slice(0, 300) : null;
      if (b.icon !== undefined) lib.icon = ['auto', 'movie', 'tv', 'star', 'heart', 'fire', 'sparkle'].includes(b.icon) ? b.icon : 'auto';
      if (b.users !== undefined) lib.users = Array.isArray(b.users) ? b.users.map(String).slice(0, 100) : [];
      updated = lib;
      return s;
    });
    if (!updated) return send(ctx.res, 404, { error: 'library not found' });
    send(ctx.res, 200, updated);
  },

  // Folder scan: walk lib.path (2 levels), parse "Title (Year)" from names, TMDB-match for
  // art/info. Items (incl. their absolute file and art paths) live server-side only — the
  // local stream/art routes below serve ONLY paths recorded by a scan, never client input.
  // Understands the common Jellyfin/Kodi layout:
  //   Movies/Title (Year) anything/Title....mkv  + poster.jpg + .nfo
  //   Series/Show (Year)/Season 01/Show - S01E02 - name.mp4  + tvshow.nfo + poster.jpg
  // Scans run in the BACKGROUND (a 2000-title library must not hold an HTTP request open):
  // POST returns 202 immediately; poll GET /scanstatus for progress + the final summary.
  libraryScan: async (ctx) => {
    const lib = store.read('libraries', { list: [] }).list.find((l) => l.id === ctx.m[1]);
    if (!lib) return send(ctx.res, 404, { error: 'library not found' });
    if (!lib.path) return send(ctx.res, 400, { error: 'library has no local path — it is a smart view' });
    const st = scanStates.get(lib.id);
    if (st && st.running) return send(ctx.res, 409, { error: 'scan already running' });
    // mode 'scan' (default): pick up new/removed files, REUSE every cached TMDB match —
    // an unchanged library costs a disk walk and zero network. 'metadata': also re-fetch
    // TMDB for every item (fresh posters/ratings). Plex's "Scan Files" vs "Refresh Metadata".
    const b = await readJson(ctx.req).catch(() => ({}));
    const mode = b && b.mode === 'metadata' ? 'metadata' : 'scan';
    const state = { running: true, startedAt: Date.now(), progress: 0, mode };
    scanStates.set(lib.id, state);
    performScan(lib, state, mode)
      .then((sum) => scanStates.set(lib.id, { running: false, finishedAt: Date.now(), mode, ...sum }))
      .catch((e) => {
        console.error('[library scan]', e.message); // full reason (incl. paths) stays server-side
        scanStates.set(lib.id, { running: false, error: 'scan failed — check the library path exists and is readable' });
      });
    send(ctx.res, 202, { started: true, mode });
  },

  libraryScanStatus: async (ctx) => send(ctx.res, 200, scanStates.get(ctx.m[1]) || { running: false, never: true }),

  // Fix a wrong TMDB match (admin): body { idx, tmdbId } — a TMDB id forces that exact
  // match; null reverts to folder/NFO info. The override is stored ON the item and honored
  // by every future scan, then a quick rescan applies it (all other items just reuse).
  libraryMatch: async (ctx) => {
    const lib = store.read('libraries', { list: [] }).list.find((l) => l.id === ctx.m[1]);
    if (!lib) return send(ctx.res, 404, { error: 'library not found' });
    if (!lib.path) return send(ctx.res, 400, { error: 'smart views have no scanned items' });
    const b = await readJson(ctx.req);
    const idx = parseInt(b.idx, 10);
    const rec = store.read('libitems', {})[lib.id];
    const item = rec && rec.items[idx];
    if (!item) return send(ctx.res, 404, { error: 'item not found — rescan first' });
    if (item.kind === 'episode') return send(ctx.res, 400, { error: 'fix the match on the SHOW — its episodes follow' });
    const ov = b.tmdbId === 'auto' ? 'auto' // clear the override — back to automatic matching
      : (b.tmdbId === null || b.tmdbId === 'none') ? 'none'
      : (Number.isInteger(+b.tmdbId) && +b.tmdbId > 0 ? +b.tmdbId : null);
    if (ov === null) return send(ctx.res, 400, { error: 'tmdbId must be a TMDB id, null for folder info, or "auto"' });
    store.update('libitems', {}, (s) => {
      const it = s[lib.id] && s[lib.id].items[idx];
      if (it) { if (ov === 'auto') { delete it.matchOverride; it.tmdbId = null; } else it.matchOverride = ov; }
      return s;
    });
    const st = scanStates.get(lib.id);
    if (st && st.running) return send(ctx.res, 202, { started: false, queued: true }); // next scan applies it
    const state = { running: true, startedAt: Date.now(), progress: 0, mode: 'scan' };
    scanStates.set(lib.id, state);
    performScan(lib, state, 'scan')
      .then((sum) => scanStates.set(lib.id, { running: false, finishedAt: Date.now(), mode: 'scan', ...sum }))
      .catch((e) => {
        console.error('[library match]', e.message);
        scanStates.set(lib.id, { running: false, error: 'rescan failed — check the library path' });
      });
    send(ctx.res, 202, { started: true });
  },
};

async function performScan(lib, state, mode = 'scan') {
    const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm|mov)$/i;
    const AUDIO = /\.(mp3|flac|m4a|ogg|opus|wav)$/i;
    const wantAudio = lib.kind === 'music';
    const MEDIA = wantAudio ? AUDIO : VIDEO;
    const EP = /S(\d{1,2})[ ._-]?E(\d{1,3})/i;
    const items = [];
    // Previous scan, keyed by file path (movies/episodes) or folder (shows): known items
    // keep their TMDB match + addedAt, so a rescan only hits TMDB for genuinely NEW files.
    // mode 'metadata' ignores the match cache (fresh lookups) but still preserves addedAt.
    const prevItems = (store.read('libitems', {})[lib.id] || { items: [] }).items;
    const prevBy = new Map(prevItems.map((it) => [it.kind === 'show' ? `show:${it.dir || ''}` : it.file, it]));
    const reuse = (key) => { const p = prevBy.get(key); return mode !== 'metadata' && p && p.tmdbId ? p : null; };
    // Admin match override (set via POST /api/libraries/:id/match), carried across scans:
    // 'none' = never TMDB-match this item (folder/NFO info only); a number = ALWAYS match
    // that exact TMDB id (fixes "wrong cover/info" picks for good).
    const ovOf = (key) => (prevBy.get(key) || {}).matchOverride;
    // A failed lookup (TMDB down, no key) must never WIPE a previously good match — a
    // metadata refresh degrades to "keep what we had" instead of unmatching the library.
    const keepPrev = (item, key) => {
      const p = prevBy.get(key);
      if (!p || !p.tmdbId) return;
      item.tmdbId = p.tmdbId; item.poster = p.poster; item.backdrop = p.backdrop;
      item.genres = p.genres || []; item.title = p.title;
      item.overview = item.overview || p.overview; item.rating = item.rating || p.rating;
    };
    const mtimeOf = (f) => { try { return Math.round(fs.statSync(f).mtimeMs); } catch { return Date.now(); } };
    // addedAt = when this file FIRST appeared (drives "Recently added" + new-episode bumps):
    // known items keep their original stamp; new files use the file's mtime (≈ download time).
    const addedAtOf = (key, file) => { const p = prevBy.get(key); return (p && p.addedAt) || mtimeOf(file); };
    // TMDB genre ids — search results carry genre_ids, direct /movie/<id> fetches genres[].
    const genresOf = (hit) => hit.genre_ids || (hit.genres || []).map((g) => g.id);
    const parseName = (label) => {
      const clean = label.replace(/\.[a-z0-9]+$/i, '');
      const m = /^(.+?)[. (_-]+\(?((?:19|20)\d{2})\)?/.exec(clean);
      return { title: (m ? m[1] : clean).replace(/[._]/g, ' ').trim(), year: m ? m[2] : null };
    };
    const lsDir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
    // Display titles: NFO titles often embed the year ("High Copy (2025)") — strip it.
    const cleanTitle = (t) => String(t || '').replace(/\s*\(\s*(?:19|20)\d{2}\s*\)\s*$/, '').trim();
    const findArt = (dir) => {
      for (const n of ['poster.jpg', 'poster.png', 'folder.jpg', 'cover.jpg']) {
        const p = path.join(dir, n);
        if (fs.existsSync(p)) return p;
      }
      return null;
    };
    // Tiny Kodi-NFO reader — title/year/plot/rating plus the TMDB id when present.
    const readNfo = (file) => {
      try {
        const xml = fs.readFileSync(file, 'utf8').slice(0, 200000);
        const tag = (t) => { const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(xml); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null; };
        const uid = /<uniqueid[^>]*type="tmdb"[^>]*>(\d+)<\/uniqueid>/i.exec(xml);
        return { title: tag('title'), year: ((tag('year') || tag('premiered') || '').match(/(19|20)\d{2}/) || [])[0] || null,
          plot: tag('plot'), rating: parseFloat(tag('rating')) || null,
          tmdbId: uid ? +uid[1] : (parseInt(tag('tmdbid'), 10) || null) };
      } catch { return null; }
    };
    const nfoBeside = (file) => readNfo(file.replace(/\.[a-z0-9]+$/i, '.nfo'));
    const tmdbLookup = async (kind, name) => {
      // Prefer an explicit NFO tmdb id; else search by parsed title+year.
      try {
        if (name.tmdbId) {
          const d = await tmdb.get(`/${kind}/${name.tmdbId}`);
          if (d && d.id) return d;
        }
        const q = `/search/${kind}?query=${encodeURIComponent(name.title)}${name.year ? `&year=${name.year}` : ''}`;
        return ((await tmdb.get(q)).results || [])[0] || null;
      } catch { return null; }
    };
    const wantTmdb = !wantAudio && lib.kind !== 'other' && lib.kind !== 'sports';
    const pushItem = (base) => { base.idx = items.length; items.push(base); return base; };
    // TMDB lookups are queued and run in PARALLEL BATCHES after the walk — a 2000-title
    // library scans in seconds of disk walk + lookups at 6-wide instead of one-at-a-time.
    const lookupJobs = [];

    // Bounds are RUNAWAY GUARDS, not product limits: episodes count toward the item total,
    // so the old 1000-item ceiling silently dropped every show after the first ~60 — the
    // owner's "not all my TV shows appear". Sized for real archives with headroom.
    const MAX_ITEMS = 25000, MAX_TOP = 5000, MAX_DIR = 2000, MAX_EPS = 1000;
    const scanMovieDir = async (dir, label) => {
      let best = null;
      for (const f of lsDir(dir).slice(0, MAX_DIR)) {
        if (!f.isFile() || !MEDIA.test(f.name)) continue;
        const st = fs.statSync(path.join(dir, f.name));
        if (!best || st.size > best.size) best = { file: path.join(dir, f.name), size: st.size };
      }
      if (!best) return;
      const nfo = nfoBeside(best.file) || readNfo(path.join(dir, 'movie.nfo'));
      const parsed = parseName(label);
      const item = pushItem({
        kind: 'movie', file: best.file, artFile: findArt(dir),
        title: cleanTitle((nfo && nfo.title) || parsed.title), year: (nfo && nfo.year) || parsed.year,
        overview: (nfo && nfo.plot) || '', rating: (nfo && nfo.rating) || null,
        tmdbId: (nfo && nfo.tmdbId) || null, poster: null, backdrop: null,
        genres: [], addedAt: addedAtOf(best.file, best.file),
      });
      const ov = ovOf(best.file);
      if (ov !== undefined) item.matchOverride = ov;
      const prev = ov === 'none' ? null : reuse(best.file);
      if (ov === 'none') { item.tmdbId = null; /* folder/NFO info only — by admin decision */ }
      else if (prev && (typeof ov !== 'number' || prev.tmdbId === ov)) {
        item.tmdbId = prev.tmdbId; item.poster = prev.poster; item.backdrop = prev.backdrop;
        item.genres = prev.genres || []; item.title = prev.title; // prev title is TMDB-final
        item.overview = item.overview || prev.overview; item.rating = item.rating || prev.rating;
      } else if (wantTmdb) lookupJobs.push(async () => {
        // A "tv"-kind library searches TV even for season-less folders (mini-series etc.).
        const kind = lib.kind === 'tv' ? 'tv' : 'movie';
        const hit = await tmdbLookup(kind, { title: parsed.title, year: item.year, tmdbId: typeof ov === 'number' ? ov : item.tmdbId });
        if (hit) {
          item.tmdbId = hit.id; item.poster = hit.poster_path; item.backdrop = hit.backdrop_path;
          item.genres = genresOf(hit);
          item.title = hit.title || hit.name || item.title; // TMDB display name beats messy NFO/folder titles
          item.overview = item.overview || hit.overview || ''; item.rating = item.rating || hit.vote_average || null;
        } else keepPrev(item, best.file);
      });
    };

    const scanShowDir = async (dir, label, epFiles) => {
      const nfo = readNfo(path.join(dir, 'tvshow.nfo'));
      const parsed = parseName(label);
      const show = pushItem({
        kind: 'show', file: null, artFile: findArt(dir), dir, // dir = the reuse key across scans
        title: cleanTitle((nfo && nfo.title) || parsed.title), year: (nfo && nfo.year) || parsed.year,
        overview: (nfo && nfo.plot) || '', rating: (nfo && nfo.rating) || null,
        tmdbId: (nfo && nfo.tmdbId) || null, poster: null, backdrop: null, genres: [],
      });
      const ovS = ovOf(`show:${dir}`);
      if (ovS !== undefined) show.matchOverride = ovS;
      const prevShow = ovS === 'none' ? null : reuse(`show:${dir}`);
      if (ovS === 'none') { show.tmdbId = null; }
      else if (prevShow && (typeof ovS !== 'number' || prevShow.tmdbId === ovS)) {
        show.tmdbId = prevShow.tmdbId; show.poster = prevShow.poster; show.backdrop = prevShow.backdrop;
        show.genres = prevShow.genres || []; show.title = prevShow.title;
        show.overview = show.overview || prevShow.overview; show.rating = show.rating || prevShow.rating;
      } else if (wantTmdb) lookupJobs.push(async () => {
        const hit = await tmdbLookup('tv', { title: parsed.title, year: show.year, tmdbId: typeof ovS === 'number' ? ovS : show.tmdbId });
        if (hit) {
          show.tmdbId = hit.id; show.poster = hit.poster_path; show.backdrop = hit.backdrop_path;
          show.genres = genresOf(hit);
          show.title = hit.name || show.title; // TMDB display name beats messy NFO/folder titles
          show.overview = show.overview || hit.overview || ''; show.rating = show.rating || hit.vote_average || null;
        } else keepPrev(show, `show:${dir}`);
        if (!show.tmdbId) return;
        // Episodes were created before the lookup resolved — sync their show-derived fields.
        for (const it of items) {
          if (it.kind !== 'episode' || it.showIdx !== show.idx) continue;
          it.tmdbId = show.tmdbId; it.poster = show.poster; it.backdrop = show.backdrop; it.genres = show.genres;
          it.title = `${show.title} · S${String(it.s).padStart(2, '0')}E${String(it.e).padStart(2, '0')}`;
        }
      });
      epFiles.sort((a, b) => a.s - b.s || a.e - b.e);
      for (const ep of epFiles.slice(0, MAX_EPS)) {
        const epNfo = nfoBeside(ep.file);
        pushItem({
          kind: 'episode', file: ep.file, artFile: show.artFile, showIdx: show.idx,
          title: `${show.title} · S${String(ep.s).padStart(2, '0')}E${String(ep.e).padStart(2, '0')}`,
          epTitle: (epNfo && epNfo.title) || null, s: ep.s, e: ep.e,
          year: show.year, overview: (epNfo && epNfo.plot) || '', rating: null,
          tmdbId: show.tmdbId, poster: show.poster, backdrop: show.backdrop, genres: show.genres,
          addedAt: addedAtOf(ep.file, ep.file),
        });
      }
      // A show's addedAt rides its NEWEST episode — a fresh S02E05 floats the whole show to
      // the top of "Recently added" (Plex behavior).
      const eps = items.filter((it) => it.kind === 'episode' && it.showIdx === show.idx);
      show.addedAt = eps.length ? Math.max(...eps.map((e2) => e2.addedAt || 0)) : ((prevBy.get(`show:${dir}`) || {}).addedAt || Date.now());
    };

    try {
      const top = lsDir(lib.path);
      for (const e of top.slice(0, MAX_TOP)) {
        if (items.length >= MAX_ITEMS) break;
        const full = path.join(lib.path, e.name);
        if (e.isFile() && MEDIA.test(e.name)) {
          const parsed = parseName(e.name);
          const item = pushItem({ kind: 'movie', file: full, artFile: null, title: parsed.title, year: parsed.year,
            overview: '', rating: null, tmdbId: null, poster: null, backdrop: null,
            genres: [], addedAt: addedAtOf(full, full) });
          const ov = ovOf(full);
          if (ov !== undefined) item.matchOverride = ov;
          const prev = ov === 'none' ? null : reuse(full);
          if (ov === 'none') { item.tmdbId = null; }
          else if (prev && (typeof ov !== 'number' || prev.tmdbId === ov)) {
            item.tmdbId = prev.tmdbId; item.poster = prev.poster; item.backdrop = prev.backdrop;
            item.genres = prev.genres || []; item.title = prev.title;
            item.overview = prev.overview || ''; item.rating = prev.rating || null;
          } else if (wantTmdb) lookupJobs.push(async () => {
            const hit = await tmdbLookup(lib.kind === 'tv' ? 'tv' : 'movie', { ...parsed, tmdbId: typeof ov === 'number' ? ov : null });
            if (hit) { item.tmdbId = hit.id; item.poster = hit.poster_path; item.backdrop = hit.backdrop_path;
              item.genres = genresOf(hit);
              item.overview = hit.overview || ''; item.rating = hit.vote_average || null; item.title = hit.title || hit.name || item.title; }
            else keepPrev(item, full);
          });
          continue;
        }
        if (!e.isDirectory()) continue;
        // Collect episode files (Season subdirs or SxxEyy files in the folder itself).
        const sub = lsDir(full);
        const epFiles = [];
        for (const f of sub.slice(0, MAX_DIR)) {
          if (f.isFile() && MEDIA.test(f.name) && EP.test(f.name)) {
            const m = EP.exec(f.name);
            epFiles.push({ file: path.join(full, f.name), s: +m[1], e: +m[2] });
          } else if (f.isDirectory() && /season|specials/i.test(f.name)) {
            for (const g of lsDir(path.join(full, f.name)).slice(0, MAX_DIR)) {
              if (!g.isFile() || !MEDIA.test(g.name)) continue;
              const m = EP.exec(g.name);
              if (m) epFiles.push({ file: path.join(full, f.name, g.name), s: +m[1], e: +m[2] });
            }
          }
          // Media folders nest one more level (Movies/<title>/file.mkv under a kind root).
          else if (f.isDirectory() && !/season|specials/i.test(f.name)) {
            const inner = lsDir(path.join(full, f.name));
            const innerEps = inner.filter((g) => g.isFile() && MEDIA.test(g.name) && EP.test(g.name));
            const innerSeasons = inner.filter((g) => g.isDirectory() && /season|specials/i.test(g.name));
            if (innerEps.length || innerSeasons.length) {
              const eps2 = [];
              for (const g of innerEps) { const m = EP.exec(g.name); eps2.push({ file: path.join(full, f.name, g.name), s: +m[1], e: +m[2] }); }
              for (const sd of innerSeasons) {
                for (const g of lsDir(path.join(full, f.name, sd.name)).slice(0, MAX_DIR)) {
                  if (!g.isFile() || !MEDIA.test(g.name)) continue;
                  const m = EP.exec(g.name);
                  if (m) eps2.push({ file: path.join(full, f.name, sd.name, g.name), s: +m[1], e: +m[2] });
                }
              }
              await scanShowDir(path.join(full, f.name), f.name, eps2);
            } else if (inner.some((g) => g.isFile() && MEDIA.test(g.name))) {
              await scanMovieDir(path.join(full, f.name), f.name);
            }
          }
        }
        if (epFiles.length) await scanShowDir(full, e.name, epFiles);
        else if (sub.some((f) => f.isFile() && MEDIA.test(f.name))) await scanMovieDir(full, e.name);
      }
    } catch (e) {
      throw e; // surfaces as the generic scan-failed state (path details stay in the log)
    }
    // Run the queued TMDB lookups 6-wide (large libraries: ~6× faster than sequential).
    for (let i = 0; i < lookupJobs.length; i += 6) {
      await Promise.all(lookupJobs.slice(i, i + 6).map((j) => j().catch(() => {})));
      state.progress = Math.min(items.length, state.progress + 6);
    }
    store.update('libitems', {}, (s) => { s[lib.id] = { scannedAt: Date.now(), items }; return s; });
    return { ok: true, count: items.length,
      shows: items.filter((i) => i.kind === 'show').length,
      matched: items.filter((i) => i.tmdbId).length,
      newItems: items.filter((i) => !prevBy.has(i.kind === 'show' ? `show:${i.dir}` : i.file)).length,
      withLocalArt: items.filter((i) => i.artFile).length };
}

// Library AUTO-SCAN: new episodes/movies dropped into a watched folder appear by themselves —
// no manual rescan. Interval polling (not fs.watch: unreliable on SMB/NFS mounts, which is
// exactly where media lives on Unraid). A no-change pass reuses every TMDB match, so it costs
// one disk walk and zero network. setInterval is unref'd: it must never keep a dying process
// (or a test run) alive.
let lastAutoScanAt = 0;
function autoScanTick() {
  const mins = Number(settings.get().libAutoScanMin ?? 15);
  if (!mins || Date.now() - lastAutoScanAt < mins * 60000) return;
  lastAutoScanAt = Date.now();
  for (const lib of store.read('libraries', { list: [] }).list) {
    if (!lib.path) continue;
    const st = scanStates.get(lib.id);
    if (st && st.running) continue;
    const state = { running: true, startedAt: Date.now(), progress: 0, mode: 'scan', auto: true };
    scanStates.set(lib.id, state);
    performScan(lib, state, 'scan')
      .then((sum) => {
        scanStates.set(lib.id, { running: false, finishedAt: Date.now(), mode: 'scan', auto: true, ...sum });
        if (sum.newItems) console.log(`[library] auto-scan "${lib.name}": ${sum.newItems} new item(s), ${sum.count} total`);
      })
      .catch((e) => {
        console.error('[library auto-scan]', e.message);
        scanStates.set(lib.id, { running: false, error: 'auto-scan failed — check the library path' });
      });
  }
}
setInterval(autoScanTick, 60000).unref(); // checks the admin-set cadence every minute

function importTraktWatchlist(uid, items) {
  let added = 0;
  store.update('watchlist', {}, (all) => {
    for (const it of items) {
      const k = `${uid}:${it.key}`;
      if (!all[k]) {
        all[k] = { meta: { title: it.title, type: it.type, tmdbId: it.tmdbId, year: it.year }, addedAt: nextStamp() };
        added++;
      }
    }
    return all;
  });
  return added;
}

// ---- Trakt sync-DOWN: watchlist + watched history + in-progress playback → local state ----
// Writes into the DEFAULT profile (Trakt accounts are per user; profiles are a local idea).
// Never downgrades: locally-watched stays watched, a real local position beats an imported %.
// Trakt stores playback progress as a PERCENT — kept as traktPct; the player seeks to it
// once the real duration is known.
async function traktSyncDown(uid) {
  if (!trakt.status(uid).linked) { const e = new Error('Trakt is not linked'); e.status = 400; throw e; }
  const [watched, playback, watchlist] = await Promise.all([trakt.pullWatched(uid), trakt.pullPlayback(uid), trakt.pullWatchlist(uid)]);
  // Artwork for the continue-watching imports (they become visible cards) — best effort.
  const art = {};
  for (let i = 0; i < Math.min(playback.length, 30); i += 6) {
    await Promise.all(playback.slice(i, i + 6).map(async (p) => {
      try {
        const d = await tmdb.get(`/${p.type === 'movie' ? 'movie' : 'tv'}/${p.tmdbId}`);
        if (d && d.backdrop_path) art[p.key] = `https://image.tmdb.org/t/p/w1280${d.backdrop_path}`;
      } catch {}
    }));
  }
  const prefix = `${uid}:default:`;
  let nWatched = 0, nPlayback = 0;
  store.update('watch', {}, (all) => {
    for (const w of watched) {
      const k = prefix + w.key;
      if (all[k] && all[k].watched) continue;
      const meta = (all[k] && all[k].meta) || {};
      all[k] = { position: 0, duration: 0, watched: true, fromTrakt: true,
        meta: { ...meta, title: meta.title || w.title, year: meta.year || w.year, type: meta.type || (w.type === 'movie' ? 'movie' : 'episode'), tmdbId: w.tmdbId },
        updatedAt: (all[k] && all[k].updatedAt) || nextStamp() };
      nWatched++;
    }
    for (const p of playback) {
      const cur = all[prefix + p.key];
      if (cur && (cur.watched || cur.position > 30)) continue; // local progress wins
      all[prefix + p.key] = { position: 0, duration: 0, traktPct: Math.round(p.pct * 10) / 10, watched: false, fromTrakt: true,
        meta: { ...(cur && cur.meta || {}), title: (cur && cur.meta && cur.meta.title) || p.title, year: p.year,
          type: p.type === 'movie' ? 'movie' : 'episode', tmdbId: p.tmdbId, ...(art[p.key] ? { backdrop: art[p.key] } : {}) },
        updatedAt: p.pausedAt || nextStamp() };
      nPlayback++;
    }
    return all;
  });
  const nWatchlist = importTraktWatchlist(uid, watchlist);
  store.update('trakt', {}, (all) => { if (all[uid]) all[uid].syncedAt = Date.now(); return all; });
  return { ok: true, watched: nWatched, playback: nPlayback, watchlist: nWatchlist, totalWatched: watched.length, totalWatchlist: watchlist.length };
}
// Auto-resync every 6h per linked user — one user per tick keeps the calls gentle.
function traktSyncTick() {
  const tokens = store.read('trakt', {});
  for (const [uid, tok] of Object.entries(tokens)) {
    if (!tok || (tok.syncedAt && Date.now() - tok.syncedAt < 6 * 3600000)) continue;
    store.update('trakt', {}, (all) => { if (all[uid]) all[uid].syncedAt = Date.now(); return all; }); // claim before the async work
    traktSyncDown(uid)
      .then((r) => { if (r.watched || r.playback || r.watchlist) console.log(`[trakt] sync: +${r.watched} watched, +${r.playback} in-progress, +${r.watchlist} watchlist`); })
      .catch((e) => console.error('[trakt sync]', e.message));
    break;
  }
}
setInterval(traktSyncTick, 60000).unref();

// ---------- handlers, continued ----------
Object.assign(H, {
  libraryItems: async (ctx) => {
    // Restricted libraries are invisible to excluded users (stream/art tokens are only minted
    // here, so this is the single gate for local playback too).
    const lib = store.read('libraries', { list: [] }).list.find((l) => l.id === ctx.m[1]);
    if (lib && lib.users && lib.users.length && ctx.user.role !== 'admin' && !lib.users.includes(ctx.user.id)) {
      return send(ctx.res, 404, { error: 'library not found' });
    }
    const rec = store.read('libitems', {})[ctx.m[1]];
    if (!rec) return send(ctx.res, 200, { items: [] });
    // Never expose absolute paths — items are addressed by index, with tokenized URLs.
    // STABLE tokens: identical URLs across requests for ~6h, so the browser's HTTP cache
    // actually holds the covers instead of re-downloading them on every visit.
    send(ctx.res, 200, {
      scannedAt: rec.scannedAt,
      items: rec.items.map(({ file, artFile, dir, ...rest }) => ({
        ...rest,
        streamUrl: file ? `/api/local/${ctx.m[1]}/${rest.idx}?t=${auth.stableStreamToken(ctx.user.id, `local:${ctx.m[1]}:${rest.idx}`)}` : null,
        playUrl: file ? `/api/local/${ctx.m[1]}/${rest.idx}/play` : null,
        artUrl: artFile ? `/api/local/${ctx.m[1]}/art/${rest.idx}?t=${auth.stableStreamToken(ctx.user.id, `art:${ctx.m[1]}:${rest.idx}`)}` : null,
        thumbUrl: file ? `/api/local/${ctx.m[1]}/thumb/${rest.idx}?t=${auth.stableStreamToken(ctx.user.id, `thumb:${ctx.m[1]}:${rest.idx}`)}` : null,
      })),
    });
  },

  // Prepare a scanned local file as a normal player mount. The old /api/local/:lib/:idx
  // URL remains for direct downloads/VLC, but the app uses this richer descriptor so added
  // libraries get the same remux/transcode, track probe, subtitles and native-player flow
  // as movies and TV episodes mounted from Usenet.
  localPlay: async (ctx) => {
    const body = await readJson(ctx.req);
    const r = localMountFor(ctx, ctx.m[1], ctx.m[2], body.caps || {});
    if (r.error) return send(ctx.res, r.status || 404, { error: r.error });
    send(ctx.res, 200, mountPayload(r.vf, ctx.user.id, { local: true }));
  },

  // Generated video thumbnail (one frame, scaled to 480w) for library items without art.
  // Made lazily on FIRST request, then cached on disk under data/thumbs — so a 2000-item
  // library costs nothing until covers actually scroll into view.
  localThumb: async (ctx) => {
    if (!streamScopeOk(ctx, `thumb:${ctx.m[1]}:${ctx.m[2]}`)) return send(ctx.res, 401, { error: 'token not valid' });
    const rec = store.read('libitems', {})[ctx.m[1]];
    const item = rec && rec.items[parseInt(ctx.m[2], 10)];
    if (!item || !item.file || !detectFfmpeg()) return send(ctx.res, 404, { error: 'no thumbnail' });
    const dir = path.join(DATA_DIR, 'thumbs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const file = path.join(dir, `${ctx.m[1]}-${ctx.m[2]}.jpg`);
    if (!fs.existsSync(file)) {
      if (!thumbJobs.has(file)) {
        thumbJobs.set(file, makeThumb(item.file, file, 120).then((ok) => ok || makeThumb(item.file, file, 5))
          .finally(() => thumbJobs.delete(file)));
      }
      await thumbJobs.get(file);
    }
    let stat;
    try { stat = fs.statSync(file); } catch { return send(ctx.res, 404, { error: 'thumbnail failed' }); }
    ctx.res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': stat.size,
      'cache-control': 'private, max-age=604800', 'x-content-type-options': 'nosniff' });
    const rs = fs.createReadStream(file);
    rs.on('error', () => { try { ctx.res.destroy(); } catch {} });
    rs.pipe(ctx.res);
  },

  // Local artwork (poster.jpg recorded by the scan) — <img> can't send headers, so this is
  // stream-auth with the token bound to exactly one art file.
  localArt: async (ctx) => {
    if (!streamScopeOk(ctx, `art:${ctx.m[1]}:${ctx.m[2]}`)) return send(ctx.res, 401, { error: 'token not valid for this art' });
    const rec = store.read('libitems', {})[ctx.m[1]];
    const item = rec && rec.items[parseInt(ctx.m[2], 10)];
    if (!item || !item.artFile) return send(ctx.res, 404, { error: 'no art' });
    let stat;
    try { stat = fs.statSync(item.artFile); } catch { return send(ctx.res, 404, { error: 'art missing on disk' }); }
    ctx.res.writeHead(200, { 'content-type': /\.png$/i.test(item.artFile) ? 'image/png' : 'image/jpeg',
      'content-length': stat.size, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    const rs = fs.createReadStream(item.artFile);
    rs.on('error', () => { try { ctx.res.destroy(); } catch {} });
    rs.pipe(ctx.res);
  },

  // Stream a scanned local file with full Range support (paths come from the server-side
  // scan record only — the client can only reference an index, never a path).
  localStream: async (ctx) => {
    if (!streamScopeOk(ctx, `local:${ctx.m[1]}:${ctx.m[2]}`)) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const rec = store.read('libitems', {})[ctx.m[1]];
    const item = rec && rec.items[parseInt(ctx.m[2], 10)];
    if (!item || !item.file) return send(ctx.res, 404, { error: 'item not found' });
    let stat;
    try { stat = fs.statSync(item.file); } catch { return send(ctx.res, 404, { error: 'file missing on disk' }); }
    const total = stat.size;
    let start = 0, end = total, code = 200;
    const headers = { 'content-type': videoMime(item.file), 'accept-ranges': 'bytes' };
    const range = ctx.req.headers.range && /bytes=(\d*)-(\d*)/.exec(ctx.req.headers.range);
    if (range) {
      if (range[1] !== '') { start = parseInt(range[1], 10); if (range[2] !== '') end = parseInt(range[2], 10) + 1; }
      else if (range[2] !== '') { start = Math.max(0, total - parseInt(range[2], 10)); }
      if (start >= total) return send(ctx.res, 416, '', { 'content-range': `bytes */${total}` });
      end = Math.min(end, total); code = 206;
      headers['content-range'] = `bytes ${start}-${end - 1}/${total}`;
    }
    headers['content-length'] = String(end - start);
    ctx.res.writeHead(code, headers);
    if (ctx.req.method === 'HEAD') return ctx.res.end();
    const rs = fs.createReadStream(item.file, { start, end: end - 1 });
    rs.on('error', () => { try { ctx.res.destroy(); } catch {} });
    rs.pipe(ctx.res);
  },

  watchList: async (ctx) => {
    const all = store.read('watch', {});
    const profile = ctx.url.searchParams.get('profile') || 'default';
    const prefix = `${ctx.user.id}:${profile}:`;
    const items = Object.entries(all)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ key: k.slice(prefix.length), ...v }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    send(ctx.res, 200, items);
  },

  watchNext: async (ctx) => {
    const profile = ctx.url.searchParams.get('profile') || 'default';
    send(ctx.res, 200, await nextWatchEpisodes(ctx.user.id, profile));
  },

  watchSet: async (ctx) => {
    const b = await readJson(ctx.req);
    if (!b.key) return send(ctx.res, 400, { error: 'key required' });
    const profile = b.profile || 'default';
    const k = `${ctx.user.id}:${profile}:${b.key}`;
    store.update('watch', {}, (all) => {
      if (b.remove) { delete all[k]; return all; } // "Remove from Continue Watching"
      all[k] = {
        position: b.position || 0, duration: b.duration || 0, watched: !!b.watched,
        meta: b.meta || {}, updatedAt: nextStamp(),
      };
      return all;
    });
    if (b.remove) {
      // "Mark unwatched" on a movie removes the record AND its Trakt history; the plain
      // Continue-Watching ✕ (no unwatch flag) stays a local-only tidy-up.
      if (b.unwatch && trakt.status(ctx.user.id).linked) trakt.history(ctx.user.id, b.key, false);
      return send(ctx.res, 200, { ok: true });
    }
    // Trakt sync-up (fire-and-forget; only for linked users + tmdb-keyed items):
    // real playback scrobbles; the explicit ✓ button (no playback context) and explicit
    // unwatch (client sends unwatch:true — progress beacons must never erase history) go
    // through /sync/history instead.
    if (trakt.status(ctx.user.id).linked) {
      if (b.duration > 0) trakt.scrobble(ctx.user.id, b.key, ((b.position || 0) / b.duration) * 100, !!b.watched);
      else if (b.watched) trakt.history(ctx.user.id, b.key, true);
      if (b.watched === false && b.unwatch) trakt.history(ctx.user.id, b.key, false);
    }
    send(ctx.res, 200, { ok: true });
  },

  // ---- Trakt: per-user device-code link + sync ----
  traktStatus: async (ctx) => send(ctx.res, 200, trakt.status(ctx.user.id)),
  traktLink: async (ctx) => {
    try { send(ctx.res, 200, await trakt.linkStart(ctx.user.id)); }
    catch (e) { send(ctx.res, 400, { error: e.message }); }
  },
  traktExchange: async (ctx) => {
    const b = await readJson(ctx.req);
    if (!b.code) return send(ctx.res, 400, { error: 'code required' });
    try {
      const r = await trakt.exchangeCode(ctx.user.id, b.code);
      if (r.state === 'linked') traktSyncDown(ctx.user.id).catch((e) => console.error('[trakt sync]', e.message));
      send(ctx.res, 200, r);
    } catch (e) { send(ctx.res, 400, { error: e.message }); }
  },
  traktPoll: async (ctx) => {
    try {
      const r = await trakt.linkPoll(ctx.user.id);
      // Fresh link → pull the user's Trakt life in right away (async; UI shows counts later).
      if (r.state === 'linked') traktSyncDown(ctx.user.id).catch((e) => console.error('[trakt sync]', e.message));
      send(ctx.res, 200, r);
    } catch (e) { send(ctx.res, 502, { error: 'trakt unreachable' }); }
  },
  traktUnlink: async (ctx) => { trakt.unlink(ctx.user.id); send(ctx.res, 200, { ok: true }); },
  // Import the user's Trakt watchlist into Triboon's (adds only — nothing is removed).
  traktPull: async (ctx) => {
    try {
      const items = await trakt.pullWatchlist(ctx.user.id);
      const added = importTraktWatchlist(ctx.user.id, items);
      send(ctx.res, 200, { ok: true, imported: added, total: items.length });
    } catch (e) { send(ctx.res, 502, { error: 'trakt unreachable' }); }
  },

  // Pull watched history + in-progress playback FROM Trakt into local watch state.
  // Manual "Sync now"; also runs automatically right after linking and every 6h (tick below).
  traktSync: async (ctx) => {
    try { send(ctx.res, 200, await traktSyncDown(ctx.user.id)); }
    catch (e) { console.error('[trakt sync]', e.message); send(ctx.res, 502, { error: 'trakt unreachable' }); }
  },

  // Bulk mark — a whole show/season watched or unwatched in one call (the client supplies the
  // episode keys it already knows from TMDB). Unwatch with watched:false removes the entries.
  watchBulk: async (ctx) => {
    const b = await readJson(ctx.req);
    const items = Array.isArray(b.items) ? b.items.slice(0, 1000) : [];
    const profile = b.profile || 'default';
    const prefix = `${ctx.user.id}:${profile}:`;
    store.update('watch', {}, (all) => {
      for (const it of items) {
        if (!it || !it.key) continue;
        const k = prefix + it.key;
        if (b.watched === false) { delete all[k]; }
        else { all[k] = { position: 0, duration: it.duration || 0, watched: true, meta: it.meta || {}, updatedAt: nextStamp() }; }
      }
      return all;
    });
    // Trakt: a whole-show bulk syncs as ONE show-level history op (Trakt expands episodes).
    if (trakt.status(ctx.user.id).linked) {
      const shows = new Set(items.map((it) => ((/^tmdb:tv:(\d+):/.exec(it && it.key || '')) || [])[1]).filter(Boolean));
      for (const id of shows) trakt.history(ctx.user.id, `tmdb:tv:${id}`, b.watched !== false);
      for (const it of items) { // bulk movie marks (rare) go item-level
        if (/^tmdb:movie:\d+$/.test(it && it.key || '')) trakt.history(ctx.user.id, it.key, b.watched !== false);
      }
    }
    send(ctx.res, 200, { ok: true, count: items.length });
  },

  settingsGet: async (ctx) => {
    const s = settings.get();
    send(ctx.res, 200, { // secrets redacted — the UI shows presence, not values
      providers: (s.providers || []).map((p) => ({ host: p.host, port: p.port, tls: !!p.tls, user: p.user ? '•••' : '', connections: p.connections || 16 })),
      indexers: (s.indexers || []).map((i) => ({
        name: i.name, url: i.url, apikey: i.apikey ? '•••' : '',
        apiDayLimit: i.apiDayLimit || null, grabDayLimit: i.grabDayLimit || null,
        usage: ixUsageToday().byIndexer[i.name] || { api: 0, grabs: 0 },
      })),
      tmdbKey: s.tmdbKey ? '•••' : null,
      openSubsKey: s.openSubsKey ? '•••' : null,
      openSubsUser: s.openSubsUser || null, // username isn't a secret; the password is
      openSubsPass: s.openSubsPass ? '•••' : null,
      // M3U/Xtream details often embed credentials — expose only hosts/flags.
      iptvUrl: s.iptvUrl ? (() => { try { return new URL(s.iptvUrl).host; } catch { return '•••'; } })() : null,
      iptvMode: s.iptvMode || 'm3u',
      xtHost: s.xtHost ? (() => { try { return new URL(s.xtHost).host; } catch { return '•••'; } })() : null,
      epgUrl: s.epgUrl ? (() => { try { return new URL(s.epgUrl).host; } catch { return '•••'; } })() : null,
      traktClientId: s.traktClientId || null, // public identifier — safe to show
      traktClientSecret: s.traktClientSecret ? '•••' : null,
      iptvUsers: s.iptvUsers || [], // user ids, not secrets
      sizeCapMode: s.sizeCapMode || 'auto',
      sizeCap4kGb: s.sizeCap4kGb || null,
      sizeCap1080Gb: s.sizeCap1080Gb || null,
      libAutoScanMin: s.libAutoScanMin ?? 15, // 0 = auto-scan off
      effectiveSizeCaps: sizeCaps(), // what's actually applied right now (auto-computed or manual)
      scoringGroupsTrusted: s.scoringGroupsTrusted || [],
      scoringGroupsAvoid: s.scoringGroupsAvoid || [],
      scoringKeywords: s.scoringKeywords || [],
    });
  },

  // Connection tests for SAVED entries (creds stay server-side, never round-trip to the UI).
  // Failures answer 200 {ok:false} — a broken provider is a result, not an HTTP error.
  testProvider: async (ctx) => {
    const b = await readJson(ctx.req);
    const p = providerList()[b.index];
    if (!p) return send(ctx.res, 400, { error: 'no provider at that index' });
    const t0 = Date.now();
    const c = new NntpConnection({ ...p, connectTimeoutMs: 8000, commandTimeoutMs: 8000 });
    try {
      await c.connect();                          // TCP + TLS + greeting + AUTH
      const authedMs = Date.now() - t0;
      await c.stat('triboon-test@invalid');       // any reply proves the command path (430 expected)
      send(ctx.res, 200, { ok: true, ms: authedMs, host: p.host, tls: !!p.tls });
    } catch (e) {
      send(ctx.res, 200, { ok: false, error: e.message, host: p.host });
    } finally { c.close(); }
  },

  testIndexer: async (ctx) => {
    const b = await readJson(ctx.req);
    const ix = (settings.get().indexers || [])[b.index];
    if (!ix) return send(ctx.res, 400, { error: 'no indexer at that index' });
    const t0 = Date.now();
    try {
      bumpIxUsage(ix.name, 'api'); // a test search is a real API hit — count it honestly
      const items = await searchIndexer(ix, { q: 'test', limit: 5 }, { timeoutMs: 8000 });
      send(ctx.res, 200, { ok: true, ms: Date.now() - t0, items: items.length, name: ix.name });
    } catch (e) {
      send(ctx.res, 200, { ok: false, error: e.message, name: ix.name });
    }
  },

  settingsSet: async (ctx) => {
    const b = await readJson(ctx.req);
    const iptvSourceChanged = ['iptvUrl', 'iptvMode', 'xtHost', 'xtUser', 'xtPass', 'epgUrl']
      .some((k) => b[k] !== undefined);
    // Ops merge server-side so the UI never needs the decrypted secrets back:
    //   addProvider / removeProvider (index) · addIndexer / removeIndexer (index)
    // Wholesale replacement (providers:/indexers:) still works for tests/automation.
    settings.update((s) => {
      const next = {
        providers: b.providers !== undefined ? b.providers : [...(s.providers || [])],
        indexers: b.indexers !== undefined ? b.indexers : [...(s.indexers || [])],
        tmdbKey: b.tmdbKey !== undefined ? b.tmdbKey : s.tmdbKey,
        openSubsKey: b.openSubsKey !== undefined ? (b.openSubsKey || null) : (s.openSubsKey ?? null),
        // Downloads need the user's opensubtitles.com login (the API key alone only searches).
        openSubsUser: b.openSubsUser !== undefined ? (b.openSubsUser || null) : (s.openSubsUser ?? null),
        openSubsPass: b.openSubsPass !== undefined ? (b.openSubsPass || null) : (s.openSubsPass ?? null),
        iptvUrl: b.iptvUrl !== undefined ? (b.iptvUrl || null) : s.iptvUrl,
        iptvMode: b.iptvMode !== undefined ? (b.iptvMode === 'xtream' ? 'xtream' : 'm3u') : s.iptvMode,
        xtHost: b.xtHost !== undefined ? (b.xtHost || null) : s.xtHost,
        xtUser: b.xtUser !== undefined ? (b.xtUser || null) : s.xtUser,
        xtPass: b.xtPass !== undefined ? (b.xtPass || null) : s.xtPass,
        epgUrl: b.epgUrl !== undefined ? (b.epgUrl || null) : s.epgUrl,
        // Admin-enforced hidden IPTV categories — removed from EVERY non-admin user's list.
        iptvHiddenGroups: b.iptvHiddenGroups !== undefined
          ? (Array.isArray(b.iptvHiddenGroups) ? b.iptvHiddenGroups.map((g) => String(g).slice(0, 80)).slice(0, 500) : [])
          : (s.iptvHiddenGroups || []),
        traktClientId: b.traktClientId !== undefined ? (b.traktClientId || null) : s.traktClientId,
        traktClientSecret: b.traktClientSecret !== undefined ? (b.traktClientSecret || null) : s.traktClientSecret,
        // Live TV user allowlist (empty = everyone) — same model as library sharing.
        iptvUsers: b.iptvUsers !== undefined
          ? (Array.isArray(b.iptvUsers) ? b.iptvUsers.map(String).slice(0, 100) : [])
          : (s.iptvUsers || []),
        // Max release size: auto (scaled from connections) | manual (GB caps below) | off.
        sizeCapMode: b.sizeCapMode !== undefined
          ? (['auto', 'manual', 'off'].includes(b.sizeCapMode) ? b.sizeCapMode : 'auto')
          : (s.sizeCapMode || 'auto'),
        sizeCap4kGb: b.sizeCap4kGb !== undefined
          ? (Number(b.sizeCap4kGb) > 0 ? Math.min(500, Number(b.sizeCap4kGb)) : null)
          : (s.sizeCap4kGb ?? null),
        sizeCap1080Gb: b.sizeCap1080Gb !== undefined
          ? (Number(b.sizeCap1080Gb) > 0 ? Math.min(500, Number(b.sizeCap1080Gb)) : null)
          : (s.sizeCap1080Gb ?? null),
        // Local-library auto-scan cadence in minutes (0 = off, max daily).
        libAutoScanMin: b.libAutoScanMin !== undefined
          ? (Number.isFinite(+b.libAutoScanMin) && +b.libAutoScanMin >= 0 ? Math.min(1440, Math.round(+b.libAutoScanMin)) : 15)
          : (s.libAutoScanMin ?? 15),
        // Scoring tweaks: group names (matched against the release's -GROUP suffix) and
        // keyword=score custom formats. Empty = pure built-in TRaSH-style defaults.
        scoringGroupsTrusted: b.scoringGroupsTrusted !== undefined
          ? (Array.isArray(b.scoringGroupsTrusted) ? b.scoringGroupsTrusted.map((g) => String(g).trim().slice(0, 30)).filter(Boolean).slice(0, 100) : [])
          : (s.scoringGroupsTrusted || []),
        scoringGroupsAvoid: b.scoringGroupsAvoid !== undefined
          ? (Array.isArray(b.scoringGroupsAvoid) ? b.scoringGroupsAvoid.map((g) => String(g).trim().slice(0, 30)).filter(Boolean).slice(0, 100) : [])
          : (s.scoringGroupsAvoid || []),
        scoringKeywords: b.scoringKeywords !== undefined
          ? (Array.isArray(b.scoringKeywords)
              ? b.scoringKeywords
                  .filter((k) => k && String(k.term || '').trim() && Number.isFinite(+k.score))
                  .map((k) => ({ term: String(k.term).trim().slice(0, 40), score: Math.max(-5000, Math.min(5000, Math.round(+k.score))) }))
                  .slice(0, 100)
              : [])
          : (s.scoringKeywords || []),
      };
      if (b.addProvider && b.addProvider.host) {
        next.providers.push({
          host: String(b.addProvider.host), port: parseInt(b.addProvider.port, 10) || 563,
          tls: b.addProvider.tls !== false, user: String(b.addProvider.user || ''),
          pass: String(b.addProvider.pass || ''),
          connections: Math.max(1, Math.min(60, parseInt(b.addProvider.connections, 10) || 16)),
        });
      }
      if (Number.isInteger(b.removeProvider)) next.providers.splice(b.removeProvider, 1);
      // In-place edit: blank password keeps the SAVED one (secrets never round-trip to the UI).
      if (b.editProvider && Number.isInteger(b.editProvider.index) && next.providers[b.editProvider.index]) {
        const e = b.editProvider, cur = next.providers[e.index];
        next.providers[e.index] = {
          host: e.host ? String(e.host) : cur.host,
          port: parseInt(e.port, 10) || cur.port,
          tls: e.tls !== undefined ? !!e.tls : cur.tls,
          user: e.user !== undefined ? String(e.user) : cur.user,
          pass: e.pass ? String(e.pass) : cur.pass,
          connections: Math.max(1, Math.min(60, parseInt(e.connections, 10) || cur.connections || 16)),
        };
      }
      if (b.addIndexer && b.addIndexer.url) {
        next.indexers.push({
          name: String(b.addIndexer.name || 'indexer').slice(0, 30),
          url: String(b.addIndexer.url), apikey: String(b.addIndexer.apikey || ''),
          // Optional daily limits (most indexer tiers cap API hits + NZB grabs per day).
          apiDayLimit: parseInt(b.addIndexer.apiDayLimit, 10) > 0 ? parseInt(b.addIndexer.apiDayLimit, 10) : null,
          grabDayLimit: parseInt(b.addIndexer.grabDayLimit, 10) > 0 ? parseInt(b.addIndexer.grabDayLimit, 10) : null,
        });
      }
      if (Number.isInteger(b.removeIndexer)) next.indexers.splice(b.removeIndexer, 1);
      // In-place edit: blank API key keeps the SAVED one.
      if (b.editIndexer && Number.isInteger(b.editIndexer.index) && next.indexers[b.editIndexer.index]) {
        const e = b.editIndexer, cur = next.indexers[e.index];
        next.indexers[e.index] = {
          name: e.name ? String(e.name).slice(0, 30) : cur.name,
          url: e.url ? String(e.url) : cur.url,
          apikey: e.apikey ? String(e.apikey) : cur.apikey,
          apiDayLimit: e.apiDayLimit !== undefined
            ? (parseInt(e.apiDayLimit, 10) > 0 ? parseInt(e.apiDayLimit, 10) : null) : (cur.apiDayLimit ?? null),
          grabDayLimit: e.grabDayLimit !== undefined
            ? (parseInt(e.grabDayLimit, 10) > 0 ? parseInt(e.grabDayLimit, 10) : null) : (cur.grabDayLimit ?? null),
        };
      }
      return next;
    });
    pool = null; poolKey = ''; // provider change → fresh pool next use
    // Indexer/provider changes invalidate cached searches — otherwise a freshly added
    // indexer is invisible (and tests of a replaced one read stale results) for 60s.
    pipeline.searchCache.clear();
    send(ctx.res, 200, { ok: true });
    if (iptvSourceChanged) {
      iptvCache = { key: null, at: 0, channels: [] };
      epgCache = { key: null, at: 0, byChannel: new Map(), byName: new Map() };
      xtreamEpgCache = { key: null, byStream: new Map() };
      if (iptvWarmTimer) scheduleIptvWarmSoon('settings');
    }
  },

  inviteCreate: async (ctx) => {
    const b = await readJson(ctx.req);
    send(ctx.res, 200, auth.createInvite(ctx.user.id, { policy: b.policy || {} }));
  },
  invitesList: async (ctx) => send(ctx.res, 200, auth.listInvites()),
  inviteAccept: async (ctx) => {
    if (throttled(ctx, `invite:${clientIp(ctx)}`, { max: 10, windowMs: 3600000, lockMs: 3600000 })) return;
    const { token, name, password } = await readJson(ctx.req);
    try { send(ctx.res, 200, auth.acceptInvite(token, { name, password })); }
    catch (e) { send(ctx.res, 400, { error: e.message }); }
  },

  users: async (ctx) => send(ctx.res, 200, store.read('users', { list: [] }).list.map((u) => auth.publicUser(u))),

  // Admin edits a user's policy after the fact (the invite only set the initial cap).
  // Also takes { password } — the forgot-password reset (admin-only; never on admin accounts).
  userEdit: async (ctx) => {
    const b = await readJson(ctx.req);
    if (b.password !== undefined) {
      try { auth.adminSetPassword(ctx.m[1], b.password); }
      catch (e) { return send(ctx.res, e.message === 'user not found' ? 404 : 400, { error: e.message }); }
    }
    let updated = null;
    store.update('users', { list: [] }, (s) => {
      const u = s.list.find((x) => x.id === ctx.m[1]);
      if (!u) return s;
      if (b.policy && typeof b.policy === 'object') {
        if (b.policy.maxResolutionRank !== undefined) {
          u.policy.maxResolutionRank = Math.max(0, Math.min(4, parseInt(b.policy.maxResolutionRank, 10) || 0));
        }
        if (b.policy.allowTranscode !== undefined) u.policy.allowTranscode = !!b.policy.allowTranscode;
      }
      updated = u;
      return s;
    });
    if (!updated) return send(ctx.res, 404, { error: 'user not found' });
    send(ctx.res, 200, auth.publicUser(updated));
  },

  // Admin removes a user — their watch state, watchlist, and Live TV favorites go with them
  // (orphaned records would resurface if a recreated user ever drew the same id).
  userDelete: async (ctx) => {
    const uid = ctx.m[1];
    if (uid === ctx.user.id) return send(ctx.res, 400, { error: 'you cannot delete your own account' });
    try {
      const r = auth.deleteUser(uid);
      store.update('watch', {}, (all) => {
        for (const k of Object.keys(all)) if (k.startsWith(uid + ':')) delete all[k];
        return all;
      });
      store.update('watchlist', {}, (all) => { delete all[uid]; return all; });
      store.update('iptvfavs', {}, (all) => { delete all[uid]; return all; });
      send(ctx.res, 200, r);
    } catch (e) { send(ctx.res, e.message === 'user not found' ? 404 : 400, { error: e.message }); }
  },

  // QC poll limit is generous (a TV legitimately polls ~every 2s) — it exists to stop bots
  // sweeping the 6-digit code space for someone else's freshly-approved token.
  qcCreate: async (ctx) => {
    if (throttled(ctx, `qc:${clientIp(ctx)}`, { max: 30, windowMs: 600000, lockMs: 600000 })) return;
    send(ctx.res, 200, auth.qcCreate((await readJson(ctx.req)).deviceName));
  },
  qcPoll: async (ctx) => {
    if (throttled(ctx, `qcpoll:${clientIp(ctx)}`, { max: 120, windowMs: 60000, lockMs: 60000 })) return;
    send(ctx.res, 200, auth.qcPoll(ctx.m[1]));
  },
  qcApprove: async (ctx) => {
    try { send(ctx.res, 200, auth.qcApprove(ctx.m[1], ctx.user.id)); }
    catch (e) { send(ctx.res, 400, { error: e.message }); }
  },

  stream: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable', tags: vf.tags });
    vf._touched = Date.now();
    const total = vf.size;
    let start = 0, end = total;
    let code = 200;
    const headers = { 'content-type': videoMime(vf.name), 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const range = ctx.req.headers.range && /bytes=(\d*)-(\d*)/.exec(ctx.req.headers.range);
    if (range) {
      if (range[1] !== '') {
        start = parseInt(range[1], 10);
        if (range[2] !== '') end = parseInt(range[2], 10) + 1;
      } else if (range[2] !== '') {
        start = Math.max(0, total - parseInt(range[2], 10)); end = total;
      }
      if (start >= total || start >= end) return send(ctx.res, 416, '', { 'content-range': `bytes */${total}` });
      end = Math.min(end, total);
      code = 206;
      headers['content-range'] = `bytes ${start}-${end - 1}/${total}`;
    }
    headers['content-length'] = String(end - start);
    ctx.res.writeHead(code, headers);
    if (ctx.req.method === 'HEAD') return ctx.res.end();
    try {
      for await (const chunk of vf.read(start, end)) {
        if (!ctx.res.write(chunk)) await new Promise((r) => ctx.res.once('drain', r));
        if (ctx.res.destroyed) break;
      }
    } catch (e) {
      console.error(`[stream ${vf.id}]`, e.message); // player sees the cut → calls /api/advance
    }
    ctx.res.end();
  },

  remux: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable', tags: vf.tags });
    if (!detectFfmpeg()) return send(ctx.res, 503, { error: 'ffmpeg not available on this server' });
    vf._touched = Date.now();
    const startSeconds = parseFloat(ctx.url.searchParams.get('start') || '0') || 0;
    const audioTrack = parseInt(ctx.url.searchParams.get('audio') || '0', 10) || 0;
    const selfUrl = `http://127.0.0.1:${server.address().port}/api/stream/${vf.id}?t=${auth.streamToken(ctx.claims.uid, vf.id)}`;
    // Audio decides itself: most browsers can't decode DDP/AC3/DTS, so a pure copy-remux of
    // most releases error'd the <video> and fell to a FULL transcode ("codec not supported"
    // on every movie). The codec (cached probe) is weighed against the CLIENT's declared
    // hardware: a device that decodes it natively gets a bit-exact copy (true direct audio);
    // anything else gets a cheap AAC pass — video is always copied either way. A background
    // probe upgrades the unknown-codec guess for seek-restarts.
    const aud = vf._tracks && vf._tracks.audio && vf._tracks.audio[audioTrack];
    const transcodeAudio = !audioCopyOk(aud && aud.codec, vf._caps);
    if (!vf._tracks && detectFfprobe() && !vf._probing) {
      vf._probing = true;
      probeTracks(selfUrl).then((t) => { vf._tracks = { available: true, ...t }; }).catch(() => {}).finally(() => { vf._probing = false; });
    }
    const ff = spawnRemux(selfUrl, { startSeconds, audioTrack, transcodeAudio });
    ctx.res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    // A spawn-level error ('error' event) is FATAL to the process if unhandled — never omit this.
    ff.on('error', (e) => { console.error('[remux spawn]', e.message); try { ctx.res.destroy(); } catch {} });
    ff.stdout.pipe(ctx.res);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('close', (codeNum) => { if (codeNum && !ctx.res.writableEnded) console.error('[remux]', err.slice(0, 400)); ctx.res.end(); });
    ctx.req.on('close', () => ff.kill('SIGKILL'));
  },

  // Full transcode (the codec wall): H.264+AAC ladder for clients that can't decode the
  // source. HDR sources are tone-mapped. Heaviest path — used only when remux can't play.
  transcode: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable', tags: vf.tags });
    if (!detectEncoder()) return send(ctx.res, 503, { error: 'no H.264 encoder available on this server' });
    vf._touched = Date.now();
    const startSeconds = parseFloat(ctx.url.searchParams.get('start') || '0') || 0;
    const audioTrack = parseInt(ctx.url.searchParams.get('audio') || '0', 10) || 0;
    const height = parseInt(ctx.url.searchParams.get('height') || '1080', 10);
    const hdr = (vf._tracks && vf._tracks.video && vf._tracks.video[0] && vf._tracks.video[0].hdr) || false;
    const selfUrl = `http://127.0.0.1:${server.address().port}/api/stream/${vf.id}?t=${auth.streamToken(ctx.claims.uid, vf.id)}`;
    const ff = spawnTranscode(selfUrl, { startSeconds, audioTrack, height: LADDER[height] ? height : 1080, hdr });
    ctx.res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    ff.on('error', (e) => { console.error('[transcode spawn]', e.message); try { ctx.res.destroy(); } catch {} });
    ff.stdout.pipe(ctx.res);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('close', (codeNum) => { if (codeNum && !ctx.res.writableEnded) console.error('[transcode]', err.slice(0, 400)); ctx.res.end(); });
    ctx.req.on('close', () => ff.kill('SIGKILL'));
  },

  // Track listing (audio + subtitles + duration) via ffprobe — powers CC/audio menus and
  // the "ends at" clock. Cached per mount (probe reads only the stream head).
  tracks: async (ctx) => {
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable', tags: vf.tags });
    vf._touched = Date.now();
    if (!detectFfprobe()) return send(ctx.res, 200, { available: false, audio: [], subs: [], duration: null });
    if (vf._tracks) return send(ctx.res, 200, vf._tracks);
    try {
      const selfUrl = `http://127.0.0.1:${server.address().port}/api/stream/${vf.id}?t=${auth.streamToken(ctx.user.id, vf.id)}`;
      const t = await probeTracks(selfUrl);
      vf._tracks = { available: true, ...t };
      send(ctx.res, 200, vf._tracks);
      // The TV player is Wyzie-only for subtitles. Embedded subtitle extraction can require
      // scanning the whole media stream, so probing tracks must not quietly kick that off.
    } catch (e) { send(ctx.res, 200, { available: false, audio: [], subs: [], duration: null, error: e.message }); }
  },

  // Online subtitles (OpenSubtitles) → WebVTT. The practical CC path: BluRay releases carry
  // only bitmap PGS subs which can never become text tracks. Cached per mount + language.
  ossubs: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    const key = settings.get().openSubsKey; // storage key kept across the Wyzie switch
    if (!key) return send(ctx.res, 503, { error: 'Wyzie Subs is not configured (Settings → Catalog — the key is free)' });
    vf._touched = Date.now();
    const lang = String(ctx.url.searchParams.get('lang') || 'en').slice(0, 5).replace(/[^a-z-]/gi, '');
    const tmdbId = String(ctx.url.searchParams.get('tmdb') || '').replace(/\D/g, '');
    const wantsList = ctx.url.searchParams.get('list') === '1';
    const variant = String(ctx.url.searchParams.get('variant') || '').replace(/[^a-z0-9_.:-]/gi, '').slice(0, 80);
    const shift = Math.max(-120, Math.min(120, Number(ctx.url.searchParams.get('shift') || 0) || 0));
    const base = process.env.WYZIE_BASE || undefined;
    const subOpts = {
      key, tmdbId, query: vf._q || vf.name, lang, releaseName: vf.name,
      durationSeconds: vf._tracks && vf._tracks.duration,
      attempts: 3, retryDelayMs: 900,
      ...(base ? { base } : {}),
    };
    vf._osCache = vf._osCache || new Map();
    vf._osInflight = vf._osInflight || new Map();
    vf._osSearchCache = vf._osSearchCache || new Map();
    vf._osSearchInflight = vf._osSearchInflight || new Map();
    const searchKey = `${lang}:${tmdbId}`;
    const getVariants = async () => {
      if (!vf._osSearchCache.has(searchKey)) {
        if (!vf._osSearchInflight.has(searchKey)) {
          const work = searchOnlineSubs(subOpts)
            .then((data) => {
              const variants = rankSubs(data, vf.name, { durationSeconds: vf._tracks && vf._tracks.duration }).slice(0, 12);
              vf._osSearchCache.set(searchKey, variants);
              return variants;
            })
            .finally(() => vf._osSearchInflight.delete(searchKey));
          vf._osSearchInflight.set(searchKey, work);
        }
        await vf._osSearchInflight.get(searchKey);
      }
      return vf._osSearchCache.get(searchKey) || [];
    };
    if (wantsList) {
      try {
        const variants = await getVariants();
        return send(ctx.res, 200, {
          lang,
          selectedId: (variants.find((v) => v.selected) || variants[0] || {}).id || null,
          variants: variants.map((v) => ({
            id: v.id, label: v.label, display: v.display, language: v.language,
            format: v.format, hearingImpaired: v.hearingImpaired, score: v.score, selected: !!v.selected,
          })),
        });
      } catch (e) {
        const status = isTransientSubError(e) ? 504 : 502;
        return send(ctx.res, status, { error: e.message || 'online subtitles failed' });
      }
    }
    const cacheKey = variant ? `${lang}:${tmdbId}:${variant}` : `${lang}:${tmdbId}:auto`;
    if (!vf._osCache.has(cacheKey)) {
      if (!vf._osInflight.has(cacheKey)) {
        const work = (async () => {
          if (!variant) return fetchOnlineSub(subOpts);
          const variants = await getVariants();
          const hit = variants.find((v) => v.id === variant);
          if (!hit || !hit.raw) throw new Error('that subtitle version is no longer available');
          return downloadSubtitle(hit.raw, { attempts: 3, retryDelayMs: 900 });
        })().then((vtt) => {
          vf._osCache.set(cacheKey, vtt);
          return vtt;
        }).finally(() => vf._osInflight.delete(cacheKey));
        vf._osInflight.set(cacheKey, work);
      }
      try { await vf._osInflight.get(cacheKey); } catch (e) {
        const status = isTransientSubError(e) ? 504 : 502;
        return send(ctx.res, status, { error: e.message || 'online subtitles failed' });
      }
    }
    const vtt = vf._osCache.get(cacheKey);
    send(ctx.res, 200, shift ? shiftVtt(vtt, shift) : vtt, { 'content-type': 'text/vtt; charset=utf-8' });
  },

  // Embedded subtitle track → WebVTT. ffmpeg must read the whole stream (subs are interleaved),
  // so this can take a while the first time on a big release; the result is cached per track.
  subtitle: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable' });
    if (!detectFfmpeg()) return send(ctx.res, 503, { error: 'ffmpeg not available' });
    vf._touched = Date.now();
    const track = parseInt(ctx.m[2], 10) || 0;
    try {
      const vtt = await ensureSubtitleVtt(vf, track, ctx.claims.uid);
      if (!ctx.res.writableEnded) send(ctx.res, 200, vtt, { 'content-type': 'text/vtt; charset=utf-8' });
    } catch (e) {
      if (!ctx.res.writableEnded) send(ctx.res, 502, { error: 'subtitle extraction failed', detail: String(e.message).slice(0, 200) });
    }
  },

  // ---- Music (YouTube Music via yt-dlp) ----
  musicSearch: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    const q = ctx.url.searchParams.get('q') || '';
    const limit = Math.max(1, Math.min(24, parseInt(ctx.url.searchParams.get('limit') || '24', 10) || 24));
    if (!q.trim()) return send(ctx.res, 200, { results: [] });
    try {
      const results = await ytmusic.search(q, { limit, cookiesPath: cookiesFor(ctx.user.id) });
      // Mint a per-track stream token so the client can build playable URLs without a round-trip.
      send(ctx.res, 200, {
        results: results.map((r) => ({ ...r, streamUrl: `/api/music/stream/${r.id}?t=${auth.streamToken(ctx.user.id, `music:${r.id}`)}` })),
      });
    } catch (e) { send(ctx.res, 502, { error: 'music search failed', detail: String(e.message).slice(0, 160) }); }
  },

  // Range-proxy the audio: resolve (cached) the googlevideo URL, then pipe its bytes with the
  // client's Range header. googlevideo URLs are IP-locked to US + expire, so a 403/410 means
  // "stale" — we re-resolve ONCE and retry rather than failing the scrub.
  musicStream: async (ctx) => {
    const id = ctx.m[1];
    if (ctx.claims.scope !== 'stream' || ctx.claims.sub !== `music:${id}`) return send(ctx.res, 401, { error: 'token not valid for this track' });
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp not available' });
    const range = ctx.req.headers.range || null;
    const pipeFrom = async (force) => {
      let rec;
      try { rec = await ytmusic.resolveStream(id, { cookiesPath: cookiesFor(ctx.claims.uid), force }); }
      catch (e) { if (!ctx.res.headersSent) send(ctx.res, 502, { error: 'could not resolve track', detail: String(e.message).slice(0, 160) }); return; }
      const u = new URL(rec.url);
      const upstreamHeaders = {};
      for (const [k, v] of Object.entries(rec.headers || {})) {
        if (v !== undefined && v !== null && !/^host$/i.test(k)) upstreamHeaders[k] = String(v);
      }
      if (range) upstreamHeaders.range = range;
      const client = u.protocol === 'http:' ? http : https;
      const upstream = client.get(u, { headers: upstreamHeaders }, (up) => {
        // Stale/expired URL → one transparent re-resolve before giving up.
        if ((up.statusCode === 403 || up.statusCode === 410) && !force) { up.resume(); return pipeFrom(true); }
        if (up.statusCode >= 400) { up.resume(); if (!ctx.res.headersSent) send(ctx.res, 502, { error: `upstream ${up.statusCode}` }); return; }
        const h = { 'content-type': rec.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' };
        for (const k of ['content-length', 'content-range']) if (up.headers[k]) h[k] = up.headers[k];
        ctx.res.writeHead(up.statusCode === 206 ? 206 : 200, h);
        up.pipe(ctx.res);
      });
      upstream.on('error', () => { try { ctx.res.destroy(); } catch {} });
      ctx.req.on('close', () => upstream.destroy());
    };
    pipeFrom(false);
  },

  // Link state only — the cookie text NEVER returns to a client.
  musicStatus: async (ctx) => {
    const linked = !!((settings.get().ytCookies || {})[ctx.user.id]) || !!cookiesFor(null);
    send(ctx.res, 200, { ytdlp: !!ytmusic.detectYtdlp(), linked });
  },

  // Paste an exported cookies.txt (Netscape format, from music.youtube.com while signed in).
  musicLink: async (ctx) => {
    const b = await readJson(ctx.req);
    const text = String(b.cookies || '').replace(/\r/g, '').slice(0, 256 * 1024);
    // Sanity: must be a Netscape cookie file that actually carries YouTube cookies.
    if (!/(^|\n)\S*\.?youtube\.com\t/i.test(text) && !/youtube\.com/i.test(text.split('\n').find((l) => !l.startsWith('#')) || '')) {
      return send(ctx.res, 400, { error: 'that does not look like a cookies.txt with youtube.com cookies — export it from music.youtube.com while signed in' });
    }
    settings.update((s) => ({ ...s, ytCookies: { ...(s.ytCookies || {}), [ctx.user.id]: text } }));
    dropCookieFile(ctx.user.id); // re-materialize with the fresh text on next use
    send(ctx.res, 200, { linked: true });
  },
  musicUnlink: async (ctx) => {
    settings.update((s) => {
      const all = { ...(s.ytCookies || {}) }; delete all[ctx.user.id];
      return { ...s, ytCookies: all };
    });
    dropCookieFile(ctx.user.id);
    send(ctx.res, 200, { linked: false });
  },

  // The user's own playlists (chips on the Music page). Honest errors — cookies can expire.
  musicPlaylists: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    const cookies = cookiesFor(ctx.user.id);
    if (!cookies) return send(ctx.res, 200, { linked: false, playlists: [] });
    try {
      const playlists = await ytmusic.listPlaylists({ cookiesPath: cookies });
      send(ctx.res, 200, { linked: true, playlists });
    } catch (e) {
      send(ctx.res, 502, { error: 'could not load your playlists — the link may have expired (re-export cookies in Preferences)', detail: String(e.message).slice(0, 160) });
    }
  },
  musicPlaylist: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    try {
      const limit = Math.max(1, Math.min(100, parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50));
      const offset = Math.max(0, parseInt(ctx.url.searchParams.get('offset') || '0', 10) || 0);
      const r = await ytmusic.playlistTracks(ctx.m[1], { cookiesPath: cookiesFor(ctx.user.id), limit: limit + 1, offset });
      const tracks = r.tracks.slice(0, limit);
      const hasMore = r.tracks.length > limit;
      send(ctx.res, 200, {
        title: r.title,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? offset + tracks.length : null,
        results: tracks.map((t) => ({ ...t, streamUrl: `/api/music/stream/${t.id}?t=${auth.streamToken(ctx.user.id, `music:${t.id}`)}` })),
      });
    } catch (e) { send(ctx.res, 502, { error: 'playlist failed to load', detail: String(e.message).slice(0, 160) }); }
  },
});

// ---- YouTube Music account linking (per user, via an exported cookies.txt) ----
// The cookie text is a CREDENTIAL: it lives ENCRYPTED in SecureSettings (s.ytCookies[uid]),
// never round-trips to the UI, and is only materialized into a private temp file while the
// process runs (yt-dlp needs a file path). A hand-placed data/yt-cookies.txt still works as
// a server-wide fallback for headless setups.
const ytCookieFiles = new Map(); // uid -> { path, hash }
function cookiesFor(uid) {
  const all = settings.get().ytCookies || {};
  const text = uid && all[uid];
  if (!text) { // legacy/global fallback
    const p = path.join(DATA_DIR, 'yt-cookies.txt');
    try { return fs.statSync(p).size > 0 ? p : null; } catch { return null; }
  }
  const hash = require('crypto').createHash('sha1').update(text).digest('hex');
  const cur = ytCookieFiles.get(uid);
  if (cur && cur.hash === hash) return cur.path;
  const file = path.join(require('os').tmpdir(), `triboon-ytc-${require('crypto').randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (cur) { try { fs.unlinkSync(cur.path); } catch {} }
  ytCookieFiles.set(uid, { path: file, hash });
  return file;
}
function dropCookieFile(uid) {
  const cur = ytCookieFiles.get(uid);
  if (cur) { try { fs.unlinkSync(cur.path); } catch {} ytCookieFiles.delete(uid); }
}
process.on('exit', () => { for (const [, f] of ytCookieFiles) { try { fs.unlinkSync(f.path); } catch {} } });

// One extraction per (mount, track), shared by every requester and IMMUNE to client
// disconnects. The old per-request spawn was killed when the CC toggle closed the fetch —
// so the whole-file read restarted from zero on every retry and the cache never filled
// ("subtitles don't load until I turn them off and on"). Now the first request (or the
// play-time prefetch) starts ONE ffmpeg run; everyone else awaits the same promise.
function ensureSubtitleVtt(vf, track, uid) {
  vf._subCache = vf._subCache || new Map();
  if (vf._subCache.has(track)) return Promise.resolve(vf._subCache.get(track));
  vf._subJobs = vf._subJobs || new Map();
  if (vf._subJobs.has(track)) return vf._subJobs.get(track);
  const selfUrl = `http://127.0.0.1:${server.address().port}/api/stream/${vf.id}?t=${auth.streamToken(uid, vf.id)}`;
  const job = new Promise((resolve, reject) => {
    let ff;
    try { ff = spawnSubtitleExtract(selfUrl, track); } catch (e) { return reject(e); }
    const chunks = []; let err = '';
    ff.on('error', reject);
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('close', (codeNum) => {
      const vtt = Buffer.concat(chunks).toString('utf8');
      if (codeNum || !vtt.startsWith('WEBVTT')) return reject(new Error(err.slice(0, 200) || `ffmpeg exit ${codeNum}`));
      if (vf._subCache.size < 8) vf._subCache.set(track, vtt);
      resolve(vtt);
    });
  }).finally(() => vf._subJobs.delete(track));
  vf._subJobs.set(track, job);
  job.catch(() => {}); // prefetch callers may not attach a handler — never an unhandled rejection
  return job;
}

// ---------- route table (deny by default; every route DECLARES auth) ----------
const ROUTES = [
  { m: 'GET', re: /^\/api\/server$/, auth: 'public', h: H.server },
  { m: 'POST', re: /^\/api\/setup$/, auth: 'public', h: H.setup },
  { m: 'POST', re: /^\/api\/login$/, auth: 'public', h: H.login },
  { m: 'POST', re: /^\/api\/invite\/accept$/, auth: 'public', h: H.inviteAccept },
  { m: 'POST', re: /^\/api\/quickconnect$/, auth: 'public', h: H.qcCreate },
  { m: 'GET', re: /^\/api\/quickconnect\/(\d{6})$/, auth: 'public', h: H.qcPoll },
  { m: 'POST', re: /^\/api\/quickconnect\/(\d{6})\/approve$/, auth: 'user', h: H.qcApprove },
  { m: 'GET', re: /^\/api\/me$/, auth: 'user', h: H.me },
  { m: 'POST', re: /^\/api\/me\/password$/, auth: 'user', h: H.password },
  { m: 'POST', re: /^\/api\/me\/profiles$/, auth: 'user', h: H.profileAdd },
  { m: 'PATCH', re: /^\/api\/me\/profiles\/(\w+)$/, auth: 'user', h: H.profileEdit },
  { m: 'POST', re: /^\/api\/me\/profiles\/(\w+)\/delete$/, auth: 'user', h: H.profileDelete },
  { m: 'POST', re: /^\/api\/me\/profiles\/(\w+)\/verify$/, auth: 'user', h: H.profileVerifyPin },
  { m: 'POST', re: /^\/api\/me\/profiles\/(\w+)\/pin$/, auth: 'user', h: H.profileSetPin },
  { m: 'POST', re: /^\/api\/watch\/bulk$/, auth: 'user', h: H.watchBulk },
  { m: 'GET', re: /^\/api\/status$/, auth: 'user', h: H.status },
  { m: 'GET', re: /^\/api\/search$/, auth: 'user', h: H.search },
  { m: 'POST', re: /^\/api\/play$/, auth: 'user', h: H.play },
  { m: 'POST', re: /^\/api\/advance\/(\w+)$/, auth: 'user', h: H.advance },
  { m: 'GET', re: /^\/api\/tmdb\/(.+)$/, auth: 'user', h: H.tmdbProxy },
  { m: 'GET', re: /^\/api\/libraries$/, auth: 'user', h: H.librariesList },
  { m: 'POST', re: /^\/api\/libraries$/, auth: 'admin', h: H.libraryCreate },
  { m: 'DELETE', re: /^\/api\/libraries\/(\w+)$/, auth: 'admin', h: H.libraryDelete },
  { m: 'PATCH', re: /^\/api\/libraries\/(\w+)$/, auth: 'admin', h: H.libraryEdit },
  { m: 'POST', re: /^\/api\/libraries\/(\w+)\/scan$/, auth: 'admin', h: H.libraryScan },
  { m: 'POST', re: /^\/api\/libraries\/(\w+)\/match$/, auth: 'admin', h: H.libraryMatch },
  { m: 'GET', re: /^\/api\/libraries\/(\w+)\/items$/, auth: 'user', h: H.libraryItems },
  { m: 'POST', re: /^\/api\/local\/(\w+)\/(\d+)\/play$/, auth: 'user', h: H.localPlay },
  { m: 'GET', re: /^\/api\/local\/(\w+)\/art\/(\d+)$/, auth: 'stream', h: H.localArt },
  { m: 'GET', re: /^\/api\/local\/(\w+)\/thumb\/(\d+)$/, auth: 'stream', h: H.localThumb },
  { m: 'GET', re: /^\/api\/libraries\/(\w+)\/scanstatus$/, auth: 'admin', h: H.libraryScanStatus },
  { m: 'GET', re: /^\/api\/local\/(\w+)\/(\d+)$/, auth: 'stream', h: H.localStream },
  { m: 'GET', re: /^\/api\/iptv\/channels$/, auth: 'user', h: H.iptvChannels },
  { m: 'POST', re: /^\/api\/iptv\/fav$/, auth: 'user', h: H.iptvFav },
  { m: 'GET', re: /^\/api\/iptv\/epg\/(\d+)$/, auth: 'user', h: H.iptvEpg },
  { m: 'GET', re: /^\/api\/iptv\/guide$/, auth: 'user', h: H.iptvGuide },
  { m: 'POST', re: /^\/api\/iptv\/groups$/, auth: 'user', h: H.iptvGroups },
  { m: 'GET', re: /^\/api\/iptv\/native\/(\d+)$/, auth: 'stream', h: H.iptvNative },
  { m: 'GET', re: /^\/api\/iptv\/stream\/(\d+)$/, auth: 'stream', h: H.iptvStream },
  { m: 'GET', re: /^\/api\/watchlist$/, auth: 'user', h: H.watchlistList },
  { m: 'POST', re: /^\/api\/watchlist$/, auth: 'user', h: H.watchlistToggle },
  { m: 'GET', re: /^\/api\/watch\/next$/, auth: 'user', h: H.watchNext },
  { m: 'GET', re: /^\/api\/watch$/, auth: 'user', h: H.watchList },
  { m: 'POST', re: /^\/api\/watch$/, auth: 'user', h: H.watchSet },
  { m: 'GET', re: /^\/api\/trakt\/status$/, auth: 'user', h: H.traktStatus },
  { m: 'POST', re: /^\/api\/trakt\/link$/, auth: 'user', h: H.traktLink },
  { m: 'POST', re: /^\/api\/trakt\/poll$/, auth: 'user', h: H.traktPoll },
  { m: 'POST', re: /^\/api\/trakt\/exchange$/, auth: 'user', h: H.traktExchange },
  { m: 'POST', re: /^\/api\/trakt\/unlink$/, auth: 'user', h: H.traktUnlink },
  { m: 'POST', re: /^\/api\/trakt\/pull$/, auth: 'user', h: H.traktPull },
  { m: 'POST', re: /^\/api\/trakt\/sync$/, auth: 'user', h: H.traktSync },
  { m: 'GET', re: /^\/api\/music\/search$/, auth: 'user', h: H.musicSearch },
  { m: 'GET', re: /^\/api\/music\/stream\/([\w-]{11})$/, auth: 'stream', h: H.musicStream },
  { m: 'GET', re: /^\/api\/music\/status$/, auth: 'user', h: H.musicStatus },
  { m: 'POST', re: /^\/api\/music\/link$/, auth: 'user', h: H.musicLink },
  { m: 'POST', re: /^\/api\/music\/unlink$/, auth: 'user', h: H.musicUnlink },
  { m: 'GET', re: /^\/api\/music\/playlists$/, auth: 'user', h: H.musicPlaylists },
  { m: 'GET', re: /^\/api\/music\/playlist\/([\w-]{2,64})$/, auth: 'user', h: H.musicPlaylist },
  { m: 'GET', re: /^\/api\/mounts$/, auth: 'admin', h: H.mounts },
  { m: 'GET', re: /^\/api\/health\/(\w+)$/, auth: 'user', h: H.health },
  { m: 'POST', re: /^\/api\/mount$/, auth: 'admin', h: H.mount },
  { m: 'GET', re: /^\/api\/settings$/, auth: 'admin', h: H.settingsGet },
  { m: 'POST', re: /^\/api\/settings$/, auth: 'admin', h: H.settingsSet },
  { m: 'POST', re: /^\/api\/test\/provider$/, auth: 'admin', h: H.testProvider },
  { m: 'POST', re: /^\/api\/test\/indexer$/, auth: 'admin', h: H.testIndexer },
  { m: 'POST', re: /^\/api\/invites$/, auth: 'admin', h: H.inviteCreate },
  { m: 'GET', re: /^\/api\/invites$/, auth: 'admin', h: H.invitesList },
  { m: 'GET', re: /^\/api\/users$/, auth: 'admin', h: H.users },
  { m: 'PATCH', re: /^\/api\/users\/(\w+)$/, auth: 'admin', h: H.userEdit },
  { m: 'DELETE', re: /^\/api\/users\/(\w+)$/, auth: 'admin', h: H.userDelete },
  { m: 'GET', re: /^\/api\/stream\/(\w+)$/, auth: 'stream', h: H.stream },
  { m: 'GET', re: /^\/api\/remux\/(\w+)$/, auth: 'stream', h: H.remux },
  { m: 'GET', re: /^\/api\/transcode\/(\w+)$/, auth: 'stream', h: H.transcode },
  { m: 'GET', re: /^\/api\/tracks\/(\w+)$/, auth: 'user', h: H.tracks },
  { m: 'GET', re: /^\/api\/subtitle\/(\w+)\/(\d+)$/, auth: 'stream', h: H.subtitle },
  { m: 'GET', re: /^\/api\/ossubs\/(\w+)$/, auth: 'stream', h: H.ossubs },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const route = ROUTES.find((r) => r.m === method && r.re.test(p));
      if (!route) return send(res, 404, { error: 'not found' }); // deny by default
      const ctx = { req, res, url, m: route.re.exec(p) };

      if (route.auth !== 'public') {
        // Drain any inbound body and ignore its socket errors before rejecting, so a
        // request still uploading when we say 401/403 doesn't surface as ECONNRESET.
        const reject = (code, body) => { req.on('error', () => {}); req.resume(); return send(res, code, body); };
        const token = bearer(req, url);
        const claims = auth.verifyToken(token, route.auth === 'stream' ? 'stream' : 'session')
          || (route.auth === 'stream' ? auth.verifyToken(token, 'session') : null);
        if (!claims) return reject(401, { error: 'authentication required' });
        ctx.claims = claims;
        ctx.user = auth.getUser(claims.uid);
        if (!ctx.user && route.auth !== 'stream') return reject(401, { error: 'unknown user' });
        if (route.auth === 'admin' && ctx.user.role !== 'admin') return reject(403, { error: 'admin only' });
      }
      return await route.h(ctx);
    }

    // ---- static UI (public shell; the app gates itself on /api/me) ----
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(WEB_DIR, path.normalize(file).replace(/^([.][.][/\\])+/, ''));
    if (!full.startsWith(WEB_DIR)) return send(res, 403, 'forbidden');
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const headers = { 'content-type': MIME[path.extname(full)] || 'application/octet-stream',
        'x-content-type-options': 'nosniff' };
      // Without an explicit policy, Chrome/WebView HEURISTICALLY caches index.html — the TV
      // app then runs a stale UI for days after a deploy. Revalidate on every load (cheap on
      // LAN; the page is one file) so every client always runs the UI the server ships.
      headers['cache-control'] = full.endsWith('.html') ? 'no-cache' : 'private, max-age=3600';
      if (full.endsWith('.html')) {
        // Single-file app → inline script/style must stay allowed, but remote script, plugin
        // content, and framing are locked out. img http(s) covers TMDB art + channel logos.
        headers['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; media-src 'self' blob:; " +
          "connect-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; " +
          "object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
        headers['x-frame-options'] = 'SAMEORIGIN';
        // NOT no-referrer: YouTube refuses to authorize many embeds without an origin referrer.
        headers['referrer-policy'] = 'strict-origin-when-cross-origin';
      }
      res.writeHead(200, headers);
      const rs = fs.createReadStream(full);
      rs.on('error', () => { try { res.destroy(); } catch {} }); // file vanished mid-read → don't crash
      return rs.pipe(res);
    }
    return send(res, 404, 'not found');
  } catch (e) {
    // Errors that carry an explicit status are intentional client-facing messages; anything
    // else is internal — log it fully here, return a generic line (no paths/URLs/creds).
    if (!res.headersSent) {
      if (!e.status) console.error('[500]', p, e.message);
      return send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
    }
    try { res.end(); } catch {}
  }
});

// ---------- housekeeping sweep ----------
// Mounts hold a segment map (can be tens of MB for a big release) and were historically kept
// until restart — a household browsing for weeks would leak serious memory. Evict mounts idle
// past the TTL (or oldest-idle beyond the cap), drop their live-mount reuse entries, expire
// old play sessions, and purge expired Quick Connect codes.
const MOUNT_IDLE_MS = 45 * 60000;   // idle = no stream/remux/tracks/subtitle touch
const MOUNT_CAP = 16;
const SESSION_TTL_MS = 12 * 3600000;
function sweep(now = Date.now()) {
  const evicted = [];
  const idle = [...mounts.values()].filter((vf) => now - (vf._touched || vf.mountedAt || 0) > MOUNT_IDLE_MS);
  for (const vf of idle) { mounts.delete(vf.id); evicted.push(vf.id); }
  if (mounts.size > MOUNT_CAP) {
    const byAge = [...mounts.values()].sort((a, b) => (a._touched || 0) - (b._touched || 0));
    for (const vf of byAge.slice(0, mounts.size - MOUNT_CAP)) { mounts.delete(vf.id); evicted.push(vf.id); }
  }
  for (const [url, id] of pipeline.mountByUrl) if (!mounts.has(id)) pipeline.mountByUrl.delete(url);
  for (const [id, s] of pipeline.sessions) if (now - (s.createdAt || 0) > SESSION_TTL_MS) pipeline.sessions.delete(id);
  auth.sweepQuickConnect();
  if (evicted.length) console.log(`[sweep] evicted ${evicted.length} idle mount(s), ${mounts.size} live`);
  return evicted;
}
// A throw inside setInterval is an uncaughtException — it would take down every live stream.
const sweepTimer = setInterval(() => { try { sweep(); } catch (e) { console.error('[sweep]', e.message); } }, 5 * 60000);
sweepTimer.unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Triboon → http://localhost:${PORT}`);
    try { getPool(); } catch { /* no provider configured yet — fine */ }
    // Warm Live TV off the viewer path: channels + XMLTV guide (or a bounded Xtream guide
    // set) are refreshed at local midnight server-side, while stale caches are served instantly.
    scheduleIptvWarmSoon('startup');
    scheduleNextIptvWarm();
  });
  // Docker sends SIGTERM on `docker stop` — flush the store and close cleanly instead of
  // being SIGKILLed 10s later with dirty state.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { console.log(`[${sig}] shutting down`); shutdown().then(() => process.exit(0)); });
  }
}

function shutdown() {
  clearInterval(sweepTimer);
  if (iptvWarmSoonTimer) clearTimeout(iptvWarmSoonTimer);
  if (iptvWarmTimer) clearTimeout(iptvWarmTimer);
  if (pool) { pool.close(); pool = null; }
  store.close();
  return new Promise((r) => server.close(r));
}

module.exports = { server, mounts, getPool, shutdown, sweep, ROUTES, auth, settings, store, warmIptvCaches, msUntilNextIptvWarm };

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
const { StringDecoder } = require('string_decoder');

const PORT = parseInt(process.env.PORT || '7777', 10);
const WEB_DIR = path.join(__dirname, '..', 'web');
const APP_VERSION = (() => {
  try { return require('../package.json').version || 'dev'; }
  catch { return 'dev'; }
})();

// ---------- state ----------
const store = new Store();
const auth = new Auth(store, process.env.TRIBOON_SECRET);
const settings = new SecureSettings(store, auth.secret);
const verdicts = new VerdictCache(store);
const mounts = new Map(); // id -> virtual file
const scanStates = new Map(); // library id -> { running, startedAt, progress, ...summary }
const thumbJobs = new Map(); // thumb path -> in-flight generation promise (no double-spawn)
const DATA_DIR = process.env.TRIBOON_DATA || path.join(__dirname, '..', 'data');
const MAX_PROVIDER_CONNECTIONS = 150;

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function providerConnections(value, fallback = 16) {
  return clampInt(value, fallback, 1, MAX_PROVIDER_CONNECTIONS);
}

function normalizeProviders(list) {
  return (Array.isArray(list) ? list : []).map((p) => ({
    ...p,
    host: String(p.host || '').trim(),
    port: parseInt(p.port, 10) || 563,
    tls: p.tls !== false,
    user: String(p.user || ''),
    pass: String(p.pass || ''),
    connections: providerConnections(p.connections),
  })).filter((p) => p.host);
}

function envProvider() {
  if (!process.env.NNTP_HOST) return null;
  return {
    host: process.env.NNTP_HOST,
    port: parseInt(process.env.NNTP_PORT || '563', 10),
    tls: (process.env.NNTP_TLS || 'true') === 'true',
    user: process.env.NNTP_USER || '',
    pass: process.env.NNTP_PASS || '',
    connections: providerConnections(process.env.NNTP_CONNECTIONS || '16'),
  };
}
function providerList() {
  const s = settings.get();
  const list = (s.providers && s.providers.length) ? normalizeProviders(s.providers) : [envProvider()].filter(Boolean);
  return list;
}

function normalizeStreamingPerformance(raw = {}) {
  const profile = ['auto', 'fast', 'balanced', 'large', 'custom'].includes(raw.profile) ? raw.profile : 'auto';
  const mix = ['1080p', '4k', 'mixed'].includes(raw.streamMix) ? raw.streamMix : 'mixed';
  return {
    profile,
    expectedUsers: clampInt(raw.expectedUsers, 4, 1, 50),
    remoteUsers: clampInt(raw.remoteUsers, 0, 0, 50),
    streamMix: mix,
    serverDownloadMbps: clampInt(raw.serverDownloadMbps, 0, 0, 100000),
    serverUploadMbps: clampInt(raw.serverUploadMbps, 0, 0, 100000),
    buffer1080Sec: clampInt(raw.buffer1080Sec, 180, 30, 600),
    buffer4kSec: clampInt(raw.buffer4kSec, 90, 30, 360),
    startupReservePct: clampInt(raw.startupReservePct, 25, 10, 50),
    maxConnPerStream1080: clampInt(raw.maxConnPerStream1080, 12, 4, 60),
    maxConnPerStream4k: clampInt(raw.maxConnPerStream4k, 20, 6, 80),
    healthProbeLimit: clampInt(raw.healthProbeLimit, 6, 2, 12),
  };
}

function totalProviderConnections(provs = providerList()) {
  return provs.reduce((n, p) => n + providerConnections(p.connections), 0);
}

function streamingRuntimeProfile() {
  const perf = normalizeStreamingPerformance(settings.get().streamingPerformance || {});
  const totalConnections = totalProviderConnections();
  const usableConnections = Math.max(0, Math.floor(totalConnections * 0.85));
  const reserveConnections = usableConnections
    ? Math.max(2, Math.ceil(usableConnections * perf.startupReservePct / 100))
    : 0;
  return { ...perf, totalConnections, usableConnections, reserveConnections };
}

function recommendStreamingPerformance(input = {}, s = settings.get()) {
  const current = normalizeStreamingPerformance({ ...(s.streamingPerformance || {}), ...input });
  const providers = normalizeProviders(s.providers || []);
  if (!providers.length) {
    const env = envProvider();
    if (env) providers.push(env);
  }
  const totalConnections = providers.reduce((n, p) => n + providerConnections(p.connections), 0);
  const usableConnections = Math.max(0, Math.floor(totalConnections * 0.85));
  const reservePct = totalConnections >= 80 ? 20 : 25;
  const reserveConnections = usableConnections ? Math.max(2, Math.ceil(usableConnections * reservePct / 100)) : 0;
  const activeBudget = Math.max(0, usableConnections - reserveConnections);
  const perUser = current.expectedUsers ? Math.max(1, Math.floor(activeBudget / current.expectedUsers)) : activeBudget;

  const mixMbps = current.streamMix === '4k' ? 55 : current.streamMix === '1080p' ? 12 : 28;
  const usableDown = current.serverDownloadMbps ? current.serverDownloadMbps * 0.8 : 0;
  const projectedDown = current.expectedUsers * mixMbps;
  const tightDownload = usableDown > 0 && projectedDown > usableDown * 0.75;
  const generousDownload = usableDown > 0 && projectedDown < usableDown * 0.45;

  const rec1080 = Math.max(4, Math.min(24, perUser >= 16 ? 14 : perUser >= 10 ? 12 : perUser >= 6 ? 8 : 6));
  const rec4k = Math.max(6, Math.min(36, perUser >= 24 ? 24 : perUser >= 16 ? 18 : perUser >= 10 ? 14 : 10));
  const buffer1080Sec = tightDownload ? 90 : generousDownload ? 240 : 180;
  const buffer4kSec = tightDownload ? 60 : generousDownload ? 120 : 90;
  const remotePerStreamMbps = current.remoteUsers && current.serverUploadMbps
    ? Math.max(1, Math.floor((current.serverUploadMbps * 0.8) / current.remoteUsers))
    : 0;

  const warnings = [];
  if (!providers.length) warnings.push('Add at least one usenet provider before applying a streaming profile.');
  if (!current.serverDownloadMbps) warnings.push('Server download speed is unknown, so download pressure is estimated from connections only.');
  if (current.remoteUsers && !current.serverUploadMbps) warnings.push('Remote users need an upload speed value for a reliable remote-stream recommendation.');
  if (tightDownload) warnings.push('Projected playback load is close to the safe download budget; read-ahead should stay conservative.');
  if (totalConnections && perUser < 6) warnings.push('Connection budget per user is tight; add provider connections or lower expected simultaneous users.');
  if (remotePerStreamMbps && remotePerStreamMbps < 20 && current.streamMix !== '1080p') warnings.push('Remote upload budget is low for 4K; use per-user quality caps for remote users.');

  const recommendation = normalizeStreamingPerformance({
    ...current,
    profile: 'auto',
    startupReservePct: reservePct,
    buffer1080Sec,
    buffer4kSec,
    maxConnPerStream1080: rec1080,
    maxConnPerStream4k: rec4k,
    healthProbeLimit: perUser < 6 ? 4 : 6,
  });

  return {
    ok: true,
    recommendation,
    capacity: {
      providers: providers.length,
      totalConnections,
      usableConnections,
      reserveConnections,
      playbackConnections: activeBudget,
      perUserConnections: perUser,
      projectedDownloadMbps: projectedDown,
      usableDownloadMbps: usableDown ? Math.floor(usableDown) : 0,
      remotePerStreamMbps,
    },
    warnings,
  };
}

let pool = null, poolKey = '';
function getPool() {
  const list = providerList();
  if (!list.length) { const e = new Error('no usenet provider configured'); e.status = 409; throw e; }
  const key = JSON.stringify(list.map((p) => [p.host, p.port, p.user, p.connections]));
  if (pool && poolKey === key) return pool;
  if (pool) pool.close();
  poolKey = key;
  pool = new NntpPool(list, Math.max(...list.map((p) => providerConnections(p.connections))));
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
  performance: streamingRuntimeProfile,
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
  fetchOnlineSub, searchOnlineSubs, downloadBestSubtitle, rankSubs, shiftVtt,
  _isTransientError: isTransientSubError,
  _isNoSubtitleError: isNoSubtitleError,
} = require('./opensubs');
const IPTV_CACHE_TTL_MS = 24 * 3600000;
const EPG_CACHE_TTL_MS = 24 * 3600000;
const EPG_EMPTY_TTL_MS = 5 * 60000;
const EPG_CACHE_STALE_MS = 7 * 24 * 3600000;
const IPTV_WARM_DELAY_MS = 1500;
const IPTV_WARM_XTREAM_GUIDE_MAX = 96;
const LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS = 25000;
const LIVE_REMUX_IDLE_TIMEOUT_MS = 45000;
const IPTV_NATIVE_ERROR_TTL_MS = 30000;
const IPTV_PROVIDER_PROTECTION_ERROR_TTL_MS = 1000;
const IPTV_LIVE_RETUNE_GRACE_MS = 650;
const IPTV_PLAYBACK_API_QUIET_MS = 7000;
let iptvCache = { key: null, at: 0, channels: [] };
let epgCache = { key: null, at: 0, byChannel: new Map(), byName: new Map() };
let xtreamEpgCache = { key: null, byStream: new Map() };
let iptvSourceCaches = new Map(); // sourceId -> { key, at, channels }
let epgSourceCaches = new Map();  // sourceId -> { key, at, byChannel, byName }
let xtreamEpgSourceCaches = new Map(); // sourceId -> { key, byStream }
let iptvRefreshingSources = new Set();
let iptvNativeErrorCache = new Map();
let activeIptvLiveStreams = new Map();
let iptvPlaybackHotUntil = 0;
let iptvRefreshPausedLogAt = 0;
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

const IPTV_LEGACY_SOURCE_ID = 'default';
function cleanIptvSourceId(id, fallback = IPTV_LEGACY_SOURCE_ID) {
  const s = String(id || '').replace(/[^\w-]/g, '').slice(0, 40);
  return s || fallback;
}
function normalizeIptvMode(v) {
  return v === 'xtream' ? 'xtream' : 'm3u';
}
function iptvUrlHost(raw) {
  try { return new URL(String(raw || '')).host || null; } catch { return raw ? '•••' : null; }
}
function iptvSourceName(src = {}) {
  const explicit = String(src.name || '').trim().slice(0, 48);
  if (explicit) return explicit;
  if (normalizeIptvMode(src.iptvMode || src.mode) === 'xtream') return iptvUrlHost(src.xtHost) || 'Xtream playlist';
  return iptvUrlHost(src.iptvUrl) || 'M3U playlist';
}
function normalizeIptvSource(raw = {}, fallbackId = IPTV_LEGACY_SOURCE_ID) {
  const mode = normalizeIptvMode(raw.iptvMode || raw.mode || raw.type);
  const src = {
    id: cleanIptvSourceId(raw.id, fallbackId),
    name: iptvSourceName(raw),
    iptvMode: mode,
    enabled: raw.enabled !== false,
    iptvUrl: raw.iptvUrl || raw.url || null,
    xtHost: raw.xtHost || raw.host || null,
    xtUser: raw.xtUser || raw.username || raw.user || null,
    xtPass: raw.xtPass || raw.password || raw.pass || null,
    epgUrl: raw.epgUrl || raw.xmltvUrl || null,
    users: Array.isArray(raw.users) ? raw.users.map(String).slice(0, 100) : [],
  };
  if (mode === 'xtream') src.iptvUrl = null;
  else { src.xtHost = null; src.xtUser = null; src.xtPass = null; }
  return src;
}
function iptvSourceConfigured(src = {}) {
  return !!(src.enabled !== false && ((src.iptvMode === 'xtream' && src.xtHost) || src.iptvUrl));
}
function legacyIptvSource(s = {}) {
  const mode = normalizeIptvMode(s.iptvMode);
  if (!((mode === 'xtream' && s.xtHost) || s.iptvUrl)) return null;
  return normalizeIptvSource({
    id: IPTV_LEGACY_SOURCE_ID,
    name: 'Default Live TV',
    iptvMode: mode,
    iptvUrl: s.iptvUrl || null,
    xtHost: s.xtHost || null,
    xtUser: s.xtUser || null,
    xtPass: s.xtPass || null,
    epgUrl: s.epgUrl || null,
    users: Array.isArray(s.iptvUsers) ? s.iptvUsers : [],
  }, IPTV_LEGACY_SOURCE_ID);
}
function iptvSourcesFromSettings(s = settings.get()) {
  const seen = new Set();
  const out = [];
  const push = (src) => {
    const norm = normalizeIptvSource(src, `src_${idHash(JSON.stringify(src || {}))}`);
    if (!iptvSourceConfigured(norm) || seen.has(norm.id)) return;
    seen.add(norm.id);
    out.push(norm);
  };
  if (Array.isArray(s.iptvSources) && s.iptvSources.length) s.iptvSources.forEach(push);
  const legacy = legacyIptvSource(s);
  if (!out.length && legacy) push(legacy);
  return out;
}
function iptvConfigured(s = settings.get()) {
  return iptvSourcesFromSettings(s).length > 0;
}
function userCanAccessIptvSource(user, src = {}) {
  const users = Array.isArray(src.users) ? src.users : [];
  return !user || user.role === 'admin' || !users.length || users.includes(user.id);
}
function iptvSourcesForUser(user, s = settings.get()) {
  return iptvSourcesFromSettings(s).filter((src) => userCanAccessIptvSource(user, src));
}
function redactIptvSource(src = {}) {
  return {
    id: src.id,
    name: src.name,
    iptvMode: src.iptvMode,
    mode: src.iptvMode,
    enabled: src.enabled !== false,
    iptvUrl: src.iptvUrl ? iptvUrlHost(src.iptvUrl) : null,
    xtHost: src.xtHost ? iptvUrlHost(src.xtHost) : null,
    epgUrl: src.epgUrl ? iptvUrlHost(src.epgUrl) : null,
    users: src.users || [],
  };
}
function makeIptvSourceFromBody(b = {}, existing = null) {
  const mode = normalizeIptvMode(b.iptvMode || b.mode || (existing && existing.iptvMode));
  const src = normalizeIptvSource({
    id: existing && existing.id ? existing.id : `src_${require('crypto').randomBytes(5).toString('hex')}`,
    name: b.name !== undefined ? b.name : (existing && existing.name),
    iptvMode: mode,
    iptvUrl: b.iptvUrl !== undefined ? (b.iptvUrl || null) : (existing && existing.iptvUrl),
    xtHost: b.xtHost !== undefined ? (b.xtHost || null) : (existing && existing.xtHost),
    xtUser: b.xtUser !== undefined ? (b.xtUser || null) : (existing && existing.xtUser),
    xtPass: b.xtPass !== undefined ? (b.xtPass || null) : (existing && existing.xtPass),
    epgUrl: b.epgUrl !== undefined ? (b.epgUrl || null) : (existing && existing.epgUrl),
    users: b.iptvUsers !== undefined ? b.iptvUsers : (b.users !== undefined ? b.users : (existing && existing.users)),
    enabled: b.enabled !== undefined ? b.enabled !== false : !(existing && existing.enabled === false),
  });
  if (!iptvSourceConfigured(src)) {
    const e = new Error(mode === 'xtream' ? 'Xtream host is required' : 'M3U playlist URL is required');
    e.status = 400;
    throw e;
  }
  return src;
}
function clearIptvAggregateCache() {
  iptvCache = { key: null, at: 0, channels: [] };
}
function clearIptvSourceRuntime(sourceId) {
  const id = cleanIptvSourceId(sourceId);
  iptvSourceCaches.delete(id);
  epgSourceCaches.delete(id);
  xtreamEpgSourceCaches.delete(id);
  iptvRefreshingSources.delete(id);
  clearIptvAggregateCache();
  if (epgCache.sourceId === id) epgCache = { key: null, at: 0, byChannel: new Map(), byName: new Map() };
  if (xtreamEpgCache.sourceId === id) xtreamEpgCache = { key: null, byStream: new Map() };
}
function clearAllIptvRuntime() {
  iptvSourceCaches.clear();
  epgSourceCaches.clear();
  xtreamEpgSourceCaches.clear();
  iptvRefreshingSources.clear();
  clearIptvAggregateCache();
  epgCache = { key: null, at: 0, byChannel: new Map(), byName: new Map() };
  xtreamEpgCache = { key: null, byStream: new Map() };
  iptvNativeErrorCache = new Map();
}
function readIptvDiskCaches() {
  const all = store.read('iptvcaches', {});
  if (all && typeof all === 'object' && !Array.isArray(all)) return all;
  const legacy = store.read('iptvcache', null);
  return legacy ? { [IPTV_LEGACY_SOURCE_ID]: legacy } : {};
}
function writeIptvDiskCache(sourceId, value) {
  const id = cleanIptvSourceId(sourceId);
  store.update('iptvcaches', {}, (all) => {
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    all[id] = value;
    return all;
  });
  if (id === IPTV_LEGACY_SOURCE_ID) store.write('iptvcache', value);
}
function deleteIptvDiskCache(sourceId) {
  const id = cleanIptvSourceId(sourceId);
  store.update('iptvcaches', {}, (all) => {
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    delete all[id];
    return all;
  });
  if (id === IPTV_LEGACY_SOURCE_ID) store.write('iptvcache', null);
  store.update('xtreamepgcaches', {}, (all) => { delete all[id]; return all; });
  store.update('epgcaches', {}, (all) => { delete all[id]; return all; });
}

// Channels from either source, normalized: { idx, id (stable), name, logo, group, tvgId, url (secret) }.
// Xtream channel URL is derived from settings — the DISK cache stores channels WITHOUT it
// (credentials stay encrypted-at-rest in settings only) and rebuilds it on read.
function xtUrlFor(s, streamId, ext = 'm3u8') {
  const base = String(s.xtHost || '').replace(/\/+$/, '');
  const safeExt = String(ext || 'm3u8').replace(/[^a-z0-9]/gi, '') || 'm3u8';
  return `${base}/live/${encodeURIComponent(s.xtUser || '')}/${encodeURIComponent(s.xtPass || '')}/${streamId}.${safeExt}`;
}
function xtChannelUrls(s, streamId) {
  return {
    url: xtUrlFor(s, streamId, 'm3u8'),
    nativeUrl: xtUrlFor(s, streamId, 'ts'),
    nativeMime: 'video/mp2t',
    nativeFallbackUrl: xtUrlFor(s, streamId, 'm3u8'),
    nativeFallbackMime: 'application/x-mpegURL',
  };
}
function hydrateXtreamCachedChannels(s, rawChannels) {
  if (!Array.isArray(rawChannels)) return [];
  return rawChannels
    .filter((c) => c && c.xtreamId !== undefined && c.xtreamId !== null && c.xtreamId !== '')
    .slice(0, 20000)
    .map((c, i) => ({
      ...c,
      idx: i,
      ...xtChannelUrls(s, c.xtreamId),
    }));
}
function iptvNativeMime(url) {
  const u = String(url || '').toLowerCase();
  if (/\.m3u8(?:[?#]|$)/.test(u)) return 'application/x-mpegURL';
  if (/\.(?:ts|mpegts)(?:[?#]|$)/.test(u)) return 'video/mp2t';
  return '';
}
const IPTV_NATIVE_PROXY_UA = 'Mozilla/5.0 (SMART-TV; Linux) AppleWebKit/537.36 TriboonTV/1.0';
function iptvNativeLogLabel(meta = {}) {
  const idx = Number.isInteger(meta.idx) ? `#${meta.idx}` : '#?';
  const name = String(meta.name || 'channel').replace(/[\r\n]+/g, ' ').slice(0, 80);
  return `${idx} "${name}"${meta.alt ? ' fallback' : ''}`;
}
function iptvLiveSlotKey(ctx) {
  const uid = ctx && ctx.claims && ctx.claims.uid ? ctx.claims.uid : 'unknown';
  const ip = ctx && ctx.req && ctx.req.socket ? (ctx.req.socket.remoteAddress || '') : '';
  const ua = ctx && ctx.req && ctx.req.headers ? String(ctx.req.headers['user-agent'] || '').slice(0, 80) : '';
  return idHash(`${uid}|${ip}|${ua}`);
}
function markIptvPlaybackHot() {
  iptvPlaybackHotUntil = Math.max(iptvPlaybackHotUntil, Date.now() + IPTV_PLAYBACK_API_QUIET_MS);
}
function iptvPlaybackBusy() {
  return activeIptvLiveStreams.size > 0 || Date.now() < iptvPlaybackHotUntil;
}
function beginIptvLiveSlot(ctx, meta = {}) {
  markIptvPlaybackHot();
  const key = iptvLiveSlotKey(ctx);
  const prev = activeIptvLiveStreams.get(key);
  let replaced = false;
  if (prev && typeof prev.close === 'function') {
    replaced = true;
    prev.close('retuned');
  }
  const label = iptvNativeLogLabel(meta);
  const entry = {
    key,
    label,
    replaced,
    closed: false,
    closer: null,
    setCloser(fn) { this.closer = typeof fn === 'function' ? fn : null; },
    close(reason = 'closed') {
      if (this.closed) return;
      this.closed = true;
      try { if (this.closer) this.closer(reason); } catch {}
      if (activeIptvLiveStreams.get(key) === this) activeIptvLiveStreams.delete(key);
      if (reason === 'retuned') console.log(`[iptv live] closed previous stream before tuning ${label}`);
    },
    done() {
      if (this.closed) return;
      this.closed = true;
      if (activeIptvLiveStreams.get(key) === this) activeIptvLiveStreams.delete(key);
    },
  };
  activeIptvLiveStreams.set(key, entry);
  return entry;
}
function closeAllIptvLiveStreams(reason = 'shutdown') {
  for (const slot of [...activeIptvLiveStreams.values()]) {
    if (slot && typeof slot.close === 'function') slot.close(reason);
  }
  activeIptvLiveStreams.clear();
}
function iptvSafeHost(raw) {
  try { return new URL(String(raw || '')).host || 'unknown'; }
  catch {
    return String(raw || '')
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .replace(/[^\w.:-]/g, '')
      .slice(0, 80) || 'unknown';
  }
}
function iptvChannelLogLabel(ch = {}) {
  const idx = Number.isInteger(ch.idx) ? `#${ch.idx}` : '#?';
  const name = String(ch.name || 'channel').replace(/[\r\n]+/g, ' ').slice(0, 80);
  const stream = ch.xtreamId !== undefined && ch.xtreamId !== null && ch.xtreamId !== '' ? ` stream=${ch.xtreamId}` : '';
  return `${idx} "${name}"${stream}`;
}
function sanitizeIptvLogError(err) {
  return sanitizeIptvFfmpegError(err && err.message ? err.message : err) || 'unknown error';
}
function iptvNativeFailureReason(status, body) {
  const text = String(body || '').toLowerCase();
  if (text.includes('bot-protection') || text.includes('bot protection')) return 'provider bot-protection';
  if (status === 429) return 'provider rate limit';
  if (status === 401 || status === 403) return 'provider rejected this channel';
  if (status === 404) return 'channel is offline';
  return 'live stream unavailable';
}
function iptvNativeFailureCacheTtl(status, reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('bot-protection') || r.includes('rate limit') || status === 429) {
    return IPTV_PROVIDER_PROTECTION_ERROR_TTL_MS;
  }
  if (status === 401 || status === 403) return IPTV_PROVIDER_PROTECTION_ERROR_TTL_MS;
  return IPTV_NATIVE_ERROR_TTL_MS;
}
function logIptvRefreshPaused(channels, label) {
  const now = Date.now();
  if (now - iptvRefreshPausedLogAt < 60000) return;
  iptvRefreshPausedLogAt = now;
  console.log(`[iptv refresh] paused channel refresh during playback; keeping ${channels.length} cached ${label} channel(s)`);
}
function iptvRemuxStatusFromFfmpeg(err) {
  const text = String(err || '');
  const m = /Server returned\s+(\d{3})/i.exec(text) || /HTTP error\s+(\d{3})/i.exec(text);
  return m ? parseInt(m[1], 10) : 0;
}
function iptvRemuxTargets(ch = {}) {
  const out = [];
  const seen = new Set();
  const add = (url, label = '') => {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, label });
  };
  // Xtream panels can reject HLS event URLs even when TS works. The Shield/native path proves
  // TS is the provider-compatible stream, so server remux should try that first too.
  if (ch.nativeUrl && iptvNativeMime(ch.nativeUrl) === 'video/mp2t') add(ch.nativeUrl, 'ts');
  add(ch.url, iptvNativeMime(ch.url) === 'application/x-mpegURL' ? 'hls' : 'primary');
  add(ch.nativeFallbackUrl, 'fallback');
  add(ch.nativeUrl, 'native');
  return out;
}
function iptvRemuxTargetLikelyHls(target = {}) {
  return target.label === 'hls' || target.label === 'fallback' || /\.m3u8(?:[?#]|$)/i.test(target.url || '');
}
function sanitizeIptvFfmpegError(err) {
  return String(err || '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const u = new URL(raw.replace(/[),.;]+$/, ''));
        return `${u.protocol}//${u.host}/redacted`;
      } catch { return '[redacted-url]'; }
    })
    .replace(/\/live\/[^/\s]+\/[^/\s]+\/([^/\s]+)/gi, '/live/redacted/redacted/$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
function sendIptvNativeError(res, status, reason) {
  const code = status >= 400 && status < 600 ? status : 502;
  const body = JSON.stringify({ error: reason });
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-triboon-iptv-error': reason,
  });
  res.end(body);
}
function proxyIptvNative(ctx, target, hops = 0, meta = {}) {
  const slot = beginIptvLiveSlot(ctx, meta);
  let up = null;
  let done = false;
  let delayTimer = null;
  let refreshedForStaleChannel = false;
  const label = iptvNativeLogLabel(meta);
  const stop = (reason = 'closed', err) => {
    if (done) return;
    done = true;
    if (delayTimer) clearTimeout(delayTimer);
    try { if (up) up.destroy(err || new Error(`live stream ${reason}`)); } catch {}
    slot.done(reason);
    ctx.req.off('close', onClientClose);
    ctx.res.off('close', onClientClose);
  };
  const onClientClose = () => stop('client closed');
  const fail = (status, body) => {
    stop('failed');
    if (!ctx.res.headersSent && !ctx.res.destroyed) {
      if (typeof body === 'string') send(ctx.res, status, { error: body });
      else sendIptvNativeError(ctx.res, body.status || status || 502, body.reason || 'live stream unavailable');
    }
  };
  slot.setCloser((reason) => {
    stop(reason, new Error(`live stream ${reason}`));
    try { if (!ctx.res.destroyed) ctx.res.destroy(); } catch {}
  });
  ctx.req.once('close', onClientClose);
  ctx.res.once('close', onClientClose);

  const open = (rawTarget, hop) => {
    if (done || slot.closed) return;
    let u;
    try {
      u = new URL(rawTarget);
      if (!/^https?:$/.test(u.protocol)) throw new Error('unsupported protocol');
    } catch {
      console.error(`[iptv native] ${label} invalid upstream url`);
      return fail(502, 'invalid live stream url');
    }
    if (hop > 5) {
      console.error(`[iptv native] ${label} too many redirects`);
      return fail(502, 'too many live stream redirects');
    }
    const failureKey = idHash(`${u.protocol}//${u.host}${u.pathname}`);
    const cachedFailure = iptvNativeErrorCache.get(failureKey);
    if (cachedFailure && cachedFailure.until > Date.now()) {
      if (!refreshedForStaleChannel && [401, 403, 429].includes(cachedFailure.status)) {
        refreshedForStaleChannel = true;
        const staleCh = iptvCache.channels && Number.isInteger(meta.idx) ? iptvCache.channels[meta.idx] : null;
        refreshXtreamChannelForPlayback(staleCh, `cached native HTTP ${cachedFailure.status}`)
          .then((nextCh) => {
            const nextTarget = nextCh
              ? (meta.alt && nextCh.nativeFallbackUrl ? nextCh.nativeFallbackUrl : (nextCh.nativeUrl || nextCh.url))
              : '';
            if (nextTarget && nextTarget !== rawTarget && !done && !slot.closed) {
              console.error(`[iptv native] ${label} retrying refreshed Xtream channel #${nextCh.idx} "${nextCh.name}" after cached failure`);
              open(nextTarget, hop + 1);
              return;
            }
            fail(cachedFailure.status, cachedFailure);
          })
          .catch((e) => {
            console.error(`[iptv refresh] cached native failure refresh failed: ${sanitizeIptvLogError(e)}`);
            fail(cachedFailure.status, cachedFailure);
          });
        return;
      }
      return fail(cachedFailure.status, cachedFailure);
    }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'user-agent': IPTV_NATIVE_PROXY_UA,
      accept: '*/*',
      connection: 'close',
    };
    if (ctx.req.headers.range) headers.range = ctx.req.headers.range;
    up = lib.request(u, { method: 'GET', headers, agent: false }, (r) => {
      if (done || slot.closed) { r.resume(); return; }
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return open(new URL(r.headers.location, u).href, hop + 1);
      }
      if ((r.statusCode || 0) >= 400) {
        const chunks = [];
        let len = 0;
        r.on('data', (c) => {
          if (len < 2048) chunks.push(c.slice(0, Math.max(0, 2048 - len)));
          len += c.length;
        });
        r.on('end', async () => {
          if (done || slot.closed) return;
          const body = Buffer.concat(chunks).toString('utf8');
          const status = r.statusCode || 502;
          const reason = iptvNativeFailureReason(status, body);
          if (!refreshedForStaleChannel && (status === 401 || status === 403)) {
            refreshedForStaleChannel = true;
            const staleCh = iptvCache.channels && Number.isInteger(meta.idx) ? iptvCache.channels[meta.idx] : null;
            const nextCh = await refreshXtreamChannelForPlayback(staleCh, `native HTTP ${status}`);
            const nextTarget = nextCh
              ? (meta.alt && nextCh.nativeFallbackUrl ? nextCh.nativeFallbackUrl : (nextCh.nativeUrl || nextCh.url))
              : '';
            if (nextTarget && nextTarget !== rawTarget && !done && !slot.closed) {
              console.error(`[iptv native] ${label} retrying refreshed Xtream channel #${nextCh.idx} "${nextCh.name}"`);
              return open(nextTarget, hop + 1);
            }
          }
          iptvNativeErrorCache.set(failureKey, {
            status,
            reason,
            until: Date.now() + iptvNativeFailureCacheTtl(status, reason),
          });
          if (iptvNativeErrorCache.size > 2000) iptvNativeErrorCache = new Map([...iptvNativeErrorCache].slice(-1000));
          console.error(`[iptv native] ${label} upstream HTTP ${status} (${reason})`);
          fail(status, { status, reason });
        });
        return;
      }
      const out = {
        'content-type': r.headers['content-type'] || 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        if (r.headers[h]) out[h] = r.headers[h];
      }
      ctx.res.writeHead(r.statusCode || 502, out);
      r.on('end', () => {
        if (!ctx.res.destroyed && !ctx.res.writableEnded) ctx.res.end();
        stop('upstream ended');
      });
      r.pipe(ctx.res, { end: false });
    });
    slot.setCloser((reason) => {
      stop(reason, new Error(`live stream ${reason}`));
      try { if (!ctx.res.destroyed) ctx.res.destroy(); } catch {}
    });
    up.on('error', (e) => {
      if (done || slot.closed || /live stream (retuned|client closed|shutdown)/i.test(String(e && e.message))) return;
      console.error(`[iptv native] ${label} upstream error: ${String(e.message).slice(0, 160)}`);
      if (!ctx.res.headersSent) send(ctx.res, 502, { error: 'live stream failed' });
      else try { ctx.res.destroy(e); } catch {}
      stop('upstream error');
    });
    up.setTimeout(15000, () => up.destroy(new Error('live stream upstream timeout')));
    up.end();
  };

  if (slot.replaced && hops === 0) {
    delayTimer = setTimeout(() => { delayTimer = null; open(target, hops); }, IPTV_LIVE_RETUNE_GRACE_MS);
    delayTimer.unref();
  } else {
    open(target, hops);
  }
}
let iptvRefreshing = false;
let iptvWarmRunning = false;
let iptvWarmTimer = null;
let iptvWarmSoonTimer = null;
let iptvPlaybackRefreshPromise = null;
function iptvSourceKey(s) {
  const mode = s.iptvMode === 'xtream' ? 'xt' : 'm3u';
  const source = mode === 'xt'
    ? `${s.xtHost || ''}|${s.xtUser || ''}|${s.xtPass || ''}`
    : `${s.iptvUrl || ''}`;
  return `${cleanIptvSourceId(s.id)}:${mode}:${idHash(source)}`;
}
function epgSourceKey(s) {
  return idHash(`${iptvSourceKey(s)}|epg:${xmltvGuideUrl(s) || ''}`);
}
function xmltvGuideUrl(s) {
  if (s.epgUrl) return s.epgUrl;
  if (s.iptvMode !== 'xtream' || !s.xtHost || !s.xtUser || !s.xtPass) return '';
  const base = String(s.xtHost || '').replace(/\/+$/, '');
  return `${base}/xmltv.php?username=${encodeURIComponent(s.xtUser || '')}&password=${encodeURIComponent(s.xtPass || '')}`;
}
function iptvPlaybackNameKey(s) {
  return String(s || '').toLowerCase()
    .replace(/^\s*\|[a-z]{2,3}\|\s*/i, '')
    .replace(/^\s*[a-z]{2,3}\s*[:|-]\s*/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(uhd|fhd|hd|sd|4k|8k|1080p?|720p?|h26[45]|hevc|raw|vip|backup)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, '');
}
function findRefreshedXtreamChannel(staleCh, channels) {
  if (!staleCh || !Array.isArray(channels) || !channels.length) return null;
  const staleId = String(staleCh.id || '');
  const staleStream = String(staleCh.xtreamId || '');
  const byId = staleId ? channels.find((c) => String(c.id || '') === staleId) : null;
  if (byId) return byId;
  const key = iptvPlaybackNameKey(staleCh.name);
  if (!key) return null;
  const matches = channels.filter((c) => iptvPlaybackNameKey(c.name) === key);
  if (!matches.length) return null;
  if (staleCh.group) {
    const groupKey = iptvPlaybackNameKey(staleCh.group);
    const sameGroup = matches.find((c) => iptvPlaybackNameKey(c.group) === groupKey);
    if (sameGroup) return sameGroup;
  }
  return matches.find((c) => String(c.xtreamId || '') !== staleStream) || matches[0];
}
function persistXtreamChannelCache(key, channels, sourceId = IPTV_LEGACY_SOURCE_ID) {
  try {
    writeIptvDiskCache(sourceId, {
      key,
      at: Date.now(),
      channels: channels.map(({ url: _u, nativeUrl: _nu, nativeFallbackUrl: _nfu, ...c }) => c),
    });
  } catch {}
}
function xtreamPanelFetchOptions(opts = {}) {
  return {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent': IPTV_NATIVE_PROXY_UA,
    },
  };
}
function xtreamM3uPlaylistUrl(s) {
  const base = String(s.xtHost || '').replace(/\/+$/, '');
  return `${base}/get.php?username=${encodeURIComponent(s.xtUser || '')}&password=${encodeURIComponent(s.xtPass || '')}&output=ts&type=m3u_plus&_=${Date.now().toString(36)}`;
}
function xtreamIdFromStreamUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    const m = /\/live\/[^/]+\/[^/]+\/(\d+)\.(?:ts|m3u8)(?:$|[?#])/i.exec(u.pathname);
    return m ? m[1] : '';
  } catch { return ''; }
}
async function fetchXtreamM3uChannelsForPlayback(s, key, reason) {
  const list = await fetchM3uChannelsStream(xtreamM3uPlaylistUrl(s), {
    maxChannels: 20000,
    timeoutMs: 15000,
    deadlineMs: 90000,
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent': IPTV_NATIVE_PROXY_UA,
    },
  });
  const channels = list.map((c, i) => {
    const xtreamId = xtreamIdFromStreamUrl(c.url);
    if (!xtreamId) return { ...c, idx: i };
    return {
      ...c,
      idx: i,
      id: 'xt' + xtreamId,
      xtreamId,
      ...xtChannelUrls(s, xtreamId),
    };
  }).filter((c) => c.xtreamId);
  if (channels.length) {
    const sourceId = cleanIptvSourceId(s.id);
    const nextCache = { key, at: Date.now(), channels };
    iptvSourceCaches.set(sourceId, nextCache);
    persistXtreamChannelCache(key, channels, sourceId);
    clearIptvAggregateCache();
    console.error(`[iptv refresh] Xtream M3U fallback refreshed ${channels.length} channel(s) after ${reason}`);
  }
  return channels;
}
async function refreshXtreamChannelForPlayback(staleCh, reason = 'playback rejection') {
  const s = sourceForIptvChannel(staleCh) || iptvSourcesFromSettings(settings.get())[0] || settings.get();
  if (s.iptvMode !== 'xtream' || !staleCh || !staleCh.xtreamId) return null;
  const key = iptvSourceKey(s);
  const sourceId = cleanIptvSourceId(s.id);
  if (!iptvPlaybackRefreshPromise || iptvPlaybackRefreshPromise.sourceId !== sourceId) {
    iptvPlaybackRefreshPromise = fetchIptvChannels(s, key)
      .catch((e) => {
        console.error(`[iptv refresh] forced Xtream channel refresh failed after ${reason}: ${sanitizeIptvLogError(e)}`);
        return [];
      })
      .finally(() => { iptvPlaybackRefreshPromise = null; });
    iptvPlaybackRefreshPromise.sourceId = sourceId;
  }
  const channels = await iptvPlaybackRefreshPromise;
  let next = findRefreshedXtreamChannel(staleCh, channels);
  let source = 'API';
  if (!next || String(next.xtreamId || '') === String(staleCh.xtreamId || '')) {
    try {
      const m3uChannels = await fetchXtreamM3uChannelsForPlayback(s, key, reason);
      const m3uNext = findRefreshedXtreamChannel(staleCh, m3uChannels);
      if (m3uNext) {
        next = m3uNext;
        source = 'M3U';
      }
    } catch (e) {
      console.error(`[iptv refresh] Xtream M3U fallback failed after ${reason}: ${sanitizeIptvLogError(e)}`);
    }
  }
  if (!next) {
    console.error(`[iptv refresh] forced Xtream channel refresh found no replacement after ${reason}: "${staleCh.name}" stream=${staleCh.xtreamId}`);
    return null;
  }
  if (String(next.xtreamId || '') === String(staleCh.xtreamId || '')) {
    console.error(`[iptv refresh] forced Xtream channel refresh kept same stream after ${reason}: "${staleCh.name}" stream=${staleCh.xtreamId}`);
    return null;
  }
  console.error(`[iptv refresh] stale Xtream channel refreshed via ${source} after ${reason}: "${staleCh.name}" stream=${staleCh.xtreamId} -> stream=${next.xtreamId}`);
  return next;
}
function sourceForIptvChannel(ch = {}) {
  const id = ch && ch.sourceId ? cleanIptvSourceId(ch.sourceId) : IPTV_LEGACY_SOURCE_ID;
  return iptvSourcesFromSettings(settings.get()).find((src) => src.id === id) || null;
}
function scopeIptvChannels(src, channels) {
  const sourceId = cleanIptvSourceId(src.id);
  return (channels || []).slice(0, 20000).map((c, i) => {
    const rawId = String(c.sourceRawId || c.id || c.xtreamId || idHash(c.url || `${c.name}:${i}`));
    const scopedId = rawId.startsWith(`${sourceId}:`) ? rawId : `${sourceId}:${rawId}`;
    const sourceGroup = c.sourceGroup || c.group || 'Other';
    return {
      ...c,
      id: scopedId,
      sourceRawId: rawId.startsWith(`${sourceId}:`) ? rawId.slice(sourceId.length + 1) : rawId,
      sourceId,
      sourceName: src.name,
      sourceIdx: Number.isInteger(c.sourceIdx) ? c.sourceIdx : i,
      idx: i,
      sourceGroup,
      group: sourceGroup,
    };
  });
}
function aggregateIptvChannels(rows) {
  const activeRows = rows.filter((r) => r && Array.isArray(r.channels) && r.channels.length);
  const multiple = activeRows.length > 1;
  let idx = 0;
  return activeRows.flatMap(({ src, channels }) => channels.map((c) => {
    const sourceGroup = c.sourceGroup || c.group || 'Other';
    return {
      ...c,
      idx: idx++,
      sourceIdx: Number.isInteger(c.sourceIdx) ? c.sourceIdx : c.idx,
      group: multiple ? `${src.name} · ${sourceGroup}` : sourceGroup,
      sourceGroup,
    };
  }));
}
function sourceCacheLabel(src, channels) {
  return `${src.iptvMode === 'xtream' ? 'Xtream' : 'playlist'} source=${src.name} channels=${channels.length}`;
}
async function backgroundRefreshIptvSource(src, key, cachedChannels, label) {
  const sourceId = cleanIptvSourceId(src.id);
  if (iptvRefreshingSources.has(sourceId)) return;
  if (iptvPlaybackBusy()) {
    logIptvRefreshPaused(cachedChannels, label);
    return;
  }
  iptvRefreshingSources.add(sourceId);
  fetchIptvChannels(src, key)
    .then(() => clearIptvAggregateCache())
    .catch((e) => {
      console.error(`[iptv refresh] background channel refresh failed; keeping cached ${sourceCacheLabel(src, cachedChannels)}: ${sanitizeIptvLogError(e)}`);
      const hit = iptvSourceCaches.get(sourceId);
      if (hit) hit.at = Date.now() - (IPTV_CACHE_TTL_MS - 600000);
    })
    .finally(() => { iptvRefreshingSources.delete(sourceId); });
}
async function loadIptvChannelsForSource(src) {
  const sourceId = cleanIptvSourceId(src.id);
  const key = iptvSourceKey(src);
  const hit = iptvSourceCaches.get(sourceId);
  if (hit && hit.key === key && Date.now() - hit.at < IPTV_CACHE_TTL_MS) return hit.channels;
  if (hit && hit.key === key && hit.channels.length) {
    backgroundRefreshIptvSource(src, key, hit.channels, src.iptvMode === 'xtream' ? 'Xtream' : 'playlist');
    return hit.channels;
  }
  if (src.iptvMode === 'xtream') {
    const disk = readIptvDiskCaches()[sourceId];
    const channels = disk && disk.key === key ? scopeIptvChannels(src, hydrateXtreamCachedChannels(src, disk.channels)) : [];
    if (channels.length) {
      const next = { key, at: Number(disk.at) || 0, channels };
      iptvSourceCaches.set(sourceId, next);
      backgroundRefreshIptvSource(src, key, channels, 'persisted Xtream');
      return channels;
    }
  }
  try {
    return await fetchIptvChannels(src, key);
  } catch (e) {
    const disk = readIptvDiskCaches()[sourceId];
    if (src.iptvMode === 'xtream' && disk && disk.key === key && Array.isArray(disk.channels) && disk.channels.length) {
      const ageMin = Math.max(0, Math.round((Date.now() - (Number(disk.at) || 0)) / 60000));
      console.error(`[iptv] Xtream source failed; serving last cached playlist source=${src.name} channels=${disk.channels.length} age=${ageMin}m: ${sanitizeIptvLogError(e)}`);
      const channels = scopeIptvChannels(src, hydrateXtreamCachedChannels(src, disk.channels));
      iptvSourceCaches.set(sourceId, { key, at: Date.now() - (IPTV_CACHE_TTL_MS - 600000), channels });
      return channels;
    }
    throw e;
  }
}
async function loadIptvChannels(sources = iptvSourcesFromSettings(settings.get())) {
  const usable = (sources || []).filter(iptvSourceConfigured);
  if (!usable.length) {
    clearIptvAggregateCache();
    return [];
  }
  const aggregateKey = usable.map((src) => `${src.id}:${iptvSourceKey(src)}`).join('|');
  if (iptvCache.key === aggregateKey && Date.now() - iptvCache.at < IPTV_CACHE_TTL_MS) return iptvCache.channels;
  const rows = [];
  const errors = [];
  await mapLimit(usable, Math.min(3, usable.length), async (src) => {
    try {
      rows.push({ src, channels: await loadIptvChannelsForSource(src) });
    } catch (e) {
      errors.push({ src, error: e });
      console.error(`[iptv] source "${src.name}" failed: ${sanitizeIptvLogError(e)}`);
    }
  });
  if (!rows.length && errors.length) throw errors[0].error;
  const channels = aggregateIptvChannels(rows);
  iptvCache = { key: aggregateKey, at: Date.now(), channels };
  return channels;
}
function m3uAttr(meta, name) {
  const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(meta);
  return m ? m[1] : '';
}
function m3uChannelFromPair(meta, streamUrl, idx) {
  const name = (meta.split(',').pop() || '').trim();
  if (!name || !/^https?:\/\//i.test(streamUrl)) return null;
  return {
    idx,
    id: idHash(streamUrl),
    name,
    logo: m3uAttr(meta, 'tvg-logo'),
    group: m3uAttr(meta, 'group-title') || 'Other',
    tvgId: m3uAttr(meta, 'tvg-id'),
    url: streamUrl,
  };
}
function fetchM3uChannelsStream(playlistUrl, opts = {}) {
  const maxChannels = opts.maxChannels || 20000;
  const maxBytes = opts.maxBytes || 768 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs || 15000;
  const deadlineMs = opts.deadlineMs || 180000;
  const redirects = opts.redirects || 0;
  if (redirects > 5) return Promise.reject(new Error('m3u playlist has too many redirects'));
  let u;
  try { u = new URL(playlistUrl); } catch { return Promise.reject(new Error('invalid m3u playlist url')); }
  if (!['http:', 'https:'].includes(u.protocol)) return Promise.reject(new Error('invalid m3u playlist protocol'));
  return new Promise((resolve, reject) => {
    const channels = [];
    const decoder = new StringDecoder('utf8');
    const client = u.protocol === 'https:' ? https : http;
    let settled = false, bytes = 0, carry = '', pendingMeta = null, req = null, resRef = null;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { if (req) req.destroy(); } catch {}
      try { if (resRef) resRef.destroy(); } catch {}
      if (err) reject(err); else resolve(channels);
    };
    const consumeLine = (lineRaw) => {
      const line = String(lineRaw || '').trim();
      if (!line) return;
      if (line.startsWith('#EXTINF')) { pendingMeta = line; return; }
      if (line.startsWith('#')) return;
      if (!pendingMeta) return;
      const ch = m3uChannelFromPair(pendingMeta, line, channels.length);
      pendingMeta = null;
      if (ch) channels.push(ch);
      if (channels.length >= maxChannels) done();
    };
    const deadline = setTimeout(() => done(new Error(`m3u playlist timed out after ${Math.round(deadlineMs / 1000)}s`)), deadlineMs);
    req = client.get(u, { headers: { ...(opts.headers || {}), 'user-agent': (opts.headers && opts.headers['user-agent']) || IPTV_NATIVE_PROXY_UA } }, (res) => {
      resRef = res;
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        res.resume();
        try {
          const nextUrl = new URL(res.headers.location, u).toString();
          settled = true;
          clearTimeout(deadline);
          fetchM3uChannelsStream(nextUrl, { ...opts, redirects: redirects + 1 }).then(resolve, reject);
        } catch { reject(new Error('invalid m3u playlist redirect')); }
        return;
      }
      if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
        res.resume();
        done(new Error(`m3u playlist HTTP ${res.statusCode || 0}`));
        return;
      }
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) return done(new Error(`m3u playlist too large (>${maxBytes} bytes)`));
        carry += decoder.write(chunk);
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() || '';
        for (const line of lines) {
          consumeLine(line);
          if (settled) return;
        }
      });
      res.on('end', () => {
        carry += decoder.end();
        if (carry) consumeLine(carry);
        done();
      });
      res.on('error', (e) => done(e));
    });
    req.on('error', (e) => done(e));
    req.setTimeout(timeoutMs, () => done(new Error('m3u playlist upstream timeout')));
  });
}
async function fetchIptvChannels(s, key) {
  const sourceId = cleanIptvSourceId(s.id);
  const curXt = xtreamEpgSourceCaches.get(sourceId);
  if (!curXt || curXt.key !== key) xtreamEpgSourceCaches.delete(sourceId);
  let channels = [];
  if (s.iptvMode === 'xtream' && s.xtHost) {
    const base = String(s.xtHost).replace(/\/+$/, '');
    const apiBase = `${base}/player_api.php?username=${encodeURIComponent(s.xtUser || '')}&password=${encodeURIComponent(s.xtPass || '')}`;
    const fetchPanel = async (action, opts) => {
      try {
        const u = `${apiBase}&action=${action}&_=${Date.now().toString(36)}`;
        const r = await fetchUrlExt(u, xtreamPanelFetchOptions(opts));
        if ((r.status || 0) >= 400) {
          const body = r.body.toString('utf8', 0, 2048);
          throw new Error(`HTTP ${r.status} (${iptvNativeFailureReason(r.status || 502, body)})`);
        }
        return r;
      } catch (e) {
        throw new Error(`Xtream channel load action=${action} host=${iptvSafeHost(s.xtHost)} failed: ${sanitizeIptvLogError(e)}`);
      }
    };
    const [catsR, streamsR] = await Promise.all([
      fetchPanel('get_live_categories', { timeoutMs: 10000, deadlineMs: 25000, maxBytes: 5 * 1024 * 1024 }),
      fetchPanel('get_live_streams', { timeoutMs: 10000, deadlineMs: 40000, maxBytes: 30 * 1024 * 1024 }),
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
      ...xtChannelUrls(s, x.stream_id),
    }));
  } else if (s.iptvUrl) {
    // Real-world playlists can exceed 500MB because providers mix live, FAST, VOD, and
    // series in one file. Stream-parse and stop at the channel cap instead of buffering it.
    channels = await fetchM3uChannelsStream(s.iptvUrl, { maxChannels: 20000 });
  }
  channels = scopeIptvChannels(s, channels);
  iptvSourceCaches.set(sourceId, { key, at: Date.now(), channels });
  // Persist Xtream playlists for restart survival — WITHOUT credential-bearing stream URLs
  // (rebuilt from encrypted settings on read). M3U playlists may embed third-party tokens
  // in every line, so those stay memory-only.
  if (s.iptvMode === 'xtream') {
    persistXtreamChannelCache(key, channels, sourceId);
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
    const sourceId = cleanIptvSourceId(cache.sourceId);
    const body = {
      key: cache.key,
      at: cache.at,
      byChannel: [...cache.byChannel.entries()],
      byName: [...cache.byName.entries()],
    };
    store.update('epgcaches', {}, (all) => { all[sourceId] = body; return all; });
    if (sourceId === IPTV_LEGACY_SOURCE_ID) store.write('epgcache', body);
  } catch {}
}
function refreshXmltvInBackground(s, key, sourceChannels) {
  const sourceId = cleanIptvSourceId(s.id);
  if (epgRefreshingSources.has(sourceId)) return;
  epgRefreshingSources.add(sourceId);
  fetchXmltv(s, key, sourceChannels).catch((e) => console.error('[xmltv refresh]', e.message))
    .finally(() => { epgRefreshingSources.delete(sourceId); });
}
async function ensureXmltv(s = iptvSourcesFromSettings(settings.get())[0], sourceChannels = null) {
  const xmltvUrl = xmltvGuideUrl(s);
  if (!xmltvUrl) return null;
  const sourceId = cleanIptvSourceId(s.id);
  const key = epgSourceKey(s);
  const hit = epgSourceCaches.get(sourceId);
  if (hit && hit.key === key && Date.now() - hit.at < EPG_CACHE_TTL_MS) return hit;
  if (hit && hit.key === key && hit.byChannel && hit.byChannel.size) {
    refreshXmltvInBackground(s, key, sourceChannels);
    return hit;
  }
  const diskAll = store.read('epgcaches', {});
  const diskRaw = diskAll && diskAll[sourceId] ? diskAll[sourceId] : (sourceId === IPTV_LEGACY_SOURCE_ID ? store.read('epgcache', null) : null);
  const disk = hydrateXmltvCache(diskRaw, key);
  if (disk && disk.byChannel.size) {
    disk.sourceId = sourceId;
    epgSourceCaches.set(sourceId, disk);
    epgCache = disk;
    if (Date.now() - disk.at >= EPG_CACHE_TTL_MS) refreshXmltvInBackground(s, key, sourceChannels);
    return disk;
  }
  return fetchXmltv(s, key, sourceChannels);
}
let epgRefreshing = false;
let epgRefreshingSources = new Set();
async function fetchXmltv(s, key = epgSourceKey(s), sourceChannels = null) {
  const xmltvUrl = xmltvGuideUrl(s);
  if (!xmltvUrl) return null;
  const r = await fetchUrlExt(xmltvUrl, { timeoutMs: 20000, deadlineMs: 90000, maxBytes: 128 * 1024 * 1024 });
  let xml = r.body;
  if (xml.length > 120 * 1024 * 1024) xml = xml.subarray(0, 120 * 1024 * 1024); // parse cap
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
  const carried = sourceChannels || (iptvSourceCaches.get(cleanIptvSourceId(s.id)) || {}).channels || [];
  for (const c of carried) {
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
  epgCache = { key, sourceId: cleanIptvSourceId(s.id), at: Date.now(), byChannel, byName };
  epgSourceCaches.set(epgCache.sourceId, epgCache);
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
function maybeB64(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) return raw;
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/\0/g, '').trim();
    if (!decoded || decoded.includes('\uFFFD') || !/[a-z0-9]/i.test(decoded)) return raw;
    const printable = decoded.replace(/[^\x20-\x7e]/g, '').length / Math.max(1, decoded.length);
    return printable > 0.85 ? decoded : raw;
  } catch { return raw; }
}
function parseXtreamTime(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = +v;
    return n > 100000000000 ? n : n * 1000;
  }
  const s = String(v).trim();
  const parsed = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}
function xtreamProgramme(e) {
  if (!e) return null;
  const title = maybeB64(e.title || e.name);
  const start = parseXtreamTime(e.start_timestamp ?? e.start ?? e.start_time);
  const stop = parseXtreamTime(e.stop_timestamp ?? e.end_timestamp ?? e.stop ?? e.end ?? e.end_time);
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
function hydrateXtreamEpgCache(key, sourceId = IPTV_LEGACY_SOURCE_ID) {
  const sid = cleanIptvSourceId(sourceId);
  const all = store.read('xtreamepgcaches', {});
  const raw = all && all[sid] ? all[sid] : (sid === IPTV_LEGACY_SOURCE_ID ? store.read('xtreamepgcache', null) : null);
  if (!raw || raw.key !== xtreamEpgStoreKey(key) || !Array.isArray(raw.streams)) {
    const empty = { key, sourceId: sid, byStream: new Map() };
    xtreamEpgSourceCaches.set(sid, empty);
    xtreamEpgCache = empty;
    return empty;
  }
  const byStream = new Map();
  for (const [id, entry] of raw.streams) {
    if (!entry || !Array.isArray(entry.list)) continue;
    const at = Number(entry.at) || 0;
    if (at && Date.now() - at <= EPG_CACHE_STALE_MS) byStream.set(String(id), { at, list: entry.list });
  }
  xtreamEpgCache = { key, sourceId: sid, byStream };
  xtreamEpgSourceCaches.set(sid, xtreamEpgCache);
  return xtreamEpgCache;
}
function persistXtreamEpgCache(cache = xtreamEpgCache) {
  try {
    const sourceId = cleanIptvSourceId(cache.sourceId);
    const streams = [...cache.byStream.entries()]
      .filter(([, e]) => e && Array.isArray(e.list) && e.list.length)
      .slice(-5000)
      .map(([id, e]) => [id, { at: Number(e.at) || 0, list: e.list }]);
    const body = { key: xtreamEpgStoreKey(cache.key), at: Date.now(), streams };
    store.update('xtreamepgcaches', {}, (all) => { all[sourceId] = body; return all; });
    if (sourceId === IPTV_LEGACY_SOURCE_ID) store.write('xtreamepgcache', body);
  } catch {}
}
async function fetchXtreamEpgAction(s, ch, limit, action, timeouts = {}) {
  const base = String(s.xtHost).replace(/\/+$/, '');
  const u = `${base}/player_api.php?username=${encodeURIComponent(s.xtUser || '')}&password=${encodeURIComponent(s.xtPass || '')}&action=${action}&stream_id=${ch.xtreamId}&limit=${Math.max(2, Math.min(48, limit))}`;
  let r;
  try {
    r = await fetchUrlExt(u, { timeoutMs: timeouts.timeoutMs || 8000, deadlineMs: timeouts.deadlineMs || 15000, maxBytes: 2 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`action=${action} host=${iptvSafeHost(s.xtHost)} failed: ${sanitizeIptvLogError(e)}`);
  }
  if ((r.status || 0) >= 400) {
    const body = r.body.toString('utf8', 0, 2048);
    throw new Error(`action=${action} host=${iptvSafeHost(s.xtHost)} HTTP ${r.status} (${iptvNativeFailureReason(r.status || 502, body)})`);
  }
  let json, raw;
  try {
    json = JSON.parse(r.body.toString('utf8') || '{}');
    raw = Array.isArray(json) ? json : (json.epg_listings || json.epg || json.listings || json.programmes || json.programs || []);
    if (raw && !Array.isArray(raw) && typeof raw === 'object') raw = Object.values(raw);
  } catch { raw = []; }
  return raw.map(xtreamProgramme).filter(Boolean).sort((a, b) => a.start - b.start);
}
async function fetchXtreamEpgList(s, ch, limit) {
  const short = await fetchXtreamEpgAction(s, ch, limit, 'get_short_epg');
  if (short.length) return short;
  try {
    return await fetchXtreamEpgAction(s, ch, limit, 'get_simple_data_table', { timeoutMs: 5000, deadlineMs: 9000 });
  } catch (e) {
    console.error(`[iptv xtream guide] ${iptvChannelLogLabel(ch)} simple-table fallback failed; using empty guide: ${sanitizeIptvLogError(e)}`);
    return short;
  }
}
async function xtreamEpgList(ch, { limit = 24, allowBusy = false } = {}) {
  const s = sourceForIptvChannel(ch) || iptvSourcesFromSettings(settings.get())[0] || settings.get();
  if (s.iptvMode !== 'xtream' || !ch.xtreamId) return [];
  const sourceId = cleanIptvSourceId(s.id);
  const key = iptvSourceKey(s);
  let cache = xtreamEpgSourceCaches.get(sourceId);
  if (!cache || cache.key !== key) cache = hydrateXtreamEpgCache(key, sourceId);
  const id = String(ch.xtreamId);
  const hit = cache.byStream.get(id);
  if (hit && Date.now() - hit.at < (hit.list && hit.list.length ? EPG_CACHE_TTL_MS : EPG_EMPTY_TTL_MS)) return hit.list;
  if (iptvPlaybackBusy() && !allowBusy) return hit && hit.list ? hit.list : [];
  if (hit && hit.list && hit.list.length && Date.now() - hit.at <= EPG_CACHE_STALE_MS) {
    if (!hit.promise) {
      const p = fetchXtreamEpgList(s, ch, limit).then((list) => {
        cache.byStream.set(id, { at: Date.now(), list });
        if (cache.byStream.size > 5000) cache.byStream.clear();
        if (list.length) persistXtreamEpgCache(cache);
        return list;
      }).catch((e) => {
        // Stale-cache refresh is fire-and-forget; provider timeouts must not surface as
        // unhandled rejections that can kill the container.
        const ageMin = Math.max(0, Math.round((Date.now() - hit.at) / 60000));
        console.error(`[iptv xtream guide] ${iptvChannelLogLabel(ch)} refresh failed; serving stale cache age=${ageMin}m: ${sanitizeIptvLogError(e)}`);
        cache.byStream.set(id, { at: hit.at, list: hit.list });
        return hit.list;
      });
      cache.byStream.set(id, { ...hit, promise: p });
    }
    return hit.list;
  }
  if (hit && hit.promise) return hit.promise;
  const p = fetchXtreamEpgList(s, ch, limit).then((list) => {
    cache.byStream.set(id, { at: Date.now(), list });
    if (cache.byStream.size > 5000) cache.byStream.clear();
    if (list.length) persistXtreamEpgCache(cache);
    return list;
  });
  cache.byStream.set(id, { at: 0, list: hit ? hit.list : [], promise: p });
  try {
    return await p;
  } catch (e) {
    console.error(`[iptv xtream guide] ${iptvChannelLogLabel(ch)} fetch failed; using ${hit && hit.list ? 'previous cache' : 'channel-title fallback'}: ${sanitizeIptvLogError(e)}`);
    cache.byStream.delete(id);
    if (hit) return hit.list;
    return [];
  }
}
async function epgNowNext(ch) {
  const s = sourceForIptvChannel(ch) || iptvSourcesFromSettings(settings.get())[0] || settings.get();
  if (s.iptvMode === 'xtream' && ch.xtreamId) {
    const list = await xtreamEpgList(ch, { limit: 24, allowBusy: true });
    const now = Date.now();
    const i = list.findIndex((p) => p.start <= now && p.stop > now);
    if (i !== -1) return { now: list[i], next: list[i + 1] || null };
    const next = list.find((p) => p.start > now);
    if (next) return { now: null, next };
  }
  if (xmltvGuideUrl(s)) {
    const epg = await ensureXmltv(s, (iptvSourceCaches.get(cleanIptvSourceId(s.id)) || {}).channels || []);
    const list = xmltvListFor(epg, ch);
    const now = Date.now();
    const i = list.findIndex((p) => p.start <= now && p.stop > now);
    if (i === -1) return {};
    return { now: list[i], next: list[i + 1] || null };
  }
  return {};
}
function xtreamGuideWarmTargets(channels, cache = xtreamEpgCache) {
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
  const cachedStreams = cache.byStream && cache.byStream.size
    ? new Set([...cache.byStream.keys()].map(String)) : new Set();
  for (const ch of channels) if (cachedStreams.has(String(ch.xtreamId))) add(ch);
  channels.slice(0, 48).forEach(add);
  return out.slice(0, IPTV_WARM_XTREAM_GUIDE_MAX);
}
async function warmIptvCaches(reason = 'scheduled') {
  if (iptvWarmRunning) return { configured: iptvConfigured(settings.get()), skipped: 'running' };
  const sources = iptvSourcesFromSettings(settings.get());
  if (!sources.length) return { configured: false };
  iptvWarmRunning = true;
  try {
    const result = { configured: true, reason, channels: 0, sources: 0, xmltv: false, xtreamGuide: 0 };
    await mapLimit(sources, Math.min(3, sources.length), async (src) => {
      const channels = await loadIptvChannelsForSource(src);
      result.channels += channels.length;
      result.sources++;
      if (xmltvGuideUrl(src)) {
        await ensureXmltv(src, channels);
        result.xmltv = true;
      }
      if (src.iptvMode === 'xtream') {
        const key = iptvSourceKey(src);
        let cache = xtreamEpgSourceCaches.get(src.id);
        if (!cache || cache.key !== key) cache = hydrateXtreamEpgCache(key, src.id);
        const targets = iptvPlaybackBusy() ? [] : xtreamGuideWarmTargets(channels, cache);
        await mapLimit(targets, 1, async (ch) => {
          if (iptvPlaybackBusy()) return;
          await xtreamEpgList(ch, { limit: 24 });
        });
        result.xtreamGuide += targets.length;
        result.xtreamGuidePaused = result.xtreamGuidePaused || (targets.length === 0 && iptvPlaybackBusy());
      }
    });
    if (sources.length) {
      const cachedRows = sources.map((src) => ({ src, channels: (iptvSourceCaches.get(src.id) || {}).channels || [] }));
      iptvCache = {
        key: sources.map((src) => `${src.id}:${iptvSourceKey(src)}`).join('|'),
        at: Date.now(),
        channels: aggregateIptvChannels(cachedRows),
      };
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
        if (r && r.configured) console.log(`[iptv] warmed ${r.channels || 0} channels${r.xmltv ? ' + XMLTV' : ''}${r.xtreamGuide ? ` + ${r.xtreamGuide} Xtream guide channel(s)` : ''}${r.xtreamGuidePaused ? ' + Xtream guide paused during playback' : ''}`);
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
  for (const k of ['mkv', 'mp4', 'h264', 'hevc', 'dovi', 'av1', 'vp9', 'mpeg2', 'aac', 'ac3', 'eac3', 'dts', 'native', 'lowPower']) {
    caps[k] = !!(raw && raw[k]);
  }
  if (raw && raw.source) caps.source = String(raw.source).slice(0, 64);
  if (raw && raw.model) caps.model = String(raw.model).slice(0, 64);
  if (raw && raw.manufacturer) caps.manufacturer = String(raw.manufacturer).slice(0, 64);
  if (raw && raw.brand) caps.brand = String(raw.brand).slice(0, 64);
  if (raw && raw.device) caps.device = String(raw.device).slice(0, 64);
  if (raw && raw.deviceClass) caps.deviceClass = String(raw.deviceClass).slice(0, 64);
  if (raw && Number.isFinite(Number(raw.ramMb))) caps.ramMb = Math.max(0, Math.min(262144, Math.round(Number(raw.ramMb))));
  return caps;
}
function parseCapsQuery(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(String(raw).slice(0, 4096));
  } catch {
    return {};
  }
}
function budgetAndroidTvCaps(caps = {}) {
  const text = [caps.manufacturer, caps.brand, caps.model, caps.device, caps.deviceClass].filter(Boolean).join(' ').toLowerCase();
  return !!(caps.lowPower || /(^|\s)(onn|walmart)(\s|$|[._-])/i.test(text)
    || /budget-android-tv/i.test(text)
    || (caps.native && caps.ramMb > 0 && caps.ramMb <= 2600 && !/shield|nvidia/i.test(text)));
}
function parseResolutionRank(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
}
function parseLanguageCode(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
  return /^[a-z]{2,3}$/.test(s) ? s : null;
}
function playbackPolicyFor(user, { maxResolutionRank, preferResolutionRank, originalLanguage, preferredAudioLanguage, caps: rawCaps } = {}) {
  let policy = { ...user.policy, ...sizeCaps(), ...scoringPrefs() };
  const caps = parseCaps(rawCaps || {});
  const maxRank = parseResolutionRank(maxResolutionRank);
  if (maxRank !== null) {
    policy = { ...policy, maxResolutionRank: Math.min(user.policy.maxResolutionRank ?? 4, maxRank) };
  }
  const preferRank = parseResolutionRank(preferResolutionRank);
  if (preferRank !== null && preferRank <= (policy.maxResolutionRank ?? 4)) {
    policy = { ...policy, preferResolutionRank: preferRank };
    if (preferRank === 4) policy.exactResolutionRank = 4;
  }
  const original = parseLanguageCode(originalLanguage);
  const preferredAudio = parseLanguageCode(preferredAudioLanguage);
  if (original) policy.originalLanguage = original;
  if (preferredAudio) policy.preferredAudioLanguage = preferredAudio;
  if (caps.native) {
    policy.deviceCaps = caps;
    policy.dolbyVision = !!caps.dovi;
  }
  if (budgetAndroidTvCaps(caps)) {
    // Onn/low-memory TV boxes can decode 4K, but huge remux + HD audio is where playback
    // becomes fragile. Prefer WEB-sized UHD sources; Sources still exposes larger files.
    policy.lowPowerDevice = true;
    policy.deviceClass = caps.deviceClass || 'budget-android-tv';
    const target = (policy.preferResolutionRank ?? policy.maxResolutionRank ?? 4) >= 4 ? 10 : 6;
    policy.sizePreferenceGB = policy.sizePreferenceGB ? Math.min(policy.sizePreferenceGB, target) : target;
  }
  return policy;
}
function sourceDrawerCandidates(candidates) {
  const allowed = candidates.filter((c) => !(c.reasons || []).some((r) => r.startsWith('over-size-cap')));
  const out = new Map();
  const keyOf = (c) => c.pickKey || c.nzbUrl || `${c.indexer || ''}:${c.name}:${c.sizeBytes || ''}`;
  const add = (c) => {
    const key = keyOf(c);
    if (!out.has(key)) out.set(key, c);
  };
  // Best keeps the default press-play order. Largest makes high-quality remuxes visible
  // when they are still under the admin cap, even if size shaping pushed them below row 250.
  allowed.slice(0, 250).forEach(add);
  allowed.filter((c) => c.sizeBytes > 0)
    .sort((a, b) => (b.sizeBytes - a.sizeBytes) || (b.score - a.score))
    .slice(0, 80).forEach(add);
  return [...out.values()].slice(0, 360);
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
function episodeSubtitleQuery(query, season, ep) {
  const base = String(query || '').trim();
  const s = Number(season);
  const e = Number(ep);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s <= 0 || e <= 0) return base;
  if (/\bS\d{1,2}\s*E\d{1,3}\b/i.test(base)) return base;
  return `${base} S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`.trim();
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
function localItemPayload(ctx, libId, item) {
  const { file, artFile, dir, ...rest } = item;
  return {
    ...rest,
    streamUrl: file ? `/api/local/${libId}/${rest.idx}?t=${auth.stableStreamToken(ctx.user.id, `local:${libId}:${rest.idx}`)}` : null,
    playUrl: file ? `/api/local/${libId}/${rest.idx}/play` : null,
    artUrl: artFile ? `/api/local/${libId}/art/${rest.idx}?t=${auth.stableStreamToken(ctx.user.id, `art:${libId}:${rest.idx}`)}` : null,
    thumbUrl: file ? `/api/local/${libId}/thumb/${rest.idx}?t=${auth.stableStreamToken(ctx.user.id, `thumb:${libId}:${rest.idx}`)}` : null,
  };
}
function localItemSorter(sort) {
  if (sort === 'title.asc') return (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
  if (sort === 'year.desc') return (a, b) => (+b.year || 0) - (+a.year || 0);
  if (sort === 'rating.desc') return (a, b) => (+b.rating || 0) - (+a.rating || 0);
  return (a, b) => (b.addedAt || 0) - (a.addedAt || 0);
}
function localMountFor(ctx, libId, idx, caps = {}, playCtx = {}) {
  const found = localItemFor(ctx, libId, idx);
  if (found.error) return found;
  let stat;
  try { stat = fs.statSync(found.item.file); } catch { return { status: 404, error: 'file missing on disk' }; }
  const id = 'l' + idHash(`${libId}:${idx}:${found.item.file}:${stat.size}:${stat.mtimeMs}`);
  const name = path.basename(found.item.file);
  let vf = mounts.get(id);
  if (!vf) {
    vf = {
      id, name, size: stat.size, segmentCount: 1,
      container: 'local', method: null, streamable: true, tags: [], health: { verdict: 'verified' },
      mountedAt: Date.now(), _local: { libId, idx: parseInt(idx, 10), file: found.item.file },
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
  const q = String(playCtx.q || found.item.q || found.item.title || name).trim();
  const season = playCtx.season ?? found.item.s ?? found.item.season;
  const ep = playCtx.ep ?? playCtx.episode ?? found.item.e ?? found.item.ep;
  vf._q = q || name;
  vf._subQuery = episodeSubtitleQuery(vf._q, season, ep);
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
function watchRowsForProfileFromAll(all, uid, profile = 'default') {
  const active = profile || 'default';
  const rows = new Map();
  const add = (prefix, accept) => {
    for (const [fullKey, value] of Object.entries(all)) {
      if (!fullKey.startsWith(prefix) || !accept(value)) continue;
      const key = fullKey.slice(prefix.length);
      rows.set(key, { key, ...value });
    }
  };
  // Trakt is linked to the account, not a local profile. Imported rows stay in the default
  // bucket and are exposed as a fallback so every selected profile sees Trakt history/progress,
  // while normal local default-profile playback remains isolated.
  if (active !== 'default') add(`${uid}:default:`, (value) => value && value.fromTrakt);
  add(`${uid}:${active}:`, () => true);
  return [...rows.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function watchRowForKeyFromAll(all, uid, profile, key) {
  const active = profile || 'default';
  const own = all[`${uid}:${active}:${key}`];
  if (own) return own;
  const fallback = all[`${uid}:default:${key}`];
  return active !== 'default' && fallback && fallback.fromTrakt ? fallback : null;
}
function deleteWatchKeyForProfile(all, uid, profile, key) {
  const active = profile || 'default';
  delete all[`${uid}:${active}:${key}`];
  const fallbackKey = `${uid}:default:${key}`;
  if (active !== 'default' && all[fallbackKey] && all[fallbackKey].fromTrakt) delete all[fallbackKey];
}
async function nextWatchEpisodes(uid, profile = 'default') {
  if (!settings.get().tmdbKey) return [];
  const all = store.read('watch', {});
  const rows = watchRowsForProfileFromAll(all, uid, profile);
  const byShow = {};
  const inProgress = new Set();
  for (const w of rows) {
    const ep = parseEpisodeKey(w.key);
    if (!ep) continue;
    if (!w.watched && ((w.position || 0) > 30 || (w.traktPct || 0) > 2)) { inProgress.add(ep.showId); continue; }
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
          const rec = watchRowForKeyFromAll(all, uid, profile, `tmdb:tv:${showId}:s${s.season_number}e${ep.episode_number}`);
          return !(rec && (rec.watched || (rec.position || 0) > 30 || (rec.traktPct || 0) > 2));
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
          updatedAt: top.w.updatedAt || 0,
          _nextEp: true, _newEp: new Date(`${next.air_date}T00:00:00Z`).getTime() > (top.w.updatedAt || 0),
          season: s.season_number, episode: next.episode_number,
        });
        break;
      }
    } catch { /* one bad show must not break the row */ }
  }
  return out;
}

const MUSIC_CHARTS = [
  { id: 'daily', title: 'Daily chart', note: 'Top songs today', query: 'top songs today', limit: 16 },
  { id: 'weekly', title: 'Weekly chart', note: 'Top songs this week', query: 'top songs this week', limit: 16 },
];
const musicChartCache = new Map(); // id -> { rows, expiresAt, inflight }
function nextMusicChartRefresh(id, now = new Date()) {
  const d = new Date(now);
  if (id === 'weekly') {
    const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
  } else {
    d.setDate(d.getDate() + 1);
  }
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
async function loadMusicChart(def) {
  const now = Date.now();
  const hit = musicChartCache.get(def.id);
  if (hit && hit.rows && now < hit.expiresAt) return hit.rows;
  if (hit && hit.inflight) return hit.inflight;
  const inflight = ytmusic.search(def.query, { limit: def.limit }).then((rows) => {
    const clean = (rows || []).filter((t) => t && /^[\w-]{11}$/.test(String(t.id || ''))).slice(0, def.limit);
    musicChartCache.set(def.id, { rows: clean, expiresAt: nextMusicChartRefresh(def.id) });
    return clean;
  }).catch((e) => {
    if (hit && hit.rows) return hit.rows;
    throw e;
  });
  musicChartCache.set(def.id, { ...(hit || {}), inflight });
  return inflight;
}

// ---------- handlers ----------
const H = {
  server: async (ctx) => send(ctx.res, 200, {
    app: 'triboon', version: APP_VERSION, phase: 4, needsSetup: !auth.hasUsers(),
    tmdb: !!settings.get().tmdbKey, ffmpeg: !!detectFfmpeg(),
    // Wyzie only needs the server-side API key; no account login is required.
    opensubs: !!settings.get().openSubsKey,
    iptv: iptvConfigured(settings.get()),
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
    const sources = iptvSourcesFromSettings(s);
    const iptvAllowed = ctx.user.role === 'admin' || sources.some((src) => userCanAccessIptvSource(ctx.user, src));
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
      streaming: streamingRuntimeProfile(),
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
      {
        q,
        imdbid: ctx.url.searchParams.get('imdbid') || undefined,
        tvdbid: ctx.url.searchParams.get('tvdbid') || undefined,
        season: ctx.url.searchParams.get('season') || undefined,
        ep: ctx.url.searchParams.get('ep') || undefined,
      },
      playbackPolicyFor(ctx.user, {
        maxResolutionRank: ctx.url.searchParams.get('maxResolutionRank'),
        preferResolutionRank: ctx.url.searchParams.get('preferResolutionRank'),
        originalLanguage: ctx.url.searchParams.get('originalLanguage'),
        preferredAudioLanguage: ctx.url.searchParams.get('preferredAudioLanguage'),
        caps: parseCapsQuery(ctx.url.searchParams.get('caps')),
      })
    );
    send(ctx.res, 200, {
      errors,
      // Sources is an override surface, not the auto-pick queue. Keep the best-ranked rows,
      // but also include the largest allowed rows so a 50GB cap really lets the admin choose
      // a 48-50GB release manually.
      candidates: sourceDrawerCandidates(candidates).map((c) => ({
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
      vf._subQuery = episodeSubtitleQuery(body.q, body.season, body.ep);
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
      vf._subQuery = episodeSubtitleQuery(vf._q, session.query && session.query.season, session.query && session.query.ep);
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
    const sources = iptvSourcesForUser(ctx.user, s);
    if (!sources.length) return send(ctx.res, 200, { configured: false, sources: [], channels: [] });
    try {
      const channels = await loadIptvChannels(sources);
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
        sources: sources.map(redactIptvSource),
        epg: sources.some((src) => !!(xmltvGuideUrl(src) || src.iptvMode === 'xtream')),
        hiddenGroups: (store.read('iptvgroups', {})[ctx.user.id]) || [],
        globalHidden: ctx.user.role === 'admin' ? [...globalHidden] : undefined,
        channels: list.map(({ url: _u, nativeUrl: _nu, nativeFallbackUrl: _nfu, ...c }) => {
          const token = auth.streamToken(ctx.user.id, `iptv:${c.idx}`);
          const nativeMime = c.nativeMime || iptvNativeMime(_nu || _u);
          const nativeFallbackMime = c.nativeFallbackMime || (_nfu ? iptvNativeMime(_nfu) : '');
          return {
            ...c, fav: favs.has(c.id),
            streamUrl: `/api/iptv/stream/${c.idx}?t=${token}`,
            nativeUrl: `/api/iptv/native/${c.idx}?t=${token}`,
            nativeMime,
            nativeFallbackUrl: _nfu ? `/api/iptv/native/${c.idx}?alt=1&t=${token}` : undefined,
            nativeFallbackMime,
          };
        }),
      });
    } catch (e) {
      console.error('[iptv]', e.message);
      send(ctx.res, 502, { error: 'live tv source failed — check the playlist/Xtream settings' });
    }
  },

  iptvSourcesList: async (ctx) => {
    const sources = iptvSourcesFromSettings(settings.get()).map(redactIptvSource);
    send(ctx.res, 200, { sources });
  },

  iptvSourceCreate: async (ctx) => {
    const b = await readJson(ctx.req);
    let src;
    try { src = makeIptvSourceFromBody(b); }
    catch (e) { return send(ctx.res, e.status || 400, { error: e.message }); }
    settings.update((s) => {
      const list = iptvSourcesFromSettings(s).filter((x) => x.id !== src.id);
      list.push(src);
      return {
        ...s,
        iptvSources: list,
        iptvUrl: null, xtHost: null, xtUser: null, xtPass: null, epgUrl: null, iptvUsers: [],
      };
    });
    clearIptvSourceRuntime(src.id);
    scheduleIptvWarmSoon('source-added');
    send(ctx.res, 200, { source: redactIptvSource(src) });
  },

  iptvSourceDelete: async (ctx) => {
    const sourceId = cleanIptvSourceId(ctx.m[1]);
    let removed = null;
    settings.update((s) => {
      const list = iptvSourcesFromSettings(s);
      removed = list.find((src) => src.id === sourceId) || null;
      const nextList = list.filter((src) => src.id !== sourceId);
      const next = { ...s, iptvSources: nextList };
      if (!nextList.length) {
        next.iptvUrl = null; next.xtHost = null; next.xtUser = null; next.xtPass = null; next.epgUrl = null; next.iptvUsers = [];
      }
      if (removed) {
        const prefix = `${removed.name} · `;
        next.iptvHiddenGroups = (next.iptvHiddenGroups || []).filter((g) => !String(g).startsWith(prefix));
      }
      return next;
    });
    clearIptvSourceRuntime(sourceId);
    deleteIptvDiskCache(sourceId);
    store.update('iptvfavs', {}, (all) => {
      const prefix = `${sourceId}:`;
      for (const uid of Object.keys(all || {})) {
        if (Array.isArray(all[uid])) all[uid] = all[uid].filter((id) => !String(id).startsWith(prefix));
      }
      return all;
    });
    if (removed) {
      const prefix = `${removed.name} · `;
      store.update('iptvgroups', {}, (all) => {
        for (const uid of Object.keys(all || {})) {
          if (Array.isArray(all[uid])) all[uid] = all[uid].filter((g) => !String(g).startsWith(prefix));
        }
        return all;
      });
    }
    scheduleIptvWarmSoon('source-deleted');
    send(ctx.res, 200, { ok: true, removed: !!removed });
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
    const channels = await mapLimit(chans, 8, async (ch) => {
      const src = sourceForIptvChannel(ch) || iptvSourcesFromSettings(settings.get())[0] || settings.get();
      let progs = [];
      if (src.iptvMode === 'xtream' && ch.xtreamId) {
        progs = (await xtreamEpgList(ch, { limit: 24, allowBusy: true })).filter((p) => p.stop > from && p.start < to);
      }
      let epg = null;
      if (xmltvGuideUrl(src)) {
        try { epg = await ensureXmltv(src, (iptvSourceCaches.get(cleanIptvSourceId(src.id)) || {}).channels || []); } catch { epg = null; }
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
    if (!iptvCache.channels || !iptvCache.channels.length) {
      try { await loadIptvChannels(iptvSourcesForUser(ctx.user, settings.get())); } catch {}
    }
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
    if (!iptvCache.channels || !iptvCache.channels.length) {
      const user = ctx.user || auth.getUser(ctx.claims.uid);
      try { await loadIptvChannels(iptvSourcesForUser(user, settings.get())); } catch {}
    }
    const ch = iptvCache.channels && iptvCache.channels[parseInt(ctx.m[1], 10)];
    if (!ch) return send(ctx.res, 404, { error: 'channel not found - open Live TV first' });
    const alt = ctx.url.searchParams.get('alt') === '1';
    const target = alt && ch.nativeFallbackUrl ? ch.nativeFallbackUrl : (ch.nativeUrl || ch.url);
    return proxyIptvNative(ctx, target, 0, { idx: ch.idx, name: ch.name, alt });
  },

  iptvStream: async (ctx) => {
    if (!streamScopeOk(ctx, `iptv:${ctx.m[1]}`)) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    if (!iptvCache.channels || !iptvCache.channels.length) {
      const user = ctx.user || auth.getUser(ctx.claims.uid);
      try { await loadIptvChannels(iptvSourcesForUser(user, settings.get())); } catch {}
    }
    let ch = iptvCache.channels && iptvCache.channels[parseInt(ctx.m[1], 10)];
    if (!ch) return send(ctx.res, 404, { error: 'channel not found — open Live TV first' });
    if (!detectFfmpeg()) return send(ctx.res, 503, { error: 'ffmpeg required for Live TV' });
    let remuxTargets = iptvRemuxTargets(ch);
    if (!remuxTargets.length) return send(ctx.res, 502, { error: 'invalid live stream url' });
    let availableTargets = [];
    let cachedFailure = null;
    let refreshedForStaleChannel = false;
    const rebuildRemuxTargets = () => {
      remuxTargets = iptvRemuxTargets(ch);
      availableTargets = [];
      cachedFailure = null;
      for (const target of remuxTargets) {
        const cached = iptvNativeErrorCache.get(idHash(`remux:${ch.idx}:${target.url}`));
        if (cached && cached.until > Date.now()) {
          if (!cachedFailure) cachedFailure = cached;
        } else {
          availableTargets.push(target);
        }
      }
    };
    rebuildRemuxTargets();
    if (!availableTargets.length && cachedFailure) {
      if ([401, 403, 429].includes(cachedFailure.status)) {
        refreshedForStaleChannel = true;
        const nextCh = await refreshXtreamChannelForPlayback(ch, `cached remux HTTP ${cachedFailure.status}`);
        if (nextCh) {
          ch = nextCh;
          rebuildRemuxTargets();
        }
      }
      if (!availableTargets.length && cachedFailure) {
        return sendIptvNativeError(ctx.res, cachedFailure.status, cachedFailure.reason);
      }
    }
    const liveSlot = beginIptvLiveSlot(ctx, { idx: ch.idx, name: ch.name });
    // Attempt 1 uses HLS-friendly demuxer options; if ffmpeg dies before emitting a single
    // byte (non-HLS channel, or an older ffmpeg without those options) retry once plain.
    let targetIndex = 0;
    const attempt = (target, hlsFriendly, retriesLeft) => {
      if (liveSlot.closed) return;
      let ff;
      try { ff = spawnLiveRemux(target.url, { hlsFriendly }); }
      catch (e) {
        liveSlot.done('spawn failed');
        console.error('[iptv]', sanitizeIptvFfmpegError(e.message));
        if (!ctx.res.headersSent) send(ctx.res, 502, { error: 'live stream unavailable' });
        else try { ctx.res.destroy(); } catch {}
        return;
      }
      let wrote = false, err = '';
      let idleTimer = null;
      let clientClosed = false;
      const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
      const armIdle = (ms) => {
        clearIdle();
        idleTimer = setTimeout(() => {
          console.error(`[iptv] "${ch.name}" remux stalled without output for ${Math.round(ms / 1000)}s`);
          try { ff.kill('SIGKILL'); } catch {}
        }, ms);
        idleTimer.unref();
      };
      const stopForClientClose = () => {
        if (clientClosed) return;
        clientClosed = true;
        clearIdle();
        try { ff.kill('SIGKILL'); } catch {}
        liveSlot.done('client closed');
      };
      liveSlot.setCloser((reason) => {
        if (clientClosed) return;
        clientClosed = true;
        clearIdle();
        try { ff.kill('SIGKILL'); } catch {}
        try { if (!ctx.res.destroyed) ctx.res.destroy(); } catch {}
      });
      armIdle(LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS);
      ff.stdout.on('data', (chunk) => {
        if (!wrote) {
          wrote = true;
          ctx.res.writeHead(200, {
            'content-type': 'video/mp4',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();
        }
        armIdle(LIVE_REMUX_IDLE_TIMEOUT_MS);
        if (!ctx.res.destroyed) ctx.res.write(chunk);
      });
      ff.stderr.on('data', (d) => { err += d; });
      ff.on('error', (e) => {
        clearIdle();
        liveSlot.done('spawn error');
        console.error('[iptv spawn]', sanitizeIptvFfmpegError(e.message));
        if (!ctx.res.headersSent) send(ctx.res, 502, { error: 'live stream unavailable' });
        else try { ctx.res.destroy(); } catch {}
      });
      ff.on('close', async (codeNum) => {
        clearIdle();
        ctx.req.off('close', stopForClientClose);
        ctx.res.off('close', stopForClientClose);
        if (clientClosed) return;
        const status = iptvRemuxStatusFromFfmpeg(err);
        const reason = iptvNativeFailureReason(status || 502, err);
        const providerRejected = [401, 403, 429].includes(status);
        err = sanitizeIptvFfmpegError(err);
        if (codeNum && !wrote && retriesLeft > 0 && !providerRejected && !ctx.res.destroyed) {
          console.error(`[iptv] "${ch.name}" attempt failed (${err.slice(0, 120).trim()}) — retrying plain`);
          return attempt(target, false, retriesLeft - 1);
        }
        if (codeNum && !wrote && targetIndex + 1 < availableTargets.length && !ctx.res.destroyed) {
          const failedLabel = target.label || 'stream';
          targetIndex++;
          const next = availableTargets[targetIndex];
          const nextHls = iptvRemuxTargetLikelyHls(next);
          console.error(`[iptv] "${ch.name}" ${failedLabel} remux failed (${err.slice(0, 120).trim()}) - trying ${next.label || 'alternate'} source`);
          return attempt(next, nextHls, nextHls ? 1 : 0);
        }
        if (codeNum && !wrote && providerRejected && !refreshedForStaleChannel && !ctx.res.destroyed) {
          refreshedForStaleChannel = true;
          const nextCh = await refreshXtreamChannelForPlayback(ch, `remux HTTP ${status}`);
          if (nextCh) {
            ch = nextCh;
            targetIndex = 0;
            rebuildRemuxTargets();
            const next = availableTargets[targetIndex] || remuxTargets[0];
            if (next) {
              const nextHls = iptvRemuxTargetLikelyHls(next);
              console.error(`[iptv] "${ch.name}" retrying refreshed Xtream remux source`);
              return attempt(next, nextHls, nextHls ? 1 : 0);
            }
          }
        }
        if (codeNum && !wrote) {
          liveSlot.done('failed');
          const failureKey = idHash(`remux:${ch.idx}:${target.url}`);
          iptvNativeErrorCache.set(failureKey, {
            status: status || 502,
            reason,
            until: Date.now() + iptvNativeFailureCacheTtl(status || 502, reason),
          });
          if (iptvNativeErrorCache.size > 2000) iptvNativeErrorCache = new Map([...iptvNativeErrorCache].slice(-1000));
          console.error(`[iptv] "${ch.name}" exit ${codeNum}: ${err} (${reason})`);
          if (!ctx.res.headersSent && !ctx.res.destroyed) return sendIptvNativeError(ctx.res, status || 502, reason);
        }
        // Log the channel NAME only (the url embeds the provider account).
        if (codeNum && wrote && err) console.error(`[iptv] "${ch.name}" exit ${codeNum}:`, err.slice(0, 300));
        liveSlot.done(codeNum ? 'ended with error' : 'ended');
        try { ctx.res.end(); } catch {}
      });
      ctx.req.once('close', stopForClientClose);
      ctx.res.once('close', stopForClientClose);
    };
    let startDelayTimer = null;
    const startAttempt = () => {
      if (startDelayTimer) startDelayTimer = null;
      if (liveSlot.closed || ctx.res.destroyed) return;
      const first = availableTargets[targetIndex] || remuxTargets[0];
      const likelyHls = iptvRemuxTargetLikelyHls(first);
      attempt(first, likelyHls, likelyHls ? 1 : 0);
    };
    liveSlot.setCloser((reason) => {
      if (startDelayTimer) clearTimeout(startDelayTimer);
      try { if (!ctx.res.destroyed) ctx.res.destroy(); } catch {}
    });
    if (liveSlot.replaced) {
      startDelayTimer = setTimeout(startAttempt, IPTV_LIVE_RETUNE_GRACE_MS);
      startDelayTimer.unref();
    } else {
      startAttempt();
    }
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
// Writes imported rows into the DEFAULT bucket as account-level Trakt fallback data. Profile
// reads merge only these fromTrakt rows; local non-Trakt default-profile playback stays isolated.
// Never downgrades: locally-watched stays watched, a real local position beats an imported %.
// Trakt stores playback progress as a PERCENT — kept as traktPct; the player seeks to it
// once the real duration is known.
async function traktSyncDown(uid) {
  if (!trakt.status(uid).linked) { const e = new Error('Trakt is not linked'); e.status = 400; throw e; }
  const pushed = await trakt.flushOutbox(uid).catch((e) => ({ sent: 0, failed: 1, pending: 0, error: e.message }));
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
  return { ok: true, watched: nWatched, playback: nPlayback, watchlist: nWatchlist,
    pushed: pushed.sent || 0, pendingPush: pushed.pending || 0,
    totalWatched: watched.length, totalWatchlist: watchlist.length };
}
// Auto-resync every 6h per linked user — one user per tick keeps the calls gentle.
function traktSyncTick() {
  const tokens = store.read('trakt', {});
  for (const [uid, tok] of Object.entries(tokens)) {
    if (!tok || (tok.syncedAt && Date.now() - tok.syncedAt < 6 * 3600000)) continue;
    store.update('trakt', {}, (all) => { if (all[uid]) all[uid].syncedAt = Date.now(); return all; }); // claim before the async work
    traktSyncDown(uid)
      .then((r) => { if (r.watched || r.playback || r.watchlist || r.pushed) console.log(`[trakt] sync: +${r.watched} watched, +${r.playback} in-progress, +${r.watchlist} watchlist, ${r.pushed} pushed`); })
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
    const libId = ctx.m[1];
    const rec = store.read('libitems', {})[libId];
    if (!rec) return send(ctx.res, 200, { items: [] });
    const limitRaw = ctx.url.searchParams.get('limit');
    if (limitRaw !== null) {
      const limit = Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 15));
      const offset = Math.max(0, parseInt(ctx.url.searchParams.get('offset') || '0', 10) || 0);
      const sort = ctx.url.searchParams.get('sort') || 'added.desc';
      const genre = parseInt(ctx.url.searchParams.get('genre') || '0', 10) || 0;
      const showIdxRaw = ctx.url.searchParams.get('showIdx');
      const showIdx = showIdxRaw === null ? null : parseInt(showIdxRaw, 10);
      const top = (rec.items || []).filter((x) => x.kind !== 'episode');
      const genres = [...new Set(top.flatMap((x) => x.genres || []))].sort((a, b) => a - b);
      let items;
      let show = null;
      if (Number.isFinite(showIdx)) {
        show = (rec.items || []).find((x) => x.idx === showIdx) || null;
        items = (rec.items || [])
          .filter((x) => x.kind === 'episode' && x.showIdx === showIdx)
          .sort((a, b) => ((+a.s || 0) - (+b.s || 0)) || ((+a.e || 0) - (+b.e || 0)) || String(a.title || '').localeCompare(String(b.title || '')));
      } else {
        items = top;
        if (genre) items = items.filter((x) => (x.genres || []).includes(genre));
        items = items.slice().sort(localItemSorter(sort));
      }
      const total = items.length;
      const page = items.slice(offset, offset + limit).map((item) => localItemPayload(ctx, libId, item));
      return send(ctx.res, 200, {
        scannedAt: rec.scannedAt,
        offset,
        limit,
        total,
        hasMore: offset + page.length < total,
        genres,
        show: show ? localItemPayload(ctx, libId, show) : null,
        items: page,
      });
    }
    // Never expose absolute paths — items are addressed by index, with tokenized URLs.
    // STABLE tokens: identical URLs across requests for ~6h, so the browser's HTTP cache
    // actually holds the covers instead of re-downloading them on every visit.
    send(ctx.res, 200, {
      scannedAt: rec.scannedAt,
      items: rec.items.map((item) => localItemPayload(ctx, libId, item)),
    });
  },

  // Prepare a scanned local file as a normal player mount. The old /api/local/:lib/:idx
  // URL remains for direct downloads/VLC, but the app uses this richer descriptor so added
  // libraries get the same remux/transcode, track probe, subtitles and native-player flow
  // as movies and TV episodes mounted from Usenet.
  localPlay: async (ctx) => {
    const body = await readJson(ctx.req);
    const r = localMountFor(ctx, ctx.m[1], ctx.m[2], body.caps || {}, body || {});
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
    send(ctx.res, 200, watchRowsForProfileFromAll(all, ctx.user.id, profile));
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
      if (b.remove) { deleteWatchKeyForProfile(all, ctx.user.id, profile, b.key); return all; } // "Remove from Continue Watching"
      if (profile !== 'default' && b.watched === false && b.unwatch) deleteWatchKeyForProfile(all, ctx.user.id, profile, b.key);
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
        if (b.watched === false) { deleteWatchKeyForProfile(all, ctx.user.id, profile, it.key); }
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
    const iptvSources = iptvSourcesFromSettings(s);
    const primaryIptv = iptvSources[0] || legacyIptvSource(s) || {};
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
      iptvSources: iptvSources.map(redactIptvSource),
      iptvUrl: primaryIptv.iptvUrl ? iptvUrlHost(primaryIptv.iptvUrl) : null,
      iptvMode: primaryIptv.iptvMode || 'm3u',
      xtHost: primaryIptv.xtHost ? iptvUrlHost(primaryIptv.xtHost) : null,
      epgUrl: primaryIptv.epgUrl ? iptvUrlHost(primaryIptv.epgUrl) : null,
      traktClientId: s.traktClientId || null, // public identifier — safe to show
      traktClientSecret: s.traktClientSecret ? '•••' : null,
      iptvUsers: primaryIptv.users || [], // user ids, not secrets
      sizeCapMode: s.sizeCapMode || 'auto',
      sizeCap4kGb: s.sizeCap4kGb || null,
      sizeCap1080Gb: s.sizeCap1080Gb || null,
      libAutoScanMin: s.libAutoScanMin ?? 15, // 0 = auto-scan off
      effectiveSizeCaps: sizeCaps(), // what's actually applied right now (auto-computed or manual)
      maxProviderConnections: MAX_PROVIDER_CONNECTIONS,
      streamingPerformance: normalizeStreamingPerformance(s.streamingPerformance || {}),
      scoringGroupsTrusted: s.scoringGroupsTrusted || [],
      scoringGroupsAvoid: s.scoringGroupsAvoid || [],
      scoringKeywords: s.scoringKeywords || [],
    });
  },

  streamingRecommend: async (ctx) => {
    const b = await readJson(ctx.req);
    send(ctx.res, 200, recommendStreamingPerformance(b, settings.get()));
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
    const iptvAccessChanged = b.iptvUsers !== undefined;
    // Ops merge server-side so the UI never needs the decrypted secrets back:
    //   addProvider / removeProvider (index) · addIndexer / removeIndexer (index)
    // Wholesale replacement (providers:/indexers:) still works for tests/automation.
    settings.update((s) => {
      const next = {
        providers: b.providers !== undefined ? normalizeProviders(b.providers) : normalizeProviders(s.providers || []),
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
        iptvSources: Array.isArray(s.iptvSources) ? s.iptvSources : [],
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
        streamingPerformance: b.streamingPerformance !== undefined
          ? normalizeStreamingPerformance(b.streamingPerformance || {})
          : normalizeStreamingPerformance(s.streamingPerformance || {}),
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
          connections: providerConnections(b.addProvider.connections),
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
          connections: providerConnections(e.connections, cur.connections || 16),
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
      if (iptvSourceChanged || iptvAccessChanged) {
        const currentSources = iptvSourcesFromSettings(s);
        const existing = currentSources[0] || legacyIptvSource(s) || { id: IPTV_LEGACY_SOURCE_ID, name: 'Default Live TV' };
        const explicitClear = b.iptvUrl === null && b.xtHost === null && b.xtUser === null && b.xtPass === null;
        if (explicitClear) {
          next.iptvSources = [];
          next.iptvUrl = null; next.xtHost = null; next.xtUser = null; next.xtPass = null; next.epgUrl = null; next.iptvUsers = [];
        } else {
          try {
            const merged = makeIptvSourceFromBody({ ...b, iptvUsers: next.iptvUsers }, existing);
            next.iptvSources = [merged, ...currentSources.filter((src) => src.id !== merged.id)];
            next.iptvMode = merged.iptvMode;
            next.iptvUrl = merged.iptvUrl;
            next.xtHost = merged.xtHost;
            next.xtUser = merged.xtUser;
            next.xtPass = merged.xtPass;
            next.epgUrl = merged.epgUrl;
            next.iptvUsers = merged.users;
          } catch {
            if (!existing || ['iptvUrl', 'xtHost', 'xtUser', 'xtPass'].some((k) => b[k] === null)) {
              next.iptvSources = [];
              next.iptvUrl = null; next.xtHost = null; next.xtUser = null; next.xtPass = null; next.epgUrl = null; next.iptvUsers = [];
            }
          }
        }
      }
      return next;
    });
    pool = null; poolKey = ''; // provider change → fresh pool next use
    // Indexer/provider changes invalidate cached searches — otherwise a freshly added
    // indexer is invisible (and tests of a replaced one read stale results) for 60s.
    pipeline.searchCache.clear();
    send(ctx.res, 200, { ok: true });
    if (iptvSourceChanged || iptvAccessChanged) {
      clearAllIptvRuntime();
      scheduleIptvWarmSoon('settings');
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

  // Online subtitles (Wyzie) -> WebVTT. The practical CC path: BluRay releases carry
  // only bitmap PGS subs which can never become text tracks. Cached per mount + language.
  ossubs: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    const key = settings.get().openSubsKey; // storage key kept across the Wyzie switch
    if (!key) return send(ctx.res, 503, { error: 'Wyzie Subs is not configured (Settings -> Catalog)' });
    vf._touched = Date.now();
    const lang = String(ctx.url.searchParams.get('lang') || 'en').slice(0, 5).replace(/[^a-z-]/gi, '');
    const tmdbId = String(ctx.url.searchParams.get('tmdb') || '').replace(/\D/g, '');
    const imdbRaw = String(ctx.url.searchParams.get('imdb') || ctx.url.searchParams.get('imdbid') || '').trim();
    const imdbId = /^tt\d{5,10}$/i.test(imdbRaw) ? imdbRaw.toLowerCase() : '';
    const wantsList = ctx.url.searchParams.get('list') === '1';
    const variant = String(ctx.url.searchParams.get('variant') || '').replace(/[^a-z0-9_.:-]/gi, '').slice(0, 80);
    const shift = Math.max(-120, Math.min(120, Number(ctx.url.searchParams.get('shift') || 0) || 0));
    const base = process.env.WYZIE_BASE || undefined;
    const subOpts = {
      key, tmdbId, imdbId, query: vf._subQuery || vf._q || vf.name, lang, releaseName: vf.name,
      durationSeconds: vf._tracks && vf._tracks.duration,
      attempts: 3, retryDelayMs: 900,
      ...(base ? { base } : {}),
    };
    vf._osCache = vf._osCache || new Map();
    vf._osInflight = vf._osInflight || new Map();
    vf._osSearchCache = vf._osSearchCache || new Map();
    vf._osSearchInflight = vf._osSearchInflight || new Map();
    const catalogId = imdbId || tmdbId;
    const searchKey = `${lang}:${catalogId}`;
    const subtitleFailure = (e) => {
      const noSubs = isNoSubtitleError(e);
      return {
        status: noSubs ? 404 : (isTransientSubError(e) ? 504 : 502),
        body: {
          error: noSubs ? 'No subtitles found for this title' : (e.message || 'online subtitles failed'),
          ...(noSubs ? { code: 'no_subtitles' } : {}),
        },
      };
    };
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
        const failure = subtitleFailure(e);
        return send(ctx.res, failure.status, failure.body);
      }
    }
    const cacheKey = variant ? `${lang}:${catalogId}:${variant}` : `${lang}:${catalogId}:auto`;
    if (!vf._osCache.has(cacheKey)) {
      if (!vf._osInflight.has(cacheKey)) {
        const work = (async () => {
          if (!variant) return fetchOnlineSub(subOpts);
          const variants = await getVariants();
          const hit = variants.find((v) => v.id === variant);
          if (!hit || !hit.raw) throw new Error('that subtitle version is no longer available');
          return downloadBestSubtitle(variants.map((v) => v.raw).filter(Boolean), {
            key,
            releaseName: vf.name,
            durationSeconds: vf._tracks && vf._tracks.duration,
            preferredId: variant,
            ...(base ? { base } : {}),
            attempts: 3,
            retryDelayMs: 900,
          });
        })().then((vtt) => {
          vf._osCache.set(cacheKey, vtt);
          return vtt;
        }).finally(() => vf._osInflight.delete(cacheKey));
        vf._osInflight.set(cacheKey, work);
      }
      try { await vf._osInflight.get(cacheKey); } catch (e) {
        const failure = subtitleFailure(e);
        return send(ctx.res, failure.status, failure.body);
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
  musicCharts: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    const charts = (await Promise.all(MUSIC_CHARTS.map(async (def) => {
      try {
        const results = await loadMusicChart(def);
        return {
          id: def.id,
          title: def.title,
          note: def.note,
          results: results.map((r) => ({ ...r, streamUrl: `/api/music/stream/${r.id}?t=${auth.streamToken(ctx.user.id, `music:${r.id}`)}` })),
        };
      } catch (e) {
        return { id: def.id, title: def.title, note: def.note, results: [], error: String(e.message).slice(0, 120) };
      }
    }))).filter((c) => c.results.length);
    send(ctx.res, 200, { charts });
  },
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
function unlinkYtCookieMap(map) {
  for (const [, f] of map) {
    try { fs.unlinkSync(f.path); } catch {}
  }
  map.clear();
}
const YT_COOKIE_CLEANUP_KEY = Symbol.for('triboon.ytCookieCleanup');
const ytCookieCleanupState = globalThis[YT_COOKIE_CLEANUP_KEY] || (() => {
  const state = { maps: new Set() };
  process.on('exit', () => {
    for (const map of Array.from(state.maps)) unlinkYtCookieMap(map);
    state.maps.clear();
  });
  globalThis[YT_COOKIE_CLEANUP_KEY] = state;
  return state;
})();
const ytCookieFiles = new Map(); // uid -> { path, hash }
ytCookieCleanupState.maps.add(ytCookieFiles);
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
function cleanupYtCookieFiles() {
  unlinkYtCookieMap(ytCookieFiles);
  ytCookieCleanupState.maps.delete(ytCookieFiles);
}

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
  { m: 'GET', re: /^\/api\/iptv\/sources$/, auth: 'admin', h: H.iptvSourcesList },
  { m: 'POST', re: /^\/api\/iptv\/sources$/, auth: 'admin', h: H.iptvSourceCreate },
  { m: 'DELETE', re: /^\/api\/iptv\/sources\/([\w-]+)$/, auth: 'admin', h: H.iptvSourceDelete },
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
  { m: 'GET', re: /^\/api\/music\/charts$/, auth: 'user', h: H.musicCharts },
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
  { m: 'POST', re: /^\/api\/streaming\/recommend$/, auth: 'admin', h: H.streamingRecommend },
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
  closeAllIptvLiveStreams('shutdown');
  cleanupYtCookieFiles();
  if (pool) { pool.close(); pool = null; }
  store.close();
  return new Promise((r) => server.close(r));
}

module.exports = { server, mounts, getPool, shutdown, sweep, ROUTES, auth, settings, store, warmIptvCaches, msUntilNextIptvWarm };

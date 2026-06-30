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
const { LibraryDb } = require('./library-db');
const { Auth, SecureSettings, RateLimiter } = require('./auth');
const { Pipeline } = require('./pipeline');
const { TmdbProxy } = require('./tmdb');
const { Trakt } = require('./trakt');
const { detectFfmpeg, detectFfprobe, detectEncoder, decidePlayback, probeTracks, spawnRemux, spawnTranscode, spawnLiveRemux, spawnSubtitleExtract, detectSubSync, spawnSubSync, makeThumb, LADDER, audioCopyOk } = require('./transcode');
const ytmusic = require('./ytmusic');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');
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
const activitySessions = new Map(); // heartbeat-only "now watching"; short TTL, not the retained history
const presenceSessions = new Map(); // online presence (browsing OR watching), keyed `${uid}:${deviceId}`, short TTL
const DATA_DIR = process.env.TRIBOON_DATA || path.join(__dirname, '..', 'data');
const libraryDb = new LibraryDb(DATA_DIR);
const MAX_PROVIDER_CONNECTIONS = 150;
const ACTIVITY_TTL_MS = 45000;
const ACTIVITY_HISTORY_DAYS = 3;
const ACTIVITY_HISTORY_RETENTION_MS = ACTIVITY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
const ACTIVITY_HISTORY_MAX_ROWS = 60; // a real ~3-day window, not just the last handful
const PRESENCE_TTL_MS = 70000; // ~3 missed 25s presence heartbeats before a device is dropped as offline

function effectiveOpenSubsKey(s = settings.get()) {
  const configured = String((s && s.openSubsKey) || '').trim();
  if (configured) return configured;
  return String(process.env.TRIBOON_WYZIE_KEY || '').trim() || null;
}

// OPTIONAL OpenSubtitles provider (hash-exact matching Wyzie can't do). Fully gated: returns
// null unless an API key + login are configured (settings first, env fallback for headless
// testing). When null, the Wyzie path runs exactly as before — zero behavior change.
function effectiveOpenSubtitles(s = settings.get()) {
  const apiKey = String((s && s.openSubtitlesApiKey) || process.env.TRIBOON_OS_API_KEY || '').trim();
  const username = String((s && s.openSubtitlesUser) || process.env.TRIBOON_OS_USER || '').trim();
  const password = String((s && s.openSubtitlesPass) || process.env.TRIBOON_OS_PASS || '').trim();
  if (!apiKey || !username || !password) return null;
  return { apiKey, username, password, base: process.env.OPENSUBTITLES_BASE || undefined };
}
// OpenSubtitles download needs a short-lived JWT (≈24h). Cache it across requests so we don't
// burn the login rate limit; re-login on expiry or auth failure.
let _osTokenCache = null; // { token, baseUrl, at }
async function osBearer(cfg, { force = false } = {}) {
  if (!force && _osTokenCache && Date.now() - _osTokenCache.at < 20 * 3600000) return _osTokenCache;
  const login = await osLogin({ apiKey: cfg.apiKey, username: cfg.username, password: cfg.password, base: cfg.base });
  _osTokenCache = { token: login.token, baseUrl: login.baseUrl, at: Date.now() };
  return _osTokenCache;
}
async function collectStream(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
// Compute the OpenSubtitles moviehash on the mounted file (first+last 64KB + size), cached on
// the mount. Uses the lowest NNTP lane so it never competes with playback. Null on any failure.
async function moviehashForMount(vf) {
  if (vf._moviehash !== undefined) return vf._moviehash;
  vf._moviehash = null;
  try {
    const size = Number(vf.size) || 0;
    if (size >= 131072 && typeof vf.read === 'function') {
      const head = await collectStream(vf.read(0, 65536, { priority: 'background' }));
      const tail = await collectStream(vf.read(size - 65536, size, { priority: 'background' }));
      vf._moviehash = moviehashFromChunks(head, tail, size) || null;
    }
  } catch { vf._moviehash = null; }
  return vf._moviehash;
}
// Normalized OpenSubtitles variants for a mount. Never throws — any failure yields [] so the
// Wyzie results stand alone. Hash search runs first (best signal), id search as the fallback.
async function openSubtitlesVariantsForMount(vf, { imdbId, tmdbId, lang, season = null, episode = null }) {
  const cfg = effectiveOpenSubtitles();
  if (!cfg) return [];
  try {
    const moviehash = await moviehashForMount(vf).catch(() => null);
    const data = await osSearch({
      apiKey: cfg.apiKey, base: cfg.base, moviehash: moviehash || '',
      imdbId, tmdbId, query: vf._subQuery || vf._q || '', lang, season, episode,
    });
    return (Array.isArray(data) ? data : []).map(osNormalize).filter((v) => v && v._osFileId);
  } catch { return []; }
}

// WebVTT -> SRT for the sync engine's input (alass parses SRT reliably). Inverse of srtToVtt:
// drop the WEBVTT header, turn the millisecond dot back into a comma. Cue indices are optional.
function vttToSrt(vtt) {
  return String(vtt || '').replace(/^﻿/, '').replace(/\r/g, '')
    .replace(/^WEBVTT[^\n]*\n+/, '')
    .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
}
// Align an already-fetched VTT to the mount's audio with alass, against the same localhost
// tokened stream URL ffmpeg already uses for embedded subs. Heavy (alass reads the audio via
// ffmpeg), so callers only invoke it for subs that aren't already in sync. Returns the corrected
// VTT; throws on failure so the caller falls back to the unsynced cue track.
async function onDemandSubSync(vf, vtt, uid) {
  const os2 = require('os');
  const fsp = fs.promises;
  const dir = await fsp.mkdtemp(path.join(os2.tmpdir(), 'triboon-subsync-'));
  const inSrt = path.join(dir, 'in.srt');
  const outSrt = path.join(dir, 'out.srt');
  try {
    await fsp.writeFile(inSrt, vttToSrt(vtt), 'utf8');
    const selfUrl = `http://127.0.0.1:${server.address().port}/api/stream/${vf.id}?t=${auth.streamToken(uid, vf.id)}`;
    await new Promise((resolve, reject) => {
      const p = spawnSubSync(selfUrl, inSrt, outSrt);
      let err = '';
      const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('subtitle sync timed out')); }, 300000);
      p.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString(); });
      p.on('error', (e) => { clearTimeout(killer); reject(e); });
      p.on('close', (code) => { clearTimeout(killer); code === 0 ? resolve() : reject(new Error(`alass exited ${code}: ${err.slice(-200)}`)); });
    });
    const out = await fsp.readFile(outSrt, 'utf8');
    // alass only re-times existing cues; a changed cue count (or empty output) means a corrupt
    // alignment — reject it so the caller falls back to the unsynced track instead of garbage.
    if (!subSyncResultOk(vtt, out)) throw new Error('alass output failed the cue-count sanity check');
    return srtToVtt(out);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

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
  // Legacy cosmetic profiles (fast/balanced/large) fold into 'auto'; intent presets are capacity-relative.
  const profile = ['auto', 'quality', 'concurrency', 'custom'].includes(raw.profile) ? raw.profile : 'auto';
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

// Approximate per-stream bitrate (Mbps) implied by a GB release-size cap over a typical feature
// runtime. 1 GB ≈ 8192 Mbit; assume ~2h. e.g. a 40 GB 4K cap ≈ 45 Mbps, a 20 GB 1080p cap ≈ 23 Mbps.
function bitrateFromSizeGb(gb, runtimeSec = 7200) {
  const n = Number(gb) || 0;
  if (n <= 0 || runtimeSec <= 0) return 0;
  return (n * 8192) / runtimeSec;
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
  // Intent presets scale with the server's REAL capacity (never hardcoded numbers): "quality" plans
  // for fewer concurrent streams (each gets a bigger share + deeper buffer), "concurrency" plans for
  // more. Everything still derives from total connections, so 40 and 300 both get sane numbers.
  const planUsers = current.profile === 'quality' ? Math.max(1, Math.ceil(current.expectedUsers / 2))
    : current.profile === 'concurrency' ? Math.max(1, Math.ceil(current.expectedUsers * 1.5))
    : current.expectedUsers;
  const bufferScale = current.profile === 'quality' ? 1.25 : current.profile === 'concurrency' ? 0.85 : 1;
  const activeBudget = Math.max(0, usableConnections - reserveConnections);
  const perUser = planUsers ? Math.max(1, Math.floor(activeBudget / planUsers)) : activeBudget;

  const mixMbps = current.streamMix === '4k' ? 55 : current.streamMix === '1080p' ? 12 : 28;
  const usableDown = current.serverDownloadMbps ? current.serverDownloadMbps * 0.8 : 0;
  const projectedDown = current.expectedUsers * mixMbps;
  const tightDownload = usableDown > 0 && projectedDown > usableDown * 0.75;
  const generousDownload = usableDown > 0 && projectedDown < usableDown * 0.45;

  const rec1080 = Math.max(4, Math.min(24, perUser >= 16 ? 14 : perUser >= 10 ? 12 : perUser >= 6 ? 8 : 6));
  const rec4k = Math.max(6, Math.min(36, perUser >= 24 ? 24 : perUser >= 16 ? 18 : perUser >= 10 ? 14 : 10));
  const buffer1080Sec = clampInt(Math.round((tightDownload ? 90 : generousDownload ? 240 : 180) * bufferScale), 180, 30, 600);
  const buffer4kSec = clampInt(Math.round((tightDownload ? 60 : generousDownload ? 120 : 90) * bufferScale), 90, 30, 360);
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

  // Phase 2 — feed the Max release size caps + measured provider speed/cap into the recommendation.
  const manualCaps = s.sizeCapMode === 'manual';
  const br4k = manualCaps && Number(s.sizeCap4kGb) > 0 ? Math.max(20, Math.min(120, Math.round(bitrateFromSizeGb(s.sizeCap4kGb)))) : 55;
  const br1080 = manualCaps && Number(s.sizeCap1080Gb) > 0 ? Math.max(8, Math.min(60, Math.round(bitrateFromSizeGb(s.sizeCap1080Gb)))) : 18;
  const measuredPerConn = Number(input.measuredMbpsPerConn) > 0 ? Number(input.measuredMbpsPerConn) : 0;
  const measuredCap = clampInt(input.measuredConnCap, 0, 0, 1000);
  // Size per-stream connections for the PEAK bitrate (VBR 4K spikes well above its average), so a
  // latency dip on a connection or two can't drop fill below the playback rate. 4K gets a higher
  // floor — running a high-bitrate stream on a handful of connections is what let the buffer drain
  // to zero mid-movie even with hundreds of connections idle.
  // A measured connection cap is a hard ceiling — usable capacity can't exceed what the account accepts.
  const effTotal = measuredCap > 0 ? Math.min(totalConnections || measuredCap, measuredCap) : totalConnections;
  const effUsable = Math.max(0, Math.floor(effTotal * 0.85));
  const effActive = Math.max(0, effUsable - (effUsable ? Math.max(2, Math.ceil(effUsable * reservePct / 100)) : 0));
  // Per-stream connections = your fair SHARE of the active budget for the number of streams the chosen
  // intent plans for, but never below what sustains the PEAK bitrate. This is what makes the preset
  // scale with capacity: fewer planned streams → bigger share → richer streams; more → more viewers fit.
  const share = planUsers ? Math.floor(effActive / planUsers) : effActive;
  const floor1080 = measuredPerConn > 0 ? Math.ceil((br1080 * 1.6) / measuredPerConn) : rec1080;
  const floor4k = measuredPerConn > 0 ? Math.ceil((br4k * 2.5) / measuredPerConn) : rec4k;
  const perStream1080 = Math.max(6, Math.min(24, Math.max(floor1080, share)));
  const perStream4k = Math.max(12, Math.min(40, Math.max(floor4k, share)));
  // Simultaneous viewers are limited by the SMALLER of two ceilings:
  //   (1) connections — each stream needs perStream connections out of the active budget; and
  //   (2) throughput — total deliverable Mbps ÷ the per-stream bitrate. Deliverable is the min of
  //       what the connections can pull (measured per-conn × active connections) and what the
  //       server's internet line can carry (entered download Mbps × 0.8). Whichever is the real wall.
  const connThroughputMbps = measuredPerConn > 0 ? effActive * measuredPerConn : 0;
  let deliverableMbps = 0;
  if (connThroughputMbps && usableDown) deliverableMbps = Math.min(connThroughputMbps, usableDown);
  else deliverableMbps = connThroughputMbps || usableDown || 0; // fall back to whichever is known
  const byConns = (perStream, n) => (perStream ? Math.floor(n / perStream) : 0);
  const byRate = (br) => (deliverableMbps ? Math.floor(deliverableMbps / br) : Infinity);
  const maxSimultaneous1080 = Math.max(0, Math.min(byConns(perStream1080, effActive), byRate(br1080)));
  const maxSimultaneous4k = Math.max(0, Math.min(byConns(perStream4k, effActive), byRate(br4k)));
  if (measuredCap > 0 && totalConnections > measuredCap) {
    warnings.push(`Providers accept about ${measuredCap} connections but ${totalConnections} are configured — lower per-account connection counts to <= ${measuredCap} to avoid "too many connections" stalls.`);
  }
  if (!current.serverDownloadMbps) {
    warnings.push('Enter your server download speed (Mbps) — it caps how many simultaneous streams your internet line can carry, so the viewer estimate is connection-only until you add it.');
  }

  const recommendation = normalizeStreamingPerformance({
    ...current,
    profile: ['quality', 'concurrency'].includes(current.profile) ? current.profile : 'auto',
    startupReservePct: reservePct,
    buffer1080Sec,
    buffer4kSec,
    maxConnPerStream1080: perStream1080,
    maxConnPerStream4k: perStream4k,
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
      maxSimultaneous1080,
      maxSimultaneous4k,
      streamBitrate1080: br1080,
      streamBitrate4k: br4k,
      deliverableMbps: Math.round(deliverableMbps) || 0,
      measuredMbpsPerConn: measuredPerConn || 0,
      measuredConnCap: measuredCap || 0,
    },
    warnings,
  };
}

// Live provider speed + connection-cap probe (powers the "Test speed" button), using its OWN
// short-lived connections (separate from the playback pool). It opens connections UP TO the count
// CONFIGURED for this provider (capped at SPEEDTEST_MAX_CONNS for safety) — so it verifies a real
// plan of ANY size (16, 40, 100, …) instead of a hardcoded ceiling. Opening is connect-only (cheap
// TCP+TLS+AUTH, no data); if the provider answers "502 too many connections" before reaching the
// configured count, THAT is the account's true cap. Throughput is then sampled on a small SUBSET of
// the open connections (no point pulling data on all 100) and reported per-connection so the
// recommendation can project total throughput honestly. Everything is closed in finally.
const SPEEDTEST_GROUPS = ['alt.binaries.boneless', 'alt.binaries.teevee', 'alt.binaries.moovee', 'alt.binaries.hdtv', 'alt.binaries.misc'];
const SPEEDTEST_MAX_CONNS = 120;     // safety ceiling — a mis-typed huge count can't open thousands
const SPEEDTEST_SAMPLE_CONNS = 12;   // connections used for the throughput sample (representative, not all)
const speedTestInFlight = new Set(); // provider indices being speed-tested — one at a time per provider
function isTooManyConnections(e) { return /too many connection|\b502\b/i.test(String((e && e.message) || e)); }
async function speedTestProvider(p, { targetConns, sampleMs = 3500 } = {}) {
  const configured = providerConnections(p.connections);
  // Never open MORE than the provider's configured cap — testing past it would violate the very
  // limit the admin set (and trip the provider's "too many connections"). The ceiling is the
  // configured count, not SPEEDTEST_MAX_CONNS.
  const want = clampInt(targetConns, configured, 1, Math.min(configured, SPEEDTEST_MAX_CONNS));
  const conns = [];
  let capHit = false;
  const openOne = async () => {
    const c = new NntpConnection({ ...p, connectTimeoutMs: 8000, commandTimeoutMs: 12000 });
    try { await c.connect(); conns.push(c); return c; }
    catch (e) { try { c.close(); } catch {} if (isTooManyConnections(e)) { capHit = true; return null; } if (!conns.length) throw e; return null; }
  };
  try {
    // Phase A — open a SMALL sample first and measure throughput on these FRESH connections, BEFORE
    // the (possibly long) full cap-open below can let early connections idle out. Sampling on
    // stale first-opened connections is what made a 100-connection provider read 0 Mbps.
    const sampleTarget = Math.min(want, SPEEDTEST_SAMPLE_CONNS);
    for (let i = 0; i < sampleTarget; i++) { if (!(await openOne())) break; }
    if (!conns.length) throw new Error('could not open any connection');
    const sampledConns = conns.length;
    const rtt0 = Date.now();
    try { await conns[0].stat('triboon-speedtest@invalid'); } catch {}
    const rttMs = Date.now() - rtt0;
    let group = null;
    for (const g of SPEEDTEST_GROUPS) {
      try {
        const r = await conns[0]._cmd(`GROUP ${g}`);
        if (r.status.startsWith('211')) {
          const [, count, first, last] = r.status.trim().split(/\s+/).map(Number);
          if (count > 1000) { group = { name: g, first, last }; break; }
        }
      } catch {}
    }
    let mbsPerConn = 0, articles = 0;
    if (group) {
      const sample = conns.slice(0, sampledConns);
      const t0 = Date.now(); let bytes = 0;
      await Promise.all(sample.map(async (c) => {
        try { await c._cmd(`GROUP ${group.name}`); } catch { return; }
        while (Date.now() - t0 < sampleMs) {
          try {
            const win = Math.min(group.last - group.first, 500000);
            const art = group.last - Math.floor(Math.random() * win);
            const r = await c._cmd(`BODY ${art}`, true);
            if (r.status.startsWith('222')) { bytes += r.body.length; articles++; }
          } catch { if (!c.alive) return; }
        }
      }));
      const secs = Math.max(0.1, (Date.now() - t0) / 1000);
      mbsPerConn = sample.length ? (bytes / 1e6 / secs) / sample.length : 0;
    }
    // Phase B — now open the REST up to the configured count (connect-only) to confirm the real cap.
    for (let i = conns.length; i < want; i++) { if (!(await openOne())) break; }
    return {
      ok: true, host: p.host,
      configured,
      connections: conns.length,             // how many actually opened = real usable for this provider
      connCap: capHit ? conns.length : null,  // set only when the provider refused below the configured count
      capHit,                                 // true = configured count exceeds the plan's real limit
      sampledConns,
      rttMs,
      mbpsPerConn: +(mbsPerConn * 8).toFixed(1),
      mbpsTotal: +(mbsPerConn * 8 * conns.length).toFixed(1), // projected across all opened connections
      articles,
      group: group ? group.name : null,
    };
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
  }
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
  // real playback: a sub-300MB "2160p" mount is junk, never auto-play it. (Tests disable via env —
  // their mount fixtures are intentionally KB-scale; the guard's logic is unit-tested directly.)
  enforceFeatureSize: process.env.TRIBOON_FEATURE_SIZE_GUARD !== '0',

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
  fetchOnlineSub, searchOnlineSubs, downloadBestSubtitle, rankSubs, usableVariants, distinctVariants, hasConfidentAutoPick, srtToVtt, shiftVtt, decodeSubtitleBuffer,
  osSearch, osNormalize, osLogin, osDownloadVtt, moviehashFromChunks, subtitleLooksSynced, subSyncResultOk,
  _isTransientError: isTransientSubError,
  _isNoSubtitleError: isNoSubtitleError,
} = require('./opensubs');
const IPTV_CACHE_TTL_MS = 24 * 3600000;
const EPG_CACHE_TTL_MS = 12 * 3600000;
const EPG_EMPTY_TTL_MS = 5 * 60000;
const EPG_CACHE_STALE_MS = 7 * 24 * 3600000;
const IPTV_WARM_DELAY_MS = 1500;
const IPTV_STARTUP_WARM_DELAY_MS = Math.max(5 * 60000, Math.min(30 * 60000, Number(process.env.TRIBOON_IPTV_STARTUP_WARM_DELAY_MS || 10 * 60000)));
const IPTV_WARM_INTERVAL_MS = 12 * 3600000;
const IPTV_WARM_XTREAM_GUIDE_MAX = 96;
const LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS = 12000;
const LIVE_REMUX_IDLE_TIMEOUT_MS = 45000;
const IPTV_NATIVE_FIRST_BYTE_TIMEOUT_MS = 10000;
const IPTV_NATIVE_ERROR_TTL_MS = 30000;
const IPTV_PROVIDER_PROTECTION_ERROR_TTL_MS = 5 * 60000;
const IPTV_LIVE_RETUNE_GRACE_MS = 650;
const IPTV_PLAYBACK_API_QUIET_MS = 7000;
const IPTV_GROUP_SEPARATOR = ' \u00B7 ';
const IPTV_PRIVATE_URL_CACHE_MS = 30 * 60000;
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
function normalizeIptvHttpUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return `http://${s}`;
}
function allowPrivateIptvTargets() {
  return /^(1|true|yes)$/i.test(String(process.env.TRIBOON_ALLOW_PRIVATE_IPTV || ''));
}
const iptvUrlSafetyCache = new Map();
function cleanUrlHostForPolicy(hostname) {
  return String(hostname || '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}
function isPrivateIpv4(ip) {
  const parts = String(ip || '').split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}
function ipv6Words(ip) {
  let s = cleanUrlHostForPolicy(ip).split('%')[0];
  if (!s || !s.includes(':')) return null;
  if (s.includes('.')) {
    const i = s.lastIndexOf(':');
    const dotted = s.slice(i + 1);
    const parts = dotted.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    s = `${s.slice(0, i)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some((x) => !x) || right.some((x) => !x)) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right]
    .map((x) => parseInt(x, 16));
  if (words.length !== 8 || words.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return null;
  return words;
}
function ipv4FromWords(words, i) {
  const hi = words[i], lo = words[i + 1];
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}
function embeddedIpv4FromIpv6(ip) {
  const w = ipv6Words(ip);
  if (!w) return null;
  const firstFiveZero = w.slice(0, 5).every((x) => x === 0);
  const firstSixZero = firstFiveZero && w[5] === 0;
  if (firstFiveZero && w[5] === 0xffff) return ipv4FromWords(w, 6); // ::ffff:127.0.0.1
  if (firstSixZero) return ipv4FromWords(w, 6); // deprecated ::127.0.0.1 / ::7f00:1
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return ipv4FromWords(w, 6); // 64:ff9b::/96 NAT64
  if (w[0] === 0x2002) return ipv4FromWords(w, 1); // 6to4 embeds IPv4 in 2002::/16
  if (w[0] === 0x2001 && w[1] === 0x0000) return '0.0.0.0'; // Teredo tunnels are blanket-blocked instead of decoded.
  return null;
}
function isPrivateIpv6(ip) {
  const s = cleanUrlHostForPolicy(ip);
  if (!s) return false;
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fe80:') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true;
  const embedded = embeddedIpv4FromIpv6(s);
  if (embedded && isPrivateIpv4(embedded)) return true;
  return false;
}
function isPrivateIptvHost(hostname) {
  const host = cleanUrlHostForPolicy(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipKind = net.isIP(host);
  if (ipKind === 4) return isPrivateIpv4(host);
  if (ipKind === 6) return isPrivateIpv6(host);
  return false;
}
function iptvPolicyError(label, detail) {
  const e = new Error(`${label} is not allowed: ${detail}`);
  e.status = 400;
  return e;
}
async function resolveIptvHost(host) {
  let timer;
  try {
    return await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), 3000);
        if (timer.unref) timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function pinnedIptvLookup(address, family) {
  return (_host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const pinnedFamily = family || net.isIP(address) || 4;
    process.nextTick(() => {
      if (opts && opts.all) cb(null, [{ address, family: pinnedFamily }]);
      else cb(null, address, pinnedFamily);
    });
  };
}
function iptvHostHeader(u) {
  const host = u && u.host ? String(u.host) : '';
  return host && !/[\r\n]/.test(host) ? host : '';
}
function pinnedIptvHref(u, address, family) {
  if (!address) return u.href;
  const cleanAddress = String(address).split('%')[0];
  const ipFamily = family || net.isIP(cleanAddress);
  const host = ipFamily === 6 ? `[${cleanAddress}]` : cleanAddress;
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${host}${port}${u.pathname}${u.search}${u.hash}`;
}
function iptvRemuxInputHref(pin, fallbackUrl) {
  const href = (pin && pin.href) || fallbackUrl;
  if (!href) return href;
  try {
    const u = new URL(href);
    // ffmpeg derives TLS SNI from the URL host. Keep HTTPS provider hostnames intact so
    // Cloudflare/shared panels present the right certificate; plain HTTP can use the pinned IP.
    if (u.protocol === 'https:') return href;
  } catch {}
  return (pin && pin.pinnedHref) || href;
}
function cachedIptvAddressKey(addr = {}) {
  return `${addr.family || net.isIP(addr.address) || 4}:${String(addr.address || '').split('%')[0]}`;
}
function pickCachedIptvAddress(host) {
  const hit = iptvUrlSafetyCache.get(host);
  if (!hit || !Array.isArray(hit.addrs) || !hit.addrs.length) return null;
  const now = Date.now();
  const failures = hit.failures || {};
  const addrs = hit.addrs.filter((a) => {
    const badUntil = failures[cachedIptvAddressKey(a)] || 0;
    return !badUntil || badUntil <= now;
  });
  const pool = addrs.length ? addrs : hit.addrs;
  if (!addrs.length) hit.failures = {};
  const offset = Math.max(0, hit.next || 0);
  const picked = pool[offset % pool.length];
  const pickedIdx = hit.addrs.findIndex((a) => cachedIptvAddressKey(a) === cachedIptvAddressKey(picked));
  hit.next = pickedIdx >= 0 ? pickedIdx + 1 : offset + 1;
  return picked || null;
}
function markIptvPinnedAddressFailure(pin, ttlMs = 60000) {
  if (!pin || !pin.cacheHost || !pin.address) return;
  const hit = iptvUrlSafetyCache.get(pin.cacheHost);
  if (!hit || !Array.isArray(hit.addrs)) return;
  const key = cachedIptvAddressKey(pin);
  hit.failures = hit.failures || {};
  hit.failures[key] = Date.now() + ttlMs;
  const idx = hit.addrs.findIndex((a) => cachedIptvAddressKey(a) === key);
  if (idx >= 0) hit.next = idx + 1;
}
async function validateAndPinIptvUrl(raw, label = 'IPTV URL') {
  const text = String(raw || '').trim();
  let u;
  try { u = new URL(text); }
  catch { throw iptvPolicyError(label, 'invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw iptvPolicyError(label, 'only http/https URLs are supported');
  if (allowPrivateIptvTargets()) return { href: u.href, pinnedHref: u.href, hostHeader: '' };
  const host = cleanUrlHostForPolicy(u.hostname);
  if (isPrivateIptvHost(host)) throw iptvPolicyError(label, 'private, loopback, or link-local hosts are blocked by default');
  let picked = null;
  let safeHit = null;
  if (net.isIP(host)) {
    picked = { address: host, family: net.isIP(host) };
  } else {
    const hit = iptvUrlSafetyCache.get(host);
    if (!hit || hit.expiresAt <= Date.now()) {
      let addrs;
      try { addrs = await resolveIptvHost(host); }
      catch { throw iptvPolicyError(label, 'host could not be resolved safely'); }
      if (!addrs.length) throw iptvPolicyError(label, 'host has no DNS addresses');
      const blocked = addrs.find((a) => isPrivateIptvHost(a && a.address));
      if (blocked) throw iptvPolicyError(label, 'DNS resolves to a private, loopback, or link-local address');
      iptvUrlSafetyCache.set(host, { expiresAt: Date.now() + IPTV_PRIVATE_URL_CACHE_MS, addrs });
      if (iptvUrlSafetyCache.size > 1000) iptvUrlSafetyCache.clear();
    }
    safeHit = iptvUrlSafetyCache.get(host);
    picked = safeHit && Array.isArray(safeHit.addrs) ? pickCachedIptvAddress(host) : null;
  }
  return {
    href: u.href,
    pinnedHref: pinnedIptvHref(u, picked && picked.address, picked && picked.family),
    hostHeader: iptvHostHeader(u),
    cacheHost: net.isIP(host) ? '' : host,
    address: picked && picked.address,
    family: picked && picked.family,
    addressCount: safeHit && Array.isArray(safeHit.addrs) ? safeHit.addrs.length : (picked ? 1 : 0),
    lookup: picked && picked.address ? pinnedIptvLookup(picked.address, picked.family) : undefined,
    onFailure: () => markIptvPinnedAddressFailure({ cacheHost: net.isIP(host) ? '' : host, address: picked && picked.address, family: picked && picked.family }),
  };
}
async function assertIptvUrlAllowed(raw, label = 'IPTV URL') {
  return (await validateAndPinIptvUrl(raw, label)).href;
}
async function assertIptvSourceAllowed(src = {}) {
  if (src.iptvMode === 'xtream') {
    if (src.xtHost) await assertIptvUrlAllowed(src.xtHost, 'Xtream host');
  } else if (src.iptvUrl) {
    await assertIptvUrlAllowed(src.iptvUrl, 'M3U playlist URL');
  }
  if (src.epgUrl) await assertIptvUrlAllowed(src.epgUrl, 'XMLTV EPG URL');
  return src;
}
function iptvFetchOptions(opts = {}) {
  return { ...opts, validateUrl: (url) => validateAndPinIptvUrl(url, 'IPTV upstream URL') };
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
    iptvUrl: normalizeIptvHttpUrl(raw.iptvUrl || raw.url),
    xtHost: normalizeIptvHttpUrl(raw.xtHost || raw.host),
    xtUser: raw.xtUser || raw.username || raw.user || null,
    xtPass: raw.xtPass || raw.password || raw.pass || null,
    epgUrl: normalizeIptvHttpUrl(raw.epgUrl || raw.xmltvUrl),
    users: Array.isArray(raw.users) ? raw.users.map(String).slice(0, 100) : [],
    ownerUserId: raw.ownerUserId ? String(raw.ownerUserId).slice(0, 64) : null,
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
  return !user || user.role === 'admin' || src.ownerUserId === user.id || !users.length || users.includes(user.id);
}
function iptvSourcesForUser(user, s = settings.get()) {
  return iptvSourcesFromSettings(s).filter((src) => userCanAccessIptvSource(user, src));
}
function iptvOwnedSourcesForUser(user, s = settings.get()) {
  return iptvSourcesFromSettings(s).filter((src) => user && src.ownerUserId === user.id);
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
    personal: !!src.ownerUserId,
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
    ownerUserId: b.ownerUserId !== undefined ? b.ownerUserId : (existing && existing.ownerUserId),
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
  iptvCache = { key: null, at: 0, channels: [], sourceErrors: [] };
}
function clearIptvSourceRuntime(sourceId) {
  const id = cleanIptvSourceId(sourceId);
  iptvSourceCaches.delete(id);
  epgSourceCaches.delete(id);
  xtreamEpgSourceCaches.delete(id);
  iptvRefreshingSources.delete(id);
  clearIptvAggregateCache();
  // Drop the negative (4xx/5xx/backoff) cache too, or a freshly fixed/re-added source stays dark
  // for the cached TTL (up to several minutes for provider-protection codes). It self-rebuilds.
  iptvNativeErrorCache = new Map();
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
function cleanupDeletedIptvSource(sourceId, removed = null) {
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
    const prefix = `${removed.name}${IPTV_GROUP_SEPARATOR}`;
    store.update('iptvgroups', {}, (all) => {
      for (const uid of Object.keys(all || {})) {
        if (Array.isArray(all[uid])) all[uid] = all[uid].filter((g) => !String(g).startsWith(prefix));
      }
      return all;
    });
  }
}
function cleanupEditedIptvSource(sourceId, before = null, after = null) {
  clearIptvSourceRuntime(sourceId);
  deleteIptvDiskCache(sourceId);
  const upstreamChanged = before && after && iptvSourceKey(before) !== iptvSourceKey(after);
  if (upstreamChanged) {
    store.update('iptvfavs', {}, (all) => {
      const prefix = `${sourceId}:`;
      for (const uid of Object.keys(all || {})) {
        if (Array.isArray(all[uid])) all[uid] = all[uid].filter((id) => !String(id).startsWith(prefix));
      }
      return all;
    });
  }
  if (before && before.name && (!after || before.name !== after.name || upstreamChanged)) {
    const prefix = `${before.name}${IPTV_GROUP_SEPARATOR}`;
    store.update('iptvgroups', {}, (all) => {
      for (const uid of Object.keys(all || {})) {
        if (Array.isArray(all[uid])) all[uid] = all[uid].filter((g) => !String(g).startsWith(prefix));
      }
      return all;
    });
  }
}
function iptvEditBodyForExisting(b = {}, existing = null) {
  if (!existing) return b;
  const out = { ...b };
  const mode = normalizeIptvMode(out.iptvMode || out.mode || existing.iptvMode);
  const sameMode = mode === existing.iptvMode;
  if (sameMode && mode === 'xtream') {
    if (out.xtHost !== undefined && !String(out.xtHost || '').trim()) delete out.xtHost;
    if (out.xtUser !== undefined && !String(out.xtUser || '').trim()) delete out.xtUser;
    if (out.xtPass !== undefined && out.xtPass === '') delete out.xtPass;
  }
  if (sameMode && mode === 'm3u' && out.iptvUrl !== undefined && !String(out.iptvUrl || '').trim()) {
    delete out.iptvUrl;
  }
  if (out.epgUrl !== undefined && !String(out.epgUrl || '').trim()) out.epgUrl = null;
  return out;
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
const IPTV_PLAYBACK_USER_AGENTS = [
  IPTV_NATIVE_PROXY_UA,
  'VLC/3.0.20 LibVLC/3.0.20',
  'IPTVSmartersPro/4.0',
];
function iptvPlaybackUserAgent(idx = 0) {
  return IPTV_PLAYBACK_USER_AGENTS[Math.max(0, Math.min(IPTV_PLAYBACK_USER_AGENTS.length - 1, idx))] || IPTV_NATIVE_PROXY_UA;
}
function shouldRetryIptvUserAgent(status, reason, uaIndex = 0) {
  if (uaIndex >= IPTV_PLAYBACK_USER_AGENTS.length - 1) return false;
  const r = String(reason || '').toLowerCase();
  return (status === 401 || status === 403) && (r.includes('bot-protection') || r.includes('bot protection'));
}
function iptvStatusFromError(err) {
  const m = /HTTP\s+(\d{3})/i.exec(String(err && err.message ? err.message : err || ''));
  return m ? parseInt(m[1], 10) : 0;
}
function shouldRetryIptvFetchUserAgent(err, uaIndex = 0) {
  if (uaIndex >= IPTV_PLAYBACK_USER_AGENTS.length - 1) return false;
  const status = iptvStatusFromError(err);
  const text = String(err && err.message ? err.message : err || '').toLowerCase();
  return (status === 401 || status === 403)
    && (text.includes('bot-protection') || text.includes('bot protection') || text.includes('m3u playlist http'));
}
function iptvNativeLogLabel(meta = {}) {
  const idx = Number.isInteger(meta.idx) ? `#${meta.idx}` : '#?';
  const name = String(meta.name || 'channel').replace(/[\r\n]+/g, ' ').slice(0, 80);
  return `${idx} "${name}"${meta.alt ? ' fallback' : ''}`;
}
function iptvLiveSlotKey(ctx) {
  const uid = ctx && ctx.claims && ctx.claims.uid ? ctx.claims.uid : 'unknown';
  const ip = ctx && ctx.req && ctx.req.socket ? (ctx.req.socket.remoteAddress || '') : '';
  const ua = ctx && ctx.req && ctx.req.headers ? String(ctx.req.headers['user-agent'] || '').slice(0, 80) : '';
  // The client sends a per-surface id (main / split / mv0..3) so concurrent multiview panes each
  // get their own live slot instead of evicting one another. Retuning the SAME surface still
  // reuses its key and closes the old upstream stream, as intended.
  const surface = ctx && ctx.url && ctx.url.searchParams ? String(ctx.url.searchParams.get('surface') || '').slice(0, 16) : '';
  return idHash(`${uid}|${ip}|${ua}|${surface}`);
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
    return iptvProviderProtectionTtlMs();
  }
  if (status === 401 || status === 403) return iptvProviderProtectionTtlMs();
  return IPTV_NATIVE_ERROR_TTL_MS;
}
function iptvProviderProtectionTtlMs() {
  const raw = Number(process.env.TRIBOON_IPTV_PROVIDER_PROTECTION_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return IPTV_PROVIDER_PROTECTION_ERROR_TTL_MS;
  return Math.max(1000, Math.min(15 * 60000, Math.floor(raw)));
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
  // Browser remux prefers HLS first when available. Xtream TS URLs often redirect or trip
  // provider rate protection before ffmpeg emits a frame; native Android still receives TS.
  add(ch.url, iptvNativeMime(ch.url) === 'application/x-mpegURL' ? 'hls' : 'primary');
  add(ch.nativeFallbackUrl, 'fallback');
  if (ch.nativeUrl && iptvNativeMime(ch.nativeUrl) === 'video/mp2t') add(ch.nativeUrl, 'ts');
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
    connection: 'close',
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
  let firstByteTimer = null;
  let refreshedForStaleChannel = false;
  const label = iptvNativeLogLabel(meta);
  const clearFirstByteTimer = () => { if (firstByteTimer) clearTimeout(firstByteTimer); firstByteTimer = null; };
  const stop = (reason = 'closed', err) => {
    if (done) return;
    done = true;
    if (delayTimer) clearTimeout(delayTimer);
    clearFirstByteTimer();
    try { if (up) up.destroy(err || new Error(`live stream ${reason}`)); } catch {}
    if (/client closed|retuned|shutdown/i.test(String(reason || ''))) {
      try { if (ctx.req.socket && !ctx.req.socket.destroyed) ctx.req.socket.destroy(); } catch {}
      try { if (!ctx.res.destroyed && !ctx.res.writableEnded) ctx.res.destroy(); } catch {}
    }
    slot.done(reason);
    ctx.req.off('close', onClientClose);
    ctx.req.off('aborted', onClientClose);
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
  ctx.req.once('aborted', onClientClose);
  ctx.res.once('close', onClientClose);

  const open = (rawTarget, hop, pinRetries = 0, uaIndex = 0) => {
    if (done || slot.closed) return;
    validateAndPinIptvUrl(rawTarget, 'Live stream URL').then((pin) => openAllowed(rawTarget, hop, pin, pinRetries, uaIndex)).catch((e) => {
      console.error(`[iptv native] ${label} blocked upstream url: ${sanitizeIptvLogError(e)}`);
      fail(e.status || 400, e.message || 'blocked live stream url');
    });
  };
  const openAllowed = (rawTarget, hop, pin = null, pinRetries = 0, uaIndex = 0) => {
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
      'user-agent': iptvPlaybackUserAgent(uaIndex),
      accept: '*/*',
      connection: 'close',
    };
    if (ctx.req.headers.range) headers.range = ctx.req.headers.range;
    const markPinFailure = () => {
      if (pin && typeof pin.onFailure === 'function') {
        try { pin.onFailure(); } catch {}
      }
    };
    const retryPinnedAddress = (reason) => {
      markPinFailure();
      if (ctx.res.headersSent || ctx.res.destroyed || done || slot.closed) return false;
      if (!pin || !pin.cacheHost || !pin.address || (pin.addressCount || 0) <= pinRetries + 1) return false;
      clearFirstByteTimer();
      const old = up; up = null;
      try {
        if (old) {
          old.removeAllListeners('error');
          // Destroying an aborted ClientRequest emits 'error' ASYNCHRONOUSLY (next tick), outside
          // this try/catch. With the real handler removed and no replacement, that becomes an
          // unhandled 'error' event and crashes the whole process — taking every stream down for a
          // single channel's startup timeout. Swallow the abort error: we are intentionally
          // discarding this request and the new attempt below owns error handling.
          old.on('error', () => {});
          old.destroy();
        }
      } catch {}
      console.error(`[iptv native] ${label} pinned upstream failed (${reason}); retrying next address`);
      open(rawTarget, hop, pinRetries + 1, uaIndex);
      return true;
    };
    up = lib.request(u, {
      method: 'GET',
      headers,
      agent: false,
      ...(pin && typeof pin.lookup === 'function' ? { lookup: pin.lookup } : {}),
    }, (r) => {
      clearFirstByteTimer();
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
          if (shouldRetryIptvUserAgent(status, reason, uaIndex) && !done && !slot.closed) {
            console.error(`[iptv native] ${label} provider bot-protection with playback identity ${uaIndex + 1}; retrying alternate identity`);
            return open(rawTarget, hop, pinRetries, uaIndex + 1);
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
        connection: 'close',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        if (r.headers[h]) out[h] = r.headers[h];
      }
      ctx.res.writeHead(r.statusCode || 502, out);
      firstByteTimer = setTimeout(() => {
        if (retryPinnedAddress('startup timeout')) return;
        markPinFailure();
        fail(504, { status: 504, reason: 'live stream startup timeout' });
      }, IPTV_NATIVE_FIRST_BYTE_TIMEOUT_MS);
      firstByteTimer.unref();
      r.once('data', clearFirstByteTimer);
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
      if (retryPinnedAddress('connection error')) return;
      markPinFailure();
      console.error(`[iptv native] ${label} upstream error: ${String(e.message).slice(0, 160)}`);
      if (!ctx.res.headersSent) send(ctx.res, 502, { error: 'live stream failed' });
      else try { ctx.res.destroy(e); } catch {}
      stop('upstream error');
    });
    firstByteTimer = setTimeout(() => {
      if (retryPinnedAddress('startup timeout')) return;
      markPinFailure();
      fail(504, { status: 504, reason: 'live stream startup timeout' });
    }, IPTV_NATIVE_FIRST_BYTE_TIMEOUT_MS);
    firstByteTimer.unref();
    up.setTimeout(IPTV_NATIVE_FIRST_BYTE_TIMEOUT_MS, () => {
      if (retryPinnedAddress('upstream timeout')) return;
      markPinFailure();
      up.destroy(new Error('live stream upstream timeout'));
    });
    up.end();
  };

  if (slot.replaced && hops === 0) {
    delayTimer = setTimeout(() => { delayTimer = null; open(target, hops); }, IPTV_LIVE_RETUNE_GRACE_MS);
    delayTimer.unref();
  } else {
    open(target, hops);
  }
}
function shouldResolveIptvRemuxRedirect(err) {
  const text = String(err || '');
  return /redirect|server returned\s+30\d|http error\s+30\d|error opening input|i\/o error/i.test(text);
}
async function resolveIptvRemuxRedirect(rawTarget, maxHops = 5) {
  let current = String(rawTarget || '').trim();
  for (let hop = 0; hop <= maxHops; hop++) {
    const pin = await validateAndPinIptvUrl(current, 'Live stream URL');
    const u = new URL(pin.href);
    const lib = u.protocol === 'https:' ? https : http;
    const next = await new Promise((resolve, reject) => {
      const req = lib.request(u, {
        method: 'GET',
        headers: {
          'user-agent': IPTV_NATIVE_PROXY_UA,
          accept: '*/*',
          connection: 'close',
        },
        agent: false,
        ...(pin && typeof pin.lookup === 'function' ? { lookup: pin.lookup } : {}),
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve(new URL(res.headers.location, u).href);
          return;
        }
        req.destroy();
        resolve('');
      });
      req.on('error', reject);
      req.setTimeout(2500, () => req.destroy(new Error('live remux redirect probe timeout')));
      req.end();
    });
    if (!next) return current;
    current = next;
  }
  throw new Error('too many live stream redirects');
}
let iptvRefreshing = false;
let iptvWarmRunning = false;
let iptvWarmTimer = null;
let iptvWarmSoonTimer = null;
let iptvWarmNextAt = 0;
let iptvWarmSoonNextAt = 0;
let iptvWarmReason = '';
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
  const headers = { ...(opts.headers || {}) };
  if (!headers['user-agent']) headers['user-agent'] = IPTV_NATIVE_PROXY_UA;
  return {
    ...opts,
    headers: {
      ...headers,
      'cache-control': 'no-cache',
      pragma: 'no-cache',
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
  let list = [];
  let lastError = null;
  for (let uaIndex = 0; uaIndex < IPTV_PLAYBACK_USER_AGENTS.length; uaIndex++) {
    try {
      list = await fetchM3uChannelsStream(xtreamM3uPlaylistUrl(s), {
        maxChannels: 20000,
        timeoutMs: 15000,
        deadlineMs: 90000,
        headers: {
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'user-agent': iptvPlaybackUserAgent(uaIndex),
        },
      });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (!shouldRetryIptvFetchUserAgent(e, uaIndex)) throw e;
      console.error(`[iptv refresh] Xtream M3U fallback hit provider protection with playback identity ${uaIndex + 1}; retrying alternate identity`);
    }
  }
  if (lastError) throw lastError;
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
  const s = sourceForIptvChannel(staleCh);
  if (!s || s.iptvMode !== 'xtream' || !staleCh || !staleCh.xtreamId) return null;
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
      group: multiple ? `${src.name}${IPTV_GROUP_SEPARATOR}${sourceGroup}` : sourceGroup,
      sourceGroup,
    };
  }));
}
function sourceCacheLabel(src, channels) {
  return `${src.iptvMode === 'xtream' ? 'Xtream' : 'playlist'} source=${src.name} channels=${channels.length}`;
}
function iptvSourceErrorPayload(src, e) {
  return {
    sourceId: cleanIptvSourceId(src && src.id),
    sourceName: (src && src.name) || 'Live TV',
    mode: normalizeIptvMode(src && src.iptvMode),
    error: sanitizeIptvLogError(e).slice(0, 220),
  };
}
function publicIptvError(err = {}) {
  return {
    sourceId: cleanIptvSourceId(err.sourceId),
    sourceName: String(err.sourceName || 'Live TV').slice(0, 80),
    mode: normalizeIptvMode(err.mode),
    error: sanitizeIptvLogError(err.error || '').slice(0, 220),
  };
}
function isIptvChannelLoadError(errorText) {
  const text = String(errorText || '').toLowerCase();
  return text.includes('xtream channel load')
    || text.includes('m3u playlist')
    || text.includes('playlist upstream')
    || text.includes('no live channels found')
    || text.includes('xtream returned invalid json');
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
  return (await loadIptvChannelState(sources)).channels;
}
function iptvAggregateKeyForSources(sources = []) {
  return (sources || []).filter(iptvSourceConfigured).map((src) => `${src.id}:${iptvSourceKey(src)}`).join('|');
}
async function loadIptvChannelState(sources = iptvSourcesFromSettings(settings.get())) {
  const usable = (sources || []).filter(iptvSourceConfigured);
  if (!usable.length) {
    clearIptvAggregateCache();
    return { channels: [], sourceErrors: [] };
  }
  const aggregateKey = iptvAggregateKeyForSources(usable);
  if (iptvCache.key === aggregateKey && Date.now() - iptvCache.at < IPTV_CACHE_TTL_MS) {
    return { channels: iptvCache.channels, sourceErrors: iptvCache.sourceErrors || [] };
  }
  const rows = [];
  const errors = [];
  await mapLimit(usable, Math.min(3, usable.length), async (src) => {
    try {
      const channels = await loadIptvChannelsForSource(src);
      if (channels.length) rows.push({ src, channels });
      else {
        errors.push({ src, error: new Error('no live channels found in this source') });
        console.error(`[iptv] source "${src.name}" loaded no live channels`);
      }
    } catch (e) {
      errors.push({ src, error: e });
      console.error(`[iptv] source "${src.name}" failed: ${sanitizeIptvLogError(e)}`);
    }
  });
  const channels = aggregateIptvChannels(rows);
  const sourceErrors = errors.map(({ src, error }) => iptvSourceErrorPayload(src, error));
  iptvCache = { key: aggregateKey, at: Date.now(), channels, sourceErrors };
  return { channels, sourceErrors };
}
async function ensureIptvChannelStateForUser(user) {
  if (!user) {
    clearIptvAggregateCache();
    return { sources: [], channels: [], sourceErrors: [] };
  }
  const sources = iptvSourcesForUser(user, settings.get());
  const aggregateKey = iptvAggregateKeyForSources(sources);
  if (!aggregateKey) {
    clearIptvAggregateCache();
    return { sources, channels: [], sourceErrors: [] };
  }
  if (iptvCache.key !== aggregateKey || !Array.isArray(iptvCache.channels)) {
    const state = await loadIptvChannelState(sources);
    return { sources, ...state };
  }
  return { sources, channels: iptvCache.channels || [], sourceErrors: iptvCache.sourceErrors || [] };
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
  let validated = null;
  return Promise.resolve()
    .then(() => validateAndPinIptvUrl(playlistUrl, 'M3U playlist URL'))
    .then((v) => { validated = v; })
    .then(() => new Promise((resolve, reject) => {
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
    const requestOptions = {
      headers: { ...(opts.headers || {}), 'user-agent': (opts.headers && opts.headers['user-agent']) || IPTV_NATIVE_PROXY_UA },
      ...(validated && typeof validated.lookup === 'function' ? { lookup: validated.lookup } : {}),
    };
    const markPinFailure = () => {
      if (validated && typeof validated.onFailure === 'function') {
        try { validated.onFailure(); } catch {}
      }
    };
    req = client.get(u, requestOptions, (res) => {
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
      res.on('error', (e) => { markPinFailure(); done(e); });
    });
    req.on('error', (e) => { markPinFailure(); done(e); });
    req.setTimeout(timeoutMs, () => { markPinFailure(); done(new Error('m3u playlist upstream timeout')); });
  }));
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
      let lastError = null;
      try {
        const u = `${apiBase}&action=${action}&_=${Date.now().toString(36)}`;
        for (let uaIndex = 0; uaIndex < IPTV_PLAYBACK_USER_AGENTS.length; uaIndex++) {
          try {
            const r = await fetchUrlExt(u, iptvFetchOptions(xtreamPanelFetchOptions({
              ...opts,
              headers: { ...(opts && opts.headers ? opts.headers : {}), 'user-agent': iptvPlaybackUserAgent(uaIndex) },
            })));
            if ((r.status || 0) >= 400) {
              const body = r.body.toString('utf8', 0, 2048);
              throw new Error(`HTTP ${r.status} (${iptvNativeFailureReason(r.status || 502, body)})`);
            }
            return r;
          } catch (e) {
            lastError = e;
            if (!shouldRetryIptvFetchUserAgent(e, uaIndex)) throw e;
            console.error(`[iptv xtream] ${action} hit provider protection with playback identity ${uaIndex + 1}; retrying alternate identity`);
          }
        }
      } catch (e) {
        if (action === 'get_live_categories') {
          console.error(`[iptv xtream] optional category load failed for source "${String(s.name || 'Live TV').slice(0, 80)}": ${sanitizeIptvLogError(e)}; loading streams without categories`);
          return { status: 200, body: Buffer.from('[]') };
        }
        throw new Error(`Xtream channel load action=${action} host=${iptvSafeHost(s.xtHost)} failed: ${sanitizeIptvLogError(e)}`);
      }
      throw lastError || new Error('Xtream channel load failed');
    };
    try {
      const [catsR, streamsR] = await Promise.all([
        fetchPanel('get_live_categories', { timeoutMs: 10000, deadlineMs: 25000, maxBytes: 5 * 1024 * 1024 }),
        fetchPanel('get_live_streams', { timeoutMs: 10000, deadlineMs: 40000, maxBytes: 30 * 1024 * 1024 }),
      ]);
      let cats = {};
      try {
        cats = Object.fromEntries((JSON.parse(catsR.body.toString('utf8') || '[]') || []).map((c) => [String(c.category_id), c.category_name]));
      } catch (e) {
        console.error(`[iptv xtream] optional category JSON failed for source "${String(s.name || 'Live TV').slice(0, 80)}": ${sanitizeIptvLogError(e)}; loading streams without categories`);
      }
      let streams;
      try {
        streams = JSON.parse(streamsR.body.toString('utf8') || '[]') || [];
      } catch {
        throw new Error('xtream stream list returned invalid JSON (check host/credentials)');
      }
      channels = streams.slice(0, 20000).map((x, i) => ({
        idx: i, id: 'xt' + x.stream_id, name: x.name || 'Channel ' + x.stream_id,
        logo: x.stream_icon || '', group: cats[String(x.category_id)] || 'Other',
        tvgId: x.epg_channel_id || '', xtreamId: x.stream_id,
        ...xtChannelUrls(s, x.stream_id),
      }));
    } catch (panelError) {
      let fallback = [];
      try {
        fallback = await fetchXtreamM3uChannelsForPlayback(s, key, 'panel channel list failure');
      } catch (fallbackError) {
        throw new Error(`${sanitizeIptvLogError(panelError)}; Xtream M3U fallback failed: ${sanitizeIptvLogError(fallbackError)}`);
      }
      if (!fallback.length) throw new Error(`${sanitizeIptvLogError(panelError)}; Xtream M3U fallback returned no live channels`);
      console.error(`[iptv xtream] source "${String(s.name || 'Live TV').slice(0, 80)}" loaded ${fallback.length} channel(s) from M3U after panel list failed: ${sanitizeIptvLogError(panelError)}`);
      channels = fallback;
    }
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
function xmlAttr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(String(attrs || ''));
  return m ? m[1] : '';
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
  const r = await fetchUrlExt(xmltvUrl, iptvFetchOptions({ timeoutMs: 20000, deadlineMs: 90000, maxBytes: 128 * 1024 * 1024 }));
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
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  n = 0;
  while ((m = re.exec(text)) && n < 200000) {
    n++;
    const attrs = m[1] || '';
    const channelId = xmlAttr(attrs, 'channel');
    if (!channelId) continue;
    if (wanted.size && !wanted.has(channelId)) continue;
    const title = ((/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!title) continue;
    const start = parseXmltvDate(xmlAttr(attrs, 'start'));
    const stop = parseXmltvDate(xmlAttr(attrs, 'stop'));
    if (!start || !stop || stop < keepFrom || start > keepTo) continue;
    if (!byChannel.has(channelId)) byChannel.set(channelId, []);
    byChannel.get(channelId).push({ start, stop, title });
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
  const guideBlockedUntil = Number(raw.guideBlockedUntil) || 0;
  xtreamEpgCache = { key, sourceId: sid, byStream, guideBlockedUntil };
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
    const guideBlockedUntil = Number(cache.guideBlockedUntil) || 0;
    const body = { key: xtreamEpgStoreKey(cache.key), at: Date.now(), streams };
    if (guideBlockedUntil > Date.now()) body.guideBlockedUntil = guideBlockedUntil;
    store.update('xtreamepgcaches', {}, (all) => { all[sourceId] = body; return all; });
    if (sourceId === IPTV_LEGACY_SOURCE_ID) store.write('xtreamepgcache', body);
  } catch {}
}
async function fetchXtreamEpgAction(s, ch, limit, action, timeouts = {}) {
  const base = String(s.xtHost).replace(/\/+$/, '');
  const u = `${base}/player_api.php?username=${encodeURIComponent(s.xtUser || '')}&password=${encodeURIComponent(s.xtPass || '')}&action=${action}&stream_id=${ch.xtreamId}&limit=${Math.max(2, Math.min(48, limit))}`;
  let r;
  try {
    r = await fetchUrlExt(u, iptvFetchOptions({ timeoutMs: timeouts.timeoutMs || 8000, deadlineMs: timeouts.deadlineMs || 15000, maxBytes: 2 * 1024 * 1024 }));
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
function xtreamGuideFailureTtlMs(err) {
  const text = String(err && err.message ? err.message : err || '').toLowerCase();
  if (text.includes('bot-protection') || text.includes('rate limit') || /\b(401|403|429)\b/.test(text)) {
    return iptvProviderProtectionTtlMs();
  }
  return EPG_EMPTY_TTL_MS;
}
function isXtreamGuideProviderProtection(err) {
  const text = String(err && err.message ? err.message : err || '').toLowerCase();
  return text.includes('bot-protection') || text.includes('rate limit') || /\b(401|403|429)\b/.test(text);
}
function xtreamGuideSourceBlocked(cache) {
  return !!(cache && Number(cache.guideBlockedUntil || 0) > Date.now());
}
function markXtreamGuideSourceBlocked(cache, err, src = {}) {
  if (!cache || !isXtreamGuideProviderProtection(err)) return false;
  const until = Date.now() + xtreamGuideFailureTtlMs(err);
  if (Number(cache.guideBlockedUntil || 0) >= until - 1000) return true;
  cache.guideBlockedUntil = until;
  cache.guideBlockedReason = sanitizeIptvLogError(err);
  persistXtreamEpgCache(cache);
  const ttlSec = Math.max(1, Math.round((until - Date.now()) / 1000));
  console.warn(`[iptv xtream guide] source "${src.name || cache.sourceId || 'Xtream'}" paused for ${ttlSec}s after provider rejection: ${cache.guideBlockedReason}`);
  return true;
}
function pruneXtreamEpgStreamCache(cache) {
  if (!cache || !cache.byStream || cache.byStream.size <= 5000) return;
  const entries = [...cache.byStream.entries()]
    .sort((a, b) => ((a[1] && (a[1].at || a[1].until)) || 0) - ((b[1] && (b[1].at || b[1].until)) || 0));
  for (const [id] of entries.slice(0, Math.max(1, entries.length - 4500))) cache.byStream.delete(id);
}
async function xtreamEpgList(ch, { limit = 24, allowBusy = false } = {}) {
  const s = sourceForIptvChannel(ch);
  if (!s || s.iptvMode !== 'xtream' || !ch.xtreamId) return [];
  const sourceId = cleanIptvSourceId(s.id);
  const key = iptvSourceKey(s);
  let cache = xtreamEpgSourceCaches.get(sourceId);
  if (!cache || cache.key !== key) cache = hydrateXtreamEpgCache(key, sourceId);
  const id = String(ch.xtreamId);
  const hit = cache.byStream.get(id);
  if (hit && hit.until && Date.now() < hit.until) return hit.list || [];
  if (hit && Date.now() - hit.at < (hit.list && hit.list.length ? EPG_CACHE_TTL_MS : EPG_EMPTY_TTL_MS)) return hit.list;
  if (iptvPlaybackBusy() && !allowBusy) return hit && hit.list ? hit.list : [];
  if (xtreamGuideSourceBlocked(cache)) return hit && hit.list ? hit.list : [];
  if (hit && hit.list && hit.list.length && Date.now() - hit.at <= EPG_CACHE_STALE_MS) {
    if (!hit.promise) {
      const p = fetchXtreamEpgList(s, ch, limit).then((list) => {
        cache.guideBlockedUntil = 0;
        cache.guideBlockedReason = '';
        cache.byStream.set(id, { at: Date.now(), list });
        pruneXtreamEpgStreamCache(cache);
        if (list.length) persistXtreamEpgCache(cache);
        return list;
      }).catch((e) => {
        // Stale-cache refresh is fire-and-forget; provider timeouts must not surface as
        // unhandled rejections that can kill the container.
        markXtreamGuideSourceBlocked(cache, e, s);
        const ageMin = Math.max(0, Math.round((Date.now() - hit.at) / 60000));
        if (!xtreamGuideSourceBlocked(cache)) console.error(`[iptv xtream guide] ${iptvChannelLogLabel(ch)} refresh failed; serving stale cache age=${ageMin}m: ${sanitizeIptvLogError(e)}`);
        cache.byStream.set(id, { at: hit.at, list: hit.list });
        return hit.list;
      });
      cache.byStream.set(id, { ...hit, promise: p });
    }
    return hit.list;
  }
  if (hit && hit.promise) return hit.promise;
  const p = fetchXtreamEpgList(s, ch, limit).then((list) => {
    cache.guideBlockedUntil = 0;
    cache.guideBlockedReason = '';
    cache.byStream.set(id, { at: Date.now(), list });
    pruneXtreamEpgStreamCache(cache);
    if (list.length) persistXtreamEpgCache(cache);
    return list;
  });
  cache.byStream.set(id, { at: 0, list: hit ? hit.list : [], promise: p });
  try {
    return await p;
  } catch (e) {
    const sourceBlocked = markXtreamGuideSourceBlocked(cache, e, s);
    if (!sourceBlocked) console.error(`[iptv xtream guide] ${iptvChannelLogLabel(ch)} fetch failed; using ${hit && hit.list ? 'previous cache' : 'channel-title fallback'}: ${sanitizeIptvLogError(e)}`);
    cache.byStream.set(id, { at: hit && hit.at ? hit.at : Date.now(), list: hit && hit.list ? hit.list : [], until: Date.now() + xtreamGuideFailureTtlMs(e) });
    pruneXtreamEpgStreamCache(cache);
    if (hit) return hit.list;
    return [];
  }
}
async function epgNowNext(ch) {
  const s = sourceForIptvChannel(ch);
  if (!s) return {};
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
function readIptvSyncState() {
  const raw = store.read('iptvsync', {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}
function writeIptvSyncState(patch = {}) {
  const next = { ...readIptvSyncState(), ...patch };
  store.write('iptvsync', next);
  return next;
}
function iptvGuideStatusForSource(src, channels = []) {
  const sourceId = cleanIptvSourceId(src.id);
  const out = { kind: 'none', cachedAt: 0, guideChannels: 0, xtreamGuideChannels: 0 };
  if (xmltvGuideUrl(src)) {
    const disk = hydrateXmltvCache((store.read('epgcaches', {}) || {})[sourceId]
      || (sourceId === IPTV_LEGACY_SOURCE_ID ? store.read('epgcache', null) : null), epgSourceKey(src));
    const cache = epgSourceCaches.get(sourceId) || disk;
    out.kind = 'xmltv';
    out.cachedAt = cache && Number(cache.at) || 0;
    out.guideChannels = cache && cache.byChannel ? cache.byChannel.size : 0;
  }
  if (src.iptvMode === 'xtream') {
    const key = iptvSourceKey(src);
    const cache = xtreamEpgSourceCaches.get(sourceId) || hydrateXtreamEpgCache(key, sourceId);
    out.kind = out.kind === 'xmltv' ? 'xtream+xmltv' : 'xtream';
    out.xtreamGuideChannels = cache && cache.byStream ? cache.byStream.size : 0;
    let newest = out.cachedAt;
    if (cache && cache.byStream) {
      for (const e of cache.byStream.values()) newest = Math.max(newest, Number(e && e.at) || 0);
    }
    out.cachedAt = newest;
    out.guideChannels = Math.max(out.guideChannels, out.xtreamGuideChannels);
  }
  if (channels.length && out.kind === 'none') out.guideChannels = 0;
  return out;
}
function iptvSyncSnapshot() {
  const sources = iptvSourcesFromSettings(settings.get());
  const activeSourceIds = new Set(sources.map((src) => cleanIptvSourceId(src.id)));
  const state = readIptvSyncState();
  const savedSourceErrors = (iptvCache.sourceErrors && iptvCache.sourceErrors.length ? iptvCache.sourceErrors : (state.sourceErrors || []))
    .map(publicIptvError)
    .filter((e) => activeSourceIds.has(e.sourceId));
  const nextScheduledAt = [iptvWarmSoonNextAt, iptvWarmNextAt].filter((n) => n && n > Date.now()).sort((a, b) => a - b)[0] || 0;
  const sourceStatusBase = sources.map((src) => {
    const sourceId = cleanIptvSourceId(src.id);
    const runtime = iptvSourceCaches.get(sourceId);
    const channels = runtime && Array.isArray(runtime.channels) ? runtime.channels : [];
    const guide = iptvGuideStatusForSource(src, channels);
    return {
      sourceId,
      sourceName: src.name,
      mode: src.iptvMode,
      channelCount: channels.length,
      channelCachedAt: runtime && Number(runtime.at) || 0,
      guideKind: guide.kind,
      guideChannels: guide.guideChannels,
      guideCachedAt: guide.cachedAt,
      refreshing: iptvRefreshingSources.has(sourceId) || epgRefreshingSources.has(sourceId),
    };
  });
  const loadedSourceIds = new Set(sourceStatusBase.filter((s) => s.channelCount > 0).map((s) => s.sourceId));
  const sourceErrors = savedSourceErrors.filter((e) => !(loadedSourceIds.has(e.sourceId) && isIptvChannelLoadError(e.error)));
  const sourceStatus = sourceStatusBase.map((row) => {
    const err = sourceErrors.find((e) => e.sourceId === row.sourceId) || null;
    return { ...row, error: err ? err.error : null };
  });
  const channelCount = (iptvCache.channels || []).length
    || sourceStatus.reduce((sum, s) => sum + (Number(s.channelCount) || 0), 0);
  return {
    configured: sources.length > 0,
    running: iptvWarmRunning,
    reason: iptvWarmReason || state.reason || null,
    startedAt: state.startedAt || 0,
    finishedAt: state.finishedAt || 0,
    nextScheduledAt,
    nextReason: nextScheduledAt ? (iptvWarmSoonNextAt && (!iptvWarmNextAt || iptvWarmSoonNextAt < iptvWarmNextAt) ? 'pending change' : 'scheduled') : null,
    channelCount,
    sourceCount: sources.length,
    loadedSourceCount: sourceStatus.filter((s) => s.channelCount > 0).length,
    guideSourceCount: sourceStatus.filter((s) => s.guideChannels > 0).length,
    xtreamGuideChannels: sourceStatus.reduce((sum, s) => sum + (s.guideKind.includes('xtream') ? s.guideChannels : 0), 0),
    sourceErrors,
    sources: sourceStatus,
    lastResult: state.lastResult || null,
  };
}
async function warmIptvCaches(reason = 'scheduled', opts = {}) {
  if (iptvWarmRunning) return { ...iptvSyncSnapshot(), skipped: 'running' };
  const sources = iptvSourcesFromSettings(settings.get());
  if (!sources.length) {
    const empty = { configured: false, reason, startedAt: Date.now(), finishedAt: Date.now(), channelCount: 0, sourceErrors: [] };
    writeIptvSyncState({ ...empty, lastResult: empty });
    return empty;
  }
  const force = !!opts.force;
  const skipGuide = !!opts.skipGuide;
  const startedAt = Date.now();
  iptvWarmReason = reason;
  iptvWarmRunning = true;
  writeIptvSyncState({ running: true, reason, startedAt, sourceErrors: [] });
  try {
    const result = {
      configured: true, reason, startedAt, finishedAt: 0,
      channels: 0, channelCount: 0, sources: sources.length, loadedSources: 0,
      xmltv: false, xtreamGuide: 0, sourceErrors: [], sourceStatuses: [],
    };
    await mapLimit(sources, Math.min(3, sources.length), async (src) => {
      const sourceId = cleanIptvSourceId(src.id);
      let channels = [];
      const sourceStatus = {
        sourceId, sourceName: src.name, mode: src.iptvMode,
        channelCount: 0, guideKind: xmltvGuideUrl(src) ? 'xmltv' : (src.iptvMode === 'xtream' ? 'xtream' : 'none'),
        guideChannels: 0, xtreamGuideChannels: 0,
      };
      try {
        const key = iptvSourceKey(src);
        channels = force ? await fetchIptvChannels(src, key) : await loadIptvChannelsForSource(src);
        sourceStatus.channelCount = channels.length;
        result.channels += channels.length;
        result.channelCount += channels.length;
        if (channels.length) result.loadedSources++;
        else {
          const err = iptvSourceErrorPayload(src, new Error('no live channels found in this source'));
          result.sourceErrors.push(err);
          sourceStatus.error = err.error;
          console.error(`[iptv] source "${src.name}" loaded no live channels`);
        }
      } catch (e) {
        const err = iptvSourceErrorPayload(src, e);
        result.sourceErrors.push(err);
        sourceStatus.error = err.error;
        console.error(`[iptv warm] source "${src.name}" failed: ${err.error}`);
      }
      if (!skipGuide && channels.length && xmltvGuideUrl(src)) {
        try {
          const epg = force ? await fetchXmltv(src, epgSourceKey(src), channels) : await ensureXmltv(src, channels);
          sourceStatus.guideChannels = epg && epg.byChannel ? epg.byChannel.size : 0;
          result.xmltv = true;
        } catch (e) {
          const err = iptvSourceErrorPayload(src, new Error(`XMLTV guide failed: ${sanitizeIptvLogError(e)}`));
          result.sourceErrors.push(err);
          sourceStatus.error = sourceStatus.error || err.error;
        }
      }
      if (!skipGuide && channels.length && src.iptvMode === 'xtream') {
        try {
          const key = iptvSourceKey(src);
          let cache = xtreamEpgSourceCaches.get(sourceId);
          if (!cache || cache.key !== key) cache = hydrateXtreamEpgCache(key, sourceId);
          const guideBlocked = xtreamGuideSourceBlocked(cache);
          const targets = (iptvPlaybackBusy() || guideBlocked) ? [] : xtreamGuideWarmTargets(channels, cache);
          await mapLimit(targets, 1, async (ch) => {
            if (iptvPlaybackBusy()) return;
            if (xtreamGuideSourceBlocked(cache)) return;
            if (force && cache && cache.byStream) cache.byStream.delete(String(ch.xtreamId));
            await xtreamEpgList(ch, { limit: 24 });
          });
          const nextCache = xtreamEpgSourceCaches.get(sourceId) || cache;
          const cachedGuideCount = nextCache && nextCache.byStream ? nextCache.byStream.size : targets.length;
          sourceStatus.xtreamGuideChannels = cachedGuideCount;
          sourceStatus.guideChannels = Math.max(sourceStatus.guideChannels, cachedGuideCount);
          result.xtreamGuide += targets.length;
          result.xtreamGuidePaused = result.xtreamGuidePaused || (targets.length === 0 && iptvPlaybackBusy());
          result.xtreamGuideBackoff = result.xtreamGuideBackoff || (targets.length === 0 && guideBlocked);
          if (guideBlocked) sourceStatus.guidePaused = 'provider backoff';
        } catch (e) {
          const err = iptvSourceErrorPayload(src, new Error(`Xtream guide failed: ${sanitizeIptvLogError(e)}`));
          result.sourceErrors.push(err);
          sourceStatus.error = sourceStatus.error || err.error;
        }
      }
      result.sourceStatuses.push(sourceStatus);
    });
    if (sources.length) {
      const cachedRows = sources.map((src) => ({ src, channels: (iptvSourceCaches.get(cleanIptvSourceId(src.id)) || {}).channels || [] }));
      iptvCache = {
        key: sources.map((src) => `${src.id}:${iptvSourceKey(src)}`).join('|'),
        at: Date.now(),
        channels: aggregateIptvChannels(cachedRows),
        sourceErrors: result.sourceErrors.map(publicIptvError),
      };
    }
    result.finishedAt = Date.now();
    writeIptvSyncState({ running: false, reason, startedAt, finishedAt: result.finishedAt, sourceErrors: result.sourceErrors, lastResult: result });
    return result;
  } finally {
    iptvWarmRunning = false;
    iptvWarmReason = '';
  }
}
function scheduleIptvWarmSoon(reason = 'changed', delayMs = IPTV_WARM_DELAY_MS, opts = {}) {
  if (iptvWarmSoonTimer) clearTimeout(iptvWarmSoonTimer);
  iptvWarmSoonNextAt = Date.now() + delayMs;
  iptvWarmReason = reason;
  iptvWarmSoonTimer = setTimeout(() => {
    iptvWarmSoonTimer = null;
    iptvWarmSoonNextAt = 0;
    warmIptvCaches(reason, opts)
      .then((r) => {
        if (r && r.configured) console.log(`[iptv] warmed ${r.channels || 0} channels${r.xmltv ? ' + XMLTV' : ''}${r.xtreamGuide ? ` + ${r.xtreamGuide} Xtream guide channel(s)` : ''}${r.xtreamGuidePaused ? ' + Xtream guide paused during playback' : ''}${r.xtreamGuideBackoff ? ' + Xtream guide paused by provider backoff' : ''}`);
      })
      .catch((e) => console.error('[iptv warm]', e.message));
  }, delayMs);
  iptvWarmSoonTimer.unref();
}
function clearPendingIptvWarmSoon() {
  if (iptvWarmSoonTimer) clearTimeout(iptvWarmSoonTimer);
  iptvWarmSoonTimer = null;
  iptvWarmSoonNextAt = 0;
}
function msUntilNextIptvWarm(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const anchor = new Date(d);
  anchor.setHours(0, 0, 0, 0);
  const elapsed = Math.max(0, nowMs - anchor.getTime());
  const nextAt = anchor.getTime() + (Math.floor(elapsed / IPTV_WARM_INTERVAL_MS) + 1) * IPTV_WARM_INTERVAL_MS;
  return Math.max(1, nextAt - nowMs);
}
function scheduleNextIptvWarm() {
  if (iptvWarmTimer) clearTimeout(iptvWarmTimer);
  iptvWarmNextAt = Date.now() + msUntilNextIptvWarm();
  iptvWarmTimer = setTimeout(() => {
    iptvWarmTimer = null;
    iptvWarmNextAt = 0;
    scheduleIptvWarmSoon('scheduled-guide-sync', 1);
    scheduleNextIptvWarm();
  }, Math.max(1, iptvWarmNextAt - Date.now()));
  iptvWarmTimer.unref();
}
const tmdb = new TmdbProxy(store, () => settings.get().tmdbKey, process.env.TMDB_BASE || undefined);
const trakt = new Trakt(store, () => settings.get(), (mutator) => settings.update(mutator));
const AUTH_ART_TTL_MS = 6 * 3600 * 1000;
let authArtCache = { expiresAt: 0, items: [] };

function tmdbImageUrl(p, size = 'w1280') {
  const path = String(p || '');
  if (!/^\/[A-Za-z0-9_.-]+$/.test(path)) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function normalizeAuthArtItem(x) {
  if (!x || x.media_type === 'person') return null;
  const kind = x.media_type === 'tv' || (!x.media_type && x.name) ? 'tv' : 'movie';
  const title = String(x.title || x.name || '').trim();
  const backdrop = tmdbImageUrl(x.backdrop_path, 'w1280');
  if (!title || !backdrop) return null;
  return {
    tmdbId: Number.isFinite(Number(x.id)) ? Number(x.id) : undefined,
    title: title.slice(0, 96),
    kind,
    backdrop,
    poster: tmdbImageUrl(x.poster_path, 'w342') || backdrop,
  };
}

async function loadAuthArt() {
  const now = Date.now();
  if (authArtCache.items.length && now < authArtCache.expiresAt) return { items: authArtCache.items, cached: true };
  const feeds = await Promise.allSettled([
    tmdb.get('/trending/all/day'),
    tmdb.get('/discover/movie?sort_by=popularity.desc&vote_count.gte=300&include_adult=false&page=1'),
    tmdb.get('/discover/tv?sort_by=popularity.desc&vote_count.gte=100&include_adult=false&page=1'),
  ]);
  const seen = new Set();
  const items = [];
  for (const feed of feeds) {
    const rows = feed.status === 'fulfilled' && Array.isArray(feed.value.results) ? feed.value.results : [];
    for (const row of rows) {
      const item = normalizeAuthArtItem(row);
      if (!item) continue;
      const key = `${item.kind}:${item.tmdbId || item.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= 18) break;
    }
    if (items.length >= 18) break;
  }
  if (items.length) authArtCache = { expiresAt: now + AUTH_ART_TTL_MS, items };
  return { items: items.length ? items : authArtCache.items, cached: false };
}

// ---------- helpers ----------
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  let out = isObj ? JSON.stringify(body) : body;
  const finalHeaders = {
    'content-type': isObj ? 'application/json' : 'text/plain',
    'x-content-type-options': 'nosniff',
    ...headers,
  };
  const acceptsGzip = !!res._acceptsGzip;
  const type = String(finalHeaders['content-type'] || '').toLowerCase();
  const compressible = acceptsGzip && !finalHeaders['content-encoding']
    && (type.includes('json') || type.startsWith('text/') || type.includes('javascript'))
    && (typeof out === 'string' || Buffer.isBuffer(out));
  const byteLength = compressible ? (Buffer.isBuffer(out) ? out.length : Buffer.byteLength(String(out))) : 0;
  if (compressible && byteLength >= 512) {
    out = zlib.gzipSync(Buffer.isBuffer(out) ? out : Buffer.from(String(out)));
    finalHeaders['content-encoding'] = 'gzip';
    finalHeaders.vary = finalHeaders.vary ? `${finalHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
  }
  res.writeHead(code, finalHeaders);
  res.end(out);
}
async function readBody(req, limit = 50 * 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let settled = false;
    const done = (err, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
      if (err) reject(err);
      else resolve(body || Buffer.concat(chunks));
    };
    const fail = (message, status) => {
      if (status === 499) {
        try { if (req.socket && !req.socket.destroyed) req.socket.destroy(); } catch {}
      }
      const e = new Error(message);
      if (status) e.status = status;
      done(e);
    };
    const onData = (c) => {
      len += c.length;
      if (len > limit) {
        try { req.destroy(); } catch {}
        return fail('body too large', 413);
      }
      chunks.push(c);
    };
    const onEnd = () => done(null);
    const onError = (e) => done(e);
    const onAborted = () => fail('request aborted', 499);
    const onClose = () => {
      if (!req.complete && !settled) fail('request aborted', 499);
    };
    const timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      fail('request body timeout', 408);
    }, 10000);
    timer.unref();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
  });
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
// Optional VOD startup profiler — OFF unless TRIBOON_STARTUP_TRACE=1. Logs one line per phase of a
// fresh play so a slow 4K start can be pinned to a cause: NZB/RAR mount, the health gate, the ffmpeg
// remux probe (incl. a lossless-audio re-encode), or a moov-at-tail seek (a served byte deep in a
// huge file → the player fetched the trailing moov before any frame). Reads the breadcrumb stamped
// on vf._su by pipeline.play(). Pure logging — no effect on playback behaviour.
const STARTUP_TRACE = process.env.TRIBOON_STARTUP_TRACE === '1';
function logStartupTrace(vf, where, extra = {}) {
  const su = (vf && vf._su) || {};
  const gb = ((Number(su.size) || 0) / 1e9).toFixed(1);
  let pos = '';
  if (typeof extra.offset === 'number') {
    const size = Number(su.size) || 0;
    pos = size && extra.offset > size * 0.5
      ? ` TAIL@${(extra.offset / 1e9).toFixed(1)}GB(moov?)`
      : ` head@${extra.offset}`;
  }
  const parts = [
    `[startup-trace] ${where} "${su.name || (vf && vf.id) || '?'}" ${gb}GB ${su.container || '?'}/${su.method || '?'}`,
    `mount=${su.mountMs ?? '?'}ms gate=${su.gateMs ?? '?'}ms`,
  ];
  if (typeof extra.seekSec === 'number') parts.push(`seek@${Math.round(extra.seekSec)}s`);
  if (typeof extra.remuxProbeMs === 'number') parts.push(`remuxProbe=${extra.remuxProbeMs}ms audio=${extra.audio}`);
  if (typeof extra.ttfbMs === 'number') parts.push(`ttfb=${extra.ttfbMs}ms${pos}`);
  console.log(parts.join(' | '));
}
function bearer(req, url, allowQuery = false) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  // The ?t= query token is ONLY honored for stream-tier media routes (which scope-check it via
  // streamScopeOk). Session tokens must arrive in the Authorization header — never the URL query,
  // where they leak into logs/referer/history. So a user/admin route never authenticates from ?t=.
  return allowQuery ? url.searchParams.get('t') : null;
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
function throttleUserRoute(ctx, routeKey, opts) {
  const uid = (ctx.user && ctx.user.id) || (ctx.claims && ctx.claims.uid) || clientIp(ctx);
  return throttled(ctx, `route:${routeKey}:${uid}`, opts);
}
// A stream-scope token must be bound to the resource it's used on. Session tokens pass.
function streamScopeOk(ctx, resource) {
  if (ctx.claims.scope !== 'stream') return true;
  return ctx.claims.sub === resource;
}
function mountAccessOk(ctx, vf) {
  if (!vf) return false;
  if (ctx.user && ctx.user.role === 'admin') return true;
  if (ctx.claims && ctx.claims.scope === 'stream') return true;
  return !vf._ownerUid || (ctx.user && vf._ownerUid === ctx.user.id);
}
const USER_MOUNT_CAP = 8;
const SESSION_TTL_MS = 12 * 3600000;
function rememberMountOwner(vf, uid) {
  if (!vf || !uid) return vf;
  vf._ownerUid = vf._ownerUid || uid;
  vf._touched = Date.now();
  return vf;
}
function sessionProtectedMountIds(now = Date.now()) {
  const protectedIds = new Set();
  for (const s of pipeline.sessions.values()) {
    if (!s || !s.currentMountId) continue;
    if (now - (s.createdAt || 0) <= SESSION_TTL_MS) protectedIds.add(s.currentMountId);
  }
  return protectedIds;
}
function trimUserMounts(uid, keepId = null, limit = USER_MOUNT_CAP) {
  if (!uid) return [];
  const protectedIds = sessionProtectedMountIds();
  const owned = [...mounts.values()]
    .filter((vf) => vf && vf._ownerUid === uid && vf.id !== keepId)
    .sort((a, b) => (Number(protectedIds.has(a.id)) - Number(protectedIds.has(b.id)))
      || ((a._touched || a.mountedAt || 0) - (b._touched || b.mountedAt || 0)));
  const evicted = [];
  while (owned.length >= limit) {
    const vf = owned.shift();
    if (!vf) break;
    if (protectedIds.has(vf.id)) continue;
    mounts.delete(vf.id);
    evicted.push(vf.id);
  }
  for (const [url, id] of pipeline.mountByUrl) if (evicted.includes(id)) pipeline.mountByUrl.delete(url);
  return evicted;
}
// Client capability claims (canPlayType results sent with the play request). Hardware that
// decodes the source natively gets TRUE direct play — no server remux/transcode at all.
function parseCaps(raw) {
  const caps = {};
  for (const k of ['mkv', 'mp4', 'h264', 'hevc', 'dovi', 'av1', 'vp9', 'mpeg2', 'aac', 'ac3', 'eac3', 'eac3Joc', 'dts', 'dtsHd', 'truehd', 'passthrough', 'native', 'lowPower']) {
    caps[k] = !!(raw && raw[k]);
  }
  if (raw && raw.source) caps.source = String(raw.source).slice(0, 64);
  if (raw && raw.model) caps.model = String(raw.model).slice(0, 64);
  if (raw && raw.manufacturer) caps.manufacturer = String(raw.manufacturer).slice(0, 64);
  if (raw && raw.brand) caps.brand = String(raw.brand).slice(0, 64);
  if (raw && raw.device) caps.device = String(raw.device).slice(0, 64);
  if (raw && raw.deviceClass) caps.deviceClass = String(raw.deviceClass).slice(0, 64);
  if (raw && raw.audioOutput) caps.audioOutput = String(raw.audioOutput).slice(0, 64);
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
    policy.audioPassthrough = !!caps.passthrough;
    policy.audioTrueHd = !!caps.truehd;
    policy.audioEac3 = !!caps.eac3;
    policy.audioEac3Joc = !!caps.eac3Joc;
    policy.audioDts = !!caps.dts;
    policy.audioDtsHd = !!caps.dtsHd;
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
function playbackRuntimeStats(now = Date.now()) {
  const active = [...mounts.values()].filter((m) => m && m.streamable && now - (m._touched || 0) < 120000);
  const out = {
    activeMounts: active.length,
    files: 0,
    reads: 0,
    segmentsServed: 0,
    cacheHits: 0,
    segmentWaits: 0,
    segmentWaitMs: 0,
    maxSegmentWaitMs: 0,
    readBytes: 0,
    adaptiveBoosts: 0,
    boostedFiles: 0,
    cacheBytes: 0,
    inflightSegments: 0,
    readAheadBaseMax: 0,
    readAheadCurrentMax: 0,
    readAheadCeilingMax: 0,
  };
  for (const vf of active) {
    for (const v of (vf.vols || [vf])) {
      if (!v || typeof v.playbackSnapshot !== 'function') continue;
      const s = v.playbackSnapshot();
      out.files++;
      out.reads += s.reads || 0;
      out.segmentsServed += s.segmentsServed || 0;
      out.cacheHits += s.cacheHits || 0;
      out.segmentWaits += s.segmentWaits || 0;
      out.segmentWaitMs += s.segmentWaitMs || 0;
      out.maxSegmentWaitMs = Math.max(out.maxSegmentWaitMs, s.maxSegmentWaitMs || 0);
      out.readBytes += s.readBytes || 0;
      out.adaptiveBoosts += s.adaptiveBoosts || 0;
      if ((s.readAhead || 0) > (s.baseReadAhead || 0)) out.boostedFiles++;
      out.cacheBytes += s.cacheBytes || 0;
      out.inflightSegments += s.inflightSegments || 0;
      out.readAheadBaseMax = Math.max(out.readAheadBaseMax, s.baseReadAhead || 0);
      out.readAheadCurrentMax = Math.max(out.readAheadCurrentMax, s.readAhead || 0);
      out.readAheadCeilingMax = Math.max(out.readAheadCeilingMax, s.maxReadAhead || 0);
    }
  }
  out.avgSegmentWaitMs = out.segmentWaits ? Math.round(out.segmentWaitMs / out.segmentWaits) : 0;
  return out;
}
function subtitleReleaseName(vf) {
  return String((vf && (vf._releaseName || vf._sourceName || vf.name)) || '').trim();
}
function publicReleaseSubs(vf) {
  return (vf && Array.isArray(vf.releaseSubs) ? vf.releaseSubs : []).map((s) => ({
    id: s.id,
    name: s.name,
    ext: s.ext,
    lang: s.lang || '',
    forced: !!s.forced,
    sdh: !!s.sdh,
    size: s.size || 0,
    score: s.score || 0,
    source: 'release',
  }));
}
function assTimeToVtt(ts) {
  const m = /^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/.exec(String(ts || '').trim());
  if (!m) return null;
  return `${String(+m[1]).padStart(2, '0')}:${m[2]}:${m[3]}.${String(m[4]).padEnd(3, '0')}`;
}
function assTextToPlain(text) {
  return String(text || '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}
function assToVtt(body) {
  const lines = String(body || '').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  let format = [];
  const cues = [];
  for (const line of lines) {
    if (/^Format:/i.test(line)) {
      format = line.slice(line.indexOf(':') + 1).split(',').map((x) => x.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    const raw = line.slice(line.indexOf(':') + 1);
    const parts = raw.split(',');
    const textIdx = format.indexOf('text');
    const startIdx = format.indexOf('start');
    const endIdx = format.indexOf('end');
    if (startIdx < 0 || endIdx < 0) continue;
    const minParts = Math.max(startIdx, endIdx, textIdx < 0 ? 9 : textIdx) + 1;
    if (parts.length < minParts) continue;
    const start = assTimeToVtt(parts[startIdx]);
    const end = assTimeToVtt(parts[endIdx]);
    const text = assTextToPlain(parts.slice(textIdx < 0 ? 9 : textIdx).join(','));
    if (start && end && text) cues.push(`${start} --> ${end}\n${text}`);
  }
  if (!cues.length) throw new Error('release subtitle has no readable text cues');
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
function releaseSubtitleToVtt(buf, ext, langHint = '') {
  const body = Buffer.isBuffer(buf) ? decodeSubtitleBuffer(buf, langHint) : String(buf || '');
  const kind = String(ext || '').toLowerCase();
  if (kind === 'vtt' || body.replace(/^\uFEFF/, '').startsWith('WEBVTT')) return body.replace(/^\uFEFF/, '');
  if (kind === 'ass' || kind === 'ssa' || /^\s*\[Script Info\]/i.test(body)) return assToVtt(body);
  return srtToVtt(body);
}
function episodeSubtitleQuery(query, season, ep) {
  const base = String(query || '').trim();
  const s = Number(season);
  const e = Number(ep);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s <= 0 || e <= 0) return base;
  if (/\bS\d{1,2}\s*E\d{1,3}\b/i.test(base)) return base;
  return `${base} S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`.trim();
}
function libraryRecord(libId, max) {
  if (libraryDb.available) {
    const rec = libraryDb.readLibrary(libId, max);
    if (rec) return rec;
  }
  return store.read('libitems', {})[libId] || null;
}
function libraryItemByIndex(libId, idx) {
  if (libraryDb.available) {
    const item = libraryDb.item(libId, idx);
    if (item) return item;
  }
  const rec = store.read('libitems', {})[libId];
  return rec && rec.items ? rec.items[parseInt(idx, 10)] : null;
}
function saveLibraryScan(libId, scannedAt, items) {
  if (libraryDb.available && libraryDb.replaceLibrary(libId, scannedAt, items)) {
    store.update('libitems', {}, (s) => { delete s[libId]; return s; });
    return true;
  }
  store.update('libitems', {}, (s) => { s[libId] = { scannedAt, items }; return s; });
  return false;
}
function allowedLocalLibraryIds(ctx) {
  return store.read('libraries', { list: [] }).list
    .filter((lib) => lib && lib.id && lib.path)
    .filter((lib) => !(lib.users && lib.users.length && ctx.user.role !== 'admin' && !lib.users.includes(ctx.user.id)))
    .map((lib) => String(lib.id));
}
function activityUserName(uid) {
  const user = store.read('users', { list: [] }).list.find((u) => u.id === uid);
  return user ? user.name : 'User';
}
function scrubActivityText(v, max = 160) {
  return String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}
function activityLooksLive(row = {}) {
  const text = `${row.type || ''} ${row.streamKind || ''} ${row.streamLabel || ''} ${row.mode || ''}`.toLowerCase();
  return text.includes('live') || String(row.key || '').startsWith('live:');
}
function activityHistoryEligible(row = {}) {
  if (activityLooksLive(row)) return false;
  const type = String(row.type || '').toLowerCase();
  if (['movie', 'tv', 'episode', 'local', 'local-tv', 'local-movie'].includes(type)) return true;
  const key = String(row.key || '').toLowerCase();
  return key.startsWith('tmdb:movie:') || key.startsWith('tmdb:tv:');
}
function activityClientVersion(b = {}, req = {}) {
  const direct = scrubActivityText(b.clientVersion || b.appVersion || b.version || '', 80);
  if (direct) return direct;
  const ua = scrubActivityText(req.headers && req.headers['user-agent'], 140);
  const app = /\b(TriboonTV|TriboonAndroid)\/([^\s]+)/i.exec(ua);
  if (app) return `${app[1] === 'TriboonTV' ? 'Android TV' : 'Android app'} ${app[2]}`;
  return `Web ${APP_VERSION}`;
}
// Friendly hardware label ("NVIDIA SHIELD", "Chrome", "iPhone"). The client computes the precise
// name (it can read Android Build.MODEL via the native bridge) and sends it as `deviceName`; this is
// the server-side fallback for older/non-JS clients, derived from the user-agent.
function activityDeviceName(b = {}, req = {}) {
  const direct = scrubActivityText(b.deviceName || '', 60);
  if (direct) return direct;
  const ua = String((req.headers && req.headers['user-agent']) || '');
  const app = /\b(TriboonTV|TriboonAndroid)\//i.exec(ua);
  if (app) return app[1] === 'TriboonTV' ? 'Android TV' : 'Android phone';
  if (/\bEdg\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera/.test(ua)) return 'Opera';
  if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/\bFirefox\//.test(ua)) return 'Firefox';
  if (/\bEdgiOS\//.test(ua)) return 'Edge';
  if (/iPhone|iPad|iPod/.test(ua) && /Safari/.test(ua)) return ua.includes('iPad') ? 'iPad' : 'iPhone';
  if (/\bChrome\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && /Apple/.test(ua)) return 'Safari';
  return 'Web';
}
function normalizeActivityRow(ctx, b = {}, id, existing = {}) {
  const duration = Math.max(0, Number(b.duration || 0) || 0);
  const position = Math.max(0, Number(b.position || 0) || 0);
  const percent = duration ? Math.max(0, Math.min(100, Math.round((position / duration) * 100))) : 0;
  const live = activityLooksLive({ ...b, key: b.key || existing.key });
  const title = live ? 'Live TV' : scrubActivityText(b.title || (b.meta && b.meta.title) || 'Playing', 180);
  return {
    id,
    sessionId: id,
    userId: ctx.user.id,
    userName: activityUserName(ctx.user.id),
    profile: scrubActivityText(b.profile || existing.profile || '', 40),
    title,
    subline: live ? 'Live stream' : scrubActivityText(b.subline || '', 120),
    key: live ? 'live' : scrubActivityText(b.key || '', 140),
    type: live ? 'live' : scrubActivityText(b.type || '', 30),
    player: scrubActivityText(b.player || '', 30),
    mode: scrubActivityText(b.mode || '', 30),
    streamKind: live ? 'live' : scrubActivityText(b.streamKind || '', 30),
    streamLabel: live ? 'Live' : scrubActivityText(b.streamLabel || '', 60),
    clientVersion: activityClientVersion(b, ctx.req),
    device: scrubActivityText(b.device || ctx.req.headers['user-agent'] || '', 90),
    deviceName: activityDeviceName(b, ctx.req),
    source: live ? '' : scrubActivityText(b.source || '', 220),
    fileName: live ? '' : scrubActivityText(b.fileName || '', 220),
    size: Math.max(0, Number(b.size || 0) || 0),
    position,
    duration,
    percent,
    startedAt: existing.startedAt || Date.now(),
    updatedAt: Date.now(),
  };
}
function pruneActivityHistoryRows(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.updatedAt && now - row.updatedAt <= ACTIVITY_HISTORY_RETENTION_MS && activityHistoryEligible(row))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, ACTIVITY_HISTORY_MAX_ROWS);
}
function recordActivityHistory(row) {
  if (!row || !row.userId) return;
  if (!activityHistoryEligible(row)) return;
  const now = Date.now();
  const histId = 'h' + idHash(`${row.userId}|${row.profile || ''}|${row.sessionId || ''}|${row.key || ''}|${row.startedAt || ''}`);
  store.update('activityHistory', { rows: [] }, (doc) => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = { rows: [] };
    const rows = pruneActivityHistoryRows(doc.rows, now);
    const saved = {
      id: histId,
      userId: row.userId,
      userName: row.userName,
      profile: row.profile,
      title: row.title,
      subline: row.subline,
      key: row.key,
      type: row.type,
      player: row.player,
      mode: row.mode,
      streamKind: row.streamKind,
      streamLabel: row.streamLabel,
      clientVersion: row.clientVersion,
      device: row.device,
      deviceName: row.deviceName,
      position: row.position,
      duration: row.duration,
      percent: row.percent,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
    };
    const ix = rows.findIndex((x) => x.id === histId);
    if (ix >= 0) rows[ix] = { ...rows[ix], ...saved, startedAt: rows[ix].startedAt || saved.startedAt };
    else rows.unshift(saved);
    doc.rows = pruneActivityHistoryRows(rows, now);
    return doc;
  });
}
function activityHistoryRows() {
  const doc = store.read('activityHistory', { rows: [] });
  const rows = pruneActivityHistoryRows(doc && doc.rows);
  if (!doc || !Array.isArray(doc.rows) || rows.length !== doc.rows.length) store.write('activityHistory', { rows });
  return rows;
}
function activeActivityRows() {
  const now = Date.now();
  for (const [id, row] of activitySessions) {
    if (!row || now - (row.updatedAt || 0) > ACTIVITY_TTL_MS) activitySessions.delete(id);
  }
  return [...activitySessions.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
// Online presence: every connected device (browsing OR watching), not just active playback. Pruned
// by TTL on read, newest first. This is what "currently connected users" means — a superset of the
// "now watching" rows above.
function activeOnlineRows() {
  const now = Date.now();
  for (const [key, row] of presenceSessions) {
    if (!row || now - (row.lastSeen || 0) > PRESENCE_TTL_MS) presenceSessions.delete(key);
  }
  return [...presenceSessions.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}
// Live usenet connection usage per provider, for the admin Activity screen. Reads the already-built
// shared pool — never forces one open (so it stays null until something has actually streamed) and
// never exposes credentials. Labels duplicate hosts so two accounts on one provider stay distinct.
function activityConnectionStats() {
  if (!pool || typeof pool.stats !== 'function') return null;
  let stats;
  try { stats = pool.stats(); } catch { return null; }
  if (!stats || !Array.isArray(stats.providers) || !stats.providers.length) return null;
  const seen = new Map();
  const providers = stats.providers.map((p, i) => {
    const host = scrubActivityText(p.host || '', 80) || `Provider ${i + 1}`;
    const n = (seen.get(host) || 0) + 1; seen.set(host, n);
    return {
      label: n > 1 ? `${host} (${n})` : host,
      inUse: p.inUse, open: p.open, connecting: p.connecting, size: p.size, queued: p.queued, down: !!p.down,
    };
  });
  return { providers, inUse: stats.inUse, open: stats.open, size: stats.size, queued: stats.queued };
}
// Bound a per-mount result cache to its newest N entries (Maps keep insertion order, so the first
// key is the oldest). Mirrors the _subCache cap so a marathon session that toggles many subtitle
// languages/variants on one long-lived mount can't grow these maps without limit.
function capMap(map, max) {
  while (map && map.size > max) { const k = map.keys().next().value; if (k === undefined) break; map.delete(k); }
}
function localLibraryItemFor(ctx, libId, idx) {
  const lib = store.read('libraries', { list: [] }).list.find((l) => l.id === libId);
  if (!lib || !lib.path) return { status: 404, error: 'library not found' };
  if (lib.users && lib.users.length && ctx.user.role !== 'admin' && !lib.users.includes(ctx.user.id)) {
    return { status: 404, error: 'library not found' };
  }
  const item = libraryItemByIndex(libId, idx);
  if (!item) return { status: 404, error: 'item not found' };
  return { lib, item };
}
function localItemFor(ctx, libId, idx) {
  const found = localLibraryItemFor(ctx, libId, idx);
  if (found.error) return found;
  const item = found.item;
  if (!item || !item.file) return { status: 404, error: 'item not found' };
  return found;
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
function tokenizedLocalUrl(raw) {
  try {
    const u = new URL(String(raw || ''), 'http://triboon.local');
    return u.pathname.startsWith('/api/local/') && u.searchParams.has('t');
  } catch { return false; }
}
function sanitizeStoredMediaMeta(meta = {}) {
  const out = { ...(meta && typeof meta === 'object' ? meta : {}) };
  for (const key of ['poster', 'backdrop']) {
    if (tokenizedLocalUrl(out[key])) delete out[key];
  }
  return out;
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
  rememberMountOwner(vf, ctx.user.id);
  trimUserMounts(ctx.user.id, vf.id);
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
      if (!fullKey.startsWith(prefix) || !value || value.hidden || !accept(value)) continue;
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
          return !(rec && (rec.hidden || rec.watched || (rec.position || 0) > 30 || (rec.traktPct || 0) > 2));
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
          qualityRank: [3, 4].includes(Number(top.w.meta && top.w.meta.qualityRank)) ? Number(top.w.meta.qualityRank) : undefined,
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
  { id: 'weekly', title: 'Weekly chart', note: 'Top songs this week', query: 'top songs this week', limit: 12 },
];
const MUSIC_HOME_WEEKLY_FEEDS = [
  { id: 'top-playlists-week', title: 'Top playlists this week', sub: 'Fresh shared mixes and creator queues', query: 'top playlists this week music', coverFeed: 'top playlists this week music', icon: 'chart', grad: 'mGrad2' },
  { id: 'new-music-mix', title: 'New Music Mix', sub: 'Fresh songs to sample first', query: 'new music mix', coverFeed: 'new music mix', icon: 'spark', grad: 'mGrad1' },
  { id: 'viral-hits', title: 'Viral hits', sub: 'Songs moving fast right now', query: 'viral hits music this week', coverFeed: 'viral hits music this week', icon: 'spark', grad: 'mGrad3' },
  { id: 'fresh-releases', title: 'Fresh releases', sub: 'New songs and album cuts', query: 'new songs this week', coverFeed: 'new songs this week', icon: 'music', grad: 'mGrad4' },
  { id: 'chill-radio', title: 'Chill radio', sub: 'Low-friction background queue', query: 'chill music mix', coverFeed: 'chill music mix', icon: 'smile', grad: 'mGrad2' },
  { id: 'throwback-hits', title: 'Throwback hits', sub: 'Familiar picks that start quickly', query: 'throwback hits music', coverFeed: 'throwback hits music', icon: 'chart', grad: 'mGrad3' },
];
function musicHomeFeedShelves() {
  return [
    { id: 'personal', title: 'Your playlists', kind: 'personal', note: 'Liked Music and linked YouTube Music playlists always render first.' },
    { id: 'weekly-playlists', title: 'Top playlists this week', kind: 'feeds', note: 'Weekly picks only, kept short so Music opens quickly.', refresh: 'weekly', items: MUSIC_HOME_WEEKLY_FEEDS },
  ];
}
const musicChartCache = new Map(); // id -> { rows, expiresAt, inflight }
const musicSearchCache = new Map(); // key -> { rows, expiresAt, inflight }
const musicPlaylistListCache = new Map(); // user/source -> { playlists, expiresAt, inflight }
const MUSIC_PLAYLIST_LIST_LIMIT = Math.max(12, Math.min(60, parseInt(process.env.TRIBOON_MUSIC_PLAYLIST_LIST_LIMIT || '36', 10) || 36));
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
function musicSearchCacheKey(q, limit, scope) {
  return `${scope || 'public'}:${limit}:${String(q || '').trim().toLowerCase()}`;
}
async function loadMusicSearch(q, { limit = 20, cookiesPath, scope = 'public', priority = 0 } = {}) {
  const query = String(q || '').trim();
  const n = Math.max(1, Math.min(40, limit));
  const key = musicSearchCacheKey(query, n, scope);
  const now = Date.now();
  const hit = musicSearchCache.get(key);
  if (hit && hit.rows && now < hit.expiresAt) return hit.rows;
  if (hit && hit.inflight) return hit.inflight;
  const inflight = ytmusic.search(query, { limit: n, cookiesPath, priority }).then((rows) => {
    const clean = (rows || []).filter((t) => t && /^[\w-]{11}$/.test(String(t.id || ''))).slice(0, n);
    musicSearchCache.set(key, { rows: clean, expiresAt: now + 12 * 3600 * 1000 });
    while (musicSearchCache.size > 80) musicSearchCache.delete(musicSearchCache.keys().next().value);
    return clean;
  }).catch((e) => {
    if (hit && hit.rows) return hit.rows;
    throw e;
  });
  musicSearchCache.set(key, { ...(hit || {}), inflight });
  return inflight;
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
function tokenizedMusicTrack(uid, r) {
  return { ...r, streamUrl: `/api/music/stream/${r.id}?t=${auth.streamToken(uid, `music:${r.id}`)}` };
}
const ytOauthPending = new Map(); // uid -> pending device-code auth
function ytOauthClient(s = settings.get()) {
  const clientId = String(s.ytOAuthClientId || '').trim();
  const clientSecret = String(s.ytOAuthClientSecret || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
function ytOauthToken(uid, s = settings.get()) {
  const all = s.ytOAuthTokens || {};
  const token = all[uid];
  return token && token.access_token && token.refresh_token ? token : null;
}
async function ytmusicOauthFor(uid) {
  const s = settings.get();
  const client = ytOauthClient(s);
  const token = ytOauthToken(uid, s);
  if (!client || !token) return null;
  const expiresAt = parseInt(token.expires_at, 10) || 0;
  if (expiresAt > Math.floor(Date.now() / 1000) + 120) return { token, client };
  const fresh = await ytmusic.refreshOAuthToken(token, client);
  settings.update((cur) => {
    const issues = { ...(cur.ytOAuthIssues || {}) }; delete issues[uid];
    return { ...cur, ytOAuthTokens: { ...(cur.ytOAuthTokens || {}), [uid]: fresh }, ytOAuthIssues: issues };
  });
  return { token: fresh, client };
}
function clearYtmIssue(uid, kind) {
  settings.update((s) => {
    const next = { ...s };
    if (kind === 'oauth' || kind === 'all') {
      const issues = { ...(next.ytOAuthIssues || {}) }; delete issues[uid]; next.ytOAuthIssues = issues;
    }
    if (kind === 'cookie' || kind === 'all') {
      const issues = { ...(next.ytCookieIssues || {}) }; delete issues[uid]; next.ytCookieIssues = issues;
    }
    return next;
  });
}
function musicPlaylistListCacheKey(uid, source) {
  return `${uid || 'anon'}:${source || 'none'}`;
}
function clearMusicPlaylistCaches(uid) {
  for (const key of [...musicPlaylistListCache.keys()]) {
    if (key.startsWith(`${uid}:`)) musicPlaylistListCache.delete(key);
  }
}
async function loadUserMusicPlaylists(uid, source, loader) {
  const key = musicPlaylistListCacheKey(uid, source);
  const now = Date.now();
  const hit = musicPlaylistListCache.get(key);
  if (hit && hit.playlists && now < hit.expiresAt) return hit.playlists;
  if (hit && hit.inflight) return hit.inflight;
  const inflight = Promise.resolve()
    .then(loader)
    .then((playlists) => {
      const clean = (playlists || []).filter((p) => p && p.id && p.title).slice(0, MUSIC_PLAYLIST_LIST_LIMIT);
      musicPlaylistListCache.set(key, { playlists: clean, expiresAt: Date.now() + 15 * 60 * 1000 });
      while (musicPlaylistListCache.size > 100) musicPlaylistListCache.delete(musicPlaylistListCache.keys().next().value);
      return clean;
    })
    .catch((e) => {
      if (hit && hit.playlists) return hit.playlists;
      throw e;
    });
  musicPlaylistListCache.set(key, { ...(hit || {}), inflight });
  return inflight;
}
async function loadMusicChartResponses(uid, { wait = true } = {}) {
  return (await Promise.all(MUSIC_CHARTS.map(async (def) => {
    try {
      let results;
      if (wait) {
        results = await loadMusicChart(def);
      } else {
        const hit = musicChartCache.get(def.id);
        if (hit && hit.rows && Date.now() < hit.expiresAt) results = hit.rows;
        else { loadMusicChart(def).catch(() => {}); return null; }
      }
      return {
        id: def.id,
        title: def.title,
        note: def.note,
        kind: 'tracks',
        results: results.map((r) => tokenizedMusicTrack(uid, r)),
      };
    } catch (e) {
      return { id: def.id, title: def.title, note: def.note, kind: 'tracks', results: [], error: String(e.message).slice(0, 120) };
    }
  }))).filter((c) => c && c.results.length);
}

// In-app update check: the SERVER fetches GitHub releases/latest once and caches it, so every device
// asks its own server instead of each hammering GitHub's 60/hr unauthenticated API — which silently
// rate-limited the update prompt (the device's check just returned nothing, so no popup appeared).
const GH_LATEST_URL = 'https://api.github.com/repos/d1same/triboon/releases/latest';
let _appLatestCache = { at: 0, data: null };
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(GH_LATEST_URL, { headers: { 'user-agent': 'triboon-server', accept: 'application/vnd.github+json' }, timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`github ${res.statusCode}`)); }
      let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('github timeout')));
  });
}
async function appLatestVersion() {
  const now = Date.now();
  if (_appLatestCache.data && now - _appLatestCache.at < 30 * 60000) return _appLatestCache.data; // 30-min cache
  const j = await fetchLatestRelease();
  const apk = (j.assets || []).find((a) => a && a.name === 'triboon.apk');
  const data = {
    latest: j.tag_name || '',
    apkUrl: apk ? apk.browser_download_url : 'https://github.com/d1same/triboon/releases/latest/download/triboon.apk',
    publishedAt: j.published_at || null,
  };
  _appLatestCache = { at: now, data };
  return data;
}

// ---------- handlers ----------
const H = {
  server: async (ctx) => send(ctx.res, 200, {
    app: 'triboon', version: APP_VERSION, phase: 4, needsSetup: !auth.hasUsers(),
    tmdb: !!settings.get().tmdbKey, ffmpeg: !!detectFfmpeg(),
    // Wyzie only needs the server-side API key; no account login is required.
    opensubs: !!effectiveOpenSubsKey(),
    // alass sidecar present → the player auto-syncs non-matched subtitles in the background.
    subSync: !!detectSubSync(),
    builtInSubtitlesEnabled: settings.get().builtInSubtitlesEnabled === true,
    iptv: iptvConfigured(settings.get()),
    music: !!ytmusic.detectYtdlp(), // Music tab shows only when yt-dlp is present
    musicCatalog: !!ytmusic.detectYtMusicApi(),
  }),

  authArt: async (ctx) => {
    if (!settings.get().tmdbKey) {
      return send(ctx.res, 200, { configured: false, items: [] }, { 'cache-control': 'public, max-age=120' });
    }
    try {
      const data = await loadAuthArt();
      send(ctx.res, 200, { configured: true, items: data.items, cached: data.cached },
        { 'cache-control': 'public, max-age=900' });
    } catch {
      send(ctx.res, 200, { configured: true, items: authArtCache.items || [] },
        { 'cache-control': 'public, max-age=120' });
    }
  },

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
    const uname = String(name || '').toLowerCase();
    const key = `login:${uname}:${clientIp(ctx)}`;
    const acctKey = `login-acct:${uname}`;
    // Per-(user,IP) throttle PLUS a generous per-account cap, so rotating-IP guessing against one
    // account is still bounded across IPs. Both clear on a successful login.
    if (throttled(ctx, key, { max: 10, windowMs: 15 * 60000, lockMs: 15 * 60000 })) return;
    if (uname && throttled(ctx, acctKey, { max: 40, windowMs: 15 * 60000, lockMs: 15 * 60000 })) return;
    try { const r = auth.login(name, password); limiter.clear(key); limiter.clear(acctKey); send(ctx.res, 200, r); }
    catch { send(ctx.res, 401, { error: 'invalid credentials' }); }
  },

  login2fa: async (ctx) => {
    const { challenge, code } = await readJson(ctx.req);
    const key = `login2fa:${clientIp(ctx)}:${String(challenge || '').slice(-24)}`;
    if (throttled(ctx, key, { max: 10, windowMs: 15 * 60000, lockMs: 15 * 60000 })) return;
    try {
      const r = auth.completeTotpLogin(challenge, code);
      limiter.clear(key);
      send(ctx.res, 200, r);
    } catch (e) { send(ctx.res, 401, { error: e.message }); }
  },

  me: async (ctx) => {
    const s = settings.get();
    const sources = iptvSourcesFromSettings(s);
    const iptvAllowed = ctx.user.role === 'admin' || sources.some((src) => userCanAccessIptvSource(ctx.user, src));
    send(ctx.res, 200, { ...auth.publicUser(ctx.user), iptvAllowed });
  },

  meSecurity: async (ctx) => {
    send(ctx.res, 200, { twoFactor: auth.twoFactorStatus(ctx.user.id) });
  },

  // Latest published app version (cached server-side) — the client compares against its installed
  // build to decide whether to show the update prompt, without each device hitting GitHub directly.
  appLatest: async (ctx) => {
    try { send(ctx.res, 200, await appLatestVersion()); }
    catch { send(ctx.res, 200, { latest: '', error: 'version check unavailable' }); }
  },

  password: async (ctx) => {
    const { oldPassword, newPassword } = await readJson(ctx.req);
    try { auth.changePassword(ctx.user.id, oldPassword, newPassword); send(ctx.res, 200, { ok: true }); }
    catch (e) { send(ctx.res, 400, { error: e.message }); }
  },

  totpSetup: async (ctx) => {
    const b = await readJson(ctx.req);
    const key = `totp:${ctx.user.id}`;
    if (throttled(ctx, key, { max: 6, windowMs: 60000, lockMs: 60000 })) return;
    try { const r = auth.startTotpSetup(ctx.user.id, b.password); limiter.clear(key); send(ctx.res, 200, r); }
    catch (e) { send(ctx.res, e.message === 'admin only' ? 403 : 400, { error: e.message }); }
  },

  totpEnable: async (ctx) => {
    const b = await readJson(ctx.req);
    const key = `totp:${ctx.user.id}`;
    if (throttled(ctx, key, { max: 6, windowMs: 60000, lockMs: 60000 })) return;
    try { const r = auth.enableTotp(ctx.user.id, b.password, b.code); limiter.clear(key); send(ctx.res, 200, r); }
    catch (e) { send(ctx.res, e.message === 'admin only' ? 403 : 400, { error: e.message }); }
  },

  totpDisable: async (ctx) => {
    const b = await readJson(ctx.req);
    const key = `totp:${ctx.user.id}`;
    if (throttled(ctx, key, { max: 6, windowMs: 60000, lockMs: 60000 })) return;
    try { const r = auth.disableTotp(ctx.user.id, b.password, b.code); limiter.clear(key); send(ctx.res, 200, r); }
    catch (e) { send(ctx.res, e.message === 'admin only' ? 403 : 400, { error: e.message }); }
  },

  totpRecovery: async (ctx) => {
    const b = await readJson(ctx.req);
    const key = `totp:${ctx.user.id}`;
    if (throttled(ctx, key, { max: 6, windowMs: 60000, lockMs: 60000 })) return;
    try { const r = auth.regenerateTotpRecovery(ctx.user.id, b.password, b.code); limiter.clear(key); send(ctx.res, 200, r); }
    catch (e) { send(ctx.res, e.message === 'admin only' ? 403 : 400, { error: e.message }); }
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
    const isAdmin = !!(ctx.user && ctx.user.role === 'admin');
    const body = {
      app: 'triboon', phase: 4, mounts: mounts.size,
      version: require('../package.json').version,
      streaming: streamingRuntimeProfile(),
      pipeline: pipeline.metricsSnapshot(),
      playback: playbackRuntimeStats(),
      indexers: (settings.get().indexers || []).length,
      tmdb: !!settings.get().tmdbKey,
    };
    // Provider host/port + host OS/CPU/Node fingerprint are admin-only operational detail (the
    // Engine panel is admin). Regular users get counts + uptime, never the provider address or the
    // server's OS/Node fingerprint.
    if (isAdmin) {
      body.nntp = provs.length ? {
        host: provs[0].host, port: provs[0].port, tls: !!provs[0].tls,
        connections: provs[0].connections || 16, providers: provs.length,
        totalConnections: provs.reduce((n, p) => n + (p.connections || 16), 0),
      } : null;
      body.ffmpeg = detectFfmpeg() ? detectFfmpeg().version : null;
      body.ytdlp = ytmusic.detectYtdlp() ? ytmusic.detectYtdlp().version : null;
      body.device = {
        os: `${os.type()} ${os.release()}`, arch: process.arch,
        cpus: os.cpus().length, memGb: +(os.totalmem() / 1e9).toFixed(1),
        node: process.version, uptimeSec: Math.floor(process.uptime()),
      };
    } else {
      body.nntp = provs.length ? { providers: provs.length } : null;
      body.device = { uptimeSec: Math.floor(process.uptime()) };
    }
    send(ctx.res, 200, body);
  },

  mount: async (ctx) => {
    if (throttleUserRoute(ctx, 'mount', { max: 8, windowMs: 60000, lockMs: 60000 })) return;
    const xml = (await readBody(ctx.req)).toString('utf8');
    const t0 = Date.now();
    const vf = await mountNzb(getPool(), xml);
    rememberMountOwner(vf, ctx.user.id);
    mounts.set(vf.id, vf);
    trimUserMounts(ctx.user.id, vf.id);
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
    if (!mountAccessOk(ctx, vf)) return send(ctx.res, 404, { error: 'mount not found' });
    send(ctx.res, 200, await vf.triage());
  },

  search: async (ctx) => {
    const q = ctx.url.searchParams.get('q');
    if (!q) return send(ctx.res, 400, { error: 'q required' });
    if (throttleUserRoute(ctx, 'search', { max: 40, windowMs: 60000, lockMs: 60000 })) return;
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
    if (throttleUserRoute(ctx, 'play', { max: 20, windowMs: 60000, lockMs: 60000 })) return;
    const t0 = Date.now();
    // HD/UHD toggle: a per-play resolution preference may tighten the cap DOWNWARD, never
    // above the admin-set cap (Plex semantics — user picks within their ceiling).
    const policy = playbackPolicyFor(ctx.user, body);
    // Explicit resolution pick (4K toggle): boost matching releases — but only within the cap,
    // so a capped user can't smuggle UHD past their ceiling via the preference.
    try {
      const { session, vf, candidate, attempts, relaxedResolution } = await pipeline.play(
        { q: body.q, imdbid: body.imdbid, tvdbid: body.tvdbid, season: body.season, ep: body.ep, pick: body.pick, pickKey: body.pickKey },
        policy
      );
      session.uid = ctx.user.id;
      vf._q = body.q; // remembered for online subtitle search (release names match poorly)
      vf._subQuery = episodeSubtitleQuery(body.q, body.season, body.ep);
      vf._caps = parseCaps(body.caps); session.caps = vf._caps; // hardware claims ride the session
      rememberMountOwner(vf, ctx.user.id);
      trimUserMounts(ctx.user.id, vf.id);
      // Owner-facing read-ahead goal for THIS stream's resolution, so the native player can size
      // its OWN buffer from the Streaming-performance setting (clamped to device RAM) instead of a
      // hard-coded constant. The client already has size+duration to turn seconds into bytes.
      const __prof = streamingRuntimeProfile();
      const bufferGoalSec = (vf.size > 4e9 ? __prof.buffer4kSec : __prof.buffer1080Sec) || 0;
      send(ctx.res, 200, mountPayload(vf, ctx.user.id, {
        sessionId: session.id, mountMs: Date.now() - t0,
        candidate: { name: candidate.name, pickKey: candidate.pickKey, score: candidate.score, indexer: candidate.indexer, reasons: candidate.reasons, attributes: candidate.attributes },
        attempts,
        relaxedResolution: relaxedResolution || undefined,
        bufferGoalSec,
      }));
    } catch (e) {
      send(ctx.res, 502, { error: e.message, summary: e.summary, attempts: e.attempts || [] });
    }
  },

  prepare: async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.q) return send(ctx.res, 400, { error: 'q required' });
    if (throttleUserRoute(ctx, 'prepare', { max: 20, windowMs: 60000, lockMs: 60000 })) return;
    const t0 = Date.now();
    const policy = playbackPolicyFor(ctx.user, body);
    try {
      const { vf, candidate, attempts, prepared } = await pipeline.prepare(
        { q: body.q, imdbid: body.imdbid, tvdbid: body.tvdbid, season: body.season, ep: body.ep, pick: body.pick, pickKey: body.pickKey },
        policy
      );
      if (vf) {
        vf._q = body.q;
        vf._subQuery = episodeSubtitleQuery(body.q, body.season, body.ep);
        vf._caps = parseCaps(body.caps);
        rememberMountOwner(vf, ctx.user.id);
        trimUserMounts(ctx.user.id, vf.id);
      }
      send(ctx.res, 200, {
        prepared: !!prepared,
        mountMs: Date.now() - t0,
        candidate: candidate ? { name: candidate.name, pickKey: candidate.pickKey, score: candidate.score, indexer: candidate.indexer } : null,
        attempts,
      });
    } catch (e) {
      send(ctx.res, 502, { error: e.message, summary: e.summary, attempts: e.attempts || [] });
    }
  },

  advance: async (ctx) => {
    if (throttleUserRoute(ctx, 'advance', { max: 30, windowMs: 60000, lockMs: 60000 })) return;
    const t0 = Date.now();
    try {
      const existing = pipeline.sessions.get(ctx.m[1]);
      if (!existing) return send(ctx.res, 404, { error: 'unknown play session', attempts: [] });
      if (existing.uid && existing.uid !== ctx.user.id) return send(ctx.res, 404, { error: 'unknown play session', attempts: [] });
      existing.uid = ctx.user.id;
      const { session, vf, candidate, attempts } = await pipeline.advance(ctx.m[1]);
      vf._q = session.query && session.query.q;
      vf._subQuery = episodeSubtitleQuery(vf._q, session.query && session.query.season, session.query && session.query.ep);
      vf._caps = session.caps || {}; // same client, same hardware claims
      rememberMountOwner(vf, ctx.user.id);
      trimUserMounts(ctx.user.id, vf.id);
      send(ctx.res, 200, mountPayload(vf, ctx.user.id, {
        sessionId: session.id, mountMs: Date.now() - t0,
        candidate: { name: candidate.name, pickKey: candidate.pickKey, score: candidate.score, indexer: candidate.indexer, attributes: candidate.attributes },
        attempts,
      }));
    } catch (e) {
      send(ctx.res, e.message.includes('unknown') ? 404 : 502, { error: e.message, summary: e.summary, attempts: e.attempts || [] });
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
      const { channels, sourceErrors } = await loadIptvChannelState(sources);
      const favs = new Set((store.read('iptvfavs', {})[ctx.user.id]) || []);
      // Admin-enforced hidden categories are stripped server-side for regular users — they
      // can't re-enable them. Admins still see everything (they manage the list).
      const globalHidden = new Set(s.iptvHiddenGroups || []);
      let list = ctx.user.role === 'admin' ? channels
        : channels.filter((c) => !globalHidden.has(c.group || 'Other'));
      // ?fav=1 → only the user's favorites (the home-row widget; keeps the payload tiny).
      if (ctx.url.searchParams.get('fav')) list = list.filter((c) => favs.has(c.id));
      const includeUrls = ctx.url.searchParams.get('lean') !== '1';
      send(ctx.res, 200, {
        configured: true,
        sources: sources.map(redactIptvSource),
        sourceErrors,
        epg: sources.some((src) => !!(xmltvGuideUrl(src) || src.iptvMode === 'xtream')),
        hiddenGroups: (store.read('iptvgroups', {})[ctx.user.id]) || [],
        globalHidden: ctx.user.role === 'admin' ? [...globalHidden] : undefined,
        channels: list.map(({ url: _u, nativeUrl: _nu, nativeFallbackUrl: _nfu, ...c }) => {
          const channelScope = `iptv:${c.idx}:${c.id}`;
          const token = auth.streamToken(ctx.user.id, channelScope);
          const cid = encodeURIComponent(c.id);
          const nativeMime = c.nativeMime || iptvNativeMime(_nu || _u);
          const nativeFallbackMime = c.nativeFallbackMime || (_nfu ? iptvNativeMime(_nfu) : '');
          const row = { ...c, fav: favs.has(c.id), nativeMime, nativeFallbackMime };
          if (!includeUrls) {
            return {
              idx: row.idx,
              id: row.id,
              name: row.name,
              logo: row.logo || '',
              group: row.group || 'Other',
              sourceId: row.sourceId || '',
              sourceName: row.sourceName || '',
              nativeMime,
              nativeFallbackMime,
              fav: row.fav,
            };
          }
          return {
            ...row,
            streamUrl: `/api/iptv/stream/${c.idx}?cid=${cid}&t=${token}`,
            nativeUrl: `/api/iptv/native/${c.idx}?cid=${cid}&t=${token}`,
            nativeFallbackUrl: _nfu ? `/api/iptv/native/${c.idx}?alt=1&cid=${cid}&t=${token}` : undefined,
          };
        }),
      });
    } catch (e) {
      console.error('[iptv]', e.message);
      send(ctx.res, 502, { error: 'live tv source failed — check the playlist/Xtream settings' });
    }
  },

  iptvPlay: async (ctx) => {
    const idx = parseInt(ctx.m[1], 10);
    const s = settings.get();
    const sources = iptvSourcesForUser(ctx.user, s);
    if (!sources.length) return send(ctx.res, 404, { error: 'live tv not configured' });
    try {
      await ensureIptvChannelStateForUser(ctx.user);
      const ch = iptvCache.channels && iptvCache.channels[idx];
      const cidParam = ctx.url.searchParams.get('cid') || '';
      if (!ch) return send(ctx.res, 404, { error: 'channel not found - open Live TV first' });
      if (cidParam && String(ch.id) !== cidParam) return send(ctx.res, 404, { error: 'channel changed - reopen Live TV' });
      const globalHidden = new Set(s.iptvHiddenGroups || []);
      if (ctx.user.role !== 'admin' && globalHidden.has(ch.group || 'Other')) {
        return send(ctx.res, 404, { error: 'channel not found' });
      }
      const channelScope = `iptv:${ch.idx}:${ch.id}`;
      const token = auth.streamToken(ctx.user.id, channelScope);
      const cid = encodeURIComponent(ch.id);
      const nativeMime = ch.nativeMime || iptvNativeMime(ch.nativeUrl || ch.url);
      const nativeFallbackMime = ch.nativeFallbackMime || (ch.nativeFallbackUrl ? iptvNativeMime(ch.nativeFallbackUrl) : '');
      return send(ctx.res, 200, {
        idx: ch.idx,
        id: ch.id,
        name: ch.name,
        group: ch.group || 'Other',
        streamUrl: `/api/iptv/stream/${ch.idx}?cid=${cid}&t=${token}`,
        nativeUrl: `/api/iptv/native/${ch.idx}?cid=${cid}&t=${token}`,
        nativeMime,
        nativeFallbackUrl: ch.nativeFallbackUrl ? `/api/iptv/native/${ch.idx}?alt=1&cid=${cid}&t=${token}` : undefined,
        nativeFallbackMime,
      });
    } catch (e) {
      console.error('[iptv play]', e.message);
      return send(ctx.res, 502, { error: 'live stream unavailable' });
    }
  },

  iptvSourcesList: async (ctx) => {
    const sources = iptvSourcesFromSettings(settings.get()).map(redactIptvSource);
    send(ctx.res, 200, { sources });
  },

  myIptvSourcesList: async (ctx) => {
    const sources = iptvOwnedSourcesForUser(ctx.user, settings.get()).map(redactIptvSource);
    send(ctx.res, 200, { sources });
  },

  myIptvSourceCreate: async (ctx) => {
    const b = await readJson(ctx.req);
    let src;
    try {
      src = makeIptvSourceFromBody({ ...b, users: [ctx.user.id], ownerUserId: ctx.user.id });
    } catch (e) {
      return send(ctx.res, e.status || 400, { error: e.message });
    }
    try { await assertIptvSourceAllowed(src); }
    catch (e) { return send(ctx.res, e.status || 400, { error: e.message }); }
    src.users = [ctx.user.id];
    src.ownerUserId = ctx.user.id;
    if (iptvOwnedSourcesForUser(ctx.user, settings.get()).length >= 10) {
      return send(ctx.res, 400, { error: 'personal playlist limit reached' });
    }
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
    scheduleIptvWarmSoon('user-source-added');
    send(ctx.res, 200, { source: redactIptvSource(src) });
  },

  myIptvSourceUpdate: async (ctx) => {
    const sourceId = cleanIptvSourceId(ctx.m[1]);
    const b = await readJson(ctx.req);
    let updated = null;
    let previous = null;
    const list = iptvSourcesFromSettings(settings.get());
    const idx = list.findIndex((src) => src.id === sourceId);
    if (idx < 0) return send(ctx.res, 404, { error: 'playlist not found' });
    previous = list[idx];
    if (previous.ownerUserId !== ctx.user.id) return send(ctx.res, 403, { error: 'not your playlist' });
    try {
      updated = makeIptvSourceFromBody(iptvEditBodyForExisting({
        ...b,
        users: [ctx.user.id],
        ownerUserId: ctx.user.id,
      }, previous), previous);
      await assertIptvSourceAllowed(updated);
    } catch (e) {
      return send(ctx.res, e.status || 400, { error: e.message || 'playlist update failed' });
    }
    updated.users = [ctx.user.id];
    updated.ownerUserId = ctx.user.id;
    settings.update((s) => {
      const current = iptvSourcesFromSettings(s);
      const currentIdx = current.findIndex((src) => src.id === sourceId);
      if (currentIdx < 0) return s;
      const nextList = [...current];
      nextList[currentIdx] = updated;
      return {
        ...s,
        iptvSources: nextList,
        iptvUrl: null, xtHost: null, xtUser: null, xtPass: null, epgUrl: null, iptvUsers: [],
      };
    });
    cleanupEditedIptvSource(sourceId, previous, updated);
    scheduleIptvWarmSoon('user-source-updated');
    send(ctx.res, 200, { source: redactIptvSource(updated) });
  },

  myIptvSourceDelete: async (ctx) => {
    const sourceId = cleanIptvSourceId(ctx.m[1]);
    let removed = null;
    let forbidden = false;
    settings.update((s) => {
      const list = iptvSourcesFromSettings(s);
      const target = list.find((src) => src.id === sourceId) || null;
      if (target && target.ownerUserId !== ctx.user.id) {
        forbidden = true;
        return s;
      }
      removed = target;
      const nextList = target ? list.filter((src) => src.id !== sourceId) : list;
      const next = { ...s, iptvSources: nextList };
      if (!nextList.length) {
        next.iptvUrl = null; next.xtHost = null; next.xtUser = null; next.xtPass = null; next.epgUrl = null; next.iptvUsers = [];
      }
      if (removed) {
        const prefix = `${removed.name}${IPTV_GROUP_SEPARATOR}`;
        next.iptvHiddenGroups = (next.iptvHiddenGroups || []).filter((g) => !String(g).startsWith(prefix));
      }
      return next;
    });
    if (forbidden) return send(ctx.res, 403, { error: 'not your playlist' });
    if (removed) cleanupDeletedIptvSource(sourceId, removed);
    if (removed) scheduleIptvWarmSoon('user-source-deleted');
    send(ctx.res, 200, { ok: true, removed: !!removed });
  },

  iptvSyncStatus: async (ctx) => {
    send(ctx.res, 200, iptvSyncSnapshot());
  },

  iptvSyncRefresh: async (ctx) => {
    let b = {};
    try { b = await readJson(ctx.req); } catch {}
    clearPendingIptvWarmSoon();
    const result = await warmIptvCaches('manual-refresh', { force: b.force !== false });
    send(ctx.res, 200, { ok: true, result, status: iptvSyncSnapshot() });
  },

  iptvSourceCreate: async (ctx) => {
    const b = await readJson(ctx.req);
    let src;
    try { src = makeIptvSourceFromBody(b); }
    catch (e) { return send(ctx.res, e.status || 400, { error: e.message }); }
    try { await assertIptvSourceAllowed(src); }
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

  iptvSourceUpdate: async (ctx) => {
    const sourceId = cleanIptvSourceId(ctx.m[1]);
    const b = await readJson(ctx.req);
    let updated = null;
    let previous = null;
    const list = iptvSourcesFromSettings(settings.get());
    const idx = list.findIndex((src) => src.id === sourceId);
    if (idx < 0) return send(ctx.res, 404, { error: 'playlist not found' });
    previous = list[idx];
    try {
      updated = makeIptvSourceFromBody(iptvEditBodyForExisting(b, previous), previous);
      await assertIptvSourceAllowed(updated);
    } catch (e) {
      return send(ctx.res, e.status || 400, { error: e.message || 'playlist update failed' });
    }
    settings.update((s) => {
      const current = iptvSourcesFromSettings(s);
      const currentIdx = current.findIndex((src) => src.id === sourceId);
      if (currentIdx < 0) return s;
      const nextList = [...current];
      nextList[currentIdx] = updated;
      return {
        ...s,
        iptvSources: nextList,
        iptvUrl: null, xtHost: null, xtUser: null, xtPass: null, epgUrl: null, iptvUsers: [],
      };
    });
    cleanupEditedIptvSource(sourceId, previous, updated);
    scheduleIptvWarmSoon('source-updated');
    send(ctx.res, 200, { source: redactIptvSource(updated) });
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
        const prefix = `${removed.name}${IPTV_GROUP_SEPARATOR}`;
        next.iptvHiddenGroups = (next.iptvHiddenGroups || []).filter((g) => !String(g).startsWith(prefix));
      }
      return next;
    });
    cleanupDeletedIptvSource(sourceId, removed);
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
    if (throttleUserRoute(ctx, 'iptv-guide', { max: 60, windowMs: 60000, lockMs: 60000 })) return;
    const idxs = String(ctx.url.searchParams.get('chs') || '')
      .split(',').map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 0).slice(0, 48);
    const cids = String(ctx.url.searchParams.get('cids') || '')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, idxs.length);
    if (idxs.length) {
      try { await ensureIptvChannelStateForUser(ctx.user); } catch {}
    }
    const chans = idxs.map((i, n) => {
      const ch = iptvCache.channels && iptvCache.channels[i];
      if (!ch) return null;
      if (cids[n] && String(ch.id) !== cids[n]) return null;
      return ch;
    }).filter(Boolean);
    if (cids.length && chans.length !== idxs.length) return send(ctx.res, 409, { error: 'channel list changed - reopen Live TV' });
    if (!chans.length) return send(ctx.res, 200, { channels: [] });
    const from = Date.now() - 90 * 60000, to = Date.now() + 4 * 3600000;
    const channels = await mapLimit(chans, 8, async (ch) => {
      const src = sourceForIptvChannel(ch);
      let progs = [];
      if (src && src.iptvMode === 'xtream' && ch.xtreamId) {
        progs = (await xtreamEpgList(ch, { limit: 24, allowBusy: true })).filter((p) => p.stop > from && p.start < to);
      }
      let epg = null;
      if (src && xmltvGuideUrl(src)) {
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
    if (throttleUserRoute(ctx, 'iptv-epg', { max: 90, windowMs: 60000, lockMs: 60000 })) return;
    try { await ensureIptvChannelStateForUser(ctx.user); } catch {}
    const ch = iptvCache.channels && iptvCache.channels[parseInt(ctx.m[1], 10)];
    if (!ch) return send(ctx.res, 404, { error: 'channel not found' });
    try {
      const nn = await epgNowNext(ch);
      send(ctx.res, 200, nn || {});
    } catch { send(ctx.res, 200, {}); }
  },

  // Live stream: ffmpeg ingests the channel URL (HLS/TS/whatever) → fMP4 the browser plays.
  iptvNative: async (ctx) => {
    const idx = parseInt(ctx.m[1], 10);
    const cid = ctx.url.searchParams.get('cid') || '';
    if (!streamScopeOk(ctx, cid ? `iptv:${idx}:${cid}` : `iptv:${idx}`)) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const user = ctx.user || auth.getUser(ctx.claims.uid);
    try { await ensureIptvChannelStateForUser(user); } catch {}
    const ch = iptvCache.channels && iptvCache.channels[idx];
    if (!ch) return send(ctx.res, 404, { error: 'channel not found - open Live TV first' });
    if (cid && String(ch.id) !== cid) return send(ctx.res, 404, { error: 'channel changed - reopen Live TV' });
    const alt = ctx.url.searchParams.get('alt') === '1';
    const target = alt && ch.nativeFallbackUrl ? ch.nativeFallbackUrl : (ch.nativeUrl || ch.url);
    return proxyIptvNative(ctx, target, 0, { idx: ch.idx, name: ch.name, alt });
  },

  iptvStream: async (ctx) => {
    const idx = parseInt(ctx.m[1], 10);
    const cid = ctx.url.searchParams.get('cid') || '';
    if (!streamScopeOk(ctx, cid ? `iptv:${idx}:${cid}` : `iptv:${idx}`)) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const user = ctx.user || auth.getUser(ctx.claims.uid);
    try { await ensureIptvChannelStateForUser(user); } catch {}
    let ch = iptvCache.channels && iptvCache.channels[idx];
    if (!ch) return send(ctx.res, 404, { error: 'channel not found — open Live TV first' });
    if (cid && String(ch.id) !== cid) return send(ctx.res, 404, { error: 'channel changed - reopen Live TV' });
    if (!detectFfmpeg()) return send(ctx.res, 503, { error: 'ffmpeg required for Live TV' });
    let remuxTargets = iptvRemuxTargets(ch);
    if (!remuxTargets.length) return send(ctx.res, 502, { error: 'invalid live stream url' });
    let availableTargets = [];
    let cachedFailure = null;
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
      return sendIptvNativeError(ctx.res, cachedFailure.status, cachedFailure.reason);
    }
    const liveSlot = beginIptvLiveSlot(ctx, { idx: ch.idx, name: ch.name });
    const startupDeadline = Date.now() + LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS;
    const startupRemaining = () => startupDeadline - Date.now();
    const startupTimedOut = () => startupRemaining() <= 0;
    const finishLiveStartupTimeout = (target, reason = 'live stream startup timeout') => {
      liveSlot.done('startup timeout');
      if (target && target.url) {
        iptvNativeErrorCache.set(idHash(`remux:${ch.idx}:${target.url}`), {
          status: 504,
          reason,
          until: Date.now() + IPTV_NATIVE_ERROR_TTL_MS,
        });
      }
      console.error(`[iptv] "${ch.name}" remux startup timeout`);
      if (!ctx.res.headersSent && !ctx.res.destroyed) return sendIptvNativeError(ctx.res, 504, reason);
      try { if (!ctx.res.destroyed) ctx.res.destroy(); } catch {}
      return undefined;
    };
    // Attempt 1 uses HLS-friendly demuxer options; if ffmpeg dies before emitting a single
    // byte (non-HLS channel, or an older ffmpeg without those options) retry once plain.
    let targetIndex = 0;
    const attempt = async (target, hlsFriendly, retriesLeft) => {
      if (liveSlot.closed) return;
      if (startupTimedOut()) return finishLiveStartupTimeout(target);
      let pin;
      try { pin = await validateAndPinIptvUrl(target.url, 'Live stream URL'); }
      catch (e) {
        liveSlot.done('blocked upstream');
        console.error(`[iptv] "${ch.name}" blocked remux upstream: ${sanitizeIptvLogError(e)}`);
        if (!ctx.res.headersSent) send(ctx.res, e.status || 400, { error: e.message || 'blocked live stream url' });
        else try { ctx.res.destroy(); } catch {}
        return;
      }
      // The validate/DNS-pin await can take a while on slow providers; if the client gave up in
      // that window, don't spawn ffmpeg + hold an upstream provider connection for nothing.
      if (liveSlot.closed || ctx.res.destroyed) { liveSlot.done('client closed'); return; }
      let ff;
      try {
        ff = spawnLiveRemux(iptvRemuxInputHref(pin, target.url), {
          hlsFriendly,
          headers: pin.hostHeader ? { Host: pin.hostHeader } : undefined,
        });
      }
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
        const waitMs = wrote ? ms : Math.min(ms, Math.max(250, startupRemaining()));
        idleTimer = setTimeout(() => {
          console.error(`[iptv] "${ch.name}" remux stalled without output for ${Math.round(waitMs / 1000)}s`);
          try { ff.kill('SIGKILL'); } catch {}
        }, waitMs);
        idleTimer.unref();
      };
      const stopForClientClose = () => {
        if (clientClosed) return;
        clientClosed = true;
        clearIdle();
        try { if (ctx.req.socket && !ctx.req.socket.destroyed) ctx.req.socket.destroy(); } catch {}
        try { ff.kill('SIGKILL'); } catch {}
        try { if (!ctx.res.destroyed) ctx.res.destroy(); } catch {}
        liveSlot.done('client closed');
      };
      liveSlot.setCloser((reason) => {
        if (clientClosed) return;
        clientClosed = true;
        clearIdle();
        try { if (ctx.req.socket && !ctx.req.socket.destroyed) ctx.req.socket.destroy(); } catch {}
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
            connection: 'close',
            'x-accel-buffering': 'no',
          });
          if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();
        }
        armIdle(LIVE_REMUX_IDLE_TIMEOUT_MS);
        if (!ctx.res.destroyed && !ctx.res.write(chunk)) {
          try { ff.stdout.pause(); } catch {}
          ctx.res.once('drain', () => {
            if (!clientClosed && !ctx.res.destroyed) {
              try { ff.stdout.resume(); } catch {}
            }
          });
        }
      });
      ff.stderr.on('data', (d) => { if (err.length < 8000) err += d; }); // cap: ffmpeg streams stderr for the whole playback
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
        if (codeNum && !wrote && startupTimedOut()) return finishLiveStartupTimeout(target);
        if (codeNum && !wrote && !providerRejected && !target.redirectResolved && !target.redirectProbeFailed && shouldResolveIptvRemuxRedirect(err) && !ctx.res.destroyed && startupRemaining() > 1500) {
          try {
            const redirectUrl = await resolveIptvRemuxRedirect(target.url);
            if (redirectUrl && redirectUrl !== target.url && !ctx.res.destroyed) {
              const redirected = { ...target, url: redirectUrl, label: target.label ? `${target.label} redirect` : 'redirect', redirectResolved: true };
              const redirectHls = hlsFriendly || iptvRemuxTargetLikelyHls(redirected);
              console.error(`[iptv] "${ch.name}" ${target.label || 'stream'} remux resolved provider redirect - retrying safely`);
              return attempt(redirected, redirectHls, redirectHls ? 1 : 0);
            }
          } catch (e) {
            target.redirectProbeFailed = true;
            console.error(`[iptv] "${ch.name}" redirect probe failed: ${sanitizeIptvLogError(e)}`);
          }
        }
        if (codeNum && !wrote && startupTimedOut()) return finishLiveStartupTimeout(target);
        if (codeNum && !wrote && !providerRejected && pin && typeof pin.onFailure === 'function') {
          try { pin.onFailure(); } catch {}
        }
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
        try { if (ctx.req.socket && !ctx.req.socket.destroyed) ctx.req.socket.destroy(); } catch {}
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
    libraryDb.deleteLibrary(ctx.m[1]);
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
    const item = libraryItemByIndex(lib.id, idx);
    if (!item) return send(ctx.res, 404, { error: 'item not found — rescan first' });
    if (item.kind === 'episode') return send(ctx.res, 400, { error: 'fix the match on the SHOW — its episodes follow' });
    const ov = b.tmdbId === 'auto' ? 'auto' // clear the override — back to automatic matching
      : (b.tmdbId === null || b.tmdbId === 'none') ? 'none'
      : (Number.isInteger(+b.tmdbId) && +b.tmdbId > 0 ? +b.tmdbId : null);
    if (ov === null) return send(ctx.res, 400, { error: 'tmdbId must be a TMDB id, null for folder info, or "auto"' });
    if (ov === 'auto') { delete item.matchOverride; item.tmdbId = null; } else item.matchOverride = ov;
    if (!(libraryDb.available && libraryDb.updateItem(lib.id, idx, item))) {
      store.update('libitems', {}, (s) => {
        const it = s[lib.id] && s[lib.id].items[idx];
        if (it) { if (ov === 'auto') { delete it.matchOverride; it.tmdbId = null; } else it.matchOverride = ov; }
        return s;
      });
    }
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
    const prevItems = (libraryRecord(lib.id) || { items: [] }).items;
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
    saveLibraryScan(lib.id, Date.now(), items);
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
  trakt.markSynced(uid);
  return { ok: true, watched: nWatched, playback: nPlayback, watchlist: nWatchlist,
    pushed: pushed.sent || 0, pendingPush: pushed.pending || 0,
    totalWatched: watched.length, totalWatchlist: watchlist.length };
}
// Auto-resync every 6h per linked user — one user per tick keeps the calls gentle.
function traktSyncTick() {
  const tokens = trakt.linkedTokens();
  for (const [uid, tok] of Object.entries(tokens)) {
    if (!tok || (tok.syncedAt && Date.now() - tok.syncedAt < 6 * 3600000)) continue;
    trakt.markSynced(uid); // claim before the async work
    traktSyncDown(uid)
      .then((r) => { if (r.watched || r.playback || r.watchlist || r.pushed) console.log(`[trakt] sync: +${r.watched} watched, +${r.playback} in-progress, +${r.watchlist} watchlist, ${r.pushed} pushed`); })
      .catch((e) => console.error('[trakt sync]', e.message));
    break;
  }
}
setInterval(traktSyncTick, 60000).unref();

// ---------- handlers, continued ----------
Object.assign(H, {
  localLookup: async (ctx) => {
    const raw = [
      ...ctx.url.searchParams.getAll('key'),
      ...String(ctx.url.searchParams.get('keys') || '').split(','),
    ].map((s) => String(s || '').trim()).filter(Boolean).slice(0, 200);
    if (!raw.length) return send(ctx.res, 200, { items: {} });
    const allowed = allowedLocalLibraryIds(ctx);
    const out = {};
    if (libraryDb.available) {
      const found = libraryDb.lookup(raw, allowed);
      for (const [key, row] of Object.entries(found)) {
        out[key] = localItemPayload(ctx, row.libId, row.item);
      }
      return send(ctx.res, 200, { items: out });
    }
    const wanted = new Set(raw);
    const all = store.read('libitems', {});
    for (const libId of allowed) {
      const rec = all[libId];
      for (const item of (rec && rec.items) || []) {
        if (!item || !item.tmdbId) continue;
        const key = item.kind === 'movie'
          ? `tmdb:movie:${item.tmdbId}`
          : item.kind === 'episode'
            ? `tmdb:tv:${item.tmdbId}:s${item.s}e${item.e}`
            : '';
        if (key && wanted.has(key) && !out[key]) out[key] = localItemPayload(ctx, libId, item);
      }
    }
    send(ctx.res, 200, { items: out });
  },

  libraryItems: async (ctx) => {
    // Restricted libraries are invisible to excluded users (stream/art tokens are only minted
    // here, so this is the single gate for local playback too).
    const lib = store.read('libraries', { list: [] }).list.find((l) => l.id === ctx.m[1]);
    if (lib && lib.users && lib.users.length && ctx.user.role !== 'admin' && !lib.users.includes(ctx.user.id)) {
      return send(ctx.res, 404, { error: 'library not found' });
    }
    const libId = ctx.m[1];
    const rec = libraryRecord(libId);
    if (!rec) return send(ctx.res, 200, { items: [] });
    const limitRaw = ctx.url.searchParams.get('limit');
    if (limitRaw !== null) {
      const limit = Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 15));
      const offset = Math.max(0, parseInt(ctx.url.searchParams.get('offset') || '0', 10) || 0);
      const sort = ctx.url.searchParams.get('sort') || 'added.desc';
      const genre = parseInt(ctx.url.searchParams.get('genre') || '0', 10) || 0;
      const showIdxRaw = ctx.url.searchParams.get('showIdx');
      const showIdx = showIdxRaw === null ? null : parseInt(showIdxRaw, 10);
      if (libraryDb.available) {
        const pageRec = libraryDb.page(libId, { offset, limit, sort, genre, showIdx });
        if (pageRec) return send(ctx.res, 200, {
          scannedAt: pageRec.scannedAt,
          offset: pageRec.offset,
          limit: pageRec.limit,
          total: pageRec.total,
          hasMore: pageRec.hasMore,
          genres: pageRec.genres,
          show: pageRec.show ? localItemPayload(ctx, libId, pageRec.show) : null,
          items: pageRec.items.map((item) => localItemPayload(ctx, libId, item)),
        });
      }
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
    // STABLE tokens: identical URLs within a short cache bucket, while the signature still
    // expires inside the normal 6h stream-token window.
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
    const found = localItemFor(ctx, ctx.m[1], ctx.m[2]);
    if (found.error) return send(ctx.res, found.status || 404, { error: found.error });
    const item = found.item;
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
    const found = localLibraryItemFor(ctx, ctx.m[1], ctx.m[2]);
    if (found.error) return send(ctx.res, found.status || 404, { error: found.error });
    const item = found.item;
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
    const found = localItemFor(ctx, ctx.m[1], ctx.m[2]);
    if (found.error) return send(ctx.res, found.status || 404, { error: found.error });
    const item = found.item;
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
      if (b.hidden) {
        all[k] = {
          position: 0, duration: 0, watched: false, hidden: true,
          meta: sanitizeStoredMediaMeta(b.meta), updatedAt: nextStamp(),
        };
        return all;
      }
      if (profile !== 'default' && b.watched === false && b.unwatch) deleteWatchKeyForProfile(all, ctx.user.id, profile, b.key);
      all[k] = {
        position: b.position || 0, duration: b.duration || 0, watched: !!b.watched,
        meta: sanitizeStoredMediaMeta(b.meta), updatedAt: nextStamp(),
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

  activityList: async (ctx) => {
    const sessions = activeActivityRows();
    const online = activeOnlineRows();
    send(ctx.res, 200, {
      sessions,
      online,
      history: activityHistoryRows(),
      activeCount: sessions.length,
      onlineCount: online.length,
      retentionDays: ACTIVITY_HISTORY_DAYS,
      connections: activityConnectionStats(),
    });
  },

  // Online-presence heartbeat: every open app pings this (browsing or watching) so the admin
  // Activity screen can show ALL connected devices, not only those actively playing. Keyed per
  // user+device so one person on TV + phone shows as two connected devices.
  presenceSet: async (ctx) => {
    const b = await readJson(ctx.req).catch(() => ({}));
    const device = scrubActivityText(b.deviceId || '', 80);
    if (!device) return send(ctx.res, 400, { error: 'deviceId required' });
    const key = `${ctx.user.id}:${device}`;
    if (b.state === 'offline' || b.stop) { presenceSessions.delete(key); return send(ctx.res, 200, { ok: true }); }
    const watching = b.state === 'watching';
    presenceSessions.set(key, {
      id: key,
      uid: ctx.user.id,
      userName: activityUserName(ctx.user.id),
      profile: scrubActivityText(b.profile || '', 40),
      state: watching ? 'watching' : 'browsing',
      title: watching ? scrubActivityText(b.title || '', 180) : '',
      view: scrubActivityText(b.view || '', 40),
      clientVersion: activityClientVersion(b, ctx.req),
      device: scrubActivityText(b.device || ctx.req.headers['user-agent'] || '', 90),
      deviceName: activityDeviceName(b, ctx.req),
      lastSeen: Date.now(),
    });
    send(ctx.res, 200, { ok: true });
  },

  activitySet: async (ctx) => {
    const b = await readJson(ctx.req).catch(() => ({}));
    const id = scrubActivityText(b.sessionId || b.id || '', 80);
    if (!id) return send(ctx.res, 400, { error: 'sessionId required' });
    const existing = activitySessions.get(id);
    // Bind each now-watching row to its owner: a user may only stop/overwrite their OWN row (admins
    // may manage any). The sessionId is client-chosen, so without this one user could stop or
    // hijack another's row by guessing/reusing its id.
    if (existing && existing.userId && existing.userId !== ctx.user.id && ctx.user.role !== 'admin') {
      return send(ctx.res, 200, { ok: true }); // no cross-user mutation; silent so it leaks nothing
    }
    if (b.state === 'stopped' || b.stop || b.remove) {
      if (existing) {
        existing.updatedAt = Date.now();
        recordActivityHistory(existing);
      }
      activitySessions.delete(id);
      return send(ctx.res, 200, { ok: true });
    }
    const row = normalizeActivityRow(ctx, b, id, existing || {});
    activitySessions.set(id, row);
    recordActivityHistory(row);
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
        else { all[k] = { position: 0, duration: it.duration || 0, watched: true, meta: sanitizeStoredMediaMeta(it.meta), updatedAt: nextStamp() }; }
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

  // Per-profile UI/playback preferences (auto-CC, screensaver delay, languages, quality default, …)
  // synced to the account so they survive a reinstall / new device and follow the user across
  // devices. Stored per (user, profile); the client mirrors them into its local storage cache.
  prefsGet: async (ctx) => {
    const profile = String(ctx.url.searchParams.get('profile') || 'default').slice(0, 64);
    const all = store.read('prefs', {}) || {};
    send(ctx.res, 200, { prefs: all[`${ctx.user.id}:${profile}`] || {} });
  },
  prefsSet: async (ctx) => {
    const b = await readJson(ctx.req);
    const profile = String(b.profile || 'default').slice(0, 64);
    const incoming = (b.prefs && typeof b.prefs === 'object' && !Array.isArray(b.prefs)) ? b.prefs : {};
    // Bound what a client can store: cap key count + key/value lengths so prefs can't bloat ./data.
    const clean = {};
    let n = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (n++ >= 120 || typeof k !== 'string' || !k || k.length > 64) continue;
      if (v === null) { clean[k] = null; continue; }
      const s = String(v);
      if (s.length > 8192) continue;
      clean[k] = s;
    }
    store.update('prefs', {}, (all) => {
      const key = `${ctx.user.id}:${profile}`;
      const cur = all[key] || {};
      for (const [k, v] of Object.entries(clean)) { if (v === null) delete cur[k]; else cur[k] = v; }
      all[key] = cur;
      return all;
    });
    send(ctx.res, 200, { ok: true });
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
      openSubsKey: effectiveOpenSubsKey(s) ? '•••' : null,
      builtInSubtitlesEnabled: s.builtInSubtitlesEnabled === true,
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
      ytOAuthClientId: s.ytOAuthClientId || null, // public identifier — safe to show
      ytOAuthClientSecret: s.ytOAuthClientSecret ? '•••' : null,
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

  // Live speed + connection-cap probe for one saved provider (creds stay server-side). A failure is
  // a 200 {ok:false} result, not an HTTP error — same contract as testProvider.
  testProviderSpeed: async (ctx) => {
    const b = await readJson(ctx.req).catch(() => ({}));
    const p = providerList()[b.index];
    if (!p) return send(ctx.res, 400, { error: 'no provider at that index' });
    // One speed test per provider at a time — two concurrent tests (e.g. two browser tabs) wouldn't
    // see each other's connections and could together overshoot the cap. Serialize them per provider.
    if (speedTestInFlight.has(b.index)) {
      return send(ctx.res, 200, { ok: false, host: p.host, error: 'a speed test is already running for this provider — wait for it to finish' });
    }
    const configured = providerConnections(p.connections);
    // The speed test opens its OWN connections, separate from the live playback pool. To honor the
    // configured cap, the test may only use the FREE headroom (configured − connections playback is
    // already holding), and we FREEZE the live pool at its current size for the test's duration so it
    // can't grow into that headroom. Net guarantee: (live playback + test) ≤ configured, always.
    const livePp = pool && pool.providers && pool.providers[b.index];
    const liveOpen = livePp ? livePp.conns.length + livePp.connecting : 0;
    const headroom = Math.max(0, configured - liveOpen);
    const want = Math.min(clampInt(b.maxConns, configured, 1, Math.min(configured, SPEEDTEST_MAX_CONNS)), headroom);
    if (want < 1) {
      return send(ctx.res, 200, { ok: false, host: p.host, reservedByPlayback: liveOpen,
        error: `all ${configured} connections are currently in use by active playback — stop a stream and retry` });
    }
    speedTestInFlight.add(b.index);
    const origSize = livePp ? livePp.size : null;
    if (livePp) livePp.size = liveOpen; // freeze: pool won't open new connections during the test
    try {
      const r = await speedTestProvider(p, { targetConns: want });
      send(ctx.res, 200, { ...r, reservedByPlayback: liveOpen });
    } catch (e) {
      send(ctx.res, 200, { ok: false, host: p.host, error: e.message });
    } finally {
      speedTestInFlight.delete(b.index);
      if (livePp) { livePp.size = origSize; livePp._pump(); }
    }
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
    let mergedIptvSource = null;
    let clearLegacyIptvSource = false;
    if (iptvSourceChanged || iptvAccessChanged) {
      const cur = settings.get();
      const currentSources = iptvSourcesFromSettings(cur);
      const existing = currentSources[0] || legacyIptvSource(cur) || { id: IPTV_LEGACY_SOURCE_ID, name: 'Default Live TV' };
      clearLegacyIptvSource = b.iptvUrl === null && b.xtHost === null && b.xtUser === null && b.xtPass === null;
      if (!clearLegacyIptvSource) {
        try {
          mergedIptvSource = makeIptvSourceFromBody({ ...b, iptvUsers: b.iptvUsers !== undefined ? b.iptvUsers : (cur.iptvUsers || []) }, existing);
          await assertIptvSourceAllowed(mergedIptvSource);
        } catch (e) {
          return send(ctx.res, e.status || 400, { error: e.message || 'Live TV source is invalid' });
        }
      }
    }
    // Ops merge server-side so the UI never needs the decrypted secrets back:
    //   addProvider / removeProvider (index) · addIndexer / removeIndexer (index)
    // Wholesale replacement (providers:/indexers:) still works for tests/automation.
    settings.update((s) => {
      const next = {
        providers: b.providers !== undefined ? normalizeProviders(b.providers) : normalizeProviders(s.providers || []),
        indexers: b.indexers !== undefined ? b.indexers : [...(s.indexers || [])],
        tmdbKey: b.tmdbKey !== undefined ? b.tmdbKey : s.tmdbKey,
        openSubsKey: b.openSubsKey !== undefined ? (b.openSubsKey || null) : (s.openSubsKey ?? null),
        builtInSubtitlesEnabled: b.builtInSubtitlesEnabled !== undefined
          ? b.builtInSubtitlesEnabled === true
          : s.builtInSubtitlesEnabled === true,
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
        ytOAuthClientId: b.ytOAuthClientId !== undefined ? (b.ytOAuthClientId || null) : s.ytOAuthClientId,
        ytOAuthClientSecret: b.ytOAuthClientSecret !== undefined ? (b.ytOAuthClientSecret || null) : s.ytOAuthClientSecret,
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
        if (clearLegacyIptvSource) {
          next.iptvSources = [];
          next.iptvUrl = null; next.xtHost = null; next.xtUser = null; next.xtPass = null; next.epgUrl = null; next.iptvUsers = [];
        } else if (mergedIptvSource) {
          next.iptvSources = [mergedIptvSource, ...currentSources.filter((src) => src.id !== mergedIptvSource.id)];
          next.iptvMode = mergedIptvSource.iptvMode;
          next.iptvUrl = mergedIptvSource.iptvUrl;
          next.xtHost = mergedIptvSource.xtHost;
          next.xtUser = mergedIptvSource.xtUser;
          next.xtPass = mergedIptvSource.xtPass;
          next.epgUrl = mergedIptvSource.epgUrl;
          next.iptvUsers = mergedIptvSource.users;
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
    if (!mountAccessOk(ctx, vf)) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable', tags: vf.tags });
    vf._touched = Date.now();
    pipeline.rebalancePlaybackWindows();
    try {
      ctx.req.setTimeout(120000);
      ctx.res.setTimeout(120000);
      if (ctx.req.socket) ctx.req.socket.setTimeout(120000);
    } catch {}
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
    const readController = new AbortController();
    const readSignal = readController.signal;
    let completedRead = false;
    const requestedPriority = String(ctx.url.searchParams.get('priority') || '').toLowerCase();
    const explicitPriority = requestedPriority === 'read-ahead' ? 'readAhead' : requestedPriority;
    const highWaterEnd = Number(vf._streamHighWaterEnd || 0);
    const partSlack = Number(vf.partSize || 0) * Math.max(2, Math.min(8, Number(vf.readAhead || 4)));
    const sequentialSlack = Math.max(2 * 1024 * 1024, partSlack || 0);
    const sequentialRange = start > 0
      && highWaterEnd > 0
      && start >= Math.max(0, highWaterEnd - sequentialSlack)
      && start <= highWaterEnd + sequentialSlack;
    const readPriority = ['background', 'readAhead', 'health'].includes(explicitPriority)
      ? explicitPriority
      : (start === 0 ? 'startup' : (sequentialRange ? 'playback' : 'seek'));
    const abortRead = () => {
      if (!readSignal.aborted) readController.abort();
      // Only a real player seek/interrupt should cancel the shared mount's read-ahead. A closing
      // read-ahead / warm-ahead / background / health connection must NOT bump the shared
      // readAheadEpoch — that strands a paused→resumed player (whose live read captured the old
      // epoch) with no prefetch until it seeks. This was the "pause a few seconds → stuck on
      // resume unless I rewind" bug.
      if (!['readAhead', 'background', 'health'].includes(readPriority)
          && vf && typeof vf.cancelReadAhead === 'function') {
        vf.cancelReadAhead();
      }
    };
    const stopReqRead = () => {
      if (!ctx.req.complete) abortRead();
    };
    const stopResRead = () => {
      if (!completedRead && !ctx.res.writableEnded) abortRead();
    };
    ctx.req.once('close', stopReqRead);
    ctx.res.once('close', stopResRead);
    const suReadT0 = STARTUP_TRACE ? Date.now() : 0;
    let suFirstChunk = STARTUP_TRACE;
    try {
      for await (const chunk of vf.read(start, end, { priority: readPriority, signal: readSignal })) {
        if (suFirstChunk) {
          suFirstChunk = false;
          if (vf._su && (readPriority === 'startup' || readPriority === 'seek')) {
            const tail = start > (Number(vf._su.size) || 0) * 0.5;
            const key = tail ? '_suTailLogged' : '_suHeadLogged';
            if (!vf._su[key]) { vf._su[key] = true; logStartupTrace(vf, 'stream', { ttfbMs: Date.now() - suReadT0, offset: start }); }
          }
        }
        if (readSignal.aborted || ctx.res.destroyed) break;
        if (!ctx.res.write(chunk)) await new Promise((resolve) => {
          const done = () => {
            ctx.res.off('drain', done);
            ctx.res.off('close', done);
            resolve();
          };
          ctx.res.once('drain', done);
          ctx.res.once('close', done);
        });
        if (readSignal.aborted || ctx.res.destroyed) break;
      }
      completedRead = !readSignal.aborted && !ctx.res.destroyed;
      if (completedRead) vf._streamHighWaterEnd = Math.max(Number(vf._streamHighWaterEnd || 0), end);
    } catch (e) {
      if (!readSignal.aborted) console.error(`[stream ${vf.id}]`, e.message);
    } finally {
      ctx.req.off('close', stopReqRead);
      ctx.res.off('close', stopResRead);
    }
    if (readSignal.aborted) {
      try { if (!ctx.res.destroyed) ctx.res.destroy(); } catch {}
      return;
    }
    if (!ctx.res.destroyed && !ctx.res.writableEnded) ctx.res.end();
  },

  remux: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!mountAccessOk(ctx, vf)) return send(ctx.res, 404, { error: 'mount not found' });
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
    const forceAudioSafe = ctx.url.searchParams.get('audioSafe') === '1';
    const transcodeAudio = forceAudioSafe || !audioCopyOk(aud, vf._caps);
    if (!vf._tracks && detectFfprobe() && !vf._probing) {
      vf._probing = true;
      probeTracks(selfUrl).then((t) => { vf._tracks = { available: true, ...t }; }).catch(() => {}).finally(() => { vf._probing = false; });
    }
    const ff = spawnRemux(selfUrl, { startSeconds, audioTrack, transcodeAudio, safeStereo: forceAudioSafe });
    if (STARTUP_TRACE) {
      // Measure the ffmpeg restart cost for BOTH the initial play (startSeconds 0, once) and every
      // seek/resume (startSeconds > 0 re-spawns ffmpeg at -ss): spawn → first output byte, which
      // includes fetching the seek-target region from usenet. This is what makes skipping/resuming
      // in 4K slow, the same way the mount made the first start slow.
      const suSpawnT0 = Date.now();
      const isSeek = startSeconds > 0;
      const audio = transcodeAudio ? 'reencode' : 'copy';
      ff.stdout.once('data', () => {
        const probeMs = Date.now() - suSpawnT0;
        if (isSeek) logStartupTrace(vf, 'seek', { remuxProbeMs: probeMs, audio, seekSec: startSeconds });
        else if (vf._su && !vf._su._suRemuxLogged) {
          vf._su._suRemuxLogged = true;
          logStartupTrace(vf, 'remux', { remuxProbeMs: probeMs, audio });
        }
      });
    }
    ctx.res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    // A spawn-level error ('error' event) is FATAL to the process if unhandled — never omit this.
    ff.on('error', (e) => { console.error('[remux spawn]', e.message); try { ctx.res.destroy(); } catch {} });
    ff.stdout.pipe(ctx.res);
    let err = '';
    ff.stderr.on('data', (d) => { if (err.length < 8000) err += d; }); // cap: ffmpeg streams stderr for the whole playback
    ff.on('close', (codeNum) => { if (codeNum && !ctx.res.writableEnded) console.error('[remux]', err.slice(0, 400)); ctx.res.end(); });
    ctx.req.on('close', () => ff.kill('SIGKILL'));
  },

  // Full transcode (the codec wall): H.264+AAC ladder for clients that can't decode the
  // source. HDR sources are tone-mapped. Heaviest path — used only when remux can't play.
  transcode: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!mountAccessOk(ctx, vf)) return send(ctx.res, 404, { error: 'mount not found' });
    // Per-user cap, transcoder half (CLAUDE.md: caps enforced at source first, transcoder second).
    // Default policy allows transcoding; only an explicit admin opt-out blocks it.
    if (ctx.user && ctx.user.policy && ctx.user.policy.allowTranscode === false) {
      return send(ctx.res, 403, { error: 'transcoding is disabled for this account' });
    }
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
    ff.stderr.on('data', (d) => { if (err.length < 8000) err += d; }); // cap: ffmpeg streams stderr for the whole playback
    ff.on('close', (codeNum) => { if (codeNum && !ctx.res.writableEnded) console.error('[transcode]', err.slice(0, 400)); ctx.res.end(); });
    ctx.req.on('close', () => ff.kill('SIGKILL'));
  },

  // Track listing (audio + subtitles + duration) via ffprobe — powers CC/audio menus and
  // the "ends at" clock. Cached per mount (probe reads only the stream head).
  tracks: async (ctx) => {
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!mountAccessOk(ctx, vf)) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable', tags: vf.tags });
    vf._touched = Date.now();
    const releaseSubs = publicReleaseSubs(vf);
    if (!detectFfprobe()) return send(ctx.res, 200, { available: false, audio: [], subs: [], releaseSubs, duration: null });
    if (vf._tracks) return send(ctx.res, 200, vf._tracks);
    try {
      const selfUrl = `http://127.0.0.1:${server.address().port}/api/stream/${vf.id}?t=${auth.streamToken(ctx.user.id, vf.id)}`;
      const t = await probeTracks(selfUrl);
      vf._tracks = { available: true, ...t, releaseSubs };
      send(ctx.res, 200, vf._tracks);
      // The TV player is Wyzie-only for subtitles. Embedded subtitle extraction can require
      // scanning the whole media stream, so probing tracks must not quietly kick that off.
    } catch (e) { send(ctx.res, 200, { available: false, audio: [], subs: [], releaseSubs, duration: null, error: e.message }); }
  },

  // Same-release sidecar subtitles from the NZB/archive. These are read only when selected,
  // so playback startup and source health checks do not wait on subtitle extraction.
  releasesub: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!mountAccessOk(ctx, vf)) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable' });
    if (typeof vf.readReleaseSub !== 'function') return send(ctx.res, 404, { error: 'release subtitle not found' });
    vf._touched = Date.now();
    const id = String(ctx.m[2] || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    const sub = (vf.releaseSubs || []).find((s) => String(s.id) === id);
    if (!sub) return send(ctx.res, 404, { error: 'release subtitle not found' });
    const shift = Math.max(-120, Math.min(120, Number(ctx.url.searchParams.get('shift') || 0) || 0));
    vf._releaseSubCache = vf._releaseSubCache || new Map();
    vf._releaseSubJobs = vf._releaseSubJobs || new Map();
    if (!vf._releaseSubCache.has(id)) {
      if (!vf._releaseSubJobs.has(id)) {
        const work = vf.readReleaseSub(id)
          .then((buf) => releaseSubtitleToVtt(buf, sub.ext))
          .then((vtt) => {
            vf._releaseSubCache.set(id, vtt);
            return vtt;
          })
          .finally(() => vf._releaseSubJobs.delete(id));
        vf._releaseSubJobs.set(id, work);
      }
      try { await vf._releaseSubJobs.get(id); } catch (e) {
        return send(ctx.res, 502, { error: 'release subtitle failed', detail: String(e.message || e).slice(0, 200) });
      }
    }
    const vtt = vf._releaseSubCache.get(id);
    send(ctx.res, 200, shift ? shiftVtt(vtt, shift) : vtt, { 'content-type': 'text/vtt; charset=utf-8' });
  },

  // Online subtitles (Wyzie) -> WebVTT. The practical CC path: BluRay releases carry
  // only bitmap PGS subs which can never become text tracks. Cached per mount + language.
  ossubs: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!mountAccessOk(ctx, vf)) return send(ctx.res, 404, { error: 'mount not found' });
    const key = effectiveOpenSubsKey();
    // OpenSubtitles (the hash-exact provider) can stand alone — don't 503 just because Wyzie is
    // unset. getVariants tolerates an empty Wyzie set and still runs the OpenSubtitles search.
    if (!key && !effectiveOpenSubtitles()) return send(ctx.res, 503, { error: 'No subtitle provider configured (Settings -> Catalog)' });
    vf._touched = Date.now();
    const lang = String(ctx.url.searchParams.get('lang') || 'en').slice(0, 5).replace(/[^a-z-]/gi, '');
    const tmdbId = String(ctx.url.searchParams.get('tmdb') || '').replace(/\D/g, '');
    const imdbRaw = String(ctx.url.searchParams.get('imdb') || ctx.url.searchParams.get('imdbid') || '').trim();
    const imdbId = /^tt\d{5,10}$/i.test(imdbRaw) ? imdbRaw.toLowerCase() : '';
    const wantsList = ctx.url.searchParams.get('list') === '1';
    const variant = String(ctx.url.searchParams.get('variant') || '').replace(/[^a-z0-9_.:-]/gi, '').slice(0, 80);
    const shift = Math.max(-120, Math.min(120, Number(ctx.url.searchParams.get('shift') || 0) || 0));
    // The player tells us exactly which episode it is playing. Forwarding it makes the episode the
    // authoritative subtitle filter instead of relying on SxxExx surviving inside the remembered
    // query string (vf._subQuery) — a play route that dropped it used to search the whole show,
    // which read as wrong-episode dialogue + a wall of mixed-episode rows.
    const seasonParam = parseInt(ctx.url.searchParams.get('season'), 10);
    const epRaw = ctx.url.searchParams.get('episode');
    const episodeParam = parseInt(epRaw != null ? epRaw : ctx.url.searchParams.get('ep'), 10);
    const hasEpisode = Number.isInteger(seasonParam) && seasonParam > 0 && Number.isInteger(episodeParam) && episodeParam > 0;
    // Caption style preference: 'avoid' (default) prefers clean dialogue-only; 'prefer' favors SDH
    // (sound descriptions for the hard of hearing); 'either' is neutral. Only nudges the auto-pick
    // and list order between otherwise-comparable subtitles.
    const sdhRaw = String(ctx.url.searchParams.get('sdh') || '').toLowerCase();
    const sdhPref = sdhRaw === 'prefer' || sdhRaw === 'avoid' || sdhRaw === 'either' ? sdhRaw : 'avoid';
    const base = process.env.WYZIE_BASE || undefined;
    const releaseName = subtitleReleaseName(vf) || vf.name;
    const subOpts = {
      key, tmdbId, imdbId, query: vf._subQuery || vf._q || releaseName || vf.name, lang, releaseName,
      durationSeconds: vf._tracks && vf._tracks.duration,
      ...(hasEpisode ? { season: seasonParam, episode: episodeParam } : {}),
      attempts: 3, retryDelayMs: 900,
      ...(base ? { base } : {}),
    };
    vf._osCache = vf._osCache || new Map();
    vf._osInflight = vf._osInflight || new Map();
    vf._osSearchCache = vf._osSearchCache || new Map();
    vf._osSearchInflight = vf._osSearchInflight || new Map();
    vf._subSyncState = vf._subSyncState || new Map(); // cacheKey -> looksSynced (skip alass when true)
    const catalogId = imdbId || tmdbId;
    const searchKey = `${lang}:${catalogId}${hasEpisode ? `:s${seasonParam}e${episodeParam}` : ''}`;
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
          // Query Wyzie and OpenSubtitles in parallel, then rank the COMBINED set in one pass
          // (rankSubs gives moviehash-matched OpenSubtitles hits a decisive boost). OpenSubtitles
          // is gated/best-effort, so when it is unconfigured `os` is [] and this is identical to
          // the prior Wyzie-only behavior — including throwing Wyzie's no-subtitles error.
          const work = (async () => {
            let wyData = [];
            let wyErr = null;
            try { wyData = await searchOnlineSubs(subOpts); } catch (e) { wyErr = e; }
            const osData = await openSubtitlesVariantsForMount(vf, { imdbId, tmdbId, lang,
              ...(hasEpisode ? { season: seasonParam, episode: episodeParam } : {}) });
            const combined = [...(Array.isArray(wyData) ? wyData : []), ...osData];
            if (!combined.length) throw (wyErr || new Error('online subtitles failed'));
            const ranked = rankSubs(combined, releaseName, { durationSeconds: vf._tracks && vf._tracks.duration, sdhPref });
            // Trim wrong-episode / non-text rows so the menu only advertises subtitles that can
            // actually play for this file (the "House shows many options but most don't work" fix).
            const variants = usableVariants(ranked, { releaseName }).slice(0, 12);
            vf._osSearchCache.set(searchKey, variants); capMap(vf._osSearchCache, 8);
            return variants;
          })().finally(() => vf._osSearchInflight.delete(searchKey));
          vf._osSearchInflight.set(searchKey, work);
        }
        await vf._osSearchInflight.get(searchKey);
      }
      return vf._osSearchCache.get(searchKey) || [];
    };
    if (wantsList) {
      try {
        const variants = await getVariants();
        // Collapse interchangeable duplicates for DISPLAY (Wyzie mirrors return dozens of identical
        // English SRTs). The full `variants` set is still cached for download fallback below.
        const menu = distinctVariants(variants);
        return send(ctx.res, 200, {
          lang,
          selectedId: (menu.find((v) => v.selected) || menu[0] || {}).id || null,
          variants: menu.map((v) => ({
            id: v.id, label: v.label, display: v.display, language: v.language,
            format: v.format, hearingImpaired: v.hearingImpaired, forced: !!v.forced, score: v.score, selected: !!v.selected,
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
          const osCfg = effectiveOpenSubtitles();
          // Download a chosen OpenSubtitles variant via its /download flow (JWT + quota). One
          // re-login retry covers an expired token.
          const downloadOpenSubtitles = async (fileId) => {
            const tok = await osBearer(osCfg);
            // ASS/SSA must go through the real converter; srtToVtt would emit `Dialogue:`/`{\an8}`
            // codes verbatim. Everything else keeps the SRT->VTT path. langHint fixes encoding.
            const toVtt = (r) => (/^(ass|ssa)$/i.test(String(r.ext || '')) ? releaseSubtitleToVtt(r.raw, r.ext, lang) : r.vtt);
            try {
              return toVtt(await osDownloadVtt(fileId, { apiKey: osCfg.apiKey, token: tok.token, base: tok.baseUrl, langHint: lang }));
            } catch (e) {
              if (/HTTP 401|HTTP 403/.test(String(e && e.message))) {
                const fresh = await osBearer(osCfg, { force: true });
                return toVtt(await osDownloadVtt(fileId, { apiKey: osCfg.apiKey, token: fresh.token, base: fresh.baseUrl, langHint: lang }));
              }
              throw e;
            }
          };
          // Both auto-pick and explicit-variant go through the ranked list so we always know the
          // chosen subtitle's metadata — that's what tells us whether it's ALREADY in sync
          // (release/hash match) and lets the auto-sync step skip alass when no sync is needed.
          const variants = await getVariants();
          // Auto-select safety: never silently serve a confirmed wrong-episode sub. If the user
          // did NOT pick a specific version and nothing in the list is a confident match for this
          // file (right episode or generic), treat it as a clean no-subtitles miss instead of
          // feeding the wrong episode's dialogue. Explicit picks bypass this.
          if (!variant && !hasConfidentAutoPick(variants, { releaseName })) {
            const e = new Error('No subtitles found for this title'); e.noSubtitles = true; e.permanent = true; throw e;
          }
          const chosen = variant ? variants.find((v) => v.id === variant) : variants[0];
          if (!chosen || !chosen.raw) throw new Error(variant ? 'that subtitle version is no longer available' : 'online subtitles failed');
          vf._subSyncState.set(cacheKey, subtitleLooksSynced(chosen.raw, releaseName)); capMap(vf._subSyncState, 24);
          if (chosen.raw._provider === 'opensubtitles') return downloadOpenSubtitles(chosen.raw._osFileId);
          return downloadBestSubtitle(variants.map((v) => v.raw).filter((d) => d && !d._provider), {
            key,
            releaseName,
            durationSeconds: vf._tracks && vf._tracks.duration,
            preferredId: chosen.id,
            ...(base ? { base } : {}),
            attempts: 3,
            retryDelayMs: 900,
          });
        })().then((vtt) => {
          vf._osCache.set(cacheKey, vtt); capMap(vf._osCache, 12);
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
    const looksSynced = vf._subSyncState.get(cacheKey) === true;
    // Sync correction (alass). Two entry points share this:
    //   - automatic: the player re-requests with ?sync=1 in the background when the header below
    //     says 'pending', then hot-swaps the corrected track in.
    //   - manual: the "Fix sync" action also hits ?sync=1.
    // We SKIP alass entirely when the subtitle already looks in sync (release/hash match) — that's
    // the "don't pull the audio when you don't need to" rule. alass reads the audio, so it only
    // runs for subs that aren't already matched, and any failure falls back to the unsynced track.
    if (ctx.url.searchParams.get('sync') === '1' && vtt) {
      if (looksSynced || !detectSubSync()) {
        // Already in sync (or no engine): serve as-is; nothing to correct.
        return send(ctx.res, 200, shift ? shiftVtt(vtt, shift) : vtt,
          { 'content-type': 'text/vtt; charset=utf-8', 'x-triboon-subsync': looksSynced ? 'synced' : 'unavailable' });
      }
      const syncKey = `${cacheKey}:synced`;
      if (!vf._osCache.has(syncKey)) {
        if (!vf._osInflight.has(syncKey)) {
          const work = onDemandSubSync(vf, vtt, ctx.claims.uid)
            .then((synced) => { vf._osCache.set(syncKey, synced); capMap(vf._osCache, 12); return synced; })
            .finally(() => vf._osInflight.delete(syncKey));
          vf._osInflight.set(syncKey, work);
        }
        try { await vf._osInflight.get(syncKey); } catch (e) {
          console.error(`[subsync ${vf.id}] ${String(e && e.message || e).slice(0, 160)}`);
        }
      }
      const synced = vf._osCache.get(syncKey);
      if (synced) return send(ctx.res, 200, shift ? shiftVtt(synced, shift) : synced,
        { 'content-type': 'text/vtt; charset=utf-8', 'x-triboon-subsync': 'corrected' });
    }
    // Tell the player whether an automatic background sync is worth requesting: 'pending' = not a
    // confident match and alass is available; 'synced' = already matched (skip); else 'unavailable'.
    const syncHdr = looksSynced ? 'synced' : (detectSubSync() && vf._subSyncState.has(cacheKey) ? 'pending' : 'unavailable');
    send(ctx.res, 200, shift ? shiftVtt(vtt, shift) : vtt,
      { 'content-type': 'text/vtt; charset=utf-8', 'x-triboon-subsync': syncHdr });
  },

  // Embedded subtitle track → WebVTT. ffmpeg must read the whole stream (subs are interleaved),
  // so this can take a while the first time on a big release; the result is cached per track.
  subtitle: async (ctx) => {
    if (!streamScopeOk(ctx, ctx.m[1])) return send(ctx.res, 401, { error: 'token not valid for this stream' });
    const vf = mounts.get(ctx.m[1]);
    if (!vf) return send(ctx.res, 404, { error: 'mount not found' });
    if (!mountAccessOk(ctx, vf)) return send(ctx.res, 404, { error: 'mount not found' });
    if (!vf.streamable) return send(ctx.res, 409, { error: 'mount is not streamable' });
    if (!detectFfmpeg()) return send(ctx.res, 503, { error: 'ffmpeg not available' });
    vf._touched = Date.now();
    const track = parseInt(ctx.m[2], 10) || 0;
    try {
      const mode = String(ctx.url.searchParams.get('mode') || '').toLowerCase();
      if (mode !== 'prewarm') {
        const waitMs = mode === 'startup' ? embeddedSubtitleStartupWaitMs() : embeddedSubtitleTimeoutMs(mode);
        extendSubtitleResponseTimeout(ctx, waitMs + 15000);
      }
      if (mode === 'prewarm') {
        ensureSubtitleVtt(vf, track, ctx.claims.uid, { mode }).catch((e) => {
          console.error(`[subtitle ${vf.id}:${track}] prewarm failed: ${String(e && e.message || e).slice(0, 200)}`);
        });
        return send(ctx.res, 202, { ok: true, status: 'prewarming' });
      }
      const job = ensureSubtitleVtt(vf, track, ctx.claims.uid, { mode });
      const vtt = mode === 'startup' ? await waitForSubtitleStartup(job, embeddedSubtitleStartupWaitMs()) : await job;
      if (!ctx.res.writableEnded) send(ctx.res, 200, vtt, { 'content-type': 'text/vtt; charset=utf-8' });
    } catch (e) {
      if (e && e.code === 'SUBTITLE_PREPARING') {
        if (!ctx.res.writableEnded) send(ctx.res, 504, { error: 'subtitle still preparing', detail: 'built-in subtitles are still preparing' });
      } else if (!ctx.res.writableEnded) {
        send(ctx.res, 502, { error: 'subtitle extraction failed', detail: String(e.message).slice(0, 200) });
      }
    }
  },

  // ---- Music (YouTube Music via yt-dlp) ----
  musicHome: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    const catalog = !!ytmusic.detectYtMusicApi();
    const chartShelves = await loadMusicChartResponses(ctx.user.id, { wait: false });
    const chartHomeShelves = chartShelves.map((s) => ({
      ...s,
      id: 'top-songs-week',
      title: 'Top songs this week',
    }));
    const shelves = [
      ...musicHomeFeedShelves(),
      ...chartHomeShelves,
    ];
    send(ctx.res, 200, {
      version: 2,
      generatedAt: new Date().toISOString(),
      catalog,
      mode: catalog ? 'catalog' : 'basic',
      chartsPending: chartHomeShelves.length < MUSIC_CHARTS.length,
      order: shelves.map((s) => s.id),
      shelves,
    });
  },
  musicCharts: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    const charts = await loadMusicChartResponses(ctx.user.id);
    send(ctx.res, 200, { charts });
  },
  musicSearch: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    const q = ctx.url.searchParams.get('q') || '';
    const limit = Math.max(1, Math.min(24, parseInt(ctx.url.searchParams.get('limit') || '24', 10) || 24));
    if (!q.trim()) return send(ctx.res, 200, { results: [] });
    try {
      const cookies = cookiesFor(ctx.user.id);
      const results = await loadMusicSearch(q, {
        limit,
        cookiesPath: cookies,
        scope: cookies ? `user:${ctx.user.id}` : 'public',
      });
      // Mint a per-track stream token so the client can build playable URLs without a round-trip.
      send(ctx.res, 200, {
        results: results.map((r) => tokenizedMusicTrack(ctx.user.id, r)),
      });
    } catch (e) { send(ctx.res, 502, { error: 'music search failed', detail: String(e.message).slice(0, 160) }); }
  },
  musicRadio: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    if (!ytmusic.detectYtMusicApi()) return send(ctx.res, 503, { error: 'ytmusicapi is not installed on the server' });
    try {
      const limit = Math.max(1, Math.min(40, parseInt(ctx.url.searchParams.get('limit') || '24', 10) || 24));
      const r = await ytmusic.watchQueue(ctx.m[1], { limit });
      send(ctx.res, 200, {
        playlistId: r.playlistId || null,
        results: (r.tracks || []).map((t) => tokenizedMusicTrack(ctx.user.id, t)),
      });
    } catch (e) { send(ctx.res, 502, { error: 'music radio failed', detail: String(e.message).slice(0, 160) }); }
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
    const s = settings.get();
    const oauthLinked = !!ytOauthToken(ctx.user.id, s);
    const accountLinked = !!((s.ytCookies || {})[ctx.user.id]);
    const serverLinked = !oauthLinked && !accountLinked && !!cookiesFor(null);
    const oauthIssue = (s.ytOAuthIssues || {})[ctx.user.id] || null;
    const cookieIssue = (s.ytCookieIssues || {})[ctx.user.id] || null;
    const issue = oauthLinked ? oauthIssue : cookieIssue;
    const ytdlp = ytmusic.detectYtdlp();
    const catalog = ytmusic.detectYtMusicApi();
    const oauthClient = ytOauthClient(s);
    send(ctx.res, 200, {
      ytdlp: !!ytdlp,
      ytdlpVersion: ytdlp ? ytdlp.version || null : null,
      catalog: !!catalog,
      catalogVersion: catalog ? catalog.version || null : null,
      oauthConfigured: !!oauthClient,
      oauthAvailable: !!(oauthClient && catalog),
      linked: oauthLinked || accountLinked || serverLinked,
      linkSource: oauthLinked ? 'oauth' : (accountLinked ? 'account' : (serverLinked ? 'server' : 'none')),
      needsRelink: !!((oauthLinked || accountLinked) && issue),
      linkIssue: (oauthLinked || accountLinked) && issue ? { at: issue.at || 0, message: String(issue.message || '').slice(0, 160) } : null,
    });
  },
  musicOAuthStart: async (ctx) => {
    if (!ytmusic.detectYtMusicApi()) return send(ctx.res, 503, { error: 'ytmusicapi is not installed on the server' });
    const client = ytOauthClient();
    if (!client) return send(ctx.res, 400, { error: 'YouTube Music OAuth app is not configured yet' });
    try {
      const r = await ytmusic.beginOAuth(client);
      if (!r.deviceCode || !r.userCode) return send(ctx.res, 502, { error: 'YouTube Music OAuth returned no device code' });
      ytOauthPending.set(ctx.user.id, {
        deviceCode: r.deviceCode,
        expiresAt: Date.now() + r.expiresIn * 1000,
        intervalMs: r.interval * 1000,
      });
      send(ctx.res, 200, {
        status: 'pending',
        userCode: r.userCode,
        verificationUrl: r.verificationUrl,
        verificationUrlComplete: r.verificationUrlComplete,
        expiresIn: r.expiresIn,
        intervalMs: r.interval * 1000,
      });
    } catch (e) { send(ctx.res, 502, { error: 'YouTube Music OAuth failed to start', detail: String(e.message).slice(0, 160) }); }
  },
  musicOAuthPoll: async (ctx) => {
    if (!ytmusic.detectYtMusicApi()) return send(ctx.res, 503, { error: 'ytmusicapi is not installed on the server' });
    const pending = ytOauthPending.get(ctx.user.id);
    if (!pending) return send(ctx.res, 404, { error: 'No YouTube Music sign-in is waiting' });
    if (Date.now() > pending.expiresAt) {
      ytOauthPending.delete(ctx.user.id);
      return send(ctx.res, 410, { error: 'YouTube Music sign-in code expired' });
    }
    const client = ytOauthClient();
    if (!client) return send(ctx.res, 400, { error: 'YouTube Music OAuth app is not configured yet' });
    try {
      const token = await ytmusic.completeOAuth({ ...client, deviceCode: pending.deviceCode });
      ytOauthPending.delete(ctx.user.id);
      settings.update((s) => {
        const cookies = { ...(s.ytCookies || {}) }; delete cookies[ctx.user.id];
        const cIssues = { ...(s.ytCookieIssues || {}) }; delete cIssues[ctx.user.id];
        const oIssues = { ...(s.ytOAuthIssues || {}) }; delete oIssues[ctx.user.id];
        return {
          ...s,
          ytCookies: cookies,
          ytCookieIssues: cIssues,
          ytOAuthTokens: { ...(s.ytOAuthTokens || {}), [ctx.user.id]: token },
          ytOAuthIssues: oIssues,
        };
      });
      clearMusicPlaylistCaches(ctx.user.id);
      dropCookieFile(ctx.user.id);
      send(ctx.res, 200, { status: 'linked', linked: true });
    } catch (e) {
      if (e.code === 'authorization_pending') return send(ctx.res, 200, { status: 'pending', intervalMs: pending.intervalMs });
      if (e.code === 'slow_down') {
        pending.intervalMs = Math.min(15000, pending.intervalMs + 5000);
        return send(ctx.res, 200, { status: 'pending', intervalMs: pending.intervalMs });
      }
      if (e.code === 'expired_token' || e.code === 'access_denied') ytOauthPending.delete(ctx.user.id);
      const status = e.code === 'expired_token' ? 410 : (e.code === 'access_denied' ? 403 : 502);
      send(ctx.res, status, { error: 'YouTube Music sign-in failed', detail: String(e.message).slice(0, 160) });
    }
  },

  // Paste an exported cookies.txt (Netscape format, from music.youtube.com while signed in).
  musicLink: async (ctx) => {
    const b = await readJson(ctx.req);
    const text = String(b.cookies || '').replace(/\r/g, '').slice(0, 256 * 1024);
    // Sanity: must be a Netscape cookie file that actually carries YouTube cookies.
    if (!/(^|\n)\S*\.?youtube\.com\t/i.test(text) && !/youtube\.com/i.test(text.split('\n').find((l) => !l.startsWith('#')) || '')) {
      return send(ctx.res, 400, { error: 'that does not look like a cookies.txt with youtube.com cookies — export it from music.youtube.com while signed in' });
    }
    settings.update((s) => {
      const issues = { ...(s.ytCookieIssues || {}) }; delete issues[ctx.user.id];
      const oauth = { ...(s.ytOAuthTokens || {}) }; delete oauth[ctx.user.id];
      const oauthIssues = { ...(s.ytOAuthIssues || {}) }; delete oauthIssues[ctx.user.id];
      return { ...s, ytCookies: { ...(s.ytCookies || {}), [ctx.user.id]: text }, ytCookieIssues: issues, ytOAuthTokens: oauth, ytOAuthIssues: oauthIssues };
    });
    clearMusicPlaylistCaches(ctx.user.id);
    dropCookieFile(ctx.user.id); // re-materialize with the fresh text on next use
    send(ctx.res, 200, { linked: true });
  },
  musicUnlink: async (ctx) => {
    settings.update((s) => {
      const all = { ...(s.ytCookies || {}) }; delete all[ctx.user.id];
      const issues = { ...(s.ytCookieIssues || {}) }; delete issues[ctx.user.id];
      const oauth = { ...(s.ytOAuthTokens || {}) }; delete oauth[ctx.user.id];
      const oauthIssues = { ...(s.ytOAuthIssues || {}) }; delete oauthIssues[ctx.user.id];
      return { ...s, ytCookies: all, ytCookieIssues: issues, ytOAuthTokens: oauth, ytOAuthIssues: oauthIssues };
    });
    ytOauthPending.delete(ctx.user.id);
    clearMusicPlaylistCaches(ctx.user.id);
    dropCookieFile(ctx.user.id);
    send(ctx.res, 200, { linked: false });
  },

  // The user's own playlists (chips on the Music page). Honest errors — cookies can expire.
  musicPlaylists: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    let oauth = null;
    try { oauth = await ytmusicOauthFor(ctx.user.id); } catch (e) {
      settings.update((s) => ({
        ...s,
        ytOAuthIssues: { ...(s.ytOAuthIssues || {}), [ctx.user.id]: { at: Date.now(), message: String(e.message || e).slice(0, 160) } },
      }));
    }
    const cookies = oauth ? null : cookiesFor(ctx.user.id);
    if (!oauth && !cookies) return send(ctx.res, 200, { linked: false, playlists: [] });
    try {
      const source = oauth ? 'oauth' : 'account';
      const playlists = await loadUserMusicPlaylists(ctx.user.id, source, () => ytmusic.listPlaylists({
        cookiesPath: cookies,
        oauthToken: oauth && oauth.token,
        oauthClientId: oauth && oauth.client.clientId,
        oauthClientSecret: oauth && oauth.client.clientSecret,
        limit: MUSIC_PLAYLIST_LIST_LIMIT,
      }));
      clearYtmIssue(ctx.user.id, oauth ? 'oauth' : 'cookie');
      send(ctx.res, 200, { linked: true, linkSource: source, playlists });
    } catch (e) {
      if (oauth) {
        settings.update((s) => ({
          ...s,
          ytOAuthIssues: { ...(s.ytOAuthIssues || {}), [ctx.user.id]: { at: Date.now(), message: String(e.message || e).slice(0, 160) } },
        }));
      } else if ((settings.get().ytCookies || {})[ctx.user.id]) {
        settings.update((s) => ({
          ...s,
          ytCookieIssues: { ...(s.ytCookieIssues || {}), [ctx.user.id]: { at: Date.now(), message: String(e.message || e).slice(0, 160) } },
        }));
      }
      send(ctx.res, 502, { error: 'could not load your playlists — the link may have expired (re-export cookies in Preferences)', detail: String(e.message).slice(0, 160) });
    }
  },
  musicPlaylist: async (ctx) => {
    if (!ytmusic.detectYtdlp()) return send(ctx.res, 503, { error: 'yt-dlp is not installed on the server' });
    try {
      const limit = Math.max(1, Math.min(100, parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50));
      const offset = Math.max(0, parseInt(ctx.url.searchParams.get('offset') || '0', 10) || 0);
      let oauth = null;
      try { oauth = await ytmusicOauthFor(ctx.user.id); } catch { oauth = null; }
      const r = await ytmusic.playlistTracks(ctx.m[1], {
        cookiesPath: oauth ? null : cookiesFor(ctx.user.id),
        oauthToken: oauth && oauth.token,
        oauthClientId: oauth && oauth.client.clientId,
        oauthClientSecret: oauth && oauth.client.clientSecret,
        limit: limit + 1,
        offset,
      });
      const tracks = r.tracks.slice(0, limit);
      const hasMore = r.tracks.length > limit;
      send(ctx.res, 200, {
        title: r.title,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? offset + tracks.length : null,
        results: tracks.map((t) => tokenizedMusicTrack(ctx.user.id, t)),
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
function embeddedSubtitleTimeoutMs(mode = '') {
  const configured = parseInt(process.env.TRIBOON_EMBEDDED_SUB_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured > 0) return Math.max(15000, Math.min(120000, configured));
  return 120000;
}
function embeddedSubtitleStartupWaitMs() {
  const configured = parseInt(process.env.TRIBOON_EMBEDDED_SUB_STARTUP_WAIT_MS || '', 10);
  if (Number.isFinite(configured) && configured > 0) return Math.max(2000, Math.min(30000, configured));
  return 8000;
}
function extendSubtitleResponseTimeout(ctx, ms) {
  const timeoutMs = Math.max(30000, Math.min(180000, parseInt(ms, 10) || 30000));
  const socket = ctx.req && ctx.req.socket;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { if (socket && !socket.destroyed) socket.setTimeout(30000); } catch {}
  };
  try { if (ctx.req && typeof ctx.req.setTimeout === 'function') ctx.req.setTimeout(timeoutMs); } catch {}
  try { if (ctx.res && typeof ctx.res.setTimeout === 'function') ctx.res.setTimeout(timeoutMs); } catch {}
  try { if (socket && typeof socket.setTimeout === 'function') socket.setTimeout(timeoutMs); } catch {}
  try { ctx.res.once('finish', restore); ctx.res.once('close', restore); } catch {}
}
function subtitleVttHasCues(vtt) {
  return /(?:^|\n)\s*(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}/.test(String(vtt || ''));
}
const SUBTITLE_FAILURE_TTL_MS = 10 * 60000;
function recentSubtitleFailure(vf, track) {
  const hit = vf && vf._subFailures && vf._subFailures.get(track);
  if (!hit) return null;
  if (Date.now() - (hit.at || 0) > SUBTITLE_FAILURE_TTL_MS) {
    try { vf._subFailures.delete(track); } catch {}
    return null;
  }
  return hit;
}
function waitForSubtitleStartup(job, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      const e = new Error('embedded subtitle still preparing');
      e.code = 'SUBTITLE_PREPARING';
      finish(reject, e);
    }, ms);
    job.then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}
function ensureSubtitleVtt(vf, track, uid, opts = {}) {
  vf._subCache = vf._subCache || new Map();
  if (vf._subCache.has(track)) return Promise.resolve(vf._subCache.get(track));
  vf._subFailures = vf._subFailures || new Map();
  if (opts.mode === 'manual') vf._subFailures.delete(track);
  const recentFailure = opts.mode === 'startup' ? recentSubtitleFailure(vf, track) : null;
  if (recentFailure) return Promise.reject(new Error(recentFailure.message || 'embedded subtitle extraction recently failed'));
  vf._subJobs = vf._subJobs || new Map();
  if (vf._subJobs.has(track)) return vf._subJobs.get(track);
  const selfUrl = `http://127.0.0.1:${server.address().port}/api/stream/${vf.id}?t=${auth.streamToken(uid, vf.id)}&priority=background`;
  const timeoutMs = embeddedSubtitleTimeoutMs(opts.mode);
  const job = new Promise((resolve, reject) => {
    let ff; let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      fn(value);
    };
    const fail = (value) => {
      const e = value instanceof Error ? value : new Error(String(value || 'embedded subtitle extraction failed'));
      vf._subFailures.set(track, { at: Date.now(), message: String(e.message || e).slice(0, 200) });
      finish(reject, e);
    };
    try { ff = spawnSubtitleExtract(selfUrl, track); } catch (e) { return fail(e); }
    const chunks = []; let err = '';
    const killer = setTimeout(() => {
      try { ff.kill('SIGKILL'); } catch {}
      fail(new Error(`embedded subtitle extraction timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    ff.on('error', (e) => fail(e));
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { if (err.length < 8000) err += d; }); // cap: ffmpeg streams stderr for the whole playback
    ff.on('close', (codeNum) => {
      const vtt = Buffer.concat(chunks).toString('utf8');
      if (codeNum || !vtt.startsWith('WEBVTT')) return fail(new Error(err.slice(0, 200) || `ffmpeg exit ${codeNum}`));
      if (!subtitleVttHasCues(vtt)) return fail(new Error('embedded subtitle extraction returned no text cues'));
      vf._subFailures.delete(track);
      if (vf._subCache.size < 8) vf._subCache.set(track, vtt);
      finish(resolve, vtt);
    });
  }).finally(() => vf._subJobs.delete(track));
  vf._subJobs.set(track, job);
  job.catch(() => {}); // prefetch callers may not attach a handler — never an unhandled rejection
  return job;
}

// ---------- route table (deny by default; every route DECLARES auth) ----------
const ROUTES = [
  { m: 'GET', re: /^\/api\/server$/, auth: 'public', h: H.server },
  { m: 'GET', re: /^\/api\/auth-art$/, auth: 'public', h: H.authArt },
  { m: 'POST', re: /^\/api\/setup$/, auth: 'public', h: H.setup },
  { m: 'POST', re: /^\/api\/login$/, auth: 'public', h: H.login },
  { m: 'POST', re: /^\/api\/login\/2fa$/, auth: 'public', h: H.login2fa },
  { m: 'POST', re: /^\/api\/invite\/accept$/, auth: 'public', h: H.inviteAccept },
  { m: 'POST', re: /^\/api\/quickconnect$/, auth: 'public', h: H.qcCreate },
  { m: 'GET', re: /^\/api\/quickconnect\/(\d{6})$/, auth: 'public', h: H.qcPoll },
  { m: 'POST', re: /^\/api\/quickconnect\/(\d{6})\/approve$/, auth: 'user', h: H.qcApprove },
  { m: 'GET', re: /^\/api\/me$/, auth: 'user', h: H.me },
  { m: 'GET', re: /^\/api\/me\/security$/, auth: 'user', h: H.meSecurity },
  { m: 'GET', re: /^\/api\/app\/latest$/, auth: 'user', h: H.appLatest },
  { m: 'POST', re: /^\/api\/me\/password$/, auth: 'user', h: H.password },
  { m: 'POST', re: /^\/api\/me\/totp\/setup$/, auth: 'admin', h: H.totpSetup },
  { m: 'POST', re: /^\/api\/me\/totp\/enable$/, auth: 'admin', h: H.totpEnable },
  { m: 'POST', re: /^\/api\/me\/totp\/disable$/, auth: 'admin', h: H.totpDisable },
  { m: 'POST', re: /^\/api\/me\/totp\/recovery$/, auth: 'admin', h: H.totpRecovery },
  { m: 'POST', re: /^\/api\/me\/profiles$/, auth: 'user', h: H.profileAdd },
  { m: 'PATCH', re: /^\/api\/me\/profiles\/(\w+)$/, auth: 'user', h: H.profileEdit },
  { m: 'POST', re: /^\/api\/me\/profiles\/(\w+)\/delete$/, auth: 'user', h: H.profileDelete },
  { m: 'POST', re: /^\/api\/me\/profiles\/(\w+)\/verify$/, auth: 'user', h: H.profileVerifyPin },
  { m: 'POST', re: /^\/api\/me\/profiles\/(\w+)\/pin$/, auth: 'user', h: H.profileSetPin },
  { m: 'GET', re: /^\/api\/me\/iptv\/sources$/, auth: 'user', h: H.myIptvSourcesList },
  { m: 'POST', re: /^\/api\/me\/iptv\/sources$/, auth: 'user', h: H.myIptvSourceCreate },
  { m: 'PATCH', re: /^\/api\/me\/iptv\/sources\/([\w-]+)$/, auth: 'user', h: H.myIptvSourceUpdate },
  { m: 'DELETE', re: /^\/api\/me\/iptv\/sources\/([\w-]+)$/, auth: 'user', h: H.myIptvSourceDelete },
  { m: 'POST', re: /^\/api\/watch\/bulk$/, auth: 'user', h: H.watchBulk },
  { m: 'GET', re: /^\/api\/me\/prefs$/, auth: 'user', h: H.prefsGet },
  { m: 'POST', re: /^\/api\/me\/prefs$/, auth: 'user', h: H.prefsSet },
  { m: 'GET', re: /^\/api\/status$/, auth: 'user', h: H.status },
  { m: 'GET', re: /^\/api\/search$/, auth: 'user', h: H.search },
  { m: 'POST', re: /^\/api\/play$/, auth: 'user', h: H.play },
  { m: 'POST', re: /^\/api\/prepare$/, auth: 'user', h: H.prepare },
  { m: 'POST', re: /^\/api\/advance\/(\w+)$/, auth: 'user', h: H.advance },
  { m: 'GET', re: /^\/api\/tmdb\/(.+)$/, auth: 'user', h: H.tmdbProxy },
  { m: 'GET', re: /^\/api\/libraries$/, auth: 'user', h: H.librariesList },
  { m: 'GET', re: /^\/api\/libraries\/local-lookup$/, auth: 'user', h: H.localLookup },
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
  { m: 'PATCH', re: /^\/api\/iptv\/sources\/([\w-]+)$/, auth: 'admin', h: H.iptvSourceUpdate },
  { m: 'DELETE', re: /^\/api\/iptv\/sources\/([\w-]+)$/, auth: 'admin', h: H.iptvSourceDelete },
  { m: 'GET', re: /^\/api\/iptv\/status$/, auth: 'admin', h: H.iptvSyncStatus },
  { m: 'POST', re: /^\/api\/iptv\/refresh$/, auth: 'admin', h: H.iptvSyncRefresh },
  { m: 'GET', re: /^\/api\/iptv\/channels$/, auth: 'user', h: H.iptvChannels },
  { m: 'GET', re: /^\/api\/iptv\/play\/(\d+)$/, auth: 'user', h: H.iptvPlay },
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
  { m: 'GET', re: /^\/api\/activity$/, auth: 'admin', h: H.activityList },
  { m: 'POST', re: /^\/api\/activity$/, auth: 'user', h: H.activitySet },
  { m: 'POST', re: /^\/api\/presence$/, auth: 'user', h: H.presenceSet },
  { m: 'GET', re: /^\/api\/trakt\/status$/, auth: 'user', h: H.traktStatus },
  { m: 'POST', re: /^\/api\/trakt\/link$/, auth: 'user', h: H.traktLink },
  { m: 'POST', re: /^\/api\/trakt\/poll$/, auth: 'user', h: H.traktPoll },
  { m: 'POST', re: /^\/api\/trakt\/exchange$/, auth: 'user', h: H.traktExchange },
  { m: 'POST', re: /^\/api\/trakt\/unlink$/, auth: 'user', h: H.traktUnlink },
  { m: 'POST', re: /^\/api\/trakt\/pull$/, auth: 'user', h: H.traktPull },
  { m: 'POST', re: /^\/api\/trakt\/sync$/, auth: 'user', h: H.traktSync },
  { m: 'GET', re: /^\/api\/music\/home$/, auth: 'user', h: H.musicHome },
  { m: 'GET', re: /^\/api\/music\/charts$/, auth: 'user', h: H.musicCharts },
  { m: 'GET', re: /^\/api\/music\/search$/, auth: 'user', h: H.musicSearch },
  { m: 'GET', re: /^\/api\/music\/radio\/([\w-]{11})$/, auth: 'user', h: H.musicRadio },
  { m: 'GET', re: /^\/api\/music\/stream\/([\w-]{11})$/, auth: 'stream', h: H.musicStream },
  { m: 'GET', re: /^\/api\/music\/status$/, auth: 'user', h: H.musicStatus },
  { m: 'POST', re: /^\/api\/music\/oauth\/start$/, auth: 'user', h: H.musicOAuthStart },
  { m: 'POST', re: /^\/api\/music\/oauth\/poll$/, auth: 'user', h: H.musicOAuthPoll },
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
  { m: 'POST', re: /^\/api\/test\/provider-speed$/, auth: 'admin', h: H.testProviderSpeed },
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
  { m: 'GET', re: /^\/api\/releasesub\/(\w+)\/([a-z0-9_-]+)$/, auth: 'stream', h: H.releasesub },
  { m: 'GET', re: /^\/api\/ossubs\/(\w+)$/, auth: 'stream', h: H.ossubs },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const server = http.createServer(async (req, res) => {
  res.shouldKeepAlive = false;
  let abortedClosed = false;
  const closeAbortedRequest = () => {
    if (abortedClosed) return;
    abortedClosed = true;
    try { if (req.socket && !req.socket.destroyed) req.socket.destroy(); } catch {}
    try { req.destroy(); } catch {}
    try { if (!res.destroyed) res.destroy(); } catch {}
  };
  req.on('aborted', closeAbortedRequest);
  req.on('close', () => {
    if (!req.complete && !res.writableEnded) closeAbortedRequest();
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      try { if (req.socket && !req.socket.destroyed) req.socket.destroy(); } catch {}
    }
  });
  res.on('error', () => {});
  res._acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
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
        const token = bearer(req, url, route.auth === 'stream');
        const claims = auth.verifyToken(token, route.auth === 'stream' ? 'stream' : 'session')
          || (route.auth === 'stream' ? auth.verifyToken(token, 'session') : null);
        if (!claims) return reject(401, { error: 'authentication required' });
        ctx.claims = claims;
        ctx.user = auth.getUser(claims.uid);
        if (!ctx.user) return reject(401, { error: 'unknown user' });
        if (!auth.claimsValidForUser(claims, ctx.user)) return reject(401, { error: 'session expired' });
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
    if (e && e.status === 499) {
      try { if (req.socket && !req.socket.destroyed) req.socket.destroy(); } catch {}
      try { req.destroy(); } catch {}
      try { if (!res.destroyed) res.destroy(); } catch {}
      return;
    }
    // Errors that carry an explicit status are intentional client-facing messages; anything
    // else is internal — log it fully here, return a generic line (no paths/URLs/creds).
    if (!res.headersSent) {
      if (!e.status) console.error('[500]', p, e.message);
      return send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
    }
    try { res.end(); } catch {}
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.timeout = 30000;
server.maxRequestsPerSocket = 1;
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch {}
});

// ---------- housekeeping sweep ----------
// Mounts hold a segment map (can be tens of MB for a big release) and were historically kept
// until restart — a household browsing for weeks would leak serious memory. Evict mounts idle
// past the TTL (or oldest-idle beyond the cap), drop their live-mount reuse entries, expire
// old play sessions, and purge expired Quick Connect codes.
const MOUNT_IDLE_MS = 45 * 60000;   // idle = no stream/remux/tracks/subtitle touch
const MOUNT_CAP = 16;
function sweep(now = Date.now()) {
  const evicted = [];
  const protectedIds = sessionProtectedMountIds(now);
  const idle = [...mounts.values()].filter((vf) =>
    !protectedIds.has(vf.id) && now - (vf._touched || vf.mountedAt || 0) > MOUNT_IDLE_MS);
  for (const vf of idle) { mounts.delete(vf.id); evicted.push(vf.id); }
  if (mounts.size > MOUNT_CAP) {
    const removable = [...mounts.values()]
      .filter((vf) => !protectedIds.has(vf.id))
      .sort((a, b) => ((a._touched || a.mountedAt || 0) - (b._touched || b.mountedAt || 0)));
    let overflow = mounts.size - MOUNT_CAP;
    for (const vf of removable) {
      if (overflow <= 0) break;
      mounts.delete(vf.id);
      evicted.push(vf.id);
      overflow--;
    }
  }
  for (const [url, id] of pipeline.mountByUrl) if (!mounts.has(id)) pipeline.mountByUrl.delete(url);
  for (const [id, s] of pipeline.sessions) if (now - (s.createdAt || 0) > SESSION_TTL_MS) pipeline.sessions.delete(id);
  // Activity/presence are otherwise pruned only when an admin polls /api/activity — collect stale
  // rows here too so the maps can't accumulate on a server whose admin never opens the screen.
  for (const [id, row] of activitySessions) if (now - ((row && row.updatedAt) || 0) > ACTIVITY_TTL_MS) activitySessions.delete(id);
  for (const [key, row] of presenceSessions) if (now - ((row && row.lastSeen) || 0) > PRESENCE_TTL_MS) presenceSessions.delete(key);
  if (evicted.length) pipeline.rebalancePlaybackWindows(now);
  auth.sweepQuickConnect();
  if (evicted.length) console.log(`[sweep] evicted ${evicted.length} idle mount(s), ${mounts.size} live`);
  return evicted;
}
// A throw inside setInterval is an uncaughtException — it would take down every live stream.
const sweepTimer = setInterval(() => { try { sweep(); } catch (e) { console.error('[sweep]', e.message); } }, 5 * 60000);
sweepTimer.unref();

if (require.main === module) {
  // Last-resort blast-radius guard (production only — tests import the module and must still surface
  // real errors). A single stray stream/socket 'error' event or rejected probe must NEVER crash the
  // whole process and 502 every other user's playback. Real fixes live at the source; this keeps the
  // box serving and logs the full stack so genuine bugs stay visible.
  process.on('uncaughtException', (e) => { console.error('[uncaught]', (e && e.stack) || e); });
  process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', (e && e.stack) || e); });
  server.listen(PORT, () => {
    console.log(`Triboon → http://localhost:${PORT}`);
    try { getPool(); } catch { /* no provider configured yet — fine */ }
    // Startup should stay responsive first. Stale Live TV caches are served instantly on demand;
    // the heavy network refresh can begin after login/playback/TV navigation have settled.
    scheduleIptvWarmSoon('startup', IPTV_STARTUP_WARM_DELAY_MS, { skipGuide: true });
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
  clearPendingIptvWarmSoon();
  if (iptvWarmTimer) clearTimeout(iptvWarmTimer);
  iptvWarmTimer = null;
  iptvWarmNextAt = 0;
  closeAllIptvLiveStreams('shutdown');
  cleanupYtCookieFiles();
  if (pool) { pool.close(); pool = null; }
  libraryDb.close();
  store.close();
  return new Promise((r) => server.close(r));
}

module.exports = { server, mounts, pipeline, getPool, shutdown, sweep, ROUTES, auth, settings, store, warmIptvCaches, msUntilNextIptvWarm };

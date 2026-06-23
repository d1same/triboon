'use strict';
// YouTube Music backend via yt-dlp — search + audio-stream resolution, stdlib only (we shell
// out to yt-dlp exactly like the rest of the server shells out to ffmpeg). The player UI is
// native Triboon; yt-dlp carries the YouTube cat-and-mouse so we don't have to.
//
// Why a server proxy for audio (not a direct browser → googlevideo link):
//   - resolved googlevideo URLs are IP-LOCKED to the host that asked yt-dlp (our server),
//   - they EXPIRE after a few hours,
//   - same-origin keeps our stream-token auth working and dodges CORS.
// So the browser plays /api/music/stream/<id>?t=… and we Range-proxy the bytes.

const { spawn, spawnSync } = require('child_process');
const https = require('https');
const YTDLP_CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.TRIBOON_YTDLP_CONCURRENCY || '2', 10) || 2));
const YTMUSICAPI_CONCURRENCY = Math.max(1, Math.min(3, parseInt(process.env.TRIBOON_YTMUSICAPI_CONCURRENCY || '2', 10) || 2));
const PLAYLIST_LIST_LIMIT = Math.max(12, Math.min(60, parseInt(process.env.TRIBOON_MUSIC_PLAYLIST_LIST_LIMIT || '36', 10) || 36));
const YTMUSIC_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube';
const YTMUSIC_OAUTH_CODE_URL = 'https://www.youtube.com/o/oauth2/device/code';
const YTMUSIC_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YTMUSIC_OAUTH_GRANT = 'http://oauth.net/grant_type/device/1.0';
const YTMUSIC_OAUTH_UA = 'Mozilla/5.0 Triboon/1.0 Cobalt/Version';
let ytdlpActive = 0;
const ytdlpQueue = [];
let ytdlpSeq = 0;
let ytmApiActive = 0;
const ytmApiQueue = [];
let ytmApiSeq = 0;
let _oauthPostForTest = null;

function pumpYtdlpQueue() {
  while (ytdlpActive < YTDLP_CONCURRENCY && ytdlpQueue.length) {
    const job = ytdlpQueue.shift();
    ytdlpActive++;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        ytdlpActive--;
        pumpYtdlpQueue();
      });
  }
}
function withYtdlpSlot(fn, { priority = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const job = { fn, resolve, reject, priority: Number(priority) || 0, seq: ++ytdlpSeq };
    const idx = ytdlpQueue.findIndex((j) => job.priority > j.priority);
    if (idx >= 0) ytdlpQueue.splice(idx, 0, job);
    else ytdlpQueue.push(job);
    pumpYtdlpQueue();
  });
}
function pumpYtmApiQueue() {
  while (ytmApiActive < YTMUSICAPI_CONCURRENCY && ytmApiQueue.length) {
    const job = ytmApiQueue.shift();
    ytmApiActive++;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        ytmApiActive--;
        pumpYtmApiQueue();
      });
  }
}
function withYtmApiSlot(fn, { priority = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const job = { fn, resolve, reject, priority: Number(priority) || 0, seq: ++ytmApiSeq };
    const idx = ytmApiQueue.findIndex((j) => job.priority > j.priority);
    if (idx >= 0) ytmApiQueue.splice(idx, 0, job);
    else ytmApiQueue.push(job);
    pumpYtmApiQueue();
  });
}

// Detection mirrors detectFfmpeg: env override → a `yt-dlp` binary on PATH → the pip module
// (`python -m yt_dlp`), so it works whether yt-dlp is a standalone exe or a pip install.
let _ytdlp; // { cmd:[...argv prefix], version } | null
function detectYtdlp() {
  if (_ytdlp !== undefined) return _ytdlp;
  const cands = [];
  if (process.env.YTDLP_PATH) cands.push([process.env.YTDLP_PATH]);
  cands.push(['yt-dlp'], ['yt-dlp.exe']);
  for (const py of [process.env.PYTHON_PATH, 'python3', 'python'].filter(Boolean)) cands.push([py, '-m', 'yt_dlp']);
  for (const cmd of cands) {
    try {
      const r = spawnSync(cmd[0], [...cmd.slice(1), '--version'], { timeout: 8000, windowsHide: true });
      if (r.status === 0) { _ytdlp = { cmd, version: String(r.stdout).trim().split('\n')[0] }; return _ytdlp; }
    } catch { /* try next */ }
  }
  _ytdlp = null;
  return null;
}
function _resetDetection() { _ytdlp = undefined; } // tests

// Optional fast catalog helper. ytmusicapi is excellent for search/radio metadata, but it is
// not a playback resolver; yt-dlp remains the only thing that turns a track id into a direct
// audio stream. Docker installs it, while bare installs can skip it and keep the old path.
let _ytmApi; // { cmd:[python], version } | null
let _ytmApiRunnerForTest = null;
function detectYtMusicApi() {
  if (_ytmApiRunnerForTest) return { cmd: ['test-python'], version: 'test' };
  if (_ytmApi !== undefined) return _ytmApi;
  if (process.env.TRIBOON_YTMUSICAPI === '0') { _ytmApi = null; return null; }
  const script = "import ytmusicapi; print(getattr(ytmusicapi, '__version__', 'unknown'))";
  for (const py of [process.env.PYTHON_PATH, 'python3', 'python'].filter(Boolean)) {
    try {
      const r = spawnSync(py, ['-c', script], { timeout: 8000, windowsHide: true });
      if (r.status === 0) {
        _ytmApi = { cmd: [py], version: String(r.stdout).trim().split('\n')[0] || 'unknown' };
        return _ytmApi;
      }
    } catch { /* try next */ }
  }
  _ytmApi = null;
  return null;
}
function _resetYtMusicApiDetection() { _ytmApi = undefined; _ytmApiRunnerForTest = null; }
function _setYtMusicApiRunnerForTest(fn) {
  _ytmApiRunnerForTest = typeof fn === 'function' ? fn : null;
  _ytmApi = _ytmApiRunnerForTest ? { cmd: ['test-python'], version: 'test' } : undefined;
}

// Cookies (a Netscape cookies.txt the admin exports from their browser) unlock the user's
// OWN library/playlists. Optional — public search + play needs none. The caller passes a
// path; we just append --cookies when present.
function ytArgs(extra, cookiesPath, { noPlaylist = true } = {}) {
  const { cmd } = detectYtdlp() || { cmd: ['yt-dlp'] };
  const base = ['--no-warnings', '--no-progress'];
  if (noPlaylist) base.push('--no-playlist');
  if (cookiesPath) base.push('--cookies', cookiesPath);
  return { bin: cmd[0], argv: [...cmd.slice(1), ...base, ...extra] };
}

function friendlyYtdlpError(stderr, fallback) {
  const msg = String(stderr || '');
  const line = msg.split('\n').find((l) => /error|warning|429|403|forbidden|sign in|bot|captcha|rate/i.test(l)) || fallback || 'yt-dlp failed';
  if (/429|too many requests|rate.?limit/i.test(msg)) return new Error('yt-dlp provider rate-limited this request');
  if (/sign in to confirm|confirm you.?re not a bot|bot|captcha/i.test(msg)) return new Error('yt-dlp provider bot-protection blocked this request');
  if (/403|forbidden/i.test(msg)) return new Error('yt-dlp provider rejected this request');
  return new Error(String(line || fallback || 'yt-dlp failed').trim());
}

// Run yt-dlp and collect stdout JSON (single object or NDJSON), with a hard timeout.
function runJson(extra, { timeoutMs = 25000, cookiesPath, priority = 0, maxStdoutBytes = 16e6 } = {}) {
  return withYtdlpSlot(() => runJsonNow(extra, { timeoutMs, cookiesPath, maxStdoutBytes }), { priority });
}
function runJsonNow(extra, { timeoutMs = 25000, cookiesPath, maxStdoutBytes = 16e6 } = {}) {
  return new Promise((resolve, reject) => {
    const yt = detectYtdlp();
    if (!yt) return reject(new Error('yt-dlp not installed on the server'));
    const { bin, argv } = ytArgs(extra, cookiesPath, { noPlaylist: optsNoPlaylist(extra) });
    const p = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    let timedOut = false, tooLarge = false, outBytes = 0;
    const killer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => {
      outBytes += d.length || 0;
      if (outBytes > maxStdoutBytes) {
        tooLarge = true;
        try { p.kill('SIGKILL'); } catch {}
        return;
      }
      out += d;
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(killer); reject(timedOut ? new Error('yt-dlp timed out') : e); });
    p.on('close', (code) => {
      clearTimeout(killer);
      if (timedOut) return reject(new Error('yt-dlp timed out'));
      if (tooLarge) return reject(new Error('yt-dlp output too large'));
      if (code !== 0 && !out) return reject(friendlyYtdlpError(err, `yt-dlp exit ${code}`));
      resolve(out);
    });
  });
}

function optsNoPlaylist(extra) {
  return !(extra || []).some((x) => /^https:\/\/(music\.youtube\.com\/(search\?|library\/playlists|playlist\?list=)|www\.youtube\.com\/feed\/playlists)/.test(String(x)));
}
function searchUrl(query) {
  return `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
}
function playlistItemsRange(offset = 0, limit = 200) {
  const start = Math.max(0, parseInt(offset, 10) || 0) + 1;
  const count = Math.max(1, Math.min(501, parseInt(limit, 10) || 200));
  return `${start}:${start + count - 1}`;
}

const num = (n) => (typeof n === 'number' && isFinite(n) ? n : null);
// id → deterministic YouTube thumbnail (no extra resolve). hqdefault always exists.
const thumbFor = (id) => (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null);
// Trim the noise scene-uploaders bake into titles so "Artist — Title" reads cleanly.
function cleanTitle(t) {
  return String(t || '').replace(/\s*[([](official\s*)?(music\s*)?(video|audio|lyrics?|visualizer|hd|4k)[)\]].*$/i, '')
    .replace(/\s*\|\s*official.*$/i, '').trim();
}

function parseJsonObject(out, message) {
  let data;
  try { data = JSON.parse(out); } catch { throw new Error(message); }
  if (!data || typeof data !== 'object') throw new Error(message);
  return data;
}

const YTMUSICAPI_SCRIPT = String.raw`
import json
import sys
from ytmusicapi import YTMusic, OAuthCredentials

payload = json.loads(sys.stdin.read() or "{}")
action = payload.get("action")

def make_client():
    token = payload.get("oauthToken")
    client_id = payload.get("clientId")
    client_secret = payload.get("clientSecret")
    if token and client_id and client_secret:
        return YTMusic(token, oauth_credentials=OAuthCredentials(client_id=client_id, client_secret=client_secret))
    return YTMusic()

yt = make_client()

if action == "search":
    rows = yt.search(str(payload.get("query") or "")[:200], filter="songs", limit=max(1, min(40, int(payload.get("limit") or 20))))
    print(json.dumps({"rows": rows}))
elif action == "watch":
    video_id = str(payload.get("id") or "")
    limit = max(1, min(50, int(payload.get("limit") or 25)))
    data = yt.get_watch_playlist(videoId=video_id, limit=limit)
    print(json.dumps({"rows": data.get("tracks") or [], "playlistId": data.get("playlistId")}))
elif action == "library_playlists":
    limit = max(1, min(100, int(payload.get("limit") or 50)))
    rows = yt.get_library_playlists(limit=limit)
    print(json.dumps({"rows": rows}))
elif action == "playlist":
    playlist_id = str(payload.get("id") or "")
    limit = max(1, min(501, int(payload.get("limit") or 100)))
    if playlist_id == "LM":
        data = yt.get_liked_songs(limit=limit)
        data["title"] = data.get("title") or "Liked Music"
    else:
        data = yt.get_playlist(playlist_id, limit=limit)
    print(json.dumps({"title": data.get("title") or "Playlist", "rows": data.get("tracks") or []}))
else:
    raise SystemExit("unknown ytmusicapi action")
`;

function oauthPost(url, data, { timeoutMs = 15000 } = {}) {
  if (_oauthPostForTest) return Promise.resolve(_oauthPostForTest(url, data));
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const u = new URL(url);
    const req = https.request(u, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'user-agent': YTMUSIC_OAUTH_UA,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => { if (chunks.reduce((n, c) => n + c.length, 0) < 2e6) chunks.push(d); });
      res.on('end', () => {
        let parsed;
        const raw = Buffer.concat(chunks).toString('utf8');
        try { parsed = JSON.parse(raw || '{}'); } catch { parsed = { error: raw || `HTTP ${res.statusCode}` }; }
        if (parsed && parsed.error) {
          const e = new Error(parsed.error_description || parsed.error);
          e.code = parsed.error;
          e.status = res.statusCode;
          e.payload = parsed;
          return reject(e);
        }
        if (res.statusCode >= 400) {
          const e = new Error(parsed.error_description || parsed.error || `OAuth HTTP ${res.statusCode}`);
          e.status = res.statusCode;
          e.payload = parsed;
          return reject(e);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('YouTube Music OAuth timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function normalizeOAuthClient(clientId, clientSecret) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!id || !secret) throw new Error('YouTube Music OAuth app is not configured');
  return { clientId: id, clientSecret: secret };
}

async function beginOAuth({ clientId, clientSecret }) {
  const c = normalizeOAuthClient(clientId, clientSecret);
  const r = await oauthPost(YTMUSIC_OAUTH_CODE_URL, { client_id: c.clientId, scope: YTMUSIC_OAUTH_SCOPE });
  const verificationUrl = r.verification_url || r.verification_uri || 'https://www.google.com/device';
  return {
    deviceCode: String(r.device_code || ''),
    userCode: String(r.user_code || ''),
    verificationUrl,
    verificationUrlComplete: r.verification_url_complete || (r.user_code ? `${verificationUrl}?user_code=${encodeURIComponent(r.user_code)}` : verificationUrl),
    expiresIn: Math.max(1, parseInt(r.expires_in, 10) || 1800),
    interval: Math.max(3, parseInt(r.interval, 10) || 5),
  };
}

function normalizeOAuthToken(raw, previous = null) {
  if (!raw || typeof raw !== 'object') throw new Error('YouTube Music OAuth returned no token');
  const expiresIn = Math.max(1, parseInt(raw.expires_in, 10) || 3600);
  const token = {
    access_token: String(raw.access_token || ''),
    refresh_token: String(raw.refresh_token || (previous && previous.refresh_token) || ''),
    scope: String(raw.scope || (previous && previous.scope) || YTMUSIC_OAUTH_SCOPE),
    token_type: String(raw.token_type || (previous && previous.token_type) || 'Bearer'),
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  };
  if (raw.refresh_token_expires_in !== undefined) token.refresh_token_expires_in = parseInt(raw.refresh_token_expires_in, 10) || 0;
  if (!token.access_token || !token.refresh_token) throw new Error('YouTube Music OAuth returned an incomplete token');
  return token;
}

async function completeOAuth({ clientId, clientSecret, deviceCode }) {
  const c = normalizeOAuthClient(clientId, clientSecret);
  const code = String(deviceCode || '').trim();
  if (!code) throw new Error('missing device code');
  const raw = await oauthPost(YTMUSIC_OAUTH_TOKEN_URL, {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: YTMUSIC_OAUTH_GRANT,
    code,
  });
  return normalizeOAuthToken(raw);
}

async function refreshOAuthToken(token, { clientId, clientSecret }) {
  const c = normalizeOAuthClient(clientId, clientSecret);
  const refreshToken = token && token.refresh_token;
  if (!refreshToken) throw new Error('YouTube Music OAuth token cannot refresh');
  const raw = await oauthPost(YTMUSIC_OAUTH_TOKEN_URL, {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return normalizeOAuthToken(raw, token);
}

function runYtMusicApiRaw(action, body, { timeoutMs = 12000, priority = 0 } = {}) {
  return withYtmApiSlot(() => runYtMusicApiRawNow(action, body, { timeoutMs }), { priority });
}
function runYtMusicApiRawNow(action, body, { timeoutMs = 12000 } = {}) {
  if (_ytmApiRunnerForTest) return Promise.resolve(_ytmApiRunnerForTest(action, body));
  return new Promise((resolve, reject) => {
    const py = detectYtMusicApi();
    if (!py) return reject(new Error('ytmusicapi is not installed'));
    const p = spawn(py.cmd[0], ['-c', YTMUSICAPI_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < 8e6) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 64e3) err += d; });
    p.on('error', (e) => { clearTimeout(killer); reject(timedOut ? new Error('ytmusicapi timed out') : e); });
    p.on('close', (code) => {
      clearTimeout(killer);
      if (timedOut) return reject(new Error('ytmusicapi timed out'));
      if (code !== 0) return reject(new Error(String(err || `ytmusicapi exit ${code}`).trim()));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('ytmusicapi returned invalid JSON')); }
    });
    p.stdin.end(JSON.stringify({ action, ...body }));
  });
}

function parseDurationText(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const s = String(v || '').trim();
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(s)) return null;
  const parts = s.split(':').map((x) => parseInt(x, 10));
  if (parts.some((x) => !isFinite(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}
function bestThumb(thumbnails, fallbackId) {
  const rows = Array.isArray(thumbnails) ? thumbnails : [];
  const best = rows
    .filter((t) => t && typeof t.url === 'string')
    .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
  return (best && best.url) || thumbFor(fallbackId);
}
function artistNames(item) {
  if (Array.isArray(item && item.artists)) {
    const names = item.artists.map((a) => a && a.name).filter(Boolean);
    if (names.length) return names.join(', ');
  }
  return (item && (item.artist || item.uploader || item.channel || item.author)) || '';
}
function normalizeYtMusicApiTrack(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.videoId || item.id || '');
  if (!/^[\w-]{11}$/.test(id)) return null;
  return {
    id,
    title: cleanTitle(item.title) || item.title || 'Unknown',
    artist: artistNames(item),
    duration: num(item.duration_seconds) || num(item.duration) || parseDurationText(item.duration),
    thumb: bestThumb(item.thumbnails, id),
    album: item.album && item.album.name ? item.album.name : undefined,
    source: 'ytmusicapi',
  };
}

function normalizeYtMusicApiPlaylist(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.playlistId || item.id || '').replace(/^VL/, '');
  if (!/^[\w-]{2,80}$/.test(id) || ['LM', 'LL', 'WL'].includes(id)) return null;
  return {
    id,
    title: item.title || 'Playlist',
    count: num(item.count) || num(item.trackCount),
    cover: bestThumb(item.thumbnails, null),
    source: 'ytmusicapi',
  };
}

async function searchWithYtMusicApi(query, limit, { priority = 0 } = {}) {
  const data = await runYtMusicApiRaw('search', { query, limit }, { priority, timeoutMs: 12000 });
  return (Array.isArray(data.rows) ? data.rows : [])
    .map(normalizeYtMusicApiTrack)
    .filter(Boolean)
    .slice(0, limit);
}
async function watchQueue(id, { limit = 25, priority = 0 } = {}) {
  if (!/^[\w-]{11}$/.test(String(id || ''))) throw new Error('bad track id');
  const n = Math.max(1, Math.min(50, parseInt(limit, 10) || 25));
  const data = await runYtMusicApiRaw('watch', { id, limit: n }, { priority, timeoutMs: 14000 });
  return {
    playlistId: data.playlistId || null,
    tracks: (Array.isArray(data.rows) ? data.rows : []).map(normalizeYtMusicApiTrack).filter(Boolean).slice(0, n),
  };
}

// A flat YouTube Music search (one fast call). Do not use generic `ytsearch`: Triboon Music
// must only discover tracks through music.youtube.com, not the whole of YouTube.
async function search(query, { limit = 20, cookiesPath, priority = 0 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return [];
  const n = Math.max(1, Math.min(40, limit));
  if (!cookiesPath && detectYtMusicApi()) {
    try {
      const fast = await searchWithYtMusicApi(q, n, { priority });
      if (fast.length) return fast;
    } catch { /* fall back to yt-dlp */ }
  }
  const out = await runJson(['--flat-playlist', '--playlist-items', `1:${n}`, '--dump-single-json', searchUrl(q)], { cookiesPath, priority });
  let data; try { data = JSON.parse(out); } catch { return []; }
  return (data.entries || [])
    .filter((e) => e && e.id && e.id.length === 11 && /^https:\/\/music\.youtube\.com\/watch\?v=/.test(String(e.url || '')))
    .map((e) => ({
      id: e.id, title: cleanTitle(e.title) || e.title || 'Unknown',
      artist: e.uploader || e.channel || e.uploader_id || '',
      duration: num(e.duration), thumb: thumbFor(e.id),
    }));
}

// Resolve the best audio stream URL for a track. Cached: the googlevideo URL is valid for a
// few hours, and re-running yt-dlp per play (≈1–3s) would gut the press-play feel. m4a is
// preferred for the broadest <audio> support, opus/webm as the fallback.
const _streamCache = new Map(); // id -> { url, at, expiresAt, title, artist, thumb, duration }
const STREAM_TTL_MS = 3 * 3600 * 1000;
function setStreamCache(id, rec) {
  while (_streamCache.size >= 200) {
    const oldest = _streamCache.keys().next().value;
    if (oldest === undefined) break;
    _streamCache.delete(oldest);
  }
  _streamCache.set(id, rec);
}
async function resolveStream(id, { cookiesPath, force = false } = {}) {
  if (!/^[\w-]{11}$/.test(String(id || ''))) throw new Error('bad track id');
  const hit = _streamCache.get(id);
  if (!force && hit && Date.now() < hit.expiresAt) return hit;
  // -J gives the picked format URL + metadata in one shot (title/artist/duration for the bar).
  const load = async (cookieFile) => {
    const out = await runJson(['-f', 'bestaudio[ext=m4a]/bestaudio/best', '-J', `https://music.youtube.com/watch?v=${id}`],
      { cookiesPath: cookieFile, timeoutMs: 30000, priority: 10 });
    try { return JSON.parse(out); } catch { throw new Error('yt-dlp returned no JSON'); }
  };
  let j = await load(cookiesPath);
  if ((!j || typeof j !== 'object') && cookiesPath) j = await load(null);
  if (!j || typeof j !== 'object') throw new Error('yt-dlp returned no track data');
  const picked = (j.requested_downloads && j.requested_downloads[0])
    || (Array.isArray(j.formats) && [...j.formats].reverse().find((f) => f.acodec && f.acodec !== 'none' && f.url))
    || null;
  const url = j.url || (picked && picked.url);
  if (!url) throw new Error('no audio stream found');
  const headers = { ...(j.http_headers || {}), ...((picked && picked.http_headers) || {}) };
  const rec = {
    url, at: Date.now(), expiresAt: Date.now() + STREAM_TTL_MS,
    headers,
    mime: /mime=audio%2Fmp4|\.m4a|ext=m4a/i.test(url) || j.ext === 'm4a' || (picked && picked.ext === 'm4a') ? 'audio/mp4' : (j.ext === 'webm' || (picked && picked.ext === 'webm') ? 'audio/webm' : 'audio/mp4'),
    title: cleanTitle(j.title) || j.title || 'Unknown', artist: j.artist || j.uploader || j.channel || '',
    duration: num(j.duration), thumb: thumbFor(id),
  };
  setStreamCache(id, rec);
  return rec;
}
function _peekCached(id) { return _streamCache.get(id) || null; }

// The user's OWN playlists (needs cookies). yt-dlp's youtube:tab extractor resolves the YTM
// library page when authenticated; entries are playlist links (ids often prefixed 'VL').
async function listPlaylists({ cookiesPath, oauthToken, oauthClientId, oauthClientSecret, limit = PLAYLIST_LIST_LIMIT }) {
  const n = Math.max(1, Math.min(PLAYLIST_LIST_LIMIT, parseInt(limit, 10) || PLAYLIST_LIST_LIMIT));
  if (oauthToken && oauthClientId && oauthClientSecret) {
    const data = await runYtMusicApiRaw('library_playlists', {
      oauthToken, clientId: oauthClientId, clientSecret: oauthClientSecret, limit: n,
    }, { timeoutMs: 12000 });
    return (Array.isArray(data.rows) ? data.rows : []).map(normalizeYtMusicApiPlaylist).filter(Boolean).slice(0, n);
  }
  if (!cookiesPath) throw new Error('YouTube Music is not linked');
  const sources = [
    'https://music.youtube.com/library/playlists',
    // yt-dlp's YTM library extractor sometimes returns `null` even when the cookies still
    // work for playlist/LM. The regular YouTube feed lists the same user playlists.
    'https://www.youtube.com/feed/playlists',
  ];
  let lastErr;
  for (const url of sources) {
    try {
      const out = await runJson(['--flat-playlist', '--playlist-items', `1:${n}`, '--dump-single-json', url], {
        cookiesPath,
        timeoutMs: url.includes('music.youtube.com') ? 12000 : 10000,
        maxStdoutBytes: 2e6,
      });
      return parseListPlaylists(out).slice(0, n);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('YouTube Music returned no playlist data — re-export cookies in Preferences');
}
function parseListPlaylists(out) {
  const data = parseJsonObject(out, 'YouTube Music returned no playlist data — re-export cookies in Preferences');
  return (Array.isArray(data.entries) ? data.entries : [])
    .map((e) => {
      let id = String(e.id || '').replace(/^VL/, '');
      if (!/^[\w-]{2,64}$/.test(id) && e.url) {
        try { id = new URL(e.url).searchParams.get('list') || id; } catch {}
      }
      return { id, title: e.title || 'Playlist', count: num(e.playlist_count) };
    })
    .filter((p) => /^[\w-]{2,64}$/.test(p.id) && !['LM', 'LL', 'WL'].includes(p.id)); // Liked Songs gets its own pinned chip
}

// Tracks of one playlist ('LM' = the user's Liked Songs; public lists work without cookies).
async function playlistTracks(id, { cookiesPath, oauthToken, oauthClientId, oauthClientSecret, limit = 200, offset = 0 } = {}) {
  if (!/^[\w-]{2,64}$/.test(String(id || ''))) throw new Error('bad playlist id');
  if (oauthToken && oauthClientId && oauthClientSecret) {
    const n = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const data = await runYtMusicApiRaw('playlist', {
      oauthToken, clientId: oauthClientId, clientSecret: oauthClientSecret, id, limit: off + n,
    }, { timeoutMs: 20000 });
    const rows = (Array.isArray(data.rows) ? data.rows : []).map(normalizeYtMusicApiTrack).filter(Boolean);
    return { title: data.title || (id === 'LM' ? 'Liked Music' : 'Playlist'), tracks: rows.slice(off, off + n) };
  }
  const out = await runJson(['--flat-playlist', '--dump-single-json', '--playlist-items', playlistItemsRange(offset, limit),
    `https://music.youtube.com/playlist?list=${id}`], { cookiesPath, timeoutMs: 45000 });
  return parsePlaylistTracks(out);
}
function parsePlaylistTracks(out) {
  const data = parseJsonObject(out, 'playlist returned no data — re-export cookies in Preferences');
  return {
    title: data.title || 'Playlist',
    tracks: (Array.isArray(data.entries) ? data.entries : []).filter((e) => e && e.id && e.id.length === 11)
      .map((e) => ({
        id: e.id, title: cleanTitle(e.title) || e.title || 'Unknown',
        artist: e.uploader || e.channel || '', duration: num(e.duration), thumb: thumbFor(e.id),
      })),
  };
}

function _queueStats() { return { active: ytdlpActive, queued: ytdlpQueue.length, concurrency: YTDLP_CONCURRENCY }; }
function _ytmApiQueueStats() { return { active: ytmApiActive, queued: ytmApiQueue.length, concurrency: YTMUSICAPI_CONCURRENCY }; }
function _setOAuthPostForTest(fn) { _oauthPostForTest = typeof fn === 'function' ? fn : null; }

module.exports = {
  detectYtdlp, detectYtMusicApi,
  search, resolveStream, listPlaylists, playlistTracks, watchQueue,
  beginOAuth, completeOAuth, refreshOAuthToken,
  thumbFor, cleanTitle,
  _resetDetection, _resetYtMusicApiDetection, _setYtMusicApiRunnerForTest,
  _setOAuthPostForTest,
  _peekCached, _queueStats, _ytmApiQueueStats,
  _withYtdlpSlot: withYtdlpSlot,
  _friendlyYtdlpError: friendlyYtdlpError,
  _ytArgs: ytArgs,
  _optsNoPlaylist: optsNoPlaylist,
  _searchUrl: searchUrl,
  _playlistItemsRange: playlistItemsRange,
  _parseListPlaylists: parseListPlaylists,
  _parsePlaylistTracks: parsePlaylistTracks,
  _normalizeYtMusicApiTrack: normalizeYtMusicApiTrack,
  _normalizeYtMusicApiPlaylist: normalizeYtMusicApiPlaylist,
  _normalizeOAuthToken: normalizeOAuthToken,
};

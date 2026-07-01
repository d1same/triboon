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
const YTMUSIC_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let ytdlpActive = 0;
const ytdlpQueue = [];
let ytdlpSeq = 0;
let ytmApiActive = 0;
const ytmApiQueue = [];
let ytmApiSeq = 0;

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
function upgradeThumbUrl(url, { size = 640 } = {}) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return raw; }
  const host = u.hostname.toLowerCase();
  if (host.endsWith('googleusercontent.com')) {
    const target = Math.max(320, Math.min(1024, parseInt(size, 10) || 640));
    const keep = raw.match(/=w\d+-h\d+((?:-[a-z0-9]+)*)$/i);
    if (keep) return raw.replace(/=w\d+-h\d+((?:-[a-z0-9]+)*)$/i, `=w${target}-h${target}${keep[1] || ''}`);
    if (/=s\d+((?:-[a-z0-9]+)+)?$/i.test(raw)) return raw.replace(/=s\d+((?:-[a-z0-9]+)+)?$/i, `=w${target}-h${target}$1`);
    if (!/[?=]$/.test(raw)) return `${raw}=w${target}-h${target}-l90-rj`;
  }
  if (host.endsWith('ytimg.com')) {
    return raw.replace(/\/(?:default|mqdefault)\.(jpg|webp)(\?.*)?$/i, '/hqdefault.$1$2');
  }
  return raw;
}
const thumbFor = (id) => (id ? upgradeThumbUrl(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`) : null);
// Trim the noise scene-uploaders bake into titles so "Artist — Title" reads cleanly.
function cleanTitle(t) {
  return String(t || '').replace(/\s*[([](official\s*)?(music\s*)?(video|audio|lyrics?|visualizer|hd|4k)[)\]].*$/i, '')
    .replace(/\s*\|\s*official.*$/i, '').trim();
}
function normSearchText(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function titleCaseQuery(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').split(' ')
    .map((p) => p ? p[0].toUpperCase() + p.slice(1) : p).join(' ');
}
function looksLikeArtistSearchQuery(query) {
  const q = normSearchText(query);
  const generic = /\b(music|song|songs|album|albums|playlist|playlists|hits|top|new|release|releases|chart|charts|viral|fresh|chill|radio|mix|live|cover|karaoke|instrumental|genre|genres|workout)\b/;
  const words = q.split(/\s+/).filter(Boolean);
  return q.length >= 5 && words.length >= 2 && words.length <= 4 && !generic.test(q);
}
function inferArtistFromTitle(title) {
  const raw = cleanTitle(title);
  const m = /^(.{2,80}?)\s+[-–—]\s+(.{2,180})$/.exec(raw);
  if (!m) return null;
  const artist = m[1].replace(/\s*\b(topic|official)\b\s*$/i, '').trim();
  const track = cleanTitle(m[2]);
  if (!artist || !track) return null;
  if (artist.includes(':')) return null;
  if (/\b(official|audio|video|lyrics?|remaster|album|playlist|mix)\b/i.test(artist)) return null;
  return { artist, title: track };
}
function noisySearchPenalty(row, query) {
  const q = normSearchText(query);
  const title = normSearchText(row && row.title);
  const haystack = `${title} ${normSearchText(row && row.artist)}`.trim();
  if (!haystack) return 200;
  let penalty = 0;
  const wants = (word) => new RegExp(`\\b${word}\\b`, 'i').test(q);
  if (!wants('cover') && /\b(cover|karaoke|instrumental)\b/.test(haystack)) penalty += 28;
  if (!wants('live') && /\b(live|concert|performance)\b/.test(haystack)) penalty += 10;
  if (/\b(reaction|review|interview|tutorial|how to|explained|podcast|game|challenge|shorts?)\b/.test(haystack)) penalty += 55;
  if (/\b(connect the songs|i played on|what makes this song|does it hold up|behind the song)\b/.test(haystack)) penalty += 65;
  return penalty;
}
function searchDedupeKey(row) {
  const title = normSearchText(row && row.title)
    .replace(/\b(radio edit|single version|album version|remaster(ed)?|official|audio|video|lyrics?)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const artist = normSearchText(row && row.artist);
  return `${title}|${artist}`;
}
function cleanSearchRows(rows, query, limit) {
  const prepared = (Array.isArray(rows) ? rows : [])
    .map((row, idx) => {
      if (!row || !/^[\w-]{11}$/.test(String(row.id || ''))) return null;
      const split = row.artist ? null : inferArtistFromTitle(row.title);
      const title = cleanTitle(split ? split.title : row.title) || row.title || 'Unknown';
      const inferredQueryArtist = looksLikeArtistSearchQuery(query) ? titleCaseQuery(query) : '';
      const artist = String(row.artist || (split && split.artist) || inferredQueryArtist || '').trim();
      return {
        ...row,
        title,
        artist,
        _idx: idx,
        _penalty: noisySearchPenalty({ ...row, title, artist }, query),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a._penalty - b._penalty || a._idx - b._idx);
  const lowPenalty = prepared.filter((row) => row._penalty < 55);
  const candidates = lowPenalty.length >= Math.min(5, limit) ? lowPenalty : prepared;
  const seen = new Set();
  const out = [];
  for (const row of candidates) {
    const key = searchDedupeKey(row);
    if (key && seen.has(key)) continue;
    seen.add(key);
    const { _idx, _penalty, ...clean } = row;
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
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
from ytmusicapi import YTMusic

payload = json.loads(sys.stdin.read() or "{}")
action = payload.get("action")

def make_client():
    # Browser (cookie) auth: ytmusicapi recognises BROWSER auth when an "authorization" header
    # containing SAPISIDHASH plus a "cookie" (with __Secure-3PAPISID) is supplied, then recomputes
    # the real per-request SAPISIDHASH itself. This is the path that reads a user's OWN library +
    # personalised home. (Google broke the OAuth path for library reads, so it was removed.)
    auth = payload.get("browserAuth")
    if auth:
        return YTMusic(auth)
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
elif action == "home":
    # Personalised home rows ("Mixed for you", "Listen again", recommended mixes) when authed;
    # generic home when not. Each row = {title, contents:[song|playlist|album ...]}.
    limit = max(1, min(20, int(payload.get("limit") or 8)))
    rows = yt.get_home(limit=limit)
    print(json.dumps({"rows": rows}))
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

// Build ytmusicapi BROWSER-auth headers from a Netscape cookies.txt (the same file yt-dlp uses).
// ytmusicapi recognises browser auth when it sees a `cookie` (carrying __Secure-3PAPISID) plus an
// `authorization` header containing "SAPISIDHASH"; it then recomputes the real per-request hash
// from the cookie itself (ytmusic.py). Returns null when the file has no usable YouTube session.
function browserAuthFromCookies(cookiesPath) {
  if (!cookiesPath) return null;
  let text;
  try { text = require('fs').readFileSync(cookiesPath, 'utf8'); } catch { return null; }
  const jar = [];
  let hasApiSid = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5];
    const value = parts[6];
    if (!name) continue;
    jar.push(`${name}=${value}`);
    if (name === '__Secure-3PAPISID') hasApiSid = true;
  }
  if (!hasApiSid || !jar.length) return null; // ytmusicapi needs __Secure-3PAPISID to sign requests
  return {
    cookie: jar.join('; '),
    authorization: 'SAPISIDHASH init', // marker → BROWSER auth; ytmusicapi recomputes the live hash
    origin: 'https://music.youtube.com',
    'x-goog-authuser': '0',
    'user-agent': YTMUSIC_BROWSER_UA,
  };
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
  return upgradeThumbUrl((best && best.url) || thumbFor(fallbackId));
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
  // Prefer ytmusicapi song search for EVERYONE (was gated to unlinked users) — it returns a full,
  // clean song list up to the limit, whereas the yt-dlp search-page scrape tops out around a dozen
  // watch?v= rows. yt-dlp stays the fallback when ytmusicapi is absent or errors.
  if (detectYtMusicApi()) {
    try {
      const fast = await searchWithYtMusicApi(q, n, { priority });
      if (fast.length) return cleanSearchRows(fast, q, n);
    } catch { /* fall back to yt-dlp */ }
  }
  const out = await runJson(['--flat-playlist', '--playlist-items', `1:${n}`, '--dump-single-json', searchUrl(q)], { cookiesPath, priority });
  let data; try { data = JSON.parse(out); } catch { return []; }
  const rows = (data.entries || [])
    .filter((e) => e && e.id && e.id.length === 11 && /^https:\/\/music\.youtube\.com\/watch\?v=/.test(String(e.url || '')))
    .map((e) => ({
      id: e.id, title: cleanTitle(e.title) || e.title || 'Unknown',
      artist: e.uploader || e.channel || e.uploader_id || '',
      duration: num(e.duration), thumb: thumbFor(e.id),
    }));
  return cleanSearchRows(rows, q, n);
}

// Resolve the best audio stream URL for a track. Cached: the googlevideo URL is valid for a
// few hours, and re-running yt-dlp per play (≈1–3s) would gut the press-play feel. m4a is
// preferred for the broadest <audio> support, opus/webm as the fallback.
const _streamCache = new Map(); // cacheKey -> { url, at, expiresAt, title, artist, thumb, duration }
const STREAM_TTL_MS = 3 * 3600 * 1000;
// Scope the cache by the cookies in play. A track resolved with one user's cookies (a premium /
// age-gated / region-specific variant, or one their account can play and another can't) must NOT
// be served to another user from cache. No cookies → shared 'public' scope.
function streamCacheKey(id, cookiesPath) {
  const scope = cookiesPath
    ? require('crypto').createHash('sha1').update(String(cookiesPath)).digest('hex').slice(0, 12)
    : 'public';
  return id + '|' + scope;
}
function setStreamCache(key, rec) {
  while (_streamCache.size >= 200) {
    const oldest = _streamCache.keys().next().value;
    if (oldest === undefined) break;
    _streamCache.delete(oldest);
  }
  _streamCache.set(key, rec);
}
async function resolveStream(id, { cookiesPath, force = false } = {}) {
  if (!/^[\w-]{11}$/.test(String(id || ''))) throw new Error('bad track id');
  const cacheKey = streamCacheKey(id, cookiesPath);
  const hit = _streamCache.get(cacheKey);
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
  setStreamCache(cacheKey, rec);
  return rec;
}
function _peekCached(id, cookiesPath) { return _streamCache.get(streamCacheKey(id, cookiesPath)) || null; }

// The user's OWN playlists (needs cookies). Prefers ytmusicapi BROWSER auth (clean structured
// data + covers); falls back to yt-dlp's youtube:tab extractor on the YTM library page (entries
// are playlist links, ids often prefixed 'VL') when ytmusicapi is absent or errors.
async function listPlaylists({ cookiesPath, limit = PLAYLIST_LIST_LIMIT }) {
  const n = Math.max(1, Math.min(PLAYLIST_LIST_LIMIT, parseInt(limit, 10) || PLAYLIST_LIST_LIMIT));
  if (!cookiesPath) throw new Error('YouTube Music is not linked');
  const browserAuth = detectYtMusicApi() ? browserAuthFromCookies(cookiesPath) : null;
  if (browserAuth) {
    try {
      const data = await runYtMusicApiRaw('library_playlists', { browserAuth, limit: n }, { timeoutMs: 14000 });
      return (Array.isArray(data.rows) ? data.rows : []).map(normalizeYtMusicApiPlaylist).filter(Boolean).slice(0, n);
    } catch { /* ytmusicapi failed → fall back to the yt-dlp library scrape below */ }
  }
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
// Liked Music is private, so it needs ytmusicapi BROWSER auth; regular playlists prefer it when
// linked (clean metadata) but fall back to yt-dlp (which resolves public lists with no auth).
async function playlistTracks(id, { cookiesPath, limit = 200, offset = 0 } = {}) {
  if (!/^[\w-]{2,64}$/.test(String(id || ''))) throw new Error('bad playlist id');
  const browserAuth = detectYtMusicApi() ? browserAuthFromCookies(cookiesPath) : null;
  if (id === 'LM' || browserAuth) {
    if (!browserAuth) throw new Error('YouTube Music is not linked');
    const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    try {
      const data = await runYtMusicApiRaw('playlist', { browserAuth, id, limit: off + n }, { timeoutMs: 24000 });
      const rows = (Array.isArray(data.rows) ? data.rows : []).map(normalizeYtMusicApiTrack).filter(Boolean);
      return { title: data.title || (id === 'LM' ? 'Liked Music' : 'Playlist'), tracks: rows.slice(off, off + n) };
    } catch (e) {
      if (id === 'LM') throw e; // no yt-dlp fallback for the private Liked list
      // public playlist → fall through to the yt-dlp path below
    }
  }
  const out = await runJson(['--flat-playlist', '--dump-single-json', '--playlist-items', playlistItemsRange(offset, limit),
    `https://music.youtube.com/playlist?list=${id}`], { cookiesPath, timeoutMs: 45000 });
  return parsePlaylistTracks(out);
}

// Personalised home rows via ytmusicapi BROWSER auth: "Mixed for you", "Listen again",
// recommended mixes — tuned to the user's own listening. Returns ytmusicapi's raw home rows
// ([{ title, contents:[...] }]); the caller normalises them into Triboon shelves. Needs cookies +
// ytmusicapi; throws otherwise so the caller can fall back to the generic (charts) home.
async function homeRows({ cookiesPath, limit = 8 } = {}) {
  if (!detectYtMusicApi()) throw new Error('ytmusicapi is not installed');
  const browserAuth = browserAuthFromCookies(cookiesPath);
  if (!browserAuth) throw new Error('YouTube Music is not linked');
  const n = Math.max(1, Math.min(20, parseInt(limit, 10) || 8));
  const data = await runYtMusicApiRaw('home', { browserAuth, limit: n }, { timeoutMs: 16000 });
  return Array.isArray(data.rows) ? data.rows : [];
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

module.exports = {
  detectYtdlp, detectYtMusicApi,
  search, resolveStream, listPlaylists, playlistTracks, watchQueue, homeRows,
  browserAuthFromCookies,
  thumbFor, cleanTitle, _upgradeThumbUrl: upgradeThumbUrl,
  _resetDetection, _resetYtMusicApiDetection, _setYtMusicApiRunnerForTest,
  _peekCached, _queueStats, _ytmApiQueueStats,
  _withYtdlpSlot: withYtdlpSlot,
  _friendlyYtdlpError: friendlyYtdlpError,
  _cleanSearchRows: cleanSearchRows,
  _ytArgs: ytArgs,
  _optsNoPlaylist: optsNoPlaylist,
  _searchUrl: searchUrl,
  _playlistItemsRange: playlistItemsRange,
  _parseListPlaylists: parseListPlaylists,
  _parsePlaylistTracks: parsePlaylistTracks,
  _normalizeYtMusicApiTrack: normalizeYtMusicApiTrack,
  _normalizeYtMusicApiPlaylist: normalizeYtMusicApiPlaylist,
};

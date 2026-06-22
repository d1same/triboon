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
const YTDLP_CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.TRIBOON_YTDLP_CONCURRENCY || '2', 10) || 2));
let ytdlpActive = 0;
const ytdlpQueue = [];
let ytdlpSeq = 0;

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
function runJson(extra, { timeoutMs = 25000, cookiesPath, priority = 0 } = {}) {
  return withYtdlpSlot(() => runJsonNow(extra, { timeoutMs, cookiesPath }), { priority });
}
function runJsonNow(extra, { timeoutMs = 25000, cookiesPath } = {}) {
  return new Promise((resolve, reject) => {
    const yt = detectYtdlp();
    if (!yt) return reject(new Error('yt-dlp not installed on the server'));
    const { bin, argv } = ytArgs(extra, cookiesPath, { noPlaylist: optsNoPlaylist(extra) });
    const p = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < 16e6) out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(killer); reject(timedOut ? new Error('yt-dlp timed out') : e); });
    p.on('close', (code) => {
      clearTimeout(killer);
      if (timedOut) return reject(new Error('yt-dlp timed out'));
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

// A flat YouTube Music search (one fast call). Do not use generic `ytsearch`: Triboon Music
// must only discover tracks through music.youtube.com, not the whole of YouTube.
async function search(query, { limit = 20, cookiesPath, priority = 0 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return [];
  const n = Math.max(1, Math.min(40, limit));
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
async function listPlaylists({ cookiesPath }) {
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
      const out = await runJson(['--flat-playlist', '--dump-single-json', url], { cookiesPath, timeoutMs: 30000 });
      return parseListPlaylists(out);
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
async function playlistTracks(id, { cookiesPath, limit = 200, offset = 0 } = {}) {
  if (!/^[\w-]{2,64}$/.test(String(id || ''))) throw new Error('bad playlist id');
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

module.exports = { detectYtdlp, search, resolveStream, listPlaylists, playlistTracks, thumbFor, cleanTitle, _resetDetection, _peekCached, _queueStats, _withYtdlpSlot: withYtdlpSlot, _friendlyYtdlpError: friendlyYtdlpError, _ytArgs: ytArgs, _optsNoPlaylist: optsNoPlaylist, _searchUrl: searchUrl, _playlistItemsRange: playlistItemsRange, _parseListPlaylists: parseListPlaylists, _parsePlaylistTracks: parsePlaylistTracks };

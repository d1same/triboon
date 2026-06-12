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
function ytArgs(extra, cookiesPath) {
  const { cmd } = detectYtdlp() || { cmd: ['yt-dlp'] };
  const base = ['--no-warnings', '--no-progress', '--no-playlist'];
  if (cookiesPath) base.push('--cookies', cookiesPath);
  return { bin: cmd[0], argv: [...cmd.slice(1), ...base, ...extra] };
}

// Run yt-dlp and collect stdout JSON (single object or NDJSON), with a hard timeout.
function runJson(extra, { timeoutMs = 25000, cookiesPath } = {}) {
  return new Promise((resolve, reject) => {
    const yt = detectYtdlp();
    if (!yt) return reject(new Error('yt-dlp not installed on the server'));
    const { bin, argv } = ytArgs(extra, cookiesPath);
    const p = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('yt-dlp timed out')); }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < 16e6) out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(killer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0 && !out) return reject(new Error(err.split('\n').find((l) => /error/i.test(l)) || `yt-dlp exit ${code}`));
      resolve(out);
    });
  });
}

const num = (n) => (typeof n === 'number' && isFinite(n) ? n : null);
// id → deterministic YouTube thumbnail (no extra resolve). hqdefault always exists.
const thumbFor = (id) => (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null);
// Trim the noise scene-uploaders bake into titles so "Artist — Title" reads cleanly.
function cleanTitle(t) {
  return String(t || '').replace(/\s*[([](official\s*)?(music\s*)?(video|audio|lyrics?|visualizer|hd|4k)[)\]].*$/i, '')
    .replace(/\s*\|\s*official.*$/i, '').trim();
}

// A flat YouTube search (one fast call): id + title + uploader(artist) + duration. We use
// plain ytsearch (not the music.youtube.com search URL) because flat YTM entries omit
// artist/duration, and the audio stream is identical either way.
async function search(query, { limit = 20, cookiesPath } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return [];
  const n = Math.max(1, Math.min(40, limit));
  const out = await runJson(['--flat-playlist', '--dump-single-json', `ytsearch${n}:${q}`], { cookiesPath });
  let data; try { data = JSON.parse(out); } catch { return []; }
  return (data.entries || []).filter((e) => e && e.id && e.id.length === 11) // 11-char = a video; album/playlist browse-ids are longer
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
async function resolveStream(id, { cookiesPath, force = false } = {}) {
  if (!/^[\w-]{11}$/.test(String(id || ''))) throw new Error('bad track id');
  const hit = _streamCache.get(id);
  if (!force && hit && Date.now() < hit.expiresAt) return hit;
  // -J gives the picked format URL + metadata in one shot (title/artist/duration for the bar).
  const out = await runJson(['-f', 'bestaudio[ext=m4a]/bestaudio/best', '-J', id], { cookiesPath, timeoutMs: 30000 });
  let j; try { j = JSON.parse(out); } catch { throw new Error('yt-dlp returned no JSON'); }
  const url = j.url || (j.requested_downloads && j.requested_downloads[0] && j.requested_downloads[0].url)
    || (Array.isArray(j.formats) && [...j.formats].reverse().find((f) => f.acodec && f.acodec !== 'none' && f.url) || {}).url;
  if (!url) throw new Error('no audio stream found');
  const rec = {
    url, at: Date.now(), expiresAt: Date.now() + STREAM_TTL_MS,
    mime: /mime=audio%2Fmp4|\.m4a|ext=m4a/i.test(url) || j.ext === 'm4a' ? 'audio/mp4' : (j.ext === 'webm' ? 'audio/webm' : 'audio/mp4'),
    title: cleanTitle(j.title) || j.title || 'Unknown', artist: j.artist || j.uploader || j.channel || '',
    duration: num(j.duration), thumb: thumbFor(id),
  };
  if (_streamCache.size > 200) _streamCache.clear(); // bounded; entries are cheap to rebuild
  _streamCache.set(id, rec);
  return rec;
}
function _peekCached(id) { return _streamCache.get(id) || null; }

module.exports = { detectYtdlp, search, resolveStream, thumbFor, cleanTitle, _resetDetection, _peekCached };

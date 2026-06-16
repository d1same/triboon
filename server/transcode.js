'use strict';
// Remux/transcode manager. Playback policy is locked: source-fit → direct play → remux →
// transcode. The engine streams raw bytes; browsers that can't open MKV get an ffmpeg remux
// (streams copied, ~0 CPU) to fragmented MP4 piped straight to the response. ffmpeg/ffprobe
// are sidecar binaries (present in the Docker image; optional on dev boxes) — when absent we
// degrade honestly: direct play + "open in VLC", never a broken stream.

const { spawn, spawnSync } = require('child_process');

let _ffmpeg; // cached detection: { path, version } | null
function detectFfmpeg() {
  if (_ffmpeg !== undefined) return _ffmpeg;
  for (const cand of [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean)) {
    try {
      const r = spawnSync(cand, ['-version'], { timeout: 4000, windowsHide: true });
      if (r.status === 0) {
        const version = String(r.stdout).split('\n')[0].trim();
        _ffmpeg = { path: cand, version };
        return _ffmpeg;
      }
    } catch { /* try next */ }
  }
  _ffmpeg = null;
  return null;
}

let _ffprobe; // cached: { path } | null
function detectFfprobe() {
  if (_ffprobe !== undefined) return _ffprobe;
  for (const cand of [process.env.FFPROBE_PATH, 'ffprobe'].filter(Boolean)) {
    try {
      const r = spawnSync(cand, ['-version'], { timeout: 4000, windowsHide: true });
      if (r.status === 0) { _ffprobe = { path: cand }; return _ffprobe; }
    } catch { /* try next */ }
  }
  _ffprobe = null;
  return null;
}

// Decide the playback method for a mount + client capabilities.
// caps: { mkv, hevc, ac3, eac3, dts } — the client's canPlayType results.
function decidePlayback(name, caps = {}) {
  const isMp4 = /\.(mp4|m4v)$/i.test(name);
  const isWebm = /\.webm$/i.test(name);
  const isMkv = /\.(mkv|ts)$/i.test(name);
  const hasKnownContainer = isMp4 || isWebm || isMkv;
  // MKV direct play needs MORE than container support: most MKVs carry AC3-family audio,
  // and Chromium happily claims matroska while decoding none of it — a "direct" DDP MKV
  // plays silent video. Devices with full container+audio hardware DO skip the server
  // entirely (true direct play); everything else gets the video-copy remux.
  if (isMp4 || isWebm || (isMkv && caps.mkv && caps.ac3 && caps.eac3)) return { method: 'direct' };
  // Usenet release names often do not expose the inner filename extension until after mount.
  // Treat that unknown container like MKV: remux first when ffmpeg is available.
  if ((isMkv || !hasKnownContainer) && detectFfmpeg()) return { method: 'remux' };
  return { method: 'direct', warning: 'container may not play in this client — use VLC/Android' };
}

// Probe a stream URL for its tracks (powers the CC/audio menus and the ends-at clock).
// Returns { duration, video: [...], audio: [{ rel, codec, lang, title, channels }],
//           subs: [{ rel, codec, lang, title, text }] } — `rel` is the per-type index that
// ffmpeg's -map 0:a:N / 0:s:N selectors use; `text` marks extractable (non-bitmap) subs.
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
function probeTracks(url) {
  return new Promise((resolve, reject) => {
    const fp = detectFfprobe();
    if (!fp) return reject(new Error('ffprobe not available'));
    const p = spawn(fp.path, [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format',
      '-analyzeduration', '20M', '-probesize', '20M', url,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', () => {
      clearTimeout(killer);
      try {
        const j = JSON.parse(out || '{}');
        const streams = j.streams || [];
        const rel = { video: 0, audio: 0, subtitle: 0 };
        const result = { duration: parseFloat((j.format || {}).duration) || null, video: [], audio: [], subs: [] };
        for (const s of streams) {
          const t = s.codec_type;
          if (!(t in rel) && t !== 'subtitle') continue;
          const base = {
            rel: rel[t === 'subtitle' ? 'subtitle' : t]++,
            codec: s.codec_name,
            lang: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
            title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
          };
          if (t === 'video') result.video.push({ ...base, height: s.height || null,
            hdr: ['smpte2084', 'arib-std-b67'].includes(s.color_transfer) });
          else if (t === 'audio') result.audio.push({ ...base, channels: s.channels || 2 });
          else if (t === 'subtitle') result.subs.push({ ...base, text: TEXT_SUB_CODECS.has(s.codec_name) });
        }
        resolve(result);
      } catch (e) { reject(new Error(`ffprobe parse: ${e.message} ${err.slice(0, 200)}`)); }
    });
    p.on('error', (e) => { clearTimeout(killer); reject(e); });
  });
}

// ---- the transcode ladder ----
// Detect the best available H.264 encoder: hardware first (NVENC → QSV → AMF → VideoToolbox
// → VAAPI), software libx264 as the universal fallback.
let _encoder;
function detectEncoder() {
  if (_encoder !== undefined) return _encoder;
  const ff = detectFfmpeg();
  if (!ff) { _encoder = null; return null; }
  let list = '';
  try { list = String(spawnSync(ff.path, ['-hide_banner', '-encoders'], { timeout: 6000, windowsHide: true }).stdout || ''); } catch {}
  const prefs = [
    { name: 'h264_nvenc', kind: 'NVIDIA NVENC' },
    { name: 'h264_qsv', kind: 'Intel QuickSync' },
    { name: 'h264_amf', kind: 'AMD AMF' },
    { name: 'h264_videotoolbox', kind: 'Apple VideoToolbox' },
    { name: 'h264_vaapi', kind: 'VAAPI' },
    { name: 'libx264', kind: 'software x264' },
  ];
  for (const p of prefs) {
    if (!list.includes(' ' + p.name + ' ')) continue;
    // HW encoders can be listed but unusable (no GPU in the container) — try a 0.2s encode.
    if (p.name !== 'libx264') {
      try {
        const probeArgs = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=10:duration=0.2'];
        if (p.name === 'h264_vaapi') probeArgs.push('-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload');
        const t = spawnSync(ff.path, [...probeArgs, '-c:v', p.name, '-f', 'null', '-'], { timeout: 15000, windowsHide: true });
        if (t.status !== 0) continue;
      } catch { continue; }
    }
    _encoder = p;
    return _encoder;
  }
  _encoder = null;
  return null;
}

const LADDER = { 1080: { h: 1080, vb: '8M', maxb: '12M' }, 720: { h: 720, vb: '4M', maxb: '6M' }, 480: { h: 480, vb: '1.8M', maxb: '3M' } };

// Full transcode: H.264 + AAC fMP4 for clients that can't decode the source codec (the HEVC
// wall). HDR sources get tone-mapped to SDR. Channels preserved up to 5.1 (browsers play
// multichannel AAC fine).
function spawnTranscode(streamUrl, { startSeconds = 0, audioTrack = 0, height = 1080, hdr = false } = {}) {
  const ff = detectFfmpeg();
  const enc = detectEncoder();
  if (!ff || !enc) throw new Error('no H.264 encoder available');
  const lad = LADDER[height] || LADDER[1080];
  const filters = [];
  if (hdr) filters.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
  filters.push(`scale=-2:'min(${lad.h},ih)'`, 'format=yuv420p');
  const encArgs = enc.name === 'libx264'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', lad.maxb, '-bufsize', '24M']
    : ['-c:v', enc.name, '-b:v', lad.vb, '-maxrate', lad.maxb];
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),  // re-encode → accurate seek is exact for BOTH tracks
    '-i', streamUrl,
    '-map', '0:v:0', '-map', `0:a:${audioTrack}?`,
    '-vf', filters.join(','),
    ...encArgs,
    '-c:a', 'aac', '-b:a', '256k', '-ac', '6',
    ...REMUX_SYNC_FLAGS,                                  // delay_moov compensates the H.264 encoder's own B-frame delay
    '-movflags', REMUX_MOVFLAGS,
    '-f', 'mp4', 'pipe:1',
  ];
  return spawn(ff.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// Browser-decodable audio codecs (Chromium/WebView/Safari common ground). Everything else
// (ac3/eac3/dts/truehd/pcm…) stream-copied into fMP4 either hard-errors the <video> — the
// "codec not supported" toast on every DDP movie — or plays silent video on Android WebView.
const BROWSER_SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
function audioNeedsTranscode(codec) { return !BROWSER_SAFE_AUDIO.has(String(codec || '').toLowerCase()); }

// Can THIS client play the codec without re-encoding? Universal web codecs always copy;
// the AC3 family copies only when the client PROVED hardware support (canPlayType caps sent
// with the play request — e.g. a TV that decodes DDP natively → true direct audio, zero
// server CPU). Unknown codec (no probe yet): trust a broad AC3+EAC3 claim, else convert —
// a wrong "copy" is a hard playback error, a wrong "convert" is a cheap AAC pass.
function audioCopyOk(codec, caps = {}) {
  const c = String(codec || '').toLowerCase();
  if (!c) return !!(caps.ac3 && caps.eac3);
  if (BROWSER_SAFE_AUDIO.has(c)) return true;
  if (c === 'ac3') return !!caps.ac3;
  if (c === 'eac3') return !!caps.eac3;
  if (c.startsWith('dts')) return !!caps.dts;
  return false; // truehd/pcm/mlp: no <video>-tag path on any client
}

// Spawn an ffmpeg remux reading the mount over our own HTTP (so ffmpeg can seek via Range),
// writing fragmented MP4 to stdout. startSeconds enables seek-by-restart; audioTrack picks
// which audio stream rides along (this is how browsers get audio selection — they can't
// switch tracks in a raw stream themselves). transcodeAudio re-encodes ONLY the audio to
// 5.1 AAC (video always copied): the cheap fix for DDP/AC3/DTS releases that otherwise
// fell all the way down to a full H.264 transcode.
// A/V SYNC (measured, bench/sync-variants.js — do not change these without re-measuring):
//  - delay_moov: with plain empty_moov the mov muxer writes the header before it knows the
//    video codec delay, then shifts ONLY the copied B-frame video forward (~2 frames): audio
//    led video by 83-125ms on EVERY remux. delay_moov buffers the first fragment so it can
//    compensate properly (video first pts 0.000, audio -21ms = standard AAC priming).
//  - noaccurate_seek: with accurate seek + stream copy, video starts at the keyframe BEFORE
//    the target but audio is cut exactly AT it — the muxer then stamped both from 0, baking
//    in a desync equal to the keyframe distance (measured 3.4s!) after every skip. Keyframe
//    seek starts both tracks at the same instant, like every player does.
//  - avoid_negative_ts make_zero shifts ALL streams equally to a 0 origin (relationship
//    preserved — measured 9ms post-seek). NOTE: an earlier attempt paired make_zero with
//    aresample=async=1 and WITHOUT delay_moov — that did nothing for the real bug; the
//    aresample half must stay out.
//  - frag_duration 500ms: delay_moov waits for the first fragment; a GOP-sized fragment
//    would stall startup. Short fragments also more than HALVED time-to-first-byte.
const REMUX_SYNC_FLAGS = ['-avoid_negative_ts', 'make_zero', '-frag_duration', '500000'];
const REMUX_MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof+delay_moov';
function spawnRemux(streamUrl, { startSeconds = 0, audioTrack = 0, transcodeAudio = false } = {}) {
  const ff = detectFfmpeg();
  if (!ff) throw new Error('ffmpeg not available');
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(startSeconds > 0 ? ['-noaccurate_seek', '-ss', String(startSeconds)] : []),
    '-i', streamUrl,
    '-map', '0:v:0', '-map', `0:a:${audioTrack}?`,
    '-c:v', 'copy',                     // remux: video NEVER re-encoded here
    ...(transcodeAudio ? ['-c:a', 'aac', '-b:a', '384k', '-ac', '6'] : ['-c:a', 'copy']),
    ...REMUX_SYNC_FLAGS,
    '-movflags', REMUX_MOVFLAGS,
    '-f', 'mp4', 'pipe:1',
  ];
  return spawn(ff.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// Live IPTV ingest (HLS / raw MPEG-TS over HTTP) → fragmented MP4 the browser can play.
// Differs from file remux on three points learned from real providers:
//  - a browser-like User-Agent (providers block ffmpeg's default "Lavf"),
//  - reconnect flags (live HTTP sources hiccup),
//  - audio is RE-ENCODED to AAC stereo: TS audio is ADTS-framed (invalid in MP4 without a
//    bitstream filter) and often AC-3/MP2 which browsers can't decode anyway. Video is
//    stream-copied (H.264 in practice), so the CPU cost is trivial.
function spawnLiveRemux(url, { hlsFriendly = true } = {}) {
  const ff = detectFfmpeg();
  if (!ff) throw new Error('ffmpeg not available');
  // hlsFriendly: real providers serve HLS whose segment URLs have no media extension
  // (".../play"), which ffmpeg 8 rejects by default. These are HLS-demuxer-PRIVATE options —
  // on a non-HLS input ffmpeg hard-fails with "Option not found", so the caller retries
  // once without them (also covers older ffmpeg builds that predate extension_picky).
  return spawn(ff.path, [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'Mozilla/5.0 (SMART-TV; Linux) AppleWebKit/537.36 TriboonTV/1.0',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
    '-analyzeduration', '1000000', '-probesize', '1000000',
    ...(hlsFriendly ? ['-extension_picky', '0', '-allowed_extensions', 'ALL'] : []),
    '-i', url,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-fflags', '+genpts',
    '-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0',
    '-frag_duration', '250000',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// One JPEG frame from a local file → library thumbnail. Caller caches the output on disk.
function makeThumb(file, out, atSeconds = 120) {
  const ff = detectFfmpeg();
  if (!ff) return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = spawn(ff.path, ['-hide_banner', '-loglevel', 'error', '-ss', String(atSeconds), '-i', file,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', out], { stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 20000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (c) => { clearTimeout(t); resolve(c === 0); });
  });
}

// Extract one embedded TEXT subtitle track as WebVTT (bitmap subs like PGS can't convert).
// Note: subtitles are interleaved through the whole file, so ffmpeg reads the full stream —
// slow on big files the first time; the caller caches the result per mount+track.
function spawnSubtitleExtract(streamUrl, subTrack) {
  const ff = detectFfmpeg();
  if (!ff) throw new Error('ffmpeg not available');
  return spawn(ff.path, [
    '-hide_banner', '-loglevel', 'error',
    '-i', streamUrl,
    '-map', `0:s:${subTrack}`, '-f', 'webvtt', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

module.exports = { detectFfmpeg, detectFfprobe, detectEncoder, decidePlayback, probeTracks, spawnRemux, spawnTranscode, spawnLiveRemux, spawnSubtitleExtract, makeThumb, LADDER, audioNeedsTranscode, audioCopyOk };

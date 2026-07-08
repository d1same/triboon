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

// The next video keyframe AT-OR-AFTER `targetSec`, for the RECONNECT-resume forward-skip. A copy-remux
// (-noaccurate_seek -ss) can only START at a coded keyframe, and the fragmented (empty_moov) output is
// UNSEEKABLE in ExoPlayer (verified: isCurrentMediaItemSeekable=false) — so we can't land mid-GOP.
// Rather than rewind to the keyframe BEFORE the drop (a visible backward jump — the owner's complaint),
// the client re-mounts at the next keyframe AT-OR-AFTER it: playback resumes slightly FORWARD (≤ one
// GOP), never backward. GATED to reconnects (a ~1-2s probe); user seeks stay instant. Returns targetSec
// when none is found nearby → the client skips nothing (today's behavior, no regression).
function ffprobeKeyframeAtOrAfter(streamUrl, targetSec, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const fp = detectFfprobe();
    if (!fp || !(targetSec > 0)) return resolve(targetSec > 0 ? targetSec : 0);
    const args = ['-v', 'error', '-read_intervals', `${targetSec}%+10`,
      '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', streamUrl];
    const p = spawn(fp.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(killer); resolve(v); };
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish(targetSec); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => finish(targetSec));
    p.on('close', () => {
      let best = Infinity;
      for (const line of out.split(/\r?\n/)) {
        const t = parseFloat(line);
        if (Number.isFinite(t) && t >= targetSec - 0.02 && t < best) best = t; // smallest keyframe >= target
      }
      finish(best !== Infinity ? best : targetSec);
    });
  });
}

let _ffmpegHttpOptions; // cached protocol option help text
function supportsFfmpegHttpOption(option) {
  const ff = detectFfmpeg();
  if (!ff) return false;
  if (_ffmpegHttpOptions === undefined) {
    try {
      const r = spawnSync(ff.path, ['-hide_banner', '-h', 'protocol=http'], { timeout: 5000, windowsHide: true });
      _ffmpegHttpOptions = `${r.stdout || ''}\n${r.stderr || ''}`;
    } catch {
      _ffmpegHttpOptions = '';
    }
  }
  return new RegExp(`(^|\\s)-${option}\\s`).test(_ffmpegHttpOptions);
}

// Decide the playback method for a mount + client capabilities.
// caps: { mkv, hevc, ac3, eac3, dts } — the client's canPlayType results.
function releaseAudioProfile(name) {
  const s = String(name || '');
  return {
    truehd: /\b(true[ ._-]?hd|mlp)\b/i.test(s),
    dtsHd: /\b(dts[ ._-]?hd|dts[ ._-]?x|dtsma|dts[ ._-]?ma)\b/i.test(s),
    dts: /\bdts\b/i.test(s),
  };
}

function releaseLosslessAudioDirectOk(name, caps = {}) {
  const a = releaseAudioProfile(name);
  const passthrough = !!(caps.native && caps.passthrough);
  if (a.truehd && !(passthrough && caps.truehd)) return false;
  if (a.dtsHd && !(passthrough && caps.dtsHd)) return false;
  // Plain DTS core: the MKV-direct gate checks AC3/EAC3 decode but not DTS, so a DTS MKV on a
  // device that can't decode DTS (and can't passthrough) plays silent on direct. Remux it. Only
  // act on an EXPLICIT caps.dts === false so older clients that don't report DTS aren't over-remuxed.
  if (a.dts && !a.dtsHd && caps.dts === false && !passthrough) return false;
  return true;
}

function decidePlayback(name, caps = {}) {
  const isMp4 = /\.(mp4|m4v)$/i.test(name);
  const isWebm = /\.webm$/i.test(name);
  const isMkv = /\.(mkv|ts)$/i.test(name);
  const hasKnownContainer = isMp4 || isWebm || isMkv;
  const losslessAudioOk = releaseLosslessAudioDirectOk(name, caps);
  // MKV direct play needs MORE than container support: most MKVs carry AC3-family audio,
  // and Chromium happily claims matroska while decoding none of it — a "direct" DDP MKV
  // plays silent video. Devices with full container+audio hardware DO skip the server
  // entirely (true direct play); everything else gets the video-copy remux.
  if (isMp4 || isWebm || (isMkv && caps.mkv && caps.ac3 && caps.eac3 && losslessAudioOk)) return { method: 'direct' };
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
            profile: s.profile || '',
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
function spawnTranscode(streamUrl, { startSeconds = 0, audioTrack = 0, height = 1080, hdr = false, safeStereo = false } = {}) {
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
    // safeStereo: a plain browser <video>/MSE surface commonly plays 5.1 AAC as VIDEO-WITH-NO-AUDIO
    // (the MediaCodec PCE-layout footgun) — same reason spawnRemux downmixes. Stereo AAC-LC is reliable.
    // The native ExoPlayer path never sets safeStereo, so it keeps full 5.1 surround.
    '-c:a', 'aac', '-b:a', safeStereo ? '192k' : '256k', '-ac', safeStereo ? '2' : '6',
    ...REMUX_SYNC_FLAGS,                                  // delay_moov compensates the H.264 encoder's own B-frame delay
    '-movflags', REMUX_MOVFLAGS,
    '-f', 'mp4', 'pipe:1',
  ];
  return spawn(ff.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// Browser-decodable audio codecs (Chromium/WebView/Safari common ground). Everything else
// (ac3/eac3/dts/truehd/pcm...) stream-copied into fMP4 either hard-errors the <video> - the
// "codec not supported" toast on every DDP movie - or plays silent video on Android WebView.
const BROWSER_SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
function audioNeedsTranscode(codec) { return !BROWSER_SAFE_AUDIO.has(String(codec || '').toLowerCase()); }

// Can THIS client play the codec without re-encoding? Universal web codecs always copy;
// the AC3 family copies only when the client PROVED hardware support (canPlayType caps sent
// with the play request — e.g. a TV that decodes DDP natively → true direct audio, zero
// server CPU). Unknown codec (no probe yet): trust a broad AC3+EAC3 claim, else convert —
// a wrong "copy" is a hard playback error, a wrong "convert" is a cheap AAC pass.
function audioDescriptor(codecOrTrack) {
  if (codecOrTrack && typeof codecOrTrack === 'object') {
    return [
      codecOrTrack.codec,
      codecOrTrack.profile,
      codecOrTrack.title,
    ].filter(Boolean).join(' ').toLowerCase();
  }
  return String(codecOrTrack || '').toLowerCase();
}

function audioCopyOk(codec, caps = {}) {
  const c = audioDescriptor(codec);
  const primary = c.split(/\s+/)[0] || c;
  const passthrough = !!(caps.native && caps.passthrough);
  if (!c) return !!(caps.ac3 && caps.eac3);
  if (BROWSER_SAFE_AUDIO.has(primary)) return true;
  if (/\b(true[ ._-]?hd|mlp)\b/.test(c)) return passthrough && !!caps.truehd;
  if (/\b(dts[ ._-]?hd|dts[ ._-]?x|dtsma|dts[ ._-]?ma)\b/.test(c)) return passthrough && !!caps.dtsHd;
  if (primary === 'ac3') return !!caps.ac3;
  if (primary === 'eac3' || primary === 'eac3-joc' || c.includes('e-ac-3')) return !!(caps.eac3 || caps.eac3Joc);
  if (primary.startsWith('dts')) return !!caps.dts;
  return false; // pcm/unknown: no safe browser path; native should direct-play the source instead.
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
// safeStereo: the "audio-safe" path (multiview panes, any plain <video>/MSE surface that has no
// audio-fallback loop) must downmix to STEREO AAC-LC. 5.1 AAC is the least-compatible AAC variant
// for browser/WebView MediaCodec decoders — it commonly plays as video-with-NO-audio, which is the
// whole bug audioSafe exists to prevent. The main Android player uses native ExoPlayer (handles
// 5.1 fine), so 5.1 stays the default for the normal transcodeAudio path.
function spawnRemux(streamUrl, { startSeconds = 0, audioTrack = 0, transcodeAudio = false, safeStereo = false } = {}) {
  const ff = detectFfmpeg();
  if (!ff) throw new Error('ffmpeg not available');
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(startSeconds > 0 ? ['-noaccurate_seek', '-ss', String(startSeconds)] : []),
    '-i', streamUrl,
    '-map', '0:v:0', '-map', `0:a:${audioTrack}?`,
    '-c:v', 'copy',                     // remux: video NEVER re-encoded here
    ...(transcodeAudio
      ? ['-c:a', 'aac', '-b:a', safeStereo ? '192k' : '384k', '-ac', safeStereo ? '2' : '6']
      : ['-c:a', 'copy']),
    ...REMUX_SYNC_FLAGS,
    '-movflags', REMUX_MOVFLAGS,
    '-f', 'mp4', 'pipe:1',
  ];
  return spawn(ff.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// HLS OUTPUT VARIANT (Cast Phase 2). Same source-fit philosophy as spawnRemux — video is
// STREAM-COPIED (0 CPU) and audio is decided the same way (bit-exact copy when the client proved it
// can decode the codec, else a cheap AAC pass). The difference is the container: a VOD HLS playlist
// (fMP4 segments) written into `outDir`, which AirPlay prefers (m3u8 is its first-class format) and
// which a Custom Web Receiver's Shaka/MPL player can pull adaptively. This is a SEPARATE, feature-
// flagged path (TRIBOON_HLS); the default direct/remux/transcode ladder is untouched.
//
// Why files instead of a pipe: HLS is inherently multi-file (playlist + segments), so ffmpeg writes
// to a temp dir and the /api/hls route serves the playlist + segments over HTTP Range. hls_flags
// delete_segments keeps the on-disk footprint bounded (a rolling window) even for a long movie; the
// route re-spawns from a seek offset when the player seeks past the retained window.
function spawnHls(streamUrl, { startSeconds = 0, audioTrack = 0, transcodeAudio = false, safeStereo = false, outDir, playlistName = 'index.m3u8', segmentTime = 4 } = {}) {
  const ff = detectFfmpeg();
  if (!ff) throw new Error('ffmpeg not available');
  if (!outDir) throw new Error('spawnHls requires an output directory');
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(startSeconds > 0 ? ['-noaccurate_seek', '-ss', String(startSeconds)] : []),
    '-i', streamUrl,
    '-map', '0:v:0', '-map', `0:a:${audioTrack}?`,
    '-c:v', 'copy',                     // HLS variant: video NEVER re-encoded here (same as remux)
    ...(transcodeAudio
      ? ['-c:a', 'aac', '-b:a', safeStereo ? '192k' : '384k', '-ac', safeStereo ? '2' : '6']
      : ['-c:a', 'copy']),
    '-f', 'hls',
    '-hls_time', String(segmentTime),
    '-hls_list_size', '10',                                 // rolling window; bounds disk use
    '-hls_flags', 'delete_segments+independent_segments+temp_file',
    '-hls_segment_type', 'fmp4',                            // fMP4 segments (AirPlay + CAF friendly)
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', `${outDir.replace(/\\/g, '/')}/seg%05d.m4s`,
    '-start_number', '0',
    `${outDir.replace(/\\/g, '/')}/${playlistName}`,
  ];
  return spawn(ff.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// Live IPTV ingest (HLS / raw MPEG-TS over HTTP) → fragmented MP4 the browser can play.
// Differs from file remux on three points learned from real providers:
//  - a browser-like User-Agent (providers block ffmpeg's default "Lavf"),
//  - reconnect flags (live HTTP sources hiccup),
//  - audio is RE-ENCODED to browser-safe AAC, but channel count is not forced to stereo.
//    TS audio is ADTS-framed (invalid in MP4 without a bitstream filter) and often AC-3/MP2
//    which browsers can't decode anyway. Video is stream-copied (H.264 in practice), so the
//    CPU cost is trivial while 5.1-capable channels can stay 5.1.
function ffmpegHeaderLines(headers = {}) {
  return Object.entries(headers || {})
    .filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(String(k || ''))
      && typeof v === 'string'
      && v.trim()
      && !/[\r\n]/.test(v))
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
}

// Video output args for the browser live path. Browsers decode H.264 only, so H.264 channels are
// stream-COPIED (near-zero cost, full quality). HEVC/MPEG-2/other channels — which a browser can't
// decode — are transcoded to H.264 with a low-latency preset and capped at 1080p (4K software encode
// can't hold real-time and the browser can't do HDR anyway; native clients keep the copy path and full
// 4K). Caller passes transcodeVideo=true only for browser clients on a non-H.264 source.
function liveVideoArgs(transcodeVideo) {
  if (!transcodeVideo) return ['-c:v', 'copy'];
  return [
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-vf', "scale=-2:'min(1080,ih)'",
    '-g', '60', '-sc_threshold', '0',
    '-maxrate', '8M', '-bufsize', '16M',
  ];
}

// Fast, bounded probe of a live stream's PRIMARY video codec (lowercased codec_name) so the browser
// live path can pick copy (h264) vs transcode (hevc/mpeg2video/...). Short analyze budget + a 6s hard
// kill so it can never hang a channel open; returns '' on any failure (caller then defaults to copy).
function probeLiveVideoCodec(url, { headers = null, userAgent = null, signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(''); // client already gone → never open the connection
    const fp = detectFfprobe();
    if (!fp) return resolve('');
    const args = ['-v', 'error', '-analyzeduration', '2000000', '-probesize', '2000000'];
    const hl = ffmpegHeaderLines(headers);
    if (hl) args.push('-headers', hl);
    if (userAgent) args.push('-user_agent', userAgent);
    args.push('-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=nk=1:nw=1', url);
    let out = '', done = false, killer = null;
    const finish = (v) => { if (done) return; done = true; if (killer) clearTimeout(killer); resolve(v); };
    let p;
    // signal (AbortSignal) lets the caller kill the probe — and free the provider connection — the
    // instant the client disconnects, instead of holding it until the 6s backstop kill.
    try { p = spawn(fp.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal, killSignal: 'SIGKILL' }); }
    catch { return finish(''); }
    killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 6000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => finish(''));   // includes the AbortError when the signal fires
    p.on('close', () => finish(String(out).trim().toLowerCase()));
  });
}

function spawnLiveRemux(url, { hlsFriendly = true, headers = null, transcodeVideo = false } = {}) {
  const ff = detectFfmpeg();
  if (!ff) throw new Error('ffmpeg not available');
  const headerLines = ffmpegHeaderLines(headers);
  // hlsFriendly: real providers serve HLS whose segment URLs have no media extension
  // (".../play"), which ffmpeg 8 rejects by default. These are HLS-demuxer-PRIVATE options —
  // on a non-HLS input ffmpeg hard-fails with "Option not found", so the caller retries
  // once without them (also covers older ffmpeg builds that predate extension_picky).
  return spawn(ff.path, [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'Mozilla/5.0 (SMART-TV; Linux) AppleWebKit/537.36 TriboonTV/1.0',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
    ...(supportsFfmpegHttpOption('max_redirects') ? ['-max_redirects', '0'] : []),
    // Zap speed: 0.5s analyze budget (was 1s) lets ffmpeg commit to a standard live TS/HLS stream
    // (H.264 + AAC/AC3) sooner → faster first byte on a channel change. probesize stays 1MB so it
    // still reads enough bytes to find every track. NOTE: re-bench on a real provider before pushing
    // lower — exotic streams with late PMT/multi-audio may need more (see the bench-first rule).
    '-analyzeduration', '500000', '-probesize', '1000000',
    ...(headerLines ? ['-headers', headerLines] : []),
    ...(hlsFriendly ? ['-extension_picky', '0', '-allowed_extensions', 'ALL'] : []),
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,udp,rtp,httpproxy',
    '-i', url,
    '-map', '0:v:0?', '-map', '0:a:0?',
    ...liveVideoArgs(transcodeVideo),
    '-c:a', 'aac', '-b:a', '384k',
    '-fflags', '+genpts',
    '-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0',
    '-frag_duration', '250000',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// Remux a single continuous MPEG-TS stream that the CALLER opens (Node already followed the
// provider's redirects, pinned IPv4, and sent a browser UA — the robust opening the bare ffmpeg URL
// path can't match) and pipes in on stdin. ffmpeg never opens a URL here, so there's no provider
// redirect / Cloudflare-IPv6 / HLS-segment failure surface — it just remuxes bytes to the same fMP4
// the browser plays. This is what closes the web↔Android Live TV reliability gap.
function spawnLiveRemuxStdin({ transcodeVideo = false } = {}) {
  const ff = detectFfmpeg();
  if (!ff) throw new Error('ffmpeg not available');
  return spawn(ff.path, [
    '-hide_banner', '-loglevel', 'error',
    '-analyzeduration', '500000', '-probesize', '1000000',
    '-f', 'mpegts', '-i', 'pipe:0',
    '-map', '0:v:0?', '-map', '0:a:0?',
    ...liveVideoArgs(transcodeVideo),
    '-c:a', 'aac', '-b:a', '384k',
    '-fflags', '+genpts',
    '-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0',
    '-frag_duration', '250000',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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

// OPTIONAL: alass ("Automatic Language-Agnostic Subtitle Synchronization") for subtitle sync.
// A sidecar binary like ffmpeg/yt-dlp — absent on most boxes, so every caller gates on detection
// and degrades honestly when missing. Chosen over ffsubsync because it's a single static binary
// (no Python/numpy), runs on the Alpine image via gcompat, and its split-penalty algorithm fixes
// constant offset AND framerate drift (23.976<->25) without flags. It uses ffmpeg to read the
// reference audio, so callers must run it OFF the hot path.
let _alass; // cached: { path } | null
function detectSubSync() {
  if (_alass !== undefined) return _alass;
  for (const cand of [process.env.ALASS_PATH, 'alass', 'alass-cli'].filter(Boolean)) {
    try {
      const r = spawnSync(cand, ['--help'], { timeout: 5000, windowsHide: true });
      if (r.status === 0 || /alass|Language-Agnostic|reference-file/i.test(String(r.stdout) + String(r.stderr))) {
        _alass = { path: cand };
        return _alass;
      }
    } catch { /* try next */ }
  }
  _alass = null;
  return null;
}
// Align `inPath` (an unsynced .srt) to `refPath` and write `outPath`. The reference may be the
// playback stream URL (alass extracts audio via ffmpeg) or another subtitle file. alass auto-
// corrects both offset and framerate ratio, so no extra flags are needed.
function spawnSubSync(refPath, inPath, outPath) {
  const al = detectSubSync();
  if (!al) throw new Error('alass not available');
  const ff = detectFfmpeg();
  // alass reads ffmpeg/ffprobe from PATH or the ALASS_FFMPEG_PATH/ALASS_FFPROBE_PATH env vars.
  const env = { ...process.env };
  if (ff) env.ALASS_FFMPEG_PATH = ff.path;
  const fp = detectFfprobe();
  if (fp) env.ALASS_FFPROBE_PATH = fp.path;
  return spawn(al.path, [refPath, inPath, outPath],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
}

module.exports = { detectFfmpeg, detectFfprobe, detectEncoder, decidePlayback, probeTracks, probeLiveVideoCodec, liveVideoArgs, spawnRemux, spawnTranscode, spawnHls, spawnLiveRemux, spawnLiveRemuxStdin, spawnSubtitleExtract, detectSubSync, spawnSubSync, makeThumb, LADDER, audioNeedsTranscode, audioCopyOk, supportsFfmpegHttpOption, ffprobeKeyframeAtOrAfter };

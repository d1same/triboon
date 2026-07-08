'use strict';
// NZB parser. The NZB schema is small and regular enough for a focused parser (no deps).
// Returns { files: [{ subject, groups[], segments: [{ msgId, bytes, number }] (sorted) }] }

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

function parseNzb(xml) {
  const files = [];
  const fileRe = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
  let fm;
  while ((fm = fileRe.exec(xml))) {
    const attrs = fm[1];
    const body = fm[2];
    const subjM = /subject="([^"]*)"/i.exec(attrs);
    const subject = subjM ? decodeEntities(subjM[1]) : '';

    const groups = [];
    const groupRe = /<group>([\s\S]*?)<\/group>/gi;
    let gm;
    while ((gm = groupRe.exec(body))) groups.push(decodeEntities(gm[1]).trim());

    const segments = [];
    const segRe = /<segment\b([^>]*)>([\s\S]*?)<\/segment>/gi;
    let sm;
    while ((sm = segRe.exec(body))) {
      const bytesM = /bytes="(\d+)"/i.exec(sm[1]);
      const numM = /number="(\d+)"/i.exec(sm[1]);
      segments.push({
        msgId: decodeEntities(sm[2]).trim(),
        bytes: bytesM ? parseInt(bytesM[1], 10) : 0,
        number: numM ? parseInt(numM[1], 10) : segments.length + 1,
      });
    }
    segments.sort((a, b) => a.number - b.number);
    files.push({ subject, groups, segments });
  }
  if (!files.length) throw new Error('NZB parse: no <file> entries found');
  return { files };
}

// Heuristics: pick the file most likely to be the playable payload.
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|webm|mov)("|\s|$)/i;
// Audiobooks (loose audio files) get a smaller boost so the mounted primary is an AUDIO file, not a
// stray cover image / PDF / bonus file — while video still outranks audio (×10) for movies/TV.
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav)("|\s|$)/i;
// Does a raw file subject/name name a specific SxxEyy (tolerant of scene separators)? The \b after
// the episode number stops S05 from matching S050, and e0? absorbs a zero-padded "E05".
function episodeInName(name, s, e) {
  if (!Number.isInteger(+s) || !Number.isInteger(+e)) return false;
  try { return new RegExp(`\\b(s0?${+s}[ ._-]?e0?${+e}|${+s}x0?${+e})\\b`, 'i').test(String(name || '')); }
  catch { return false; }
}
// opts.wantedEpisode {s,e}: for a TV episode play against a loose-file SEASON PACK, pick the video file
// that matches the requested SxxEyy instead of merely the largest — so "play S02E05" mounts E05, not
// E01/the biggest file. A no-op for a single-file movie NZB (no wantedEpisode / nothing matches) and
// for a single RAR-set pack (episodes live inside the archive → handled by pickInner, a follow-up).
function pickPrimaryFile(nzb, opts = {}) {
  const we = opts.wantedEpisode;
  const scored = nzb.files.map((f) => {
    const size = f.segments.reduce((s, x) => s + x.bytes, 0);
    let score = size;
    if (VIDEO_EXT.test(f.subject)) score *= 10;
    else if (AUDIO_EXT.test(f.subject)) score *= 5;
    if (/\.par2/i.test(f.subject)) score = -1;
    if (/\.(nfo|sfv|srr|jpg|png)/i.test(f.subject)) score = -1;
    if (we && VIDEO_EXT.test(f.subject) && episodeInName(f.subject, we.s, we.e)) score += 1e15;
    return { f, size, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].f;
}

// Extract a filename from a usenet subject line, e.g.:  blah "Movie.2024.mkv" yEnc (1/50)
function fileNameFromSubject(subject) {
  const q = /"([^"]+)"/.exec(subject);
  if (q) return q[1];
  const m = /([\w.\-\[\]() ]+\.\w{2,4})/.exec(subject);
  return m ? m[1] : subject.slice(0, 60);
}

// Obfuscation services sometimes ship the archive password inside the NZB itself.
function nzbPassword(xml) {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(xml);
  if (!head) return null;
  const m = /<meta\s+type="password"\s*>([\s\S]*?)<\/meta>/i.exec(head[1]);
  return m ? decodeEntities(m[1]).trim() : null;
}

module.exports = { parseNzb, pickPrimaryFile, fileNameFromSubject, nzbPassword, AUDIO_EXT };

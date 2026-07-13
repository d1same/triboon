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
const SELECTION_JUNK_EXT = /\.(par2|nfo|sfv|srr|srt|sub|idx|txt|jpg|jpeg|png)("|\s|$)/i;
// Does a raw file subject/name name a specific SxxEyy (tolerant of scene separators)? JavaScript's
// \b treats underscore as a word character, so use explicit ASCII-alphanumeric boundaries: common
// pack members such as Show_S02E05_1080p.mkv must match without letting S02E05x/S02E050 match.
function episodeInName(name, s, e) {
  if (!Number.isInteger(+s) || !Number.isInteger(+e)) return false;
  try {
    const value = String(name || '');
    if (new RegExp(`(?:^|[^a-z0-9])(?:s0?${+s}[ ._-]?e0?${+e}|${+s}x0?${+e})(?=$|[^a-z0-9])`, 'i')
      .test(value)) return true;
    // A single payload may intentionally cover an episode range (S02E05-E06 / S02E05E06).
    // releaseMatches accepts such sources, so payload selection must honor the same contract.
    const ranges = value.matchAll(/(?:^|[^a-z0-9])s0?(\d{1,2})[ ._-]?e0?(\d{1,3})[ ._-]*(?:s0?(\d{1,2})[ ._-]?)?e0?(\d{1,3})(?=$|[^a-z0-9])/ig);
    for (const match of ranges) {
      const startSeason = +match[1];
      const endSeason = match[3] == null ? startSeason : +match[3];
      const startEpisode = +match[2];
      const endEpisode = +match[4];
      if (startSeason === +s && endSeason === +s && startEpisode <= +e && +e <= endEpisode) return true;
    }
    return false;
  }
  catch { return false; }
}

// True when a filename identifies ANY concrete episode. This is deliberately separate from
// episodeInName(): when S02E05 is requested, a lone opaque "8f3c.mkv" remains a valid
// single-payload fallback, but an explicitly named S02E04 (or several opaque videos) must never be
// guessed as E05.
function episodeLikeName(name) {
  return /(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{1,3})(?=$|[^a-z0-9])/i
    .test(String(name || ''));
}

function episodeSelectionError(wantedEpisode, reason) {
  const s = String(Number(wantedEpisode && wantedEpisode.s)).padStart(2, '0');
  const e = String(Number(wantedEpisode && wantedEpisode.e)).padStart(2, '0');
  const err = new Error(`requested episode S${s}E${e} ${reason}`);
  err.code = 'EPISODE_SELECTION';
  return err;
}
// opts.wantedEpisode {s,e}: for a TV episode play against a loose-file SEASON PACK, pick the video file
// that matches the requested SxxEyy instead of merely the largest — so "play S02E05" mounts E05, not
// E01/the biggest file. Movies (no wantedEpisode) keep the original size heuristic; a single opaque
// payload keeps the obfuscation fallback, while mismatched/ambiguous packs reject for auto-advance.
function pickPrimaryFile(nzb, opts = {}) {
  const we = opts.wantedEpisode;
  const scored = nzb.files.map((f) => {
    const name = fileNameFromSubject(f.subject);
    const size = f.segments.reduce((s, x) => s + x.bytes, 0);
    let score = size;
    if (VIDEO_EXT.test(f.subject)) score *= 10;
    else if (AUDIO_EXT.test(f.subject)) score *= 5;
    if (/\.par2/i.test(f.subject)) score = -1;
    if (/\.(nfo|sfv|srr|jpg|png)/i.test(f.subject)) score = -1;
    if (we && VIDEO_EXT.test(f.subject) && episodeInName(f.subject, we.s, we.e)) score += 1e15;
    return { f, name, size, score };
  }).sort((a, b) => b.score - a.score);

  if (we) {
    const nonJunk = scored.filter(({ f, name }) => !SELECTION_JUNK_EXT.test(f.subject)
      && !/\bsample\b/i.test(name));
    const namedVideos = nonJunk.filter(({ f }) => VIDEO_EXT.test(f.subject));
    // Prefer recognized video extensions when present; otherwise treat the remaining non-junk
    // entries as opaque payloads so one hash-named .bin still works but two cannot be guessed.
    const payloads = namedVideos.length ? namedVideos : nonJunk;
    const exact = payloads.filter(({ name }) => episodeInName(name, we.s, we.e));
    if (exact.length === 1) return exact[0].f;
    if (exact.length > 1) throw episodeSelectionError(we, 'is ambiguous (multiple matching payloads)');
    // Obfuscated single-file posts cannot prove episode identity from the filename. Preserve the
    // long-standing fallback only when there is exactly one plausible payload and it does NOT name a
    // different episode. Anything else is unsafe to guess and must advance to another release.
    if (payloads.length === 1 && !episodeLikeName(payloads[0].name)) return payloads[0].f;
    if (payloads.length) throw episodeSelectionError(we, 'is not uniquely present in this release');
  }
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

module.exports = {
  parseNzb, pickPrimaryFile, fileNameFromSubject, nzbPassword, AUDIO_EXT,
  episodeInName, episodeLikeName, episodeSelectionError,
};

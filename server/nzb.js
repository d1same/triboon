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
function pickPrimaryFile(nzb) {
  const scored = nzb.files.map((f) => {
    const size = f.segments.reduce((s, x) => s + x.bytes, 0);
    let score = size;
    if (VIDEO_EXT.test(f.subject)) score *= 10;
    if (/\.par2/i.test(f.subject)) score = -1;
    if (/\.(nfo|sfv|srr|jpg|png)/i.test(f.subject)) score = -1;
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

module.exports = { parseNzb, pickPrimaryFile, fileNameFromSubject, nzbPassword };

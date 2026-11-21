'use strict';
// Brief 143: the file's own TEXT subtitles for the remux/transcode viewers (browser, phone, TV).
//
// A remux carries no subtitle stream, and ffmpeg holds a subtitle line until a later packet when a
// picture output runs beside it (measured: a line arrived when the next one was read). So the server
// reads the subtitle blocks itself, straight out of the Matroska bytes that already pass through
// /api/stream on their way to the remux: no extra read, nothing added to the picture path, and a
// line is known the moment ffmpeg reads it. A local file (ffmpeg reads it from disk) is read ahead
// of the picture by readLocalAhead (the OS cache serves the remux the same pages).
//
// Zero dependencies. Text tracks only: S_TEXT/UTF8 (SRT), S_TEXT/ASS, S_TEXT/SSA, S_TEXT/WEBVTT.
// A track's place among the file's subtitle tracks is ffmpeg's 0:s:N, which is the probe's `rel`.

const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Info: 0x1549A966, TimecodeScale: 0x2AD7B1,
  Duration: 0x4489, Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86,
  Language: 0x22B59C, Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
  BlockDuration: 0x9B, ContentEncodings: 0x6D80, Cues: 0x1C53BB6B, Tags: 0x1254C367, Chapters: 0x1043A770, Attachments: 0x1941A469, Void: 0xEC, Crc32: 0xBF,
};
const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);
const TEXT_CODECS = new Set(['S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/WEBVTT', 'S_TEXT/ASCII']);
const MAX_CUES_PER_TRACK = 30000;
// Lines are kept per mount for its life: capped by size too (one block can be 4 MB; second check 3.5.7).
const MAX_CUE_BYTES_PER_TRACK = 8 * 1048576;
const MAX_CURSORS = 6;
const CLUSTER_MAGIC = Buffer.from([0x1F, 0x43, 0xB6, 0x75]);

// Element id: the leading 1 bits stay in the value (Matroska ids are written that way).
function readId(buf, pos) {
  if (pos >= buf.length) return null;
  const b = buf[pos];
  let len = 1;
  while (len <= 4 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 4) return { bad: true };
  if (pos + len > buf.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return { value: v, len };
}
// Size: the marker bit removed; all ones means "unknown size".
function readSize(buf, pos) {
  if (pos >= buf.length) return null;
  const b = buf[pos];
  let len = 1;
  while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 8) return { bad: true };
  if (pos + len > buf.length) return null;
  let v = b & (0xFF >> len);
  let allOnes = v === (0xFF >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + buf[pos + i]; if (buf[pos + i] !== 0xFF) allOnes = false; }
  return { value: allOnes ? Infinity : v, len };
}
// Sizes come from the file: a length over 8 bytes, or past the bytes on hand, is a broken element.
// Looping on it froze the whole server (an "unknown" size is Infinity; second check 3.5.7).
function readUint(buf, start, len) {
  if (!(len >= 0) || len > 8 || !(start >= 0) || start + len > buf.length) return 0;
  let v = 0; for (let i = 0; i < len; i++) v = v * 256 + buf[start + i]; return v;
}
// A child element that does not fit inside its parent ends that parent's walk.
function childFits(id, size, at, end) {
  return !!(id && !id.bad && size && !size.bad && size.value !== Infinity && at + size.value <= end);
}

// Info + Tracks from the bytes at the start of the file. Returns null until enough bytes are there.
function parseHeader(buf) {
  if (buf.length < 4 || buf.readUInt32BE(0) !== ID.EBML) return { notMkv: true };
  let pos = 0;
  const ebml = readId(buf, 0); const es = readSize(buf, ebml.len);
  if (!es || es.bad) return null;
  pos = ebml.len + es.len + es.value;
  const seg = readId(buf, pos); if (!seg) return null;
  if (seg.bad || seg.value !== ID.Segment) return { notMkv: true };
  const ss = readSize(buf, pos + seg.len); if (!ss) return null;
  pos += seg.len + ss.len;
  let scale = 1000000; let duration = 0; let tracks = null;
  while (pos < buf.length) {
    const id = readId(buf, pos); if (!id || id.bad) return null;
    const sz = readSize(buf, pos + id.len); if (!sz || sz.bad) return null;
    const body = pos + id.len + sz.len;
    if (id.value === ID.Cluster) break;
    if (sz.value === Infinity) return null;
    if (id.value === ID.Info || id.value === ID.Tracks) {
      if (body + sz.value > buf.length) return null;
      if (id.value === ID.Info) {
        for (let p = body; p < body + sz.value;) {
          const cid = readId(buf, p); const cs = cid && !cid.bad ? readSize(buf, p + cid.len) : null;
          const cb = cs ? p + cid.len + cs.len : NaN;
          if (!childFits(cid, cs, cb, body + sz.value)) break;
          if (cid.value === ID.TimecodeScale) scale = readUint(buf, cb, cs.value) || scale;
          if (cid.value === ID.Duration) duration = cs.value === 8 ? buf.readDoubleBE(cb) : cs.value === 4 ? buf.readFloatBE(cb) : 0;
          p = cb + cs.value;
        }
      } else {
        tracks = [];
        for (let p = body; p < body + sz.value;) {
          const tid = readId(buf, p); const ts = tid && !tid.bad ? readSize(buf, p + tid.len) : null;
          const tb = ts ? p + tid.len + ts.len : NaN;
          if (!childFits(tid, ts, tb, body + sz.value)) break;
          if (tid.value === ID.TrackEntry) {
            const t = { number: 0, type: 0, codec: '', lang: 'eng', encoded: false };
            for (let q = tb; q < tb + ts.value;) {
              const fid = readId(buf, q); const fs = fid && !fid.bad ? readSize(buf, q + fid.len) : null;
              const fb = fs ? q + fid.len + fs.len : NaN;
              if (!childFits(fid, fs, fb, tb + ts.value)) break;
              if (fid.value === ID.TrackNumber) t.number = readUint(buf, fb, fs.value);
              else if (fid.value === ID.TrackType) t.type = readUint(buf, fb, fs.value);
              else if (fid.value === ID.CodecID) t.codec = buf.toString('latin1', fb, fb + fs.value).replace(/\0+$/, '');
              else if (fid.value === ID.Language) t.lang = buf.toString('latin1', fb, fb + fs.value).replace(/\0+$/, '');
              // Compressed (zlib) or header-stripped blocks are not plain text: the client goes online.
              else if (fid.value === ID.ContentEncodings) t.encoded = true;
              q = fb + fs.value;
            }
            tracks.push(t);
          }
          p = tb + ts.value;
        }
      }
    }
    if (tracks && scale) break;
    pos = body + sz.value;
  }
  if (!tracks) return null;
  const subs = tracks.filter((t) => t.type === 0x11);
  return {
    scale, duration: duration * scale / 1e9,
    // ffmpeg's 0:s:N order is the order of the subtitle track entries.
    subs: subs.map((t, i) => ({ index: i, number: t.number, codec: t.codec, lang: t.lang, text: TEXT_CODECS.has(t.codec) && !t.encoded })),
  };
}

function cueText(codec, payload) {
  let s = payload.toString('utf8').replace(/\0+$/, '');
  if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA') {
    // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    let cut = 0;
    for (let i = 0; i < 8 && cut >= 0; i++) cut = s.indexOf(',', cut) + 1 || -1;
    s = cut > 0 ? s.slice(cut) : s;
    s = s.replace(/\{[^}]*\}/g, '').replace(/\\N|\\n/g, '\n').replace(/\\h/g, ' ');
  }
  s = s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  return s.replace(/-->/g, '→');
}

class MkvSubtitleTap {
  constructor() {
    this.header = null;      // parseHeader() result once known
    this.notMkv = false;
    this.head = Buffer.alloc(0);
    this.cues = new Map();   // subtitle index -> Map(key -> cue)
    this.cueBytes = new Map(); // subtitle index -> text bytes kept
    this.cursors = [];       // contiguous readers: { next, buf, skip, inCluster, clusterEnd, tc, pending }
    this.maxTime = 0;        // the latest cluster time seen (for the local reader)
  }
  // The first and last cluster times the reader that has read up to `offset` has seen (null before any).
  timesAt(offset) {
    const c = this.cursors.find((x) => x.next === offset);
    return c && c.firstSec != null ? { first: c.firstSec, last: c.lastSec } : null;
  }
  textIndex(number) {
    if (!this.header) return -1;
    const t = this.header.subs.find((s) => s.number === number);
    return t && t.text ? t.index : -1;
  }
  // Bytes [offset, offset + chunk.length) of the file, as any reader read them. Never throws.
  feed(offset, chunk) {
    try { this._feed(offset, chunk); } catch { /* a malformed spot only costs its lines */ }
  }
  _feed(offset, chunk) {
    if (this.notMkv || !chunk || !chunk.length) return;
    if (!this.header && offset <= this.head.length && offset + chunk.length > this.head.length && this.head.length < 8 * 1048576) {
      this.head = Buffer.concat([this.head, chunk.subarray(this.head.length - offset)]);
      const h = parseHeader(this.head);
      if (h && h.notMkv) { this.notMkv = true; this.cursors = []; return; }
      if (h) { this.header = h; this.head = Buffer.alloc(0); }
    }
    if (!this.header) return;
    let cur = this.cursors.find((c) => c.next === offset);
    if (!cur) {
      cur = { next: offset, pos: offset, buf: Buffer.alloc(0), skip: 0, sync: true, clusterEnd: Infinity, tc: 0, inCluster: false };
      this.cursors.push(cur);
      if (this.cursors.length > MAX_CURSORS) this.cursors.shift();
    }
    cur.next = offset + chunk.length;
    this._run(cur, chunk);
  }
  _run(cur, chunk) {
    let data = chunk;
    if (cur.skip > 0) {
      const n = Math.min(cur.skip, data.length);
      cur.skip -= n; cur.pos += n; data = data.subarray(n);
      if (!data.length) return;
    }
    let buf = cur.buf.length ? Buffer.concat([cur.buf, data]) : data;
    let p = 0;
    const take = (n) => { p += n; cur.pos += n; };
    for (;;) {
      if (cur.sync) {
        const i = buf.indexOf(CLUSTER_MAGIC, p);
        if (i < 0) { const keep = Math.max(p, buf.length - 3); cur.pos += keep - p; p = keep; break; }
        take(i - p); cur.sync = false; cur.inCluster = false; cur.fromSync = true;
      }
      if (cur.inCluster && cur.pos >= cur.clusterEnd) cur.inCluster = false;
      const id = readId(buf, p); if (!id) break;
      if (id.bad) { cur.sync = true; take(1); continue; }
      const sz = readSize(buf, p + id.len); if (!sz) break;
      if (sz.bad) { cur.sync = true; take(1); continue; }
      const hl = id.len + sz.len;
      if (id.value === ID.Cluster) {
        take(hl); cur.inCluster = true; cur.tc = 0; cur.needTc = !!cur.fromSync; cur.fromSync = false;
        cur.clusterEnd = sz.value === Infinity ? Infinity : cur.pos + sz.value;
        continue;
      }
      if (!cur.inCluster || (cur.clusterEnd === Infinity && LEVEL1.has(id.value))) {
        cur.inCluster = false;
        if (id.value === ID.Segment) { take(hl); continue; }
        if (sz.value === Infinity) { cur.sync = true; take(1); continue; }
        // Another level-1 element (Cues, Tags, attachments...): step over it.
        take(hl); const avail = buf.length - p; const n = Math.min(sz.value, avail);
        take(n); if (n < sz.value) { cur.skip = sz.value - n; }
        if (cur.skip) break; continue;
      }
      // Found by searching: a real cluster starts with its Timecode, a match inside picture data rarely does.
      // (A CRC-32 or Void element may come first.)
      if (cur.needTc && id.value !== ID.Timecode && id.value !== ID.Crc32 && id.value !== ID.Void) { cur.needTc = false; cur.sync = true; cur.inCluster = false; continue; }
      if (id.value === ID.Timecode) cur.needTc = false;
      if (id.value === ID.Timecode) {
        if (p + hl + sz.value > buf.length) break;
        cur.tc = readUint(buf, p + hl, sz.value); take(hl + sz.value);
        const sec = cur.tc * this.header.scale / 1e9;
        this.maxTime = Math.max(this.maxTime, sec);
        if (cur.firstSec == null) cur.firstSec = sec;
        cur.lastSec = sec;
        continue;
      }
      if (id.value === ID.SimpleBlock || id.value === ID.BlockGroup) {
        // Look at the block's track first; anything but a text track is stepped over unread.
        let track = -1;
        if (id.value === ID.SimpleBlock) {
          const t = readSize(buf, p + hl); if (!t) break; track = t.value;
        } else {
          const bid = readId(buf, p + hl); if (!bid) break;
          const bs = bid.bad ? null : readSize(buf, p + hl + bid.len); if (!bid.bad && !bs) break;
          if (!bid.bad && bid.value === ID.Block) { const t = readSize(buf, p + hl + bid.len + bs.len); if (!t) break; track = t.value; }
        }
        const idx = track >= 0 ? this.textIndex(track) : -1;
        if (idx < 0) {
          take(hl); const avail = buf.length - p; const n = Math.min(sz.value, avail);
          take(n); if (n < sz.value) { cur.skip = sz.value - n; break; }
          continue;
        }
        if (p + hl + sz.value > buf.length) {
          if (sz.value > 4 * 1048576) { cur.sync = true; take(1); continue; }
          break; // wait for the whole (small) text block
        }
        this._textBlock(id.value, buf.subarray(p + hl, p + hl + sz.value), cur.tc, idx);
        take(hl + sz.value);
        continue;
      }
      // Any other cluster child (BlockAdditions, Void, Position...): step over it.
      if (sz.value === Infinity) { cur.sync = true; take(1); continue; }
      take(hl); const avail = buf.length - p; const n = Math.min(sz.value, avail);
      take(n); if (n < sz.value) { cur.skip = sz.value - n; break; }
    }
    cur.buf = p < buf.length ? Buffer.from(buf.subarray(p)) : Buffer.alloc(0);
    if (cur.buf.length > 8 * 1048576) { cur.buf = Buffer.alloc(0); cur.sync = true; }
  }
  _textBlock(kind, body, clusterTc, idx) {
    let block = body; let dur = 0;
    if (kind === ID.BlockGroup) {
      block = null;
      for (let q = 0; q < body.length;) {
        const cid = readId(body, q); if (!cid || cid.bad) break;
        const cs = readSize(body, q + cid.len); if (!cs || cs.bad || cs.value === Infinity) break;
        const cb = q + cid.len + cs.len;
        if (cid.value === ID.Block) block = body.subarray(cb, cb + cs.value);
        else if (cid.value === ID.BlockDuration) dur = readUint(body, cb, cs.value);
        q = cb + cs.value;
      }
      if (!block) return;
    }
    const tn = readSize(block, 0); if (!tn || tn.bad || block.length < tn.len + 3) return;
    const rel = block.readInt16BE(tn.len);
    const flags = block[tn.len + 2];
    if (flags & 0x06) return; // laced text blocks do not occur in practice
    const scale = this.header.scale;
    const start = (clusterTc + rel) * scale / 1e9;
    const end = dur > 0 ? start + dur * scale / 1e9 : start + 4;
    const track = this.header.subs[idx];
    const text = cueText(track.codec, block.subarray(tn.len + 3));
    if (!text) return;
    let m = this.cues.get(idx);
    if (!m) { m = new Map(); this.cues.set(idx, m); }
    if (m.size >= MAX_CUES_PER_TRACK) return;
    const bytes = this.cueBytes.get(idx) || 0;
    if (bytes + text.length > MAX_CUE_BYTES_PER_TRACK) return;
    const key = `${start.toFixed(3)}|${text}`;
    if (!m.has(key)) { m.set(key, { start, end, text }); this.cueBytes.set(idx, bytes + text.length); }
  }
  // The track's lines so far as WebVTT, on the movie's own clock.
  vtt(index) {
    const m = this.cues.get(index);
    const list = m ? [...m.values()].sort((a, b) => a.start - b.start || a.end - b.end) : [];
    const t = (x) => {
      const ms = Math.max(0, Math.round(x * 1000));
      const h = Math.floor(ms / 3600000); const mi = Math.floor(ms / 60000) % 60; const s = Math.floor(ms / 1000) % 60;
      return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    };
    return 'WEBVTT\n\n' + list.map((c) => `${t(c.start)} --> ${t(c.end)}\n${c.text}\n`).join('\n');
  }
}

module.exports = { MkvSubtitleTap, parseHeader, cueText, readId, readSize };

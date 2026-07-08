'use strict';
// Archive-aware mounting: NZB → volume set → container detection → inner-file extent map →
// a seekable virtual file over the STORED bytes. Containers we can't stream yet (compressed,
// encrypted, 7z) still mount, but are honest: streamable=false plus verdict tags so the
// ranking/picker can 🐢-tag or skip them.

const crypto = require('crypto');
const { parseNzb, fileNameFromSubject, pickPrimaryFile, nzbPassword } = require('./nzb');
const { NzbFileStream } = require('./vfs');
const { parseRarVolumes, RAR4_SIG, RAR5_SIG } = require('./rar');
const { parseZip } = require('./zip');

const SIG_7Z = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|webm|mov)$/i;
const JUNK_EXT = /\.(par2|nfo|sfv|srr|srt|sub|idx|txt|jpg|png|sample)$/i;
const TEXT_SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

function detectContainer(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(RAR5_SIG)) return 'rar5';
  if (buf.length >= 7 && buf.subarray(0, 7).equals(RAR4_SIG)) return 'rar4';
  if (buf.length >= 6 && buf.subarray(0, 6).equals(SIG_7Z)) return '7z';
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return 'zip';
  return null;
}

// Classify a filename as an archive volume. Returns { base, key } or null.
// Old WinRAR scheme rolls over past .r99 to .s00, .t00, … so a volume's order is
// (letter-'r')*100 + NN + 1; .rar is always first (key 0). New scheme: .partN.rar → N.
function volumeKey(name) {
  const n = name.toLowerCase();
  let m;
  if ((m = /^(.*)\.part(\d+)\.rar$/.exec(n))) return { base: m[1], key: parseInt(m[2], 10) };
  if ((m = /^(.*)\.([r-z])(\d{2})$/.exec(n))) {
    return { base: m[1], key: (m[2].charCodeAt(0) - 0x72) * 100 + parseInt(m[3], 10) + 1 };
  }
  // Numbered splits (.7z.001, .zip.001, …) — common for obfuscated posts. Without this they
  // fell through to mountFlat and streamed raw archive bytes as if they were video.
  if ((m = /^(.*\.(?:7z|zip|rar))\.(\d{2,4})$/.exec(n))) return { base: m[1], key: parseInt(m[2], 10) };
  if ((m = /^(.*)\.(rar|zip|7z)$/.exec(n))) return { base: m[1], key: 0 };
  return null;
}

// From a list of { name, … }, return the ordered volume files of the dominant archive set
// (largest total bytes, then most members). Non-volume and junk files fall away naturally.
function orderVolumes(files) {
  const sets = new Map();
  for (const f of files) {
    if (JUNK_EXT.test(f.name)) continue;
    const k = volumeKey(f.name);
    if (!k) continue;
    if (!sets.has(k.base)) sets.set(k.base, []);
    sets.get(k.base).push({ f, key: k.key });
  }
  let best = null;
  for (const members of sets.values()) {
    const bytes = members.reduce((s, m) => s + (m.f.bytes || 0), 0);
    if (!best || bytes > best.bytes || (bytes === best.bytes && members.length > best.members.length)) {
      best = { members, bytes };
    }
  }
  if (!best) return [];
  return best.members.sort((a, b) => a.key - b.key).map((m) => m.f);
}

// Pick the playable inner file: video extension wins, then size; junk never wins. Sample
// clips are video-extension files too ("…-sample.mkv") — they only win when NOTHING else
// is playable, and the pipeline then refuses the mount by name.
function pickInner(files) {
  const scored = files
    .map((f) => ({ f, score: (JUNK_EXT.test(f.name) || /\bsample\b/i.test(f.name) ? -1 : f.size) * (VIDEO_EXT.test(f.name) ? 10 : 1) }))
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].f : null;
}

function releaseSubExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function releaseSubLanguage(name) {
  const n = String(name || '').toLowerCase();
  const token = (re, lang) => (re.test(n) ? lang : '');
  return token(/(?:^|[.\s_-])(en|eng|english)(?:[.\s_-]|$)/, 'eng')
    || token(/(?:^|[.\s_-])(es|spa|spanish)(?:[.\s_-]|$)/, 'spa')
    || token(/(?:^|[.\s_-])(fr|fre|fra|french)(?:[.\s_-]|$)/, 'fra')
    || token(/(?:^|[.\s_-])(de|ger|deu|german)(?:[.\s_-]|$)/, 'deu')
    || token(/(?:^|[.\s_-])(it|ita|italian)(?:[.\s_-]|$)/, 'ita')
    || token(/(?:^|[.\s_-])(pt|por|portuguese)(?:[.\s_-]|$)/, 'por')
    || '';
}

function releaseSubFlags(name) {
  const n = String(name || '').toLowerCase();
  return {
    forced: /(?:^|[.\s_-])forced(?:[.\s_-]|$)/.test(n),
    sdh: /(?:^|[.\s_-])(sdh|hi|hearing[.\s_-]?impaired)(?:[.\s_-]|$)/.test(n),
  };
}

function releaseSubScore(sub, videoName = '') {
  const name = String(sub.name || '');
  const ext = releaseSubExt(name);
  let s = ext === 'srt' ? 60 : ext === 'vtt' ? 55 : 35;
  const flags = releaseSubFlags(name);
  if (flags.forced) s -= 8;
  if (flags.sdh) s -= 4;
  const base = String(videoName || '').replace(/\.[^.]+$/, '').toLowerCase();
  const subBase = name.replace(/\.[^.]+$/, '').toLowerCase();
  if (base && subBase.includes(base)) s += 40;
  if (releaseSubLanguage(name) === 'eng') s += 10;
  return s;
}

function publicReleaseSub(sub, idx, videoName) {
  const flags = releaseSubFlags(sub.name);
  return {
    id: `r${idx}`,
    name: sub.name,
    ext: releaseSubExt(sub.name),
    lang: releaseSubLanguage(sub.name),
    forced: flags.forced,
    sdh: flags.sdh,
    size: sub.size || sub.bytes || 0,
    score: releaseSubScore(sub, videoName),
    source: 'release',
  };
}

function releaseSubCandidates(files, videoName = '') {
  return (files || [])
    .filter((f) => f && TEXT_SUB_EXT.test(f.name || '') && String(f.name || '') !== String(videoName || ''))
    .filter((f) => !f.method || (f.method === 'store' && !f.encrypted))
    .map((f, idx) => ({ ...publicReleaseSub(f, idx, videoName), _source: f }))
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
}

class ArchiveVirtualFile {
  constructor({ vols, inner, container, method, streamable, tags, password, releaseSubs = [], audioFiles = null }) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.vols = vols;
    this.container = container;
    this.method = method;
    this.streamable = streamable;
    this.tags = tags;
    this.password = password;
    this.name = inner ? inner.name : vols[0].name;
    this.size = inner ? inner.size : vols.reduce((s, v) => s + v.size, 0);
    this.health = { verdict: 'unverified', checkedAt: null, missing: 0, sampled: 0 };
    this.segmentCount = vols.reduce((s, v) => s + v.segments.length, 0);
    this.releaseSubs = releaseSubs;
    // Multi-file audiobook packed INSIDE the archive: the ordered inner audio tracks. One mount serves
    // any track by index via audioStreamAt() (a lightweight ArchiveVirtualFile over that inner file's
    // already-known extents — no re-mount). Absent for single-file archives.
    this.audioFiles = audioFiles;
    if (audioFiles) this._audioStreams = new Map();

    // Cumulative extent table for O(log n) seek: inner offset → (volume, volume offset).
    this.extents = [];
    if (inner) {
      let pos = 0;
      for (const e of inner.extents) {
        this.extents.push({ innerStart: pos, vol: e.vol, offset: e.offset, length: e.length });
        pos += e.length;
      }
      this.mappedBytes = pos;
    }
  }

  cancelReadAhead() {
    for (const v of this.vols) {
      if (v && typeof v.cancelReadAhead === 'function') v.cancelReadAhead();
    }
  }

  async *read(start, end, opts = {}) {
    if (!this.streamable) throw new Error(`mount is not streamable (${this.tags.join(', ')})`);
    end = Math.min(end, this.size);
    // Binary search the first extent containing `start`.
    let lo = 0, hi = this.extents.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.extents[mid];
      if (start < e.innerStart) hi = mid - 1;
      else if (start >= e.innerStart + e.length) lo = mid + 1;
      else { idx = mid; break; }
    }
    let offset = start;
    while (offset < end && idx < this.extents.length) {
      const e = this.extents[idx];
      const from = e.offset + (offset - e.innerStart);
      const take = Math.min(e.innerStart + e.length, end) - offset;
      yield* this.vols[e.vol].read(from, from + take, opts);
      offset += take;
      idx++;
    }
  }

  // Health triage across ALL volumes: first + last + random middle segments of the whole set.
  async triage(sampleCount = 6) {
    const all = [];
    for (const v of this.vols) for (const s of v.segments) all.push(s);
    const idxs = new Set([0, all.length - 1]);
    while (idxs.size < Math.min(sampleCount, all.length)) {
      idxs.add(Math.floor(Math.random() * all.length));
    }
    const results = await Promise.all(
      [...idxs].map((i) => this.vols[0].pool.stat(all[i].msgId, 'health').catch(() => false))
    );
    const missing = results.filter((ok) => !ok).length;
    this.health = {
      verdict: missing === 0 ? 'verified' : missing >= results.length / 2 ? 'blocked' : 'degraded',
      missing,
      sampled: results.length,
      checkedAt: new Date().toISOString(),
    };
    return this.health;
  }

  // Stream one inner audio TRACK (by index) — a light ArchiveVirtualFile over its extents, reused
  // across Range requests. Same shape as the flat mount's audioStreamAt so H.audioTrack is unchanged.
  async audioStreamAt(index) {
    const track = (this.audioFiles || [])[index];
    if (!track || !track._source) { const e = new Error('audio track not found'); e.status = 404; throw e; }
    let vf = this._audioStreams.get(index);
    if (!vf) {
      vf = new ArchiveVirtualFile({
        vols: this.vols, inner: track._source, container: this.container,
        method: track._source.method || this.method, streamable: true, tags: [], password: this.password,
      });
      this._audioStreams.set(index, vf);
    }
    vf._touched = Date.now();
    return vf;
  }

  async readReleaseSub(id, maxBytes = 5 * 1024 * 1024) {
    const sub = (this.releaseSubs || []).find((s) => String(s.id) === String(id));
    if (!sub || !sub._source || !sub._source.extents) throw new Error('release subtitle not found');
    if ((sub.size || 0) > maxBytes) throw new Error('release subtitle is too large');
    const vf = new ArchiveVirtualFile({
      vols: this.vols,
      inner: sub._source,
      container: this.container,
      method: sub._source.method || this.method,
      streamable: true,
      tags: [],
      password: this.password,
    });
    const chunks = [];
    for await (const c of vf.read(0, vf.size, { priority: 'playback' })) chunks.push(c);
    return Buffer.concat(chunks);
  }
}

// Mount any NZB: flat post, RAR set, ZIP, or 7z. Returns a virtual file exposing
// { id, name, size, container, method, streamable, tags, read(), triage(), segmentCount }.
async function mountNzb(pool, nzbXml, opts = {}) {
  const nzb = parseNzb(nzbXml);
  const password = nzbPassword(nzbXml);
  const candidates = nzb.files.map((f) => ({
    ...f,
    name: fileNameFromSubject(f.subject),
    bytes: f.segments.reduce((s, x) => s + x.bytes, 0),
  }));

  const volumeEntries = orderVolumes(candidates);
  if (!volumeEntries.length) return mountFlat(pool, nzb, opts);

  const vols = volumeEntries.map((f) => new NzbFileStream(pool, f, opts));
  try {
    await Promise.all(vols.map((v) => v.mount()));
  } catch (e) {
    // A failed multi-volume mount (one volume rotted/missing) must not leave the OTHER volumes'
    // startup fetches queued in the NNTP pool — orphaned requests hold connections/queue slots and
    // can starve the next press-play (pool exhaustion → stall). Abort every volume's inflight
    // segment fetches before rethrowing. (Only on failure — normal reads are untouched.)
    for (const v of vols) {
      try {
        if (v && v.inflight) for (const rec of v.inflight.values()) {
          if (rec && rec.controller && !rec.controller.signal.aborted) rec.controller.abort();
        }
      } catch { /* best-effort cleanup */ }
    }
    throw e;
  }

  const head = await vols[0].readAt(0, 8);
  // Short read = truncated/damaged first volume — fail with a clear reason instead of letting
  // the header parsers read past the buffer.
  if (head.length < 8) throw new Error('archive truncated: first volume head unreadable');
  const kind = detectContainer(head);
  if (!kind) return mountFlat(pool, nzb, opts); // named like an archive, isn't one

  if (kind === '7z') {
    return new ArchiveVirtualFile({
      vols, inner: null, container: '7z', method: null, streamable: false,
      tags: ['unsupported-container'], password,
    });
  }

  const parsed = kind === 'zip' ? await parseZip(vols[0]) : await parseRarVolumes(vols);
  const container = kind === 'zip' ? 'zip' : 'rar';

  if (parsed.headersEncrypted) {
    return new ArchiveVirtualFile({
      vols, inner: null, container, method: null, streamable: false,
      tags: ['encrypted', 'headers-encrypted'], password,
    });
  }

  const inner = pickInner(parsed.files);
  if (!inner) throw new Error('archive contains no usable files');

  const tags = [];
  if (inner.method === 'compressed') tags.push('compressed', '🐢');
  if (inner.encrypted) tags.push('encrypted');
  const mapped = inner.extents.reduce((s, e) => s + e.length, 0);
  const streamable = inner.method === 'store' && !inner.encrypted && mapped === inner.size;
  if (!streamable && !tags.length) tags.push('unmappable');

  // Multi-file audiobook packed in the archive → expose every inner audio track as a playlist so the
  // client plays from track 1, not whichever single file pickInner chose (which "started mid-book").
  const audioInner = audioInnerCandidates(parsed.files);
  return new ArchiveVirtualFile({
    vols, inner, container, method: inner.method, streamable, tags, password,
    releaseSubs: releaseSubCandidates(parsed.files, inner.name),
    audioFiles: audioInner.length > 1 ? audioInner : null,
  });
}

// Multi-file audiobooks are posted as N loose audio files (one per chapter/part). Natural-sort by
// name so "Chapter 2" precedes "Chapter 10", and expose them as an ordered, index-addressable list.
const AUDIO_TRACK_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav)$/i;
function naturalKey(name) {
  return String(name || '').toLowerCase().replace(/\d+/g, (n) => n.padStart(8, '0'));
}
function audioTrackCandidates(files) {
  return (files || [])
    .filter((f) => f && AUDIO_TRACK_EXT.test(f.name || ''))
    .sort((a, b) => naturalKey(a.name).localeCompare(naturalKey(b.name)))
    .map((f, index) => ({ index, name: f.name, size: f.bytes || 0, _source: f }));
}
// Same, but for the INNER files of an archive (they carry extents + method instead of raw bytes).
// Only STORE (uncompressed, unencrypted, fully-mapped) tracks are streamable as-is.
function audioInnerCandidates(files) {
  return (files || [])
    .filter((f) => f && AUDIO_TRACK_EXT.test(f.name || '') && f.method === 'store' && !f.encrypted && Array.isArray(f.extents))
    .sort((a, b) => naturalKey(a.name).localeCompare(naturalKey(b.name)))
    .map((f, index) => ({ index, name: f.name, size: f.size || 0, _source: f }));
}

function mountFlat(pool, nzb, opts) {
  // opts.wantedEpisode threads through so a loose-file season pack mounts the REQUESTED episode file.
  const primary = pickPrimaryFile(nzb, opts);
  const vf = new NzbFileStream(pool, primary, opts);
  vf.container = 'flat';
  vf.method = null;
  vf.streamable = true;
  vf.tags = [];
  vf.segmentCount = vf.segments.length;
  const files = nzb.files.map((f) => ({
    ...f,
    name: fileNameFromSubject(f.subject),
    bytes: f.segments.reduce((s, x) => s + x.bytes, 0),
  }));
  // Multi-file audiobook: expose every audio track so the client can play them as one chaptered
  // playlist. One mount serves any track by index (mirrors how release subs serve any inner file).
  const audio = audioTrackCandidates(files);
  if (audio.length > 1) {
    vf.audioFiles = audio;
    vf._audioStreams = new Map(); // index -> mounted NzbFileStream (reused across Range requests)
    vf.audioStreamAt = async (index) => {
      const track = vf.audioFiles[index];
      if (!track || !track._source) { const e = new Error('audio track not found'); e.status = 404; throw e; }
      let s = vf._audioStreams.get(index);
      if (!s) { s = new NzbFileStream(pool, track._source, opts); await s.mount('playback'); vf._audioStreams.set(index, s); }
      s._touched = Date.now();
      return s;
    };
  }
  vf.releaseSubs = releaseSubCandidates(files, fileNameFromSubject(primary.subject));
  vf.readReleaseSub = async (id, maxBytes = 5 * 1024 * 1024) => {
    const sub = (vf.releaseSubs || []).find((s) => String(s.id) === String(id));
    if (!sub || !sub._source) throw new Error('release subtitle not found');
    if ((sub.size || sub.bytes || 0) > maxBytes) throw new Error('release subtitle is too large');
    const sf = new NzbFileStream(pool, sub._source, { ...opts, readAhead: 0, cacheSegments: 2, cacheBytes: maxBytes });
    await sf.mount('playback');
    const chunks = [];
    for await (const c of sf.read(0, Math.min(sf.size || maxBytes, maxBytes), { priority: 'playback' })) chunks.push(c);
    return Buffer.concat(chunks);
  };
  return vf.mount();
}

module.exports = { detectContainer, orderVolumes, mountNzb, ArchiveVirtualFile, audioTrackCandidates, audioInnerCandidates };

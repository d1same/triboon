'use strict';
// Archive-aware mounting: NZB → volume set → container detection → inner-file extent map →
// a seekable virtual file over the STORED bytes. Containers we can't stream yet (compressed,
// encrypted, 7z) still mount, but are honest: streamable=false plus verdict tags so the
// ranking/picker can 🐢-tag or skip them.

const crypto = require('crypto');
const {
  parseNzb, fileNameFromSubject, pickPrimaryFile, nzbPassword,
  episodeInName, episodeLikeName, episodeSelectionError,
  releaseNamesExactEpisode, looksLikeSplitParts,
} = require('./nzb');
const { NzbFileStream, SharedCacheBudget } = require('./vfs');
const { parseRarVolumes, rar5VolumeInfo, RAR4_SIG, RAR5_SIG } = require('./rar');
const { parseZip } = require('./zip');
const { parseFileDescs, headHash, HEAD_HASH_BYTES } = require('./par2');
const { getMountMap } = require('./mount-map');

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
  // Obfuscated posts often drop the container suffix entirely: hash.01 / hash.10 / hash.001
  // instead of hash.7z.001. Lioness WEB-DLs arrived as 40 files named <md5>.10, <md5>.11, …
  // and pickPrimaryFile treated every slice as a competing episode payload. 2-3 digit
  // extensions only — a trailing year (2023) must not look like a volume.
  if ((m = /^(.*)\.(\d{2,3})$/.exec(n))) return { base: m[1], key: parseInt(m[2], 10) };
  return null;
}

function fileBaseName(name) {
  return String(name || '').split(/[/\\]/).pop();
}
function isArchiveVolumeName(name) {
  const base = fileBaseName(name);
  return !!volumeKey(base) && !VIDEO_EXT.test(base);
}

function nestedArchiveVolumes(files) {
  const members = (files || []).filter((f) => f && f.method === 'store' && !f.encrypted && isArchiveVolumeName(f.name));
  const ordered = orderVolumes(members.map((f) => ({ ...f, bytes: f.size })));
  if (ordered.length >= 2) return ordered;
  if (ordered.length === 1 && /\.(rar|zip|7z)$/i.test(fileBaseName(ordered[0].name))) return ordered;
  return null;
}

function composeChildExtents(parentFiles, childExtents) {
  const out = [];
  for (const ce of childExtents || []) {
    const parent = parentFiles[ce.vol];
    if (!parent || !Array.isArray(parent.extents)) continue;
    let parentPos = 0;
    const childStart = ce.offset;
    const childEnd = ce.offset + ce.length;
    for (const pe of parent.extents) {
      const peStart = parentPos;
      const peEnd = parentPos + pe.length;
      parentPos = peEnd;
      const start = Math.max(childStart, peStart);
      const end = Math.min(childEnd, peEnd);
      if (end > start) out.push({ vol: pe.vol, offset: pe.offset + (start - peStart), length: end - start });
    }
  }
  return out;
}

function sniffRawMedia(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'mkv';
  if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (buf[0] === 0x47) return 'ts';
  return null;
}

function concatenatedVolumeInner(vols, name) {
  const extents = [];
  let size = 0;
  for (let i = 0; i < vols.length; i++) {
    const length = Number(vols[i].size) || 0;
    extents.push({ vol: i, offset: 0, length });
    size += length;
  }
  return { name, size, method: 'store', encrypted: false, extents };
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

// Per-volume obfuscation: many reposts give EVERY slice its own random name
// (h9yS….part01.rar, ORuE….part02.rar, or "zjb_D7hn" with no extension at all). orderVolumes
// keys on the base name, so it sees N one-volume sets, keeps one, and 52 MB of a 4 GB file
// maps → "unmappable" while the release is perfectly healthy. The post's own .par2 lists the
// real file names with the MD5 of each file's first 16 KB (the SABnzbd rename trick); RAR5
// slices also carry their volume number in the main header. Restore names/order from those,
// then hand the already-mounted volume streams back so no article is fetched twice.
// Returns ordered NzbFileStream[] (renamed) or null when nothing could be proven.
const OBFUSCATED_SLICE_MIN_BYTES = 8 * 1024; // junk is excluded by extension; tiny strays cost one article
const PAR2_READ_CAP = 8 * 1024 * 1024;
function isPar2Name(name) { return /\.par2$/i.test(fileBaseName(name)); }
// hash.NN / hash.NNN slices (no container suffix): the number is a posting index that reposters
// shuffle, not a promise about order. .7z.001 / .rar.001 style keeps its suffix and is trusted.
function numericSliceSet(vols) {
  return vols.length >= 2 && vols.every((f) => /\.\d{2,3}$/.test(fileBaseName(f.name || ''))
    && !/\.(rar|zip|7z)\.\d{2,4}$/i.test(fileBaseName(f.name || '')));
}
function obfuscatedSliceCandidates(candidates) {
  return candidates.filter((f) => f && f.segments && f.segments.length
    && (f.bytes || 0) >= OBFUSCATED_SLICE_MIN_BYTES
    && !isPar2Name(f.name) && !JUNK_EXT.test(f.name) && !VIDEO_EXT.test(f.name));
}
async function deobfuscateVolumes(pool, candidates, opts = {}) {
  const slices = obfuscatedSliceCandidates(candidates);
  if (slices.length < 2) return null;
  const streams = slices.map((f) => new NzbFileStream(pool, f, opts));
  // First article of every slice: needed anyway by the RAR header walk that follows.
  const heads = await Promise.all(streams.map((s) => s.readAt(0, HEAD_HASH_BYTES).catch(() => null)));

  // 1) PAR2 FileDesc rename — exact names, verified by the 16 KB hash.
  const par2Files = candidates.filter((f) => f && f.segments && f.segments.length && isPar2Name(f.name))
    .sort((a, b) => (a.bytes || 0) - (b.bytes || 0)); // the main .par2 (no recovery blocks) is smallest
  let descs = [];
  for (const p of par2Files.slice(0, 3)) {
    try {
      const ps = new NzbFileStream(pool, p, opts);
      await ps.mount();
      const buf = await ps.readAt(0, Math.min(ps.size || PAR2_READ_CAP, PAR2_READ_CAP));
      descs = parseFileDescs(buf);
    } catch { descs = []; }
    if (descs.length) break;
  }
  if (descs.length) {
    const byHash = new Map(descs.map((d) => [d.hash16k, d]));
    let renamed = 0;
    const entries = streams.map((s, i) => {
      const head = heads[i];
      const d = head && byHash.get(headHash(head));
      if (d && (!d.length || !s.size || d.length === s.size)) { renamed++; return { f: slices[i], name: d.name, stream: s }; }
      return { f: slices[i], name: slices[i].name, stream: s };
    });
    if (renamed >= 2) {
      const ordered = orderVolumes(entries.map((e) => ({ ...e.f, name: e.name, _entry: e })));
      if (ordered.length >= 2) {
        return ordered.map((f) => { f._entry.stream.name = f.name; return f._entry.stream; });
      }
    }
  }

  // 2) RAR5 volume numbers — the archive says where each slice belongs.
  const infos = heads.map((h) => (h ? rar5VolumeInfo(h) : null));
  if (infos.length >= 2 && infos.every((x) => x && x.volume)) {
    const firsts = infos.filter((x) => x.number === 0).length;
    const numbers = new Set(infos.map((x) => x.number));
    if (firsts === 1 && numbers.size === infos.length) {
      const order = infos.map((x, i) => ({ n: x.number, i })).sort((a, b) => a.n - b.n);
      const base = (slices[order[0].i].name || 'volume').replace(/\.[^.]*$/, '') || 'volume';
      return order.map(({ i }, k) => {
        streams[i].name = `${base}.part${String(k + 1).padStart(3, '0')}.rar`;
        return streams[i];
      });
    }
  }
  return null;
}

// Pick the playable inner file: video extension wins, then size; junk never wins. Sample
// clips are video-extension files too ("…-sample.mkv") — they only win when NOTHING else
// is playable, and the pipeline then refuses the mount by name.
function pickInner(files, wantedEpisode = null, releaseName = '') {
  const scored = files
    .map((f) => {
      const junk = JUNK_EXT.test(f.name) || /\bsample\b/i.test(f.name) || isArchiveVolumeName(f.name);
      let score = (junk ? -1 : f.size) * (VIDEO_EXT.test(f.name) ? 10 : 1);
      // A season pack may contain every episode inside one RAR/ZIP. Exact episode identity must
      // outrank file size, otherwise E01/the largest member is reused for an E05 request.
      if (!junk && wantedEpisode && VIDEO_EXT.test(f.name)
          && episodeInName(f.name, wantedEpisode.s, wantedEpisode.e)) score += 1e15;
      return { f, score };
    })
    .sort((a, b) => b.score - a.score);
  if (wantedEpisode) {
    const nonJunk = scored.filter(({ f }) => !JUNK_EXT.test(f.name) && !/\bsample\b/i.test(f.name)
      && !isArchiveVolumeName(f.name));
    const namedVideos = nonJunk.filter(({ f }) => VIDEO_EXT.test(f.name));
    const payloads = namedVideos.length ? namedVideos : nonJunk;
    const exact = payloads.filter(({ f }) => episodeInName(f.name, wantedEpisode.s, wantedEpisode.e));
    if (exact.length === 1) return exact[0].f;
    if (exact.length > 1) {
      if (looksLikeSplitParts(exact.map((x) => x.f.name))) {
        throw episodeSelectionError(wantedEpisode, 'is ambiguous (multiple matching archive members)');
      }
      if (releaseNamesExactEpisode(releaseName, wantedEpisode.s, wantedEpisode.e)) {
        return exact.slice().sort((a, b) => (b.f.size || 0) - (a.f.size || 0))[0].f;
      }
      throw episodeSelectionError(wantedEpisode, 'is ambiguous (multiple matching archive members)');
    }
    // A single opaque payload member is a common obfuscation pattern and remains safe: there is no
    // competing payload to confuse it with. A named different episode or multiple opaque members
    // are not safe guesses and must make the pipeline advance to another release.
    if (payloads.length === 1 && !episodeLikeName(payloads[0].f.name)) return payloads[0].f;
    if (releaseNamesExactEpisode(releaseName, wantedEpisode.s, wantedEpisode.e)) {
      const usable = payloads.filter(({ f }) => !episodeLikeName(f.name)
        || episodeInName(f.name, wantedEpisode.s, wantedEpisode.e));
      if (usable.length === 1) return usable[0].f;
      // A single-episode release (Lioness.S01E01) whose inner names omit SxxEyy: pick the largest
      // video. Season packs never reach here — their release name is not an exact episode.
      if (usable.length > 1 && !looksLikeSplitParts(usable.map((x) => x.f.name))) {
        const videos = usable.filter(({ f }) => VIDEO_EXT.test(f.name));
        const pool = videos.length ? videos : usable;
        return pool.slice().sort((a, b) => (b.f.size || 0) - (a.f.size || 0))[0].f;
      }
    }
    if (payloads.length) {
      throw episodeSelectionError(wantedEpisode, 'is not uniquely present in this archive');
    }
  }
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

function releaseEpisodeKey(name) {
  const x = String(name || '').toLowerCase();
  const se = /\bs(\d{1,2})\s?e(\d{1,3})\b/i.exec(x);
  if (se) return `s${String(+se[1]).padStart(2, '0')}e${String(+se[2]).padStart(2, '0')}`;
  const xe = /\b(\d{1,2})x(\d{1,3})\b/i.exec(x);
  if (xe) return `s${String(+xe[1]).padStart(2, '0')}e${String(+xe[2]).padStart(2, '0')}`;
  return '';
}

function releaseSubCandidates(files, videoName = '') {
  const videoEpisode = releaseEpisodeKey(videoName);
  return (files || [])
    .filter((f) => f && TEXT_SUB_EXT.test(f.name || '') && String(f.name || '') !== String(videoName || ''))
    .filter((f) => !f.method || (f.method === 'store' && !f.encrypted))
    // A season pack can carry every episode's sidecar. Episode 10 must not
    // auto-play episode 1's words. A file with no episode tag can still be this one.
    .filter((f) => {
      if (!videoEpisode) return true;
      const subEpisode = releaseEpisodeKey(f.name);
      return !subEpisode || subEpisode === videoEpisode;
    })
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
    this.segmentCount = vols.reduce((s, v) => s + ((v && v.segments && v.segments.length) || 0), 0);
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

  async readAt(start, len, opts = {}) {
    const chunks = [];
    for await (const c of this.read(start, start + len, opts)) chunks.push(c);
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
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

function rememberArchiveMap(nzbXml, vf) {
  const store = getMountMap();
  if (!store || !vf || !Array.isArray(vf.vols) || !vf.vols.length) return;
  // A multi-file audiobook needs the full inner list. Replaying one file would drop the chapters.
  if (vf.audioFiles && vf.audioFiles.length > 1) return;
  const volumes = [];
  for (const v of vf.vols) {
    if (!(v && v.name && v.size > 0 && v.partSize > 0)) return;
    volumes.push({ name: v.name, size: v.size, partSize: v.partSize });
  }
  const inner = vf.extents && vf.extents.length ? {
    name: vf.name,
    size: vf.size,
    method: vf.method,
    encrypted: !!(vf.tags && vf.tags.includes('encrypted')),
    extents: vf.extents.map((e) => ({ vol: e.vol, offset: e.offset, length: e.length })),
  } : null;
  const releaseSubs = (vf.releaseSubs || []).map((sub) => ({
    public: {
      id: sub.id, name: sub.name, ext: sub.ext, lang: sub.lang,
      forced: !!sub.forced, sdh: !!sub.sdh, size: sub.size || 0, score: sub.score || 0, source: 'release',
    },
    source: sub._source && Array.isArray(sub._source.extents) ? {
      name: sub._source.name,
      size: sub._source.size,
      method: sub._source.method,
      encrypted: !!sub._source.encrypted,
      extents: sub._source.extents,
    } : null,
  })).filter((sub) => sub.source);
  store.put(nzbXml, {
    v: 1,
    container: vf.container,
    method: vf.method,
    streamable: !!vf.streamable,
    tags: Array.isArray(vf.tags) ? vf.tags : [],
    volumes,
    inner,
    releaseSubs,
  });
}

async function mountFromSavedMap(pool, nzbXml, candidates, opts, password) {
  const store = getMountMap();
  if (!store) return null;
  const saved = store.get(nzbXml);
  if (!saved || saved.v !== 1 || !Array.isArray(saved.volumes) || !saved.volumes.length) return null;
  const byName = new Map();
  for (const f of candidates) {
    if (f && f.name && !byName.has(f.name)) byName.set(f.name, f);
  }
  const ordered = [];
  for (const vol of saved.volumes) {
    const file = byName.get(vol.name);
    if (!file || !(vol.size > 0) || !(vol.partSize > 0)) return null;
    ordered.push(file);
  }
  const sharedCacheBudget = new SharedCacheBudget(opts.cacheBytes);
  const vols = ordered.map((f) => new NzbFileStream(pool, f, opts));
  for (let i = 0; i < vols.length; i++) {
    vols[i].size = saved.volumes[i].size;
    vols[i].partSize = saved.volumes[i].partSize;
    vols[i].setSharedCacheBudget(sharedCacheBudget);
  }
  try {
    await Promise.all(vols.map((v) => v.mount()));
  } catch {
    return null;
  }
  const inner = saved.inner && Array.isArray(saved.inner.extents) ? saved.inner : null;
  const releaseSubs = (saved.releaseSubs || []).filter((sub) => sub && sub.public && sub.source).map((sub) => ({
    ...sub.public,
    _source: sub.source,
  }));
  return new ArchiveVirtualFile({
    vols,
    inner,
    container: saved.container,
    method: saved.method,
    streamable: !!saved.streamable,
    tags: Array.isArray(saved.tags) ? saved.tags : [],
    password,
    releaseSubs,
  });
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

  const reused = await mountFromSavedMap(pool, nzbXml, candidates, opts, password);
  if (reused) return reused;

  const volumeEntries = orderVolumes(candidates);
  const doneArchive = (vf) => {
    rememberArchiveMap(nzbXml, vf);
    return vf;
  };
  // Two obfuscation signatures: (a) one or zero named volumes next to several anonymous slices;
  // (b) a hash.NN set whose NN is NOT the volume order (.10 was really part45). Both get the
  // real order proven from the par2 / RAR5 headers before the RAR walk; a plain .partNN.rar set
  // never pays for this.
  let deobfuscated = null;
  if (obfuscatedSliceCandidates(candidates).length >= 2
      && (volumeEntries.length < 2 || numericSliceSet(volumeEntries))) {
    deobfuscated = await deobfuscateVolumes(pool, candidates, opts);
  }
  if (!deobfuscated && !volumeEntries.length) return mountFlat(pool, nzb, opts);

  const sharedCacheBudget = new SharedCacheBudget(opts.cacheBytes);
  const vols = deobfuscated || volumeEntries.map((f) => new NzbFileStream(pool, f, opts));
  for (const v of vols) v.setSharedCacheBudget(sharedCacheBudget);
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
  if (!kind) {
    // Obfuscated <hash>.10/.11 slices of a raw MKV/MP4: one video split across NZB files, not an
    // archive. Concatenate in volume order. A single stray numeric file still falls through to flat.
    const media = sniffRawMedia(head);
    if (media && vols.length >= 2) {
      const inner = concatenatedVolumeInner(vols, opts.releaseName || vols[0].name);
      return doneArchive(new ArchiveVirtualFile({
        vols, inner, container: 'flat-split', method: 'store', streamable: true, tags: [], password,
      }));
    }
    return mountFlat(pool, nzb, opts); // named like an archive, isn't one
  }

  if (kind === '7z') {
    return doneArchive(new ArchiveVirtualFile({
      vols, inner: null, container: '7z', method: null, streamable: false,
      tags: ['unsupported-container'], password,
    }));
  }

  const parsed = kind === 'zip' ? await parseZip(vols[0]) : await parseRarVolumes(vols);
  const container = kind === 'zip' ? 'zip' : 'rar';

  if (typeof opts.onParsed === 'function') {
    opts.onParsed({
      kind,
      volumes: vols.map((v) => ({ name: v.name, size: v.size })),
      headersEncrypted: !!parsed.headersEncrypted,
      files: (parsed.files || []).map((f) => ({
        name: f.name, size: f.size, method: f.method, encrypted: !!f.encrypted,
      })),
    });
  }

  if (parsed.headersEncrypted) {
    return doneArchive(new ArchiveVirtualFile({
      vols, inner: null, container, method: null, streamable: false,
      tags: ['encrypted', 'headers-encrypted'], password,
    }));
  }

  // Scene posts often wrap a RAR volume set (.rar/.r00) inside another store RAR. The outer
  // members are 50MB slices, not the video — unwrap one nested archive so Play gets the mkv.
  const nested = await unwrapNestedArchive(vols, parsed.files, opts);
  if (nested && nested.unstreamable) {
    return doneArchive(new ArchiveVirtualFile({
      vols, inner: null, container: nested.container, method: null, streamable: false,
      tags: nested.tags, password,
    }));
  }

  const inner = (nested && nested.inner) || pickInner(parsed.files, opts.wantedEpisode, opts.releaseName);
  if (!inner) throw new Error('archive contains no usable files');
  const pickFiles = (nested && nested.files) || parsed.files;

  const tags = [];
  if (inner.method === 'compressed') tags.push('compressed', '🐢');
  if (inner.encrypted) tags.push('encrypted');
  const mapped = inner.extents.reduce((s, e) => s + e.length, 0);
  const streamable = inner.method === 'store' && !inner.encrypted && mapped === inner.size;
  if (!streamable && !tags.length) tags.push('unmappable');

  // Multi-file audiobook packed in the archive → expose every inner audio track as a playlist so the
  // client plays from track 1, not whichever single file pickInner chose (which "started mid-book").
  const audioInner = audioInnerCandidates(pickFiles);
  return doneArchive(new ArchiveVirtualFile({
    vols, inner, container: (nested && nested.container) || container, method: inner.method, streamable, tags, password,
    releaseSubs: releaseSubCandidates(pickFiles, inner.name),
    audioFiles: audioInner.length > 1 ? audioInner : null,
  }));
}

async function unwrapNestedArchive(outerVols, outerFiles, opts = {}) {
  const nestedMembers = nestedArchiveVolumes(outerFiles);
  if (!nestedMembers) return null;
  const wraps = nestedMembers.map((f) => new ArchiveVirtualFile({
    vols: outerVols, inner: f, container: 'rar', method: 'store', streamable: true, tags: [],
  }));
  const head = await wraps[0].readAt(0, 8);
  if (head.length < 6) return null;
  const kind = detectContainer(head);
  if (!kind) return null;
  if (kind === '7z') {
    return { unstreamable: true, container: '7z', tags: ['unsupported-container'] };
  }
  const parsed = kind === 'zip' ? await parseZip(wraps[0]) : await parseRarVolumes(wraps);
  if (parsed.headersEncrypted) {
    return { unstreamable: true, container: kind === 'zip' ? 'zip' : 'rar', tags: ['encrypted', 'headers-encrypted'] };
  }
  if (typeof opts.onParsed === 'function') {
    opts.onParsed({
      kind: 'nested-' + kind,
      volumes: nestedMembers.map((v) => ({ name: v.name, size: v.size })),
      headersEncrypted: false,
      files: (parsed.files || []).map((f) => ({
        name: f.name, size: f.size, method: f.method, encrypted: !!f.encrypted,
      })),
    });
  }
  const picked = pickInner(parsed.files, opts.wantedEpisode, opts.releaseName);
  if (!picked) return null;
  return {
    container: kind === 'zip' ? 'zip' : 'rar',
    files: parsed.files,
    inner: {
      ...picked,
      extents: composeChildExtents(nestedMembers, picked.extents),
    },
  };
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

module.exports = { detectContainer, orderVolumes, volumeKey, mountNzb, ArchiveVirtualFile, audioTrackCandidates, audioInnerCandidates };

'use strict';
// Clean-room STORE-mode archive writers for the golden test corpus: RAR4, RAR5, ZIP.
// Written from the public RAR technote / ZIP APPNOTE layouts; validated against real
// unrar/7z (see test/fixtures/README.md). Compression is never implemented — store only,
// which is what scene rules mandate for video and what Phase 1 streams natively.

const { crc32 } = require('../server/yenc');

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

// RAR5 vint: little-endian base-128, high bit = continuation.
function vint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}

// Deterministic payload (same LCG family as the e2e suite) so tests regenerate expected bytes.
function seededPayload(size, seed = 0x7ace) {
  const data = Buffer.allocUnsafe(size);
  let s = seed;
  for (let i = 0; i < size; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i] = s & 0xff; }
  return data;
}

// ---------------- RAR4 ----------------
const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

function rar4Block(type, flags, fields) {
  const head = Buffer.concat([u8(type), u16(flags), u16(7 + fields.length), fields]);
  return Buffer.concat([u16(crc32(head) & 0xffff), head]);
}

function rar4Main({ multi = false, first = false, newNumbering = false } = {}) {
  let flags = 0;
  if (multi) flags |= 0x0001;
  if (newNumbering) flags |= 0x0010;
  if (first) flags |= 0x0100;
  return rar4Block(0x73, flags, Buffer.concat([u16(0), u32(0)])); // HighPosAV, PosAV
}

function rar4File({ name, chunk, unpSize, splitBefore, splitAfter, fullCrc }) {
  let flags = 0x8000; // long block: packed data follows
  if (splitBefore) flags |= 0x01;
  if (splitAfter) flags |= 0x02;
  const nameBuf = Buffer.from(name, 'latin1');
  // Split CRC semantics (validated vs real unrar, same rule for RAR4 and RAR5): volumes that
  // continue into the next volume store THIS chunk's crc32; the final volume stores the
  // whole file's crc32.
  const crc = splitAfter ? crc32(chunk) : fullCrc;
  const fields = Buffer.concat([
    u32(chunk.length), u32(unpSize), u8(2 /* HOST_OS: Windows */), u32(crc),
    u32(0x58e7a21b /* DOS ftime, fixed for determinism */), u8(20 /* UNP_VER 2.0 */),
    u8(0x30 /* METHOD: store */), u16(nameBuf.length), u32(0x20 /* ATTR: archive */), nameBuf,
  ]);
  return Buffer.concat([rar4Block(0x74, flags, fields), chunk]);
}

const rar4End = (nextVolume) => rar4Block(0x7b, nextVolume ? 0x0001 : 0, Buffer.alloc(0));

// ---------------- RAR5 ----------------
const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

function rar5Block(type, hflags, fields, dataSize = null) {
  const parts = [vint(type), vint(hflags)];
  if (dataSize !== null) parts.push(vint(dataSize));
  parts.push(fields);
  const body = Buffer.concat(parts);
  const size = vint(body.length);
  return Buffer.concat([u32(crc32(Buffer.concat([size, body]))), size, body]);
}

function rar5Main({ multi = false, volNumber = 0 } = {}) {
  let arcFlags = 0;
  if (multi) arcFlags |= 0x0001;
  if (volNumber > 0) arcFlags |= 0x0002;
  const fields = volNumber > 0 ? Buffer.concat([vint(arcFlags), vint(volNumber)]) : vint(arcFlags);
  return rar5Block(1, 0, fields);
}

function rar5File({ name, chunk, unpSize, splitBefore, splitAfter, fullCrc }) {
  let hflags = 0x0002; // data area present
  if (splitBefore) hflags |= 0x0008;
  if (splitAfter) hflags |= 0x0010;
  const nameBuf = Buffer.from(name, 'utf8');
  // Same split-CRC rule as RAR4: chunk crc while continuing, full-file crc on the last part.
  const crc = splitAfter ? crc32(chunk) : fullCrc;
  const fields = Buffer.concat([
    vint(0x0004 /* file flags: CRC present */), vint(unpSize), vint(0x20 /* attributes */),
    u32(crc), vint(0 /* compression info: v0, store, no solid */), vint(0 /* host: Windows */),
    vint(nameBuf.length), nameBuf,
  ]);
  return Buffer.concat([rar5Block(2, hflags, fields, chunk.length), chunk]);
}

const rar5End = (nextVolume) => rar5Block(5, 0, vint(nextVolume ? 1 : 0));

// ---------------- shared volume packer ----------------
// files: [{ name, data }] · volSize: max DATA bytes per volume (headers excluded — fine for tests)
// Returns [{ name, data }] volumes named per `naming`: 'old' (.rar/.r00/…) or 'part' (.partN.rar).
function packVolumes(files, { volSize, base, naming }, writers) {
  const chunksPerVol = []; // [{ file, chunk, splitBefore, splitAfter }]
  let cur = [], room = volSize === null ? Infinity : volSize;
  for (const f of files) {
    let off = 0;
    while (off < f.data.length || (f.data.length === 0 && off === 0)) {
      if (room <= 0) { chunksPerVol.push(cur); cur = []; room = volSize; }
      const take = Math.min(f.data.length - off, room);
      cur.push({ file: f, chunk: f.data.subarray(off, off + take), splitBefore: off > 0, splitAfter: off + take < f.data.length, prefixEnd: off + take });
      off += take; room -= take;
      if (f.data.length === 0) break;
    }
  }
  chunksPerVol.push(cur);
  const multi = chunksPerVol.length > 1;

  return chunksPerVol.map((chunks, vi) => {
    const last = vi === chunksPerVol.length - 1;
    const blocks = [writers.sig, writers.main({ multi, vi, naming })];
    for (const c of chunks) {
      blocks.push(writers.file({
        name: c.file.name, chunk: c.chunk, unpSize: c.file.data.length,
        splitBefore: c.splitBefore, splitAfter: c.splitAfter, fullCrc: crc32(c.file.data),
      }));
    }
    blocks.push(writers.end(!last));
    return { name: volumeName(base, vi, chunksPerVol.length, naming), data: Buffer.concat(blocks) };
  });
}

function volumeName(base, idx, total, naming) {
  if (total === 1) return `${base}.rar`;
  if (naming === 'part') return `${base}.part${String(idx + 1).padStart(String(total).length, '0')}.rar`;
  return idx === 0 ? `${base}.rar` : `${base}.r${String(idx - 1).padStart(2, '0')}`;
}

function writeRar4Store(files, { volSize = null, base = 'archive', naming = 'old' } = {}) {
  return packVolumes(files, { volSize, base, naming }, {
    sig: RAR4_SIG,
    main: ({ multi, vi, naming: n }) => rar4Main({ multi, first: multi && vi === 0, newNumbering: n === 'part' }),
    file: rar4File,
    end: rar4End,
  });
}

function writeRar5Store(files, { volSize = null, base = 'archive', naming = 'part' } = {}) {
  return packVolumes(files, { volSize, base, naming }, {
    sig: RAR5_SIG,
    main: ({ multi, vi }) => rar5Main({ multi, volNumber: vi }),
    file: rar5File,
    end: rar5End,
  });
}

// ---------------- ZIP (store) ----------------
function writeZipStore(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.concat([
      Buffer.from('PK\x03\x04', 'latin1'), u16(20), u16(0), u16(0 /* store */),
      u16(0x6020), u16(0x58e7), u32(crc), u32(f.data.length), u32(f.data.length),
      u16(nameBuf.length), u16(0), nameBuf, f.data,
    ]);
    centrals.push(Buffer.concat([
      Buffer.from('PK\x01\x02', 'latin1'), u16(20), u16(20), u16(0), u16(0),
      u16(0x6020), u16(0x58e7), u32(crc), u32(f.data.length), u32(f.data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0x20), u32(offset), nameBuf,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06', 'latin1'), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { seededPayload, writeRar4Store, writeRar5Store, writeZipStore, volumeName };

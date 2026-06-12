'use strict';
// RAR4 + RAR5 header parsing over remote volumes (random-access reads, no full download).
// Output: a logical file map — for each inner file, the ordered byte extents inside the
// volumes that hold its STORED data. Store-mode mapping is what makes seek = arithmetic.
// Clean-room from the public RAR technotes; validated against real rar/unrar (test/fixtures).

const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

// vint: little-endian base-128, high bit = continuation. Returns [value, bytesRead].
function readVint(buf, off) {
  let value = 0n, shift = 0n, i = off;
  for (;;) {
    if (i >= buf.length) throw new Error('rar5: truncated vint');
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (!(b & 0x80)) break;
  }
  return [Number(value), i - off];
}

// ---------------- RAR4 ----------------
// Block: HEAD_CRC u16 · HEAD_TYPE u8 · HEAD_FLAGS u16 · HEAD_SIZE u16 · fields…
// File block (0x74) fields: PACK u32 · UNP u32 · HOST u8 · CRC u32 · FTIME u32 · VER u8 ·
// METHOD u8 · NAMELEN u16 · ATTR u32 · [HIGHPACK u32 · HIGHUNP u32 if 0x100] · NAME
async function walkRar4Volume(vol, volIdx) {
  const entries = [];
  let off = RAR4_SIG.length;
  let headersEncrypted = false;
  for (;;) {
    const head = await vol.readAt(off, 7);
    if (head.length < 7) break;
    const type = head[2];
    const flags = head.readUInt16LE(3);
    const hsize = head.readUInt16LE(5);
    if (hsize < 7) throw new Error(`rar4: bad header size at ${off}`);

    if (type === 0x73) { // main header
      if (flags & 0x0080) { headersEncrypted = true; break; } // -hp: everything after is encrypted
      off += hsize;
    } else if (type === 0x74) { // file header
      const h = await vol.readAt(off, hsize);
      if (h.length < hsize) throw new Error(`rar4: truncated file header at ${off}`);
      // Layout after the 7-byte base: PACK u32(7) UNP u32(11) HOST u8(15) CRC u32(16)
      // FTIME u32(20) UNP_VER u8(24) METHOD u8(25) NAMELEN u16(26) ATTR u32(28) [highs] NAME.
      let packSize = h.readUInt32LE(7);
      let unpSize = h.readUInt32LE(11);
      const method = h[25];
      const nameSize = h.readUInt16LE(26);
      let nameOff = 32;
      if (flags & 0x100) { // large file: 64-bit sizes
        packSize += h.readUInt32LE(32) * 2 ** 32;
        unpSize += h.readUInt32LE(36) * 2 ** 32;
        nameOff += 8;
      }
      let name = h.subarray(nameOff, nameOff + nameSize);
      // Unicode-name variant stores "ansi\0encoded-unicode"; NUL never appears in real names.
      const nul = name.indexOf(0);
      if (nul !== -1) name = name.subarray(0, nul);
      entries.push({
        name: name.toString('latin1'), unpSize, method: method === 0x30 ? 'store' : 'compressed',
        encrypted: !!(flags & 0x04), splitBefore: !!(flags & 0x01), splitAfter: !!(flags & 0x02),
        vol: volIdx, dataOffset: off + hsize, packSize,
      });
      off += hsize + packSize;
    } else if (type === 0x7b) { // end of archive
      break;
    } else { // any other block: skip header + optional data area
      let addSize = 0;
      if (flags & 0x8000) {
        const add = await vol.readAt(off + 7, 4);
        if (add.length < 4) throw new Error(`rar4: truncated block at ${off}`);
        addSize = add.readUInt32LE(0);
      }
      off += hsize + addSize;
    }
  }
  return { entries, headersEncrypted };
}

// ---------------- RAR5 ----------------
// Block: CRC u32 · HeaderSize vint · [ Type vint · Flags vint · [ExtraSize] · [DataSize] · … ]
async function walkRar5Volume(vol, volIdx) {
  const entries = [];
  let off = RAR5_SIG.length;
  let headersEncrypted = false;
  for (;;) {
    const peek = await vol.readAt(off, 16); // crc(4) + size vint (≤3 bytes here) + body start
    if (peek.length < 6) break;
    const [hsize, sizeLen] = readVint(peek, 4);
    const headerTotal = 4 + sizeLen + hsize;
    const block = await vol.readAt(off, headerTotal);
    if (block.length < headerTotal) throw new Error(`rar5: truncated header at ${off}`);
    const body = block.subarray(4 + sizeLen);

    let c = 0;
    const [type, tLen] = readVint(body, c); c += tLen;
    const [hflags, fLen] = readVint(body, c); c += fLen;
    let extraSize = 0, dataSize = 0;
    if (hflags & 0x0001) { const [v, n] = readVint(body, c); extraSize = v; c += n; }
    if (hflags & 0x0002) { const [v, n] = readVint(body, c); dataSize = v; c += n; }

    if (type === 4) { headersEncrypted = true; break; } // archive encryption header (-hp)
    if (type === 5) break; // end of archive

    if (type === 2) { // file header (type 3 = service header — same shape, skipped)
      const [fileFlags, a] = readVint(body, c); c += a;
      const [unpSize, b] = readVint(body, c); c += b;
      const [, d] = readVint(body, c); c += d; // attributes
      if (fileFlags & 0x0002) c += 4; // mtime
      if (fileFlags & 0x0004) c += 4; // crc32
      const [compInfo, e] = readVint(body, c); c += e;
      const [, g] = readVint(body, c); c += g; // host OS
      const [nameLen, n] = readVint(body, c); c += n;
      const name = body.subarray(c, c + nameLen).toString('utf8');

      // File encryption lives in the extra area: records of [size vint · type vint · …], type 1.
      let encrypted = false;
      if (extraSize > 0) {
        let x = body.length - extraSize;
        while (x < body.length) {
          const [recSize, rs] = readVint(body, x);
          const [recType] = readVint(body, x + rs);
          if (recType === 1) encrypted = true;
          x += rs + recSize;
        }
      }
      entries.push({
        name, unpSize, method: ((compInfo >> 7) & 7) === 0 ? 'store' : 'compressed',
        encrypted, splitBefore: !!(hflags & 0x0008), splitAfter: !!(hflags & 0x0010),
        vol: volIdx, dataOffset: off + headerTotal, packSize: dataSize,
      });
    }
    off += headerTotal + dataSize;
  }
  return { entries, headersEncrypted };
}

// ---------------- volume merge ----------------
// vols: ordered [{ name, size, readAt(offset, length) → Promise<Buffer> }]
async function parseRarVolumes(vols) {
  const sig = await vols[0].readAt(0, 8);
  let version;
  if (sig.length >= 8 && sig.subarray(0, 8).equals(RAR5_SIG)) version = 5;
  else if (sig.length >= 7 && sig.subarray(0, 7).equals(RAR4_SIG)) version = 4;
  else throw new Error('not a RAR archive');
  const walk = version === 5 ? walkRar5Volume : walkRar4Volume;

  // Volumes are independent — walk them all in parallel (each costs ~2 article fetches on a
  // real provider; serial walks dominated mount time on large releases), merge in order.
  const walked = await Promise.all(vols.map((v, vi) => walk(v, vi)));

  const files = [];
  let open = null; // file continuing from the previous volume
  let headersEncrypted = false;
  for (let vi = 0; vi < vols.length; vi++) {
    const { entries, headersEncrypted: enc } = walked[vi];
    if (enc) { headersEncrypted = true; break; }
    for (const e of entries) {
      const extent = { vol: e.vol, offset: e.dataOffset, length: e.packSize };
      if (e.splitBefore && open && open.name === e.name) {
        open.extents.push(extent);
      } else {
        open = { name: e.name, size: e.unpSize, method: e.method, encrypted: e.encrypted, extents: [extent] };
        files.push(open);
      }
      if (!e.splitAfter) open = null;
    }
  }
  return { version, headersEncrypted, files };
}

module.exports = { parseRarVolumes, RAR4_SIG, RAR5_SIG };

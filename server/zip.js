'use strict';
// ZIP parsing over a remote volume: read the end-of-central-directory from the tail, then the
// central directory, then each local header to find exact data offsets. Store entries are
// directly streamable; deflate entries are detected and tagged, not streamed (Phase 1).

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

async function parseZip(vol) {
  const tailLen = Math.min(vol.size, 66000); // EOCD + max comment
  const tail = await vol.readAt(vol.size - tailLen, tailLen);
  if (tail.length < 22) throw new Error('zip: truncated (no room for end-of-central-directory)');
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('zip: end-of-central-directory not found');
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);

  const cd = await vol.readAt(cdOff, cdSize);
  const files = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CENTRAL_SIG) {
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOff = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // Local header lengths can differ from central ones — read them for the true data offset.
    const local = await vol.readAt(localOff, 30);
    if (local.length < 30) throw new Error(`zip: truncated local header at ${localOff}`);
    const lNameLen = local.readUInt16LE(26);
    const lExtraLen = local.readUInt16LE(28);
    files.push({
      name, size: usize, method: method === 0 ? 'store' : 'compressed',
      encrypted: !!(flags & 0x0001),
      extents: [{ vol: 0, offset: localOff + 30 + lNameLen + lExtraLen, length: csize }],
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { files };
}

module.exports = { parseZip };

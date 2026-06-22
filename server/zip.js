'use strict';
// ZIP parsing over a remote volume: read the end-of-central-directory from the tail, then the
// central directory, then each local header to find exact data offsets. Store entries are
// directly streamable; deflate entries are detected and tagged, not streamed (Phase 1).

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const MAX_ZIP_CENTRAL_DIRECTORY = 128 * 1024 * 1024;
const MAX_ZIP_NAME_EXTRA_COMMENT = 1024 * 1024;

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
  if (cdSize > MAX_ZIP_CENTRAL_DIRECTORY) throw new Error('zip: central-directory too large');
  if (cdOff > vol.size || cdOff + cdSize > vol.size) throw new Error('zip: central-directory outside volume');

  const cd = await vol.readAt(cdOff, cdSize);
  if (cd.length < cdSize) throw new Error('zip: truncated central directory');
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
    const entryHeaderLen = 46 + nameLen + extraLen + commentLen;
    if (entryHeaderLen > MAX_ZIP_NAME_EXTRA_COMMENT || p + entryHeaderLen > cd.length) {
      throw new Error(`zip: truncated central entry at ${cdOff + p}`);
    }
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // Local header lengths can differ from central ones — read them for the true data offset.
    if (localOff > vol.size || localOff + 30 > vol.size) throw new Error(`zip: local header outside volume at ${localOff}`);
    const local = await vol.readAt(localOff, 30);
    if (local.length < 30) throw new Error(`zip: truncated local header at ${localOff}`);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip: bad local header at ${localOff}`);
    const lNameLen = local.readUInt16LE(26);
    const lExtraLen = local.readUInt16LE(28);
    if (30 + lNameLen + lExtraLen > MAX_ZIP_NAME_EXTRA_COMMENT) throw new Error(`zip: local name/extra too large at ${localOff}`);
    if (localOff + 30 + lNameLen + lExtraLen + csize > vol.size) throw new Error(`zip: file data outside volume at ${localOff}`);
    files.push({
      name, size: usize, method: method === 0 ? 'store' : 'compressed',
      encrypted: !!(flags & 0x0001),
      extents: [{ vol: 0, offset: localOff + 30 + lNameLen + lExtraLen, length: csize }],
    });
    p += entryHeaderLen;
  }
  return { files };
}

module.exports = { parseZip };

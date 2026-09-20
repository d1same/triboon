'use strict';
// Minimal PAR2 reader: only the FileDesc packets. A post's .par2 names every real file and
// carries the MD5 of each file's first 16 KB, which is how an obfuscated volume set
// (every slice its own random name) gets its real names back before the RAR volume order
// is rebuilt. Clean-room from the public PAR 2.0 specification. No repair, no recovery.

const crypto = require('crypto');

const PKT_MAGIC = Buffer.from('PAR2\0PKT', 'latin1');
const PKT_FILEDESC = Buffer.from('PAR 2.0\0FileDesc', 'latin1');
const PKT_HEADER_BYTES = 64; // magic(8) length(8) md5(16) set-id(16) type(16)
const FILEDESC_MIN_BODY = 56; // file-id(16) md5-full(16) md5-16k(16) length(8) name…
const HEAD_HASH_BYTES = 16 * 1024;

// Parse every FileDesc packet in a buffer. Tolerates leading junk and truncated tails.
// Returns [{ fileId, hash16k, length, name }], hashes as lowercase hex.
function parseFileDescs(buf) {
  const out = [];
  const seen = new Set();
  if (!Buffer.isBuffer(buf)) return out;
  let off = 0;
  while (off + PKT_HEADER_BYTES <= buf.length) {
    const at = buf.indexOf(PKT_MAGIC, off);
    if (at === -1 || at + PKT_HEADER_BYTES > buf.length) break;
    let len;
    try { len = Number(buf.readBigUInt64LE(at + 8)); } catch { break; }
    if (!Number.isFinite(len) || len < PKT_HEADER_BYTES || len % 4 !== 0) { off = at + PKT_MAGIC.length; continue; }
    const end = at + len;
    if (end > buf.length) break; // truncated read — nothing complete past here
    if (buf.subarray(at + 48, at + 64).equals(PKT_FILEDESC)) {
      const body = buf.subarray(at + PKT_HEADER_BYTES, end);
      if (body.length >= FILEDESC_MIN_BODY) {
        const fileId = body.subarray(0, 16).toString('hex');
        const hash16k = body.subarray(32, 48).toString('hex');
        let length;
        try { length = Number(body.readBigUInt64LE(48)); } catch { length = 0; }
        const name = body.subarray(FILEDESC_MIN_BODY).toString('utf8').replace(/\0+$/, '').split(/[/\\]/).pop();
        if (name && !seen.has(fileId)) {
          seen.add(fileId);
          out.push({ fileId, hash16k, length, name });
        }
      }
    }
    off = end;
  }
  return out;
}

// MD5 of the first 16 KB (or of the whole file when shorter) — the PAR2 "16k hash".
function headHash(buf) {
  return crypto.createHash('md5').update(buf.subarray(0, Math.min(buf.length, HEAD_HASH_BYTES))).digest('hex');
}

module.exports = { parseFileDescs, headHash, HEAD_HASH_BYTES, PKT_MAGIC, PKT_FILEDESC };

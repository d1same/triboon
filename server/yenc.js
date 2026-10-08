'use strict';
// yEnc encode/decode. Decoder is the hot path; encoder exists for tests & the mock NNTP server.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, seed = 0xffffffff) {
  let c = seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Encode a part of `data` (absolute offsets, 0-based [begin,end)) as a yEnc article body.
function encodePart(data, { name, partNum, totalParts, begin, end, lineLen = 128, totalSize }) {
  const slice = data.subarray(begin, end);
  const head =
    `=ybegin part=${partNum} total=${totalParts} line=${lineLen} size=${totalSize} name=${name}\r\n` +
    `=ypart begin=${begin + 1} end=${end}\r\n`;
  const out = [];
  let line = [];
  for (let i = 0; i < slice.length; i++) {
    let c = (slice[i] + 42) & 0xff;
    if (c === 0x00 || c === 0x0a || c === 0x0d || c === 0x3d || (line.length === 0 && (c === 0x2e || c === 0x20))) {
      line.push(0x3d, (c + 64) & 0xff); // escape: '=' + (c+64)
    } else {
      line.push(c);
    }
    if (line.length >= lineLen) {
      out.push(Buffer.from(line), Buffer.from('\r\n'));
      line = [];
    }
  }
  if (line.length) out.push(Buffer.from(line), Buffer.from('\r\n'));
  const tail = `=yend size=${slice.length} part=${partNum} pcrc32=${crc32(slice).toString(16).padStart(8, '0')}\r\n`;
  return Buffer.concat([Buffer.from(head), ...out, Buffer.from(tail)]);
}

// Decode one yEnc article body. Returns { data, part: {begin,end}|null, size, name, crcOk }.
// skipDecoded: walk-and-CRC the prefix (so crcOk stays honest) but do not keep those bytes —
// a mid-segment seek only needs the suffix.
function decodeLegacy(articleBuf, opts = {}) {
  const skipDecoded = Math.max(0, Math.floor(Number(opts && opts.skipDecoded) || 0));
  const text = articleBuf;
  let pos = 0;
  let meta = { begin: null, end: null, size: null, name: null };
  let pcrc = null;
  let endSeen = false;
  let yendSize = null;
  let sawPart = false;
  let fileCrc = null;
  // Pre-size output generously; trimmed at the end.
  const out = Buffer.allocUnsafe(Math.max(0, text.length - skipDecoded));
  let o = 0;
  let decoded = 0;
  let crc = 0xffffffff;
  let inBody = false;

  while (pos < text.length) {
    let nl = text.indexOf(0x0a, pos); // \n
    if (nl === -1) nl = text.length;
    let lineEnd = nl;
    if (lineEnd > pos && text[lineEnd - 1] === 0x0d) lineEnd--; // strip \r
    const isKeyword = text[pos] === 0x3d && text[pos + 1] === 0x79; // "=y"
    if (isKeyword) {
      const line = text.toString('latin1', pos, lineEnd);
      if (line.startsWith('=ybegin')) {
        const m = /size=(\d+)/.exec(line); if (m) meta.size = parseInt(m[1], 10);
        const n = /name=(.+)$/.exec(line); if (n) meta.name = n[1].trim();
        inBody = true;
      } else if (line.startsWith('=ypart')) {
        sawPart = true;
        const b = /begin=(\d+)/.exec(line); const e = /end=(\d+)/.exec(line);
        if (b) meta.begin = parseInt(b[1], 10) - 1; // store 0-based
        if (e) meta.end = parseInt(e[1], 10);       // exclusive
      } else if (line.startsWith('=yend')) {
        const c = /pcrc32=([0-9a-fA-F]{8})/.exec(line); if (c) pcrc = parseInt(c[1], 16) >>> 0;
        const f = /(?:^|\s)crc32=([0-9a-fA-F]{8})/.exec(line); if (f) fileCrc = parseInt(f[1], 16) >>> 0;
        const z = /(?:^|\s)size=(\d+)/.exec(line); if (z) yendSize = parseInt(z[1], 10);
        endSeen = true;
        inBody = false;
      }
    } else if (inBody) {
      for (let i = pos; i < lineEnd; i++) {
        let c = text[i];
        if (c === 0x3d) {
          if (i + 1 >= lineEnd) break;
          i++;
          c = (text[i] - 64) & 0xff;
        }
        const byte = (c - 42) & 0xff;
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        if (decoded++ >= skipDecoded) out[o++] = byte;
      }
    }
    pos = nl + 1;
  }
  const data = out.subarray(0, o);
  // A single-part post only carries crc32= (no pcrc32): that is its checksum.
  const expectCrc = pcrc !== null ? pcrc : (!sawPart && fileCrc !== null ? fileCrc : null);
  const crcOk = expectCrc === null ? true : ((crc ^ 0xffffffff) >>> 0) === expectCrc;
  const part = meta.begin !== null ? { begin: meta.begin, end: meta.end } : null;
  // The article agrees with ITSELF: it ends (=yend), has bytes, and its decoded length matches the
  // sizes it declares. A cut-off or mangled copy that still passes the CRC check (no checksum, or
  // truncated before =yend) used to be accepted and later zero-filled into the picture.
  const partLen = part && Number.isFinite(part.end) ? part.end - part.begin : null;
  // A checksum that matched is the strongest proof the bytes are right: some encoders write the
  // WHOLE-file size in =yend size= or an off-by-one =ypart end, and those articles are fine. The
  // declared-length comparisons only decide when there is no checksum to lean on.
  const intact = endSeen && decoded > 0
    && (expectCrc !== null
      ? crcOk
      : ((yendSize === null || decoded === yendSize) && (partLen === null || decoded === partLen)));
  return { data, part, size: meta.size, name: meta.name, crcOk, intact, decodedLen: decoded };
}

// Hot path. Same contract as decodeLegacy (differential fuzz in e2e), but the CRC is computed once
// over the decoded bytes with zlib.crc32 (native, Node >= 22.2) instead of a table step per byte:
// ~3x faster decode on the thread that also serves video. skipDecoded still CRCs the WHOLE article
// (the checksum covers every byte); only the returned data is the suffix.
const zlibCrc32 = typeof require('zlib').crc32 === 'function' ? require('zlib').crc32 : null;
function decode(articleBuf, opts = {}) {
  if (!zlibCrc32) return decodeLegacy(articleBuf, opts);
  const skipDecoded = Math.max(0, Math.floor(Number(opts && opts.skipDecoded) || 0));
  const text = articleBuf;
  let pos = 0;
  const meta = { begin: null, end: null, size: null, name: null };
  let pcrc = null;
  let endSeen = false;
  let yendSize = null;
  let sawPart = false;
  let fileCrc = null;
  const out = Buffer.allocUnsafe(text.length);
  let o = 0;
  let inBody = false;

  while (pos < text.length) {
    let nl = text.indexOf(0x0a, pos); // \n
    if (nl === -1) nl = text.length;
    let lineEnd = nl;
    if (lineEnd > pos && text[lineEnd - 1] === 0x0d) lineEnd--; // strip \r
    const isKeyword = text[pos] === 0x3d && text[pos + 1] === 0x79; // "=y"
    if (isKeyword) {
      const line = text.toString('latin1', pos, lineEnd);
      if (line.startsWith('=ybegin')) {
        const m = /size=(\d+)/.exec(line); if (m) meta.size = parseInt(m[1], 10);
        const n = /name=(.+)$/.exec(line); if (n) meta.name = n[1].trim();
        inBody = true;
      } else if (line.startsWith('=ypart')) {
        sawPart = true;
        const b = /begin=(\d+)/.exec(line); const e = /end=(\d+)/.exec(line);
        if (b) meta.begin = parseInt(b[1], 10) - 1;
        if (e) meta.end = parseInt(e[1], 10);
      } else if (line.startsWith('=yend')) {
        const c = /pcrc32=([0-9a-fA-F]{8})/.exec(line); if (c) pcrc = parseInt(c[1], 16) >>> 0;
        const f = /(?:^|\s)crc32=([0-9a-fA-F]{8})/.exec(line); if (f) fileCrc = parseInt(f[1], 16) >>> 0;
        const z = /(?:^|\s)size=(\d+)/.exec(line); if (z) yendSize = parseInt(z[1], 10);
        endSeen = true;
        inBody = false;
      }
    } else if (inBody) {
      for (let i = pos; i < lineEnd; i++) {
        let c = text[i];
        if (c === 0x3d) {
          if (i + 1 >= lineEnd) break;
          i++;
          c = (text[i] - 64) & 0xff;
        }
        out[o++] = (c - 42) & 0xff;
      }
    }
    pos = nl + 1;
  }
  const decoded = o;
  const all = out.subarray(0, decoded);
  const expectCrc = pcrc !== null ? pcrc : (!sawPart && fileCrc !== null ? fileCrc : null);
  const crcOk = expectCrc === null ? true : (zlibCrc32(all) >>> 0) === expectCrc;
  const data = skipDecoded > 0 ? all.subarray(Math.min(skipDecoded, decoded)) : all;
  const part = meta.begin !== null ? { begin: meta.begin, end: meta.end } : null;
  const partLen = part && Number.isFinite(part.end) ? part.end - part.begin : null;
  const intact = endSeen && decoded > 0
    && (expectCrc !== null
      ? crcOk
      : ((yendSize === null || decoded === yendSize) && (partLen === null || decoded === partLen)));
  return { data, part, size: meta.size, name: meta.name, crcOk, intact, decodedLen: decoded };
}

module.exports = { encodePart, decode, decodeLegacy, crc32 };

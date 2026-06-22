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
function decode(articleBuf) {
  const text = articleBuf;
  let pos = 0;
  let meta = { begin: null, end: null, size: null, name: null };
  let pcrc = null;
  // Pre-size output generously; trimmed at the end.
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
        const b = /begin=(\d+)/.exec(line); const e = /end=(\d+)/.exec(line);
        if (b) meta.begin = parseInt(b[1], 10) - 1; // store 0-based
        if (e) meta.end = parseInt(e[1], 10);       // exclusive
      } else if (line.startsWith('=yend')) {
        const c = /pcrc32=([0-9a-fA-F]{8})/.exec(line); if (c) pcrc = parseInt(c[1], 16) >>> 0;
        inBody = false;
      }
    } else if (inBody) {
      for (let i = pos; i < lineEnd; i++) {
        let c = text[i];
        if (c === 0x3d) {
          if (i + 1 >= lineEnd) break;
          i++;
          c = (text[i] - 64) & 0xff;
          out[o++] = (c - 42) & 0xff;
        }
        else out[o++] = (c - 42) & 0xff;
      }
    }
    pos = nl + 1;
  }
  const data = out.subarray(0, o);
  const crcOk = pcrc === null ? true : crc32(data) === pcrc;
  const part = meta.begin !== null ? { begin: meta.begin, end: meta.end } : null;
  return { data, part, size: meta.size, name: meta.name, crcOk };
}

module.exports = { encodePart, decode, crc32 };

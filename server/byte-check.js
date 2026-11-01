'use strict';
// When a player says a file is unreadable, nothing in the log can tell a damaged release from Triboon
// handing it the wrong bytes: the health check only proves the articles exist. This re-downloads the
// pieces the player last read, compares them with what the stream path serves, and walks the MKV
// structure, so the log says which it was. It runs beside the switch and never delays it.
const debug = require('./debug');

const WINDOW_BYTES = 12 * 1024 * 1024;
const TIME_LIMIT_MS = 90000;
const CLUSTER_ID = 0x1f43b675;
const CLUSTER_MAGIC = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const CLUSTER_CHILDREN = new Set([0xe7, 0xa3, 0xa0, 0xab, 0xa7, 0xec, 0xbf, 0x5854]);
const TOP_LEVEL = new Set([CLUSTER_ID, 0x1c53bb6b, 0x1254c367, 0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1043a770, 0x1941a469, 0xec, 0xbf]);

function vintLength(first) {
  for (let n = 1; n <= 8; n++) if (first & (0x80 >> (n - 1))) return n;
  return 0; // 0x00: the exact byte behind "No valid varint length mask found"
}

function readId(buf, at) {
  const n = vintLength(buf[at]);
  if (!n || n > 4) return { bad: true };
  if (at + n > buf.length) return { end: true };
  let id = 0;
  for (let i = 0; i < n; i++) id = id * 256 + buf[at + i];
  return { id, next: at + n };
}

function readSize(buf, at) {
  if (at >= buf.length) return { end: true };
  const n = vintLength(buf[at]);
  if (!n) return { bad: true };
  if (at + n > buf.length) return { end: true };
  let size = buf[at] & (0xff >> n);
  let unknown = size === (0xff >> n);
  for (let i = 1; i < n; i++) {
    size = size * 256 + buf[at + i];
    if (buf[at + i] !== 0xff) unknown = false;
  }
  return { size: unknown ? null : size, next: at + n };
}

// Walks from the first Cluster in the window. A clean walk that runs off the end of the window is
// fine; `broken` is the file offset of the first element that cannot be valid MKV.
function walkMkv(buf, baseOffset = 0) {
  const start = buf.indexOf(CLUSTER_MAGIC);
  if (start < 0) return { checked: false };
  const broken = (at) => ({
    checked: true, clusters, broken: baseOffset + at,
    bytes: buf.subarray(at, Math.min(buf.length, at + 8)).toString('hex'),
  });
  let at = start;
  let clusters = 0;
  while (at < buf.length) {
    const id = readId(buf, at);
    if (id.end) break;
    if (id.bad || !TOP_LEVEL.has(id.id)) return broken(at);
    const size = readSize(buf, id.next);
    if (size.end) break;
    if (size.bad) return broken(id.next);
    if (id.id !== CLUSTER_ID) {
      if (size.size === null) break;
      at = size.next + size.size;
      continue;
    }
    clusters++;
    const limit = size.size === null ? buf.length : size.next + size.size;
    let child = size.next;
    while (child < limit && child < buf.length) {
      if (size.size === null && buf.subarray(child, child + 4).equals(CLUSTER_MAGIC)) break;
      const cid = readId(buf, child);
      if (cid.end) break;
      if (cid.bad || !CLUSTER_CHILDREN.has(cid.id)) return broken(child);
      const csize = readSize(buf, cid.next);
      if (csize.end) break;
      if (csize.bad || csize.size === null) return broken(cid.next);
      child = csize.next + csize.size;
    }
    if (child > limit && limit < buf.length) return broken(limit);
    at = size.size === null ? child : limit;
  }
  return { checked: true, clusters, broken: null };
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function longestZeroRun(buf) {
  let best = 0;
  let run = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) { run++; if (run > best) best = run; } else run = 0;
  }
  return best;
}

async function collect(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// Pure, so the wording of the answer is testable. fault is 'file', 'triboon' or 'unknown'.
function byteCheckVerdict({ served, fresh, pieces, mkv, edges }) {
  const failed = pieces.filter((p) => p.error);
  if (failed.length) return { fault: 'unknown', text: `could not re-read ${failed.length} of ${pieces.length} pieces (${failed[0].error})` };
  const corrupt = pieces.filter((p) => !p.crcOk || !p.intact);
  const diff = firstDifference(served, fresh);
  if (diff >= 0) {
    const off = pieces.filter((p) => p.offGrid);
    return {
      fault: 'triboon', at: diff,
      text: `TRIBOON served different bytes from the articles, first at window +${diff}${off.length ? `; ${off.length} pieces sit away from their slot` : ''}`,
    };
  }
  if (corrupt.length) return { fault: 'file', text: `FILE damaged: ${corrupt.length} pieces fail their own checksum` };
  if (mkv && mkv.broken != null) {
    const near = edges.some((e) => Math.abs(e - mkv.broken) <= 4096);
    return near
      ? { fault: 'triboon', text: `TRIBOON likely: bytes match the articles but the MKV breaks at a RAR volume edge, offset ${mkv.broken} (${mkv.bytes})` }
      : { fault: 'file', text: `FILE damaged: bytes match the articles and the MKV breaks at offset ${mkv.broken} (${mkv.bytes})` };
  }
  return { fault: 'unknown', text: mkv && mkv.checked ? 'these bytes are clean: the bad spot is outside this window' : 'bytes match the articles; no MKV structure to walk here' };
}

async function runByteCheck(vf, { name = '', log = (line) => debug.fail('play', line), now = Date.now } = {}) {
  if (!vf || vf._byteChecked || typeof vf.freshBytes !== 'function') return null;
  const end = Math.min(Number(vf._lastServedEnd) || 0, Number(vf.size) || 0);
  if (!(end > 0)) return null;
  vf._byteChecked = true;
  const start = Math.max(0, end - WINDOW_BYTES);
  const label = String(name || vf.name || '').slice(0, 90);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIME_LIMIT_MS);
  if (timer.unref) timer.unref();
  const t0 = now();
  try {
    // Served first, while the pieces the player read are still in the cache.
    const served = await collect(vf.read(start, end, { priority: 'background', signal: controller.signal }));
    const { buf: fresh, pieces, edges = [] } = await vf.freshBytes(start, end, { signal: controller.signal });
    const mkv = /\.mkv$/i.test(String(vf.name || '')) ? walkMkv(fresh, start) : null;
    const verdict = byteCheckVerdict({ served, fresh, pieces, mkv, edges });
    log(`byte check — "${label}": ${verdict.text} — window ${mb(start)} to ${mb(end)} of ${mb(Number(vf.size) || 0)}, ${pieces.length} pieces, `
      + `${mkv && mkv.checked ? `${mkv.clusters} clusters walked, ` : ''}longest zero run ${longestZeroRun(fresh)}, ${Math.round((now() - t0) / 1000)}s`);
    return verdict;
  } catch (e) {
    log(`byte check — "${label}": could not finish (${String((e && e.message) || e).slice(0, 120)})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runByteCheck, walkMkv, byteCheckVerdict, firstDifference, longestZeroRun, WINDOW_BYTES };

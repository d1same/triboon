'use strict';
// Quantifies the "30s to resume" report. Resume runs the SAME pipeline as a fresh play (no pick →
// width-5 parallel walk), so the walk isn't the regression. The suspect is MOUNT cost: a scene TV
// release is almost always a multi-volume store-RAR, and parseRarVolumes walks the header of EVERY
// volume before the mount returns (≈ one article fetch per volume). The parallel walk then commits
// IN RANK ORDER, so the start is gated on the best-ranked candidate finishing its mount — even if a
// lower-ranked flat release already mounted. This bench measures mountNzb() wall-clock for a flat
// single-file release vs. multi-volume RARs of growing volume count, at a realistic per-segment RTT.
//
//   node bench/resume-latency.js [rttMs] [poolSize]
//
// It proves where the seconds go without needing real provider/indexer creds.

const { NntpPool } = require('../server/nntp');
const { mountNzb } = require('../server/archive');
const { encodePart } = require('../server/yenc');
const { createMockNntp } = require('../test/mock-nntp');
const { seededPayload, writeRar5Store } = require('../test/archive-fixtures');

const RTT = parseInt(process.argv[2] || '60', 10);   // simulated per-command provider RTT (ms)
const POOL = parseInt(process.argv[3] || '8', 10);    // startup-reserve connection window

// Build an NZB (+ article map) from [{name,data}] volumes — same shape as test/archive.test.js.
function makeNzb(volumes, partSize) {
  const articles = new Map();
  const fileXml = [];
  let fileNo = 0;
  for (const v of volumes) {
    fileNo++;
    const total = Math.ceil(v.data.length / partSize) || 1;
    const segs = [];
    for (let p = 0; p < total; p++) {
      const begin = p * partSize;
      const end = Math.min(v.data.length, begin + partSize);
      const body = encodePart(v.data, { name: v.name, partNum: p + 1, totalParts: total, begin, end, totalSize: v.data.length });
      const msgId = `f${fileNo}s${p + 1}@triboon.test`;
      articles.set(msgId, body);
      segs.push(`<segment bytes="${body.length}" number="${p + 1}">${msgId}</segment>`);
    }
    fileXml.push(`<file poster="t" date="1700000000" subject="[r] &quot;${v.name}&quot; yEnc (1/${total})"><groups><group>a.b.t</group></groups><segments>${segs.join('')}</segments></file>`);
  }
  const nzb = `<?xml version="1.0"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n${fileXml.join('\n')}\n</nzb>`;
  return { nzb, articles };
}

async function timeMount(label, volumes, partSize) {
  const { nzb, articles } = makeNzb(volumes, partSize);
  const mock = createMockNntp({ articles, latencyMs: RTT });
  const port = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port, tls: false }, POOL);
  pool.warm(POOL);
  await new Promise((r) => setTimeout(r, RTT + 40)); // let warm handshakes settle (as at server boot)
  // median of 3 to damp scheduler jitter
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const vf = await mountNzb(pool, nzb);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (i === 0) {
      console.log(`  ${label}`);
      console.log(`    container=${vf.container} vols=${vf.vols ? vf.vols.length : 1} segments=${vf.segmentCount} streamable=${vf.streamable}`);
    }
  }
  pool.close();
  await mock.close();
  samples.sort((a, b) => a - b);
  console.log(`    mount median=${samples[1].toFixed(0)}ms  (min ${samples[0].toFixed(0)} / max ${samples[2].toFixed(0)})`);
  return samples[1];
}

(async () => {
  console.log(`\nMount latency vs. archive layout  —  RTT=${RTT}ms per NNTP command, pool=${POOL} connections\n`);

  // ~50MB per volume of video, segment ~700KB (typical usenet article). We scale payload DOWN but
  // keep VOLUME COUNT realistic — mount cost is one first-segment fetch PER VOLUME, so count is the
  // variable that matters. partSize chosen so each volume is ~3 segments (header lives in seg 1).
  const SEG = 64 * 1024;        // article payload size proxy
  const PER_VOL = 3 * SEG;      // ~3 articles per volume

  // Flat WEB-DL: one .mkv, no RAR. Mount only needs the first segment to identify the primary file.
  const flat = [{ name: 'House.of.the.Dragon.S02E01.2160p.WEB-DL.DDP5.1.H.265-NTb.mkv', data: seededPayload(20 * PER_VOL, 0x100) }];
  const flatMs = await timeMount('FLAT  single-file WEB-DL (20 segments, 1 file)', flat, SEG);
  console.log('');

  // Multi-volume store-RAR (scene TV norm), growing volume count.
  const big = seededPayload(60 * PER_VOL, 0x200); // same total bytes across all RAR cases
  const results = [];
  for (const vcount of [6, 12, 24, 48]) {
    const volSize = Math.ceil(big.length / vcount);
    const vols = writeRar5Store([{ name: 'House.of.the.Dragon.S02E01.2160p.BluRay.x265-GROUP.mkv', data: big }], { volSize, base: 'hotd.s02e01', naming: 'part' });
    const ms = await timeMount(`RAR   ${vols.length}-volume store-RAR (same total bytes)`, vols, SEG);
    results.push({ vols: vols.length, ms });
    console.log('');
  }

  console.log('SUMMARY');
  console.log(`  flat single-file mount : ${flatMs.toFixed(0)}ms`);
  for (const r of results) console.log(`  ${String(r.vols).padStart(2)}-volume RAR mount     : ${r.ms.toFixed(0)}ms   (${(r.ms / flatMs).toFixed(1)}× the flat mount)`);
  console.log('\n  The parallel walk commits in RANK ORDER, so press-play→start is gated on the');
  console.log('  best-ranked candidate finishing THIS mount. A rotted top pick that fails slowly');
  console.log('  then a multi-volume RAR behind it stacks these numbers toward the 30s report.\n');
})().catch((e) => { console.error(e); process.exit(1); });

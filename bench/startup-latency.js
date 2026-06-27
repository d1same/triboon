'use strict';
// Measures the press-play → mounted latency through the real Pipeline against the in-memory mock
// NNTP (with a configurable per-command RTT) + a mock indexer. Used to quantify the first-article
// STAT probe overlap (startup win #1): run it before and after the change and compare avg play ms.
//
//   node bench/startup-latency.js [rttMs] [iterations]
//
// It reports total play() wall-clock plus the pipeline metric breakdown (probe/mount/health-gate).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pipeline } = require('../server/pipeline');
const { NntpPool } = require('../server/nntp');
const { Store, VerdictCache } = require('../server/store');
const { createMockNntp } = require('../test/mock-nntp');
const { encodePart } = require('../server/yenc');

const RTT = parseInt(process.argv[2] || '60', 10);   // simulated per-command provider RTT (ms)
const ITERS = parseInt(process.argv[3] || '12', 10);

function seeded(size, seed) {
  const d = Buffer.allocUnsafe(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s & 0xff; }
  return d;
}
function nzbFor(name, data, partSize, prefix) {
  const articles = new Map();
  const total = Math.ceil(data.length / partSize) || 1;
  const segs = [];
  for (let p = 0; p < total; p++) {
    const begin = p * partSize; const end = Math.min(data.length, begin + partSize);
    const body = encodePart(data, { name, partNum: p + 1, totalParts: total, begin, end, totalSize: data.length });
    const id = `${prefix}s${p}@bench.test`;
    articles.set(id, body);
    segs.push(`<segment bytes="${body.length}" number="${p + 1}">${id}</segment>`);
  }
  const nzb = `<?xml version="1.0"?><nzb><file poster="t" date="1" subject="[r] &quot;${name}&quot; yEnc (1/${total})"><groups><group>a.b</group></groups><segments>${segs.join('')}</segments></file></nzb>`;
  return { nzb, articles };
}

(async () => {
  const data = seeded(2 * 1024 * 1024, 0xbeef); // ~2MB flat release
  const rel = nzbFor('Bench.Movie.2024.1080p.WEB-DL.H.264-NTb.mkv', data, 256 * 1024, 'bench');
  const mock = createMockNntp({ articles: rel.articles, latencyMs: RTT });
  const nntpPort = await mock.listen();
  const ix = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><item><title>Bench.Movie.2024.1080p.WEB-DL.H.264-NTb</title><link>http://127.0.0.1:${ix.address().port}/nzb</link><enclosure url="http://127.0.0.1:${ix.address().port}/nzb" length="${5e9}" type="application/x-nzb"/><newznab:attr name="size" value="${5e9}"/></item></channel></rss>`);
    }
    res.writeHead(200); res.end(rel.nzb);
  });
  const ixPort = await new Promise((r) => ix.listen(0, '127.0.0.1', () => r(ix.address().port)));

  const samples = [];
  for (let i = 0; i < ITERS; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-bench-'));
    const store = new Store(dir);
    const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 8);
    pool.warm(8); // realistic: connections pre-warmed (as at server boot)
    await new Promise((r) => setTimeout(r, RTT + 30)); // let warm handshakes settle
    const pipeline = new Pipeline({
      pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
      indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
    });
    const t0 = process.hrtime.bigint();
    await pipeline.play({ q: 'Bench Movie 2024' }, {});
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (i === ITERS - 1) console.log('metrics:', JSON.stringify(pipeline.metricsSnapshot().firstProbe), JSON.stringify(pipeline.metricsSnapshot().mount));
    pool.close(); store.close();
  }
  ix.close(); await mock.close();
  samples.sort((a, b) => a - b);
  const avg = samples.reduce((s, x) => s + x, 0) / samples.length;
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`play() over ${ITERS} runs @ ${RTT}ms RTT:  avg=${avg.toFixed(1)}ms  median=${median.toFixed(1)}ms  min=${samples[0].toFixed(1)}ms  max=${samples[samples.length - 1].toFixed(1)}ms`);
})().catch((e) => { console.error(e); process.exit(1); });

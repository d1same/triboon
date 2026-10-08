'use strict';
// Multi-viewer load simulation: N virtual players pull articles through the REAL connection pool
// and allocator from mock providers that each have their own speed. Reports start time, stall time
// and lines used per viewer. A/B an old checkout with SERVER_DIR=<path>/server.
//   node bench/multi-viewer-sim.js [--mode auto|custom] [--secs 40] [--mix 4k,4k,4k,1080,1080,1080]
const path = require('path');
const dir = process.env.SERVER_DIR ? path.resolve(process.env.SERVER_DIR) : path.join(__dirname, '..', 'server');
const { NntpPool } = require(path.join(dir, 'nntp'));
const P = require(path.join(dir, 'pipeline'));
const { createMockNntp } = require(path.join(__dirname, '..', 'test', 'mock-nntp'));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MODE = arg('mode', 'auto');
const SECS = +arg('secs', 40);
const MIX = arg('mix', '4k,4k,4k,1080,1080,1080').split(',');
const MEASURED = +arg('measured', 22.6);          // the saved speed-test figure (optimistic)
const LATENCIES = (arg('lat', '600,900,1100,1400')).split(',').map(Number); // ms per article, per provider
const CAPS = (arg('caps', '100,40,40,30')).split(',').map(Number);
const ART_BYTES = 700 * 1024;
const BODY = Buffer.from(`=ybegin part=1 total=1 line=128 size=${ART_BYTES} name=x\r\n=ypart begin=1 end=${ART_BYTES}\r\n${'A'.repeat(2000)}\r\n=yend size=${ART_BYTES} pcrc32=00000000\r\n`);

(async () => {
  const articles = new Map();
  for (let i = 0; i < 20000; i++) articles.set(`a${i}@sim`, BODY);
  const servers = []; const opts = [];
  for (let i = 0; i < LATENCIES.length; i++) {
    const m = createMockNntp({ articles, latencyMs: LATENCIES[i] });
    const port = await m.listen(); servers.push(m);
    opts.push({ host: `127.0.0.${i + 1}`, port, tls: false, connectHost: '127.0.0.1' });
  }
  // The mock listens on 127.0.0.1; give every provider the same host but a distinct label.
  const pool = new NntpPool(opts.map((o, i) => ({ host: '127.0.0.1', port: o.port, tls: false, label: `p${i}` })), 40);
  pool.providers.forEach((p, i) => { p.size = CAPS[i] || 30; p.configuredSize = p.size; });
  const bitrate = (k) => (k === '4k' ? 60 : 15);     // Mbps the player consumes
  const perf = { connectionMode: MODE, usableConnections: Math.floor(CAPS.reduce((a, b) => a + b, 0) * 0.85),
    serverDownloadMbps: 900, measuredMbpsPerConn: MEASURED, maxConnPerStream1080: 10, maxConnPerStream4k: 12 };
  perf.reserveConnections = Math.ceil(perf.usableConnections * 0.2);
  const t0 = Date.now();
  const viewers = MIX.map((k, i) => ({
    id: `v${i}`, kind: k, rate: bitrate(k) * 1e6 / 8 / ART_BYTES, // articles per second consumed
    next: 0, inflight: 0, have: new Set(), play: 0, started: null, stall: 0, stalled: false, lastTick: t0, lines: 0,
    mount: { size: (k === '4k' ? 9 : 3) * 1e9, _releaseName: k === '4k' ? 'X.2160p.WEB-DL' : 'X.1080p.WEB-DL', _tracks: { duration: 2520 },
      _activeStreamReads: 1, _playbackTouched: t0, aheadCacheBytes: 0 },
  }));
  const GOAL_SEC = 30;
  const rebalance = () => {
    for (const v of viewers) v.mount.aheadCacheBytes = Math.max(0, (v.have.size - Math.floor(v.play))) * ART_BYTES;
    const shares = P.allocateStreamConnections(viewers.map((v) => v.mount), perf, { now: Date.now(), viewerChanged: false });
    viewers.forEach((v, i) => { v.lines = shares[i]; });
    pool.setViewerShares(viewers.map((v) => ({ id: v.id, lines: v.lines })));
    pool.setPlaybackOpenCap(viewers.reduce((n, v) => n + v.lines, 0));
  };
  rebalance();
  const iv = setInterval(rebalance, 1000);
  const pump = (v) => {
    const ahead = v.have.size + v.inflight - Math.floor(v.play);
    while (v.inflight < Math.max(v.lines, 4) + 4 && ahead + 0 < GOAL_SEC * v.rate + v.inflight && v.next < 19990) {
      const idx = v.next++; v.inflight++;
      const needed = idx === Math.floor(v.play) || (!v.started && idx < 2); // the piece the player is blocked on; beyond it is read-ahead
      pool.body(`a${idx}@sim`, needed ? 'playback' : 'readAhead', { viewer: v.id })
        .then(() => { v.have.add(idx); }, (e) => { v.errs = (v.errs || 0) + 1; v.lastErr = String(e && e.message).slice(0, 60); v.next = Math.min(v.next, idx); v.retry = idx; })
        .finally(() => { v.inflight--; pump(v); });
      if (v.next - Math.floor(v.play) > GOAL_SEC * v.rate) break;
    }
  };
  const tick = setInterval(() => {
    const now = Date.now();
    for (const v of viewers) {
      const dt = (now - v.lastTick) / 1000; v.lastTick = now;
      const buffered = (() => { let n = 0; for (let i = Math.floor(v.play); v.have.has(i); i++) n++; return n; })();
      if (v.started == null) { if (buffered >= v.rate * 1.5) v.started = (now - t0) / 1000; }
      else if (buffered >= 1) { v.play += v.rate * dt; v.stalled = false; }
      else { v.stall += dt; v.stalled = true; }
      pump(v);
    }
  }, 100);
  const { linesSummary } = require(path.join(dir, 'nntp'));
  for (const at of [8, 16, 24]) setTimeout(() => { if (linesSummary) console.log(`t=${at}s ${linesSummary(pool.stats())}`); }, at * 1000);
  await new Promise((r) => setTimeout(r, SECS * 1000));
  clearInterval(tick); clearInterval(iv);
  console.log(`mode=${MODE} measured=${MEASURED} latencies=${LATENCIES} caps=${CAPS} secs=${SECS}`);
  let totalStall = 0;
  for (const v of viewers) {
    totalStall += v.stall;
    console.log(`${v.id} ${v.kind.padEnd(4)} lines=${String(v.lines).padStart(2)} start=${v.started == null ? 'NEVER' : v.started.toFixed(1) + 's'} stall=${v.stall.toFixed(1)}s played=${(v.play / v.rate).toFixed(0)}s have=${v.have.size} next=${v.next} inflight=${v.inflight} firstMissing=${(() => { let i = 0; while (v.have.has(i)) i++; return i; })()} errs=${v.errs || 0} ${v.lastErr || ''}`);
  }
  pool.providers.forEach((p, i) => {
    const q = p.queue.filter((t) => t.viewer === 'v3').map((t) => `${t.priority}:${((Date.now() - t.at) / 1000).toFixed(0)}s`);
    const conns = p.conns.map((c) => `${c.owner || '-'}${c.hold ? 'H' : ''}${p.busy.has(c) ? '*' : ''}`).join(' ');
    console.log(`p${i} v3-queue=[${q.join(',')}] total-queue=${p.queue.length} conns: ${conns}`);
  });
  const st = pool.stats();
  console.log(`house open=${st.open} busy=${st.inUse} cap=${st.openCap} totalStall=${totalStall.toFixed(1)}s`);
  pool.close(); for (const s of servers) await s.close();
  process.exit(0);
})();

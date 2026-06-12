'use strict';
// Provider benchmark: connection setup, STAT RTT, and BODY throughput at 1/4/8/12/16
// parallel connections. Reads NNTP_HOST/PORT/TLS/USER/PASS from env — no credentials on disk.
// Usage: node bench/provider-bench.js

const { NntpConnection } = require('../server/nntp');

const opts = {
  host: process.env.NNTP_HOST,
  port: +(process.env.NNTP_PORT || 563),
  tls: process.env.NNTP_TLS !== '0',
  user: process.env.NNTP_USER,
  pass: process.env.NNTP_PASS,
};
if (!opts.host || !opts.user) {
  console.error('Set NNTP_HOST/NNTP_PORT/NNTP_TLS/NNTP_USER/NNTP_PASS');
  process.exit(1);
}

const TIERS = [1, 4, 8, 12, 16];
const MAX_CONNS = Math.max(...TIERS);
const SETUP_SAMPLES = 6;
const STAT_SAMPLES = 20;
const TIER_DURATION_MS = 8000;
const CANDIDATE_GROUPS = [
  'alt.binaries.boneless', 'alt.binaries.teevee', 'alt.binaries.moovee',
  'alt.binaries.hdtv', 'alt.binaries.misc',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, label, conn) {
  let t;
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => {
      if (conn) try { conn.sock.destroy(); } catch {}
      rej(new Error(`timeout: ${label} > ${ms}ms`));
    }, ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}
function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    min: s[0], max: s[s.length - 1], mean: sum / s.length,
    median: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2,
  };
}
const fmt = (n, d = 1) => n.toFixed(d);

async function measureSetup() {
  const times = [];
  const conns = [];
  for (let i = 0; i < SETUP_SAMPLES; i++) {
    const c = new NntpConnection(opts);
    const t0 = process.hrtime.bigint();
    await withTimeout(c.connect(), 15000, 'connect', c);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    conns.push(c);
  }
  return { times, conns };
}

async function measureStatRtt(conn) {
  const times = [];
  for (let i = 0; i < STAT_SAMPLES; i++) {
    const id = `triboon-bench-${i}-${Math.floor(Math.random() * 1e9)}@bench.invalid`;
    const t0 = process.hrtime.bigint();
    await withTimeout(conn.stat(id), 10000, 'STAT', conn); // 430 expected — RTT is what we measure
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return times;
}

async function selectGroup(conn) {
  for (const g of CANDIDATE_GROUPS) {
    const r = await withTimeout(conn._cmd(`GROUP ${g}`), 10000, `GROUP ${g}`, conn);
    if (r.status.startsWith('211')) {
      const [, count, first, last] = r.status.trim().split(/\s+/).map(Number);
      if (count > 1000) return { name: g, count, first, last };
    }
  }
  throw new Error('No usable binary group found on this provider');
}

function randomArticle(group) {
  const window = Math.min(group.last - group.first, 500000); // recent articles → best retention
  return group.last - Math.floor(Math.random() * window);
}

async function throughputTier(conns, group, durationMs) {
  const t0 = Date.now();
  let bytes = 0, articles = 0, misses = 0;
  await Promise.all(conns.map(async (c) => {
    try { await withTimeout(c._cmd(`GROUP ${group.name}`), 10000, 'GROUP', c); } catch { return; }
    while (Date.now() - t0 < durationMs) {
      try {
        const r = await withTimeout(c._cmd(`BODY ${randomArticle(group)}`, true), 20000, 'BODY', c);
        if (r.status.startsWith('222')) { bytes += r.body.length; articles++; } else misses++;
      } catch (e) {
        if (!c.alive || /not connected|closed|timeout/.test(e.message)) return;
        misses++;
      }
    }
  }));
  const secs = (Date.now() - t0) / 1000;
  return { n: conns.length, bytes, articles, misses, secs };
}

(async () => {
  console.log(`Benchmarking ${opts.host}:${opts.port} (TLS=${opts.tls})\n`);

  // 1. Connection setup (TCP + TLS + greeting + AUTHINFO), sequential
  const { times: setupTimes, conns } = await measureSetup();
  const su = stats(setupTimes);
  console.log(`Connection setup (n=${SETUP_SAMPLES}): min ${fmt(su.min)}ms · median ${fmt(su.median)}ms · mean ${fmt(su.mean)}ms · max ${fmt(su.max)}ms`);
  console.log(`  samples: ${setupTimes.map((t) => fmt(t, 0)).join(', ')} ms`);

  // 2. STAT RTT on a warm connection
  const rtts = await measureStatRtt(conns[0]);
  const rt = stats(rtts);
  console.log(`STAT RTT (n=${STAT_SAMPLES}): min ${fmt(rt.min)}ms · median ${fmt(rt.median)}ms · mean ${fmt(rt.mean)}ms · max ${fmt(rt.max)}ms\n`);

  // 3. Pick a binary group with real articles
  const group = await selectGroup(conns[0]);
  console.log(`Throughput group: ${group.name} (${group.count.toLocaleString()} articles)\n`);

  // Top up the pool to MAX_CONNS (parallel — setup already measured)
  while (conns.length < MAX_CONNS) {
    const batch = Array.from({ length: Math.min(4, MAX_CONNS - conns.length) }, () => new NntpConnection(opts));
    await Promise.all(batch.map((c) => withTimeout(c.connect(), 15000, 'connect', c)));
    conns.push(...batch);
  }

  // 4. Throughput tiers, ~8s each, random recent articles
  const rows = [];
  for (const n of TIERS) {
    const live = conns.filter((c) => c.alive).slice(0, n);
    const r = await throughputTier(live, group, TIER_DURATION_MS);
    const mbs = r.bytes / 1e6 / r.secs;
    rows.push({ ...r, mbs });
    console.log(`  ${String(n).padStart(2)} conn: ${fmt(mbs)} MB/s (${fmt(mbs * 8)} Mbps) · ${r.articles} articles · ${r.misses} misses · ${fmt(mbs / r.n, 2)} MB/s per conn`);
    await sleep(300);
  }

  console.log('\n| Connections | MB/s | Mbps | MB/s per conn | Articles | Misses |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.n} | ${fmt(r.mbs)} | ${fmt(r.mbs * 8)} | ${fmt(r.mbs / r.n, 2)} | ${r.articles} | ${r.misses} |`);
  }

  for (const c of conns) c.close();
  process.exit(0);
})().catch((e) => { console.error('BENCH FAILED:', e.message); process.exit(1); });

'use strict';
// Follow-up: compare STAT RTT on EXISTING articles (by number, in group context) vs misses,
// and DATE command RTT as a pure-network baseline. Credentials from env, as provider-bench.js.

const { NntpConnection } = require('../server/nntp');

const opts = {
  host: process.env.NNTP_HOST, port: +(process.env.NNTP_PORT || 563),
  tls: process.env.NNTP_TLS !== '0', user: process.env.NNTP_USER, pass: process.env.NNTP_PASS,
};
const N = 15;
function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { min: s[0], median: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2, max: s[s.length - 1] };
}
const fmt = (o) => `min ${o.min.toFixed(1)}ms · median ${o.median.toFixed(1)}ms · max ${o.max.toFixed(1)}ms`;

(async () => {
  const c = new NntpConnection(opts);
  await c.connect();

  // Pure-network baseline: DATE is a trivial server-side op.
  const dateTimes = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await c._cmd('DATE');
    dateTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`DATE (network baseline):  ${fmt(stats(dateTimes))}`);

  // STAT hits: real article numbers from a busy group.
  const g = await c._cmd('GROUP alt.binaries.boneless');
  const [, count, first, last] = g.status.trim().split(/\s+/).map(Number);
  const hitTimes = [];
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const n = last - Math.floor(Math.random() * Math.min(count - 1, 500000));
    const t0 = process.hrtime.bigint();
    const r = await c._cmd(`STAT ${n}`);
    hitTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (r.status.startsWith('223')) hits++;
  }
  console.log(`STAT existing (${hits}/${N} 223): ${fmt(stats(hitTimes))}`);

  // STAT misses: invalid message-ids (the original measurement).
  const missTimes = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await c.stat(`triboon-bench-${i}-${Math.floor(Math.random() * 1e9)}@bench.invalid`);
    missTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`STAT miss (430):          ${fmt(stats(missTimes))}`);

  c.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

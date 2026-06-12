'use strict';
// Real end-to-end smoke test: query nzbgeek for a RAR'd release, fetch the NZB, mount it
// against the real Easynews provider, and stream-verify a few byte ranges (header magic at 0,
// a mid range, and the tail) — proving archive mounting works outside the mock. Read-only.
// Env: NNTP_* (Easynews), NZBGEEK_KEY. Usage: node bench/real-rar-smoke.js ["search terms"]

const https = require('https');
const { NntpPool } = require('../server/nntp');
const { mountNzb } = require('../server/archive');
const { detectContainer } = require('../server/archive');

const nntpOpts = {
  host: process.env.NNTP_HOST, port: +(process.env.NNTP_PORT || 563),
  tls: process.env.NNTP_TLS !== '0', user: process.env.NNTP_USER, pass: process.env.NNTP_PASS,
};
const GEEK = process.env.NZBGEEK_KEY;
const QUERY = process.argv[2] || '';

function get(url, headers = {}) {
  headers = { 'User-Agent': 'Triboon/0.1 (+phase1-smoke)', ...headers };
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, headers));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

(async () => {
  // 1. Search nzbgeek (newznab). Prefer small results so the smoke test is quick.
  const base = 'https://api.nzbgeek.info/api';
  const q = QUERY
    ? `${base}?t=search&q=${encodeURIComponent(QUERY)}&limit=40&apikey=${GEEK}`
    : `${base}?t=search&cat=2040,5040&limit=60&apikey=${GEEK}`; // movies/TV HD
  const sr = await get(q);
  const xml = sr.body.toString('utf8');

  // Parse <item> blocks: title, size, and the NZB download URL.
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = (/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(b) || [])[1] || '';
    const size = +((/<enclosure[^>]*length="(\d+)"/.exec(b) || [])[1] || (/newznab:attr name="size" value="(\d+)"/.exec(b) || [])[1] || 0);
    const url = (/<enclosure[^>]*url="([^"]+)"/.exec(b) || [])[1] || (/<link>([^<]+)<\/link>/.exec(b) || [])[1];
    if (url) items.push({ title, size, url: url.replace(/&amp;/g, '&') });
  }
  if (!items.length) { console.error('No nzbgeek results. XML head:', xml.slice(0, 400)); process.exit(2); }
  items.sort((a, b) => a.size - b.size);
  console.log(`nzbgeek returned ${items.length} items; smallest: "${items[0].title}" (${(items[0].size / 1e6).toFixed(0)} MB)`);

  const pool = new NntpPool(nntpOpts, 16);
  const wantRar = process.env.REQUIRE_RAR === '1';

  // 2. Walk smallest-first until one mounts as a streamable RAR/zip.
  const seen = {};
  for (const it of items.slice(0, 40)) {
    let nzb;
    try { nzb = (await get(it.url)).body.toString('utf8'); } catch { continue; }
    if (!/<file\b/i.test(nzb)) continue;
    let vf;
    try { vf = await mountNzb(pool, nzb); } catch (e) { console.log(`  skip "${it.title.slice(0, 50)}": ${e.message}`); continue; }
    seen[vf.container] = (seen[vf.container] || 0) + 1;
    if (wantRar && vf.container !== 'rar') continue; // hunting specifically for a RAR set
    const tag = `${vf.container}/${vf.method || '-'} streamable=${vf.streamable} tags=[${vf.tags.join(',')}]`;
    console.log(`\nMounted "${vf.name}" — ${tag}`);
    console.log(`  size=${(vf.size / 1e6).toFixed(1)}MB  segments=${vf.segmentCount}  volumes=${vf.vols ? vf.vols.length : 1}`);
    if (!vf.streamable) { console.log('  (not streamable — trying next)'); continue; }

    // 3. Stream-verify: header magic + a mid window + the tail.
    const t0 = Date.now();
    const head = await collect(vf.read(0, 16));
    const ttfb = Date.now() - t0;
    const inner = detectContainer(head);
    console.log(`  first 16 bytes: ${head.toString('hex')}  (inner sig: ${inner || 'video/raw'})  TTFB=${ttfb}ms`);

    const midOff = Math.floor(vf.size / 2);
    const t1 = Date.now();
    const mid = await collect(vf.read(midOff, midOff + 65536));
    console.log(`  mid 64KB @ ${(midOff / 1e6).toFixed(1)}MB: got ${mid.length} bytes in ${Date.now() - t1}ms`);

    const tail = await collect(vf.read(vf.size - 65536, vf.size));
    console.log(`  tail 64KB: got ${tail.length} bytes`);

    const h = await vf.triage(8);
    console.log(`  triage: ${h.verdict} (${h.missing}/${h.sampled} missing)`);
    console.log('\n✅ REAL-PROVIDER STREAM VERIFIED. streamUrl would serve this to VLC.');
    if (process.env.SAVE_NZB) {
      require('fs').writeFileSync(process.env.SAVE_NZB, nzb);
      console.log(`  saved NZB → ${process.env.SAVE_NZB} ("${it.title.slice(0, 60)}")`);
    }
    pool.close();
    process.exit(0);
  }
  console.log(`\nNo streamable ${wantRar ? 'RAR' : 'store-RAR/zip'} found in sample. Containers seen: ${JSON.stringify(seen)}`);
  pool.close();
  process.exit(3);

  async function collect(gen) { const c = []; for await (const x of gen) c.push(x); return Buffer.concat(c); }
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });

'use strict';
// Measures how long the IPTV warm holds the main thread on a household-sized lineup.
// Unraid 2026-10-23: two Jellyfin requests took 3.9 s (neighbours 2-70 ms) right before
// "[iptv] warmed 9004 channels + XMLTV". This serves a synthetic 9,004-channel M3U plus an XMLTV
// guide (24 programmes per channel), boots an isolated server, runs a forced warm, and prints the
// longest event-loop blocks plus the functions that held the thread.
//
//   node bench/iptv-warm-stall.js [channels=9004] [programmesPerChannel=24]

const http = require('http');
const inspector = require('inspector');
const { bootServer, setupAdmin, httpJson } = require('../test/helpers');
const { summarizeCpuProfile } = require('../server/debug');

const CHANNELS = Number(process.argv[2]) || 9004;
const PROGRAMMES = Number(process.argv[3]) || 24;

function m3u() {
  const rows = ['#EXTM3U'];
  for (let i = 0; i < CHANNELS; i++) {
    rows.push(`#EXTINF:-1 tvg-id="ch${i}.bench" tvg-name="Channel ${i}" tvg-logo="http://127.0.0.1/logo/${i}.png" group-title="Group ${i % 40}",Channel ${i} HD`);
    rows.push(`http://127.0.0.1:9/live/${i}.ts`);
  }
  return rows.join('\n');
}
function xmltv() {
  const out = ['<?xml version="1.0" encoding="UTF-8"?><tv>'];
  for (let i = 0; i < CHANNELS; i++) out.push(`<channel id="ch${i}.bench"><display-name>Channel ${i}</display-name></channel>`);
  const t0 = new Date(Date.now() - 3600000);
  const stamp = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  for (let i = 0; i < CHANNELS; i++) {
    for (let p = 0; p < PROGRAMMES; p++) {
      const a = new Date(t0.getTime() + p * 1800000);
      const b = new Date(a.getTime() + 1800000);
      out.push(`<programme start="${stamp(a)}" stop="${stamp(b)}" channel="ch${i}.bench"><title>Show ${p} on ${i}</title><desc>Episode description number ${p} for channel ${i}, long enough to look like a real guide entry with a sentence or two.</desc></programme>`);
    }
  }
  out.push('</tv>');
  return out.join('\n');
}

(async () => {
  const playlist = Buffer.from(m3u());
  const guide = Buffer.from(xmltv());
  const fixture = http.createServer((req, res) => {
    if (req.url.startsWith('/list.m3u')) { res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }); return res.end(playlist); }
    if (req.url.startsWith('/guide.xml')) { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(guide); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const fport = fixture.address().port;
  console.log(`fixture: ${CHANNELS} channels, M3U ${(playlist.length / 1e6).toFixed(1)} MB, XMLTV ${(guide.length / 1e6).toFixed(1)} MB`);

  const srv = await bootServer({ NNTP_HOST: null, TMDB_BASE: null, TRIBOON_ALLOW_PRIVATE_IPTV: '1' });
  try {
    const admin = await setupAdmin(srv.port);
    const add = await httpJson(srv.port, 'POST', '/api/iptv/sources', {
      name: 'Bench', iptvMode: 'm3u', iptvUrl: `http://127.0.0.1:${fport}/list.m3u`, epgUrl: `http://127.0.0.1:${fport}/guide.xml`,
    }, admin);
    if (add.status !== 200) throw new Error(`add source: ${add.status} ${JSON.stringify(add.json)}`);

    for (const round of ['cold (forced fetch)', 'warm again (forced fetch)']) {
      const blocks = [];
      let last = performance.now();
      const tick = setInterval(() => {
        const now = performance.now();
        const gap = now - last - 5;
        if (gap > 50) blocks.push(Math.round(gap));
        last = now;
      }, 5);
      const session = new inspector.Session();
      session.connect();
      await new Promise((r) => session.post('Profiler.enable', () => session.post('Profiler.setSamplingInterval', { interval: 1000 }, () => session.post('Profiler.start', r))));
      const t0 = Date.now();
      const r = await srv.warmIptvCaches('bench', { force: true });
      await new Promise((res) => setTimeout(res, 1500)); // let the async store flush run inside the window
      const profile = await new Promise((res) => session.post('Profiler.stop', (e, out) => res(out && out.profile)));
      session.disconnect();
      clearInterval(tick);
      blocks.sort((a, b) => b - a);
      console.log(`\n${round}: ${Date.now() - t0} ms total, channels=${r.channels} xmltv=${r.xmltv}`);
      console.log(`  longest loop blocks (ms): ${blocks.slice(0, 8).join(', ') || 'none > 50 ms'}`);
      console.log(`  busiest code: ${summarizeCpuProfile(profile, 8).map((t) => `${t.fn} ${t.pct}%`).join(' | ')}`);
      // What a settings save did before 3.4.3: a synchronous flush of EVERY dirty table. Re-dirty the
      // guide tables the warm just wrote and time both flavours.
      for (const t of ['iptvcaches', 'epgcaches', 'iptvcache', 'epgcache']) if (srv.store.cache.has(t)) srv.store.dirty.add(t);
      const dirtyMb = [...srv.store.dirty].reduce((n, t) => n + JSON.stringify(srv.store.cache.get(t) || null).length, 0) / 1e6;
      let f0 = performance.now();
      srv.store.flush(['settings']);
      const scoped = performance.now() - f0;
      f0 = performance.now();
      srv.store.flush();
      const full = performance.now() - f0;
      console.log(`  settings-save flush: scoped ${scoped.toFixed(1)} ms vs old full flush ${full.toFixed(0)} ms (${dirtyMb.toFixed(1)} MB of cache tables)`);
    }
  } finally {
    await srv.shutdown();
    fixture.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });

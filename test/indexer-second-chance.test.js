'use strict';
// Brief 148: a slow indexer gets one second chance when a search ends with nothing playable,
// and the "nothing playable" line names the real reason (cinema copy, over the cap, filtered word).
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Pipeline, summarizeUnplayable, noPlayableError } = require('../server/pipeline');
const { rankReleases } = require('../server/scoring');
const { clearIndexerCooldowns, indexerIsCooling } = require('../server/newznab');
const { NntpPool } = require('../server/nntp');
const { Store, VerdictCache } = require('../server/store');
const { createMockNntp } = require('./mock-nntp');
const { encodePart } = require('../server/yenc');
const { seededPayload } = require('./archive-fixtures');

function nzbFor(volumes, partSize, prefix) {
  const articles = new Map();
  const fileXml = volumes.map((v, fi) => {
    const totalParts = Math.ceil(v.data.length / partSize) || 1;
    const segs = [];
    for (let p = 0; p < totalParts; p++) {
      const begin = p * partSize, end = Math.min(v.data.length, begin + partSize);
      const body = encodePart(v.data, { name: v.name, partNum: p + 1, totalParts, begin, end, totalSize: v.data.length });
      const msgId = `${prefix}f${fi}s${p}@t.test`;
      articles.set(msgId, body);
      segs.push(`<segment bytes="${body.length}" number="${p + 1}">${msgId}</segment>`);
    }
    return `<file poster="t" date="1" subject="[r] &quot;${v.name}&quot; yEnc (1/${totalParts})"><groups><group>a.b</group></groups><segments>${segs.join('')}</segments></file>`;
  }).join('');
  return { nzb: `<?xml version="1.0"?><nzb>${fileXml}</nzb>`, articles };
}
const rss = (items) => `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>${items.map((i) => `<item><title>${i.name}</title><link>${i.url}</link><enclosure url="${i.url}" length="${i.size}" type="application/x-nzb"/></item>`).join('')}</channel></rss>`;

// An indexer on a random local port. `delayMs` holds every /api answer; `release` is its one row.
function indexer({ delayMs = 0, release = null, nzb = null, status = () => 200, nzbStatus = 200 } = {}) {
  const sockets = new Set();
  const state = { hits: 0, delayMs };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const port = server.address().port;
    if (u.pathname === '/api') {
      state.hits++;
      const code = status(state.hits);
      const answer = () => {
        try {
          res.writeHead(code);
          res.end(code === 200 ? rss(release ? [{ name: release, url: `http://127.0.0.1:${port}/nzb/0`, size: 5e9 }] : []) : 'busy');
        } catch {}
      };
      if (state.delayMs > 0) setTimeout(answer, state.delayMs); else answer();
      return;
    }
    if (u.pathname === '/nzb/0' && nzb) { state.nzbHits = (state.nzbHits || 0) + 1; res.writeHead(nzbStatus); return res.end(nzbStatus === 200 ? nzb : 'nope'); }
    res.writeHead(404); res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return {
    state,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

async function rig(ixDefs, opts = {}) {
  clearIndexerCooldowns();
  const good = nzbFor([{ name: 'Movie.2024.1080p.WEB-DL.mkv', data: seededPayload(120 * 1024, 0x148) }], 30000, `sc${Math.random().toString(36).slice(2, 7)}`);
  const mock = createMockNntp({ articles: good.articles });
  const nntpPort = await mock.listen();
  const pool = new NntpPool({ host: '127.0.0.1', port: nntpPort, tls: false }, 4);
  const servers = [];
  const ixs = [];
  for (const d of ixDefs) {
    const s = indexer({ ...d, nzb: good.nzb });
    const port = await s.listen();
    servers.push(s);
    ixs.push({ name: d.name, url: `http://127.0.0.1:${port}`, apikey: 'k' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-sc-'));
  const store = new Store(dir);
  const results = [];
  const pipeline = new Pipeline({
    pool: () => pool, verdicts: new VerdictCache(store), mounts: new Map(),
    indexers: () => ixs,
    indexerTimeoutMs: opts.indexerTimeoutMs || 250,
    secondChanceTimeoutMs: opts.secondChanceTimeoutMs || 3000,
    usage: { onSearchResult: (name, outcome) => results.push({ name, outcome }) },
  });
  const done = async () => {
    try { pipeline.disposePlaybackRuntime(); } catch {}
    pool.close(); servers.forEach((s) => s.close()); await mock.close(); store.close();
  };
  return { pipeline, servers, ixs, results, done };
}

const PLAYABLE = 'Movie.2024.1080p.WEB-DL.H.264-NTb';

test('second chance: one indexer misses the 2 s deadline and the rest find nothing, so that indexer is asked once more and the title plays', async () => {
  const r = await rig([
    { name: 'quick' },                                   // answers at once, nothing found
    { name: 'slowgeek', delayMs: 2300, release: PLAYABLE }, // misses the 2 s (here 250 ms) budget, answers in 2.3 s
  ]);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    const play = await r.pipeline.play({ q: 'Movie 2024' });
    assert.strictEqual(play.candidate.name, PLAYABLE, 'the second-chance release plays');
    assert.strictEqual(r.pipeline.metrics.secondChanceRounds, 1, 'exactly one second-chance round');
    const line = logs.find((l) => /second chance: slowgeek answered in \d+ ms, \d+ new release/.test(l));
    assert.ok(line, `log names the indexer, its time and the new releases: ${logs.join(' | ')}`);
    assert.ok(r.results.some((x) => x.name === 'slowgeek' && x.outcome === 'timeout'), 'the first-round timeout is recorded for indexer health');
  } finally {
    console.log = orig;
    await r.done();
  }
});

test('second chance: a Play that already has a playable result never waits for the slow indexer', async () => {
  const r = await rig([
    { name: 'quick', release: PLAYABLE },
    { name: 'slowgeek', delayMs: 2500, release: 'Movie.2024.2160p.WEB-DL.H.265-FLUX' },
  ]);
  try {
    const t0 = Date.now();
    const play = await r.pipeline.play({ q: 'Movie 2024' });
    const ms = Date.now() - t0;
    assert.strictEqual(play.candidate.name, PLAYABLE);
    const hitsAtPlay = r.servers[1].state.hits;
    await new Promise((res) => setTimeout(res, 150));
    assert.strictEqual(r.servers[1].state.hits, hitsAtPlay, 'no extra request went to the slow indexer');
    assert.ok(!(r.pipeline.metrics.secondChanceRounds > 0), 'no second-chance round ran');
    assert.ok(ms < 2500, `Play did not wait for the slow indexer (${ms} ms)`);
  } finally {
    await r.done();
  }
});

test('second chance: cancelling the Play stops the round at once and leaves it free for the next Play', async () => {
  const r = await rig([
    { name: 'quick' },
    { name: 'slowgeek', delayMs: 5000 },
  ], { secondChanceTimeoutMs: 4000 });
  try {
    const ac = new AbortController();
    const t0 = Date.now();
    let roundStartedAt = 0;
    const watch = setInterval(() => {
      if (!roundStartedAt && r.pipeline.metrics.secondChanceRounds > 0) {
        roundStartedAt = Date.now();
        setTimeout(() => ac.abort(), 100);
      }
    }, 10);
    let err = null;
    try { await r.pipeline.play({ q: 'Movie 2024' }, {}, {}, { signal: ac.signal }); } catch (e) { err = e; }
    clearInterval(watch);
    assert.ok(err, 'the cancelled Play does not play');
    assert.ok(roundStartedAt > 0, 'the second-chance round had started');
    assert.ok(Date.now() - roundStartedAt < 1500, `the round stopped right after the cancel, not after its 4 s budget (${Date.now() - roundStartedAt} ms)`);
    assert.strictEqual(r.pipeline.metrics.secondChanceCancelled, 1, 'the cancel is counted');
    assert.ok(Date.now() - t0 < 4000);
    assert.strictEqual(r.pipeline._secondChanceTried.size, 0, 'a cancelled round is not marked tried');
  } finally {
    await r.done();
  }
});

test('second chance: at most one round, a slow indexer still silent is not asked again by the next Play, and the round stays out of the shared fan-out count', async () => {
  const r = await rig([
    { name: 'quick' },
    { name: 'slowgeek', delayMs: 2000 },
  ], { secondChanceTimeoutMs: 600 });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    let fanoutsDuringRound = null;
    const watch = setInterval(() => {
      if (r.pipeline.metrics.secondChanceInflight > 0 && fanoutsDuringRound === null) fanoutsDuringRound = r.pipeline._activeFanouts;
    }, 5);
    await assert.rejects(r.pipeline.play({ q: 'Movie 2024' }), /no playable/);
    clearInterval(watch);
    assert.strictEqual(fanoutsDuringRound, 0, 'second-chance requests do not shrink another title\'s fan-out width');
    assert.strictEqual(r.pipeline.metrics.secondChanceRounds, 1);
    assert.ok(logs.some((l) => /second chance: slowgeek still no answer/.test(l)), logs.join(' | '));
    // The search cache is 60 s; drop it so the next Play really searches again at 2 s.
    r.pipeline.searchCache.clear();
    await assert.rejects(r.pipeline.play({ q: 'Movie 2024' }), /no playable/);
    assert.strictEqual(r.pipeline.metrics.secondChanceRounds, 1, 'a round that did not help is not repeated by the next Play');
  } finally {
    console.log = orig;
    await r.done();
  }
});

test('second chance: an indexer that is cooling down after a rate limit is not asked again', async () => {
  // First /api request hangs past the deadline; every later one answers 429, which marks it limited.
  const r = await rig([
    { name: 'quick' },
    { name: 'slowgeek', delayMs: 0, status: (n) => (n === 1 ? 200 : 429) },
  ]);
  // Make only the first request slow.
  const s = r.servers[1];
  const origHits = () => s.state.hits;
  s.state.delayMs = 600;
  try {
    const pending = assert.rejects(r.pipeline.play({ q: 'Movie 2024' }), /no playable/);
    // After the first request, drop the delay so the rest answer 429 at once.
    const until = Date.now() + 2000;
    while (origHits() < 1 && Date.now() < until) await new Promise((res) => setTimeout(res, 5));
    s.state.delayMs = 0;
    await pending;
    assert.ok(indexerIsCooling('slowgeek'), 'the 429 marked the indexer limited');
    assert.ok(!(r.pipeline.metrics.secondChanceRounds > 0), 'a limited indexer gets no second chance');
  } finally {
    clearIndexerCooldowns();
    await r.done();
  }
});

test('nothing playable: the reason names cinema copies, the quality cap, the size limit and a filtered word instead of one lump', () => {
  const policy = {
    maxResolutionRank: 3, maxSizeGb1080: 10,
    customScoring: { keywords: [{ term: 'CAM', score: -8000 }, { term: 'BLOCKME', score: -5000 }] },
  };
  const rows = [
    { name: 'Sunrise.2026.HDCAM.x264-GRP', sizeBytes: 1.5e9 },
    { name: 'Sunrise.2026.CAM.x264-GRP', sizeBytes: 1.4e9 },
    { name: 'Sunrise.2026.TS.x264-GRP', sizeBytes: 1.3e9 },
    { name: 'Sunrise.2026.TELESYNC.XviD-GRP', sizeBytes: 1.2e9 },
    { name: 'Sunrise.2026.2160p.WEB-DL.H.265-FLUX', sizeBytes: 15e9 },
    { name: 'Sunrise.2026.1080p.BluRay.REMUX.AVC-GRP', sizeBytes: 30e9 },
    { name: 'Sunrise.2026.DVDRip.XviD.BLOCKME.KORSUB-YIFY', sizeBytes: 1.1e9 },
  ];
  const ranked = rankReleases(rows, policy);
  for (const c of ranked) assert.ok(c.score <= -5000, `fixture ${c.name} is really unplayable (${c.score})`);
  const line = summarizeUnplayable(ranked);
  assert.match(line, /4 cinema copies skipped until a home release/);
  assert.match(line, /1 above your quality cap/);
  assert.match(line, /1 over the size limit/);
  assert.match(line, /1 blocked by a filtered word or group/);
  assert.doesNotMatch(line, /below the quality cap or filtered/, 'no lump bucket when every reason is known');
  const e = noPlayableError(ranked, [{ indexer: 'NZBgeek', error: 'deadline after 2000ms: api.example' }], 2);
  assert.strictEqual(e.message, 'no playable releases found', 'the message the client and prepare cache key on is unchanged');
  assert.match(e.summary, /^Found 7 releases, none playable \(/);
  assert.match(e.summary, /1 indexer also failed/);
  assert.doesNotMatch(e.summary, /no playable|not available yet/i, 'the web toast shows the reason, not "Not available yet"');
  // The old pin: a candidate with no known reason still lands in the catch-all, word for word.
  assert.strictEqual(summarizeUnplayable([{ name: 'X.mkv', score: -10 }]), '1 below the quality cap or filtered');
  assert.strictEqual(summarizeUnplayable(rankReleases([{ name: 'Sunrise.2026.CAM.x264-GRP' }], policy)), '1 cinema copy skipped until a home release');
});

test('Settings → Indexers: the health line says plainly when an indexer is slow or failing today', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const src = /function indexerHealthText\(h\) \{[\s\S]*?\r?\n\}\r?\n/.exec(html);
  assert.ok(src, 'indexerHealthText is in the web UI');
  const indexerHealthText = new Function(`${src[0]}; return indexerHealthText;`)();
  assert.deepStrictEqual(indexerHealthText({ searches: 5, timeouts: 4, failures: 0 }),
    { text: ' · slow or failing today: 4 of 5 searches timed out', bad: true });
  assert.strictEqual(indexerHealthText({ searches: 10, timeouts: 1, failures: 0 }).bad, false);
  assert.strictEqual(indexerHealthText({ searches: 0 }).text, '');
  assert.match(indexerHealthText({ searches: 6, timeouts: 0, failures: 0 }).text, /6 searches answered today/);
  assert.match(html, /indexerHealthText\(x\.health\)/, 'the indexer list renders it');
  assert.match(html, /\$\{esc\(ixHealth\.text\)\}/, 'and escapes it');
});

test('second chance: only a Play the viewer pressed asks the slow indexer again; a warm-up never starts or joins a round (lead decision, 3.5.8)', async () => {
  // Warm-ups (card focus, Up next, Jellyfin prepare) run for titles nobody pressed Play on. A round
  // for them spends indexer API calls against the daily limit, and a round that finds nothing marks
  // the search tried for 10 minutes, taking the second chance away from the Play that follows.
  const r = await rig([
    { name: 'quick' },
    { name: 'slowgeek', delayMs: 1200, release: PLAYABLE },
  ]);
  try {
    await r.pipeline.prepare({ q: 'Movie 2024' }).catch(() => null);
    assert.ok(!(r.pipeline.metrics.secondChanceRounds > 0), 'the warm-up started no round');
    assert.strictEqual(r.pipeline._secondChanceTried.size, 0, 'and used up nothing');
    const play = r.pipeline.play({ q: 'Movie 2024' });
    const until = Date.now() + 5000;
    while (!(r.pipeline.metrics.secondChanceInflight > 0) && Date.now() < until) await new Promise((res) => setTimeout(res, 5));
    assert.ok(r.pipeline.metrics.secondChanceInflight > 0, 'the Play started its own round');
    await r.pipeline.prepare({ q: 'Movie 2024' }).catch(() => null);
    assert.ok(!(r.pipeline.metrics.secondChanceJoins > 0), 'a warm-up during the Play round does not join it');
    assert.strictEqual((await play).candidate.name, PLAYABLE, 'the Play still gets its second chance and plays');
    assert.strictEqual(r.pipeline.metrics.secondChanceRounds, 1, 'one round, for the Play');
  } finally {
    await r.done();
  }
});

test('indexer health: NZB downloads that fail are counted per indexer with their status code, and nothing else changes', async () => {
  const r = await rig([{ name: 'geek510', release: PLAYABLE, nzbStatus: 510 }]);
  try {
    await assert.rejects(r.pipeline.play({ q: 'Movie 2024' }));
    const h = r.pipeline.indexerHealth('geek510');
    assert.ok(h.nzbFailures.length === 1 && h.nzbFailures[0].code === 'HTTP 510', JSON.stringify(h));
    const n = h.nzbFailures[0].count;
    assert.strictEqual(n, r.servers[0].state.nzbHits, 'one count per failed NZB download');
    assert.ok(!/k=|apikey/i.test(JSON.stringify(h)), 'codes only, never a link or key');
    assert.deepStrictEqual(r.pipeline.indexerHealth('nobody').nzbFailures, []);
  } finally {
    await r.done();
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const src = /function indexerHealthText\(h\) \{[\s\S]*?\r?\n\}\r?\n/.exec(html);
  const indexerHealthText = new Function(`${src[0]}; return indexerHealthText;`)();
  const t = indexerHealthText({ searches: 4, timeouts: 0, failures: 0, nzbFailures: [{ code: 'HTTP 510', count: 3 }] });
  assert.match(t.text, /NZB downloads failing: HTTP 510, 3 today/);
  assert.strictEqual(t.bad, true);
  assert.match(indexerHealthText({ searches: 0, nzbFailures: [{ code: 'HTTP 510', count: 2 }] }).text, /HTTP 510, 2 today/);
});

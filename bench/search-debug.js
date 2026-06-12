'use strict';
// Debug: run the real indexer fan-out + the REAL title verification for a query.
// Usage: node bench/search-debug.js "From S01E01"
const { Store } = require('../server/store');
const { Auth, SecureSettings } = require('../server/auth');
const { fanout } = require('../server/newznab');
const { rankReleases } = require('../server/scoring');
const { parseWantedTitle, releaseMatches } = require('../server/pipeline');

const store = new Store();
const auth = new Auth(store, process.env.TRIBOON_SECRET);
const settings = new SecureSettings(store, auth.secret);
const s = settings.get();
const ixs = (s.indexers || []).filter((i) => i.enabled !== false);
if (!ixs.length) { console.error('no indexers in settings'); process.exit(1); }

const sanitize = (q) => String(q || '').replace(/['’`]/g, '').replace(/[:&,!?./\\()\[\]\-_;]+/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const q = sanitize(process.argv[2] || 'From S01E01');
  const wanted = parseWantedTitle(q);
  console.log('query:', JSON.stringify(q), 'wanted:', JSON.stringify(wanted));
  const { results, errors } = await fanout(ixs, { q, limit: 100 }, { timeoutMs: 8000 });
  for (const e of errors) console.log('indexer error:', e.indexer, e.error);
  const pass = results.filter((r) => releaseMatches(r.name, wanted));
  const fail = results.filter((r) => !releaseMatches(r.name, wanted));
  console.log(`raw: ${results.length} | passed title check: ${pass.length} | rejected: ${fail.length}`);
  const ranked = rankReleases(pass.map((r) => ({ ...r })), {});
  console.log('\n--- TOP 12 RANKED (playable picks) ---');
  for (const c of ranked.slice(0, 12)) console.log(String(c.score).padStart(7), c.name);
  console.log('\n--- REJECTED (first 12) ---');
  for (const r of fail.slice(0, 12)) console.log('   x   ', r.name);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

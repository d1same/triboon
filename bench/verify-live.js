'use strict';
// Guided LIVE self-test — the half of "bulletproof" the unit suite cannot prove.
//
// The mock-NNTP test suite proves the engine logic (parse/mount/seek/triage/auto-advance/
// concurrency) byte-for-byte, but it runs WITHOUT real usenet creds, so it cannot measure the
// one thing the owner cares about most: does pressing Play on a real movie/episode hit frame in
// ~1-2s against the real provider, with sound, seekable, and does a resume re-check catch a dead
// source? This script drives a RUNNING Triboon server (which holds the encrypted creds +
// indexers) over its real HTTP API and MEASURES wall-clock the way the player experiences it.
//
//   1. press -> ready ......... POST /api/play returns a streamUrl (search + score + NZB +
//                               mount + bounded health gate). This is "press Play to playable".
//   2. play -> first byte ..... GET the streamUrl Range bytes=0- (time to first decoded bytes,
//                               the proxy for time-to-first-frame).
//   3. seek -> first byte ..... GET a Range deep in the file (cold-seek responsiveness).
//   4. audio path ............. the server's playback decision (direct / remux / transcode) and
//                               whether an AAC-safe transcode is needed for this client's caps.
//   5. resume feel ............ a second Play of the same title should reuse the live mount
//                               (~instant), and /api/health re-reports the live triage verdict.
//
// USAGE (PowerShell):
//   $env:TRIBOON_USER="owner"; $env:TRIBOON_PASS="..."; node bench/verify-live.js `
//     --title "Sintel 2010|tt1727587" --title "The Bear S01E01|tt14452776|1|1"
//
//   node bench/verify-live.js --base http://10.1.20.11:7777 --title "Dune Part Two 2024"
//
// A title is "query|imdbid|season|episode" — only the query is required. Pass --title repeatedly.
// With no --title flags, DEFAULT_TITLES below is used (edit it for your own library).
// Exit code is non-zero if any title fails to produce a playable stream.

const http = require('http');
const https = require('https');
const { URL } = require('url');

// --- edit these for your own catalog, or pass --title flags instead ---
const DEFAULT_TITLES = [
  'Sintel 2010|tt1727587',
  'Big Buck Bunny 2008|tt1254207',
];

// Budgets (ms). These are "feels local" targets, not hard gates — the report flags SLOW, and the
// owner judges. Only a non-playable title or an HTTP error is a hard FAIL.
const BUDGET = { ready: 3000, firstByte: 1500, seekByte: 2000, resume: 800 };

function parseArgs(argv) {
  const out = { base: process.env.TRIBOON_BASE || 'http://localhost:7777', titles: [], token: process.env.TRIBOON_TOKEN || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--title') out.titles.push(argv[++i]);
    else if (a === '--token') out.token = argv[++i];
  }
  if (!out.titles.length) out.titles = DEFAULT_TITLES.slice();
  return out;
}

function parseTitle(spec) {
  const [q, imdbid, season, ep] = String(spec).split('|').map((s) => (s || '').trim());
  const t = { q };
  if (imdbid) t.imdbid = imdbid;
  if (season) t.season = Number(season);
  if (ep) t.ep = Number(ep);
  return t;
}

// Minimal JSON + Range client (zero deps; honors http/https from the base URL).
function request(method, urlStr, { headers = {}, body = null, rangeBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...headers } };
    if (body != null) {
      const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = buf.length;
      opts._buf = buf;
    }
    const t0 = process.hrtime.bigint();
    const req = lib.request(opts, (res) => {
      let firstByteMs = null;
      let received = 0;
      const chunks = [];
      res.on('data', (c) => {
        if (firstByteMs === null) firstByteMs = Number(process.hrtime.bigint() - t0) / 1e6;
        received += c.length;
        // For Range probes we only need the first window; stop early to avoid pulling the file.
        if (rangeBytes && received < rangeBytes + 1) chunks.push(c);
        if (rangeBytes && received >= rangeBytes) { req.destroy(); res.destroy(); }
        else if (!rangeBytes) chunks.push(c);
      });
      res.on('end', () => finish());
      res.on('close', () => finish());
      let done = false;
      function finish() {
        if (done) return; done = true;
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, raw, firstByteMs, received,
          totalMs: Number(process.hrtime.bigint() - t0) / 1e6 });
      }
    });
    req.on('error', (e) => { if (e.code === 'ECONNRESET' && rangeBytes) return; reject(e); });
    if (opts._buf) req.write(opts._buf);
    req.end();
  });
}

const fmt = (ms) => (ms == null ? '  —  ' : `${Math.round(ms)}ms`);
const mark = (ms, budget) => (ms == null ? '?' : ms <= budget ? 'OK' : 'SLOW');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base.replace(/\/$/, '');
  console.log(`\nTriboon live self-test → ${base}\n${'='.repeat(64)}`);

  // 1) Auth: token from flag/env, else log in with TRIBOON_USER/TRIBOON_PASS.
  let token = args.token;
  if (!token) {
    const user = process.env.TRIBOON_USER, pass = process.env.TRIBOON_PASS;
    if (!user || !pass) { console.error('Set TRIBOON_USER + TRIBOON_PASS (or pass --token / TRIBOON_TOKEN).'); process.exit(2); }
    const r = await request('POST', `${base}/api/login`, { body: { name: user, password: pass } });
    if (r.status !== 200 || !r.json || !r.json.token) {
      console.error(`Login failed (${r.status}). ${r.json && r.json.challenge ? '2FA is enabled — pass --token from a logged-in session.' : (r.json && r.json.error) || ''}`);
      process.exit(2);
    }
    token = r.json.token;
  }
  const authH = { authorization: `Bearer ${token}` };

  // Environment snapshot — surfaces the things that silently change behavior.
  try {
    const srv = (await request('GET', `${base}/api/server`, { headers: authH })).json || {};
    console.log(`server: v${srv.version || '?'} ffmpeg=${!!srv.ffmpeg} subSync(alass)=${!!srv.subSync} subtitles=${!!srv.opensubs} iptv=${!!srv.iptv}`);
    if (srv.needsSetup) console.log('⚠ server reports needsSetup — finish first-run setup in the dashboard before testing playback.');
  } catch {}
  console.log('');

  const rows = [];
  let hardFail = 0;

  for (const spec of args.titles) {
    const t = parseTitle(spec);
    const row = { title: t.q, ready: null, firstByte: null, seekByte: null, resume: null, method: '?', health: '?', source: '', note: '' };
    try {
      // 1. press -> ready
      const playT0 = process.hrtime.bigint();
      const play = await request('POST', `${base}/api/play`, { headers: authH, body: t });
      row.ready = Number(process.hrtime.bigint() - playT0) / 1e6;
      if (play.status !== 200 || !play.json || !play.json.streamUrl) {
        row.note = `PLAY FAILED (${play.status}): ${(play.json && play.json.error) || ''}`.trim();
        if (play.json && play.json.attempts && play.json.attempts.length) row.note += ` [${play.json.attempts.slice(0, 3).map((a) => a.fail).join('; ')}]`;
        hardFail++; rows.push(row); console.log(line(row)); continue;
      }
      const m = play.json;
      row.source = (m.candidate && m.candidate.name) || m.name || '';
      row.method = (m.playback && m.playback.method) || m.method || (m.streamable ? 'direct' : 'unstreamable');
      const needsAac = !!(m.playback && (m.playback.audioSafe || m.playback.transcodeAudio));
      if (needsAac && /direct/.test(row.method)) row.method += '+aacSafe';

      // 2. play -> first byte (real decoded bytes off the front of the file)
      const sUrl = `${base}${m.streamUrl}`;
      const fb = await request('GET', sUrl, { rangeBytes: 64 * 1024 });
      row.firstByte = fb.firstByteMs;
      if (fb.status >= 400) { row.note = `stream HTTP ${fb.status}`; hardFail++; }

      // 3. seek -> first byte (cold range ~70% in)
      if (m.size > 200000) {
        const seekStart = Math.floor(m.size * 0.7);
        const sk = await request('GET', sUrl, { headers: { Range: `bytes=${seekStart}-${seekStart + 65535}` }, rangeBytes: 64 * 1024 });
        row.seekByte = sk.firstByteMs;
        if (sk.status !== 206 && sk.status !== 200) row.note += ` seek HTTP ${sk.status}`;
      }

      // 4. health re-check (the resume path: /api/health runs live triage on the mount)
      try {
        const h = await request('GET', `${base}/api/health/${m.id}`, { headers: authH });
        row.health = (h.json && h.json.verdict) || '?';
      } catch {}

      // 5. resume feel — a second Play should reuse the live mount (~instant)
      const rT0 = process.hrtime.bigint();
      const again = await request('POST', `${base}/api/play`, { headers: authH, body: t });
      row.resume = Number(process.hrtime.bigint() - rT0) / 1e6;
      if (again.json && again.json.id !== m.id) row.note += ' (resume remounted, not reused)';
    } catch (e) {
      row.note = `ERROR: ${e.message}`; hardFail++;
    }
    rows.push(row);
    console.log(line(row));
  }

  console.log('='.repeat(64));
  console.log(legend());
  if (hardFail) { console.error(`\n${hardFail} title(s) failed to produce a playable stream — see notes above.`); process.exit(1); }
  console.log('\nAll titles produced a playable stream. Compare the ms columns against your "feels local" bar.');
}

function line(r) {
  const cell = (label, ms, budget) => `${label} ${fmt(ms)} ${mark(ms, budget)}`.padEnd(22);
  const head = (r.title || '').slice(0, 26).padEnd(28);
  const body = [
    cell('ready', r.ready, BUDGET.ready),
    cell('1stByte', r.firstByte, BUDGET.firstByte),
    cell('seek', r.seekByte, BUDGET.seekByte),
    cell('resume', r.resume, BUDGET.resume),
  ].join('');
  let s = `${head}${body} ${r.method.padEnd(14)} health=${String(r.health).padEnd(9)}`;
  if (r.source) s += `\n${' '.repeat(28)}↳ ${r.source}`;
  if (r.note) s += `\n${' '.repeat(28)}⚠ ${r.note}`;
  return s;
}

function legend() {
  return `budgets: ready≤${BUDGET.ready}  1stByte≤${BUDGET.firstByte}  seek≤${BUDGET.seekByte}  resume≤${BUDGET.resume} (ms). OK within budget, SLOW over.\n`
    + `method: direct = no transcode; +aacSafe = audio transcoded to AAC for this client; remux/transcode = ffmpeg in the path.\n`
    + `health: verified/degraded/blocked from a live triage on the mounted source.`;
}

main().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// A/V sync diagnosis: play a real title through the RUNNING server, then measure the
// audio↔video timestamp relationship in the SOURCE stream vs the REMUX output.
// Usage: node bench/sync-debug.js "Inception 2010" [startSeconds]
const { Store } = require('../server/store');
const { Auth } = require('../server/auth');
const { spawnSync } = require('child_process');
const http = require('http');

const store = new Store();
const auth = new Auth(store, process.env.TRIBOON_SECRET);
const users = store.read('users', { list: [] }).list;
const admin = users.find((u) => u.role === 'owner' || u.role === 'admin');
if (!admin) { console.error('no admin user'); process.exit(1); }
const token = auth.signToken({ uid: admin.id, role: admin.role, scope: 'session' }, 3600e3);
const BASE = 'http://127.0.0.1:7777';

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + path, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
      authorization: 'Bearer ' + token } }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(new Error(b.slice(0, 300))); } });
    });
    req.on('error', reject); req.end(data);
  });
}

// ffprobe the first N packets of a URL (optionally with input -ss) → per-stream first/last pts.
function probePackets(url, { ss = 0, readDuration = 20 } = {}) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_packets',
    '-read_intervals', (ss ? `${ss}` : '0') + `%+${readDuration}`, url];
  const r = spawnSync('ffprobe', args, { timeout: 120000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error('ffprobe failed: ' + String(r.stderr).slice(0, 400));
  const pkts = (JSON.parse(String(r.stdout) || '{}').packets || []).filter((p) => p.pts_time != null);
  const by = {};
  for (const p of pkts) {
    const k = p.codec_type + p.stream_index;
    if (!by[k]) by[k] = { type: p.codec_type, idx: p.stream_index, first: +p.pts_time, last: +p.pts_time, n: 0 };
    by[k].first = Math.min(by[k].first, +p.pts_time); by[k].last = Math.max(by[k].last, +p.pts_time); by[k].n++;
  }
  return Object.values(by);
}

(async () => {
  const q = process.argv[2] || 'Inception 2010';
  const ss = parseFloat(process.argv[3] || '0') || 0;
  console.log('playing:', q, ' caps like Shield WebView (no ac3/eac3 → audio transcode)');
  const r = await apiPost('/api/play', { q, caps: { mkv: true, hevc: true, ac3: false, eac3: false, dts: false } });
  if (r.status !== 200) { console.error('play failed', r.status, JSON.stringify(r.json).slice(0, 400)); process.exit(1); }
  const m = r.json.mount || r.json;
  console.log('mounted:', m.name, '| method:', m.method, '| playback:', JSON.stringify(r.json.playback || m.playback));
  const streamUrl = BASE + m.streamUrl;
  const remuxUrl = BASE + m.remuxUrl + (ss ? `&start=${ss}` : '');

  console.log('\n--- SOURCE packets (first 20s' + (ss ? ` from ${ss}s` : '') + ') ---');
  for (const s of probePackets(streamUrl, { ss })) console.log(`  ${s.type}#${s.idx}: first=${s.first.toFixed(3)} last=${s.last.toFixed(3)} pkts=${s.n}`);

  console.log('\n--- REMUX output packets (first 20s of pipe) ---');
  for (const s of probePackets(remuxUrl, { ss: 0 })) console.log(`  ${s.type}#${s.idx}: first=${s.first.toFixed(3)} last=${s.last.toFixed(3)} pkts=${s.n}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
